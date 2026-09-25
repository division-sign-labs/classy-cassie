// packages/cli/src/commands/ops.ts
// portfolio / orders / alerts test / venue status.

import pc from "picocolors";
import {
  KeyRoles,
  TelegramAlerter,
  WebhookAlerter,
  computePortfolio,
  createAdapter,
  parseBotConfig,
  type AlertEvent,
  type BotPortfolio,
  type Order,
} from "@quotient-forecasting/cassie-core";
import { adapterFor, ask, controlFetch, getPassphrase, isDeployed, keystore, requireAccount } from "../context.js";
import { listBotIds, loadBotConfig, saveBotConfig } from "../paths.js";
import { describeTelegramSettings, resolveTelegramSettings } from "../telegram-settings.js";
import {
  checkWebhookUrl,
  describeWebhookSettings,
  localWebhookSettings,
  parseAlertKinds,
  parseWebhookFormat,
  resolveWebhookSettings,
} from "../webhook-settings.js";
import { money, num, renderTable, shortRef } from "../render.js";

export interface PortfolioOutputBreakdown {
  cash: number;
  positions: number;
  equity: number;
  unrealizedPnl: number;
}

function sumFinite(values: Array<number | undefined>): number {
  return values.reduce<number>((sum, value) => sum + (Number.isFinite(value) ? value! : 0), 0);
}

/** Values shown in the portfolio heading; resting orders are intentionally excluded. */
export function portfolioOutputBreakdown(portfolio: BotPortfolio): PortfolioOutputBreakdown {
  const cash = sumFinite(portfolio.balances.map((balance) => balance.total));
  const finitePositionValue = sumFinite(portfolio.positions.map((position) => position.value));
  const hasUnknownPositionValue = portfolio.positions.some((position) => !Number.isFinite(position.value));
  const equityLessCash = portfolio.equity - cash;
  const positions =
    hasUnknownPositionValue && Number.isFinite(equityLessCash)
      ? equityLessCash
      : finitePositionValue;
  const equity = Number.isFinite(portfolio.equity) ? portfolio.equity : cash + positions;
  const unrealizedPnl = Number.isFinite(portfolio.unrealizedPnl)
    ? portfolio.unrealizedPnl
    : sumFinite(portfolio.positions.map((position) => position.unrealizedPnl));
  return { cash, positions, equity, unrealizedPnl };
}

export function aggregatePortfolioOutput(portfolios: BotPortfolio[]): PortfolioOutputBreakdown {
  return portfolios.map(portfolioOutputBreakdown).reduce<PortfolioOutputBreakdown>(
    (total, portfolio) => ({
      cash: total.cash + portfolio.cash,
      positions: total.positions + portfolio.positions,
      equity: total.equity + portfolio.equity,
      unrealizedPnl: total.unrealizedPnl + portfolio.unrealizedPnl,
    }),
    { cash: 0, positions: 0, equity: 0, unrealizedPnl: 0 },
  );
}

function portfolioSummary(values: PortfolioOutputBreakdown): string {
  return (
    `cash ${money(values.cash)}  positions ${money(values.positions)}  ` +
    `equity ${money(values.equity)}  uPnL ${money(values.unrealizedPnl)}`
  );
}

export async function showPortfolio(botId?: string): Promise<void> {
  const ids = botId ? [botId] : listBotIds();
  if (ids.length === 0) {
    console.log("No bots configured.");
    console.log("cassie init");
    return;
  }
  const portfolios: BotPortfolio[] = [];
  for (const id of ids) {
    const cfg = loadBotConfig(id);
    try {
      let p: BotPortfolio;
      if (isDeployed(cfg)) {
        p = (await controlFetch(cfg, "/portfolio")) as BotPortfolio;
      } else {
        const adapter = await adapterFor(cfg);
        p = await computePortfolio(id, adapter, requireAccount(cfg));
      }
      portfolios.push(p);
    } catch (err) {
      console.log(pc.yellow(`${id}: ${(err as Error).message}`));
    }
  }
  for (const p of portfolios) {
    if (p.perpScope) {
      console.log(pc.bold(`\n${p.botId} (${p.venue})`));
      console.log(`Hyperliquid funding balance ${money(p.perpScope.fundingBalance)}`);
      console.log(`Funding available ${money(p.perpScope.fundingAvailable)}`);
      console.log(`${p.perpScope.dex} trading NAV ${money(p.equity)}`);
      console.log(`Exposure ${money(sumFinite(p.positions.map(position => position.value)))}`);
      console.log(`uPnL ${money(p.unrealizedPnl)}`);
      console.log(`Account mode ${p.perpScope.accountMode}`);
    } else {
      console.log(pc.bold(`\n${p.botId} (${p.venue})  ${portfolioSummary(portfolioOutputBreakdown(p))}`));
    }
    if (p.positions.length > 0) {
      console.log(
        renderTable(
          ["market", "side", "size", "avg", "mark", p.perpScope ? "notional" : "value", "uPnL"],
          p.positions.map((x) => [
            x.label ?? shortRef(x.marketRef),
            x.side,
            num(x.size, 2),
            num(x.avgPrice),
            num(x.markPrice),
            money(x.value),
            money(x.unrealizedPnl),
          ]),
        ),
      );
    }
    if (p.openOrders.length > 0) {
      console.log(pc.dim("open orders:"));
      console.log(
        renderTable(
          ["id", "market", "side", "size", "filled", "price"],
          p.openOrders.map((o) => [o.id, shortRef(o.marketRef), o.side, num(o.size, 2), num(o.filledSize, 2), num(o.price)]),
        ),
      );
    }
    if (p.positions.length === 0 && p.openOrders.length === 0) console.log(pc.dim("  flat, no orders"));
  }
  if (portfolios.length > 1) {
    console.log(pc.bold(portfolios.some(p => p.perpScope)
      ? `\nTOTAL  trading equity ${money(sumFinite(portfolios.map(p => p.equity)))}  uPnL ${money(sumFinite(portfolios.map(p => p.unrealizedPnl)))}`
      : `\nTOTAL  ${portfolioSummary(aggregatePortfolioOutput(portfolios))}`));
  }
}

export async function showOrders(botId: string, opts: { cancel?: string; cancelAll?: boolean }): Promise<void> {
  const cfg = loadBotConfig(botId);
  assertGenericOrderMutationAllowed(cfg, opts);
  if (isDeployed(cfg)) {
    if (opts.cancel) {
      await controlFetch(cfg, "/orders/cancel", { method: "POST", body: JSON.stringify({ id: opts.cancel }) });
      console.log(pc.green(`canceled ${opts.cancel}`));
      return;
    }
    if (opts.cancelAll) {
      await controlFetch(cfg, "/orders/cancel-all", { method: "POST" });
      console.log(pc.green("canceled all orders"));
      return;
    }
    const orders = (await controlFetch(cfg, "/orders")) as Order[];
    printOrders(orders);
    return;
  }
  const adapter = await adapterFor(cfg);
  const account = requireAccount(cfg);
  if (opts.cancel) {
    await adapter.cancelOrder(account, opts.cancel);
    console.log(pc.green(`canceled ${opts.cancel}`));
    return;
  }
  if (opts.cancelAll) {
    await adapter.cancelAll(account);
    console.log(pc.green("canceled all orders"));
    return;
  }
  printOrders(await adapter.openOrders(account));
}

/** Market-maker cancels must update its durable reservations through its controller. */
export function assertGenericOrderMutationAllowed(
  cfg: ReturnType<typeof loadBotConfig>,
  opts: { cancel?: string; cancelAll?: boolean },
): void {
  if (cfg.strategy.id === "quotient-swing" && (opts.cancel !== undefined || opts.cancelAll === true)) {
    throw new Error(`Generic cancellation is disabled for swing bots. Halt entries without removing native stops:\ncassie swing halt ${cfg.id}`);
  }
  if (cfg.strategy.id === "market-make" && (opts.cancel !== undefined || opts.cancelAll === true)) {
    throw new Error(
      `Generic order cancellation bypasses market-make reservations. Use its controller:\n` +
        `cassie market-make halt ${cfg.id}\ncassie market-make reconcile ${cfg.id}`,
    );
  }
}

function printOrders(orders: Order[]): void {
  if (orders.length === 0) {
    console.log("no open orders");
    return;
  }
  console.log(
    renderTable(
      ["id", "market", "side", "size", "filled", "price", "status"],
      orders.map((o) => [o.id, shortRef(o.marketRef), o.side, num(o.size, 2), num(o.filledSize, 2), num(o.price), o.status]),
    ),
  );
}

export async function alertsTest(botId: string): Promise<void> {
  const cfg = loadBotConfig(botId);
  const telegram = await resolveTelegramSettings(botId, cfg.alerts.telegram);
  const webhook = await resolveWebhookSettings(botId);
  const hasTelegram = Boolean(telegram.token && telegram.chatId);
  if (!hasTelegram && !webhook.url) {
    console.error(pc.red(
      `No alert sink is configured.\n${describeTelegramSettings(telegram)}.\n${describeWebhookSettings(webhook)}.\n` +
      `Put the values in the nearest .local.env, run cassie init, or run cassie alerts webhook ${botId}`,
    ));
    process.exit(1);
  }
  const event: AlertEvent = {
    kind: "test",
    botId,
    message: "test alert from `cassie alerts test`",
    at: new Date().toISOString(),
    venue: cfg.venue,
    strategy: cfg.strategy.id,
  };
  let failed = false;
  if (hasTelegram) {
    console.log(pc.dim(describeTelegramSettings(telegram)));
    try {
      await new TelegramAlerter(telegram.token!, telegram.chatId!).send(event);
      console.log(pc.green("telegram: sent"));
    } catch (error) {
      failed = true;
      console.error(pc.red(`telegram: ${(error as Error).message}`));
    }
  }
  if (webhook.url) {
    console.log(pc.dim(describeWebhookSettings(webhook)));
    const sink = new WebhookAlerter({
      url: webhook.url,
      ...(webhook.secret ? { secret: webhook.secret } : {}),
      format: cfg.alerts.webhook?.format ?? "json",
      retryDelaysMs: [500],
    });
    await sink.send(event);
    const result = await sink.flush();
    if (result.sent > 0) console.log(pc.green("webhook: sent"));
    else {
      failed = true;
      console.error(pc.red(`webhook: ${result.lastError ?? "not delivered"}`));
    }
  }
  if (failed) process.exit(1);
}

export interface AlertsWebhookOpts {
  format?: string;
  kinds?: string;
  off?: boolean;
  show?: boolean;
}

function applyHint(botId: string, deployed: boolean): string {
  return deployed ? `Apply with: cassie deploy ${botId}` : `Applies the next time you run: cassie run ${botId}`;
}

/**
 * Configure the alert webhook. The URL and signing secret are prompted for
 * (never taken from argv) and stored in the bot's keystore, unless the nearest
 * .local.env or the environment already sets them.
 */
export async function alertsWebhook(botId: string, opts: AlertsWebhookOpts): Promise<void> {
  const cfg = loadBotConfig(botId);
  if (opts.off && (opts.format || opts.kinds || opts.show)) throw new Error("--off takes no other options");

  if (opts.show) {
    const settings = await resolveWebhookSettings(botId);
    console.log(describeWebhookSettings(settings));
    const tuning = cfg.alerts.webhook;
    console.log(`format: ${tuning?.format ?? "json"}; kinds: ${tuning?.kinds?.join(", ") ?? "all"}`);
    return;
  }

  if (opts.off) {
    const ks = keystore();
    const removed = [KeyRoles.webhookUrl, KeyRoles.webhookSecret].filter((role) => ks.removeEntry(botId, role));
    const { webhook: _removed, ...alerts } = cfg.alerts;
    saveBotConfig(parseBotConfig({ ...cfg, alerts }));
    console.log(`${botId}: webhook alerts off${removed.length ? `; removed ${removed.join(", ")} from the keystore` : ""}`);
    const local = localWebhookSettings();
    if (local.url) console.log(pc.yellow(`CASSIE_WEBHOOK_URL is still set in ${local.urlOrigin}; remove it there too.`));
    console.log(applyHint(botId, isDeployed(cfg)));
    return;
  }

  const format = parseWebhookFormat(opts.format) ?? cfg.alerts.webhook?.format ?? "json";
  const kinds = opts.kinds !== undefined ? parseAlertKinds(opts.kinds) : cfg.alerts.webhook?.kinds;

  const local = localWebhookSettings();
  if (local.url) {
    checkWebhookUrl(local.url);
    console.log(pc.dim(`URL from ${local.urlOrigin}; not stored in the keystore`));
  } else {
    const url = checkWebhookUrl(await ask("Webhook URL", { secret: true }));
    const secret = (await ask("Signing secret (blank for none; Slack and Discord ignore it)", { secret: true })).trim();
    const pass = await getPassphrase(botId);
    const ks = keystore();
    ks.putEntry(botId, KeyRoles.webhookUrl, url, pass, { runtimeEligible: true });
    if (secret) ks.putEntry(botId, KeyRoles.webhookSecret, secret, pass, { runtimeEligible: true });
    else ks.removeEntry(botId, KeyRoles.webhookSecret);
  }

  saveBotConfig(parseBotConfig({ ...cfg, alerts: { ...cfg.alerts, webhook: { format, ...(kinds ? { kinds } : {}) } } }));
  console.log(describeWebhookSettings(await resolveWebhookSettings(botId)));
  console.log(`format: ${format}; kinds: ${kinds?.join(", ") ?? "all"}`);
  console.log(`Check it with: cassie alerts test ${botId}`);
  console.log(applyHint(botId, isDeployed(cfg)));
}

export function venueStatus(): void {
  const defaults = parseBotConfig({ id: "probe", venue: "polymarket" }).venueUrls;
  const rows: [string, string, string][] = [];
  for (const venue of ["polymarket", "kalshi", "hyperliquid"] as const) {
    try {
      const adapter = createAdapter(venue, { urls: defaults });
      rows.push([venue, adapter.verifiedAgainst, adapter.supportsNativeTriggers ? "native triggers" : "synthetic triggers"]);
    } catch (err) {
      rows.push([venue, "unavailable", (err as Error).message.slice(0, 60)]);
    }
  }
  console.log(renderTable(["venue", "verifiedAgainst", "notes"], rows));
  console.log(pc.dim("\nRe-verify adapters with stale verification dates."));
}

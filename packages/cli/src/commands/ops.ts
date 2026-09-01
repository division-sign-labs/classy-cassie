// packages/cli/src/commands/ops.ts
// portfolio / orders / alerts test / venue status.

import pc from "picocolors";
import {
  KeyRoles,
  TelegramAlerter,
  computePortfolio,
  createAdapter,
  parseBotConfig,
  type BotPortfolio,
  type Order,
} from "@quotient-forecasting/cassie-core";
import { adapterFor, controlFetch, getKeystoreSecret, isDeployed, requireAccount } from "../context.js";
import { listBotIds, loadBotConfig } from "../paths.js";
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
    console.log("no bots yet. Run cassie init.");
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
    console.log(pc.bold(`\n${p.botId} (${p.venue})  ${portfolioSummary(portfolioOutputBreakdown(p))}`));
    if (p.positions.length > 0) {
      console.log(
        renderTable(
          ["market", "side", "size", "avg", "mark", "value", "uPnL"],
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
    console.log(pc.bold(`\nTOTAL  ${portfolioSummary(aggregatePortfolioOutput(portfolios))}`));
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
  if (cfg.strategy.id === "market-make" && (opts.cancel !== undefined || opts.cancelAll === true)) {
    throw new Error(
      `generic order cancellation is disabled for market-make bot "${cfg.id}" because it bypasses durable reservations; ` +
        `use \`cassie market-make halt ${cfg.id}\` or \`cassie market-make reconcile ${cfg.id}\``,
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
  const chatId = cfg.alerts.telegram?.chatId;
  const token = process.env.TELEGRAM_BOT_TOKEN ?? (await getKeystoreSecret(botId, KeyRoles.telegramToken));
  if (!chatId || !token) {
    console.error(pc.red("telegram is not configured — rerun cassie init, or set the token and chat id"));
    process.exit(1);
  }
  await new TelegramAlerter(token, chatId).send({ kind: "test", botId, message: "test ping from `cassie alerts test`" });
  console.log(pc.green("sent"));
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
  console.log(pc.dim("\nVenue APIs drift: re-verify before relying on a stale date."));
}

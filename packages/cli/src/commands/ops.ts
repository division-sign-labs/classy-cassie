// packages/cli/src/commands/ops.ts
// portfolio / orders / logs / alerts test / venue status.

import pc from "picocolors";
import {
  KeyRoles,
  TelegramAlerter,
  computePortfolio,
  aggregatePortfolios,
  createAdapter,
  parseBotConfig,
  type BotPortfolio,
  type ErrorRecord,
  type Order,
} from "@quotient/cassie-core";
import { SqliteStateStore } from "@quotient/cassie-runtime-local";
import { adapterFor, controlFetch, getKeystoreSecret, isDeployed, requireAccount } from "../context.js";
import { listBotIds, loadBotConfig, statePath } from "../paths.js";
import { money, num, renderTable, shortRef } from "../render.js";

export async function showPortfolio(botId?: string): Promise<void> {
  const ids = botId ? [botId] : listBotIds();
  if (ids.length === 0) {
    console.log("no bots — `cassie init`");
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
        const adapter = await adapterFor(cfg, { fixtureBooks: cfg.venue === "fixture" ? "{\"markets\":{}}" : undefined });
        p = await computePortfolio(id, adapter, requireAccount(cfg));
      }
      portfolios.push(p);
    } catch (err) {
      console.log(pc.yellow(`${id}: ${(err as Error).message}`));
    }
  }
  for (const p of portfolios) {
    console.log(pc.bold(`\n${p.botId} (${p.venue})  equity ${money(p.equity)}  uPnL ${money(p.unrealizedPnl)}`));
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
    const agg = aggregatePortfolios(portfolios);
    console.log(pc.bold(`\nTOTAL equity ${money(agg.totalEquity)}  uPnL ${money(agg.totalUnrealizedPnl)}`));
  }
}

export async function showOrders(botId: string, opts: { cancel?: string; cancelAll?: boolean }): Promise<void> {
  const cfg = loadBotConfig(botId);
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

export async function showLogs(botId: string, opts: { level?: string; tail?: string }): Promise<void> {
  const cfg = loadBotConfig(botId);
  let errors: ErrorRecord[];
  if (isDeployed(cfg)) {
    const qs = new URLSearchParams();
    if (opts.level) qs.set("level", opts.level);
    if (opts.tail) qs.set("tail", opts.tail);
    errors = (await controlFetch(cfg, `/logs?${qs}`)) as ErrorRecord[];
  } else {
    const store = new SqliteStateStore(statePath(botId));
    errors = await store.readErrors({
      level: opts.level as ErrorRecord["level"] | undefined,
      tail: opts.tail ? Number(opts.tail) : 50,
    });
    store.close();
  }
  if (errors.length === 0) {
    console.log("no log entries");
    return;
  }
  for (const e of errors) {
    const color = e.level === "error" ? pc.red : e.level === "warn" ? pc.yellow : pc.dim;
    console.log(
      `${new Date(e.ts).toISOString()} ${color(e.level.toUpperCase())} [${e.code}]${e.tickSeq !== undefined ? ` tick=${e.tickSeq}` : ""} ${e.message}` +
        (e.context ? pc.dim(` ${JSON.stringify(e.context)}`) : ""),
    );
  }
}

export async function alertsTest(botId: string): Promise<void> {
  const cfg = loadBotConfig(botId);
  const chatId = cfg.alerts.telegram?.chatId;
  const token = process.env.TELEGRAM_BOT_TOKEN ?? (await getKeystoreSecret(botId, KeyRoles.telegramToken));
  if (!chatId || !token) {
    console.error(pc.red("telegram not configured — rerun `cassie init` or set the token/chat id"));
    process.exit(1);
  }
  await new TelegramAlerter(token, chatId).send({ kind: "test", botId, message: "test ping from `cassie alerts test`" });
  console.log(pc.green("sent"));
}

export function venueStatus(): void {
  const defaults = parseBotConfig({ id: "probe", venue: "fixture" }).venueUrls;
  const rows: [string, string, string][] = [];
  for (const venue of ["polymarket", "hyperliquid", "lighter"] as const) {
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

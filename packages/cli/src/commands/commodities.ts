// packages/cli/src/commands/commodities.ts
// Read-only scans, isolated previews, and explicit activation of the commodity strategy.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommodityConfigSchema, COMMODITY_REPORT_KEY, COMMODITY_LEDGER_KEY, KalshiCommoditiesStrategy,
  Engine, MemoryStateStore, ConsoleAlerter, consoleLogger, createAdapter, parseBotConfig,
  type BotConfig, type CommodityReport, type StrategyContext } from "@quotient-forecasting/cassie-core";
import { CommodityDataSource, CommodityRecordingStore, SqliteStateStore } from "@quotient-forecasting/cassie-runtime-node";
import { buildRuntimeCreds, confirm, requireAccount } from "../context.js";
import { dirs, loadBotConfig, saveBotConfig, statePath } from "../paths.js";
import { discoverQuotientToken, resolveQuotientToken } from "../quotient-token.js";
import { swingControl } from "./swing.js";

function running(cfg: BotConfig): boolean { return Boolean(cfg.deployment) || existsSync(join(dirs.run(), `${cfg.id}.sock`)) || existsSync(`${statePath(cfg.id)}.run.lock`); }
function requireCommodity(botId: string): BotConfig {
  const cfg = loadBotConfig(botId);
  if (cfg.venue !== "kalshi" || cfg.strategy.id !== "kalshi-commodities") throw new Error("this command requires a Kalshi kalshi-commodities bot");
  return cfg;
}
function print(value: unknown, output?: string): void {
  const json = JSON.stringify(value, null, 2) + "\n";
  if (output) { writeFileSync(output, json, { mode: 0o600 }); console.log("Saved."); console.log(output); }
  else console.log(json);
}
export function configureCommodities(botId: string, opts: { config?: string; execution?: string } = {}): void {
  const cfg = loadBotConfig(botId);
  if (cfg.venue !== "kalshi") throw new Error("kalshi-commodities requires Kalshi");
  if (running(cfg)) throw new Error("stop the local runtime before changing commodity configuration; deployed bots require the deployment workflow");
  if (cfg.strategy.id !== "kalshi-commodities" && existsSync(statePath(botId))) throw new Error("create a new bot id; existing strategy state cannot be repurposed");
  const raw: unknown = opts.config ? JSON.parse(readFileSync(opts.config, "utf8")) : cfg.strategy.id === "kalshi-commodities" ? cfg.strategy.config : {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("strategy JSON must be an object");
  const config = CommodityConfigSchema.parse({ ...raw, ...(opts.execution ? { entryStyle: opts.execution } : {}) });
  saveBotConfig(parseBotConfig({ ...cfg, strategy: { id: "kalshi-commodities", config }, tickIntervalMin: 1,
    signals: { ...cfg.signals, maxAgeSec: config.maxForecastAgeHours * 3600 },
    risk: { ...cfg.risk, minDailyVolume: 0, depthCapPct: config.depthParticipationPct, minViableNotional: config.minEntryNotional,
      maxOrderNotional: Math.min(cfg.risk.maxOrderNotional, 100) },
    execution: { mode: "adaptive", entryDeadlineSec: config.entryDeadlineSec, exitPassiveSec: config.exitPassiveSec } }));
  console.log(`Configured ${botId}.`);
  console.log(`Assets: ${config.assets.join(", ")}`);
  console.log(`Execution: ${config.entryStyle} limits`);
  console.log(`Gross premium cap: ${config.grossCapPct}%`);
  console.log("Runtime starts paused.");
}

/** Public venue reads plus a hypothetical flat portfolio. Never unlocks exchange credentials. */
export async function scanCommodities(opts: { equity?: string; config?: string; output?: string } = {}): Promise<void> {
  const equity = Number(opts.equity ?? 1000);
  if (!Number.isFinite(equity) || equity <= 0) throw new Error("equity must be a positive USD amount");
  const config = CommodityConfigSchema.parse(opts.config ? JSON.parse(readFileSync(opts.config, "utf8")) : {});
  const token = discoverQuotientToken()?.token;
  if (!token) throw new Error("scan needs a Quotient API key from .local.env, environment or the Quotient CLI");
  const bot = parseBotConfig({ id: "commodity-scan", venue: "kalshi", strategy: { id: "kalshi-commodities", config } });
  const source = new CommodityDataSource({ config, baseUrl: bot.signals.baseUrl, apiBase: bot.venueUrls.kalshi.api, token });
  const adapter = createAdapter("kalshi", { urls: bot.venueUrls });
  const values = new Map<string, unknown>();
  const ctx: StrategyContext = { botId: bot.id, venueId: "kalshi", config, signals: source, equity, positions: [], openOrders: [],
    now: Date.now, log: consoleLogger(bot.id), memory: {
      get: async <T>(key: string): Promise<T | undefined> => structuredClone(values.get(key)) as T | undefined,
      set: async <T>(key: string, value: T): Promise<void> => { values.set(key, structuredClone(value)); },
    }, venue: { balances: async () => [{ asset: "USD", total: equity, available: equity }], positions: async () => [], openOrders: async () => [], fills: async () => [],
      book: ref => adapter.book(ref), quote: ref => adapter.quote(ref), eventRef: ref => adapter.eventRef!(ref) } };
  await new KalshiCommoditiesStrategy().tick(ctx);
  print({ hypotheticalPortfolio: true, ...(values.get(COMMODITY_REPORT_KEY) as CommodityReport) }, opts.output);
}

export async function commodityStatus(botId: string): Promise<void> {
  const cfg = requireCommodity(botId);
  if (running(cfg)) { print(await swingControl(cfg, "/commodities/status")); return; }
  if (!existsSync(statePath(botId))) { print({ running: false, config: cfg.strategy.config, report: null }); return; }
  const state = new SqliteStateStore(statePath(botId));
  try {
    const [report, ledger, execution] = await Promise.all([state.get(`strategy:${COMMODITY_REPORT_KEY}`), state.get(`strategy:${COMMODITY_LEDGER_KEY}`), state.get("prediction:execution:v1")]);
    print({ running: false, config: cfg.strategy.config, report: report ? JSON.parse(report) : null, risk: ledger ? JSON.parse(ledger) : null, execution: execution ? JSON.parse(execution) : null });
  } finally { state.close(); }
}

export async function commodityDryRun(botId: string, opts: { output?: string } = {}): Promise<void> {
  const cfg = requireCommodity(botId);
  if (running(cfg)) { print(await swingControl(cfg, "/commodities/dry-run", "POST"), opts.output); return; }
  const creds = await buildRuntimeCreds(cfg), token = (await resolveQuotientToken(botId))?.token;
  if (!token) throw new Error("commodity preview needs a Quotient API key");
  const source = new CommodityDataSource({ config: CommodityConfigSchema.parse(cfg.strategy.config), baseUrl: cfg.signals.baseUrl,
    apiBase: cfg.venueUrls.kalshi.demo ? cfg.venueUrls.kalshi.demoApi : cfg.venueUrls.kalshi.api, token });
  // Copy the three required records into memory. No service timers or shutdown order path exists here.
  const state = new MemoryStateStore();
  if (existsSync(statePath(botId))) {
    const disk = new SqliteStateStore(statePath(botId));
    try { for (const key of [`strategy:${COMMODITY_LEDGER_KEY}`, "prediction:execution:v1"]) { const value = await disk.get(key); if (value !== undefined && value !== null) await state.set(key, value); } }
    finally { disk.close(); }
  }
  const log = consoleLogger(botId), strategy = new KalshiCommoditiesStrategy();
  const engine = new Engine({ botId, config: cfg, account: requireAccount(cfg), adapter: createAdapter("kalshi", { creds, urls: cfg.venueUrls }),
    state, log, strategy, signals: source, alerter: new ConsoleAlerter(log) });
  await strategy.tick(await engine.strategyContext());
  const report = await state.get(`strategy:${COMMODITY_REPORT_KEY}`);
  print(report ? JSON.parse(report) : { actions: [], reason: "no funded equity" }, opts.output);
}
export async function commodityHalt(botId: string): Promise<void> { print(await swingControl(requireCommodity(botId), "/pause", "POST")); }
export async function commodityHistory(botId: string, opts: { from?: string; until?: string; limit?: string; output?: string } = {}): Promise<void> {
  const cfg = requireCommodity(botId);
  const from = opts.from ? Date.parse(opts.from) : undefined, until = opts.until ? Date.parse(opts.until) : undefined;
  const limit = Number(opts.limit ?? 100);
  if ((from !== undefined && !Number.isFinite(from)) || (until !== undefined && !Number.isFinite(until))
    || (from !== undefined && until !== undefined && from > until) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("history needs valid ISO dates and a limit from 1 to 10000");
  if (running(cfg)) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (from !== undefined) query.set("from", String(from)); if (until !== undefined) query.set("until", String(until));
    print(await swingControl(cfg, `/commodities/history?${query}`), opts.output); return;
  }
  const path = `${statePath(botId)}.commodities.sqlite`;
  if (!existsSync(path)) { print([], opts.output); return; }
  const recordings = new CommodityRecordingStore(path);
  try { print(recordings.read({ from, until, limit }), opts.output); } finally { recordings.close(); }
}
export async function commodityResume(botId: string, opts: { acknowledgeLossReset?: boolean } = {}): Promise<void> {
  const cfg = requireCommodity(botId);
  print(await swingControl(cfg, "/commodities/status"));
  if (!(await confirm(`Enable automated ${cfg.venueUrls.kalshi.demo ? "demo" : "live"} commodity trading for ${botId} under its displayed limits?`, false))) return;
  if (opts.acknowledgeLossReset && !(await confirm("Reset reviewed drawdown limits? The account must be flat with no working orders.", false))) return;
  print(await swingControl(cfg, "/commodities/resume", "POST", { confirmed: true, acknowledgeLossReset: opts.acknowledgeLossReset === true }));
}

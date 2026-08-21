// packages/cli/src/commands/strategy.ts
// The one strategy is `signals`: follow Quotient signals, hold until the
// market prices in the forecast. The wizard offers the recommended settings in
// one keystroke; this command is the manual flow for tuning them.

import pc from "picocolors";
import { ask, confirm } from "../context.js";
import { loadBotConfig, saveBotConfig } from "../paths.js";

export const RECOMMENDED_STRATEGY = {
  topN: 2,
  dailyBudgetUsd: 25,
  positionBudgetPct: 50,
  entrySpreadPp: 10,
  minEntryNotional: 1,
  universe: "from-signals",
  tickIntervalMin: 5,
} as const;

export const RECOMMENDED_SUMMARY = "up to 2 positions, widest eligible edges first, 50% of the daily budget per entry, 10pp minimum edge";

export async function elicitRecommendedStrategyConfig(
  current: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const dailyBudgetUsd = positiveNumber(
    "daily entry budget",
    await ask("Daily entry budget ($, resets at 00:00 UTC)", {
      default: String(current.dailyBudgetUsd ?? RECOMMENDED_STRATEGY.dailyBudgetUsd),
    }),
  );
  return { ...RECOMMENDED_STRATEGY, dailyBudgetUsd };
}

export async function elicitStrategyConfig(current: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const d = (k: string, fallback: string) => String(current[k] ?? fallback);
  const topN = positiveInteger("top positions", await ask("Top N signal positions", { default: d("topN", "2") }));
  const dailyBudgetUsd = positiveNumber(
    "daily entry budget",
    await ask("Daily entry budget ($, resets at 00:00 UTC)", { default: d("dailyBudgetUsd", "25") }),
  );
  const positionBudgetPct = percentage(
    "budget per position",
    await ask("Daily budget per position (%)", { default: d("positionBudgetPct", "50") }),
  );
  const entrySpreadPp = positiveNumber("entry spread", await ask("Minimum entry edge (pp)", { default: d("entrySpreadPp", "10") }));
  const minEntryNotional = nonnegativeNumber(
    "minimum entry",
    await ask("Minimum viable entry after risk caps ($)", { default: d("minEntryNotional", "1") }),
  );
  const tickIntervalMin = positiveNumber("tick interval", await ask("Tick interval (min)", { default: d("tickIntervalMin", "5") }));
  const universeRaw = (await ask("Universe (from-signals or marketRefs)", { default: d("universe", "from-signals") })).trim();
  return {
    topN,
    dailyBudgetUsd,
    positionBudgetPct,
    entrySpreadPp,
    minEntryNotional,
    universe: universeRaw === "from-signals" ? "from-signals" : universeRaw.split(",").map((s) => s.trim()),
    tickIntervalMin,
  };
}

export interface StrategyOptions {
  top?: string;
  dailyBudget?: string;
  positionBudgetPct?: string;
  minEntryNotional?: string;
  signalMaxAgeHours?: string;
  slippage?: string;
  maxOrderNotional?: string;
}

/** `cassie strategy <botId>`: view and tune the bot's strategy and signal guardrails. */
export async function runStrategy(botId: string, opts: StrategyOptions = {}): Promise<void> {
  const cfg = loadBotConfig(botId);
  const directUpdate = Object.values(opts).some((value) => value !== undefined);
  if (directUpdate) {
    const strategyConfig = normalizeStrategyConfig(cfg.strategy.config as Record<string, unknown>);
    if (opts.top !== undefined) strategyConfig.topN = positiveInteger("top positions", opts.top);
    if (opts.dailyBudget !== undefined) strategyConfig.dailyBudgetUsd = positiveNumber("daily entry budget", opts.dailyBudget);
    if (opts.positionBudgetPct !== undefined) {
      strategyConfig.positionBudgetPct = percentage("budget per position", opts.positionBudgetPct);
    }
    if (opts.minEntryNotional !== undefined) {
      strategyConfig.minEntryNotional = nonnegativeNumber("minimum entry notional", opts.minEntryNotional);
    }
    const maxAgeSec =
      opts.signalMaxAgeHours === undefined
        ? cfg.signals.maxAgeSec
        : positiveNumber("signal max age hours", opts.signalMaxAgeHours) * 60 * 60;
    const risk = {
      ...cfg.risk,
      ...(opts.slippage === undefined ? {} : { slippageCents: positiveNumber("slippage cents", opts.slippage) }),
      ...(opts.maxOrderNotional === undefined
        ? {}
        : { maxOrderNotional: positiveNumber("maximum order notional", opts.maxOrderNotional) }),
    };
    saveBotConfig({
      ...cfg,
      strategy: { ...cfg.strategy, config: strategyConfig },
      signals: { ...cfg.signals, maxAgeSec },
      risk,
    });
    console.log(pc.green(`saved strategy settings for ${botId}`));
    printStrategy(strategyConfig, maxAgeSec, risk);
    return;
  }
  console.log(pc.bold(`strategy: signals`));
  printStrategy(cfg.strategy.config as Record<string, unknown>, cfg.signals.maxAgeSec, cfg.risk);
  if (await confirm(`Reset to recommended (${RECOMMENDED_SUMMARY})?`, false)) {
    saveStrategy(botId, await elicitRecommendedStrategyConfig(cfg.strategy.config as Record<string, unknown>));
    return;
  }
  const config = await elicitStrategyConfig(cfg.strategy.config as Record<string, unknown>);
  saveStrategy(botId, config);
}

function positiveNumber(label: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be greater than zero`);
  return value;
}

function nonnegativeNumber(label: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be zero or greater`);
  return value;
}

function positiveInteger(label: string, raw: string): number {
  const value = positiveNumber(label, raw);
  if (!Number.isInteger(value)) throw new Error(`${label} must be a whole number`);
  return value;
}

function percentage(label: string, raw: string): number {
  const value = positiveNumber(label, raw);
  if (value > 100) throw new Error(`${label} must be at most 100%`);
  return value;
}

function normalizeStrategyConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { sizing: _sizing, maxPositionNotional: _maxPositionNotional, maxOpenPositions: _maxOpenPositions, ...current } = config;
  return current;
}

function printStrategy(
  config: Record<string, unknown>,
  maxAgeSec: number,
  risk: { maxOrderNotional: number; slippageCents: number },
): void {
  const current = { ...RECOMMENDED_STRATEGY, ...normalizeStrategyConfig(config) };
  const dailyBudgetUsd = Number(current.dailyBudgetUsd);
  const positionBudgetPct = Number(current.positionBudgetPct);
  const perEntryUsd = (dailyBudgetUsd * positionBudgetPct) / 100;
  console.log(`  top N positions:      ${current.topN} (widest eligible edges first)`);
  console.log(`  daily entry budget:   $${dailyBudgetUsd.toFixed(2)} (resets 00:00 UTC)`);
  console.log(`  budget per entry:     ${positionBudgetPct}% = $${perEntryUsd.toFixed(2)} before liquidity/risk caps`);
  console.log(`  minimum entry edge:   ${current.entrySpreadPp}pp`);
  console.log(`  minimum viable entry: $${Number(current.minEntryNotional).toFixed(2)}`);
  console.log(`  slippage:             ${risk.slippageCents}¢ from best executable price`);
  console.log(`  hard per-order cap:   $${risk.maxOrderNotional.toFixed(2)} (risk module)`);
  console.log(`  signal max age:       ${(maxAgeSec / 3600).toFixed(2)}h`);
  console.log(`  tick interval:        ${current.tickIntervalMin} min`);
  console.log(`  universe:             ${Array.isArray(current.universe) ? current.universe.join(", ") : current.universe}`);
}

function saveStrategy(botId: string, config: Record<string, unknown>): void {
  const cfg = loadBotConfig(botId);
  const normalized = normalizeStrategyConfig(config);
  saveBotConfig({
    ...cfg,
    strategy: { id: "signals", config: normalized },
    tickIntervalMin: Number(normalized.tickIntervalMin ?? cfg.tickIntervalMin),
  });
  console.log(pc.green(`saved strategy settings for ${botId}`));
  printStrategy(normalized, cfg.signals.maxAgeSec, cfg.risk);
}

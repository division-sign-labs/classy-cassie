// packages/cli/src/commands/strategy.ts
// The one strategy is `signals`: follow Quotient signals, hold until the
// market prices in the forecast. The wizard offers the recommended settings in
// one keystroke; this command is the manual flow for tuning them.

import pc from "picocolors";
import { ask, confirm } from "../context.js";
import { loadBotConfig, saveBotConfig } from "../paths.js";

export const RECOMMENDED_STRATEGY = {
  topN: null,
  dailyBudgetUsd: 100,
  positionBudgetPct: 25,
  entrySpreadPp: 10,
  minEntryNotional: 1,
  universe: "from-signals",
  tickIntervalMin: 1,
  signalPollIntervalMin: 5,
} as const;

export const RECOMMENDED_SUMMARY =
  "no position-count cap, widest eligible edges first, $100 daily budget, $25 per entry, " +
  "10pp minimum edge, positions every 60s, signals every 5m";

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
  const topN = positionLimit(
    await ask("Maximum signal positions (number or unlimited)", {
      default: current.topN === null ? "unlimited" : d("topN", "unlimited"),
    }),
  );
  const dailyBudgetUsd = positiveNumber(
    "daily entry budget",
    await ask("Daily entry budget ($, resets at 00:00 UTC)", { default: d("dailyBudgetUsd", "100") }),
  );
  const positionBudgetPct = percentage(
    "budget per position",
    await ask("Daily budget per position (%)", { default: d("positionBudgetPct", "25") }),
  );
  const entrySpreadPp = positiveNumber("entry spread", await ask("Minimum entry edge (pp)", { default: d("entrySpreadPp", "10") }));
  const minEntryNotional = nonnegativeNumber(
    "minimum entry",
    await ask("Minimum viable entry after risk caps ($)", { default: d("minEntryNotional", "1") }),
  );
  const positionCheckSeconds = positiveNumber(
    "position check interval",
    await ask("Position check interval (sec)", {
      default: String(Number(d("tickIntervalMin", "1")) * 60),
    }),
  );
  const signalPollIntervalMin = positiveNumber(
    "signal check interval",
    await ask("Signal check interval (min)", { default: d("signalPollIntervalMin", "5") }),
  );
  const universeRaw = (await ask("Universe (from-signals or marketRefs)", { default: d("universe", "from-signals") })).trim();
  return {
    topN,
    dailyBudgetUsd,
    positionBudgetPct,
    entrySpreadPp,
    minEntryNotional,
    universe: universeRaw === "from-signals" ? "from-signals" : universeRaw.split(",").map((s) => s.trim()),
    tickIntervalMin: positionCheckSeconds / 60,
    signalPollIntervalMin,
  };
}

export interface StrategyOptions {
  top?: string;
  dailyBudget?: string;
  positionBudgetPct?: string;
  minEntryNotional?: string;
  positionCheckSeconds?: string;
  signalCheckMinutes?: string;
  signalMaxAgeHours?: string;
  slippage?: string;
  maxOrderNotional?: string;
}

/** `cassie strategy <botId>`: view and tune the bot's strategy and signal guardrails. */
export async function runStrategy(botId: string, opts: StrategyOptions = {}): Promise<void> {
  const cfg = loadBotConfig(botId);
  if (cfg.strategy.id === "agent") {
    throw new Error(
      `bot "${botId}" runs the agent strategy — tune it with \`cassie agent prompt|persona|status ${botId}\`, or re-run \`cassie init\` to change strategies`,
    );
  }
  const directUpdate = Object.values(opts).some((value) => value !== undefined);
  if (directUpdate) {
    const strategyConfig = normalizeStrategyConfig(cfg.strategy.config as Record<string, unknown>);
    let tickIntervalMin = cfg.tickIntervalMin;
    if (opts.top !== undefined) strategyConfig.topN = positionLimit(opts.top);
    if (opts.dailyBudget !== undefined) strategyConfig.dailyBudgetUsd = positiveNumber("daily entry budget", opts.dailyBudget);
    if (opts.positionBudgetPct !== undefined) {
      strategyConfig.positionBudgetPct = percentage("budget per position", opts.positionBudgetPct);
    }
    if (opts.minEntryNotional !== undefined) {
      strategyConfig.minEntryNotional = nonnegativeNumber("minimum entry notional", opts.minEntryNotional);
    }
    if (opts.positionCheckSeconds !== undefined) {
      tickIntervalMin = positiveNumber("position check interval", opts.positionCheckSeconds) / 60;
    }
    if (opts.signalCheckMinutes !== undefined) {
      strategyConfig.signalPollIntervalMin = positiveNumber("signal check interval", opts.signalCheckMinutes);
    }
    const maxAgeSec =
      opts.signalMaxAgeHours === undefined
        ? cfg.signals.maxAgeSec
        : positiveNumber("signal max age hours", opts.signalMaxAgeHours) * 60 * 60;
    const risk = {
      ...cfg.risk,
      ...(opts.slippage === undefined ? {} : { slippagePct: percentage("slippage", opts.slippage) }),
      ...(opts.maxOrderNotional === undefined
        ? {}
        : { maxOrderNotional: positiveNumber("maximum order notional", opts.maxOrderNotional) }),
    };
    saveBotConfig({
      ...cfg,
      strategy: { ...cfg.strategy, config: strategyConfig },
      signals: { ...cfg.signals, maxAgeSec },
      risk,
      tickIntervalMin,
    });
    console.log(pc.green(`saved strategy settings for ${botId}`));
    printStrategy(strategyConfig, maxAgeSec, risk, tickIntervalMin);
    return;
  }
  console.log(pc.bold(`strategy: signals`));
  printStrategy(cfg.strategy.config as Record<string, unknown>, cfg.signals.maxAgeSec, cfg.risk, cfg.tickIntervalMin);
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

function positionLimit(raw: string): number | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "unlimited" || normalized === "none" || normalized === "off") return null;
  return positiveInteger("position limit", raw);
}

function percentage(label: string, raw: string): number {
  const value = positiveNumber(label, raw);
  if (value > 100) throw new Error(`${label} must be at most 100%`);
  return value;
}

function normalizeStrategyConfig(config: Record<string, unknown>): Record<string, unknown> {
  // tickIntervalMin is saved at the top of the bot config, not here.
  const {
    sizing: _sizing,
    maxPositionNotional: _maxPositionNotional,
    maxOpenPositions: _maxOpenPositions,
    tickIntervalMin: _tickIntervalMin,
    ...current
  } = config;
  return current;
}

function printStrategy(
  config: Record<string, unknown>,
  maxAgeSec: number,
  risk: { maxOrderNotional: number; slippagePct: number },
  tickIntervalMin: number,
): void {
  const current = { ...RECOMMENDED_STRATEGY, ...normalizeStrategyConfig(config) };
  const dailyBudgetUsd = Number(current.dailyBudgetUsd);
  const positionBudgetPct = Number(current.positionBudgetPct);
  const perEntryUsd = (dailyBudgetUsd * positionBudgetPct) / 100;
  const positionLimit = current.topN === null ? "unlimited" : String(current.topN);
  console.log(`  position limit:       ${positionLimit} (widest eligible edges first)`);
  console.log(`  daily entry budget:   $${dailyBudgetUsd.toFixed(2)} (resets 00:00 UTC)`);
  console.log(`  budget per entry:     ${positionBudgetPct}% = $${perEntryUsd.toFixed(2)} before liquidity/risk caps`);
  console.log(`  minimum entry edge:   ${current.entrySpreadPp}pp`);
  console.log(`  minimum viable entry: $${Number(current.minEntryNotional).toFixed(2)}`);
  console.log(`  slippage:             ${risk.slippagePct}% from best executable price`);
  console.log(`  hard per-order cap:   $${risk.maxOrderNotional.toFixed(2)} (risk module)`);
  console.log(`  signal max age:       ${(maxAgeSec / 3600).toFixed(2)}h`);
  console.log(`  signal checks:        every ${compactNumber(Number(current.signalPollIntervalMin))} min`);
  console.log(`  position checks:      every ${compactNumber(tickIntervalMin * 60)} sec`);
  console.log(`  universe:             ${Array.isArray(current.universe) ? current.universe.join(", ") : current.universe}`);
}

function compactNumber(value: number): string {
  return String(Number(value.toFixed(4)));
}

function saveStrategy(botId: string, config: Record<string, unknown>): void {
  const cfg = loadBotConfig(botId);
  const tickIntervalMin = Number(config.tickIntervalMin ?? cfg.tickIntervalMin);
  const normalized = normalizeStrategyConfig(config);
  saveBotConfig({
    ...cfg,
    strategy: { id: "signals", config: normalized },
    tickIntervalMin,
  });
  console.log(pc.green(`saved strategy settings for ${botId}`));
  printStrategy(normalized, cfg.signals.maxAgeSec, cfg.risk, tickIntervalMin);
}

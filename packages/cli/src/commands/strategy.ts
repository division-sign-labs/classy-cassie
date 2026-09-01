// packages/cli/src/commands/strategy.ts
// The one strategy is `signals`: follow Quotient signals, hold until the
// market prices in the forecast. The wizard offers the recommended settings in
// one keystroke; this command is the manual flow for tuning them.

import pc from "picocolors";
import { ask, confirm } from "../context.js";
import { loadBotConfig, saveBotConfig } from "../paths.js";

export const RECOMMENDED_STRATEGY = {
  topN: null,
  allocationMode: "portfolio-kelly",
  kellyFraction: 0.25,
  marketCapPct: 5,
  eventCapPct: 7.5,
  minExitDepth2cUsd: 2_500,
  entrySpreadPp: 10,
  maxEntrySpreadPp: 30,
  minEntryNotional: 1,
  minConvergenceProfitPct: 2,
  maxHoldDays: 7,
  universe: "from-signals",
  tickIntervalMin: 1,
  signalPollIntervalMin: 5,
} as const;

export const RECOMMENDED_SUMMARY =
  "no position-count cap, widest eligible edges first, quarter-Kelly targets with same-side top-ups, " +
  "capped at 5% per market and 7.5% per event, $2.5k exit depth within 2¢, 10–30pp entry edge, " +
  "+2% positive convergence or 7-day max hold";

const LEGACY_DAILY_BUDGET_STRATEGY = {
  topN: null,
  allocationMode: "daily-budget",
  dailyBudgetUsd: 100,
  positionBudgetPct: 25,
  entrySpreadPp: 10,
  maxEntrySpreadPp: 30,
  minEntryNotional: 1,
  minConvergenceProfitPct: 2,
  maxHoldDays: 7,
  universe: "from-signals",
  tickIntervalMin: 1,
  signalPollIntervalMin: 5,
} as const;

const LEGACY_DAILY_BUDGET_SUMMARY =
  "no position-count cap, widest eligible edges first, $100 daily budget, 25% requested per entry, " +
  "10–30pp entry edge, positions every 60s, signals every 5m";

type AllocationMode = "portfolio-kelly" | "daily-budget";

export function recommendedStrategySummary(venue?: string): string {
  return venue === "hyperliquid" ? LEGACY_DAILY_BUDGET_SUMMARY : RECOMMENDED_SUMMARY;
}

export async function elicitRecommendedStrategyConfig(
  current: Record<string, unknown> = {},
  venue?: string,
): Promise<Record<string, unknown>> {
  if (venue !== "hyperliquid") return { ...RECOMMENDED_STRATEGY };

  const dailyBudgetUsd = positiveNumber(
    "daily entry budget",
    await ask("Daily entry budget ($, resets at 00:00 UTC)", {
      default: String(current.dailyBudgetUsd ?? LEGACY_DAILY_BUDGET_STRATEGY.dailyBudgetUsd),
    }),
  );
  return { ...LEGACY_DAILY_BUDGET_STRATEGY, dailyBudgetUsd };
}

export async function elicitStrategyConfig(
  current: Record<string, unknown> = {},
  venue?: string,
): Promise<Record<string, unknown>> {
  const d = (k: string, fallback: string) => String(current[k] ?? fallback);
  const topN = positionLimit(
    await ask("Maximum signal positions (number or unlimited)", {
      default: current.topN === null ? "unlimited" : d("topN", "unlimited"),
    }),
  );
  const allocationMode = parseAllocationMode(
    await ask("Allocation mode (portfolio-kelly or daily-budget)", {
      default: configuredAllocationMode(current, venue),
    }),
  );
  const allocationConfig =
    allocationMode === "portfolio-kelly"
      ? {
          kellyFraction: kellyFraction(
            "Kelly fraction",
            await ask("Kelly fraction (0–1; 0.25 = quarter Kelly)", { default: d("kellyFraction", "0.25") }),
          ),
          marketCapPct: percentage(
            "market cap",
            await ask("Maximum portfolio equity per market (%)", {
              default: d("marketCapPct", String(RECOMMENDED_STRATEGY.marketCapPct)),
            }),
          ),
          eventCapPct: percentage(
            "event cap",
            await ask("Maximum portfolio equity per parent event (%)", {
              default: d("eventCapPct", String(RECOMMENDED_STRATEGY.eventCapPct)),
            }),
          ),
          minExitDepth2cUsd: nonnegativeNumber(
            "minimum exit depth within 2 cents",
            await ask("Minimum held-side bid depth within 2¢ ($; 0 disables)", {
              default: d("minExitDepth2cUsd", "2500"),
            }),
          ),
        }
      : {
          dailyBudgetUsd: positiveNumber(
            "daily entry budget",
            await ask("Daily entry budget ($, resets at 00:00 UTC)", { default: d("dailyBudgetUsd", "100") }),
          ),
          positionBudgetPct: percentage(
            "budget per position",
            await ask("Daily budget per position (%)", { default: d("positionBudgetPct", "25") }),
          ),
        };
  const entrySpreadPp = positiveNumber("entry spread", await ask("Minimum entry edge (pp)", { default: d("entrySpreadPp", "10") }));
  const maxEntrySpreadPp = optionalPositiveNumber(
    "maximum entry edge",
    await ask("Maximum entry edge (pp or unlimited)", {
      default: current.maxEntrySpreadPp === null ? "unlimited" : d("maxEntrySpreadPp", "30"),
    }),
  );
  const minEntryNotional = nonnegativeNumber(
    "minimum entry",
    await ask("Minimum viable entry after risk caps ($)", { default: d("minEntryNotional", "1") }),
  );
  const minConvergenceProfitPct = nonnegativeNumber(
    "minimum convergence profit",
    await ask("Minimum executable gain for early convergence (%)", {
      default: d("minConvergenceProfitPct", "2"),
    }),
  );
  const maxHoldDays = optionalPositiveNumber(
    "maximum hold",
    await ask("Maximum hold (days or unlimited)", {
      default: current.maxHoldDays === null ? "unlimited" : d("maxHoldDays", "7"),
    }),
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
    allocationMode,
    ...allocationConfig,
    entrySpreadPp,
    maxEntrySpreadPp,
    minEntryNotional,
    minConvergenceProfitPct,
    maxHoldDays,
    universe: universeRaw === "from-signals" ? "from-signals" : universeRaw.split(",").map((s) => s.trim()),
    tickIntervalMin: positionCheckSeconds / 60,
    signalPollIntervalMin,
  };
}

export interface StrategyOptions {
  top?: string;
  allocationMode?: string;
  kellyFraction?: string;
  marketCapPct?: string;
  eventCapPct?: string;
  minExitDepth2cUsd?: string;
  dailyBudget?: string;
  positionBudgetPct?: string;
  maxEntryEdge?: string;
  minEntryNotional?: string;
  minConvergenceProfitPct?: string;
  maxHoldDays?: string;
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
  if (cfg.strategy.id === "market-make") {
    throw new Error(
      `bot "${botId}" runs the market-make strategy — tune it with \`cassie market-make configure ${botId}\``,
    );
  }
  if (cfg.strategy.id !== "signals" && cfg.strategy.id !== "flip-flat") {
    throw new Error(`bot "${botId}" runs the unsupported "${cfg.strategy.id}" strategy`);
  }
  const directUpdate = Object.values(opts).some((value) => value !== undefined);
  if (directUpdate) {
    const strategyConfig = normalizeStrategyConfig(cfg.strategy.config as Record<string, unknown>);
    let tickIntervalMin = cfg.tickIntervalMin;
    if (opts.top !== undefined) strategyConfig.topN = positionLimit(opts.top);
    const requestedMode = requestedAllocationMode(opts);
    strategyConfig.allocationMode ??= configuredAllocationMode(strategyConfig, cfg.venue);
    if (requestedMode !== undefined) {
      strategyConfig.allocationMode = requestedMode;
      if (requestedMode === "portfolio-kelly") {
        delete strategyConfig.dailyBudgetUsd;
        delete strategyConfig.positionBudgetPct;
        strategyConfig.kellyFraction ??= RECOMMENDED_STRATEGY.kellyFraction;
        strategyConfig.marketCapPct ??= RECOMMENDED_STRATEGY.marketCapPct;
        strategyConfig.eventCapPct ??= RECOMMENDED_STRATEGY.eventCapPct;
        strategyConfig.minExitDepth2cUsd ??= RECOMMENDED_STRATEGY.minExitDepth2cUsd;
      } else {
        delete strategyConfig.kellyFraction;
        delete strategyConfig.marketCapPct;
        delete strategyConfig.eventCapPct;
        delete strategyConfig.minExitDepth2cUsd;
        strategyConfig.dailyBudgetUsd ??= LEGACY_DAILY_BUDGET_STRATEGY.dailyBudgetUsd;
        strategyConfig.positionBudgetPct ??= LEGACY_DAILY_BUDGET_STRATEGY.positionBudgetPct;
      }
    }
    if (opts.kellyFraction !== undefined) {
      strategyConfig.kellyFraction = kellyFraction("Kelly fraction", opts.kellyFraction);
    }
    if (opts.marketCapPct !== undefined) strategyConfig.marketCapPct = percentage("market cap", opts.marketCapPct);
    if (opts.eventCapPct !== undefined) strategyConfig.eventCapPct = percentage("event cap", opts.eventCapPct);
    if (opts.minExitDepth2cUsd !== undefined) {
      strategyConfig.minExitDepth2cUsd = nonnegativeNumber(
        "minimum exit depth within 2 cents",
        opts.minExitDepth2cUsd,
      );
    }
    if (opts.dailyBudget !== undefined) strategyConfig.dailyBudgetUsd = positiveNumber("daily entry budget", opts.dailyBudget);
    if (opts.positionBudgetPct !== undefined) {
      strategyConfig.positionBudgetPct = percentage("budget per position", opts.positionBudgetPct);
    }
    if (opts.maxEntryEdge !== undefined) {
      strategyConfig.maxEntrySpreadPp = optionalPositiveNumber("maximum entry edge", opts.maxEntryEdge);
    }
    if (opts.minEntryNotional !== undefined) {
      strategyConfig.minEntryNotional = nonnegativeNumber("minimum entry notional", opts.minEntryNotional);
    }
    if (opts.minConvergenceProfitPct !== undefined) {
      strategyConfig.minConvergenceProfitPct = nonnegativeNumber(
        "minimum convergence profit",
        opts.minConvergenceProfitPct,
      );
    }
    if (opts.maxHoldDays !== undefined) {
      strategyConfig.maxHoldDays = optionalPositiveNumber("maximum hold", opts.maxHoldDays);
    }
    if (opts.positionCheckSeconds !== undefined) {
      tickIntervalMin = positiveNumber("position check interval", opts.positionCheckSeconds) / 60;
      strategyConfig.tickIntervalMin = tickIntervalMin;
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
    validateEntryEdgeRange(strategyConfig);
    saveBotConfig({
      ...cfg,
      strategy: { ...cfg.strategy, config: strategyConfig },
      signals: { ...cfg.signals, maxAgeSec },
      risk,
      tickIntervalMin,
    });
    console.log(pc.green(`saved strategy settings for ${botId}`));
    printStrategy(strategyConfig, maxAgeSec, risk, tickIntervalMin, cfg.venue);
    return;
  }
  console.log(pc.bold(`strategy: signals`));
  printStrategy(cfg.strategy.config as Record<string, unknown>, cfg.signals.maxAgeSec, cfg.risk, cfg.tickIntervalMin, cfg.venue);
  const recommendedSummary = recommendedStrategySummary(cfg.venue);
  if (await confirm(`Reset to recommended (${recommendedSummary})?`, false)) {
    saveStrategy(botId, await elicitRecommendedStrategyConfig(cfg.strategy.config as Record<string, unknown>, cfg.venue));
    return;
  }
  const config = await elicitStrategyConfig(cfg.strategy.config as Record<string, unknown>, cfg.venue);
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

function optionalPositiveNumber(label: string, raw: string): number | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "unlimited" || normalized === "none" || normalized === "off") return null;
  return positiveNumber(label, raw);
}

function parseAllocationMode(raw: string): AllocationMode {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "portfolio-kelly" || normalized === "daily-budget") return normalized;
  throw new Error("allocation mode must be portfolio-kelly or daily-budget");
}

function configuredAllocationMode(config: Record<string, unknown>, venue?: string): AllocationMode {
  if (config.allocationMode === "portfolio-kelly" || config.allocationMode === "daily-budget") {
    return config.allocationMode;
  }
  if (Object.hasOwn(config, "dailyBudgetUsd") || Object.hasOwn(config, "positionBudgetPct")) return "daily-budget";
  return venue === "hyperliquid" ? "daily-budget" : "portfolio-kelly";
}

function requestedAllocationMode(opts: StrategyOptions): AllocationMode | undefined {
  const explicit = opts.allocationMode === undefined ? undefined : parseAllocationMode(opts.allocationMode);
  const requestsDailyBudget = opts.dailyBudget !== undefined || opts.positionBudgetPct !== undefined;
  const requestsPortfolioKelly =
    opts.kellyFraction !== undefined ||
    opts.marketCapPct !== undefined ||
    opts.eventCapPct !== undefined ||
    opts.minExitDepth2cUsd !== undefined;

  if (requestsDailyBudget && requestsPortfolioKelly) {
    throw new Error("daily-budget and portfolio-kelly sizing options cannot be combined");
  }
  if (explicit === "portfolio-kelly" && requestsDailyBudget) {
    throw new Error("--allocation-mode portfolio-kelly conflicts with daily-budget sizing options");
  }
  if (explicit === "daily-budget" && requestsPortfolioKelly) {
    throw new Error("--allocation-mode daily-budget conflicts with Kelly/cap sizing options");
  }
  if (explicit !== undefined) return explicit;
  if (requestsDailyBudget) return "daily-budget";
  if (requestsPortfolioKelly) return "portfolio-kelly";
  return undefined;
}

function kellyFraction(label: string, raw: string): number {
  const value = positiveNumber(label, raw);
  if (value > 1) throw new Error(`${label} must be at most 1`);
  return value;
}

function validateEntryEdgeRange(config: Record<string, unknown>): void {
  const minimum = Number(config.entrySpreadPp ?? RECOMMENDED_STRATEGY.entrySpreadPp);
  const configuredMaximum =
    config.maxEntrySpreadPp === undefined ? RECOMMENDED_STRATEGY.maxEntrySpreadPp : config.maxEntrySpreadPp;
  if (configuredMaximum !== null && Number(configuredMaximum) < minimum) {
    throw new Error(`maximum entry edge must be at least the ${minimum}pp minimum entry edge`);
  }
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
  risk: { maxOrderNotional: number; slippagePct: number },
  tickIntervalMin: number,
  venue?: string,
): void {
  const normalized = normalizeStrategyConfig(config);
  const allocationMode = configuredAllocationMode(normalized, venue);
  const defaults = allocationMode === "portfolio-kelly" ? RECOMMENDED_STRATEGY : LEGACY_DAILY_BUDGET_STRATEGY;
  const current = { ...defaults, ...normalized, allocationMode } as Record<string, unknown>;
  const positionLimit = current.topN === null ? "unlimited" : String(current.topN);
  console.log(`  position limit:       ${positionLimit} (widest eligible edges first)`);
  console.log(`  allocation mode:      ${allocationMode}`);
  if (allocationMode === "portfolio-kelly") {
    console.log(`  Kelly fraction:       ${current.kellyFraction}× full Kelly (current portfolio equity)`);
    console.log(`  per-market cap:       ${current.marketCapPct}% of portfolio equity`);
    console.log(`  per-event cap:        ${current.eventCapPct}% of portfolio equity`);
    console.log(`  entry liquidity:      $${Number(current.minExitDepth2cUsd).toFixed(2)} held-side bid depth within 2¢`);
    console.log("  repeat signals:       top up toward target; over-cap holdings are not auto-trimmed");
  } else {
    const dailyBudgetUsd = Number(current.dailyBudgetUsd);
    const positionBudgetPct = Number(current.positionBudgetPct);
    const perEntryUsd = (dailyBudgetUsd * positionBudgetPct) / 100;
    console.log(`  daily entry budget:   $${dailyBudgetUsd.toFixed(2)} (resets 00:00 UTC)`);
    console.log(`  budget per entry:     ${positionBudgetPct}% = $${perEntryUsd.toFixed(2)} before liquidity/risk caps`);
  }
  console.log(`  minimum entry edge:   ${current.entrySpreadPp}pp`);
  console.log(
    `  maximum entry edge:   ${current.maxEntrySpreadPp === null ? "unlimited" : `${current.maxEntrySpreadPp}pp`}`,
  );
  console.log(`  minimum viable entry: $${Number(current.minEntryNotional).toFixed(2)}`);
  console.log(`  convergence profit:   +${Number(current.minConvergenceProfitPct).toFixed(2)}% minimum executable gain`);
  console.log(
    `  maximum hold:         ${current.maxHoldDays === null ? "unlimited" : `${current.maxHoldDays} days`}`,
  );
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
  const normalized = normalizeStrategyConfig(config);
  validateEntryEdgeRange(normalized);
  const tickIntervalMin = Number(normalized.tickIntervalMin ?? cfg.tickIntervalMin);
  saveBotConfig({
    ...cfg,
    strategy: { id: "signals", config: normalized },
    tickIntervalMin,
  });
  console.log(pc.green(`saved strategy settings for ${botId}`));
  printStrategy(normalized, cfg.signals.maxAgeSec, cfg.risk, tickIntervalMin, cfg.venue);
}

// packages/cli/src/commands/strategy.ts
// Configure the signals strategy; other strategies use their own command groups.
//
// Only operator settings live here: sizing, caps, cadence, universe. The
// entry and exit rules themselves are served by Quotient behind the bot's
// strategy key and override anything rule-shaped in the saved config.

import pc from "picocolors";
import {
  PredictionExecutionConfigSchema,
  QUOTIENT_POLYMARKET_BUILDER_FEE_PCT,
  type PredictionExecutionConfig,
} from "@quotient-forecasting/cassie-core";
import { stripFlipFlatRules } from "@quotient-forecasting/strategy-flip-flat";
import { ask, confirm } from "../context.js";
import { loadBotConfig, saveBotConfig } from "../paths.js";

export const RECOMMENDED_STRATEGY = {
  topN: null,
  allocationMode: "portfolio-kelly",
  kellyFraction: 0.25,
  marketCapPct: 2.5,
  eventCapPct: 5,
  minExitDepth2cUsd: 2_500,
  minEntryNotional: 1,
  universe: "from-signals",
  tickIntervalMin: 1,
  signalPollIntervalMin: 5,
} as const;

export const RECOMMENDED_SUMMARY =
  "no position-count cap, widest eligible edges first, quarter-Kelly targets with same-side top-ups, " +
  "capped at 2.5% per market and 5% per event, $2.5k exit depth within 2¢; " +
  "entry and exit rules are served by Quotient";

const LEGACY_DAILY_BUDGET_STRATEGY = {
  topN: null,
  allocationMode: "daily-budget",
  dailyBudgetUsd: 100,
  positionBudgetPct: 25,
  minEntryNotional: 1,
  universe: "from-signals",
  tickIntervalMin: 1,
  signalPollIntervalMin: 5,
} as const;

const LEGACY_DAILY_BUDGET_SUMMARY =
  "no position-count cap, widest eligible edges first, $100 daily budget, 25% requested per entry, " +
  "positions every 60s, signals every 5m; entry and exit rules are served by Quotient";

/** Shown wherever a Polymarket signals bot is configured, run, or deployed. */
export const POLYMARKET_FEE_DISCLOSURE =
  `Quotient charges ${QUOTIENT_POLYMARKET_BUILDER_FEE_PCT}% of notional on each Polymarket fill, collected by Polymarket as a builder fee.`;

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
    allocationMode,
    ...allocationConfig,
    minEntryNotional,
    universe: universeRaw === "from-signals" ? "from-signals" : universeRaw.split(",").map((s) => s.trim()),
    tickIntervalMin: positionCheckSeconds / 60,
    signalPollIntervalMin,
  };
}

export interface StrategyOptions {
  execution?: string;
  entryDeadlineSeconds?: string;
  exitPassiveSeconds?: string;
  top?: string;
  allocationMode?: string;
  kellyFraction?: string;
  marketCapPct?: string;
  eventCapPct?: string;
  minExitDepth2cUsd?: string;
  dailyBudget?: string;
  positionBudgetPct?: string;
  minEntryNotional?: string;
  positionCheckSeconds?: string;
  signalCheckMinutes?: string;
  signalMaxAgeHours?: string;
  slippage?: string;
  maxOrderNotional?: string;
}

/** `cassie strategy <botId>`: view and tune the bot's operator settings and guardrails. */
export async function runStrategy(botId: string, opts: StrategyOptions = {}): Promise<void> {
  const cfg = loadBotConfig(botId);
  const executionOptions = ["execution", "entryDeadlineSeconds", "exitPassiveSeconds"] as const;
  const hasExecutionOptions = executionOptions.some((name) => opts[name] !== undefined);
  if (hasExecutionOptions && (cfg.venue !== "polymarket" || !["signals", "flip-flat"].includes(cfg.strategy.id))) {
    throw new Error("execution settings are supported only for Polymarket signals bots");
  }
  if (cfg.strategy.id === "agent") {
    throw new Error(
      `${botId} uses the agent strategy.\ncassie agent prompt ${botId}\ncassie agent persona ${botId}\ncassie agent status ${botId}`,
    );
  }
  if (cfg.strategy.id === "quotient-swing") {
    throw new Error(`${botId} uses quotient-swing.\ncassie swing configure ${botId}\ncassie swing status ${botId}`);
  }
  if (cfg.strategy.id === "kalshi-commodities") {
    throw new Error(`${botId} uses kalshi-commodities.\ncassie commodities configure ${botId}\ncassie commodities status ${botId}`);
  }
  if (cfg.strategy.id !== "signals" && cfg.strategy.id !== "flip-flat") {
    throw new Error(`bot "${botId}" runs the unsupported "${cfg.strategy.id}" strategy`);
  }
  const directUpdate = Object.values(opts).some((value) => value !== undefined);
  if (directUpdate) {
    let execution = cfg.execution;
    if (hasExecutionOptions) {
      execution = PredictionExecutionConfigSchema.parse({
        ...cfg.execution,
        ...(opts.execution === undefined ? {} : { mode: opts.execution.trim().toLowerCase() }),
        ...(opts.entryDeadlineSeconds === undefined
          ? {}
          : { entryDeadlineSec: positiveNumber("entry deadline", opts.entryDeadlineSeconds) }),
        ...(opts.exitPassiveSeconds === undefined
          ? {}
          : { exitPassiveSec: nonnegativeNumber("exit passive duration", opts.exitPassiveSeconds) }),
      });
      const onlyExecutionOptions = Object.entries(opts).every(
        ([name, value]) => value === undefined || (executionOptions as readonly string[]).includes(name),
      );
      if (onlyExecutionOptions) {
        saveBotConfig({ ...cfg, execution });
        console.log(pc.green(`saved strategy settings for ${botId}`));
        printStrategy(cfg.strategy.config, cfg.signals.maxAgeSec, cfg.risk, cfg.tickIntervalMin, cfg.venue, execution);
        return;
      }
    }
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
    if (opts.minEntryNotional !== undefined) {
      strategyConfig.minEntryNotional = nonnegativeNumber("minimum entry notional", opts.minEntryNotional);
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
    saveBotConfig({
      ...cfg,
      strategy: { ...cfg.strategy, config: strategyConfig },
      signals: { ...cfg.signals, maxAgeSec },
      risk,
      tickIntervalMin,
      ...(hasExecutionOptions ? { execution } : {}),
    });
    console.log(pc.green(`saved strategy settings for ${botId}`));
    printStrategy(strategyConfig, maxAgeSec, risk, tickIntervalMin, cfg.venue, execution);
    return;
  }
  console.log(pc.bold(`strategy: signals`));
  printStrategy(cfg.strategy.config as Record<string, unknown>, cfg.signals.maxAgeSec, cfg.risk, cfg.tickIntervalMin, cfg.venue, cfg.execution);
  const recommendedSummary = recommendedStrategySummary(cfg.venue);
  console.log(`Recommended: ${recommendedSummary}`);
  if (await confirm("Reset to recommended settings?", false)) {
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

function percentage(label: string, raw: string): number {
  const value = positiveNumber(label, raw);
  if (value > 100) throw new Error(`${label} must be at most 100%`);
  return value;
}

/**
 * Drop retired sizing keys and every rule key. Rules saved by older versions
 * of this command are already overridden at runtime; removing them here keeps
 * the saved config honest about what the operator controls.
 */
function normalizeStrategyConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { sizing: _sizing, maxPositionNotional: _maxPositionNotional, maxOpenPositions: _maxOpenPositions, ...current } = config;
  return stripFlipFlatRules(current);
}

function printStrategy(
  config: Record<string, unknown>,
  maxAgeSec: number,
  risk: { maxOrderNotional: number; slippagePct: number },
  tickIntervalMin: number,
  venue?: string,
  execution?: PredictionExecutionConfig,
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
  console.log(`  minimum viable entry: $${Number(current.minEntryNotional).toFixed(2)} (entries only; exits are never floored)`);
  console.log("  entry and exit rules: served by Quotient for the signals strategy; the bot's strategy key selects them");
  console.log(`  slippage:             ${risk.slippagePct}% from best executable price`);
  const executionConfig = PredictionExecutionConfigSchema.parse(execution ?? {});
  const executionMode = venue === "polymarket" ? executionConfig.mode : "legacy";
  console.log(`  execution:            ${executionMode} (${executionMode === "adaptive" ? "managed post-only limits" : "crossing limits"})`);
  if (venue === "polymarket") {
    const inactive = executionMode === "legacy" ? " (inactive in legacy mode)" : "";
    console.log(`  entry deadline:       ${compactNumber(executionConfig.entryDeadlineSec)} sec${inactive}`);
    console.log(`  exit passive phase:   ${compactNumber(executionConfig.exitPassiveSec)} sec${inactive}`);
    console.log(`  Quotient fee:         ${QUOTIENT_POLYMARKET_BUILDER_FEE_PCT}% of notional per fill, collected by Polymarket as a builder fee`);
  }
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
  const tickIntervalMin = Number(normalized.tickIntervalMin ?? cfg.tickIntervalMin);
  saveBotConfig({
    ...cfg,
    strategy: { id: "signals", config: normalized },
    tickIntervalMin,
  });
  console.log(pc.green(`saved strategy settings for ${botId}`));
  printStrategy(normalized, cfg.signals.maxAgeSec, cfg.risk, tickIntervalMin, cfg.venue, cfg.execution);
}

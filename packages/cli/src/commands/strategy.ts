// packages/cli/src/commands/strategy.ts
// Configure the signals strategy; other strategies use their own command groups.

import pc from "picocolors";
import {
  PredictionExecutionConfigSchema,
  describePolymarketBuilderFee,
  polymarketFeeMode,
  type PredictionExecutionConfig,
} from "@quotient-forecasting/cassie-core";
import { ask, confirm } from "../context.js";
import { loadBotConfig, saveBotConfig } from "../paths.js";

export const RECOMMENDED_STRATEGY = {
  topN: null,
  allocationMode: "portfolio-kelly",
  kellyFraction: 0.25,
  marketCapPct: 2.5,
  eventCapPct: 5,
  minExitDepth2cUsd: 2_500,
  nearResolutionDays: 3,
  nearResolutionSizeCutPct: 25,
  entrySpreadPp: 10,
  maxEntrySpreadPp: 30,
  minEntryNotional: 1,
  takeProfitPrice: 0.9,
  maxHoldDays: null,
  universe: "from-signals",
  tickIntervalMin: 1,
  signalPollIntervalMin: 5,
} as const;

export const RECOMMENDED_SUMMARY =
  "no position-count cap, widest eligible edges first, quarter-Kelly targets with same-side top-ups, " +
  "capped at 2.5% per market and 5% per event, 25% smaller within 3 days of resolution, " +
  "$2.5k exit depth within 2¢, 10–30pp entry edge, sell at a 90¢ bid or hold to resolution, no time limit";

const LEGACY_DAILY_BUDGET_STRATEGY = {
  topN: null,
  allocationMode: "daily-budget",
  dailyBudgetUsd: 100,
  positionBudgetPct: 25,
  nearResolutionDays: 3,
  nearResolutionSizeCutPct: 25,
  entrySpreadPp: 10,
  maxEntrySpreadPp: 30,
  minEntryNotional: 1,
  takeProfitPrice: 0.9,
  maxHoldDays: null,
  universe: "from-signals",
  tickIntervalMin: 1,
  signalPollIntervalMin: 5,
} as const;

const LEGACY_DAILY_BUDGET_SUMMARY =
  "no position-count cap, widest eligible edges first, $100 daily budget, 25% requested per entry, " +
  "10–30pp entry edge, positions every 60s, signals every 5m";

type AllocationMode = "portfolio-kelly" | "daily-budget" | "fixed-notional";

/**
 * Hold-to-resolution preset: `cassie strategy <bot> --preset hold`, or `signals-hold`
 * in `cassie init`. One fixed-dollar lot per market, entered on the first signal seen
 * with at least 15pp of edge and at most 60 days to resolution; sold only after two
 * consecutive committed forecasts put Q on the other side of 50%; otherwise held to
 * the payout. Replayed on every published Polymarket signal from 2026-06-29 to 09-16
 * (q-trade-analysis/signal-daily-hold-report.md): +19.6% per lot, about 1.3 lots a day.
 */
export const HOLD_STRATEGY = {
  topN: null,
  allocationMode: "fixed-notional",
  lotNotionalUsd: 10,
  nearResolutionDays: null,
  nearResolutionSizeCutPct: 25,
  entrySpreadPp: 15,
  maxEntrySpreadPp: null,
  maxWindowDays: 60,
  minEntryNotional: 1,
  takeProfitPrice: null,
  maxHoldDays: null,
  scenarioExitEnabled: true,
  adverseCrossConfirmations: null,
  qCollapsePp: null,
  flipConfirmations: 2,
  flipExitMaxRemainingEdgePp: null,
  universe: "from-signals",
  tickIntervalMin: 1,
  signalPollIntervalMin: 5,
} as const;

export const HOLD_SUMMARY =
  "one fixed $10 lot per market with no top-ups, 15pp+ entry edge with no ceiling, 60 days or less to resolution, " +
  "sell only after two consecutive forecasts put Q on the other side of 50%, otherwise hold to the payout; " +
  "no take-profit, no time stop, no collapse or adverse-cross exit";

export type StrategyPreset = "recommended" | "hold";

export function presetStrategyConfig(preset: StrategyPreset, venue?: string): Record<string, unknown> {
  if (preset === "hold") return { ...HOLD_STRATEGY };
  return { ...(venue === "hyperliquid" ? LEGACY_DAILY_BUDGET_STRATEGY : RECOMMENDED_STRATEGY) };
}

function parsePreset(raw: string): StrategyPreset {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "recommended" || normalized === "hold") return normalized;
  throw new Error("preset must be recommended or hold");
}

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
  const takeProfitPrice = optionalPrice(
    "take-profit price",
    await ask("Take-profit held-side bid (0–1, or off)", {
      default: current.takeProfitPrice === null ? "off" : d("takeProfitPrice", "0.9"),
    }),
  );
  const maxHoldDays = optionalPositiveNumber(
    "maximum hold",
    await ask("Maximum hold (days or unlimited)", {
      default: current.maxHoldDays === null ? "unlimited" : d("maxHoldDays", "unlimited"),
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
    takeProfitPrice,
    maxHoldDays,
    universe: universeRaw === "from-signals" ? "from-signals" : universeRaw.split(",").map((s) => s.trim()),
    tickIntervalMin: positionCheckSeconds / 60,
    signalPollIntervalMin,
  };
}

export interface StrategyOptions {
  preset?: string;
  execution?: string;
  entryDeadlineSeconds?: string;
  entryCrossingSeconds?: string;
  exitPassiveSeconds?: string;
  top?: string;
  allocationMode?: string;
  kellyFraction?: string;
  marketCapPct?: string;
  eventCapPct?: string;
  nearResolutionDays?: string;
  nearResolutionSizeCutPct?: string;
  minExitDepth2cUsd?: string;
  dailyBudget?: string;
  positionBudgetPct?: string;
  lotNotional?: string;
  maxEntryEdge?: string;
  maxWindowDays?: string;
  minEntryNotional?: string;
  takeProfitPrice?: string;
  maxHoldDays?: string;
  positionCheckSeconds?: string;
  signalCheckMinutes?: string;
  signalMaxAgeHours?: string;
  slippage?: string;
  maxOrderNotional?: string;
  scenarioExit?: string;
  adverseCrossEdgePp?: string;
  adverseCrossMaxPnlPct?: string;
  adverseCrossConfirmations?: string;
  qCollapsePp?: string;
  qCollapseMaxRemainingEdgePp?: string;
  flipConfirmations?: string;
  flipExitMaxRemainingEdgePp?: string;
  exitFeeBps?: string;
  exitRetrySeconds?: string;
  pendingEntryReservationSeconds?: string;
}

/** Defaults of the opt-in signal-exit state machine, mirrored from the strategy schema. */
export const SCENARIO_EXIT_DEFAULTS = {
  scenarioExitEnabled: false,
  adverseCrossEdgePp: 0,
  adverseCrossMaxPnlPct: 0,
  adverseCrossConfirmations: 2,
  qCollapsePp: 30,
  qCollapseMaxRemainingEdgePp: 0,
  flipConfirmations: 2,
  flipExitMaxRemainingEdgePp: null,
  exitFeeBps: 0,
  exitRetrySec: 300,
  pendingEntryReservationSec: 900,
} as const;

/** `cassie strategy <botId>`: view and tune the bot's strategy and signal guardrails. */
export async function runStrategy(botId: string, opts: StrategyOptions = {}): Promise<void> {
  const cfg = loadBotConfig(botId);
  const executionOptions = ["execution", "entryDeadlineSeconds", "entryCrossingSeconds", "exitPassiveSeconds"] as const;
  const hasExecutionOptions = executionOptions.some((name) => opts[name] !== undefined);
  if (hasExecutionOptions && (cfg.venue !== "polymarket" || !["signals", "flip-flat"].includes(cfg.strategy.id))) {
    throw new Error("execution settings are supported only for Polymarket signals bots");
  }
  if (cfg.strategy.id === "agent") {
    throw new Error(
      `${botId} uses the agent strategy.\ncassie agent prompt ${botId}\ncassie agent persona ${botId}\ncassie agent status ${botId}`,
    );
  }
  if (cfg.strategy.id === "market-make") {
    throw new Error(
      `${botId} uses the market-make strategy.\ncassie market-make configure ${botId}`,
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
        ...(opts.entryCrossingSeconds === undefined
          ? {}
          : { entryCrossingSec: nonnegativeNumber("entry crossing window", opts.entryCrossingSeconds) }),
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
    let strategyConfig = normalizeStrategyConfig(cfg.strategy.config as Record<string, unknown>);
    if (opts.preset !== undefined) strategyConfig = presetStrategyConfig(parsePreset(opts.preset), cfg.venue);
    let tickIntervalMin = cfg.tickIntervalMin;
    if (opts.top !== undefined) strategyConfig.topN = positionLimit(opts.top);
    const requestedMode = requestedAllocationMode(opts);
    strategyConfig.allocationMode ??= configuredAllocationMode(strategyConfig, cfg.venue);
    if (requestedMode !== undefined) {
      strategyConfig.allocationMode = requestedMode;
      if (requestedMode !== "daily-budget") {
        delete strategyConfig.dailyBudgetUsd;
        delete strategyConfig.positionBudgetPct;
      }
      if (requestedMode !== "portfolio-kelly") {
        delete strategyConfig.kellyFraction;
        delete strategyConfig.marketCapPct;
        delete strategyConfig.eventCapPct;
        delete strategyConfig.minExitDepth2cUsd;
      }
      if (requestedMode !== "fixed-notional") delete strategyConfig.lotNotionalUsd;
      if (requestedMode === "portfolio-kelly") {
        strategyConfig.kellyFraction ??= RECOMMENDED_STRATEGY.kellyFraction;
        strategyConfig.marketCapPct ??= RECOMMENDED_STRATEGY.marketCapPct;
        strategyConfig.eventCapPct ??= RECOMMENDED_STRATEGY.eventCapPct;
        strategyConfig.minExitDepth2cUsd ??= RECOMMENDED_STRATEGY.minExitDepth2cUsd;
      } else if (requestedMode === "daily-budget") {
        strategyConfig.dailyBudgetUsd ??= LEGACY_DAILY_BUDGET_STRATEGY.dailyBudgetUsd;
        strategyConfig.positionBudgetPct ??= LEGACY_DAILY_BUDGET_STRATEGY.positionBudgetPct;
      } else {
        strategyConfig.lotNotionalUsd ??= HOLD_STRATEGY.lotNotionalUsd;
      }
    }
    if (opts.kellyFraction !== undefined) {
      strategyConfig.kellyFraction = kellyFraction("Kelly fraction", opts.kellyFraction);
    }
    if (opts.marketCapPct !== undefined) strategyConfig.marketCapPct = percentage("market cap", opts.marketCapPct);
    if (opts.eventCapPct !== undefined) strategyConfig.eventCapPct = percentage("event cap", opts.eventCapPct);
    if (opts.nearResolutionDays !== undefined) {
      strategyConfig.nearResolutionDays = optionalPositiveNumber("near-resolution window", opts.nearResolutionDays);
    }
    if (opts.nearResolutionSizeCutPct !== undefined) {
      strategyConfig.nearResolutionSizeCutPct = cutPercentage("near-resolution size cut", opts.nearResolutionSizeCutPct);
    }
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
    if (opts.lotNotional !== undefined) strategyConfig.lotNotionalUsd = positiveNumber("lot notional", opts.lotNotional);
    if (opts.maxEntryEdge !== undefined) {
      strategyConfig.maxEntrySpreadPp = optionalPositiveNumber("maximum entry edge", opts.maxEntryEdge);
    }
    if (opts.maxWindowDays !== undefined) {
      strategyConfig.maxWindowDays = optionalPositiveNumber("maximum days to resolution", opts.maxWindowDays);
    }
    if (opts.minEntryNotional !== undefined) {
      strategyConfig.minEntryNotional = nonnegativeNumber("minimum entry notional", opts.minEntryNotional);
    }
    if (opts.takeProfitPrice !== undefined) {
      strategyConfig.takeProfitPrice = optionalPrice("take-profit price", opts.takeProfitPrice);
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
    applyScenarioExitOptions(strategyConfig, opts);
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

function onOff(label: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (["on", "true", "yes", "1", "enabled"].includes(normalized)) return true;
  if (["off", "false", "no", "0", "disabled"].includes(normalized)) return false;
  throw new Error(`${label} must be on or off`);
}

function signedNumber(label: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${label} must be a number`);
  return value;
}

function applyScenarioExitOptions(config: Record<string, unknown>, opts: StrategyOptions): void {
  if (opts.scenarioExit !== undefined) config.scenarioExitEnabled = onOff("scenario exit", opts.scenarioExit);
  if (opts.adverseCrossEdgePp !== undefined) config.adverseCrossEdgePp = signedNumber("adverse cross edge", opts.adverseCrossEdgePp);
  if (opts.adverseCrossMaxPnlPct !== undefined) {
    config.adverseCrossMaxPnlPct = signedNumber("adverse cross maximum P&L", opts.adverseCrossMaxPnlPct);
  }
  if (opts.adverseCrossConfirmations !== undefined) {
    config.adverseCrossConfirmations = optionalPositiveInteger("adverse cross confirmations", opts.adverseCrossConfirmations);
  }
  if (opts.qCollapsePp !== undefined) config.qCollapsePp = optionalPositiveNumber("Q collapse", opts.qCollapsePp);
  if (opts.qCollapseMaxRemainingEdgePp !== undefined) {
    config.qCollapseMaxRemainingEdgePp = signedNumber("Q collapse maximum remaining edge", opts.qCollapseMaxRemainingEdgePp);
  }
  if (opts.flipConfirmations !== undefined) config.flipConfirmations = positiveInteger("flip confirmations", opts.flipConfirmations);
  if (opts.flipExitMaxRemainingEdgePp !== undefined) {
    config.flipExitMaxRemainingEdgePp = optionalSignedNumber("flip exit maximum remaining edge", opts.flipExitMaxRemainingEdgePp);
  }
  if (opts.exitFeeBps !== undefined) config.exitFeeBps = nonnegativeNumber("exit fee", opts.exitFeeBps);
  if (opts.exitRetrySeconds !== undefined) config.exitRetrySec = positiveNumber("exit retry window", opts.exitRetrySeconds);
  if (opts.pendingEntryReservationSeconds !== undefined) {
    config.pendingEntryReservationSec = positiveNumber("pending entry reservation window", opts.pendingEntryReservationSeconds);
  }
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

function optionalPositiveInteger(label: string, raw: string): number | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "none") return null;
  return positiveInteger(label, raw);
}

function optionalSignedNumber(label: string, raw: string): number | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "none") return null;
  return signedNumber(label, raw);
}

function positionLimit(raw: string): number | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "unlimited" || normalized === "none" || normalized === "off") return null;
  return positiveInteger("position limit", raw);
}

function optionalPrice(label: string, raw: string): number | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "none") return null;
  const value = positiveNumber(label, raw);
  if (value > 1) throw new Error(`${label} must be a price between 0 and 1`);
  return value;
}

function optionalPositiveNumber(label: string, raw: string): number | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "unlimited" || normalized === "none" || normalized === "off") return null;
  return positiveNumber(label, raw);
}

function parseAllocationMode(raw: string): AllocationMode {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "portfolio-kelly" || normalized === "daily-budget" || normalized === "fixed-notional") return normalized;
  throw new Error("allocation mode must be portfolio-kelly, daily-budget or fixed-notional");
}

function configuredAllocationMode(config: Record<string, unknown>, venue?: string): AllocationMode {
  if (
    config.allocationMode === "portfolio-kelly" ||
    config.allocationMode === "daily-budget" ||
    config.allocationMode === "fixed-notional"
  ) {
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

  const requestsFixedNotional = opts.lotNotional !== undefined;

  if (requestsDailyBudget && requestsPortfolioKelly) {
    throw new Error("daily-budget and portfolio-kelly sizing options cannot be combined");
  }
  if (requestsFixedNotional && (requestsDailyBudget || requestsPortfolioKelly)) {
    throw new Error("--lot-notional cannot be combined with daily-budget or portfolio-kelly sizing options");
  }
  if (explicit === "portfolio-kelly" && requestsDailyBudget) {
    throw new Error("--allocation-mode portfolio-kelly conflicts with daily-budget sizing options");
  }
  if (explicit === "daily-budget" && requestsPortfolioKelly) {
    throw new Error("--allocation-mode daily-budget conflicts with Kelly/cap sizing options");
  }
  if (explicit !== undefined && explicit !== "fixed-notional" && requestsFixedNotional) {
    throw new Error(`--allocation-mode ${explicit} conflicts with --lot-notional`);
  }
  if (explicit === "fixed-notional" && (requestsDailyBudget || requestsPortfolioKelly)) {
    throw new Error("--allocation-mode fixed-notional conflicts with daily-budget and Kelly/cap sizing options");
  }
  if (explicit !== undefined) return explicit;
  if (requestsDailyBudget) return "daily-budget";
  if (requestsPortfolioKelly) return "portfolio-kelly";
  if (requestsFixedNotional) return "fixed-notional";
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

function cutPercentage(label: string, raw: string): number {
  const value = nonnegativeNumber(label, raw);
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
  execution?: PredictionExecutionConfig,
): void {
  const normalized = normalizeStrategyConfig(config);
  const allocationMode = configuredAllocationMode(normalized, venue);
  const defaults =
    allocationMode === "portfolio-kelly"
      ? RECOMMENDED_STRATEGY
      : allocationMode === "fixed-notional"
        ? HOLD_STRATEGY
        : LEGACY_DAILY_BUDGET_STRATEGY;
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
  } else if (allocationMode === "fixed-notional") {
    console.log(`  lot per entry:        $${Number(current.lotNotionalUsd).toFixed(2)} fixed, before liquidity/risk caps`);
    console.log("  repeat signals:       one lot per market; no top-ups");
  } else {
    const dailyBudgetUsd = Number(current.dailyBudgetUsd);
    const positionBudgetPct = Number(current.positionBudgetPct);
    const perEntryUsd = (dailyBudgetUsd * positionBudgetPct) / 100;
    console.log(`  daily entry budget:   $${dailyBudgetUsd.toFixed(2)} (resets 00:00 UTC)`);
    console.log(`  budget per entry:     ${positionBudgetPct}% = $${perEntryUsd.toFixed(2)} before liquidity/risk caps`);
  }
  const nearResolution =
    current.nearResolutionDays === null
      ? "off"
      : `${current.nearResolutionSizeCutPct}% smaller when the market resolves within ${current.nearResolutionDays} days`;
  console.log(`  near resolution:      ${nearResolution}`);
  console.log(`  minimum entry edge:   ${current.entrySpreadPp}pp`);
  console.log(
    `  maximum entry edge:   ${current.maxEntrySpreadPp === null ? "unlimited" : `${current.maxEntrySpreadPp}pp`}`,
  );
  console.log(
    `  resolution window:    ${current.maxWindowDays === null || current.maxWindowDays === undefined ? "any" : `${current.maxWindowDays} days or less at entry`}`,
  );
  console.log(`  minimum viable entry: $${Number(current.minEntryNotional).toFixed(2)} (entries only; exits are never floored)`);
  const scenario = { ...SCENARIO_EXIT_DEFAULTS, ...normalized } as Record<string, unknown>;
  const maxHold = current.maxHoldDays === null ? "unlimited" : `${current.maxHoldDays} days`;
  const takeProfit =
    current.takeProfitPrice === null
      ? "off"
      : `sell once the held-side bid reaches $${Number(current.takeProfitPrice).toFixed(2)}`;
  console.log(`  take profit:          ${takeProfit}`);
  if (scenario.scenarioExitEnabled === true) {
    console.log("  exit model:           signal state machine (scenarioExitEnabled)");
    console.log(
      scenario.adverseCrossConfirmations === null
        ? "  adverse cross:        off"
        : `  adverse cross:        edge <= ${scenario.adverseCrossEdgePp}pp and P&L <= ${scenario.adverseCrossMaxPnlPct}% on ` +
            `${scenario.adverseCrossConfirmations} distinct forecasts`,
    );
    console.log(
      scenario.qCollapsePp === null
        ? "  Q collapse:           off"
        : `  Q collapse:           retreat >= ${scenario.qCollapsePp}pp with edge <= ${scenario.qCollapseMaxRemainingEdgePp}pp, immediate`,
    );
    console.log(
      `  Q flip:               ${scenario.flipConfirmations} distinct forecasts below 50%, ` +
        (scenario.flipExitMaxRemainingEdgePp === null
          ? "exit on confirmation at any remaining edge"
          : `exit at edge <= ${scenario.flipExitMaxRemainingEdgePp}pp`),
    );
    console.log(
      current.maxHoldDays === null
        ? "  time stop:            off (hold to resolution)"
        : `  time stop:            ${maxHold} from the entry fill, regardless of P&L`,
    );
    console.log(`  exit fee assumed:     ${scenario.exitFeeBps}bps on executable proceeds`);
    console.log(`  exit retry window:    ${scenario.exitRetrySec}s before an invisible exit is re-evaluated`);
  } else {
    console.log("  exit model:           take-profit and optional time stop (scenarioExitEnabled off)");
    console.log(`  maximum hold:         ${maxHold}`);
  }
  console.log(`  entry handoff hold:   ${scenario.pendingEntryReservationSec}s reservation while a fill is not yet visible`);
  console.log(`  slippage:             ${risk.slippagePct}% from best executable price`);
  const executionConfig = PredictionExecutionConfigSchema.parse(execution ?? {});
  const executionMode = venue === "polymarket" ? executionConfig.mode : "legacy";
  console.log(`  execution:            ${executionMode} (${executionMode === "adaptive" ? "maker-first managed limits" : "crossing limits"})`);
  if (venue === "polymarket") {
    const inactive = executionMode === "legacy" ? " (inactive in legacy mode)" : "";
    console.log(`  entry deadline:       ${compactNumber(executionConfig.entryDeadlineSec)} sec maker phase${inactive}`);
    console.log(`  entry crossing:       ${executionConfig.entryCrossingSec === 0 ? "off (maker-only entries)" : `${compactNumber(executionConfig.entryCrossingSec)} sec marketable limit inside the price bound after the deadline`}${inactive}`);
    console.log(`  exit passive phase:   ${compactNumber(executionConfig.exitPassiveSec)} sec${inactive}`);
    const feeMode = polymarketFeeMode(executionMode);
    console.log(`  fee mode:             ${feeMode} (${executionMode} execution${feeMode === "maker" ? "; entries that cross after the deadline and urgent exits fill as taker" : ""})`);
    console.log(`  Quotient fee:         ${describePolymarketBuilderFee(feeMode)}`);
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
  validateEntryEdgeRange(normalized);
  const tickIntervalMin = Number(normalized.tickIntervalMin ?? cfg.tickIntervalMin);
  saveBotConfig({
    ...cfg,
    strategy: { id: "signals", config: normalized },
    tickIntervalMin,
  });
  console.log(pc.green(`saved strategy settings for ${botId}`));
  printStrategy(normalized, cfg.signals.maxAgeSec, cfg.risk, tickIntervalMin, cfg.venue, cfg.execution);
}

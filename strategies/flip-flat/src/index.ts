// strategies/flip-flat/src/index.ts
// Reference strategy (§8): buy, take profitable convergence, and enforce a
// maximum holding period. Behind `scenarioExitEnabled`, held prediction
// positions instead run the confirmed seven-day signal-exit state machine.
// Pure decisions — the engine sizes, risk-checks, and executes.

import { z } from "zod";
import {
  isSignalFresh,
  marketForecastFromSignal,
  mirrorBookForNo,
  type Action,
  type Fill,
  type MarketForecast,
  type OrderBook,
  type Position,
  type Signal,
  type Strategy,
  type StrategyActionResult,
  type StrategyContext,
} from "@quotient-forecasting/cassie-core";

const FlipFlatConfigObjectSchema = z.object({
  /** Portfolio targets are the new default; legacy configs retain their daily-budget allocator. */
  allocationMode: z.enum(["portfolio-kelly", "daily-budget"]).default("portfolio-kelly"),
  /** Fraction of full Kelly used for binary prediction-market targets. */
  kellyFraction: z.number().positive().max(1).default(0.25),
  /** Maximum capital-at-risk in one market as a percentage of current equity. */
  marketCapPct: z.number().positive().max(100).default(5),
  /** Maximum capital-at-risk across sibling markets in one event. */
  eventCapPct: z.number().positive().max(100).default(7.5),
  /** Held-outcome bid notional required within $0.02 of its best bid; 0 disables. */
  minExitDepth2cUsd: z.number().nonnegative().default(2_500),
  /** Enter when |prob − price| in percentage points is at least this. */
  entrySpreadPp: z.number().default(10),
  /**
   * Entry-only upper guardrail for |prob − price|. Very large apparent
   * edges are more likely to be stale or mismapped; null explicitly removes
   * the ceiling.
   */
  maxEntrySpreadPp: z.number().positive().nullable().default(30),
  /** Optional position-count cap; null means no artificial strategy cap. */
  topN: z.number().int().positive().nullable().default(null),
  /** Cumulative entry notional allowed per UTC day. */
  dailyBudgetUsd: z.number().positive().default(100),
  /** Desired notional for each entry as a percentage of the daily budget. */
  positionBudgetPct: z.number().positive().max(100).default(25),
  /** Entry-only floor after sizing and capacity caps. Exits are never subject to it. */
  minEntryNotional: z.number().nonnegative().default(1),
  /** Explicit marketRefs, or "from-signals" to trade whatever is signaled. */
  universe: z.union([z.literal("from-signals"), z.array(z.string())]).default("from-signals"),
  /** Reconcile positions and evaluate exits every minute by default. */
  tickIntervalMin: z.number().positive().default(1),
  /** Refresh the complete signal snapshot independently of the engine cadence. */
  signalPollIntervalMin: z.number().positive().default(5),
  /** Perps entry sanity bound: skip if mid drifted more than this % from refPrice. */
  refPriceSanityPct: z.number().positive().default(2),
  /**
   * Early convergence exit for prediction markets. This only takes profit
   * once the edge has closed; the maximum holding period remains independent.
   */
  convergenceExit: z.boolean().default(true),
  /** Remaining edge, in pp, at or below which the forecast counts as priced in. */
  convergenceExitPp: z.number().default(2),
  /** Minimum held-side gain required for an early convergence exit. */
  minConvergenceProfitPct: z.number().nonnegative().default(2),
  /** Unconditional prediction-position deadline; null disables the deadline. */
  maxHoldDays: z.number().positive().nullable().default(7),

  // ---- Seven-day signal-exit state machine (opt-in) -----------------------
  /**
   * Run the confirmed signal-exit state machine for held prediction
   * positions. When on, it supersedes the legacy convergence overlay above
   * (`convergenceExit`, `convergenceExitPp`, `minConvergenceProfitPct`); the
   * time stop reuses `maxHoldDays`. Off by default so existing bots keep
   * their current behavior until an operator turns it on explicitly.
   */
  scenarioExitEnabled: z.boolean().default(false),
  /** Positive take-profit: remaining held-side edge at or below this many pp. */
  positiveConvergenceEdgePp: z.number().default(3),
  /** Positive take-profit: executable held-side return at or above this percent. */
  positiveConvergenceMinProfitPct: z.number().default(4),
  /** Positive take-profit: held-side Q may retreat from entry by at most this many pp. */
  positiveConvergenceMaxQRetreatPp: z.number().nonnegative().default(1),
  /** Adverse cross: remaining edge at or below this many pp counts as a non-positive spread. */
  adverseCrossEdgePp: z.number().default(0),
  /** Adverse cross: executable P&L at or below this percent. */
  adverseCrossMaxPnlPct: z.number().default(0),
  /** Adverse cross: distinct committed forecasts with a non-positive spread required to exit. */
  adverseCrossConfirmations: z.number().int().positive().default(2),
  /** Q collapse: immediate exit once held-side Q has retreated by at least this many pp from entry. */
  qCollapsePp: z.number().positive().default(30),
  /** Q collapse: only when remaining edge is at or below this many pp. */
  qCollapseMaxRemainingEdgePp: z.number().default(0),
  /** Q flip: consecutive distinct committed forecasts below 50% on the held side required to confirm. */
  flipConfirmations: z.number().int().positive().default(2),
  /** Q flip: exit a confirmed flip once remaining edge is at or below this many pp. */
  flipExitMaxRemainingEdgePp: z.number().default(5),
  /** Fee rate, in basis points, deducted from executable sell proceeds in the P&L gates. */
  exitFeeBps: z.number().nonnegative().default(0),
  /**
   * Seconds a submitted exit stays pending while the venue shows neither the
   * order nor the closed position. After that a still-held position is
   * re-evaluated and may submit again.
   */
  exitRetrySec: z.number().positive().default(300),
  /**
   * Seconds an accepted entry stays reserved against market and event caps
   * while it appears in neither positions nor open orders. A resting order
   * keeps the reservation alive past this; a fill releases it as soon as the
   * venue position absorbs the size.
   */
  pendingEntryReservationSec: z.number().positive().default(900),
}).superRefine((config, ctx) => {
  if (config.maxEntrySpreadPp !== null && config.maxEntrySpreadPp < config.entrySpreadPp) {
    ctx.addIssue({
      code: "custom",
      path: ["maxEntrySpreadPp"],
      message: "maximum entry edge must be at least the minimum entry edge",
    });
  }
});

export const FlipFlatConfigSchema = z.preprocess((raw) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const config = raw as Record<string, unknown>;
  if (config.allocationMode !== undefined) return config;
  // Existing bot configs explicitly carry the old budget fields. Preserve
  // their behavior until an operator opts them into portfolio Kelly.
  if ("dailyBudgetUsd" in config || "positionBudgetPct" in config) {
    return { ...config, allocationMode: "daily-budget" };
  }
  return config;
}, FlipFlatConfigObjectSchema);
export type FlipFlatConfig = z.output<typeof FlipFlatConfigSchema>;

export const DAILY_BUDGET_MEMORY_KEY = "daily-entry-budget";
export const SCENARIO_EXIT_MEMORY_KEY = "scenario-exit-positions";
export const PENDING_ENTRIES_MEMORY_KEY = "pending-entry-reservations";
const HOLD_STARTS_MEMORY_KEY = "position-hold-starts";
const DAY_MS = 86_400_000;
const EPSILON = 1e-9;
/** Fill lookups per position before the placement time stands in for the fill time. */
const MAX_FILL_LOOKUPS = 5;

interface DailyBudgetState {
  utcDay: string;
  placedUsd: number;
}

interface HoldStartsState {
  byMarket: Record<string, number>;
}

interface PortfolioPlanningState {
  availableCashUsd: number;
  unresolvedExistingEvent: boolean;
  marketExposureUsd: Map<string, number>;
  eventExposureUsd: Map<string, number>;
  eventRefs: Map<string, string | undefined>;
}

// ---------------------------------------------------------------------------
// Durable pending-entry reservations
// ---------------------------------------------------------------------------

/**
 * An accepted entry the venue may not show yet. An immediate fill can appear
 * in neither positions nor open orders for a few ticks, so the reservation
 * keeps counting against market and event caps until the venue position
 * absorbs the size, the order rests visibly, or the handoff window expires.
 */
export interface PendingEntryReservation {
  orderId: string;
  clientId?: string;
  marketRef: string;
  side: "YES" | "NO";
  eventRef?: string;
  reservedNotionalUsd: number;
  reservedSize: number;
  /** Same-side position size seen when the entry was accepted. */
  priorMarketSize: number;
  priorMarketCostUsd: number;
  placedAt: number;
  signalId?: string;
  ackStatus?: string;
  ackFilledSize?: number;
}

interface PendingEntriesState {
  byOrderId: Record<string, PendingEntryReservation>;
}

interface ReservationSync {
  byOrderId: Record<string, PendingEntryReservation>;
  /** Reserved notional not yet visible through positions or open orders, per market. */
  contributionUsdByMarket: Map<string, number>;
  eventRefByMarket: Map<string, string>;
  markets: Set<string>;
}

// ---------------------------------------------------------------------------
// Seven-day signal-exit state machine
// ---------------------------------------------------------------------------

export type ScenarioExitReason =
  | "market_resolved"
  | "q_collapse"
  | "adverse_cross"
  | "q_flip"
  | "positive_convergence"
  | "time_stop";

export interface ScenarioEntrySnapshot {
  /** Held-side Q probability (0..1) from the published signal at entry. Immutable. */
  qHeld: number;
  signalId: string;
  signalTs: string;
  /** Held-side market reference price the signal carried. */
  refPrice?: number;
  source: "published-signal" | "seeded-from-active-signal";
  capturedAt: number;
}

export interface ScenarioExitTelemetry {
  ts: number;
  marketRef: string;
  side: "YES" | "NO";
  entryQPct?: number;
  currentQPct?: number;
  midHeld?: number;
  executableBid?: number;
  executableSize?: number;
  entryCostUsd: number;
  netProceedsUsd?: number;
  remainingEdgePp?: number;
  qRetreatPp?: number;
  executablePnlPct?: number;
  adverseCrossConfirmations: number;
  flipConfirmations: number;
  flipConfirmed: boolean;
  positionAgeDays: number;
  exitReason?: ScenarioExitReason;
  /** Distinct committed forecast versions that provided the current confirmations. */
  confirmingForecastIds: string[];
  forecastVersion?: string;
  entrySignalId?: string;
  entryFillSource?: string;
  note?: string;
}

export interface ScenarioPositionRecord {
  marketRef: string;
  side: "YES" | "NO";
  entry?: ScenarioEntrySnapshot;
  entryOrderId?: string;
  entryPlacedAt?: number;
  /** Actual entry-fill timestamp when known; position age is measured from it. */
  entryFilledAt?: number;
  entryFillSource?: "venue-fill" | "placement-ack" | "hold-start";
  fillLookupAttempts: number;
  lastForecastVersion?: string;
  lastForecastTs?: string;
  currentQHeld?: number;
  adverseCross: { count: number; versions: string[] };
  flip: { count: number; versions: string[]; confirmed: boolean };
  exit?: {
    reason: ScenarioExitReason;
    submittedAt: number;
    orderId?: string;
    status?: string;
    detail: string;
  };
  lastHeldAt: number;
  lastEvaluation?: ScenarioExitTelemetry;
}

interface ScenarioState {
  byMarket: Record<string, ScenarioPositionRecord>;
}

export interface ScenarioExitInput {
  resolved: boolean;
  /** Immutable held-side entry Q, 0..1. */
  entryQHeld?: number;
  /** Latest distinct committed held-side Q, 0..1. */
  currentQHeld?: number;
  /** Held contract live midpoint, 0..1. */
  midHeld?: number;
  /** Net executable return at the current bid, percent of actual entry cost. */
  executablePnlPct?: number;
  ageMs: number;
  adverseCrossConfirmations: number;
  flipConfirmed: boolean;
}

export interface ScenarioExitDecision {
  reason?: ScenarioExitReason;
  remainingEdgePp?: number;
  qRetreatPp?: number;
}

type ScenarioExitConfig = Pick<
  FlipFlatConfig,
  | "positiveConvergenceEdgePp"
  | "positiveConvergenceMinProfitPct"
  | "positiveConvergenceMaxQRetreatPp"
  | "adverseCrossEdgePp"
  | "adverseCrossMaxPnlPct"
  | "adverseCrossConfirmations"
  | "qCollapsePp"
  | "qCollapseMaxRemainingEdgePp"
  | "flipConfirmations"
  | "flipExitMaxRemainingEdgePp"
  | "maxHoldDays"
>;

/**
 * Exit precedence, evaluated top to bottom; exactly one reason is returned.
 * The profit requirement belongs to the positive take-profit branch alone and
 * never vetoes collapse, adverse-cross, flip, resolution, or the time stop.
 */
export function evaluateScenarioExit(input: ScenarioExitInput, cfg: ScenarioExitConfig): ScenarioExitDecision {
  const remainingEdgePp =
    input.currentQHeld !== undefined && input.midHeld !== undefined
      ? 100 * (input.currentQHeld - input.midHeld)
      : undefined;
  const qRetreatPp =
    input.entryQHeld !== undefined && input.currentQHeld !== undefined
      ? 100 * (input.entryQHeld - input.currentQHeld)
      : undefined;
  const metrics = { remainingEdgePp, qRetreatPp };
  const pnl = input.executablePnlPct;

  if (input.resolved) return { reason: "market_resolved", ...metrics };
  if (
    qRetreatPp !== undefined &&
    remainingEdgePp !== undefined &&
    qRetreatPp + EPSILON >= cfg.qCollapsePp &&
    remainingEdgePp <= cfg.qCollapseMaxRemainingEdgePp + EPSILON
  ) {
    return { reason: "q_collapse", ...metrics };
  }
  if (
    remainingEdgePp !== undefined &&
    pnl !== undefined &&
    remainingEdgePp <= cfg.adverseCrossEdgePp + EPSILON &&
    pnl <= cfg.adverseCrossMaxPnlPct + EPSILON &&
    input.adverseCrossConfirmations >= cfg.adverseCrossConfirmations
  ) {
    return { reason: "adverse_cross", ...metrics };
  }
  if (
    input.flipConfirmed &&
    remainingEdgePp !== undefined &&
    remainingEdgePp <= cfg.flipExitMaxRemainingEdgePp + EPSILON
  ) {
    return { reason: "q_flip", ...metrics };
  }
  if (
    remainingEdgePp !== undefined &&
    pnl !== undefined &&
    qRetreatPp !== undefined &&
    remainingEdgePp <= cfg.positiveConvergenceEdgePp + EPSILON &&
    pnl + EPSILON >= cfg.positiveConvergenceMinProfitPct &&
    qRetreatPp <= cfg.positiveConvergenceMaxQRetreatPp + EPSILON
  ) {
    return { reason: "positive_convergence", ...metrics };
  }
  if (cfg.maxHoldDays !== null && input.ageMs + EPSILON >= cfg.maxHoldDays * DAY_MS) {
    return { reason: "time_stop", ...metrics };
  }
  return metrics;
}

/**
 * Identity of one committed forecast. The committed timestamp distinguishes
 * versions; the id alone cannot, because a lookup row reuses the market key.
 * A forecast with no usable timestamp falls back to its probability so a
 * genuinely new value still counts once.
 */
export function forecastVersionKey(forecast: MarketForecast): string {
  const ts = Date.parse(forecast.ts);
  return Number.isFinite(ts) && ts > 0 ? `${forecast.id}@${forecast.ts}` : `${forecast.id}@q=${forecast.probYes}`;
}

/**
 * Advance the confirmation counters for one observation. Counters move only
 * on a distinct committed forecast version; re-polling the same version never
 * adds a confirmation. A new version that restores positive edge resets the
 * adverse-cross run, and one that returns Q to the held side resets the flip.
 * The same version can still earn its single adverse count later, when the
 * market rather than the forecast closes the spread.
 */
export function applyForecastObservation(
  record: Pick<ScenarioPositionRecord, "lastForecastVersion" | "lastForecastTs" | "currentQHeld" | "adverseCross" | "flip">,
  observation: { version: string; forecastTs: string; qHeld: number; remainingEdgePp?: number },
  cfg: Pick<FlipFlatConfig, "adverseCrossEdgePp" | "adverseCrossConfirmations" | "flipConfirmations">,
): { newVersion: boolean } {
  const { version, qHeld, remainingEdgePp } = observation;
  const newVersion = record.lastForecastVersion !== version;
  const adverse = remainingEdgePp !== undefined && remainingEdgePp <= cfg.adverseCrossEdgePp + EPSILON;
  if (newVersion) {
    record.lastForecastVersion = version;
    record.lastForecastTs = observation.forecastTs;
    record.currentQHeld = qHeld;
    if (qHeld < 0.5) {
      record.flip.count += 1;
      record.flip.versions.push(version);
    } else {
      record.flip = { count: 0, versions: [], confirmed: false };
    }
    if (remainingEdgePp !== undefined) {
      if (adverse) {
        record.adverseCross.count += 1;
        record.adverseCross.versions.push(version);
      } else {
        record.adverseCross = { count: 0, versions: [] };
      }
    }
  } else if (adverse && !record.adverseCross.versions.includes(version)) {
    record.adverseCross.count += 1;
    record.adverseCross.versions.push(version);
  }
  record.flip.confirmed = record.flip.count >= cfg.flipConfirmations;
  return { newVersion };
}

export interface HeldSideLiquidation {
  bestBid: number;
  executableSize: number;
  unfilledSize: number;
  grossProceedsUsd: number;
  netProceedsUsd: number;
}

/**
 * Executable sell proceeds for `size` held shares, walking the held side's
 * displayed bids (slippage) and deducting fees. Quantity beyond the displayed
 * depth is valued at the deepest displayed bid rather than at the touch.
 */
export function heldSideLiquidation(book: OrderBook, size: number, feeBps = 0): HeldSideLiquidation | undefined {
  const bids = book.bids
    .filter((level) => level.price > 0 && level.price < 1 && level.size > 0)
    .sort((left, right) => right.price - left.price);
  const bestBid = bids[0]?.price;
  if (bestBid === undefined || !(size > 0)) return undefined;
  let remaining = size;
  let gross = 0;
  let deepest = bestBid;
  for (const level of bids) {
    if (remaining <= EPSILON) break;
    const take = Math.min(remaining, level.size);
    gross += take * level.price;
    remaining -= take;
    deepest = level.price;
  }
  const executableSize = size - remaining;
  gross += remaining * deepest;
  return {
    bestBid,
    executableSize,
    unfilledSize: remaining,
    grossProceedsUsd: gross,
    netProceedsUsd: gross * (1 - feeBps / 10_000),
  };
}

function bookMid(book: OrderBook): number | undefined {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  if (bid === undefined || ask === undefined || !(bid > 0) || !(ask < 1) || bid >= ask) return undefined;
  return (bid + ask) / 2;
}

function heldSideOf(sig: Signal): "YES" | "NO" | undefined {
  return sig.side === "YES" || sig.side === "NO" ? sig.side : undefined;
}

function fmtPct(value: number | undefined, digits = 1): string {
  return value === undefined ? "n/a" : `${value.toFixed(digits)}%`;
}

function fmtPp(value: number | undefined): string {
  return value === undefined ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}pp`;
}

function fmtPx(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(3);
}

export function formatScenarioExitReason(t: ScenarioExitTelemetry, cfg: Pick<FlipFlatConfig, "adverseCrossConfirmations" | "flipConfirmations">): string {
  const pnl = t.executablePnlPct === undefined ? "n/a" : `${t.executablePnlPct >= 0 ? "+" : ""}${t.executablePnlPct.toFixed(1)}%`;
  return (
    `${t.exitReason ?? "hold"}: entryQ ${fmtPct(t.entryQPct)} → Q ${fmtPct(t.currentQPct)}, ` +
    `mid ${fmtPx(t.midHeld)}, bid ${fmtPx(t.executableBid)}, edge ${fmtPp(t.remainingEdgePp)}, ` +
    `retreat ${fmtPp(t.qRetreatPp)}, pnl ${pnl}, adverse ${t.adverseCrossConfirmations}/${cfg.adverseCrossConfirmations}, ` +
    `flip ${t.flipConfirmations}/${cfg.flipConfirmations}, age ${t.positionAgeDays.toFixed(2)}d, ` +
    `forecasts [${t.confirmingForecastIds.join(", ")}]`
  );
}

// ---------------------------------------------------------------------------
// Sizing helpers
// ---------------------------------------------------------------------------

export function portfolioKellyTargetUsd(input: {
  prob: number;
  price: number;
  equity: number;
  kellyFraction: number;
  marketCapPct: number;
}): number {
  const { prob, price, equity, kellyFraction, marketCapPct } = input;
  if (!(price > 0 && price < 1) || !(prob >= 0 && prob <= 1) || !(equity > 0)) return 0;
  const fullKelly = (prob - price) / (1 - price);
  const fractionalTarget = Math.max(0, fullKelly) * kellyFraction * equity;
  return Math.min(fractionalTarget, (marketCapPct / 100) * equity);
}

/** Executable bid notional no more than two cents below the best bid. */
export function bidDepthWithin2cUsd(book: OrderBook): number {
  const bestBid = book.bids[0]?.price;
  if (bestBid === undefined || bestBid <= 0) return 0;
  const minimumPrice = bestBid - 0.02;
  return book.bids.reduce(
    (notional, level) =>
      level.price + 1e-9 >= minimumPrice && level.price > 0 && level.size > 0
        ? notional + level.price * level.size
        : notional,
    0,
  );
}

/** Edge in percentage points, or undefined when the signal carries no probability. */
export function signalEdgePp(sig: Signal): number | undefined {
  return sig.spreadPp ?? (sig.prob !== undefined ? Math.abs(sig.prob - sig.refPrice) * 100 : undefined);
}

/** Sort key: unrankable signals (no probability) sort as 0 under a stable sort. */
function edgePpOf(sig: Signal): number {
  return signalEdgePp(sig) ?? 0;
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export class FlipFlatStrategy implements Strategy {
  readonly id = "flip-flat";

  async tick(ctx: StrategyContext): Promise<Action[]> {
    const cfg = FlipFlatConfigSchema.parse(ctx.config ?? {});
    const actions: Action[] = [];
    const signals = await ctx.signals.latest({ venue: ctx.venueId });
    const now = ctx.now();
    const holdStarts = await this.syncHoldStarts(ctx, now);
    const reservations = await this.syncPendingEntries(ctx, cfg, now);
    let remainingBudgetUsd = Number.POSITIVE_INFINITY;
    if (cfg.allocationMode === "daily-budget") {
      const budget = await this.dailyBudgetState(ctx, now);
      remainingBudgetUsd = Math.max(0, cfg.dailyBudgetUsd - budget.placedUsd);
    }
    const portfolio =
      cfg.allocationMode === "portfolio-kelly"
        ? await this.portfolioPlanningState(ctx, reservations)
        : undefined;

    // Latest signal per market, restricted to the configured universe.
    const latestByMarket = new Map<string, Signal>();
    for (const s of signals) {
      if (cfg.universe !== "from-signals" && !cfg.universe.includes(s.marketRef)) continue;
      const prev = latestByMarket.get(s.marketRef);
      if (!prev || Date.parse(s.ts) >= Date.parse(prev.ts)) latestByMarket.set(s.marketRef, s);
    }

    // Resolution first: redeem where the venue requires it (Polymarket).
    const entryBlockedMarkets = new Set<string>();
    for (const pos of ctx.positions) {
      if (pos.redeemable) {
        actions.push({ kind: "redeem", marketRef: pos.marketRef, reason: "market resolved" });
        entryBlockedMarkets.add(pos.marketRef);
      }
    }

    // Resting orders and unabsorbed entries occupy a slot too; otherwise a
    // slow fill could let later ticks place more entry orders than the
    // configured position limit.
    const openOrderMarkets = new Set(ctx.openOrders.map((order) => order.marketRef));
    const occupiedMarkets = new Set([
      ...ctx.positions.filter((position) => position.size > 0).map((position) => position.marketRef),
      ...openOrderMarkets,
      ...reservations.markets,
    ]);
    let openCount = occupiedMarkets.size;

    // Exits are position-driven, never entry-signal-driven. An existing order
    // suppresses another exit for the same market.
    const heldPositions = ctx.positions.filter(
      (position) =>
        position.size > 0 &&
        !position.redeemable &&
        (position.side === "YES" || position.side === "NO"),
    );
    if (cfg.scenarioExitEnabled) {
      const scenario = await this.scenarioExits(
        ctx,
        cfg,
        heldPositions,
        signals,
        holdStarts,
        reservations,
        openOrderMarkets,
        entryBlockedMarkets,
        now,
      );
      actions.push(...scenario.actions);
      for (const marketRef of scenario.blockedMarkets) entryBlockedMarkets.add(marketRef);
    } else {
      actions.push(
        ...(await this.legacyExits(ctx, cfg, heldPositions, signals, holdStarts, openOrderMarkets, entryBlockedMarkets, now)),
      );
    }

    // Widest edge first. An optional topN cap and the daily budget can bind
    // partway down this list, so iteration order decides which markets get the
    // capital. Signals with no computable edge (perps) sort as 0 and the sort
    // is stable, so their relative order is unchanged.
    const ranked = [...latestByMarket.entries()].sort((a, b) => edgePpOf(b[1]) - edgePpOf(a[1]));

    for (const [marketRef, sig] of ranked) {
      if (entryBlockedMarkets.has(marketRef)) continue;
      if (reservations.markets.has(marketRef)) {
        ctx.log.info(`entry handoff pending for ${marketRef}; no new entry until the venue shows it`);
        continue;
      }
      if (!isSignalFresh(sig, now)) {
        ctx.log.info(`stale signal for ${marketRef} (ts=${sig.ts}, ttl=${sig.ttlSec}s); no entry`);
        continue;
      }

      const held = ctx.positions.filter((position) => position.marketRef === marketRef && position.size > 0);
      const isTopUp = held.length > 0;

      // The legacy allocator never added to an existing position. Portfolio
      // mode may top up only when every existing lot is on the signaled side.
      if (isTopUp && cfg.allocationMode === "daily-budget") continue;
      if (isTopUp && held.some((position) => position.side !== sig.side)) continue;

      // One active order per market: its unfilled commitment is already
      // reserved below, and another order would race that reservation.
      if (ctx.openOrders.some((o) => o.marketRef === marketRef)) continue;
      const spreadPp = signalEdgePp(sig);
      if (!isTopUp && cfg.topN !== null && openCount >= cfg.topN) {
        // Say what was passed over, and at what edge — a silent cap reads as
        // "nothing else qualified" when the truth is "we ran out of slots".
        ctx.log.info(
          `top ${cfg.topN} positions already filled; skipping ${marketRef}` +
            (spreadPp !== undefined ? ` (edge ${spreadPp.toFixed(1)}pp)` : ""),
        );
        continue;
      }

      if (cfg.allocationMode === "daily-budget") {
        if (!(await this.entryOk(ctx, cfg, sig, spreadPp))) continue;
        const notional = await this.dailyEntryNotional(ctx, cfg, sig, remainingBudgetUsd);
        if (notional <= 0) {
          ctx.log.info(`no sizeable edge or budget for ${marketRef}; skipping`);
          continue;
        }
        actions.push({
          kind: "enter",
          marketRef,
          side: sig.side,
          notional,
          minNotional: cfg.minEntryNotional,
          reason: `signal ${sig.id}${spreadPp !== undefined ? ` spread ${spreadPp.toFixed(1)}pp` : ""}`,
          provenance: {
            allocationMode: "daily-budget",
            signalId: sig.id,
            signalTs: sig.ts,
            side: sig.side,
            ...(sig.prob !== undefined ? { qHeld: sig.prob } : {}),
            signalRefPrice: sig.refPrice,
            ...(spreadPp !== undefined ? { signalEdgePp: spreadPp } : {}),
            requestedNotionalUsd: notional,
            remainingDailyBudgetUsd: remainingBudgetUsd,
          },
        });
        remainingBudgetUsd -= notional;
        openCount += 1;
        continue;
      }

      if (!portfolio) continue;
      const sized = await this.portfolioEntry(ctx, cfg, portfolio, sig);
      if (!sized) continue;
      actions.push({
        kind: "enter",
        marketRef,
        side: sig.side,
        notional: sized.notional,
        minNotional: cfg.minEntryNotional,
        reason: `${isTopUp ? "top-up" : "signal"} ${sig.id} live edge ${sized.liveEdgePp.toFixed(1)}pp`,
        provenance: sized.provenance,
      });
      portfolio.availableCashUsd -= sized.notional;
      portfolio.marketExposureUsd.set(
        marketRef,
        (portfolio.marketExposureUsd.get(marketRef) ?? 0) + sized.notional,
      );
      portfolio.eventExposureUsd.set(
        sized.eventRef,
        (portfolio.eventExposureUsd.get(sized.eventRef) ?? 0) + sized.notional,
      );
      if (!isTopUp) openCount += 1;
    }

    return actions;
  }

  async onActionResult(ctx: StrategyContext, action: Action, result: StrategyActionResult): Promise<void> {
    if (action.kind === "exit") {
      await this.recordExitResult(ctx, action.marketRef, result);
      return;
    }
    if (action.kind !== "enter" || !result.placed) return;
    const cfg = FlipFlatConfigSchema.parse(ctx.config ?? {});
    const now = ctx.now();
    if (cfg.allocationMode === "daily-budget" && result.placedNotional && result.placedNotional > 0) {
      const current = await this.dailyBudgetState(ctx, now);
      await ctx.memory.set<DailyBudgetState>(DAILY_BUDGET_MEMORY_KEY, {
        utcDay: current.utcDay,
        placedUsd: current.placedUsd + result.placedNotional,
      });
    }
    if (action.side === "YES" || action.side === "NO") {
      await this.rememberHoldStart(ctx, action.marketRef, now);
      await this.reservePendingEntry(ctx, action, action.side, result, now);
      await this.recordEntrySnapshot(ctx, action, action.side, result, now);
    }
  }

  private async dailyBudgetState(ctx: StrategyContext, now: number): Promise<DailyBudgetState> {
    const utcDay = new Date(now).toISOString().slice(0, 10);
    const saved = await ctx.memory.get<DailyBudgetState>(DAILY_BUDGET_MEMORY_KEY);
    return saved?.utcDay === utcDay ? saved : { utcDay, placedUsd: 0 };
  }

  // -------------------------------------------------------------------------
  // Legacy exits (convergence overlay + maximum hold)
  // -------------------------------------------------------------------------

  private async legacyExits(
    ctx: StrategyContext,
    cfg: FlipFlatConfig,
    heldPositions: Position[],
    signals: Signal[],
    holdStarts: HoldStartsState,
    openOrderMarkets: Set<string>,
    entryBlockedMarkets: Set<string>,
    now: number,
  ): Promise<Action[]> {
    const actions: Action[] = [];
    // The maximum hold is checked first and needs no forecast. Before that
    // deadline, convergence may take profit but never realizes a
    // sub-threshold gain.
    const convergenceCandidates: Position[] = [];
    for (const held of heldPositions) {
      if (openOrderMarkets.has(held.marketRef) || entryBlockedMarkets.has(held.marketRef)) continue;
      const heldSince = holdStarts.byMarket[held.marketRef] ?? now;
      const heldMs = Math.max(0, now - heldSince);
      if (cfg.maxHoldDays !== null && heldMs >= cfg.maxHoldDays * DAY_MS) {
        actions.push({
          kind: "exit",
          marketRef: held.marketRef,
          reason: `max hold reached: ${(heldMs / DAY_MS).toFixed(2)}d held (limit ${cfg.maxHoldDays}d)`,
          provenance: { exitModel: "legacy", heldSince, heldDays: heldMs / DAY_MS, maxHoldDays: cfg.maxHoldDays },
        });
        entryBlockedMarkets.add(held.marketRef);
        continue;
      }
      if (cfg.convergenceExit) convergenceCandidates.push(held);
    }
    if (convergenceCandidates.length === 0) return actions;

    const heldRefs = new Set(convergenceCandidates.map((position) => position.marketRef));
    const forecastByMarket = await this.heldForecasts(ctx, signals, heldRefs);
    for (const held of convergenceCandidates) {
      if (entryBlockedMarkets.has(held.marketRef)) continue;
      const forecast = forecastByMarket.get(held.marketRef);
      if (!forecast) {
        ctx.log.info(`no Q forecast for held market ${held.marketRef}; convergence not evaluated`);
        continue;
      }
      const conv = await this.convergenceCheck(ctx, cfg, forecast, held);
      if (conv) {
        actions.push({
          kind: "exit",
          marketRef: held.marketRef,
          reason: conv,
          provenance: { exitModel: "legacy", forecastId: forecast.id, forecastTs: forecast.ts, probYes: forecast.probYes },
        });
        // The position still consumes exposure until the exit actually
        // fills. Never spend that headroom speculatively in the same tick.
        entryBlockedMarkets.add(held.marketRef);
      }
    }
    return actions;
  }

  /**
   * Latest Q forecasts for held markets. Queried forecasts are independent of
   * signal publication; the published feed is the fallback, and whichever
   * carries the newer committed timestamp is the current forecast.
   */
  private async heldForecasts(
    ctx: StrategyContext,
    signals: Signal[],
    heldRefs: Set<string>,
  ): Promise<Map<string, MarketForecast>> {
    const fallbackForecasts = signals
      .map(marketForecastFromSignal)
      .filter(
        (forecast): forecast is MarketForecast =>
          forecast !== null && heldRefs.has(forecast.marketRef),
      );
    let queried: MarketForecast[] = [];
    const fetchForecasts = ctx.signals.forecasts?.bind(ctx.signals);
    if (fetchForecasts && heldRefs.size > 0) {
      try {
        queried = await fetchForecasts({ venue: ctx.venueId, marketRefs: [...heldRefs] });
      } catch (err) {
        ctx.log.warn(`held forecast refresh failed: ${(err as Error).message}`);
      }
    }
    const committedAt = (forecast: MarketForecast): number => {
      const ts = Date.parse(forecast.ts);
      return Number.isFinite(ts) ? ts : 0;
    };
    const byMarket = new Map<string, MarketForecast>();
    for (const forecast of [...queried, ...fallbackForecasts]) {
      const current = byMarket.get(forecast.marketRef);
      if (!current || committedAt(forecast) > committedAt(current)) byMarket.set(forecast.marketRef, forecast);
    }
    return byMarket;
  }

  // -------------------------------------------------------------------------
  // Seven-day signal-exit state machine
  // -------------------------------------------------------------------------

  private async scenarioExits(
    ctx: StrategyContext,
    cfg: FlipFlatConfig,
    heldPositions: Position[],
    signals: Signal[],
    holdStarts: HoldStartsState,
    reservations: ReservationSync,
    openOrderMarkets: Set<string>,
    entryBlockedMarkets: Set<string>,
    now: number,
  ): Promise<{ actions: Action[]; blockedMarkets: Set<string> }> {
    const state = await this.scenarioState(ctx);
    const before = JSON.stringify(state);
    const actions: Action[] = [];
    const blockedMarkets = new Set<string>();

    for (const held of heldPositions) this.ensureScenarioRecord(ctx, state, held, signals, holdStarts, now);
    await this.resolveEntryFillTimestamps(ctx, state, heldPositions, now);
    this.pruneScenarioRecords(ctx, cfg, state, heldPositions, openOrderMarkets, reservations, now);

    const heldRefs = new Set(heldPositions.map((position) => position.marketRef));
    const forecastByMarket = await this.heldForecasts(ctx, signals, heldRefs);

    for (const held of heldPositions) {
      const marketRef = held.marketRef;
      const record = state.byMarket[marketRef];
      if (!record) continue;
      if (entryBlockedMarkets.has(marketRef)) {
        blockedMarkets.add(marketRef);
        continue;
      }
      // Idempotent submission: one exit per position until the venue shows
      // the order or the position is gone. A vanished order with the position
      // still held is re-evaluated only after the retry window.
      if (record.exit) {
        const visible = ctx.openOrders.some(
          (order) =>
            (record.exit?.orderId !== undefined && order.id === record.exit.orderId) ||
            (order.marketRef === marketRef && order.side === "SELL"),
        );
        const ageMs = now - record.exit.submittedAt;
        if (visible || ageMs < cfg.exitRetrySec * 1_000) {
          blockedMarkets.add(marketRef);
          continue;
        }
        ctx.log.warn(
          `${record.exit.reason} exit for ${marketRef} submitted ${(ageMs / 1_000).toFixed(0)}s ago is no longer visible ` +
            "while the position remains; re-evaluating",
        );
        record.exit = undefined;
      }
      if (openOrderMarkets.has(marketRef)) {
        blockedMarkets.add(marketRef);
        continue;
      }
      const telemetry = await this.evaluateHeldPosition(
        ctx,
        cfg,
        record,
        held,
        forecastByMarket.get(marketRef),
        holdStarts,
        now,
      );
      if (!telemetry.exitReason) continue;
      const detail = formatScenarioExitReason(telemetry, cfg);
      actions.push({
        kind: "exit",
        marketRef,
        reason: detail,
        provenance: { exitModel: "scenario", ...telemetry },
      });
      record.exit = { reason: telemetry.exitReason, submittedAt: now, detail };
      blockedMarkets.add(marketRef);
    }

    if (JSON.stringify(state) !== before) await ctx.memory.set<ScenarioState>(SCENARIO_EXIT_MEMORY_KEY, state);
    return { actions, blockedMarkets };
  }

  private async scenarioState(ctx: StrategyContext): Promise<ScenarioState> {
    const saved = await ctx.memory.get<ScenarioState>(SCENARIO_EXIT_MEMORY_KEY);
    const byMarket: Record<string, ScenarioPositionRecord> = {};
    if (!saved?.byMarket || typeof saved.byMarket !== "object") return { byMarket };
    for (const [marketRef, record] of Object.entries(saved.byMarket)) {
      if (!record || typeof record !== "object") continue;
      if (record.side !== "YES" && record.side !== "NO") continue;
      byMarket[marketRef] = {
        ...record,
        marketRef,
        fillLookupAttempts: Number.isFinite(record.fillLookupAttempts) ? record.fillLookupAttempts : 0,
        adverseCross: {
          count: Number.isFinite(record.adverseCross?.count) ? record.adverseCross.count : 0,
          versions: Array.isArray(record.adverseCross?.versions) ? record.adverseCross.versions : [],
        },
        flip: {
          count: Number.isFinite(record.flip?.count) ? record.flip.count : 0,
          versions: Array.isArray(record.flip?.versions) ? record.flip.versions : [],
          confirmed: record.flip?.confirmed === true,
        },
        lastHeldAt: Number.isFinite(record.lastHeldAt) ? record.lastHeldAt : 0,
      };
    }
    return { byMarket };
  }

  /**
   * Seed a record for a position that predates its entry snapshot. Entry Q
   * comes from the active published signal on the held side when one exists;
   * without it, the collapse and take-profit branches stay off for that
   * position while the adverse-cross, flip, and time stop still apply.
   */
  private ensureScenarioRecord(
    ctx: StrategyContext,
    state: ScenarioState,
    held: Position,
    signals: Signal[],
    holdStarts: HoldStartsState,
    now: number,
  ): ScenarioPositionRecord {
    const side = held.side as "YES" | "NO";
    let record = state.byMarket[held.marketRef];
    if (record && record.side !== side) {
      ctx.log.info(`held side for ${held.marketRef} changed ${record.side} → ${side}; starting a fresh exit record`);
      record = undefined;
    }
    if (!record) {
      const sameSide = signals
        .filter((sig) => sig.marketRef === held.marketRef && heldSideOf(sig) === side && sig.prob !== undefined)
        .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
      const seed = sameSide[0];
      record = {
        marketRef: held.marketRef,
        side,
        ...(seed && seed.prob !== undefined
          ? {
              entry: {
                qHeld: seed.prob,
                signalId: seed.id,
                signalTs: seed.ts,
                refPrice: seed.refPrice,
                source: "seeded-from-active-signal",
                capturedAt: now,
              },
            }
          : {}),
        entryFilledAt: holdStarts.byMarket[held.marketRef] ?? now,
        entryFillSource: "hold-start",
        fillLookupAttempts: MAX_FILL_LOOKUPS,
        adverseCross: { count: 0, versions: [] },
        flip: { count: 0, versions: [], confirmed: false },
        lastHeldAt: now,
      };
      state.byMarket[held.marketRef] = record;
      ctx.log.info(
        `seeded exit record for held ${side} ${held.marketRef}: entry Q ` +
          (record.entry ? `${(record.entry.qHeld * 100).toFixed(1)}% from active signal ${record.entry.signalId}` : "unknown (no active same-side signal)") +
          `; age measured from ${new Date(record.entryFilledAt ?? now).toISOString()}`,
      );
    }
    record.lastHeldAt = now;
    return record;
  }

  /** Resolve actual entry-fill timestamps from venue fills for records that still lack one. */
  private async resolveEntryFillTimestamps(
    ctx: StrategyContext,
    state: ScenarioState,
    heldPositions: Position[],
    now: number,
  ): Promise<void> {
    const pending = heldPositions
      .map((held) => ({ held, record: state.byMarket[held.marketRef] }))
      .filter(
        (row): row is { held: Position; record: ScenarioPositionRecord & { entryPlacedAt: number } } =>
          row.record !== undefined &&
          row.record.entryFilledAt === undefined &&
          row.record.entryPlacedAt !== undefined &&
          row.record.fillLookupAttempts < MAX_FILL_LOOKUPS,
      );
    if (pending.length === 0) return;
    const since = Math.max(0, Math.min(...pending.map((row) => row.record.entryPlacedAt)) - 60_000);
    let fills: Fill[];
    try {
      fills = await ctx.venue.fills(since);
    } catch (err) {
      ctx.log.warn(`entry fill lookup failed: ${(err as Error).message}`);
      for (const { record } of pending) this.noteFillLookupMiss(ctx, record, now);
      return;
    }
    for (const { held, record } of pending) {
      const candidates = fills.filter(
        (fill) =>
          fill.side === "BUY" &&
          fill.marketRef === held.marketRef &&
          (fill.outcome === undefined || fill.outcome === record.side) &&
          fill.ts >= record.entryPlacedAt - 60_000,
      );
      const exact = record.entryOrderId
        ? candidates.filter((fill) => fill.orderId === record.entryOrderId || fill.makerOrderId === record.entryOrderId)
        : [];
      const matched = exact.length > 0 ? exact : candidates;
      const first = matched.reduce<Fill | undefined>((best, fill) => (!best || fill.ts < best.ts ? fill : best), undefined);
      if (first) {
        record.entryFilledAt = first.ts;
        record.entryFillSource = "venue-fill";
        ctx.log.info(`entry fill for ${held.marketRef} found at ${new Date(first.ts).toISOString()} (${exact.length > 0 ? "order id match" : "market match"})`);
      } else {
        this.noteFillLookupMiss(ctx, record, now);
      }
    }
  }

  private noteFillLookupMiss(ctx: StrategyContext, record: ScenarioPositionRecord, now: number): void {
    record.fillLookupAttempts += 1;
    if (record.fillLookupAttempts < MAX_FILL_LOOKUPS || record.entryFilledAt !== undefined) return;
    record.entryFilledAt = record.entryPlacedAt ?? now;
    record.entryFillSource = "hold-start";
    ctx.log.warn(
      `no venue fill found for the ${record.marketRef} entry after ${MAX_FILL_LOOKUPS} lookups; ` +
        `measuring age from placement at ${new Date(record.entryFilledAt).toISOString()}`,
    );
  }

  /** Drop records once neither a position, an order, nor a pending entry remains and the handoff window has passed. */
  private pruneScenarioRecords(
    ctx: StrategyContext,
    cfg: FlipFlatConfig,
    state: ScenarioState,
    heldPositions: Position[],
    openOrderMarkets: Set<string>,
    reservations: ReservationSync,
    now: number,
  ): void {
    const heldRefs = new Set(heldPositions.map((position) => position.marketRef));
    for (const [marketRef, record] of Object.entries(state.byMarket)) {
      if (heldRefs.has(marketRef) || openOrderMarkets.has(marketRef) || reservations.markets.has(marketRef)) continue;
      const anchor = Math.max(record.lastHeldAt, record.entryPlacedAt ?? 0, record.exit?.submittedAt ?? 0);
      if (now - anchor < cfg.pendingEntryReservationSec * 1_000) continue;
      delete state.byMarket[marketRef];
      ctx.log.info(`cleared exit record for ${marketRef}${record.exit ? ` after ${record.exit.reason} exit` : ""}`);
    }
  }

  private async evaluateHeldPosition(
    ctx: StrategyContext,
    cfg: FlipFlatConfig,
    record: ScenarioPositionRecord,
    held: Position,
    forecast: MarketForecast | undefined,
    holdStarts: HoldStartsState,
    now: number,
  ): Promise<ScenarioExitTelemetry> {
    const side = record.side;
    let heldBook: OrderBook | undefined;
    try {
      const yesBook = await ctx.venue.book(held.marketRef);
      heldBook = side === "NO" ? mirrorBookForNo(yesBook) : yesBook;
    } catch (err) {
      ctx.log.warn(`held book unavailable for ${held.marketRef}: ${(err as Error).message}`);
    }
    let midHeld = heldBook ? bookMid(heldBook) : undefined;
    if (midHeld === undefined) {
      try {
        const quote = await ctx.venue.quote(held.marketRef);
        const mirrored = side === "NO" ? 1 - quote.mid : quote.mid;
        midHeld = mirrored > 0 && mirrored < 1 ? mirrored : undefined;
      } catch (err) {
        ctx.log.warn(`held quote unavailable for ${held.marketRef}: ${(err as Error).message}`);
      }
    }
    const liquidation = heldBook ? heldSideLiquidation(heldBook, held.size, cfg.exitFeeBps) : undefined;
    const entryCostUsd = held.size * held.avgPrice;
    const executablePnlPct =
      liquidation && entryCostUsd > 0 ? 100 * (liquidation.netProceedsUsd / entryCostUsd - 1) : undefined;
    const currentQHeld =
      forecast === undefined ? record.currentQHeld : side === "NO" ? 1 - forecast.probYes : forecast.probYes;
    const remainingEdgePp =
      currentQHeld !== undefined && midHeld !== undefined ? 100 * (currentQHeld - midHeld) : undefined;
    let forecastVersion = record.lastForecastVersion;
    if (forecast && currentQHeld !== undefined) {
      forecastVersion = forecastVersionKey(forecast);
      const observed = applyForecastObservation(
        record,
        { version: forecastVersion, forecastTs: forecast.ts, qHeld: currentQHeld, remainingEdgePp },
        cfg,
      );
      if (observed.newVersion) {
        ctx.log.info(`new committed forecast for ${held.marketRef}: ${forecastVersion} (held-side Q ${(currentQHeld * 100).toFixed(1)}%)`, {
          adverseCrossConfirmations: record.adverseCross.count,
          flipConfirmations: record.flip.count,
        });
      }
    } else if (!forecast && record.lastForecastVersion) {
      ctx.log.info(`no fresh Q forecast for held market ${held.marketRef}; evaluating on the last committed forecast ${record.lastForecastVersion}`);
    } else if (!forecast) {
      ctx.log.info(`no Q forecast for held market ${held.marketRef}; only the time stop can fire`);
    }
    const entryFilledAt = record.entryFilledAt ?? holdStarts.byMarket[held.marketRef] ?? record.entryPlacedAt ?? now;
    const ageMs = Math.max(0, now - entryFilledAt);
    const decision = evaluateScenarioExit(
      {
        resolved: false,
        entryQHeld: record.entry?.qHeld,
        currentQHeld,
        midHeld,
        executablePnlPct,
        ageMs,
        adverseCrossConfirmations: record.adverseCross.count,
        flipConfirmed: record.flip.confirmed,
      },
      cfg,
    );
    const confirming = decision.reason === "adverse_cross"
      ? record.adverseCross.versions
      : decision.reason === "q_flip"
        ? record.flip.versions
        : [...new Set([...record.adverseCross.versions, ...record.flip.versions])];
    const telemetry: ScenarioExitTelemetry = {
      ts: now,
      marketRef: held.marketRef,
      side,
      ...(record.entry ? { entryQPct: 100 * record.entry.qHeld, entrySignalId: record.entry.signalId } : {}),
      ...(currentQHeld !== undefined ? { currentQPct: 100 * currentQHeld } : {}),
      ...(midHeld !== undefined ? { midHeld } : {}),
      ...(liquidation
        ? {
            executableBid: liquidation.bestBid,
            executableSize: liquidation.executableSize,
            netProceedsUsd: liquidation.netProceedsUsd,
          }
        : {}),
      entryCostUsd,
      ...(decision.remainingEdgePp !== undefined ? { remainingEdgePp: decision.remainingEdgePp } : {}),
      ...(decision.qRetreatPp !== undefined ? { qRetreatPp: decision.qRetreatPp } : {}),
      ...(executablePnlPct !== undefined ? { executablePnlPct } : {}),
      adverseCrossConfirmations: record.adverseCross.count,
      flipConfirmations: record.flip.count,
      flipConfirmed: record.flip.confirmed,
      positionAgeDays: ageMs / DAY_MS,
      ...(decision.reason ? { exitReason: decision.reason } : {}),
      confirmingForecastIds: confirming,
      ...(forecastVersion ? { forecastVersion } : {}),
      ...(record.entryFillSource ? { entryFillSource: record.entryFillSource } : {}),
      ...(record.entry ? {} : { note: "entry Q unknown: collapse and take-profit branches inactive" }),
    };
    record.lastEvaluation = telemetry;
    if (decision.reason) {
      ctx.log.info(`scenario exit triggered: ${formatScenarioExitReason(telemetry, cfg)}`, telemetry);
    } else {
      ctx.log.debug(`scenario exit evaluated: ${formatScenarioExitReason(telemetry, cfg)}`, telemetry);
    }
    return telemetry;
  }

  private async recordEntrySnapshot(
    ctx: StrategyContext,
    action: Extract<Action, { kind: "enter" }>,
    side: "YES" | "NO",
    result: StrategyActionResult,
    now: number,
  ): Promise<void> {
    const state = await this.scenarioState(ctx);
    const existing = state.byMarket[action.marketRef];
    const stillHeld = ctx.positions.some(
      (position) => position.marketRef === action.marketRef && position.side === side && position.size > 0,
    );
    if (existing && existing.side === side && stillHeld && !existing.exit) {
      // A top-up never rewrites the immutable entry snapshot or the age anchor.
      existing.lastHeldAt = now;
      await ctx.memory.set<ScenarioState>(SCENARIO_EXIT_MEMORY_KEY, state);
      return;
    }
    const provenance = action.provenance ?? {};
    const qHeld = typeof provenance.qHeld === "number" ? provenance.qHeld : undefined;
    const signalId = typeof provenance.signalId === "string" ? provenance.signalId : undefined;
    const signalTs = typeof provenance.signalTs === "string" ? provenance.signalTs : undefined;
    const filledOnAck = result.status === "filled" || result.status === "partial" || (result.filledSize ?? 0) > 0;
    const placedAt = result.placedAt ?? now;
    state.byMarket[action.marketRef] = {
      marketRef: action.marketRef,
      side,
      ...(qHeld !== undefined && signalId !== undefined && signalTs !== undefined
        ? {
            entry: {
              qHeld,
              signalId,
              signalTs,
              ...(typeof provenance.signalRefPrice === "number" ? { refPrice: provenance.signalRefPrice } : {}),
              source: "published-signal",
              capturedAt: now,
            },
          }
        : {}),
      ...(result.orderId ? { entryOrderId: result.orderId } : {}),
      entryPlacedAt: placedAt,
      ...(filledOnAck ? { entryFilledAt: placedAt, entryFillSource: "placement-ack" } : {}),
      fillLookupAttempts: 0,
      adverseCross: { count: 0, versions: [] },
      flip: { count: 0, versions: [], confirmed: false },
      lastHeldAt: now,
    };
    await ctx.memory.set<ScenarioState>(SCENARIO_EXIT_MEMORY_KEY, state);
  }

  private async recordExitResult(ctx: StrategyContext, marketRef: string, result: StrategyActionResult): Promise<void> {
    const state = await this.scenarioState(ctx);
    const record = state.byMarket[marketRef];
    if (!record?.exit) return;
    if (result.placed) {
      record.exit = {
        ...record.exit,
        submittedAt: result.placedAt ?? record.exit.submittedAt,
        ...(result.orderId ? { orderId: result.orderId } : {}),
        ...(result.status ? { status: result.status } : {}),
      };
    } else {
      // The engine skipped it (capacity, no position); evaluate again next tick.
      record.exit = undefined;
    }
    await ctx.memory.set<ScenarioState>(SCENARIO_EXIT_MEMORY_KEY, state);
  }

  // -------------------------------------------------------------------------
  // Pending-entry reservations
  // -------------------------------------------------------------------------

  private async pendingEntriesState(ctx: StrategyContext): Promise<PendingEntriesState> {
    const saved = await ctx.memory.get<PendingEntriesState>(PENDING_ENTRIES_MEMORY_KEY);
    const byOrderId: Record<string, PendingEntryReservation> = {};
    if (!saved?.byOrderId || typeof saved.byOrderId !== "object") return { byOrderId };
    for (const [orderId, reservation] of Object.entries(saved.byOrderId)) {
      if (!reservation || typeof reservation !== "object") continue;
      if (reservation.side !== "YES" && reservation.side !== "NO") continue;
      if (!Number.isFinite(reservation.reservedNotionalUsd) || !Number.isFinite(reservation.placedAt)) continue;
      byOrderId[orderId] = reservation;
    }
    return { byOrderId };
  }

  private async reservePendingEntry(
    ctx: StrategyContext,
    action: Extract<Action, { kind: "enter" }>,
    side: "YES" | "NO",
    result: StrategyActionResult,
    now: number,
  ): Promise<void> {
    const placedAt = result.placedAt ?? now;
    const orderId = result.orderId ?? result.clientId ?? `${action.marketRef}:${placedAt}`;
    const reservedNotionalUsd = result.placedNotional ?? (result.placedSize !== undefined && result.limitPrice !== undefined ? result.placedSize * result.limitPrice : action.notional);
    const reservedSize =
      result.placedSize ??
      (result.limitPrice !== undefined && result.limitPrice > 0 ? reservedNotionalUsd / result.limitPrice : 0);
    const prior = ctx.positions.filter(
      (position) => position.marketRef === action.marketRef && position.side === side && position.size > 0,
    );
    const provenance = action.provenance ?? {};
    const state = await this.pendingEntriesState(ctx);
    state.byOrderId[orderId] = {
      orderId,
      ...(result.clientId ? { clientId: result.clientId } : {}),
      marketRef: action.marketRef,
      side,
      ...(typeof provenance.eventRef === "string" ? { eventRef: provenance.eventRef } : {}),
      reservedNotionalUsd,
      reservedSize,
      priorMarketSize: prior.reduce((sum, position) => sum + position.size, 0),
      priorMarketCostUsd: prior.reduce((sum, position) => sum + position.size * position.avgPrice, 0),
      placedAt,
      ...(typeof provenance.signalId === "string" ? { signalId: provenance.signalId } : {}),
      ...(result.status ? { ackStatus: result.status } : {}),
      ...(result.filledSize !== undefined ? { ackFilledSize: result.filledSize } : {}),
    };
    await ctx.memory.set<PendingEntriesState>(PENDING_ENTRIES_MEMORY_KEY, state);
    ctx.log.info(
      `reserved pending entry ${orderId} for ${side} ${action.marketRef}: $${reservedNotionalUsd.toFixed(2)} ` +
        `(${reservedSize.toFixed(2)} shares) until the venue position or open order absorbs it`,
    );
  }

  /**
   * Reconcile reservations against what the venue shows now. A reservation
   * contributes only the part of its notional that is visible in neither the
   * same-side position growth nor a resting order, so nothing is counted
   * twice once the venue catches up.
   */
  private async syncPendingEntries(ctx: StrategyContext, cfg: FlipFlatConfig, now: number): Promise<ReservationSync> {
    const state = await this.pendingEntriesState(ctx);
    const next: Record<string, PendingEntryReservation> = {};
    const contributionUsdByMarket = new Map<string, number>();
    const eventRefByMarket = new Map<string, string>();
    const markets = new Set<string>();
    let changed = false;

    for (const [orderId, reservation] of Object.entries(state.byOrderId)) {
      const sizeNow = ctx.positions
        .filter((position) => position.marketRef === reservation.marketRef && position.side === reservation.side && position.size > 0)
        .reduce((sum, position) => sum + position.size, 0);
      const absorbedSize = Math.max(0, sizeNow - reservation.priorMarketSize);
      const absorbedFraction = reservation.reservedSize > 0 ? Math.min(1, absorbedSize / reservation.reservedSize) : 1;
      const open = ctx.openOrders.find(
        (order) => order.id === orderId || (reservation.clientId !== undefined && order.clientId === reservation.clientId),
      );
      if (absorbedFraction >= 1 - 1e-6) {
        ctx.log.info(`pending entry ${orderId} for ${reservation.marketRef} absorbed by the venue position; reservation released`);
        changed = true;
        continue;
      }
      const ageMs = now - reservation.placedAt;
      if (!open && ageMs >= cfg.pendingEntryReservationSec * 1_000) {
        ctx.log.warn(
          `pending entry ${orderId} for ${reservation.marketRef} released after ${(ageMs / 1_000).toFixed(0)}s: ` +
            `$${reservation.reservedNotionalUsd.toFixed(2)} appeared in neither positions nor open orders; treating it as canceled or rejected`,
        );
        changed = true;
        continue;
      }
      const openRemainingUsd = open ? Math.max(0, open.size - open.filledSize) * open.price : 0;
      const contributionUsd = Math.max(0, reservation.reservedNotionalUsd * (1 - absorbedFraction) - openRemainingUsd);
      next[orderId] = reservation;
      markets.add(reservation.marketRef);
      if (reservation.eventRef) eventRefByMarket.set(reservation.marketRef, reservation.eventRef);
      contributionUsdByMarket.set(
        reservation.marketRef,
        (contributionUsdByMarket.get(reservation.marketRef) ?? 0) + contributionUsd,
      );
    }
    if (changed) await ctx.memory.set<PendingEntriesState>(PENDING_ENTRIES_MEMORY_KEY, { byOrderId: next });
    return { byOrderId: next, contributionUsdByMarket, eventRefByMarket, markets };
  }

  // -------------------------------------------------------------------------
  // Hold-start bookkeeping (legacy age anchor; also the fallback for the state machine)
  // -------------------------------------------------------------------------

  /**
   * Seed legacy positions at first sight and prune timestamps once neither a
   * position nor an order remains. A pending order retains an entry timestamp
   * across the placement-to-fill gap.
   */
  private async syncHoldStarts(ctx: StrategyContext, now: number): Promise<HoldStartsState> {
    const saved = await this.holdStartsState(ctx);
    const heldRefs = new Set(
      ctx.positions
        .filter(
          (position) =>
            position.size > 0 && (position.side === "YES" || position.side === "NO"),
        )
        .map((position) => position.marketRef),
    );
    const openOrderRefs = new Set(ctx.openOrders.map((order) => order.marketRef));
    const byMarket: Record<string, number> = {};

    for (const marketRef of heldRefs) {
      byMarket[marketRef] = saved.byMarket[marketRef] ?? now;
    }
    for (const marketRef of openOrderRefs) {
      const heldSince = saved.byMarket[marketRef];
      if (heldSince !== undefined) byMarket[marketRef] = heldSince;
    }

    const savedEntries = Object.entries(saved.byMarket);
    const changed =
      savedEntries.length !== Object.keys(byMarket).length ||
      savedEntries.some(([marketRef, heldSince]) => byMarket[marketRef] !== heldSince);
    const state = { byMarket };
    if (changed) await ctx.memory.set<HoldStartsState>(HOLD_STARTS_MEMORY_KEY, state);
    return state;
  }

  private async rememberHoldStart(ctx: StrategyContext, marketRef: string, now: number): Promise<void> {
    const saved = await this.holdStartsState(ctx);
    if (saved.byMarket[marketRef] !== undefined) return;
    await ctx.memory.set<HoldStartsState>(HOLD_STARTS_MEMORY_KEY, {
      byMarket: { ...saved.byMarket, [marketRef]: now },
    });
  }

  private async holdStartsState(ctx: StrategyContext): Promise<HoldStartsState> {
    const saved = await ctx.memory.get<HoldStartsState>(HOLD_STARTS_MEMORY_KEY);
    const byMarket: Record<string, number> = {};
    if (!saved?.byMarket || typeof saved.byMarket !== "object") return { byMarket };
    for (const [marketRef, heldSince] of Object.entries(saved.byMarket)) {
      if (Number.isFinite(heldSince) && heldSince >= 0) byMarket[marketRef] = heldSince;
    }
    return { byMarket };
  }

  /**
   * Early convergence take-profit. Remaining edge uses the venue midpoint,
   * while the profit gate uses the held outcome's executable best bid. This
   * never treats an untradeable mark as realized profit.
   *
   * Both legs are measured on the held side's own token: for a NO position,
   * both Q's YES forecast and the venue's YES mid are mirrored. Mixing the two
   * conventions would invert every NO decision.
   */
  private async convergenceCheck(
    ctx: StrategyContext,
    cfg: FlipFlatConfig,
    forecast: MarketForecast,
    held: Position,
  ): Promise<string | undefined> {
    // Prediction markets only — perps carry no binary forecast to converge on.
    if (held.side !== "YES" && held.side !== "NO") return undefined;
    if (!(held.avgPrice > 0)) return undefined;

    let mid: number;
    try {
      mid = (await ctx.venue.quote(forecast.marketRef)).mid;
    } catch (err) {
      ctx.log.warn(`convergence check skipped for ${forecast.marketRef}: ${(err as Error).message}`);
      return undefined;
    }
    if (!(mid > 0 && mid < 1)) return undefined;

    const curPrice = held.side === "NO" ? 1 - mid : mid;
    const prob = held.side === "NO" ? 1 - forecast.probYes : forecast.probYes;
    // Signed on purpose: an overshoot past the forecast is past converged.
    const remainingEdgePp = (prob - curPrice) * 100;

    if (remainingEdgePp > cfg.convergenceExitPp) return undefined;
    let exitPrice: number;
    try {
      const yesBook = await ctx.venue.book(forecast.marketRef);
      const heldBook = held.side === "NO" ? mirrorBookForNo(yesBook) : yesBook;
      exitPrice = heldBook.bids[0]?.price ?? Number.NaN;
    } catch (err) {
      ctx.log.warn(`convergence executable-price check skipped for ${forecast.marketRef}: ${(err as Error).message}`);
      return undefined;
    }
    if (!(exitPrice > 0 && exitPrice < 1)) {
      ctx.log.info(`no executable bid for held ${held.side} ${forecast.marketRef}; convergence not taken`);
      return undefined;
    }

    const profitPct = ((exitPrice - held.avgPrice) / held.avgPrice) * 100;
    if (profitPct + 1e-9 < cfg.minConvergenceProfitPct) return undefined;
    const profit = `${profitPct >= 0 ? "+" : ""}${profitPct.toFixed(1)}%`;
    const minimum = `${cfg.minConvergenceProfitPct >= 0 ? "+" : ""}${cfg.minConvergenceProfitPct.toFixed(1)}%`;
    return `converged: ${remainingEdgePp.toFixed(1)}pp edge left at mid ${curPrice.toFixed(3)}; executable gain ${profit} at bid ${exitPrice.toFixed(3)} >= ${minimum}`;
  }

  /**
   * Snapshot capital already committed before planning this tick. Position
   * cost basis is the amount put into a binary contract; pending BUYs reserve
   * their full remaining limit notional; accepted entries the venue does not
   * show yet keep their reservation. Pending exits do not free exposure until
   * they fill.
   */
  private async portfolioPlanningState(ctx: StrategyContext, reservations: ReservationSync): Promise<PortfolioPlanningState> {
    let availableCashUsd = ctx.equity;
    try {
      const balances = await ctx.venue.balances();
      availableCashUsd = balances.reduce((sum, balance) => sum + Math.max(0, balance.available), 0);
    } catch {
      /* fall back to current equity */
    }
    const reservedNotVisibleUsd = [...reservations.contributionUsdByMarket.values()].reduce((sum, usd) => sum + usd, 0);

    const state: PortfolioPlanningState = {
      // Keep the same small cash buffer as the legacy allocator. Cash that an
      // invisible fill already spent is subtracted before the buffer.
      availableCashUsd: Math.max(0, (availableCashUsd - reservedNotVisibleUsd) * 0.95),
      unresolvedExistingEvent: false,
      marketExposureUsd: new Map(),
      eventExposureUsd: new Map(),
      eventRefs: new Map(),
    };
    for (const [marketRef, eventRef] of reservations.eventRefByMarket) state.eventRefs.set(marketRef, eventRef);

    const addExposure = async (marketRef: string, notional: number) => {
      if (!(notional > 0)) return;
      state.marketExposureUsd.set(
        marketRef,
        (state.marketExposureUsd.get(marketRef) ?? 0) + notional,
      );
      const eventRef = await this.resolveEventRef(ctx, state, marketRef);
      if (!eventRef) {
        state.unresolvedExistingEvent = true;
        return;
      }
      state.eventExposureUsd.set(
        eventRef,
        (state.eventExposureUsd.get(eventRef) ?? 0) + notional,
      );
    };

    for (const position of ctx.positions) {
      if (position.size <= 0) continue;
      await addExposure(position.marketRef, Math.max(0, position.size * position.avgPrice));
    }
    for (const order of ctx.openOrders) {
      if (order.side !== "BUY") continue;
      const remainingSize = Math.max(0, order.size - order.filledSize);
      await addExposure(order.marketRef, remainingSize * order.price);
    }
    for (const [marketRef, notional] of reservations.contributionUsdByMarket) {
      await addExposure(marketRef, notional);
    }

    return state;
  }

  private async resolveEventRef(
    ctx: StrategyContext,
    state: PortfolioPlanningState,
    marketRef: string,
  ): Promise<string | undefined> {
    if (state.eventRefs.has(marketRef)) return state.eventRefs.get(marketRef);
    let eventRef: string | undefined;
    try {
      eventRef = await ctx.venue.eventRef?.(marketRef);
    } catch (err) {
      ctx.log.warn(`event lookup failed for ${marketRef}: ${(err as Error).message}`);
    }
    state.eventRefs.set(marketRef, eventRef);
    return eventRef;
  }

  private async portfolioEntry(
    ctx: StrategyContext,
    cfg: FlipFlatConfig,
    state: PortfolioPlanningState,
    sig: Signal,
  ): Promise<{ notional: number; eventRef: string; liveEdgePp: number; provenance: Record<string, unknown> } | undefined> {
    if ((sig.side !== "YES" && sig.side !== "NO") || sig.prob === undefined) {
      ctx.log.info(`portfolio Kelly requires a binary probability; skipping ${sig.marketRef}`);
      return undefined;
    }
    if (state.unresolvedExistingEvent) {
      ctx.log.warn(
        `existing exposure has no canonical parent event; failing closed on new entries and top-ups`,
      );
      return undefined;
    }

    let yesMid: number;
    try {
      yesMid = (await ctx.venue.quote(sig.marketRef)).mid;
    } catch (err) {
      ctx.log.warn(`live entry quote failed for ${sig.marketRef}: ${(err as Error).message}`);
      return undefined;
    }
    const price = sig.side === "NO" ? 1 - yesMid : yesMid;
    if (!(price > 0 && price < 1)) return undefined;

    // Revalidate both edges against the live held-side price. A formerly good
    // signal must not be topped up after the venue has already converged.
    const liveEdgePp = (sig.prob - price) * 100;
    if (liveEdgePp < cfg.entrySpreadPp) return undefined;
    if (cfg.maxEntrySpreadPp !== null && liveEdgePp - cfg.maxEntrySpreadPp > 1e-9) {
      ctx.log.info(
        `live edge ${liveEdgePp.toFixed(1)}pp > maxEntrySpreadPp ${cfg.maxEntrySpreadPp.toFixed(1)}pp; skipping ${sig.marketRef}`,
      );
      return undefined;
    }

    // Entry eligibility asks whether the position could be unwound near the
    // touch. This is separate from the engine's ask-side entry capacity and
    // is never consulted by an exit action.
    let exitDepthUsd: number | undefined;
    if (cfg.minExitDepth2cUsd > 0) {
      exitDepthUsd = 0;
      try {
        const yesBook = await ctx.venue.book(sig.marketRef);
        const heldBook = sig.side === "NO" ? mirrorBookForNo(yesBook) : yesBook;
        exitDepthUsd = bidDepthWithin2cUsd(heldBook);
      } catch (err) {
        ctx.log.warn(
          `exit-depth check failed for ${sig.marketRef}: ${(err as Error).message}; ` +
            `measured $${exitDepthUsd.toFixed(2)} < required $${cfg.minExitDepth2cUsd.toFixed(2)}`,
        );
        return undefined;
      }
      if (exitDepthUsd + 1e-9 < cfg.minExitDepth2cUsd) {
        ctx.log.info(
          `exit depth within $0.02 of best ${sig.side} bid measured $${exitDepthUsd.toFixed(2)} ` +
            `< required $${cfg.minExitDepth2cUsd.toFixed(2)}; skipping ${sig.marketRef}`,
        );
        return undefined;
      }
    }

    const eventRef = await this.resolveEventRef(ctx, state, sig.marketRef);
    if (!eventRef) {
      ctx.log.warn(`no canonical parent event for ${sig.marketRef}; entry skipped`);
      return undefined;
    }

    const targetUsd = portfolioKellyTargetUsd({
      prob: sig.prob,
      price,
      equity: ctx.equity,
      kellyFraction: cfg.kellyFraction,
      marketCapPct: cfg.marketCapPct,
    });
    const currentMarketUsd = state.marketExposureUsd.get(sig.marketRef) ?? 0;
    const currentEventUsd = state.eventExposureUsd.get(eventRef) ?? 0;
    const marketCapUsd = (cfg.marketCapPct / 100) * ctx.equity;
    const eventCapUsd = (cfg.eventCapPct / 100) * ctx.equity;
    const headroom: Array<[string, number]> = [
      ["target", targetUsd - currentMarketUsd],
      ["market-cap", marketCapUsd - currentMarketUsd],
      ["event-cap", eventCapUsd - currentEventUsd],
      ["cash", state.availableCashUsd],
    ];
    const [limitingCap, rawNotional] = headroom.reduce((best, current) => (current[1] < best[1] ? current : best));
    const notional = Math.max(0, rawNotional);

    const provenance: Record<string, unknown> = {
      allocationMode: "portfolio-kelly",
      signalId: sig.id,
      signalTs: sig.ts,
      side: sig.side,
      qHeld: sig.prob,
      signalRefPrice: sig.refPrice,
      ...(signalEdgePp(sig) !== undefined ? { signalEdgePp: signalEdgePp(sig) } : {}),
      liveEdgePp,
      yesMid,
      heldPrice: price,
      eventRef,
      isTopUp: currentMarketUsd > 0,
      equityUsd: ctx.equity,
      targetUsd,
      marketCapUsd,
      eventCapUsd,
      currentMarketUsd,
      currentEventUsd,
      availableCashUsd: state.availableCashUsd,
      headroomUsd: Object.fromEntries(headroom),
      limitingCap,
      requestedNotionalUsd: notional,
      ...(exitDepthUsd !== undefined ? { exitDepth2cUsd: exitDepthUsd } : {}),
    };

    if (notional < cfg.minEntryNotional) {
      if (notional > 0) {
        ctx.log.info(
          `portfolio top-up $${notional.toFixed(2)} < minEntryNotional $${cfg.minEntryNotional.toFixed(2)}; skipping ${sig.marketRef}`,
        );
      }
      return undefined;
    }
    return { notional, eventRef, liveEdgePp, provenance };
  }

  /** USD notional for a legacy entry, bounded by today's remaining budget and cash. */
  private async dailyEntryNotional(
    ctx: StrategyContext,
    cfg: FlipFlatConfig,
    sig: Signal,
    remainingBudgetUsd: number,
  ): Promise<number> {
    if (remainingBudgetUsd <= 0) {
      ctx.log.info(`daily entry budget $${cfg.dailyBudgetUsd.toFixed(2)} exhausted; skipping ${sig.marketRef}`);
      return 0;
    }
    let available = ctx.equity;
    try {
      const balances = await ctx.venue.balances();
      available = balances.reduce((s, x) => s + x.available, 0);
    } catch {
      /* fall back to equity */
    }
    const perPositionUsd = (cfg.dailyBudgetUsd * cfg.positionBudgetPct) / 100;
    const notional = Math.min(perPositionUsd, remainingBudgetUsd, available * 0.95);
    if (notional < cfg.minEntryNotional) {
      ctx.log.info(
        `entry notional $${notional.toFixed(2)} < minEntryNotional $${cfg.minEntryNotional.toFixed(2)}; skipping ${sig.marketRef}`,
      );
      return 0;
    }
    return notional;
  }

  private async entryOk(
    ctx: StrategyContext,
    cfg: FlipFlatConfig,
    sig: Signal,
    spreadPp: number | undefined,
  ): Promise<boolean> {
    if (sig.side === "YES" || sig.side === "NO") {
      if (spreadPp === undefined || spreadPp < cfg.entrySpreadPp) return false;
      if (cfg.maxEntrySpreadPp !== null && spreadPp > cfg.maxEntrySpreadPp) {
        ctx.log.info(
          `signal edge ${spreadPp.toFixed(1)}pp > maxEntrySpreadPp ${cfg.maxEntrySpreadPp.toFixed(1)}pp; skipping ${sig.marketRef}`,
        );
        return false;
      }
      return true;
    }
    // Perps: the signal itself is the trigger; refPrice is the entry sanity bound.
    try {
      const q = await ctx.venue.quote(sig.marketRef);
      const driftPct = Math.abs(q.mid - sig.refPrice) / sig.refPrice * 100;
      if (driftPct > cfg.refPriceSanityPct) {
        ctx.log.info(`price drifted ${driftPct.toFixed(2)}% from signal refPrice; skipping ${sig.marketRef}`);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }
}

export const strategy = new FlipFlatStrategy();

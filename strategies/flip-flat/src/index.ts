// strategies/flip-flat/src/index.ts
// Reference strategy (§8): buy, take profitable convergence, and enforce a
// maximum holding period.
// Pure decisions — the engine sizes, risk-checks, and executes.

import { z } from "zod";
import {
  isSignalFresh,
  marketForecastFromSignal,
  mirrorBookForNo,
  type Action,
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
const HOLD_STARTS_MEMORY_KEY = "position-hold-starts";
const DAY_MS = 86_400_000;

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

export class FlipFlatStrategy implements Strategy {
  readonly id = "flip-flat";

  async tick(ctx: StrategyContext): Promise<Action[]> {
    const cfg = FlipFlatConfigSchema.parse(ctx.config ?? {});
    const actions: Action[] = [];
    const signals = await ctx.signals.latest({ venue: ctx.venueId });
    const now = ctx.now();
    const holdStarts = await this.syncHoldStarts(ctx, now);
    let remainingBudgetUsd = Number.POSITIVE_INFINITY;
    if (cfg.allocationMode === "daily-budget") {
      const budget = await this.dailyBudgetState(ctx, now);
      remainingBudgetUsd = Math.max(0, cfg.dailyBudgetUsd - budget.placedUsd);
    }
    const portfolio =
      cfg.allocationMode === "portfolio-kelly"
        ? await this.portfolioPlanningState(ctx)
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

    // Resting orders occupy a slot too; otherwise a slow fill could let later
    // ticks place more entry orders than the configured position limit.
    const openOrderMarkets = new Set(ctx.openOrders.map((order) => order.marketRef));
    const occupiedMarkets = new Set([
      ...ctx.positions.filter((position) => position.size > 0).map((position) => position.marketRef),
      ...openOrderMarkets,
    ]);
    let openCount = occupiedMarkets.size;

    // Exits are position-driven, never entry-signal-driven. The maximum hold
    // is checked first and needs no forecast. Before that deadline,
    // convergence may take profit but never realizes a sub-threshold gain.
    // An existing order suppresses another exit for the same market.
    const heldPositions = ctx.positions.filter(
      (position) =>
        position.size > 0 &&
        !position.redeemable &&
        (position.side === "YES" || position.side === "NO"),
    );
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
        });
        entryBlockedMarkets.add(held.marketRef);
        continue;
      }
      if (cfg.convergenceExit) convergenceCandidates.push(held);
    }

    if (convergenceCandidates.length > 0) {
      const heldRefs = new Set(convergenceCandidates.map((position) => position.marketRef));
      const fallbackForecasts = signals
        .map(marketForecastFromSignal)
        .filter(
          (forecast): forecast is MarketForecast =>
            forecast !== null && heldRefs.has(forecast.marketRef),
        );
      let forecasts = fallbackForecasts;
      const fetchForecasts = ctx.signals.forecasts?.bind(ctx.signals);
      if (fetchForecasts) {
        try {
          const queried = await fetchForecasts({
            venue: ctx.venueId,
            marketRefs: [...heldRefs],
          });
          const queriedRefs = new Set(queried.map((forecast) => forecast.marketRef));
          forecasts = [
            ...queried,
            ...fallbackForecasts.filter((forecast) => !queriedRefs.has(forecast.marketRef)),
          ];
        } catch (err) {
          ctx.log.warn(`held forecast refresh failed: ${(err as Error).message}`);
        }
      }
      const forecastByMarket = new Map(
        forecasts.map((forecast) => [forecast.marketRef, forecast]),
      );
      for (const held of convergenceCandidates) {
        if (entryBlockedMarkets.has(held.marketRef)) continue;
        const forecast = forecastByMarket.get(held.marketRef);
        if (!forecast) {
          ctx.log.info(`no Q forecast for held market ${held.marketRef}; convergence not evaluated`);
          continue;
        }
        const conv = await this.convergenceCheck(ctx, cfg, forecast, held);
        if (conv) {
          actions.push({ kind: "exit", marketRef: held.marketRef, reason: conv });
          // The position still consumes exposure until the exit actually
          // fills. Never spend that headroom speculatively in the same tick.
          entryBlockedMarkets.add(held.marketRef);
        }
      }
    }

    // Widest edge first. An optional topN cap and the daily budget can bind
    // partway down this list, so iteration order decides which markets get the
    // capital. Signals with no computable edge (perps) sort as 0 and the sort
    // is stable, so their relative order is unchanged.
    const ranked = [...latestByMarket.entries()].sort((a, b) => edgePpOf(b[1]) - edgePpOf(a[1]));

    for (const [marketRef, sig] of ranked) {
      if (entryBlockedMarkets.has(marketRef)) continue;
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
    }
  }

  private async dailyBudgetState(ctx: StrategyContext, now: number): Promise<DailyBudgetState> {
    const utcDay = new Date(now).toISOString().slice(0, 10);
    const saved = await ctx.memory.get<DailyBudgetState>(DAILY_BUDGET_MEMORY_KEY);
    return saved?.utcDay === utcDay ? saved : { utcDay, placedUsd: 0 };
  }

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
   * their full remaining limit notional. Pending exits do not free exposure
   * until they fill.
   */
  private async portfolioPlanningState(ctx: StrategyContext): Promise<PortfolioPlanningState> {
    let availableCashUsd = ctx.equity;
    try {
      const balances = await ctx.venue.balances();
      availableCashUsd = balances.reduce((sum, balance) => sum + Math.max(0, balance.available), 0);
    } catch {
      /* fall back to current equity */
    }

    const state: PortfolioPlanningState = {
      // Keep the same small cash buffer as the legacy allocator.
      availableCashUsd: Math.max(0, availableCashUsd * 0.95),
      unresolvedExistingEvent: false,
      marketExposureUsd: new Map(),
      eventExposureUsd: new Map(),
      eventRefs: new Map(),
    };

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
  ): Promise<{ notional: number; eventRef: string; liveEdgePp: number } | undefined> {
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
    if (cfg.minExitDepth2cUsd > 0) {
      let exitDepthUsd = 0;
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
    const notional = Math.max(
      0,
      Math.min(
        targetUsd - currentMarketUsd,
        marketCapUsd - currentMarketUsd,
        eventCapUsd - currentEventUsd,
        state.availableCashUsd,
      ),
    );

    if (notional < cfg.minEntryNotional) {
      if (notional > 0) {
        ctx.log.info(
          `portfolio top-up $${notional.toFixed(2)} < minEntryNotional $${cfg.minEntryNotional.toFixed(2)}; skipping ${sig.marketRef}`,
        );
      }
      return undefined;
    }
    return { notional, eventRef, liveEdgePp };
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

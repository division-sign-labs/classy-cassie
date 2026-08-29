// strategies/flip-flat/src/index.ts
// Reference strategy (§8): buy and hold until the market prices in the forecast.
// Pure decisions — the engine sizes, risk-checks, and executes.

import { z } from "zod";
import {
  isSignalFresh,
  marketForecastFromSignal,
  type Action,
  type MarketForecast,
  type Position,
  type Signal,
  type Strategy,
  type StrategyActionResult,
  type StrategyContext,
} from "@quotient-forecasting/cassie-core";

export const FlipFlatConfigSchema = z.object({
  /** Enter when |prob − price| in percentage points is at least this. */
  entrySpreadPp: z.number().default(10),
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
   * Convergence exit (prediction markets, on by default): the sole exit. Fires
   * when the remaining edge on the held side has closed to `convergenceExitPp`
   * or less, in profit or at a loss — once the forecast is at or below the
   * price, holding has no expected upside left. While edge remains, the
   * position is held regardless of P&L: a cheap market under a higher forecast
   * is still +EV to hold.
   */
  convergenceExit: z.boolean().default(true),
  /** Remaining edge, in pp, at or below which the forecast counts as priced in. */
  convergenceExitPp: z.number().default(2),
});
export type FlipFlatConfig = z.output<typeof FlipFlatConfigSchema>;

export const DAILY_BUDGET_MEMORY_KEY = "daily-entry-budget";

interface DailyBudgetState {
  utcDay: string;
  placedUsd: number;
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
    const budget = await this.dailyBudgetState(ctx, now);
    let remainingBudgetUsd = Math.max(0, cfg.dailyBudgetUsd - budget.placedUsd);

    // Latest signal per market, restricted to the configured universe.
    const latestByMarket = new Map<string, Signal>();
    for (const s of signals) {
      if (cfg.universe !== "from-signals" && !cfg.universe.includes(s.marketRef)) continue;
      const prev = latestByMarket.get(s.marketRef);
      if (!prev || Date.parse(s.ts) >= Date.parse(prev.ts)) latestByMarket.set(s.marketRef, s);
    }

    // Resolution first: redeem where the venue requires it (Polymarket).
    for (const pos of ctx.positions) {
      if (pos.redeemable) {
        actions.push({ kind: "redeem", marketRef: pos.marketRef, reason: "market resolved" });
      }
    }

    // Resting orders occupy a slot too; otherwise a slow fill could let later
    // ticks place more entry orders than the configured position limit.
    const occupiedMarkets = new Set([
      ...ctx.positions.filter((position) => position.size > 0).map((position) => position.marketRef),
      ...ctx.openOrders.map((order) => order.marketRef),
    ]);
    let openCount = occupiedMarkets.size;

    // Exits are position-driven, never signal-driven. Query the latest Q
    // forecast for every held prediction market even when its entry signal is
    // stale or no longer published, then compare it with a fresh venue quote.
    const heldPositions = ctx.positions.filter(
      (position) =>
        position.size > 0 &&
        !position.redeemable &&
        (position.side === "YES" || position.side === "NO"),
    );
    if (cfg.convergenceExit && heldPositions.length > 0) {
      const heldRefs = new Set(heldPositions.map((position) => position.marketRef));
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
      for (const held of heldPositions) {
        const forecast = forecastByMarket.get(held.marketRef);
        if (!forecast) {
          ctx.log.info(`no Q forecast for held market ${held.marketRef}; convergence not evaluated`);
          continue;
        }
        const conv = await this.convergenceCheck(ctx, cfg, forecast, held);
        if (conv) {
          actions.push({ kind: "exit", marketRef: held.marketRef, reason: conv });
          openCount -= 1;
        }
      }
    }

    // Widest edge first. An optional topN cap and the daily budget can bind
    // partway down this list, so iteration order decides which markets get the
    // capital. Signals with no computable edge (perps) sort as 0 and the sort
    // is stable, so their relative order is unchanged.
    const ranked = [...latestByMarket.entries()].sort((a, b) => edgePpOf(b[1]) - edgePpOf(a[1]));

    for (const [marketRef, sig] of ranked) {
      // A held position was evaluated above from its forecast, whether or not
      // this entry signal remains active or fresh.
      if (ctx.positions.some((position) => position.marketRef === marketRef && position.size > 0)) continue;
      if (!isSignalFresh(sig, now)) {
        ctx.log.info(`stale signal for ${marketRef} (ts=${sig.ts}, ttl=${sig.ttlSec}s); no entry`);
        continue;
      }

      // Flat → enter the signaled side when the edge is wide enough.
      if (ctx.openOrders.some((o) => o.marketRef === marketRef)) continue;
      const spreadPp = signalEdgePp(sig);
      const entryConditionMet = await this.entryOk(ctx, cfg, sig, spreadPp);
      if (cfg.topN !== null && openCount >= cfg.topN) {
        // Say what was passed over, and at what edge — a silent cap reads as
        // "nothing else qualified" when the truth is "we ran out of slots".
        ctx.log.info(
          `top ${cfg.topN} positions already filled; skipping ${marketRef}` +
            (spreadPp !== undefined ? ` (edge ${spreadPp.toFixed(1)}pp)` : ""),
        );
        continue;
      }
      if (entryConditionMet) {
        const notional = await this.entryNotional(ctx, cfg, sig, remainingBudgetUsd);
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
      }
    }

    return actions;
  }

  async onActionResult(ctx: StrategyContext, action: Action, result: StrategyActionResult): Promise<void> {
    if (action.kind !== "enter" || !result.placed || !(result.placedNotional && result.placedNotional > 0)) return;
    const now = ctx.now();
    const current = await this.dailyBudgetState(ctx, now);
    await ctx.memory.set<DailyBudgetState>(DAILY_BUDGET_MEMORY_KEY, {
      utcDay: current.utcDay,
      placedUsd: current.placedUsd + result.placedNotional,
    });
  }

  private async dailyBudgetState(ctx: StrategyContext, now: number): Promise<DailyBudgetState> {
    const utcDay = new Date(now).toISOString().slice(0, 10);
    const saved = await ctx.memory.get<DailyBudgetState>(DAILY_BUDGET_MEMORY_KEY);
    return saved?.utcDay === utcDay ? saved : { utcDay, placedUsd: 0 };
  }

  /**
   * Convergence exit test. Returns the exit reason when the forecast has been
   * priced in, or undefined to keep holding.
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
    const profitPct = ((curPrice - held.avgPrice) / held.avgPrice) * 100;
    return `converged: ${remainingEdgePp.toFixed(1)}pp edge left at ${curPrice.toFixed(3)}, ${profitPct >= 0 ? "+" : ""}${profitPct.toFixed(1)}%`;
  }

  /** USD notional for a new entry, bounded by today's remaining budget and cash. */
  private async entryNotional(
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
      return spreadPp !== undefined && spreadPp >= cfg.entrySpreadPp;
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

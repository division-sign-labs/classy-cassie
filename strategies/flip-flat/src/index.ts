// strategies/flip-flat/src/index.ts
// Reference strategy (§8): buy and hold until the forecast side flips.
// Pure decisions — the engine sizes, risk-checks, and executes.

import { z } from "zod";
import {
  isSignalFresh,
  type Action,
  type Position,
  type Signal,
  type Strategy,
  type StrategyContext,
} from "@quotient/cassie-core";

export const FlipFlatConfigSchema = z.object({
  /** Enter when |prob − price| in percentage points is at least this. */
  entrySpreadPp: z.number().default(10),
  reenterOnFlip: z.boolean().default(true),
  /**
   * Position sizing. "quarter-kelly" sizes each entry from the signal's
   * probability and price (fraction = max(0, f-star/4) of equity), bounded by
   * maxPositionNotional and the available balance, so positions keep opening
   * until the budget is used. "fixed" uses maxPositionNotional per position.
   * Signals without a probability (perps) size as "fixed".
   */
  sizing: z.enum(["quarter-kelly", "fixed"]).default("fixed"),
  /** Per-position notional cap, USD. The engine may cap it further (§9). */
  maxPositionNotional: z.number().positive().default(50),
  maxOpenPositions: z.number().int().positive().default(5),
  /** Explicit marketRefs, or "from-signals" to trade whatever is signaled. */
  universe: z.union([z.literal("from-signals"), z.array(z.string())]).default("from-signals"),
  tickIntervalMin: z.number().positive().default(5),
  /** Perps entry sanity bound: skip if mid drifted more than this % from refPrice. */
  refPriceSanityPct: z.number().positive().default(2),
  /**
   * Convergence exit (prediction markets, on by default): take profit when the
   * market has priced in the forecast, rather than holding for a flip that may
   * never come. Fires when the remaining edge has closed to `convergenceExitPp`
   * or less AND the position is up at least `minProfitPct`.
   *
   * The two conditions are both required on purpose: edge closing while the
   * position is flat or down means the market moved against the entry, which
   * is a losing exit rather than a converged one.
   */
  convergenceExit: z.boolean().default(true),
  /** Remaining edge, in pp, at or below which the forecast counts as priced in. */
  convergenceExitPp: z.number().default(2),
  /** Floor on realized gain before a convergence exit may fire, in % of entry. */
  minProfitPct: z.number().default(1),
});
export type FlipFlatConfig = z.output<typeof FlipFlatConfigSchema>;

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

    let openCount = ctx.positions.filter((p) => p.size > 0).length;

    // Widest edge first. maxOpenPositions and the sizing budget both bind
    // partway down this list, so iteration order decides which markets get the
    // capital — unordered, that was whichever rows the gateway happened to
    // return first. Signals with no computable edge (perps) sort as 0 and the
    // sort is stable, so their relative order is unchanged.
    const ranked = [...latestByMarket.entries()].sort((a, b) => edgePpOf(b[1]) - edgePpOf(a[1]));

    for (const [marketRef, sig] of ranked) {
      if (!isSignalFresh(sig, now)) {
        ctx.log.info(`stale signal for ${marketRef} (ts=${sig.ts}, ttl=${sig.ttlSec}s); no action`);
        continue;
      }
      const held = ctx.positions.find((p) => p.marketRef === marketRef && p.size > 0);
      const hasRestingOrder = ctx.openOrders.some((o) => o.marketRef === marketRef);

      const spreadPp = signalEdgePp(sig);
      const entryConditionMet = await this.entryOk(ctx, cfg, sig, spreadPp);

      if (!held) {
        // Flat → enter the signaled side when the edge is wide enough.
        if (hasRestingOrder) continue;
        if (openCount >= cfg.maxOpenPositions) {
          // Say what was passed over, and at what edge — a silent cap reads as
          // "nothing else qualified" when the truth is "we ran out of slots".
          ctx.log.info(
            `maxOpenPositions ${cfg.maxOpenPositions} reached; skipping ${marketRef}` +
              (spreadPp !== undefined ? ` (edge ${spreadPp.toFixed(1)}pp)` : ""),
          );
          continue;
        }
        if (entryConditionMet) {
          const notional = await this.entryNotional(ctx, cfg, sig);
          if (notional <= 0) {
            ctx.log.info(`no sizeable edge or budget for ${marketRef}; skipping`);
            continue;
          }
          actions.push({
            kind: "enter",
            marketRef,
            side: sig.side,
            notional,
            reason: `signal ${sig.id}${spreadPp !== undefined ? ` spread ${spreadPp.toFixed(1)}pp` : ""}`,
          });
          openCount += 1;
        }
        continue;
      }

      if (held.side !== sig.side) {
        // Forecast flipped: exit, then re-enter per config.
        actions.push({ kind: "exit", marketRef, reason: `flip ${held.side}→${sig.side} (signal ${sig.id})` });
        openCount -= 1;
        if (cfg.reenterOnFlip && entryConditionMet && openCount < cfg.maxOpenPositions && !hasRestingOrder) {
          const notional = await this.entryNotional(ctx, cfg, sig);
          if (notional > 0) {
            actions.push({
              kind: "enter",
              marketRef,
              side: sig.side,
              notional,
              reason: `flip re-entry (signal ${sig.id})`,
            });
            openCount += 1;
          }
        }
      }
      // Sides agree. Hold, unless the market has converged onto the forecast
      // and the position is in profit — the thesis paid out, so bank it.
      else if (cfg.convergenceExit) {
        const conv = await this.convergenceCheck(ctx, cfg, sig, held);
        if (conv) {
          actions.push({ kind: "exit", marketRef, reason: conv });
          openCount -= 1;
        }
      }
    }

    return actions;
  }

  /**
   * Convergence exit test. Returns the exit reason when the forecast has been
   * priced in at a profit, or undefined to keep holding.
   *
   * Both legs are measured on the held side's own token: for a NO position the
   * price is 1 − YES mid, and `sig.prob` already arrives expressed for the
   * signaled side. Mixing the two conventions would invert every NO decision.
   */
  private async convergenceCheck(
    ctx: StrategyContext,
    cfg: FlipFlatConfig,
    sig: Signal,
    held: Position,
  ): Promise<string | undefined> {
    // Prediction markets only — perps signals carry no probability to converge on.
    if (held.side !== "YES" && held.side !== "NO") return undefined;
    if (sig.prob === undefined || !(held.avgPrice > 0)) return undefined;

    let mid: number;
    try {
      mid = (await ctx.venue.quote(sig.marketRef)).mid;
    } catch (err) {
      ctx.log.warn(`convergence check skipped for ${sig.marketRef}: ${(err as Error).message}`);
      return undefined;
    }
    if (!(mid > 0 && mid < 1)) return undefined;

    const curPrice = held.side === "NO" ? 1 - mid : mid;
    // Signed on purpose: an overshoot past the forecast is past converged.
    const remainingEdgePp = (sig.prob - curPrice) * 100;
    const profitPct = ((curPrice - held.avgPrice) / held.avgPrice) * 100;

    if (remainingEdgePp > cfg.convergenceExitPp) return undefined;
    if (profitPct < cfg.minProfitPct) {
      ctx.log.info(
        `${sig.marketRef} converged (${remainingEdgePp.toFixed(1)}pp left) but only ${profitPct.toFixed(1)}% up; holding for ${cfg.minProfitPct}%`,
      );
      return undefined;
    }
    return `converged: ${remainingEdgePp.toFixed(1)}pp edge left at ${curPrice.toFixed(3)}, +${profitPct.toFixed(1)}%`;
  }

  /** USD notional for a new entry, per the configured sizing mode. */
  private async entryNotional(ctx: StrategyContext, cfg: FlipFlatConfig, sig: Signal): Promise<number> {
    if (cfg.sizing !== "quarter-kelly" || sig.prob === undefined || !(sig.refPrice > 0 && sig.refPrice < 1)) {
      return cfg.maxPositionNotional;
    }
    // Quarter Kelly on the signaled side: p = side probability, price = side cost,
    // b = (1−price)/price, f* = p − (1−p)/b, fraction = max(0, f*/4) of equity.
    const p = sig.prob;
    const price = sig.refPrice;
    const b = (1 - price) / price;
    const fStar = p - (1 - p) / b;
    const frac = Math.max(0, fStar / 4);
    if (frac <= 0) return 0;
    let available = ctx.equity;
    try {
      const balances = await ctx.venue.balances();
      available = balances.reduce((s, x) => s + x.available, 0);
    } catch {
      /* fall back to equity */
    }
    return Math.min(frac * ctx.equity, cfg.maxPositionNotional, available * 0.95);
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

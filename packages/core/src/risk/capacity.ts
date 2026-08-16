// packages/core/src/risk/capacity.ts
// Capacity and volume checks (§9). Runs before every order the strategy or
// manual-trade path emits. Pure functions over book/quote snapshots.

import type { OrderBook, OrderSide, Quote } from "../types.js";
import type { RiskConfig } from "../config.js";

export interface CapacityInput {
  side: OrderSide;
  /** Desired size in base units. */
  desiredSize: number;
  /** Reference price used to convert notional caps to size. */
  refPrice: number;
  book: OrderBook;
  quote: Quote;
  risk: RiskConfig;
  /** Per-order floor. May tighten, but never weaken, risk.minViableNotional. */
  minimumNotional?: number;
}

export interface CapacityResult {
  ok: boolean;
  /** Final size after capping; 0 when skipped. */
  size: number;
  /** Crossing limit price at the edge of the slippage band. */
  limitPrice: number;
  /** Depth (base units) executable within the slippage band. */
  bandDepth: number;
  capped: boolean;
  skipReasons: string[];
  notes: string[];
}

/**
 * Compute executable size within the configured band (an absolute book walk
 * from the touch when maxBookWalkCents is set, otherwise maxSlippageBps from
 * mid), cap at
 * min(desired, depthCapPct × bandDepth, maxOrderNotional), enforce market
 * eligibility (volume/spread floors) and minViableNotional.
 */
export function checkCapacity(input: CapacityInput): CapacityResult {
  const { side, desiredSize, refPrice, book, quote, risk } = input;
  const minimumNotional = Math.max(risk.minViableNotional, input.minimumNotional ?? 0);
  const skipReasons: string[] = [];
  const notes: string[] = [];

  const levels = side === "BUY" ? book.asks : book.bids;
  const touch = levels[0]?.price;
  const maxBookWalkCents = risk.maxBookWalkCents;
  const usesBookWalk = maxBookWalkCents !== undefined;
  const band = maxBookWalkCents !== undefined ? maxBookWalkCents / 100 : (quote.mid * risk.maxSlippageBps) / 10_000;
  const anchor = usesBookWalk && touch !== undefined ? touch : quote.mid;
  const limitPrice = side === "BUY" ? anchor + band : anchor - band;

  // Market eligibility floor (§9).
  if (quote.volume24h < risk.minDailyVolume) {
    skipReasons.push(`24h volume $${quote.volume24h.toFixed(0)} < minDailyVolume $${risk.minDailyVolume}`);
  }
  if (quote.spreadBps > risk.maxSpreadBps) {
    skipReasons.push(`spread ${quote.spreadBps.toFixed(0)}bps > maxSpreadBps ${risk.maxSpreadBps}`);
  }

  // Executable depth within the band.
  let bandDepth = 0;
  for (const lvl of levels) {
    const inBand = side === "BUY" ? lvl.price <= limitPrice : lvl.price >= limitPrice;
    if (!inBand) break;
    bandDepth += lvl.size;
  }
  if (bandDepth <= 0) {
    skipReasons.push(
      usesBookWalk
        ? `no depth within ${maxBookWalkCents}¢ of best ${side === "BUY" ? "ask" : "bid"}`
        : `no depth within ${risk.maxSlippageBps}bps of mid`,
    );
  }

  const depthCap = bandDepth * (risk.depthCapPct / 100);
  const notionalCap = risk.maxOrderNotional / refPrice;
  let size = Math.min(desiredSize, depthCap, notionalCap);
  const capped = size < desiredSize;
  if (capped && size === depthCap) {
    notes.push(`size capped by depth: ${risk.depthCapPct}% of ${bandDepth.toFixed(2)} in-band = ${depthCap.toFixed(2)}`);
  } else if (capped && size === notionalCap) {
    notes.push(`size capped by maxOrderNotional $${risk.maxOrderNotional}`);
  }

  if (size * refPrice < minimumNotional) {
    skipReasons.push(
      `capped notional $${(size * refPrice).toFixed(2)} < minimum notional $${minimumNotional} — skip rather than dribble`,
    );
  }

  if (skipReasons.length > 0) {
    return { ok: false, size: 0, limitPrice, bandDepth, capped, skipReasons, notes };
  }
  return { ok: true, size, limitPrice, bandDepth, capped, skipReasons, notes };
}

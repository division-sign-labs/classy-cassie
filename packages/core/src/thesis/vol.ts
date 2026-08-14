// packages/core/src/thesis/vol.ts
// Volatility estimation behind an interface (§13 extension point).
// ATR (Wilder) is the only MVP implementation.
// EXTEND: realized-vol or regime-aware estimators are PR-able here without
// touching the ticket flow — implement VolEstimator and register it.

import type { Candle } from "../types.js";

export interface VolEstimator {
  id: string;
  /** Returns a price-unit volatility figure (e.g. ATR) from candles. */
  estimate(candles: Candle[], lookback: number): number;
}

export const atrEstimator: VolEstimator = {
  id: "atr-wilder",
  estimate(candles: Candle[], lookback: number): number {
    if (candles.length < lookback + 1) {
      throw new Error(`ATR needs ${lookback + 1} candles, got ${candles.length}`);
    }
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i]!;
      const prevClose = candles[i - 1]!.close;
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
    }
    // Wilder's smoothing: seed with SMA of the first `lookback` TRs.
    let atr = trs.slice(0, lookback).reduce((s, v) => s + v, 0) / lookback;
    for (let i = lookback; i < trs.length; i++) {
      atr = (atr * (lookback - 1) + trs[i]!) / lookback;
    }
    return atr;
  },
};

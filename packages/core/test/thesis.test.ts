// packages/core/test/thesis.test.ts
// §13 sizing arithmetic, hand-computed. Elicitation lives in the skill;
// every number here comes from buildTicket/buildPredictionSize.

import { describe, expect, it } from "vitest";
import {
  atrEstimator,
  buildPredictionSize,
  buildTicket,
  type Candle,
  type ThesisTicket,
} from "@quotient-forecasting/cassie-core";

const baseTicket: ThesisTicket = {
  venue: "hyperliquid",
  instrument: "ETH",
  side: "LONG",
  confidence: "medium",
  timeframe: "days",
  magnitude: "meaningful",
  riskBudgetPct: 1,
};

describe("buildTicket", () => {
  it("computes stop/target/size per the default mappings (hand-checked)", () => {
    const t = buildTicket(baseTicket, { entryPx: 100, atr: 2, equity: 10_000 });
    // stop: days → 4h ATR14 k=2.0 → 100 − 4 = 96
    expect(t.stopPx).toBe(96);
    // target: meaningful → 2.5R × 4 = 10 → 110
    expect(t.tpPx).toBe(110);
    expect(t.trailBps).toBeUndefined();
    // b=2.5, p₀=1/3.5≈0.285714, p=+0.06 edge≈0.345714, f*≈0.084, qk≈0.021
    expect(t.sizing.fixedFractionalRisk).toBeCloseTo(100, 6);
    expect(t.sizing.quarterKellyRisk).toBeCloseTo(210, 0);
    expect(t.sizing.chosen).toBe("fixed-fractional");
    // size = min risk $100 / stop distance 4 = 25
    expect(t.size).toBeCloseTo(25, 4);
    expect(t.notional).toBeCloseTo(2500, 2);
    expect(t.leverage).toBeCloseTo(0.25, 4);
    expect(t.violations).toEqual([]);
    // Every line prints its provenance (answer → rule → number).
    expect(t.lines.length).toBeGreaterThanOrEqual(6);
    for (const line of t.lines) {
      expect(line.provenance.length).toBeGreaterThan(0);
    }
  });

  it("widens an invalidation inside the 0.5×ATR floor and says so", () => {
    const t = buildTicket({ ...baseTicket, invalidationPx: 99.5 }, { entryPx: 100, atr: 2, equity: 10_000 });
    // floor = 0.5 × 2 = 1.0 → stop widened from 99.5 to 99
    expect(t.stopPx).toBe(99);
    expect(t.warnings.join(" ")).toMatch(/widened/);
  });

  it("uses a respected invalidation level as-is", () => {
    const t = buildTicket({ ...baseTicket, invalidationPx: 95 }, { entryPx: 100, atr: 2, equity: 10_000 });
    expect(t.stopPx).toBe(95);
    expect(t.warnings).toEqual([]);
  });

  it("repricing + weeks defaults to a trailing stop instead of fixed TP", () => {
    const t = buildTicket(
      { ...baseTicket, magnitude: "repricing", timeframe: "weeks" },
      { entryPx: 100, atr: 2, equity: 10_000 },
    );
    // weeks → k=2.5 → stop distance 5 → trail = 500bps of entry
    expect(t.tpPx).toBeUndefined();
    expect(t.trailBps).toBe(500);
    const targetLine = t.lines.find((l) => l.field === "target")!;
    expect(targetLine.warning).toBe(true);
    expect(targetLine.value).toMatch(/trailing/);
  });

  it("flags a risk budget above the soft cap as a violation", () => {
    const t = buildTicket({ ...baseTicket, riskBudgetPct: 3 }, { entryPx: 100, atr: 2, equity: 10_000 });
    expect(t.violations.join(" ")).toMatch(/soft cap/);
  });

  it("caps leverage by timeframe when auto-sizing", () => {
    // stop distance 0.1 → unclamped size 1000 → 10x, above the 5x days cap.
    const t = buildTicket(baseTicket, { entryPx: 100, atr: 0.05, equity: 10_000 });
    expect(t.leverage).toBeCloseTo(5, 6);
    expect(t.size).toBeCloseTo(500, 4);
    const capLine = t.lines.find((l) => l.field === "leverage-cap")!;
    expect(capLine).toBeDefined();
    expect(capLine.warning).toBe(true);
    expect(t.violations).toEqual([]);
  });

  it("an overridden size above the leverage cap is a violation, not silently capped", () => {
    const t = buildTicket(baseTicket, { entryPx: 100, atr: 0.05, equity: 10_000 }, undefined, { size: 1000 });
    expect(t.violations.join(" ")).toMatch(/above the 5x cap/);
  });

  it("a stop inside the liquidation buffer is a violation", () => {
    // quarter (k=3, atr 10) → stop 70, distance 30, buffer 60 → liq must be ≤ 10.
    // Overridden size 20 → 2x (at the quarter cap) → liq ≈ 50.5 → violation.
    const t = buildTicket(
      { ...baseTicket, timeframe: "quarter", magnitude: "small", confidence: "low" },
      { entryPx: 100, atr: 10, equity: 1_000 },
      undefined,
      { size: 20 },
    );
    expect(t.leverage).toBeCloseTo(2, 6);
    expect(t.violations.join(" ")).toMatch(/liquidation/);
  });

  it("warns when funding drag exceeds 25% of target distance", () => {
    // quarter small: stop distance 6, target distance 9; 0.1%/8h × 270 periods
    // on a LONG = 27 price units of drag = 300% of target → warn.
    const t = buildTicket(
      { ...baseTicket, timeframe: "quarter", magnitude: "small" },
      { entryPx: 100, atr: 2, equity: 10_000, fundingRate8h: 0.001 },
    );
    expect(t.warnings.join(" ")).toMatch(/funding drag/);
    const fundingLine = t.lines.find((l) => l.field === "funding")!;
    expect(fundingLine.warning).toBe(true);
  });

  it("SHORT mirrors stop and target", () => {
    const t = buildTicket({ ...baseTicket, side: "SHORT" }, { entryPx: 100, atr: 2, equity: 10_000 });
    expect(t.stopPx).toBe(104);
    expect(t.tpPx).toBe(90);
  });

  it("throws when the stop equals entry", () => {
    expect(() => buildTicket({ ...baseTicket, invalidationPx: 100 }, { entryPx: 100, atr: 0, equity: 10_000 })).toThrow();
  });
});

describe("buildPredictionSize (§13 prediction variant)", () => {
  it("hand-checked sizing at prob 0.7, price 0.55", () => {
    const r = buildPredictionSize({ prob: 0.7, price: 0.55, equity: 1_000, riskBudgetPct: 1, confidence: "medium" });
    // b = 0.45/0.55 ≈ 0.8182; f* = 0.7 − 0.3/0.8182 ≈ 0.3333; qk ≈ 0.0833
    expect(r.quarterKellyRisk).toBeCloseTo(83.33, 1);
    expect(r.fixedFractionalRisk).toBeCloseTo(10, 6);
    expect(r.chosen).toBe("fixed-fractional");
    // risk $10 / price 0.55 = 18.1818 shares
    expect(r.size).toBeCloseTo(18.1818, 3);
    expect(r.notional).toBeCloseTo(10, 2);
    expect(r.entrySpreadPp).toBe(10); // medium
    expect(r.arithmetic.length).toBeGreaterThanOrEqual(4);
  });

  it("maps confidence to entrySpreadPp (low 12 / medium 10 / high 7)", () => {
    const at = (confidence: "low" | "medium" | "high") =>
      buildPredictionSize({ prob: 0.7, price: 0.5, equity: 1000, riskBudgetPct: 1, confidence }).entrySpreadPp;
    expect(at("low")).toBe(12);
    expect(at("medium")).toBe(10);
    expect(at("high")).toBe(7);
  });

  it("rejects prices outside (0,1)", () => {
    expect(() => buildPredictionSize({ prob: 0.5, price: 0, equity: 1, riskBudgetPct: 1, confidence: "low" })).toThrow();
    expect(() => buildPredictionSize({ prob: 0.5, price: 1, equity: 1, riskBudgetPct: 1, confidence: "low" })).toThrow();
  });
});

describe("atrEstimator (Wilder)", () => {
  const flat = (n: number): Candle[] =>
    Array.from({ length: n }, (_, i) => ({ ts: i, open: 10, high: 10.5, low: 9.5, close: 10 }));

  it("returns the constant TR for a constant-range series", () => {
    // TR = max(1, 0.5, 0.5) = 1 for every bar.
    expect(atrEstimator.estimate(flat(5), 2)).toBeCloseTo(1, 12);
  });

  it("applies Wilder smoothing after the SMA seed", () => {
    const candles: Candle[] = [
      { ts: 0, open: 10, high: 10, low: 10, close: 10 },
      { ts: 1, open: 10, high: 11, low: 10, close: 11 }, // TR 1
      { ts: 2, open: 11, high: 13, low: 11, close: 13 }, // TR 2
      { ts: 3, open: 13, high: 13, low: 9, close: 9 }, // TR 4
    ];
    // seed = (1+2)/2 = 1.5; then (1.5×1 + 4)/2 = 2.75
    expect(atrEstimator.estimate(candles, 2)).toBeCloseTo(2.75, 12);
  });

  it("throws when there are not enough candles", () => {
    expect(() => atrEstimator.estimate(flat(2), 14)).toThrow(/needs 15 candles/);
  });
});

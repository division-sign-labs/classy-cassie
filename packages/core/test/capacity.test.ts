// packages/core/test/capacity.test.ts
import { describe, expect, it } from "vitest";
import { RiskConfigSchema, checkCapacity, type OrderBook, type Quote } from "@quotient/cassie-core";

// Fixture book (fixtures/books.json), best-first.
const book: OrderBook = {
  marketRef: "fx-yes-1",
  bids: [
    { price: 0.54, size: 50 },
    { price: 0.53, size: 100 },
    { price: 0.5, size: 400 },
  ],
  asks: [
    { price: 0.56, size: 40 },
    { price: 0.57, size: 60 },
    { price: 0.6, size: 500 },
  ],
  ts: 0,
};

function quote(volume24h = 50_000): Quote {
  const bid = 0.54;
  const ask = 0.56;
  const mid = 0.55;
  return { marketRef: "fx-yes-1", bid, ask, mid, volume24h, spreadBps: ((ask - bid) / mid) * 10_000, ts: 0 };
}

describe("checkCapacity (§9)", () => {
  it("caps a BUY at depthCapPct of in-band depth", () => {
    const risk = RiskConfigSchema.parse({ maxSlippageBps: 300 });
    const res = checkCapacity({ side: "BUY", desiredSize: 90.9, refPrice: 0.55, book, quote: quote(), risk });
    expect(res.ok).toBe(true);
    // band = 0.55 * 3% = 0.0165 → limit 0.5665; only the 40 @ 0.56 is in-band.
    expect(res.limitPrice).toBeCloseTo(0.5665, 10);
    expect(res.bandDepth).toBe(40);
    // 25% of 40 = 10 shares.
    expect(res.size).toBe(10);
    expect(res.capped).toBe(true);
    expect(res.notes.join(" ")).toMatch(/depth/);
    expect(res.skipReasons).toHaveLength(0);
  });

  it("caps by maxOrderNotional when that binds first", () => {
    const risk = RiskConfigSchema.parse({ maxSlippageBps: 300, maxOrderNotional: 2, depthCapPct: 100 });
    const res = checkCapacity({ side: "BUY", desiredSize: 30, refPrice: 0.55, book, quote: quote(), risk });
    expect(res.ok).toBe(true);
    expect(res.size).toBeCloseTo(2 / 0.55, 10);
    expect(res.notes.join(" ")).toMatch(/maxOrderNotional/);
  });

  it("skips when 24h volume is below the floor", () => {
    const risk = RiskConfigSchema.parse({ maxSlippageBps: 300 });
    const res = checkCapacity({ side: "BUY", desiredSize: 10, refPrice: 0.55, book, quote: quote(5_000), risk });
    expect(res.ok).toBe(false);
    expect(res.size).toBe(0);
    expect(res.skipReasons.join(" ")).toMatch(/volume/);
  });

  it("skips when spread exceeds maxSpreadBps", () => {
    const risk = RiskConfigSchema.parse({ maxSlippageBps: 300, maxSpreadBps: 100 });
    const res = checkCapacity({ side: "BUY", desiredSize: 10, refPrice: 0.55, book, quote: quote(), risk });
    expect(res.ok).toBe(false);
    expect(res.skipReasons.join(" ")).toMatch(/spread/);
  });

  it("skips rather than dribbles below minViableNotional", () => {
    const risk = RiskConfigSchema.parse({ maxSlippageBps: 300, minViableNotional: 5 });
    const res = checkCapacity({ side: "BUY", desiredSize: 1, refPrice: 0.55, book, quote: quote(), risk });
    expect(res.ok).toBe(false);
    expect(res.skipReasons.join(" ")).toMatch(/minViableNotional/);
  });

  it("skips when no depth sits within the slippage band", () => {
    const risk = RiskConfigSchema.parse({ maxSlippageBps: 10 });
    const res = checkCapacity({ side: "BUY", desiredSize: 10, refPrice: 0.55, book, quote: quote(), risk });
    expect(res.ok).toBe(false);
    expect(res.skipReasons.join(" ")).toMatch(/no depth/);
  });

  it("SELL walks the bid side", () => {
    const risk = RiskConfigSchema.parse({ maxSlippageBps: 300 });
    const res = checkCapacity({ side: "SELL", desiredSize: 100, refPrice: 0.55, book, quote: quote(), risk });
    // limit = 0.5335; only the 50 @ 0.54 is in-band → 25% = 12.5
    expect(res.ok).toBe(true);
    expect(res.bandDepth).toBe(50);
    expect(res.size).toBe(12.5);
  });
});

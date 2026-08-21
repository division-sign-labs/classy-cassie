// packages/core/test/capacity.test.ts
import { describe, expect, it } from "vitest";
import { RiskConfigSchema, checkCapacity, type OrderBook, type Quote } from "@quotient-forecasting/cassie-core";

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
    const risk = RiskConfigSchema.parse({ slippageCents: 0.5 });
    const res = checkCapacity({ side: "BUY", desiredSize: 90.9, refPrice: 0.55, book, quote: quote(), risk });
    expect(res.ok).toBe(true);
    // Half a cent from the 0.56 best ask → limit 0.565; only the 40 @ 0.56 is in-band.
    expect(res.limitPrice).toBeCloseTo(0.565, 10);
    expect(res.bandDepth).toBe(40);
    // 25% of 40 = 10 shares.
    expect(res.size).toBe(10);
    expect(res.capped).toBe(true);
    expect(res.notes.join(" ")).toMatch(/depth/);
    expect(res.skipReasons).toHaveLength(0);
  });

  it("caps by maxOrderNotional when that binds first", () => {
    const risk = RiskConfigSchema.parse({ slippageCents: 0.5, maxOrderNotional: 2, depthCapPct: 100 });
    const res = checkCapacity({ side: "BUY", desiredSize: 30, refPrice: 0.55, book, quote: quote(), risk });
    expect(res.ok).toBe(true);
    expect(res.size).toBeCloseTo(2 / 0.55, 10);
    expect(res.notes.join(" ")).toMatch(/maxOrderNotional/);
  });

  it("measures the slippage band from the best executable price", () => {
    const risk = RiskConfigSchema.parse({ slippageCents: 2, depthCapPct: 100 });
    const res = checkCapacity({ side: "BUY", desiredSize: 1_000, refPrice: 0.55, book, quote: quote(), risk });
    // Two cents from the 0.56 best ask includes 0.56 and 0.57, but not 0.60.
    expect(res.ok).toBe(true);
    expect(res.limitPrice).toBeCloseTo(0.58, 10);
    expect(res.bandDepth).toBe(100);
    expect(res.size).toBe(100);
  });

  it("migrates a legacy maxBookWalkCents config onto slippageCents", () => {
    const risk = RiskConfigSchema.parse({ maxBookWalkCents: 2, maxSlippageBps: 100, maxSpreadBps: 500, depthCapPct: 100 });
    expect(risk.slippageCents).toBe(2);
    const res = checkCapacity({ side: "BUY", desiredSize: 100, refPrice: 0.55, book, quote: quote(), risk });
    expect(res.ok).toBe(true);
    expect(res.bandDepth).toBe(100);
  });

  it("ignores quoted spread: a wide market with depth at the touch is tradable", () => {
    const risk = RiskConfigSchema.parse({ slippageCents: 2 });
    // 0.54/0.56 on a 0.55 mid quotes ~364bps; the old spread gate would skip it.
    const res = checkCapacity({ side: "BUY", desiredSize: 10, refPrice: 0.55, book, quote: quote(), risk });
    expect(res.ok).toBe(true);
    expect(res.skipReasons).toHaveLength(0);
  });

  it("skips when 24h volume is below the floor", () => {
    const risk = RiskConfigSchema.parse({ slippageCents: 2 });
    const res = checkCapacity({ side: "BUY", desiredSize: 10, refPrice: 0.55, book, quote: quote(5_000), risk });
    expect(res.ok).toBe(false);
    expect(res.size).toBe(0);
    expect(res.skipReasons.join(" ")).toMatch(/volume/);
  });

  it("skips rather than dribbles below minViableNotional", () => {
    const risk = RiskConfigSchema.parse({ slippageCents: 2, minViableNotional: 5 });
    const res = checkCapacity({ side: "BUY", desiredSize: 1, refPrice: 0.55, book, quote: quote(), risk });
    expect(res.ok).toBe(false);
    expect(res.skipReasons.join(" ")).toMatch(/minimum notional/);
  });

  it("honours a stricter per-entry floor after depth capping", () => {
    const risk = RiskConfigSchema.parse({ slippageCents: 0.5 });
    const res = checkCapacity({
      side: "BUY",
      desiredSize: 90.9,
      refPrice: 0.55,
      book,
      quote: quote(),
      risk,
      minimumNotional: 10,
    });
    // Capacity caps this to 10 shares = $5.50, so the $10 entry must not dribble through.
    expect(res.ok).toBe(false);
    expect(res.skipReasons.join(" ")).toMatch(/\$5\.50 < minimum notional \$10/);
  });

  it("does not let a per-order floor weaken the bot risk floor", () => {
    const risk = RiskConfigSchema.parse({ slippageCents: 2, minViableNotional: 5 });
    const res = checkCapacity({
      side: "BUY",
      desiredSize: 1,
      refPrice: 0.55,
      book,
      quote: quote(),
      risk,
      minimumNotional: 0,
    });
    expect(res.ok).toBe(false);
    expect(res.skipReasons.join(" ")).toMatch(/minimum notional \$5/);
  });

  it("skips when no depth sits within the slippage band", () => {
    // Band from the touch always includes the touch level when one exists, so
    // an empty band needs an empty side of the book.
    const emptyAsks: OrderBook = { ...book, asks: [] };
    const risk = RiskConfigSchema.parse({ slippageCents: 2 });
    const res = checkCapacity({ side: "BUY", desiredSize: 10, refPrice: 0.55, book: emptyAsks, quote: quote(), risk });
    expect(res.ok).toBe(false);
    expect(res.skipReasons.join(" ")).toMatch(/no depth/);
  });

  it("SELL walks the bid side", () => {
    const risk = RiskConfigSchema.parse({ slippageCents: 0.5 });
    const res = checkCapacity({ side: "SELL", desiredSize: 100, refPrice: 0.55, book, quote: quote(), risk });
    // limit = 0.535; only the 50 @ 0.54 is in-band → 25% = 12.5
    expect(res.ok).toBe(true);
    expect(res.bandDepth).toBe(50);
    expect(res.size).toBe(12.5);
  });

  it("measures the SELL band down from the best bid", () => {
    const risk = RiskConfigSchema.parse({ slippageCents: 1, depthCapPct: 100 });
    const res = checkCapacity({ side: "SELL", desiredSize: 1_000, refPrice: 0.55, book, quote: quote(), risk });
    expect(res.ok).toBe(true);
    expect(res.limitPrice).toBeCloseTo(0.53, 10);
    expect(res.bandDepth).toBe(150);
    expect(res.size).toBe(150);
  });
});

// packages/core/test/mirror.test.ts
import { describe, expect, it } from "vitest";
import { mirrorBookForNo, mirrorQuoteForNo, type OrderBook, type Quote } from "@quotient-forecasting/cassie-core";

const yesBook: OrderBook = {
  marketRef: "fx-yes-1",
  bids: [
    { price: 0.54, size: 50 },
    { price: 0.53, size: 100 },
  ],
  asks: [
    { price: 0.56, size: 40 },
    { price: 0.57, size: 60 },
  ],
  ts: 42,
};

describe("mirrorBookForNo", () => {
  it("maps YES bids to NO asks (and vice versa) at complement prices", () => {
    const no = mirrorBookForNo(yesBook);
    // A YES bid at p is willingness to sell NO at 1-p → NO ask.
    expect(no.asks[0]).toEqual({ price: 1 - 0.54, size: 50 });
    expect(no.asks[1]).toEqual({ price: 1 - 0.53, size: 100 });
    expect(no.bids[0]).toEqual({ price: 1 - 0.56, size: 40 });
    expect(no.bids[1]).toEqual({ price: 1 - 0.57, size: 60 });
    expect(no.marketRef).toBe("fx-yes-1");
    expect(no.ts).toBe(42);
  });

  it("keeps best-first ordering after mirroring", () => {
    const no = mirrorBookForNo(yesBook);
    // Best NO ask (lowest) first; best NO bid (highest) first.
    expect(no.asks[0]!.price).toBeLessThan(no.asks[1]!.price);
    expect(no.bids[0]!.price).toBeGreaterThan(no.bids[1]!.price);
  });
});

describe("mirrorQuoteForNo", () => {
  it("complements bid/ask/mid", () => {
    const q: Quote = { marketRef: "fx-yes-1", bid: 0.54, ask: 0.56, mid: 0.55, volume24h: 50_000, spreadBps: 363.6, ts: 1 };
    const no = mirrorQuoteForNo(q);
    expect(no.bid).toBeCloseTo(1 - 0.56, 12);
    expect(no.ask).toBeCloseTo(1 - 0.54, 12);
    expect(no.mid).toBeCloseTo(0.45, 12);
    expect(no.volume24h).toBe(50_000);
    // Spread re-based on the NO mid: (0.46-0.44)/0.45
    expect(no.spreadBps).toBeCloseTo((0.02 / 0.45) * 10_000, 6);
  });
});

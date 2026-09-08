// strategies/market-make/test/two-sided.test.ts
import { describe, expect, it } from "vitest";
import { TwoSidedPolicySchema, planTwoSidedQuotes, type TwoSidedPlanInput } from "../src/two-sided.js";
import type { TokenBook } from "../src/types.js";

const NOW = Date.parse("2026-09-04T22:00:00Z");
function book(tokenId: string, bid: number, ask: number, depthUsd = 1_000): TokenBook {
  return { tokenId, bids: [{ price: bid, size: depthUsd / bid }], asks: [{ price: ask, size: 2_000 }], ts: NOW };
}
function input(overrides: Partial<TwoSidedPlanInput> = {}): TwoSidedPlanInput {
  return {
    market: {
      marketKey: "polymarket:1", nativeMarketId: "1", conditionId: "condition-1", marketRef: "yes-1",
      eventId: "event-1", category: "Politics", yesTokenId: "yes-1", noTokenId: "no-1",
      active: true, closed: false, archived: false, acceptingOrders: true, orderbookEnabled: true,
      endsAt: NOW + 86_400_000, volume24hUsd: 10_000, tickSize: 0.01, minOrderSize: 5,
    },
    yesBook: book("yes-1", 0.49, 0.51), noBook: book("no-1", 0.49, 0.51),
    inventory: { yesQuantity: 0, noQuantity: 0 }, now: NOW,
    baseOrderUsd: 30, maxOrderUsd: 40, maxMarketUsd: 120, minimumSecondsToEnd: 3_600,
    policy: TwoSidedPolicySchema.parse({}), ...overrides,
  };
}

describe("two-sided complementary quote planner", () => {
  it("has strict operational defaults", () => {
    expect(TwoSidedPolicySchema.parse({})).toMatchObject({ target_markets: 3, minimum_depth_usd: 300, maximum_unpaired_notional_usd: 60 });
    expect(TwoSidedPolicySchema.safeParse({ unexplainedKnob: true }).success).toBe(false);
    expect(TwoSidedPolicySchema.safeParse({ maximum_depth_participation: 2 }).success).toBe(false);
    expect(TwoSidedPolicySchema.safeParse({ minimum_token_price: 0.5 }).success).toBe(false);
  });

  it("quotes a matched BUY pair from flat without a directional forecast", () => {
    const plan = planTwoSidedQuotes(input());
    expect(plan.eligible).toBe(true);
    expect(plan.reasons).toEqual([]);
    expect(plan.quotes.map((quote) => [quote.lane, quote.outcome, quote.side, quote.limitPrice])).toEqual([
      ["bid", "YES", "BUY", 0.49], ["ask", "NO", "BUY", 0.49],
    ]);
    expect(plan.quotes[0]!.size).toBe(plan.quotes[1]!.size);
    expect(plan.quotes[0]!.size * plan.quotes[0]!.limitPrice).toBeCloseTo(30);
  });

  it("uses equal shares at unequal prices, with the expensive leg at the base ticket", () => {
    const plan = planTwoSidedQuotes(input({ yesBook: book("yes-1", 0.78, 0.79), noBook: book("no-1", 0.21, 0.22) }));
    expect(plan.quotes).toHaveLength(2);
    expect(plan.quotes[0]!.size).toBeCloseTo(30 / 0.78);
    expect(plan.quotes[1]!.size).toBe(plan.quotes[0]!.size);
    expect(plan.quotes[1]!.size * plan.quotes[1]!.limitPrice).toBeLessThan(9);
  });

  it("routes the ask through held YES and skews against accumulating more YES", () => {
    const flat = planTwoSidedQuotes(input());
    const held = planTwoSidedQuotes(input({ inventory: { yesQuantity: 80, noQuantity: 0, yesAverageCost: 0.49 } }));
    expect(held.context.skewTicks).toBeGreaterThan(0);
    expect(held.quotes.find((quote) => quote.lane === "ask")).toMatchObject({ outcome: "YES", side: "SELL" });
    expect(held.quotes.some((quote) => quote.outcome === "NO")).toBe(false);
    expect(held.quotes.find((quote) => quote.side === "BUY")!.limitPrice).toBeLessThan(flat.quotes[0]!.limitPrice);
    expect(held.quotes.find((quote) => quote.side === "SELL")!.size).toBeLessThanOrEqual(80);
  });

  it("uses both inventories through SELL lanes with no additional BUY", () => {
    const plan = planTwoSidedQuotes(input({ inventory: { yesQuantity: 80, noQuantity: 80 } }));
    expect(plan.quotes.map((quote) => [quote.lane, quote.outcome, quote.side])).toEqual([
      ["bid", "NO", "SELL"], ["ask", "YES", "SELL"],
    ]);
    expect(plan.quotes.reduce((sum, quote) => sum + quote.limitPrice, 0)).toBeGreaterThan(1);
  });

  it("constrains actual and complementary crosses even with inconsistent books", () => {
    const source = input({ yesBook: book("yes-1", 0.59, 0.61), noBook: book("no-1", 0.44, 0.46) });
    const plan = planTwoSidedQuotes(source);
    expect(plan.quotes).toHaveLength(2);
    const y = plan.quotes.find((quote) => quote.outcome === "YES")!;
    const n = plan.quotes.find((quote) => quote.outcome === "NO")!;
    expect(y.limitPrice).toBeLessThan(0.61);
    expect(n.limitPrice).toBeLessThan(0.46);
    expect(y.limitPrice + 0.44).toBeLessThan(1);
    expect(n.limitPrice + 0.59).toBeLessThan(1);
    expect(y.limitPrice + n.limitPrice).toBeLessThanOrEqual(0.99 + 1e-9);
  });

  it("leaves only the reducing SELL when inventory already exceeds the adverse cap", () => {
    const plan = planTwoSidedQuotes(input({ inventory: { yesQuantity: 130, noQuantity: 0 } }));
    expect(plan.eligible).toBe(false);
    expect(plan.quotes).toHaveLength(1);
    expect(plan.quotes[0]).toMatchObject({ outcome: "YES", side: "SELL", lane: "ask" });
  });

  it("caps worst-case incremental unpaired exposure without crediting an unfilled SELL", () => {
    const plan = planTwoSidedQuotes(input({ inventory: { yesQuantity: 110, noQuantity: 0 } }));
    const buy = plan.quotes.find((quote) => quote.side === "BUY")!;
    expect(buy.size).toBeCloseTo(10);
    expect((110 + buy.size) * 0.5).toBeLessThanOrEqual(60 + 1e-9);
  });

  it("also caps an opposite-outcome SELL that would increase directional exposure", () => {
    const plan = planTwoSidedQuotes(input({ inventory: { yesQuantity: 200, noQuantity: 100 } }));
    const sellNo = plan.quotes.find((quote) => quote.outcome === "NO")!;
    expect(sellNo.side).toBe("SELL");
    expect(sellNo.size).toBeCloseTo(20);
    expect((200 - (100 - sellNo.size)) * 0.5).toBeLessThanOrEqual(60 + 1e-9);
    expect(plan.quotes.find((quote) => quote.outcome === "YES")!.size).toBeGreaterThan(20);
  });

  it("caps both flat legs together by gross market cash commitment", () => {
    const plan = planTwoSidedQuotes(input({ maxMarketUsd: 35 }));
    expect(plan.quotes).toHaveLength(2);
    expect(plan.quotes[0]!.size).toBe(plan.quotes[1]!.size);
    expect(plan.quotes.reduce((sum, quote) => sum + quote.size * quote.limitPrice, 0)).toBeCloseTo(35);
  });

  it("does not round a below-minimum pair up through the cash cap", () => {
    const plan = planTwoSidedQuotes(input({ maxMarketUsd: 4 }));
    expect(plan.quotes).toEqual([]);
    expect(plan.reasons).toContain("buy-capacity-below-minimum-order");
  });

  it("requires depth on both outcomes for new BUYs but keeps feasible reducing SELLs", () => {
    const thin = input({ noBook: book("no-1", 0.49, 0.51, 200) });
    expect(planTwoSidedQuotes(thin).quotes).toEqual([]);
    const reducing = planTwoSidedQuotes({ ...thin, inventory: { yesQuantity: 40, noQuantity: 0 } });
    expect(reducing.reasons).toContain("no-exit-depth-low");
    expect(reducing.quotes).toHaveLength(1);
    expect(reducing.quotes[0]).toMatchObject({ outcome: "YES", side: "SELL" });
  });

  it("allows a held-outcome SELL when the other book is unavailable", () => {
    const plan = planTwoSidedQuotes(input({
      noBook: { tokenId: "no-1", bids: [], asks: [], ts: NOW },
      inventory: { yesQuantity: 40, noQuantity: 0 },
    }));
    expect(plan.reasons).toContain("no-book-invalid");
    expect(plan.quotes).toHaveLength(1);
    expect(plan.quotes[0]).toMatchObject({ outcome: "YES", side: "SELL", size: 40 });
  });

  it("retains reductions through the entry volume, spread, and end-time gates", () => {
    const source = input({ inventory: { yesQuantity: 40, noQuantity: 40 } });
    const plan = planTwoSidedQuotes({
      ...source, market: { ...source.market, volume24hUsd: 0, endsAt: NOW + 1_000 },
      yesBook: book("yes-1", 0.46, 0.54), noBook: book("no-1", 0.46, 0.54),
    });
    expect(plan.eligible).toBe(false);
    expect(plan.quotes).toHaveLength(2);
    expect(plan.quotes.every((quote) => quote.side === "SELL")).toBe(true);
  });

  it("still sells feasible near-boundary inventory when skew prevents a complete pair", () => {
    const plan = planTwoSidedQuotes(input({
      yesBook: book("yes-1", 0.01, 0.02), noBook: book("no-1", 0.98, 0.99),
      inventory: { yesQuantity: 200, noQuantity: 0 },
    }));
    expect(plan.reasons).toContain("no-passive-pair-price");
    expect(plan.reasons).toContain("yes-price-extreme");
    expect(plan.quotes).toHaveLength(1);
    expect(plan.quotes[0]).toMatchObject({ outcome: "YES", side: "SELL", limitPrice: 0.02, size: 200 });
  });

  it("rejects new inventory in extreme price books", () => {
    const plan = planTwoSidedQuotes(input({
      yesBook: book("yes-1", 0.97, 0.98), noBook: book("no-1", 0.02, 0.03),
    }));
    expect(plan.reasons).toContain("no-price-extreme");
    expect(plan.quotes).toEqual([]);
  });

  it("does not mutate books or inventory", () => {
    const source = input();
    const before = structuredClone(source);
    planTwoSidedQuotes(source);
    expect(source).toEqual(before);
  });
});

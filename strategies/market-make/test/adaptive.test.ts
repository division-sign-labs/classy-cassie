// strategies/market-make/test/adaptive.test.ts
import { describe, expect, it } from "vitest";
import { AdaptivePolicySchema, type AdaptiveForecast, type AdaptiveMovement, type AdaptiveInventoryControl } from "../src/adaptive-policy.js";
import { planAdaptiveQuotes } from "../src/adaptive.js";
import { planTwoSidedQuotes, TwoSidedPolicySchema, type TwoSidedPlanInput } from "../src/two-sided.js";
import type { TokenBook } from "../src/types.js";

const NOW = Date.parse("2026-09-05T12:00:00Z");
function book(tokenId: string, bid = 0.49, ask = 0.51, ts = NOW): TokenBook {
  return { tokenId, bids: [{ price: bid, size: 5_000 }], asks: [{ price: ask, size: 5_000 }], ts };
}
function input(overrides: Partial<TwoSidedPlanInput> = {}): TwoSidedPlanInput {
  return {
    market: {
      marketKey: "polymarket:1", nativeMarketId: "1", conditionId: "condition-1", marketRef: "yes-1",
      eventId: "event-1", category: "Politics", yesTokenId: "yes-1", noTokenId: "no-1",
      active: true, closed: false, archived: false, acceptingOrders: true, orderbookEnabled: true,
      endsAt: NOW + 86_400_000, volume24hUsd: 10_000, tickSize: 0.01, minOrderSize: 5,
    },
    yesBook: book("yes-1"), noBook: book("no-1"), inventory: { yesQuantity: 0, noQuantity: 0 },
    now: NOW, baseOrderUsd: 30, maxOrderUsd: 40, maxMarketUsd: 120, minimumSecondsToEnd: 3_600,
    policy: { ...TwoSidedPolicySchema.parse({}), adaptive: AdaptivePolicySchema.parse({}) }, ...overrides,
  };
}
const forecast = (overrides: Partial<AdaptiveForecast> = {}): AdaptiveForecast => ({
  marketKey: "polymarket:1", qYes: 0.5, forecastAt: NOW, forecastStatus: "converging", ...overrides,
});
const movement = (overrides: Partial<AdaptiveMovement> = {}): AdaptiveMovement => ({
  observedAt: NOW, referenceAt: NOW - 60_000, referenceYesMid: 0.48, yesMid: 0.5, ...overrides,
});
const inventoryControl = (overrides: Partial<AdaptiveInventoryControl> = {}): AdaptiveInventoryControl => ({
  firstHeldAt: NOW - 3_600_000, initialEdgePp: 20, qBacked: true,
  maximumHoldSeconds: 86_400, minimumHoldEdgePp: 10, remainingEdgeExitPp: 5, capturedGapFraction: .75, ...overrides,
});

describe("opt-in Q-adaptive quote policy", () => {
  it.each([1, 6, 23])("holds Q-supported YES surplus after %s hours instead of offering it at the spread", (hours) => {
    const plan = planAdaptiveQuotes(input({ inventory: { yesQuantity: 20, noQuantity: 0 } }), forecast({ qYes: .7 }), undefined,
      inventoryControl({ firstHeldAt: NOW - hours * 3_600_000 }));
    expect(plan.context.adaptive).toMatchObject({ inventoryAction: "hold", inventoryReason: "adaptive-inventory-q-supported" });
    expect(plan.quotes.length).toBeGreaterThan(0);
    expect(plan.quotes.every((quote) => quote.lane === "bid")).toBe(true);
  });

  it("protects NO symmetrically and only permits selling the paired portion of the supported outcome", () => {
    const no = planAdaptiveQuotes(input({ inventory: { yesQuantity: 0, noQuantity: 20 } }), forecast({ qYes: .3 }), undefined, inventoryControl());
    expect(no.context.adaptive?.inventoryAction).toBe("hold");
    expect(no.quotes.every((quote) => quote.lane === "ask")).toBe(true);
    const paired = planAdaptiveQuotes(input({ inventory: { yesQuantity: 30, noQuantity: 10 } }), forecast({ qYes: .7 }), undefined, inventoryControl());
    expect(paired.quotes.find((quote) => quote.side === "SELL" && quote.outcome === "YES")?.size).toBeLessThanOrEqual(10);
  });

  it.each([
    [.54, "adaptive-inventory-converged"], [.4, "adaptive-inventory-q-invalidated"],
  ])("exits a held thesis on executable edge change to Q=%s", (qYes, reason) => {
    const plan = planAdaptiveQuotes(input({ inventory: { yesQuantity: 20, noQuantity: 0 } }), forecast({ qYes }), undefined, inventoryControl());
    expect(plan.context.adaptive).toMatchObject({ inventoryAction: "exit", inventoryReason: reason });
    expect(plan.quotes).toHaveLength(1);
    expect(plan.quotes[0]).toMatchObject({ side: "SELL", outcome: "YES" });
  });

  it("exits when 75% of the recorded entry gap closes, without fabricating an entry gap for imported holdings", () => {
    const source = input({ inventory: { yesQuantity: 20, noQuantity: 0 } });
    const plan = planAdaptiveQuotes(source, forecast({ qYes: .58 }), undefined, inventoryControl({ initialEdgePp: 40 }));
    expect(plan.context.adaptive?.inventoryReason).toBe("adaptive-inventory-gap-captured");
    const imported = planAdaptiveQuotes(source, forecast({ qYes: .58 }), undefined, inventoryControl({ initialEdgePp: undefined }));
    expect(imported.context.adaptive?.inventoryAction).toBe("hold");
  });

  it("starts reducing only unmatched shares at 24 hours even with a freshly renewed Q", () => {
    const plan = planAdaptiveQuotes(input({ inventory: { yesQuantity: 30, noQuantity: 10 } }), forecast({ qYes: .7 }), undefined,
      inventoryControl({ firstHeldAt: NOW - 86_400_000 }));
    expect(plan.context.adaptive?.inventoryReason).toBe("adaptive-inventory-hold-ceiling");
    expect(plan.quotes).toHaveLength(1);
    expect(plan.quotes[0]).toMatchObject({ side: "SELL", outcome: "YES", size: 20 });
    const complete = planAdaptiveQuotes(input({ inventory: { yesQuantity: 10, noQuantity: 10 } }), forecast(), undefined,
      inventoryControl({ firstHeldAt: NOW - 86_400_000 }));
    expect(complete.quotes.map((quote) => quote.side)).toEqual(["SELL", "SELL"]);
  });

  it("does not infer price convergence merely from the Q status label", () => {
    const plan = planAdaptiveQuotes(input({ inventory: { yesQuantity: 20, noQuantity: 0 } }), forecast({ qYes: .7, forecastStatus: "converged" }), undefined, inventoryControl());
    expect(plan.context.adaptive?.inventoryAction).toBe("hold");
  });

  it("does not hold through forecast warnings or explicit loss reduction", () => {
    const source = input({ inventory: { yesQuantity: 20, noQuantity: 0 } });
    for (const plan of [planAdaptiveQuotes(source, forecast({ qYes: .7, forecastStatus: "warning" }), undefined, inventoryControl()),
      planAdaptiveQuotes(source, forecast({ qYes: .7 }), undefined, inventoryControl({ forceReduceReason: "loss-stop" }))]) {
      expect(plan.context.adaptive?.inventoryAction).toBe("exit");
      expect(plan.quotes.every((quote) => quote.side === "SELL")).toBe(true);
    }
  });

  it("keeps ordinary small-gap inventory available for spread recycling", () => {
    const source = input({ inventory: { yesQuantity: 20, noQuantity: 0 } });
    const plan = planAdaptiveQuotes(source, forecast(), undefined, inventoryControl({ initialEdgePp: 2, qBacked: false }));
    expect(plan.context.adaptive?.inventoryAction).toBeUndefined();
    expect(plan.quotes.some((quote) => quote.side === "SELL" && quote.outcome === "YES")).toBe(true);
  });

  it("has strict, bounded discretionary defaults and rejects incoherent time intervals", () => {
    expect(AdaptivePolicySchema.parse({})).toMatchObject({ forecast_refresh_seconds: 900, forecast_full_weight_seconds: 86_400, forecast_max_age_seconds: 129_600, book_max_age_seconds: 5 });
    for (const value of [{ daily_api_budget: 1 }, { maximum_quote_buffer_ticks: 11 }, { minimum_size_multiplier: 0 },
      { book_max_age_seconds: NaN }, { forecast_full_weight_seconds: 150_000 }, { movement_window_seconds: 20 },
      { directional_minimum_gap_pp: 40 }]) expect(AdaptivePolicySchema.safeParse(value).success).toBe(false);
  });

  it("does not change the original strategy without the opt-in policy", () => {
    const source = input({ policy: TwoSidedPolicySchema.parse({}) });
    expect(planAdaptiveQuotes(source, undefined)).toEqual(planTwoSidedQuotes(source));
  });

  it("quotes a balanced pair near Q without pretending that the gap estimates profitability", () => {
    const source = input();
    const plan = planAdaptiveQuotes(source, forecast({ qYes: 0.54 }));
    expect(plan.context.adaptive).toMatchObject({ regime: "balanced", quoteBufferTicks: 0, sizeMultiplier: 1 });
    expect(plan.quotes.map(({ reason: _reason, ...quote }) => quote)).toEqual(planTwoSidedQuotes(source).quotes.map(({ reason: _reason, ...quote }) => quote));
  });

  it("widens and downsizes a large gap without moving the fair-value midpoint", () => {
    const source = input();
    const base = planTwoSidedQuotes(source);
    const plan = planAdaptiveQuotes(source, forecast({ qYes: 0.7 }));
    expect(plan.context.adaptive).toMatchObject({ regime: "defensive", quoteBufferTicks: 1 });
    expect(plan.context.adaptive?.sizeMultiplier).toBeCloseTo(0.9);
    expect(plan.quotes.map((quote) => quote.limitPrice)).toEqual([0.48, 0.48]);
    expect(plan.quotes[0]!.size).toBeCloseTo(base.quotes[0]!.size * 0.9);
    expect(plan.quotes[0]!.size).toBe(plan.quotes[1]!.size);
  });

  it("requires recent movement toward Q before selecting one favored economic lane", () => {
    const plan = planAdaptiveQuotes(input(), forecast({ qYes: 0.7 }), movement());
    expect(plan.context.adaptive).toMatchObject({ regime: "directional", favoredOutcome: "YES" });
    expect(plan.quotes).toHaveLength(1);
    expect(plan.quotes[0]).toMatchObject({ side: "BUY", outcome: "YES", lane: "bid", limitPrice: 0.49 });
    expect(plan.quotes[0]!.size).toBeCloseTo(planTwoSidedQuotes(input()).quotes[0]!.size);
    expect(planAdaptiveQuotes(input(), forecast({ qYes: 0.7 }), movement({ referenceYesMid: 0.52 })).context.adaptive?.regime).toBe("defensive");
  });

  it("is symmetric when Q and recent movement favor NO", () => {
    const yes = planAdaptiveQuotes(input(), forecast({ qYes: 0.7 }), movement());
    const no = planAdaptiveQuotes(input(), forecast({ qYes: 0.3 }), movement({ referenceYesMid: 0.52 }));
    expect(no.context.adaptive).toMatchObject({ regime: "directional", favoredOutcome: "NO" });
    expect(no.quotes).toHaveLength(1);
    expect(no.quotes[0]).toMatchObject({ side: "BUY", outcome: "NO", lane: "ask", limitPrice: yes.quotes[0]!.limitPrice });
    expect(no.quotes[0]!.size).toBeCloseTo(yes.quotes[0]!.size);
  });

  it.each([
    { observedAt: NOW - 6_000 }, { observedAt: NOW + 6_000 }, { referenceAt: NOW - 301_000 },
    { referenceAt: NOW - 10_000 }, { referenceYesMid: 0.495 }, { referenceYesMid: NaN },
    { yesMid: 0.6 }, { referenceAt: NOW + 10_000 },
  ])("rejects stale, too short, invalid or inconsistent movement: %j", (invalid) => {
    expect(planAdaptiveQuotes(input(), forecast({ qYes: 0.7 }), movement(invalid)).context.adaptive?.regime).toBe("defensive");
  });

  it("does not interpret a gap beyond the directional band as more alpha", () => {
    const plan = planAdaptiveQuotes(input(), forecast({ qYes: 0.95 }), movement());
    expect(plan.context.adaptive).toMatchObject({ regime: "defensive", quoteBufferTicks: 1 });
    expect(plan.context.adaptive?.sizeMultiplier).toBeCloseTo(0.775);
    expect(plan.quotes).toHaveLength(2);
  });

  it("makes caution defensive without overriding the configured minimum size multiplier", () => {
    const plan = planAdaptiveQuotes(input(), forecast({ qYes: 0.7, forecastStatus: "caution" }), movement());
    expect(plan.context.adaptive).toMatchObject({ regime: "defensive", sizeMultiplier: 0.75 });
    expect(plan.quotes).toHaveLength(2);
  });

  it("keeps a daily forecast usable at 24h, then fades it without directional entries through 36h", () => {
    const full = planAdaptiveQuotes(input(), forecast({ qYes: 0.7, forecastAt: NOW - 86_400_000 }), movement());
    expect(full.context.adaptive?.regime).toBe("directional");
    const fading = planAdaptiveQuotes(input(), forecast({ qYes: 0.7, forecastAt: NOW - 108_000_000 }), movement());
    expect(fading.context.adaptive).toMatchObject({ regime: "defensive", forecastAgeSeconds: 108_000, sizeMultiplier: 0.75 });
    expect(fading.quotes).toHaveLength(2);
    expect(planAdaptiveQuotes(input(), forecast({ forecastAt: NOW - 129_601_000 })).quotes).toEqual([]);
  });

  it.each([
    undefined, forecast({ qYes: NaN }), forecast({ qYes: Infinity }), forecast({ qYes: -0.1 }), forecast({ qYes: 1.1 }),
    forecast({ forecastAt: NaN }), forecast({ forecastAt: NOW + 6_000 }), forecast({ forecastAt: NOW - 130_000_000 }),
    forecast({ marketKey: "polymarket:other" }), forecast({ forecastStatus: "warning" }),
    forecast({ forecastStatus: "invented" }), forecast({ drawdownRiskElevated: true }),
  ])("fails closed on invalid Q while retaining a fresh net-reducing SELL: %j", (invalid) => {
    expect(planAdaptiveQuotes(input(), invalid).quotes).toEqual([]);
    const held = planAdaptiveQuotes(input({ inventory: { yesQuantity: 40, noQuantity: 10 } }), invalid);
    expect(held.context.adaptive?.regime).toBe("reduce-only");
    expect(held.eligible).toBe(false);
    expect(held.quotes).toHaveLength(1);
    expect(held.quotes[0]).toMatchObject({ side: "SELL", outcome: "YES", size: 30 });
  });

  it("never calls breaking a neutral pair a safe reduction", () => {
    const plan = planAdaptiveQuotes(input({ inventory: { yesQuantity: 40, noQuantity: 40 } }), undefined);
    expect(plan.quotes).toEqual([]);
    const inverse = planAdaptiveQuotes(input({ inventory: { yesQuantity: 10, noQuantity: 40 } }), undefined);
    expect(inverse.quotes).toHaveLength(1);
    expect(inverse.quotes[0]).toMatchObject({ side: "SELL", outcome: "NO", size: 30 });
  });

  it("holds favored inventory during confirmed direction but restores its exit when forced to reduce", () => {
    const held = input({ inventory: { yesQuantity: 40, noQuantity: 0 } });
    const supported = planAdaptiveQuotes(held, forecast({ qYes: 0.7 }), movement());
    expect(supported.quotes.every((quote) => quote.lane === "bid")).toBe(true);
    expect(supported.quotes.some((quote) => quote.side === "SELL" && quote.outcome === "YES")).toBe(false);
    expect(planAdaptiveQuotes(held, undefined).quotes[0]).toMatchObject({ side: "SELL", outcome: "YES", size: 40 });
  });

  it("routes favored exposure through opposite inventory while respecting the original unpaired cap", () => {
    const source = input({ inventory: { yesQuantity: 200, noQuantity: 100 } });
    const plan = planAdaptiveQuotes(source, forecast({ qYes: 0.7 }), movement());
    expect(plan.quotes).toHaveLength(1);
    expect(plan.quotes[0]).toMatchObject({ side: "SELL", outcome: "NO", lane: "bid" });
    expect((100 + plan.quotes[0]!.size) * 0.5).toBeLessThanOrEqual(60 + EPSILON);
  });

  it("requires two fresh books for exposure but not a fresh other-outcome book for a reduction", () => {
    const source = input({ yesBook: book("yes-1", 0.49, 0.51, NOW - 6_000) });
    expect(planAdaptiveQuotes(source, forecast()).quotes).toEqual([]);
    const held = planAdaptiveQuotes({ ...source, inventory: { yesQuantity: 0, noQuantity: 40 } }, forecast());
    expect(held.quotes).toHaveLength(1);
    expect(held.quotes[0]).toMatchObject({ side: "SELL", outcome: "NO" });
    expect(planAdaptiveQuotes({ ...source, inventory: { yesQuantity: 40, noQuantity: 0 } }, forecast()).quotes).toEqual([]);
  });

  it("rejects complement identity and excessive complement discrepancy for new exposure", () => {
    for (const noBook of [book("wrong-token"), book("no-1", 0.59, 0.61), book("no-1", 0.49, 0.51, NOW + 6_000)]) {
      expect(planAdaptiveQuotes(input({ noBook }), forecast()).quotes).toEqual([]);
    }
  });

  it("retains fresh reducing exits through the existing volume, end and depth gates", () => {
    const source = input({ inventory: { yesQuantity: 40, noQuantity: 0 } });
    source.market = { ...source.market, volume24hUsd: 0, endsAt: NOW + 1_000 };
    source.noBook = { ...source.noBook, bids: [] };
    expect(planAdaptiveQuotes(source, undefined).quotes[0]).toMatchObject({ side: "SELL", outcome: "YES", size: 40 });
  });

  it("does not retreat or downsize a genuinely net-reducing SELL when the gap is defensive", () => {
    const source = input({ inventory: { yesQuantity: 40, noQuantity: 0 } });
    const baseline = planTwoSidedQuotes(source).quotes.find((quote) => quote.side === "SELL")!;
    const adaptive = planAdaptiveQuotes(source, forecast({ qYes: 0.7 })).quotes.find((quote) => quote.side === "SELL")!;
    expect(adaptive.limitPrice).toBe(baseline.limitPrice);
    expect(adaptive.size).toBe(baseline.size);
  });

  it("cannot silently disable an invalid adaptive policy or accept a non-finite clock", () => {
    const malformed = input();
    malformed.policy.adaptive = { ...malformed.policy.adaptive!, book_max_age_seconds: NaN };
    expect(planAdaptiveQuotes(malformed, forecast()).quotes).toEqual([]);
    expect(planAdaptiveQuotes(input({ now: NaN }), forecast()).quotes).toEqual([]);
    expect(planAdaptiveQuotes(input({ inventory: { yesQuantity: NaN, noQuantity: 0 } }), forecast()).quotes).toEqual([]);
  });

  it("never rounds a scaled below-minimum lot upward", () => {
    const source = input({ baseOrderUsd: 2.5, maxOrderUsd: 2.5 });
    expect(planTwoSidedQuotes(source).quotes).toHaveLength(2);
    expect(planAdaptiveQuotes(source, forecast({ qYes: 0.8 })).quotes).toEqual([]);
  });

  it("is tick-safe, passive, and never expands a baseline quote size or order notional", () => {
    for (const tickSize of [0.01, 0.001]) for (const qYes of [0, 0.1, 0.35, 0.5, 0.65, 0.9, 1]) {
      const source = input({ inventory: { yesQuantity: 40, noQuantity: 30 } });
      source.market = { ...source.market, tickSize };
      const base = planTwoSidedQuotes(source);
      const plan = planAdaptiveQuotes(source, forecast({ qYes }));
      for (const quote of plan.quotes) {
        const original = base.quotes.find((other) => other.lane === quote.lane)!;
        expect(quote.size).toBeLessThanOrEqual(original.size + EPSILON);
        expect(quote.size * quote.limitPrice).toBeLessThanOrEqual(30 + EPSILON);
        expect(quote.limitPrice / tickSize).toBeCloseTo(Math.round(quote.limitPrice / tickSize));
        expect(quote.limitPrice).toBeGreaterThan(0.49);
      }
      if (plan.quotes.length === 2) expect(plan.quotes.reduce((sum, quote) => sum + quote.limitPrice, 0)).toBeGreaterThanOrEqual(1 + tickSize - EPSILON);
    }
  });

  it("does not mutate caller-owned inputs, forecasts or movement", () => {
    const source = input();
    const q = forecast({ qYes: 0.7 });
    const move = movement();
    const before = structuredClone({ source, q, move });
    planAdaptiveQuotes(source, q, move);
    expect({ source, q, move }).toEqual(before);
  });
});

const EPSILON = 1e-9;

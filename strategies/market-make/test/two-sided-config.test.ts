// strategies/market-make/test/two-sided-config.test.ts
import { describe, expect, it } from "vitest";
import {
  MARKET_MAKE_PRESET,
  MarketMakeConfigSchema,
  createMarketMakeConfig,
  createTwoSidedMarketMakeConfig,
  marketMakeConfigForBankroll,
  marketMakeConfigHash,
} from "../src/index.js";

describe("two-sided config identity and compatibility", () => {
  it("creates a separate coherent execution identity with operational policy defaults", () => {
    const config = createTwoSidedMarketMakeConfig();
    expect(config).toMatchObject({
      schema_version: "polymarket-two-sided-mm/1",
      strategy_id: "two-sided-spread-v1",
      mode: "two_sided_spread_and_inventory",
      decision_probability: "executable venue book with inventory skew",
      two_sided: { target_markets: 3, minimum_depth_usd: 300, minimum_token_price: 0.05, maximum_unpaired_notional_usd: 60 },
    });
    expect(MarketMakeConfigSchema.safeParse(config).success).toBe(true);
  });

  it.each(["schema_version", "strategy_id", "mode", "decision_probability"] as const)("rejects mixed %s identity in either direction", (field) => {
    const legacy = createMarketMakeConfig();
    const twoSided = createTwoSidedMarketMakeConfig();
    expect(MarketMakeConfigSchema.safeParse({ ...twoSided, [field]: legacy[field] }).success).toBe(false);
    expect(MarketMakeConfigSchema.safeParse({ ...legacy, [field]: twoSided[field] }).success).toBe(false);
  });

  it("rejects legacy identity with a two-sided policy or two-sided identity without policy", () => {
    const legacy = createMarketMakeConfig();
    const twoSided = createTwoSidedMarketMakeConfig();
    expect(MarketMakeConfigSchema.safeParse({ ...legacy, two_sided: {} }).success).toBe(false);
    const { two_sided: _policy, ...missingPolicy } = twoSided;
    expect(MarketMakeConfigSchema.safeParse(missingPolicy).success).toBe(false);
  });

  it("requires enough active-market and order slots for every target pair", () => {
    expect(() => createTwoSidedMarketMakeConfig({ capital: { max_active_markets: 2 } })).toThrow(/target markets/);
    expect(() => createTwoSidedMarketMakeConfig({ capital: { max_live_orders: 5 } })).toThrow(/two order slots/);
    expect(createTwoSidedMarketMakeConfig({ capital: { max_active_markets: 3, max_live_orders: 6 } }).two_sided!.target_markets).toBe(3);
  });

  it("preserves the resolved legacy preset and its identity hash without adding an optional field", () => {
    const legacy = createMarketMakeConfig();
    expect(legacy).toEqual(MARKET_MAKE_PRESET);
    expect(Object.hasOwn(legacy, "two_sided")).toBe(false);
    expect(marketMakeConfigHash(legacy)).toBe("b203d8b339d0db509875b1678f0a23243fb1ad5193ffeb0f018318ee29e4a1f6");
    expect(Object.hasOwn(marketMakeConfigForBankroll(legacy, 1_000), "two_sided")).toBe(false);
  });

  it("scales inventory dollars but retains venue liquidity floors, prices, timing, and counts", () => {
    const original = createTwoSidedMarketMakeConfig({
      capital: { base_order_notional_usd: 30, max_order_notional_usd: 40, hard_market_cost_usd: 120 },
      two_sided: { maximum_unpaired_notional_usd: 75, minimum_depth_usd: 450, minimum_volume_24h_usd: 1_500 },
    });
    const scaled = marketMakeConfigForBankroll(original, 1_000);
    expect(scaled.capital).toMatchObject({ base_order_notional_usd: 60, max_order_notional_usd: 80, hard_market_cost_usd: 240 });
    expect(scaled.two_sided).toEqual({ ...original.two_sided, maximum_unpaired_notional_usd: 150 });
    expect(scaled.cassie_overrides.liquidity).toEqual(original.cassie_overrides.liquidity);
    expect(scaled.quote_model).toEqual(original.quote_model);
    expect(original.two_sided!.maximum_unpaired_notional_usd).toBe(75);
  });

  it("keeps operator overrides and unrelated compatibility fields when selecting two-sided execution", () => {
    const config = createTwoSidedMarketMakeConfig({
      capital: { base_order_notional_usd: 30, max_order_notional_usd: 40, hard_market_cost_usd: 120 },
      reconciliation: { rest_reconcile_seconds: 60 },
      two_sided: { minimum_rest_seconds: 45, reprice_ticks: 2 },
    });
    expect(config.capital.base_order_notional_usd).toBe(30);
    expect(config.reconciliation.rest_reconcile_seconds).toBe(60);
    expect(config.two_sided).toMatchObject({ minimum_rest_seconds: 45, reprice_ticks: 2, target_markets: 3 });
    expect(config.inventory).toEqual(MARKET_MAKE_PRESET.inventory);
    expect(config.quotient_feed).toEqual(MARKET_MAKE_PRESET.quotient_feed);
    expect(config.loss_limits).toEqual(MARKET_MAKE_PRESET.loss_limits);
    expect(marketMakeConfigHash(config)).not.toBe(marketMakeConfigHash(MARKET_MAKE_PRESET));
  });
});

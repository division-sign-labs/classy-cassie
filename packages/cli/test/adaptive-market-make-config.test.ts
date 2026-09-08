// packages/cli/test/adaptive-market-make-config.test.ts
import { describe, expect, it } from "vitest";
import {
  MARKET_MAKE_PRESET, createAdaptiveMarketMakeConfig, createTwoSidedMarketMakeConfig,
  marketMakeConfigHash,
} from "@quotient-forecasting/strategy-market-make";
import { resolveMarketMakeConfig } from "../src/commands/market-make.js";

describe("opt-in adaptive market-maker CLI configuration", () => {
  it("explicitly selects the adaptive factory without changing unrelated capital limits", () => {
    const before = structuredClone(MARKET_MAKE_PRESET);
    const result = resolveMarketMakeConfig(MARKET_MAKE_PRESET, { adaptive: true, baseOrderUsd: "30", maxOrderUsd: "30" });
    expect(result).toMatchObject({
      schema_version: "polymarket-adaptive-mm/1",
      strategy_id: "quotient-adaptive-liquidity-v1",
      mode: "forecast_conditioned_liquidity",
      capital: { base_order_notional_usd: 30, max_order_notional_usd: 30 },
    });
    expect(result.two_sided?.adaptive).toBeDefined();
    expect(result.two_sided?.maximum_inventory_age_seconds).toBe(86_400);
    expect(result.exit_policy.forecast_refresh_can_extend_once).toBe(false);
    expect(result.capital.max_total_inventory_and_pending_entry_cost_usd).toBe(before.capital.max_total_inventory_and_pending_entry_cost_usd);
    expect(result.capital.hard_market_cost_usd).toBe(before.capital.hard_market_cost_usd);
    expect(result.portfolio_risk).toEqual(before.portfolio_risk);
    expect(MARKET_MAKE_PRESET).toEqual(before);
  });

  it("rejects simultaneous adaptive and ordinary two-sided selectors", () => {
    expect(() => resolveMarketMakeConfig(MARKET_MAKE_PRESET, { adaptive: true, twoSided: true })).toThrow(/adaptive.*two-sided|two-sided.*adaptive/i);
  });

  it("keeps existing adaptive identity when tuning ordinary liquidity and capital flags", () => {
    const source = createAdaptiveMarketMakeConfig();
    const result = resolveMarketMakeConfig(source, { minVolumeUsd: "2500", minDepth2cUsd: "300", maxBookSpreadPp: "4", baseOrderUsd: "18", maxOrderUsd: "25" });
    expect(result.strategy_id).toBe(source.strategy_id);
    expect(result.schema_version).toBe(source.schema_version);
    expect(result.two_sided?.adaptive).toEqual(source.two_sided?.adaptive);
    expect(result.two_sided).toMatchObject({ minimum_volume_24h_usd: 2500, minimum_depth_usd: 300, maximum_spread_pp: 4 });
    expect(result.capital).toMatchObject({ base_order_notional_usd: 18, max_order_notional_usd: 25 });
  });

  it("does not add Q requirements to ordinary two-sided or legacy directional configurations", () => {
    const ordinary = createTwoSidedMarketMakeConfig();
    expect(resolveMarketMakeConfig(ordinary).two_sided?.adaptive).toBeUndefined();
    expect(resolveMarketMakeConfig(ordinary).strategy_id).toBe("two-sided-spread-v1");
    expect(resolveMarketMakeConfig(MARKET_MAKE_PRESET).two_sided).toBeUndefined();
  });

  it("makes the selected policy part of configuration identity", () => {
    const directional = resolveMarketMakeConfig(MARKET_MAKE_PRESET);
    const ordinary = resolveMarketMakeConfig(directional, { twoSided: true });
    const adaptive = resolveMarketMakeConfig(ordinary, { adaptive: true });
    expect(new Set([directional, ordinary, adaptive].map(marketMakeConfigHash)).size).toBe(3);
    const restored = resolveMarketMakeConfig(adaptive, { twoSided: true });
    expect(restored.strategy_id).toBe("two-sided-spread-v1");
    expect(restored.two_sided?.adaptive).toBeUndefined();
    expect(restored.capital).toEqual(adaptive.capital);
  });

  it.each(["adaptive", "two-sided"] as const)("routes the hold-age override to the active %s inventory policy", (mode) => {
    const source = mode === "adaptive" ? createAdaptiveMarketMakeConfig() : createTwoSidedMarketMakeConfig();
    const before = structuredClone(source);
    const result = resolveMarketMakeConfig(source, { maxHoldHours: "2.5" });
    expect(result.two_sided?.maximum_inventory_age_seconds).toBe(9_000);
    expect(result.exit_policy.default_hard_hold_seconds).toBe(9_000);
    expect(result.strategy_id).toBe(source.strategy_id);
    expect(result.two_sided?.adaptive).toEqual(source.two_sided?.adaptive);
    expect(source).toEqual(before);
  });

  it.each(["maxForecastAgeHours", "staleForecastExitHours"] as const)("routes %s to adaptive expiry and clamps the full-weight interval", (flag) => {
    const source = createAdaptiveMarketMakeConfig();
    const before = structuredClone(source);
    const result = resolveMarketMakeConfig(source, { [flag]: "12" });
    expect(result.two_sided?.adaptive).toMatchObject({
      forecast_max_age_seconds: 43_200,
      forecast_full_weight_seconds: 43_200,
      forecast_refresh_seconds: source.two_sided!.adaptive!.forecast_refresh_seconds,
    });
    expect(source).toEqual(before);
  });

  it.each(["maxForecastAgeHours", "staleForecastExitHours"] as const)("does not extend full Q weight when %s extends only expiry", (flag) => {
    const source = createAdaptiveMarketMakeConfig();
    const result = resolveMarketMakeConfig(source, { [flag]: "48" });
    expect(result.two_sided?.adaptive?.forecast_max_age_seconds).toBe(172_800);
    expect(result.two_sided?.adaptive?.forecast_full_weight_seconds).toBe(source.two_sided!.adaptive!.forecast_full_weight_seconds);
  });

  it("accepts numerically matching adaptive forecast-age aliases", () => {
    const result = resolveMarketMakeConfig(createAdaptiveMarketMakeConfig(), { maxForecastAgeHours: "12", staleForecastExitHours: "12.0" });
    expect(result.two_sided?.adaptive).toMatchObject({ forecast_max_age_seconds: 43_200, forecast_full_weight_seconds: 43_200 });
  });

  it("rejects conflicting forecast-age aliases instead of silently choosing one", () => {
    const source = createAdaptiveMarketMakeConfig();
    const before = structuredClone(source);
    expect(() => resolveMarketMakeConfig(source, { maxForecastAgeHours: "12", staleForecastExitHours: "36" })).toThrow(/one forecast-expiry limit.*matching/i);
    expect(source).toEqual(before);
  });

  it("routes maximum edge and book age to the adaptive execution policy", () => {
    const source = createAdaptiveMarketMakeConfig();
    const before = structuredClone(source);
    const result = resolveMarketMakeConfig(source, { maxEdgePp: "25", marketDataStaleSeconds: "3" });
    expect(result.two_sided?.adaptive).toMatchObject({ directional_maximum_gap_pp: 25, book_max_age_seconds: 3 });
    expect(result.market_data.market_data_stale_seconds).toBe(3);
    expect(result.two_sided?.adaptive?.directional_minimum_gap_pp).toBe(source.two_sided!.adaptive!.directional_minimum_gap_pp);
    expect(result.two_sided?.adaptive?.forecast_refresh_seconds).toBe(source.two_sided!.adaptive!.forecast_refresh_seconds);
    expect(source).toEqual(before);
  });

  it("validates the overridden adaptive maximum gap against its minimum", () => {
    expect(() => resolveMarketMakeConfig(createAdaptiveMarketMakeConfig(), { maxEdgePp: "5" })).toThrow(/minimum directional gap/);
  });

  it("does not opt ordinary two-sided quoting into Q while applying the same flags", () => {
    const result = resolveMarketMakeConfig(createTwoSidedMarketMakeConfig(), {
      maxForecastAgeHours: "12", staleForecastExitHours: "36", maxEdgePp: "25", marketDataStaleSeconds: "3", maxHoldHours: "2",
    });
    expect(result.strategy_id).toBe("two-sided-spread-v1");
    expect(result.two_sided?.adaptive).toBeUndefined();
    expect(result.two_sided?.maximum_inventory_age_seconds).toBe(7_200);
  });
});

// packages/cli/test/two-sided-config.test.ts

import { describe, expect, it } from "vitest";
import { MARKET_MAKE_PRESET, createTwoSidedMarketMakeConfig } from "@quotient-forecasting/strategy-market-make";
import { resolveMarketMakeConfig } from "../src/commands/market-make.js";

describe("two-sided CLI configuration", () => {
  it("explicitly selects a separate spread policy and preserves capital limits", () => {
    const cfg = resolveMarketMakeConfig(MARKET_MAKE_PRESET, { twoSided: true, baseOrderUsd: "30", maxOrderUsd: "30" });
    expect(cfg.strategy_id).toBe("two-sided-spread-v1");
    expect(cfg.two_sided?.target_markets).toBe(3);
    expect(cfg.capital.base_order_notional_usd).toBe(30);
    expect(cfg.capital.max_order_notional_usd).toBe(30);
    expect(cfg.capital.max_total_inventory_and_pending_entry_cost_usd).toBe(MARKET_MAKE_PRESET.capital.max_total_inventory_and_pending_entry_cost_usd);
  });

  it("routes liquidity flags to the active two-sided policy", () => {
    const cfg = resolveMarketMakeConfig(createTwoSidedMarketMakeConfig(), {
      minVolumeUsd: "2500", minDepth2cUsd: "300", maxBookSpreadPp: "4",
    });
    expect(cfg.two_sided).toMatchObject({ minimum_volume_24h_usd: 2500, minimum_depth_usd: 300, maximum_spread_pp: 4 });
  });

  it("scales unmatched capital when selecting a fixed bankroll", () => {
    const cfg = resolveMarketMakeConfig(createTwoSidedMarketMakeConfig(), { bankrollUsd: "1000" });
    expect(cfg.two_sided?.maximum_unpaired_notional_usd).toBe(120);
    expect(cfg.two_sided?.minimum_depth_usd).toBe(300);
  });

  it("does not silently convert an existing directional configuration", () => {
    expect(resolveMarketMakeConfig(MARKET_MAKE_PRESET).two_sided).toBeUndefined();
  });
});

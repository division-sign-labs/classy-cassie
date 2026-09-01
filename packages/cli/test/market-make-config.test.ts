// packages/cli/test/market-make-config.test.ts

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBotConfig } from "@quotient-forecasting/cassie-core";
import {
  MARKET_MAKE_PRESET,
  type MarketMakeConfig,
} from "@quotient-forecasting/strategy-market-make";
import {
  requireMarketMakeBot,
  resolveMarketMakeConfig,
} from "../src/commands/market-make.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempFile(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "cassie-market-make-config-"));
  roots.push(root);
  const path = join(root, "strategy.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("market-make configuration", () => {
  it("uses a complete config file as the base, then applies unit-suffixed CLI overrides", () => {
    const fromFile = structuredClone(MARKET_MAKE_PRESET) as MarketMakeConfig;
    fromFile.capital.base_order_notional_usd = 11;
    fromFile.exit_policy.remaining_live_q_edge_exit_pp = 4;

    const resolved = resolveMarketMakeConfig(MARKET_MAKE_PRESET, {
      config: tempFile(fromFile),
      bankrollUsd: "600",
      baseOrderUsd: "14.50",
      targetNoUsd: "48",
      minNoEdgePp: "12",
      yesMinEdgePp: "22",
      convergenceEdgePp: "6",
      gapCapturePct: "80",
      reviewHours: "8",
      maxHoldHours: "26",
      absoluteMaxHoldHours: "38",
      renewalNoEdgePp: "11",
      yesRenewalEdgePp: "23",
      minDepth1cUsd: "1200",
      minDepth2cUsd: "3000",
      maxOrderDepth1cPct: "2.5",
      maxOrderDepth2cPct: "0.9",
      maxMarketDepth1cPct: "5",
      maxMarketDepth2cPct: "1.8",
    });

    expect(resolved.capital.initial_bankroll_usd).toBe(600);
    expect(resolved.capital.sizing_bankroll_usd).toBe(600);
    expect(resolved.cassie_overrides.bankroll).toEqual({
      mode: "fixed",
      maximum_sizing_bankroll_usd: null,
    });
    expect(resolved.capital.base_order_notional_usd).toBe(14.5);
    expect(resolved.direction_policy.NO.minimum_edge_pp).toBe(12);
    expect(resolved.direction_policy.NO.target_market_cost_usd).toBe(48);
    expect(resolved.direction_policy.YES.minimum_edge_pp).toBe(22);
    expect(resolved.eligibility.q_market_edge_min_pp).toBe(12);
    expect(resolved.exit_policy.remaining_live_q_edge_exit_pp).toBe(6);
    expect(resolved.exit_policy.captured_initial_gap_fraction_exit).toBe(0.8);
    expect(resolved.exit_policy.soft_review_after_seconds).toBe(8 * 3600);
    expect(resolved.exit_policy.default_hard_hold_seconds).toBe(26 * 3600);
    expect(resolved.exit_policy.absolute_max_hold_seconds).toBe(38 * 3600);
    expect(resolved.exit_policy.maximum_extension_seconds).toBe(12 * 3600);
    expect(resolved.cassie_overrides.renewal_min_edge_pp).toEqual({ NO: 11, YES: 23 });
    expect(resolved.cassie_overrides.liquidity.minimum_exit_bid_depth_1c_usd).toBe(1200);
    expect(resolved.cassie_overrides.liquidity.minimum_exit_bid_depth_2c_usd).toBe(3000);
    expect(resolved.cassie_overrides.liquidity.max_order_fraction_of_exit_bid_depth_1c).toBe(0.025);
    expect(resolved.cassie_overrides.liquidity.max_order_fraction_of_exit_bid_depth_2c).toBeCloseTo(0.009);
    expect(resolved.cassie_overrides.liquidity.max_market_fraction_of_exit_bid_depth_1c).toBe(0.05);
    expect(resolved.cassie_overrides.liquidity.max_market_fraction_of_exit_bid_depth_2c).toBeCloseTo(0.018);
  });

  it("scales a $10k portfolio coherently while retaining absolute depth sanity floors", () => {
    const resolved = resolveMarketMakeConfig(MARKET_MAKE_PRESET, { bankrollUsd: "10000" });
    expect(resolved.capital.max_total_inventory_and_pending_entry_cost_usd).toBe(7_000);
    expect(resolved.capital.base_order_notional_usd).toBe(250);
    expect(resolved.capital.max_order_notional_usd).toBe(400);
    expect(resolved.direction_policy.NO.target_market_cost_usd).toBe(800);
    expect(resolved.direction_policy.YES.target_market_cost_usd).toBe(400);
    expect(resolved.portfolio_risk.max_event_cost_usd).toBe(1_200);
    expect(resolved.loss_limits.max_strategy_drawdown_usd).toBe(800);
    expect(resolved.cassie_overrides.liquidity.minimum_exit_bid_depth_1c_usd).toBe(1_000);
    expect(resolved.cassie_overrides.liquidity.minimum_exit_bid_depth_2c_usd).toBe(2_500);
  });

  it("uses funded capital automatically by default and accepts an optional ceiling", () => {
    const automatic = resolveMarketMakeConfig(MARKET_MAKE_PRESET);
    expect(automatic.cassie_overrides.bankroll).toEqual({
      mode: "live",
      maximum_sizing_bankroll_usd: null,
    });
    expect(automatic.capital.sizing_bankroll_usd).toBe(500);

    const capped = resolveMarketMakeConfig(automatic, { bankrollCeilingUsd: "10000" });
    expect(capped.cassie_overrides.bankroll).toEqual({
      mode: "live",
      maximum_sizing_bankroll_usd: 10_000,
    });
    // Live sizing scales these reference limits at runtime; configuring a
    // ceiling must not rewrite their policy ratios.
    expect(capped.capital.sizing_bankroll_usd).toBe(500);
    expect(capped.capital.max_total_inventory_and_pending_entry_cost_usd).toBe(350);
    expect(capped.capital.base_order_notional_usd).toBe(12.5);
  });

  it("can return a legacy fixed config to uncapped live-funded sizing", () => {
    const fixed = resolveMarketMakeConfig(MARKET_MAKE_PRESET, { bankrollUsd: "750" });
    const automatic = resolveMarketMakeConfig(fixed, { liveBankroll: true });
    expect(automatic.cassie_overrides.bankroll).toEqual({
      mode: "live",
      maximum_sizing_bankroll_usd: null,
    });
    expect(automatic.capital.sizing_bankroll_usd).toBe(750);

    const cleared = resolveMarketMakeConfig(automatic, { bankrollCeilingUsd: "unlimited" });
    expect(cleared.cassie_overrides.bankroll.maximum_sizing_bankroll_usd).toBeNull();
  });

  it("rejects mixing fixed and live bankroll controls", () => {
    expect(() => resolveMarketMakeConfig(MARKET_MAKE_PRESET, {
      bankrollUsd: "500",
      bankrollCeilingUsd: "1000",
    })).toThrow(/cannot be combined/);
    expect(() => resolveMarketMakeConfig(MARKET_MAKE_PRESET, {
      bankrollUsd: "500",
      liveBankroll: true,
    })).toThrow(/cannot be combined/);
    expect(() => resolveMarketMakeConfig(MARKET_MAKE_PRESET, {
      bankrollCeilingUsd: "1000",
      liveBankroll: true,
    })).toThrow(/cannot be combined/);
    expect(() => resolveMarketMakeConfig(MARKET_MAKE_PRESET, {
      bankrollCeilingUsd: "zero",
    })).toThrow(/--bankroll-ceiling-usd must be a positive number/);
  });

  it("requires --config to be complete and rejects unknown keys", () => {
    expect(() =>
      resolveMarketMakeConfig(MARKET_MAKE_PRESET, {
        config: tempFile({ schema_version: "q-directed-polymarket-mm/1" }),
      }),
    ).toThrow();

    expect(() =>
      resolveMarketMakeConfig(MARKET_MAKE_PRESET, {
        config: tempFile({ ...MARKET_MAKE_PRESET, surprise: true }),
      }),
    ).toThrow(/unrecognized|surprise/i);
  });

  it("rejects malformed units and invalid cross-field bounds before saving", () => {
    expect(() => resolveMarketMakeConfig(MARKET_MAKE_PRESET, { baseOrderUsd: "12usd" })).toThrow(
      /--base-order-usd must be a positive number/,
    );
    expect(() => resolveMarketMakeConfig(MARKET_MAKE_PRESET, { gapCapturePct: "101" })).toThrow(
      /at most 100 percent/,
    );
    expect(() => resolveMarketMakeConfig(MARKET_MAKE_PRESET, { maxOrderDepth1cPct: "101" })).toThrow(
      /at most 100 percent/,
    );
    expect(() => resolveMarketMakeConfig(MARKET_MAKE_PRESET, { maxMarkets: "2.5" })).toThrow(
      /whole number/,
    );
    expect(() => resolveMarketMakeConfig(MARKET_MAKE_PRESET, { minDepth1cUsd: "3000" })).toThrow(
      /1c minimum depth cannot exceed 2c minimum depth/,
    );
    expect(() => resolveMarketMakeConfig(MARKET_MAKE_PRESET, { maxBookSpreadPp: "31" })).toThrow(
      /operational spread exceeds hard sanity spread/,
    );
    expect(() =>
      resolveMarketMakeConfig(MARKET_MAKE_PRESET, {
        maxHoldHours: "36",
        absoluteMaxHoldHours: "24",
      }),
    ).toThrow(/absolute-max-hold-hours/);
  });
});

describe("market-make bot guard", () => {
  it("rejects a Polymarket bot running another strategy", () => {
    const bot = parseBotConfig({ id: "signals-bot", venue: "polymarket", strategy: { id: "signals", config: {} } });
    expect(() => requireMarketMakeBot(bot)).toThrow(/runs the "signals" strategy/);
  });

  it("rejects market-make on any non-Polymarket venue", () => {
    expect(() =>
      parseBotConfig({ id: "kalshi-mm", venue: "kalshi", strategy: { id: "market-make", config: MARKET_MAKE_PRESET } }),
    ).toThrow(/supported only on Polymarket/);
  });
});

// packages/core/test/passive-capacity.test.ts
import { describe, expect, it } from "vitest";
import {
  checkPassiveEntryCapacity,
  executableLiquidationValue,
  measureBidLiquidity,
  type PassiveLiquidityConfig,
} from "../src/risk/passive.js";
import type { OrderBook } from "../src/types.js";

const config: PassiveLiquidityConfig = {
  minDepthWithin1cUsd: 1_000,
  minDepthWithin2cUsd: 2_500,
  maxOrderFractionWithin1c: 0.02,
  maxOrderFractionWithin2c: 0.008,
  maxMarketFractionWithin1c: 0.04,
  maxMarketFractionWithin2c: 0.016,
  maxBestLevelFraction: 0.25,
  maxOrderNotionalUsd: 20,
  hardMarketCostUsd: 50,
  minOrderNotionalUsd: 1,
  maxBookSpreadPp: 4,
  hardMaxBookSpreadPp: 30,
};

function book(depth1 = 1_000, depth2 = 2_500): OrderBook {
  // At 50c, quantities are twice their USD depth. Keep the one-cent level
  // exact and put the balance exactly two cents behind the touch.
  return {
    marketRef: "yes",
    bids: [
      { price: 0.5, size: depth1 / 0.5 },
      { price: 0.48, size: (depth2 - depth1) / 0.48 },
    ],
    asks: [{ price: 0.52, size: 10_000 }],
    ts: 1,
  };
}

describe("passive market-making liquidity", () => {
  it("measures executable bid depth at one- and two-cent bands", () => {
    const measured = measureBidLiquidity(book());
    expect(measured).toMatchObject({
      depthWithin1cUsd: 1_000,
      depthWithin2cUsd: 2_500,
    });
    expect(measured.spreadPp).toBeCloseTo(2);
  });

  it("maps the default minimum depth to a $20 order and $40 market cap", () => {
    const result = checkPassiveEntryCapacity({
      book: book(),
      requestedNotionalUsd: 100,
      currentMarketCostUsd: 0,
      remainingTargetUsd: 100,
      config: { ...config, maxOrderNotionalUsd: 1_000, hardMarketCostUsd: 1_000 },
    });
    expect(result.ok).toBe(true);
    expect(result.orderLiquidityCapUsd).toBeCloseTo(20);
    expect(result.marketLiquidityCapUsd).toBeCloseTo(40);
    expect(result.notionalUsd).toBeCloseTo(20);
  });

  it("requires $20k/$50k depth before permitting a $400 order", () => {
    const scaled = checkPassiveEntryCapacity({
      book: book(20_000, 50_000),
      requestedNotionalUsd: 400,
      currentMarketCostUsd: 0,
      remainingTargetUsd: 1_000,
      config: { ...config, maxOrderNotionalUsd: 500, hardMarketCostUsd: 1_000 },
    });
    expect(scaled.ok).toBe(true);
    expect(scaled.notionalUsd).toBeCloseTo(400);
  });

  it("fails closed when either configured depth tier is short", () => {
    expect(
      checkPassiveEntryCapacity({
        book: book(999, 2_500),
        requestedNotionalUsd: 12.5,
        currentMarketCostUsd: 0,
        remainingTargetUsd: 40,
        config,
      }).skipReasons.join(" "),
    ).toContain("within 1c");
    expect(
      checkPassiveEntryCapacity({
        book: book(1_000, 2_499),
        requestedNotionalUsd: 12.5,
        currentMarketCostUsd: 0,
        remainingTargetUsd: 40,
        config,
      }).skipReasons.join(" "),
    ).toContain("within 2c");
  });

  it("marks only displayed liquidation depth and values the remainder at zero", () => {
    const result = executableLiquidationValue(
      {
        marketRef: "yes",
        bids: [
          { price: 0.5, size: 10 },
          { price: 0.48, size: 5 },
          { price: 0.47, size: 100 },
        ],
        asks: [{ price: 0.51, size: 10 }],
        ts: 1,
      },
      20,
      { maxConcessionPp: 2, feeRateBps: 100 },
    );
    expect(result.executableSize).toBe(15);
    expect(result.unfilledSize).toBe(5);
    expect(result.grossValueUsd).toBeCloseTo(7.4);
    expect(result.netValueUsd).toBeCloseTo(7.326);
  });
});

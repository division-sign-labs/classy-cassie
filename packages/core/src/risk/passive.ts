// packages/core/src/risk/passive.ts
// Passive-entry liquidity and executable liquidation checks for market-making.

import type { OrderBook } from "../types.js";

export interface PassiveLiquidityConfig {
  minDepthWithin1cUsd: number;
  minDepthWithin2cUsd: number;
  maxOrderFractionWithin1c: number;
  maxOrderFractionWithin2c: number;
  maxMarketFractionWithin1c: number;
  maxMarketFractionWithin2c: number;
  maxBestLevelFraction: number;
  maxOrderNotionalUsd: number;
  hardMarketCostUsd: number;
  minOrderNotionalUsd: number;
  maxBookSpreadPp: number;
  hardMaxBookSpreadPp: number;
}

export interface BidLiquidity {
  bestBid: number;
  bestAsk: number;
  spreadPp: number;
  bestBidLevelUsd: number;
  depthWithin1cUsd: number;
  depthWithin2cUsd: number;
}

export interface PassiveEntryCapacityInput {
  book: OrderBook;
  requestedNotionalUsd: number;
  currentMarketCostUsd: number;
  /** Direction target remaining after inventory and pending entries. */
  remainingTargetUsd: number;
  config: PassiveLiquidityConfig;
  /** Optional stricter global risk ceiling. */
  globalMaxOrderNotionalUsd?: number;
}

export interface PassiveEntryCapacityResult {
  ok: boolean;
  notionalUsd: number;
  liquidity: BidLiquidity;
  orderLiquidityCapUsd: number;
  marketLiquidityCapUsd: number;
  skipReasons: string[];
  notes: string[];
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Measure the inventory's executable exit side. Depth bands are measured from
 * the best bid because passive BUY inventory must ultimately be sold into bids.
 */
export function measureBidLiquidity(book: OrderBook): BidLiquidity {
  const bids = [...book.bids]
    .filter((level) => finitePositive(level.price) && finitePositive(level.size))
    .sort((left, right) => right.price - left.price);
  const asks = [...book.asks]
    .filter((level) => finitePositive(level.price) && finitePositive(level.size))
    .sort((left, right) => left.price - right.price);
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 1;
  const dollarsWithin = (cents: number): number =>
    bids
      .filter((level) => bestBid > 0 && level.price >= bestBid - cents / 100 - 1e-12)
      .reduce((sum, level) => sum + level.price * level.size, 0);
  return {
    bestBid,
    bestAsk,
    spreadPp: (bestAsk - bestBid) * 100,
    bestBidLevelUsd: bids[0] ? bids[0].price * bids[0].size : 0,
    depthWithin1cUsd: dollarsWithin(1),
    depthWithin2cUsd: dollarsWithin(2),
  };
}

/**
 * Apply entry-only book sanity and participation limits. All caps are upper
 * bounds; this function never rounds a sub-minimum order upward.
 */
export function checkPassiveEntryCapacity(input: PassiveEntryCapacityInput): PassiveEntryCapacityResult {
  const { config } = input;
  const liquidity = measureBidLiquidity(input.book);
  const skipReasons: string[] = [];
  const notes: string[] = [];

  if (liquidity.bestBid <= 0 || liquidity.bestAsk >= 1 || liquidity.bestAsk <= liquidity.bestBid) {
    skipReasons.push("selected-token book is empty or crossed");
  }
  if (liquidity.spreadPp > config.hardMaxBookSpreadPp + 1e-9) {
    skipReasons.push(
      `selected-token spread ${liquidity.spreadPp.toFixed(2)}pp exceeds hard sanity ceiling ${config.hardMaxBookSpreadPp}pp`,
    );
  } else if (liquidity.spreadPp > config.maxBookSpreadPp + 1e-9) {
    skipReasons.push(
      `selected-token spread ${liquidity.spreadPp.toFixed(2)}pp exceeds entry ceiling ${config.maxBookSpreadPp}pp`,
    );
  }
  if (liquidity.depthWithin1cUsd + 1e-9 < config.minDepthWithin1cUsd) {
    skipReasons.push(
      `exit bid depth within 1c $${liquidity.depthWithin1cUsd.toFixed(2)} < $${config.minDepthWithin1cUsd.toFixed(2)}`,
    );
  }
  if (liquidity.depthWithin2cUsd + 1e-9 < config.minDepthWithin2cUsd) {
    skipReasons.push(
      `exit bid depth within 2c $${liquidity.depthWithin2cUsd.toFixed(2)} < $${config.minDepthWithin2cUsd.toFixed(2)}`,
    );
  }

  const orderLiquidityCapUsd = Math.min(
    liquidity.depthWithin1cUsd * config.maxOrderFractionWithin1c,
    liquidity.depthWithin2cUsd * config.maxOrderFractionWithin2c,
    liquidity.bestBidLevelUsd * config.maxBestLevelFraction,
  );
  const marketLiquidityCapUsd = Math.min(
    liquidity.depthWithin1cUsd * config.maxMarketFractionWithin1c,
    liquidity.depthWithin2cUsd * config.maxMarketFractionWithin2c,
  );
  const globalOrderCap = input.globalMaxOrderNotionalUsd ?? Number.POSITIVE_INFINITY;
  const remainingLiquidityMarketCapacity = Math.max(0, marketLiquidityCapUsd - input.currentMarketCostUsd);
  const notionalUsd = Math.max(
    0,
    Math.min(
      input.requestedNotionalUsd,
      config.maxOrderNotionalUsd,
      globalOrderCap,
      config.hardMarketCostUsd - input.currentMarketCostUsd,
      input.remainingTargetUsd,
      orderLiquidityCapUsd,
      remainingLiquidityMarketCapacity,
    ),
  );

  if (notionalUsd + 1e-9 < config.minOrderNotionalUsd) {
    skipReasons.push(
      `capped passive order $${notionalUsd.toFixed(2)} < minimum $${config.minOrderNotionalUsd.toFixed(2)}`,
    );
  }
  if (notionalUsd + 1e-9 < input.requestedNotionalUsd) {
    notes.push(`requested $${input.requestedNotionalUsd.toFixed(2)} capped to $${notionalUsd.toFixed(2)}`);
  }
  return {
    ok: skipReasons.length === 0,
    notionalUsd: skipReasons.length === 0 ? notionalUsd : 0,
    liquidity,
    orderLiquidityCapUsd,
    marketLiquidityCapUsd,
    skipReasons,
    notes,
  };
}

export interface LiquidationValue {
  requestedSize: number;
  executableSize: number;
  unfilledSize: number;
  grossValueUsd: number;
  netValueUsd: number;
  averagePrice?: number;
}

/**
 * Mark or construct a bounded exit by walking displayed bids. Unavailable
 * quantity is worth zero for risk marking; callers may keep it as inventory.
 */
export function executableLiquidationValue(
  book: OrderBook,
  size: number,
  options: { maxConcessionPp?: number; feeRateBps?: number } = {},
): LiquidationValue {
  const requestedSize = Math.max(0, size);
  const bids = [...book.bids]
    .filter((level) => finitePositive(level.price) && finitePositive(level.size))
    .sort((left, right) => right.price - left.price);
  const bestBid = bids[0]?.price ?? 0;
  const floor = Math.max(0, bestBid - (options.maxConcessionPp ?? 100) / 100);
  let remaining = requestedSize;
  let grossValueUsd = 0;
  for (const level of bids) {
    if (level.price + 1e-12 < floor || remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    grossValueUsd += take * level.price;
    remaining -= take;
  }
  const executableSize = requestedSize - remaining;
  const fee = grossValueUsd * ((options.feeRateBps ?? 0) / 10_000);
  return {
    requestedSize,
    executableSize,
    unfilledSize: remaining,
    grossValueUsd,
    netValueUsd: Math.max(0, grossValueUsd - fee),
    ...(executableSize > 0 ? { averagePrice: grossValueUsd / executableSize } : {}),
  };
}

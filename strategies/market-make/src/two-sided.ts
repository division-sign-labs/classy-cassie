// strategies/market-make/src/two-sided.ts
// Inventory-aware complementary quotes; defaults are operating choices, not research optima.

import { z } from "zod";
import type { MarketCatalogSnapshot, Outcome, TokenBook } from "./types.js";
import { AdaptivePolicySchema, type AdaptiveQuoteContext } from "./adaptive-policy.js";

const finite = z.number().finite();
export const TwoSidedPolicySchema = z.object({
  target_markets: finite.int().positive().default(3),
  minimum_volume_24h_usd: finite.nonnegative().default(1_000),
  minimum_depth_usd: finite.nonnegative().default(300),
  minimum_token_price: finite.positive().lt(0.5).default(0.05),
  maximum_depth_participation: finite.positive().max(1).default(0.1),
  maximum_spread_pp: finite.positive().max(100).default(6),
  minimum_pair_spread_ticks: finite.int().positive().default(1),
  inventory_skew_ticks: finite.nonnegative().default(2),
  maximum_unpaired_notional_usd: finite.positive().default(60),
  minimum_rest_seconds: finite.nonnegative().default(30),
  reprice_ticks: finite.positive().default(1),
  maximum_inventory_age_seconds: finite.positive().default(3_600),
  adaptive: AdaptivePolicySchema.optional(),
}).strict();

export type TwoSidedPolicy = z.infer<typeof TwoSidedPolicySchema>;

/** Total holdings; the controller clips new SELLs against other live reservations. */
export interface TwoSidedInventory {
  yesQuantity: number;
  noQuantity: number;
  yesAverageCost?: number;
  noAverageCost?: number;
}

export interface TwoSidedQuote {
  marketKey: string;
  marketRef: string;
  conditionId: string;
  tokenId: string;
  outcome: Outcome;
  side: "BUY" | "SELL";
  size: number;
  limitPrice: number;
  /** Economic YES bid/ask, including their complementary NO representation. */
  lane: "bid" | "ask";
  reason: string;
}

export interface TwoSidedPlanInput {
  market: MarketCatalogSnapshot;
  yesBook: TokenBook;
  noBook: TokenBook;
  inventory: TwoSidedInventory;
  now: number;
  baseOrderUsd: number;
  maxOrderUsd: number;
  maxMarketUsd: number;
  minimumSecondsToEnd: number;
  policy: TwoSidedPolicy;
}

export interface TwoSidedPlan {
  quotes: TwoSidedQuote[];
  /** New two-sided inventory is eligible; reducing SELLs may exist when false. */
  eligible: boolean;
  reasons: string[];
  context: {
    yesBid?: number;
    yesAsk?: number;
    noBid?: number;
    noAsk?: number;
    depthYes2cUsd: number;
    depthNo2cUsd: number;
    skewTicks: number;
    shareQuantity?: number;
    adaptive?: AdaptiveQuoteContext;
  };
}

interface BookView {
  bid: number;
  ask: number;
  mid: number;
  depthUsd: number;
}

const EPSILON = 1e-9;
const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;
const priceValid = (price: number): boolean => finitePositive(price) && price < 1;
const floorTick = (price: number, tick: number): number => Number((Math.floor((price + EPSILON) / tick) * tick).toFixed(12));
const ceilTick = (price: number, tick: number): number => Number((Math.ceil((price - EPSILON) / tick) * tick).toFixed(12));

function readBook(book: TokenBook, tokenId: string): BookView | undefined {
  if (book.tokenId !== tokenId || !Number.isFinite(book.ts)) return undefined;
  const valid = (level: TokenBook["bids"][number]) => priceValid(level.price) && finitePositive(level.size);
  if (!book.bids.every(valid) || !book.asks.every(valid) || !book.bids.length || !book.asks.length) return undefined;
  const bid = Math.max(...book.bids.map((level) => level.price));
  const ask = Math.min(...book.asks.map((level) => level.price));
  if (bid >= ask - EPSILON) return undefined;
  const depthUsd = book.bids.reduce((total, level) => level.price + EPSILON >= bid - 0.02
    ? total + level.price * level.size : total, 0);
  return { bid, ask, mid: (bid + ask) / 2, depthUsd };
}

function makeQuote(input: TwoSidedPlanInput, outcome: Outcome, side: "BUY" | "SELL", lane: "bid" | "ask", price: number, size: number): TwoSidedQuote {
  return {
    marketKey: input.market.marketKey,
    marketRef: input.market.marketRef,
    conditionId: input.market.conditionId,
    tokenId: outcome === "YES" ? input.market.yesTokenId : input.market.noTokenId,
    outcome,
    side,
    size,
    limitPrice: price,
    lane,
    reason: side === "SELL" ? `two-sided ${lane}: release ${outcome} inventory` : `two-sided ${lane}: passive ${outcome} liquidity`,
  };
}

/**
 * All returned terms are passive. The controller must submit post-only, validate
 * freshness, account for live reservations, and cancel old lanes before replacing.
 * Rest/reprice/maximum-age policy is executed by that controller, not this planner.
 */
export function planTwoSidedQuotes(input: TwoSidedPlanInput): TwoSidedPlan {
  const { market, inventory, policy } = input;
  const yes = readBook(input.yesBook, market.yesTokenId);
  const no = readBook(input.noBook, market.noTokenId);
  const reasons: string[] = [];
  const plan: TwoSidedPlan = {
    quotes: [], eligible: false, reasons,
    context: {
      ...(yes ? { yesBid: yes.bid, yesAsk: yes.ask } : {}),
      ...(no ? { noBid: no.bid, noAsk: no.ask } : {}),
      depthYes2cUsd: yes?.depthUsd ?? 0,
      depthNo2cUsd: no?.depthUsd ?? 0,
      skewTicks: 0,
    },
  };
  const tick = market.tickSize;
  if (!finitePositive(tick) || tick >= 1 || Math.abs(1 / tick - Math.round(1 / tick)) > EPSILON || !finitePositive(market.minOrderSize)) {
    reasons.push("invalid-tick-or-minimum-order");
    return plan;
  }
  if (!market.marketKey || !market.conditionId || !market.marketRef || !market.yesTokenId || !market.noTokenId || market.yesTokenId === market.noTokenId) {
    reasons.push("market-identity-incomplete");
    return plan;
  }
  if (![inventory.yesQuantity, inventory.noQuantity].every((quantity) => Number.isFinite(quantity) && quantity >= 0)) {
    reasons.push("invalid-inventory");
    return plan;
  }
  if (![input.baseOrderUsd, input.maxOrderUsd, input.maxMarketUsd].every(finitePositive)
    || !Number.isFinite(input.now) || !Number.isFinite(input.minimumSecondsToEnd) || input.minimumSecondsToEnd < 0) {
    reasons.push("invalid-capital-or-clock");
    return plan;
  }
  if (!market.active || market.closed || market.archived || !market.acceptingOrders || !market.orderbookEnabled) {
    reasons.push("market-not-accepting-orders");
    return plan;
  }
  if (!yes) reasons.push("yes-book-invalid");
  if (!no) reasons.push("no-book-invalid");
  if (!Number.isFinite(market.endsAt) || market.endsAt - input.now < input.minimumSecondsToEnd * 1_000) reasons.push("market-end-too-near");
  if (!Number.isFinite(market.volume24hUsd) || market.volume24hUsd < policy.minimum_volume_24h_usd) reasons.push("volume-24h-low");
  if (yes && yes.depthUsd + EPSILON < policy.minimum_depth_usd) reasons.push("yes-exit-depth-low");
  if (no && no.depthUsd + EPSILON < policy.minimum_depth_usd) reasons.push("no-exit-depth-low");
  if (yes && yes.mid + EPSILON < policy.minimum_token_price) reasons.push("yes-price-extreme");
  if (no && no.mid + EPSILON < policy.minimum_token_price) reasons.push("no-price-extreme");
  if (yes && 100 * (yes.ask - yes.bid) > policy.maximum_spread_pp + EPSILON) reasons.push("yes-spread-wide");
  if (no && 100 * (no.ask - no.bid) > policy.maximum_spread_pp + EPSILON) reasons.push("no-spread-wide");

  const ticketUsd = Math.min(input.baseOrderUsd, input.maxOrderUsd);
  const minSize = market.minOrderSize;
  const yesQty = inventory.yesQuantity;
  const noQty = inventory.noQuantity;
  const yesMark = yes?.mid ?? (no ? 1 - no.mid : 0.5);
  const noMark = no?.mid ?? (yes ? 1 - yes.mid : 0.5);
  const adverseLaneRoom = (lane: "bid" | "ask"): number => {
    const delta = lane === "bid" ? yesQty - noQty : noQty - yesQty;
    const mark = lane === "bid" ? yesMark : noMark;
    return Math.max(0, policy.maximum_unpaired_notional_usd / mark - delta);
  };
  const fallbackReductions = (): TwoSidedQuote[] => {
    const quotes: TwoSidedQuote[] = [];
    for (const [outcome, book, quantity] of [["YES", yes, yesQty], ["NO", no, noQty]] as const) {
      if (!book || quantity + EPSILON < minSize) continue;
      const otherBook = outcome === "YES" ? no : yes;
      const price = ceilTick(Math.max(book.ask, book.bid + tick, otherBook ? 1 - otherBook.ask + tick : 0), tick);
      const size = Math.min(quantity, ticketUsd / price, adverseLaneRoom(outcome === "YES" ? "ask" : "bid"));
      if (priceValid(price) && size + EPSILON >= minSize) {
        quotes.push(makeQuote(input, outcome, "SELL", outcome === "YES" ? "ask" : "bid", price, size));
      }
    }
    if (quotes.length === 2 && quotes[0]!.limitPrice + quotes[1]!.limitPrice < 1 + policy.minimum_pair_spread_ticks * tick - EPSILON) {
      const quote = quotes[0]!;
      quote.limitPrice = ceilTick(1 + policy.minimum_pair_spread_ticks * tick - quotes[1]!.limitPrice, tick);
      quote.size = Math.min(quote.size, ticketUsd / quote.limitPrice);
      if (!priceValid(quote.limitPrice) || quote.size + EPSILON < minSize) quotes.shift();
    }
    return quotes;
  };

  // One broken book must not suppress a valid SELL in the other outcome.
  if (!yes || !no) {
    plan.quotes = fallbackReductions();
    return plan;
  }

  const unpairedQty = yesQty - noQty;
  const unpairedMark = unpairedQty >= 0 ? yes.mid : no.mid;
  const skewFraction = Math.max(-1, Math.min(1, unpairedQty * unpairedMark / policy.maximum_unpaired_notional_usd));
  const skewTicks = skewFraction * policy.inventory_skew_ticks;
  plan.context.skewTicks = skewTicks;
  const shift = skewTicks * tick;

  // Work in implied YES prices so both real and complementary books constrain
  // either representation of a lane. This also prevents mint/merge self-crosses.
  let bid = floorTick(Math.min((yes.bid + 1 - no.ask) / 2 - shift, yes.ask - tick, 1 - no.bid - tick), tick);
  const ask = ceilTick(Math.max((yes.ask + 1 - no.bid) / 2 - shift, yes.bid + tick, 1 - no.ask + tick), tick);
  bid = floorTick(Math.min(bid, ask - policy.minimum_pair_spread_ticks * tick), tick);
  if (!priceValid(bid) || !priceValid(ask) || ask - bid + EPSILON < policy.minimum_pair_spread_ticks * tick) {
    reasons.push("no-passive-pair-price");
    plan.quotes = fallbackReductions();
    return plan;
  }

  const bidUsesInventory = noQty + EPSILON >= minSize;
  const askUsesInventory = yesQty + EPSILON >= minSize;
  const bidPrice = bidUsesInventory ? ceilTick(1 - bid, tick) : bid;
  const askPrice = askUsesInventory ? ask : floorTick(1 - ask, tick);
  const targetQuantity = ticketUsd / Math.max(bidPrice, askPrice);
  plan.context.shareQuantity = targetQuantity;
  const lanes = [
    { lane: "bid" as const, outcome: bidUsesInventory ? "NO" as const : "YES" as const, side: bidUsesInventory ? "SELL" as const : "BUY" as const, price: bidPrice, available: noQty },
    { lane: "ask" as const, outcome: askUsesInventory ? "YES" as const : "NO" as const, side: askUsesInventory ? "SELL" as const : "BUY" as const, price: askPrice, available: yesQty },
  ];
  const grossInventoryUsd = yesQty * (finitePositive(inventory.yesAverageCost ?? 0) ? inventory.yesAverageCost! : yes.mid)
    + noQty * (finitePositive(inventory.noAverageCost ?? 0) ? inventory.noAverageCost! : no.mid);
  const grossRoomUsd = Math.max(0, input.maxMarketUsd - grossInventoryUsd);
  const buyPriceSum = lanes.reduce((sum, lane) => sum + (lane.side === "BUY" ? lane.price : 0), 0);
  let buyQuantity = Math.min(targetQuantity, buyPriceSum > 0 ? grossRoomUsd / buyPriceSum : targetQuantity);
  for (const lane of lanes) {
    if (lane.side !== "BUY") continue;
    const book = lane.outcome === "YES" ? yes : no;
    const adverseQty = lane.outcome === "YES" ? unpairedQty : -unpairedQty;
    const unpairedRoom = Math.max(0, policy.maximum_unpaired_notional_usd / Math.max(book.mid, lane.price) - adverseQty);
    buyQuantity = Math.min(buyQuantity, book.depthUsd * policy.maximum_depth_participation / lane.price, unpairedRoom);
  }
  if (buyPriceSum > 0 && buyQuantity + EPSILON < minSize) reasons.push("buy-capacity-below-minimum-order");
  if (targetQuantity + EPSILON < minSize) reasons.push("ticket-below-minimum-order");
  const allowBuys = reasons.length === 0;
  for (const lane of lanes) {
    if (lane.side === "BUY" && !allowBuys) continue;
    // Selling an existing NO increases economic YES exposure (and vice versa),
    // even though gross inventory falls. Paired inventory is not a risk waiver.
    const size = lane.side === "SELL" ? Math.min(targetQuantity, lane.available, adverseLaneRoom(lane.lane)) : buyQuantity;
    if (!priceValid(lane.price) || size + EPSILON < minSize) continue;
    const book = lane.outcome === "YES" ? yes : no;
    if (lane.side === "BUY" ? lane.price >= book.ask - EPSILON : lane.price <= book.bid + EPSILON) continue;
    plan.quotes.push(makeQuote(input, lane.outcome, lane.side, lane.lane, lane.price, size));
  }
  plan.eligible = allowBuys && plan.quotes.length === 2;
  return plan;
}

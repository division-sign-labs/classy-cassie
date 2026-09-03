// strategies/market-make/src/math.ts
// Candidate normalization, hard gates, and passive quote arithmetic shared by live and replay.

import type { MarketMakeConfig } from "./schema.js";
import type {
  CategoryFamily,
  EntryQuote,
  GateDecision,
  MarketCatalogSnapshot,
  NormalizedCandidate,
  NormalizedSignal,
  PublishedSignalInput,
  QuoteCapacity,
  StabilitySnapshot,
  TokenBook,
  VolatilityRegime,
  VolatilitySnapshot,
} from "./types.js";

const EPSILON = 1e-9;

function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`unit error: ${name} must be ${min}..${max}; received ${String(value)}`);
  }
}

export function normalizePublishedSignal(input: PublishedSignalInput): NormalizedSignal {
  assertRange("entryQ", input.entryQ, 0, 100);
  assertRange("entryPm", input.entryPm, 0, 100);
  assertRange("latestQ", input.latestQ, 0, 1);
  if (!input.marketKey || !input.conditionId || !input.nativeMarketId) throw new Error("signal identity is incomplete");
  return {
    ...input,
    qYesAtPublish: input.entryQ / 100,
    marketYesAtPublish: input.entryPm / 100,
    qYes: input.latestQ,
  };
}

export function categoryFamily(category: string, config: MarketMakeConfig): CategoryFamily {
  for (const family of ["international", "domestic", "macro_business", "culture_tech"] as const) {
    if (config.diversification.category_families[family].includes(category)) return family;
  }
  return "other";
}

export function volatilityRegime(snapshot: VolatilitySnapshot, config: MarketMakeConfig): VolatilityRegime {
  if (snapshot.rv24Pp < config.volatility.dead_rv24_upper_pp) return "dead";
  if (snapshot.rv24Pp < config.volatility.normal_rv24_upper_pp) return "normal";
  if (snapshot.rv24Pp < config.volatility.high_rv24_upper_pp && snapshot.acceleration < config.volatility.extreme_acceleration_lower) return "high";
  return "extreme";
}

export function bestBid(book: TokenBook): number | undefined {
  return book.bids.reduce<number | undefined>((best, level) => best === undefined || level.price > best ? level.price : best, undefined);
}

export function bestAsk(book: TokenBook): number | undefined {
  return book.asks.reduce<number | undefined>((best, level) => best === undefined || level.price < best ? level.price : best, undefined);
}

export function bookMid(book: TokenBook): number | undefined {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  return bid === undefined || ask === undefined || bid >= ask ? undefined : (bid + ask) / 2;
}

/** Executable liquidation depth on bids, priced in USD, within `cents` of best bid. */
export function exitBidDepthUsd(book: TokenBook, cents: number): number {
  const bid = bestBid(book);
  if (bid === undefined) return 0;
  const floor = bid - cents / 100;
  return book.bids.reduce((sum, level) => level.price + EPSILON >= floor ? sum + level.price * level.size : sum, 0);
}

export function bestBidLevelUsd(book: TokenBook): number {
  const bid = bestBid(book);
  if (bid === undefined) return 0;
  return book.bids.reduce((sum, level) => Math.abs(level.price - bid) <= EPSILON ? sum + level.price * level.size : sum, 0);
}

export interface CandidateSnapshotInput {
  signal: NormalizedSignal;
  market: MarketCatalogSnapshot;
  yesBook: TokenBook;
  noBook: TokenBook;
  volatility: VolatilitySnapshot;
  stability: StabilitySnapshot;
}

export function normalizeCandidate(input: CandidateSnapshotInput, config: MarketMakeConfig): NormalizedCandidate {
  const yesMid = bookMid(input.yesBook);
  const noMid = bookMid(input.noBook);
  // An invalid book remains representable so the gate can produce an auditable
  // rejection. The 0.5 fallback cannot pass the empty/crossed-book gate.
  const comparisonYesMid = yesMid ?? 0.5;
  const side = input.signal.qYes - comparisonYesMid >= 0 ? "YES" : "NO";
  const selectedBook = side === "YES" ? input.yesBook : input.noBook;
  const selectedMid = side === "YES" ? yesMid : noMid;
  const bid = bestBid(selectedBook);
  const ask = bestAsk(selectedBook);
  const qSide = side === "YES" ? input.signal.qYes : 1 - input.signal.qYes;
  const midSide = selectedMid ?? Number.NaN;
  return {
    marketKey: input.signal.marketKey,
    marketRef: input.market.marketRef,
    nativeMarketId: input.signal.nativeMarketId,
    conditionId: input.signal.conditionId,
    eventId: input.market.eventId,
    category: input.market.category,
    categoryFamily: categoryFamily(input.market.category, config),
    manualCorrelationGroup: input.market.manualCorrelationGroup,
    signalId: input.signal.id,
    qAsOf: input.signal.qAsOf,
    side,
    tokenId: side === "YES" ? input.market.yesTokenId : input.market.noTokenId,
    qSide,
    midSide,
    yesMid: yesMid ?? Number.NaN,
    noMid: noMid ?? Number.NaN,
    liveEdgePp: 100 * (qSide - midSide),
    selectedSpreadPp: bid === undefined || ask === undefined ? Number.POSITIVE_INFINITY : 100 * (ask - bid),
    depthWithin1cUsd: exitBidDepthUsd(selectedBook, 1),
    depthWithin2cUsd: exitBidDepthUsd(selectedBook, 2),
    bestBidLevelUsd: bestBidLevelUsd(selectedBook),
    bestBid: bid ?? Number.NaN,
    bestAsk: ask ?? Number.NaN,
    tickSize: input.market.tickSize,
    minOrderSize: input.market.minOrderSize,
    volume24hUsd: input.market.volume24hUsd,
    forecastStatus: input.signal.forecastStatus,
    retiredReason: input.signal.retiredReason,
    drawdownRiskElevated: input.signal.drawdownRiskElevated ?? false,
    volatility: input.volatility,
    volatilityRegime: volatilityRegime(input.volatility, config),
    stability: input.stability,
    rewardRateUsd: input.market.rewardRateUsd ?? 0,
    signal: input.signal,
    market: input.market,
  };
}

export interface EntryGateContext {
  now: number;
  globalEntryPausedUntil?: number;
  marketShockPausedUntil?: number;
  requireQAfterShockAsOf?: number;
  lossLatched?: boolean;
  halted?: boolean;
  capReasons?: string[];
}

export function evaluateEntryGates(candidate: NormalizedCandidate, context: EntryGateContext, config: MarketMakeConfig): GateDecision {
  const reasons: string[] = [];
  const signal = candidate.signal;
  const market = candidate.market;
  const direction = config.direction_policy[candidate.side];
  const now = context.now;

  if (!signal.active) reasons.push("signal-inactive");
  if (!signal.livePriced) reasons.push("signal-not-live-priced");
  if (signal.suppressionReason != null) reasons.push("signal-suppressed");
  if (signal.retiredReason != null) reasons.push(`signal-retired:${signal.retiredReason}`);
  if (now - signal.qAsOf > config.quotient_feed.new_entry_max_forecast_age_seconds * 1_000) reasons.push("q-stale");
  if (signal.qAsOf - now > config.global_kill_switches.max_clock_skew_seconds * 1_000) reasons.push("q-clock-skew");

  if (!market.active || market.closed || market.archived) reasons.push("market-not-open");
  if (!market.acceptingOrders || !market.orderbookEnabled) reasons.push("market-not-accepting-orders");
  if (market.endsAt - now < config.market_catalog.minimum_seconds_to_end_at_entry * 1_000) reasons.push("market-ends-too-soon");
  if (!market.conditionId || !market.yesTokenId || !market.noTokenId) reasons.push("market-identity-incomplete");
  if (market.conditionId !== signal.conditionId || market.nativeMarketId !== signal.nativeMarketId) reasons.push("market-identity-mismatch");

  if (!Number.isFinite(candidate.midSide) || !Number.isFinite(candidate.bestBid) || !Number.isFinite(candidate.bestAsk) || candidate.bestBid >= candidate.bestAsk) reasons.push("book-empty-or-crossed");

  const hardSanityFailure = candidate.selectedSpreadPp > config.eligibility.hard_max_selected_token_book_spread_pp + EPSILON;
  if (hardSanityFailure) reasons.push("book-spread-hard-sanity");
  if (candidate.selectedSpreadPp > config.eligibility.max_selected_token_book_spread_pp + EPSILON) reasons.push("book-spread-operational");
  if (!(candidate.midSide > config.eligibility.min_selected_side_price && candidate.midSide < config.eligibility.max_selected_side_price)) reasons.push("selected-price-out-of-range");
  if (candidate.qSide + EPSILON < config.eligibility.min_q_probability_on_selected_side) reasons.push("selected-q-too-low");
  if (candidate.liveEdgePp + EPSILON < direction.minimum_edge_pp) reasons.push("edge-below-direction-min");
  if (candidate.liveEdgePp - EPSILON > direction.maximum_edge_pp) reasons.push("edge-above-direction-max");
  if (candidate.liveEdgePp - EPSILON > config.eligibility.q_market_edge_max_pp) reasons.push("edge-above-global-max");
  if (candidate.depthWithin2cUsd + EPSILON < config.eligibility.min_live_depth_usd_within_2c) reasons.push("depth-2c-below-source-min");
  if (candidate.depthWithin1cUsd + EPSILON < config.cassie_overrides.liquidity.minimum_exit_bid_depth_1c_usd) reasons.push("exit-bid-depth-1c-low");
  if (candidate.depthWithin2cUsd + EPSILON < config.cassie_overrides.liquidity.minimum_exit_bid_depth_2c_usd) reasons.push("exit-bid-depth-2c-low");
  if (candidate.volume24hUsd + EPSILON < config.eligibility.min_volume_24h_usd) reasons.push("volume-low");
  if (!Number.isFinite(candidate.yesMid) || !Number.isFinite(candidate.noMid) || Math.abs(candidate.yesMid + candidate.noMid - 1) * 100 > config.market_data.max_yes_no_midpoint_complement_error_pp + EPSILON) reasons.push("yes-no-complement-error");
  if (candidate.volatilityRegime === "dead" || candidate.volatilityRegime === "extreme") reasons.push(`volatility-${candidate.volatilityRegime}`);
  // Drawdown risk is a covariate under test, not evidence against the edge: the
  // preset ranks flagged candidates below clean ones instead of excluding them.
  if (config.eligibility.reject_drawdown_risk_elevated && candidate.drawdownRiskElevated) reasons.push("q-drawdown-risk-elevated");
  if (candidate.forecastStatus === "converged" || candidate.forecastStatus === "diverging" || candidate.forecastStatus === "caution" || candidate.forecastStatus === "warning") reasons.push(`forecast-status-${candidate.forecastStatus}`);
  if (now - candidate.stability.validSince + EPSILON < config.eligibility.entry_stability_seconds * 1_000) reasons.push("entry-not-stable-long-enough");
  if (candidate.stability.maxMoveAwayFromQPp + EPSILON >= config.eligibility.max_move_away_from_q_during_entry_stability_pp) reasons.push("entry-moved-away-from-q");
  if ((context.globalEntryPausedUntil ?? 0) > now) reasons.push("global-entry-paused");
  if ((context.marketShockPausedUntil ?? 0) > now) reasons.push("market-shock-paused");
  if (context.requireQAfterShockAsOf !== undefined && signal.qAsOf <= context.requireQAfterShockAsOf) reasons.push("awaiting-post-shock-q");
  if (context.lossLatched) reasons.push("loss-limit-latched");
  if (context.halted) reasons.push("manual-halt");
  reasons.push(...(context.capReasons ?? []));
  return { passed: reasons.length === 0, reasons, hardSanityFailure };
}

/** Adds explicit book freshness to the reusable hard-gate calculation. */
export function gateCandidate(candidate: NormalizedCandidate, yesBook: TokenBook, noBook: TokenBook, context: EntryGateContext, config: MarketMakeConfig): GateDecision {
  const decision = evaluateEntryGates(candidate, context, config);
  const reasons = [...decision.reasons];
  const selected = candidate.side === "YES" ? yesBook : noBook;
  if (yesBook.tokenId !== candidate.market.yesTokenId || noBook.tokenId !== candidate.market.noTokenId || selected.tokenId !== candidate.tokenId) reasons.push("token-mapping-mismatch");
  if (context.now - selected.ts > config.market_data.venue_quote_max_age_seconds * 1_000) reasons.push("selected-quote-stale");
  if (context.now - yesBook.ts > config.market_data.market_data_stale_seconds * 1_000 || context.now - noBook.ts > config.market_data.market_data_stale_seconds * 1_000) reasons.push("market-data-stale");
  if (Math.max(yesBook.ts, noBook.ts) - context.now > config.global_kill_switches.max_clock_skew_seconds * 1_000) reasons.push("book-clock-skew");
  return { ...decision, passed: reasons.length === 0, reasons };
}

export interface LiquidityParticipationCaps {
  orderCapUsd: number;
  marketCapUsd: number;
  orderDepth1cCapUsd: number;
  orderDepth2cCapUsd: number;
  marketDepth1cCapUsd: number;
  marketDepth2cCapUsd: number;
}

export function liquidityParticipationCaps(depth1cUsd: number, depth2cUsd: number, configuredOrderCapUsd: number, configuredMarketCapUsd: number, config: MarketMakeConfig): LiquidityParticipationCaps {
  const liq = config.cassie_overrides.liquidity;
  const orderDepth1cCapUsd = depth1cUsd * liq.max_order_fraction_of_exit_bid_depth_1c;
  const orderDepth2cCapUsd = depth2cUsd * liq.max_order_fraction_of_exit_bid_depth_2c;
  const marketDepth1cCapUsd = depth1cUsd * liq.max_market_fraction_of_exit_bid_depth_1c;
  const marketDepth2cCapUsd = depth2cUsd * liq.max_market_fraction_of_exit_bid_depth_2c;
  return {
    orderCapUsd: Math.min(configuredOrderCapUsd, orderDepth1cCapUsd, orderDepth2cCapUsd),
    marketCapUsd: Math.min(configuredMarketCapUsd, marketDepth1cCapUsd, marketDepth2cCapUsd),
    orderDepth1cCapUsd,
    orderDepth2cCapUsd,
    marketDepth1cCapUsd,
    marketDepth2cCapUsd,
  };
}

export function floorToTick(value: number, tick: number): number {
  if (!(tick > 0)) throw new Error("tick must be positive");
  return Math.floor((value + EPSILON) / tick) * tick;
}

export function buildEntryQuote(candidate: NormalizedCandidate, capacity: QuoteCapacity, config: MarketMakeConfig): EntryQuote | null {
  const direction = config.direction_policy[candidate.side];
  const vol = config.volatility.regimes[candidate.volatilityRegime];
  if (!vol.new_entry_enabled) return null;
  const predictedMovePp = Math.min(direction.maximum_center_shift_pp, config.quote_model.fair_value_beta * candidate.liveEdgePp);
  const adjustedCenter = candidate.midSide + predictedMovePp / 100;
  const halfWidth = Math.max(candidate.tickSize, (candidate.bestAsk - candidate.bestBid) / 2) + vol.extra_quote_ticks * candidate.tickSize;
  const fairBid = floorToTick(adjustedCenter - halfWidth, candidate.tickSize);
  const competitiveBid = candidate.bestAsk - candidate.bestBid + EPSILON >= 2 * candidate.tickSize
    ? Math.min(candidate.bestBid + candidate.tickSize, candidate.bestAsk - candidate.tickSize)
    : candidate.bestBid;
  const edgeCap = floorToTick(candidate.qSide - direction.minimum_edge_pp / 100, candidate.tickSize);
  const price = Math.min(fairBid, competitiveBid, edgeCap);
  if (!Number.isFinite(price) || price <= 0 || price >= candidate.bestAsk - EPSILON) return null;
  if (candidate.bestBid - price > config.quote_model.maximum_ticks_behind_best_bid * candidate.tickSize + EPSILON) return null;
  if (100 * (candidate.qSide - price) + EPSILON < direction.minimum_edge_pp) return null;
  if (!(price > config.eligibility.min_selected_side_price && price < config.eligibility.max_selected_side_price)) return null;

  const configuredMarketCap = Math.min(direction.target_market_cost_usd, config.capital.hard_market_cost_usd);
  const participation = liquidityParticipationCaps(
    candidate.depthWithin1cUsd,
    candidate.depthWithin2cUsd,
    config.capital.max_order_notional_usd,
    configuredMarketCap,
    config,
  );
  const requestedUsd = config.capital.base_order_notional_usd * direction.size_multiplier * vol.size_multiplier;
  const caps: Array<[string, number]> = [
    ["requested", requestedUsd],
    ["order-participation", participation.orderCapUsd],
    ["market-participation", participation.marketCapUsd - capacity.marketCommittedUsd],
    ["source-depth-2c", candidate.depthWithin2cUsd * config.quote_model.size_cap_fraction_of_depth_within_2c],
    ["best-level", candidate.bestBidLevelUsd * config.quote_model.size_cap_fraction_of_best_level],
    ["global", capacity.globalRemainingUsd],
    ["event", capacity.eventRemainingUsd],
    ["family", capacity.familyRemainingUsd],
    ["correlation", capacity.correlationRemainingUsd],
  ];
  const [limitingCap, notionalUsd] = caps.reduce((best, current) => current[1] < best[1] ? current : best);
  if (!(notionalUsd > 0)) return null;
  const size = notionalUsd / price;
  if (size + EPSILON < candidate.minOrderSize) return null;
  return { price, size, notionalUsd, requestedUsd, marketInventoryCapUsd: participation.marketCapUsd, limitingCap };
}

/** A sell is always capped to free inventory after every outstanding SELL reservation. */
export function freeSellQuantity(freeQuantity: number, reservedSellQuantity: number, requestedQuantity = Number.POSITIVE_INFINITY): number {
  return Math.max(0, Math.min(requestedQuantity, freeQuantity - reservedSellQuantity));
}

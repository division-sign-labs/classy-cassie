// strategies/market-make/src/risk.ts
// Pure shock, loss-limit, reservation, and portfolio-cap helpers.

import type { MarketMakeConfig } from "./schema.js";
import type { LossSnapshot, MarketMakeState, MarketRuntimeState, NormalizedCandidate, TrackedOrder } from "./types.js";

export interface ShockObservation {
  move60sPp: number;
  move5mPp: number;
  move15mPp: number;
  spreadMultipleVs5mMedian: number;
  depthDropFraction60s: number;
  adverse: boolean;
  bookCorrupt?: boolean;
}

export interface ShockDecision {
  shocked: boolean;
  adverse: boolean;
  reasons: string[];
}

export function evaluateShock(observation: ShockObservation, config: MarketMakeConfig): ShockDecision {
  const reasons: string[] = [];
  if (Math.abs(observation.move60sPp) >= config.market_shock.absolute_move_60s_pp) reasons.push("absolute-60s-move");
  if (observation.adverse && Math.abs(observation.move5mPp) >= config.market_shock.adverse_move_5m_pp) reasons.push("adverse-5m-move");
  if (observation.adverse && Math.abs(observation.move15mPp) >= config.market_shock.adverse_move_15m_pp) reasons.push("adverse-15m-move");
  if (observation.spreadMultipleVs5mMedian >= config.market_shock.spread_multiple_vs_trailing_5m) reasons.push("spread-expansion");
  if (observation.depthDropFraction60s >= config.market_shock.depth_drop_fraction_60s) reasons.push("depth-drop");
  if (observation.bookCorrupt) reasons.push("book-corrupt-or-gap");
  return { shocked: reasons.length > 0, adverse: observation.adverse, reasons };
}

export function lossLimitReasons(loss: LossSnapshot, config: MarketMakeConfig): string[] {
  const reasons: string[] = [];
  for (const [marketKey, amount] of Object.entries(loss.marketLossUsd)) {
    if (amount >= config.loss_limits.max_marked_loss_per_market_usd) reasons.push(`market-loss:${marketKey}`);
  }
  if (loss.rolling24hLossUsd >= config.loss_limits.max_rolling_24h_loss_usd) reasons.push("rolling-24h-loss");
  if (loss.drawdownUsd >= config.loss_limits.max_strategy_drawdown_usd) reasons.push("strategy-drawdown");
  return reasons;
}

/** Cancel-pending BUYs remain fully reserved until a confirmed terminal state. */
export function reservedBuyNotional(order: TrackedOrder): number {
  if (order.side !== "BUY" || order.status === "CANCELED" || order.status === "FILLED" || order.status === "REJECTED") return 0;
  return Math.max(0, order.size - order.filledSize) * order.price;
}

export function marketCommittedUsd(market: MarketRuntimeState): number {
  const inventory = market.inventory ? market.inventory.freeQuantity * market.inventory.avgCost : 0;
  return inventory + Object.values(market.orders).reduce((sum, order) => sum + reservedBuyNotional(order), 0);
}

export interface PortfolioExposure {
  totalUsd: number;
  eventUsd: Record<string, number>;
  eventMarketCounts: Record<string, number>;
  familyUsd: Record<string, number>;
  correlationUsd: Record<string, number>;
  activeMarketKeys: Set<string>;
  activeEventIds: Set<string>;
}

export function portfolioExposure(state: MarketMakeState, config: MarketMakeConfig): PortfolioExposure {
  const exposure: PortfolioExposure = {
    totalUsd: 0,
    eventUsd: {},
    eventMarketCounts: {},
    familyUsd: {},
    correlationUsd: {},
    activeMarketKeys: new Set(),
    activeEventIds: new Set(),
  };
  for (const market of Object.values(state.markets)) {
    const committed = marketCommittedUsd(market);
    if (!(committed > 0) || !market.catalog) continue;
    exposure.totalUsd += committed;
    exposure.activeMarketKeys.add(market.marketKey);
    exposure.activeEventIds.add(market.catalog.eventId);
    exposure.eventUsd[market.catalog.eventId] = (exposure.eventUsd[market.catalog.eventId] ?? 0) + committed;
    exposure.eventMarketCounts[market.catalog.eventId] =
      (exposure.eventMarketCounts[market.catalog.eventId] ?? 0) + 1;
    const category = market.catalog.category;
    const families = config.diversification.category_families as Record<string, string[]>;
    const mapped = Object.entries(families).find(([, categories]) => categories.includes(category))?.[0] ?? "other";
    exposure.familyUsd[mapped] = (exposure.familyUsd[mapped] ?? 0) + committed;
    if (market.catalog.manualCorrelationGroup) {
      const group = market.catalog.manualCorrelationGroup;
      exposure.correlationUsd[group] = (exposure.correlationUsd[group] ?? 0) + committed;
    }
  }
  return exposure;
}

export function candidateCapReasons(candidate: NormalizedCandidate, exposure: PortfolioExposure, config: MarketMakeConfig): string[] {
  const reasons: string[] = [];
  const hasCurrentMarket = exposure.activeMarketKeys.has(candidate.marketKey);
  if (
    exposure.activeMarketKeys.size > config.capital.max_active_markets ||
    (!hasCurrentMarket && exposure.activeMarketKeys.size >= config.capital.max_active_markets)
  ) reasons.push("max-active-markets");
  const eventMarketCount = exposure.eventMarketCounts[candidate.eventId] ?? 0;
  if (
    eventMarketCount > config.portfolio_risk.max_open_markets_per_event ||
    (!hasCurrentMarket && eventMarketCount >= config.portfolio_risk.max_open_markets_per_event)
  ) reasons.push(config.portfolio_risk.max_open_markets_per_event === 1
    ? "one-market-per-event"
    : "max-open-markets-per-event");
  if ((exposure.eventUsd[candidate.eventId] ?? 0) >= config.portfolio_risk.max_event_cost_usd) reasons.push("event-cap");
  if ((exposure.familyUsd[candidate.categoryFamily] ?? 0) >= config.portfolio_risk.max_category_family_cost_usd) reasons.push("category-family-cap");
  if (candidate.manualCorrelationGroup && (exposure.correlationUsd[candidate.manualCorrelationGroup] ?? 0) >= config.portfolio_risk.max_manual_correlation_group_cost_usd) reasons.push("correlation-cap");
  if (exposure.totalUsd >= config.capital.max_total_inventory_and_pending_entry_cost_usd) reasons.push("deployment-cap");
  return reasons;
}

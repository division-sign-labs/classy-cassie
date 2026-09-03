// strategies/market-make/src/reducer.ts
// Deterministic event reducer; live runtime and chronological replay call this exact code.

import { allocateCandidates, compareCandidatePriority } from "./allocation.js";
import { buildExitOrderTerms, evaluateExit, qProbabilityForOutcome } from "./exit.js";
import {
  buildEntryQuote,
  freeSellQuantity,
  gateCandidate,
  liquidityParticipationCaps,
  normalizeCandidate,
  normalizePublishedSignal,
} from "./math.js";
import { candidateCapReasons, lossLimitReasons, marketCommittedUsd, portfolioExposure } from "./risk.js";
import type { MarketMakeConfig } from "./schema.js";
import type {
  CategoryFamily,
  DecisionRecord,
  EntryDecisionCovariates,
  InventoryCycle,
  MarketMakeAction,
  MarketMakeState,
  MarketRuntimeState,
  NormalizedCandidate,
  NormalizedMarketMakeEvent,
  ReducerResult,
  TokenBook,
  TrackedOrder,
} from "./types.js";

const TERMINAL_ORDER_STATES = new Set<TrackedOrder["status"]>(["CANCELED", "FILLED", "REJECTED"]);
const EXIT_DECISION_EVENTS = new Set<NormalizedMarketMakeEvent["type"]>([
  "signal",
  "catalog",
  "book",
  "fill",
  "cancel-confirmed",
  "timer",
  "loss",
  "halt",
]);
const MAX_IN_MEMORY_DECISIONS = 1_000;
const EPSILON = 1e-9;

export function createInitialMarketMakeState(config: MarketMakeConfig): MarketMakeState {
  return {
    schemaVersion: "cassie-market-make-state/1",
    sequence: 0,
    markets: {},
    processedFillIds: {},
    recentShocks: [],
    globalEntryPausedUntil: 0,
    consecutiveOrderRejections: 0,
    halted: false,
    liquidateRequested: false,
    lossLatched: false,
    loss: { marketLossUsd: {}, rolling24hLossUsd: 0, drawdownUsd: 0 },
    availableCollateralUsd: config.capital.sizing_bankroll_usd,
    decisions: [],
  };
}

function marketState(state: MarketMakeState, marketKey: string): MarketRuntimeState {
  return state.markets[marketKey] ??= {
    marketKey,
    orders: {},
    inventoryIncreasingFillsByUtcDay: {},
    shockPausedUntil: 0,
  };
}

function isWorking(order: TrackedOrder): boolean {
  return !TERMINAL_ORDER_STATES.has(order.status);
}

function isWorkingEntry(order: TrackedOrder): boolean {
  return order.purpose === "entry" && order.side === "BUY" && isWorking(order);
}

function remainingOrderQuantity(order: TrackedOrder): number {
  return Math.max(0, order.size - order.filledSize);
}

/**
 * Public CLOB depth includes our own resting bids. Entry gates and sizing must
 * measure external exit liquidity, otherwise a quote can count itself as both
 * the best bid and the capacity supporting that quote. PLANNED orders are not
 * subtracted because they have not been acknowledged by the venue yet.
 */
function bookWithoutWorkingEntryBids(market: MarketRuntimeState, book: TokenBook): TokenBook {
  const bids = book.bids.map((level) => ({ ...level }));
  const ownBids = Object.values(market.orders).filter((order) =>
    isWorkingEntry(order) &&
    order.status !== "PLANNED" &&
    order.tokenId === book.tokenId &&
    remainingOrderQuantity(order) > EPSILON);
  for (const order of ownBids) {
    let quantityToSubtract = remainingOrderQuantity(order);
    for (const level of bids) {
      if (Math.abs(level.price - order.price) > EPSILON || quantityToSubtract <= EPSILON) continue;
      const subtraction = Math.min(level.size, quantityToSubtract);
      level.size = Math.max(0, level.size - subtraction);
      quantityToSubtract -= subtraction;
    }
  }
  return { ...book, bids: bids.filter((level) => level.size > EPSILON) };
}

function releaseSellReservation(market: MarketRuntimeState, order: TrackedOrder): void {
  if (order.side !== "SELL" || market.inventory?.tokenId !== order.tokenId) return;
  market.inventory.reservedSellQuantity = Math.max(
    0,
    market.inventory.reservedSellQuantity - remainingOrderQuantity(order),
  );
}

function existingOrder(market: MarketRuntimeState, incoming: TrackedOrder): TrackedOrder | undefined {
  return market.orders[incoming.orderId]
    ?? market.orders[incoming.clientId]
    ?? Object.values(market.orders).find((order) =>
      order.orderId === incoming.orderId || order.clientId === incoming.clientId);
}

function activeOrderCount(state: MarketMakeState): number {
  return Object.values(state.markets).reduce((count, market) => count + Object.values(market.orders).filter(isWorking).length, 0);
}

function nextClientId(state: MarketMakeState, marketKey: string, purpose: string): string {
  state.sequence += 1;
  return `mm:${state.sequence}:${marketKey}:${purpose}`;
}

function planOrder(
  state: MarketMakeState,
  market: MarketRuntimeState,
  action: Extract<MarketMakeAction, { kind: "place" }>,
  ts: number,
  placement?: { qAsOf: number; qSide: number; bestBid: number },
): void {
  market.orders[action.clientId] = {
    orderId: action.clientId,
    clientId: action.clientId,
    marketKey: action.marketKey,
    marketRef: action.marketRef,
    conditionId: action.conditionId,
    tokenId: action.tokenId,
    outcome: action.outcome,
    side: action.side,
    size: action.size,
    filledSize: 0,
    price: action.limitPrice,
    tif: action.tif,
    postOnly: action.postOnly,
    qAsOfAtPlacement: placement?.qAsOf,
    qSideAtPlacement: placement?.qSide,
    bestBidAtPlacement: placement?.bestBid,
    purpose: action.purpose,
    status: "PLANNED",
    createdAt: ts,
  };
}

function cancelOrders(market: MarketRuntimeState, predicate: (order: TrackedOrder) => boolean, reason: string): MarketMakeAction[] {
  const actions: MarketMakeAction[] = [];
  for (const order of Object.values(market.orders)) {
    if (!isWorking(order) || order.status === "CANCEL_PENDING" || !predicate(order)) continue;
    order.status = "CANCEL_PENDING";
    actions.push({ kind: "cancel", orderId: order.orderId, marketKey: market.marketKey, marketRef: order.marketRef, reason });
  }
  return actions;
}

function cancelEveryWorkingEntry(state: MarketMakeState, reason: string): MarketMakeAction[] {
  return Object.values(state.markets).flatMap((market) => cancelOrders(market, isWorkingEntry, reason));
}

/**
 * A late fill can arrive after its cancellation released risk reservations.
 * The fill itself is authoritative and cannot be undone, so immediately pull
 * every other inventory-increasing order if the resulting portfolio breaches
 * a hard cap. Later entry decisions remain blocked by the same cap helpers.
 */
function hardPortfolioCapBreaches(state: MarketMakeState, config: MarketMakeConfig): string[] {
  const exposure = portfolioExposure(state, config);
  const reasons: string[] = [];
  if (exposure.totalUsd > config.capital.max_total_inventory_and_pending_entry_cost_usd + EPSILON) {
    reasons.push("deployment-cap");
  }
  if (exposure.activeMarketKeys.size > config.capital.max_active_markets) reasons.push("max-active-markets");
  for (const [eventId, amount] of Object.entries(exposure.eventUsd)) {
    if (amount > config.portfolio_risk.max_event_cost_usd + EPSILON) reasons.push(`event-cap:${eventId}`);
  }
  for (const [eventId, count] of Object.entries(exposure.eventMarketCounts)) {
    if (count > config.portfolio_risk.max_open_markets_per_event) reasons.push(`event-market-count:${eventId}`);
  }
  for (const [family, amount] of Object.entries(exposure.familyUsd)) {
    if (amount > config.portfolio_risk.max_category_family_cost_usd + EPSILON) reasons.push(`family-cap:${family}`);
  }
  for (const [group, amount] of Object.entries(exposure.correlationUsd)) {
    if (amount > config.portfolio_risk.max_manual_correlation_group_cost_usd + EPSILON) reasons.push(`correlation-cap:${group}`);
  }
  for (const market of Object.values(state.markets)) {
    const committedUsd = marketCommittedUsd(market);
    if (!(committedUsd > 0)) continue;
    const workingEntry = Object.values(market.orders).find(isWorkingEntry);
    const outcome = market.inventory?.outcome ?? workingEntry?.outcome;
    if (!outcome) continue;
    const direction = config.direction_policy[outcome];
    const configuredMarketCap = Math.min(direction.target_market_cost_usd, config.capital.hard_market_cost_usd);
    if (committedUsd > configuredMarketCap + EPSILON) reasons.push(`market-cost-cap:${market.marketKey}`);
    const candidate = completeCandidate(market, config);
    if (!candidate || candidate.side !== outcome) continue;
    const participation = liquidityParticipationCaps(
      candidate.depthWithin1cUsd,
      candidate.depthWithin2cUsd,
      config.capital.max_order_notional_usd,
      configuredMarketCap,
      config,
    );
    if (committedUsd > participation.marketCapUsd + EPSILON) {
      reasons.push(`market-depth-cap:${market.marketKey}`);
    }
  }
  return reasons;
}

function applyFill(state: MarketMakeState, event: Extract<NormalizedMarketMakeEvent, { type: "fill" }>, config: MarketMakeConfig): MarketMakeAction[] {
  if (state.processedFillIds[event.fillId]) return [];
  state.processedFillIds[event.fillId] = true;
  const market = marketState(state, event.marketKey);
  const order = market.orders[event.orderId] ?? (event.clientId ? market.orders[event.clientId] : undefined) ?? Object.values(market.orders).find((candidate) => candidate.clientId === event.orderId);
  const sellReservationAlreadyReleased = order?.side === "SELL" && TERMINAL_ORDER_STATES.has(order.status);
  const effectiveSize = order ? Math.min(event.size, Math.max(0, order.size - order.filledSize)) : event.size;
  if (!(effectiveSize > 0)) return [];
  if (order) {
    order.filledSize = Math.min(order.size, order.filledSize + effectiveSize);
    if (order.filledSize >= order.size) order.status = "FILLED";
    else if (!TERMINAL_ORDER_STATES.has(order.status)) order.status = "PARTIAL";
  }
  if (event.side === "BUY") {
    const signal = market.signal;
    const qSide = signal ? qProbabilityForOutcome(signal.qYes, event.outcome) : event.price;
    if (!market.inventory || market.inventory.freeQuantity <= 0) {
      market.inventory = {
        marketKey: event.marketKey,
        marketRef: market.catalog?.marketRef ?? order?.marketRef ?? event.marketKey,
        conditionId: market.catalog?.conditionId ?? order?.conditionId ?? "unknown",
        tokenId: event.tokenId,
        outcome: event.outcome,
        freeQuantity: effectiveSize,
        reservedSellQuantity: 0,
        avgCost: event.price,
        cashPaidUsd: event.price * effectiveSize + (event.feeUsd ?? 0),
        cashReceivedUsd: 0,
        firstFillAt: event.ts,
        anchorQAsOf: signal?.qAsOf ?? event.ts,
        anchorQSide: qSide,
        anchorFillPrice: event.price,
        initialEdgePp: 100 * (qSide - event.price),
        renewalUsed: false,
        urgentAttempts: 0,
      };
    } else if (market.inventory.tokenId === event.tokenId) {
      const previousCost = market.inventory.avgCost * market.inventory.freeQuantity;
      market.inventory.freeQuantity += effectiveSize;
      market.inventory.avgCost = (previousCost + event.price * effectiveSize) / market.inventory.freeQuantity;
      market.inventory.cashPaidUsd += event.price * effectiveSize + (event.feeUsd ?? 0);
    } else {
      // The deterministic v1 never adds the opposite outcome while inventory
      // remains. A venue reconciliation that reports both sides is preserved
      // as a killed mismatch by latching entries rather than silently netting.
      state.lossLatched = true;
    }
    market.lastInventoryIncreasingFillAt = event.ts;
    market.lastInventoryIncreasingQAsOf = order?.qAsOfAtPlacement ?? signal?.qAsOf ?? event.ts;
    const day = new Date(event.ts).toISOString().slice(0, 10);
    market.inventoryIncreasingFillsByUtcDay[day] = (market.inventoryIncreasingFillsByUtcDay[day] ?? 0) + 1;
    return config.quote_model.cancel_remaining_entry_after_any_fill
      ? cancelOrders(market, (candidate) => candidate.purpose === "entry", "cancel remaining entry after fill")
      : [];
  }
  const inventory = market.inventory;
  if (!inventory || inventory.tokenId !== event.tokenId) return [];
  const sold = Math.min(effectiveSize, inventory.freeQuantity);
  inventory.freeQuantity -= sold;
  // A late fill may race a cancel/reject acknowledgement. That terminal
  // transition already released this order's remainder, so the fill must not
  // consume a different working sell order's reservation.
  if (order?.side === "SELL" && !sellReservationAlreadyReleased) {
    inventory.reservedSellQuantity = Math.max(0, inventory.reservedSellQuantity - sold);
  }
  inventory.cashReceivedUsd += sold * event.price - (event.feeUsd ?? 0);
  if (inventory.freeQuantity <= 1e-9) market.inventory = undefined;
  return [];
}

function applyEvent(state: MarketMakeState, event: NormalizedMarketMakeEvent, config: MarketMakeConfig): MarketMakeAction[] {
  switch (event.type) {
    case "signal": {
      const signal = normalizePublishedSignal(event.signal);
      const market = marketState(state, signal.marketKey);
      if (market.signal?.qAsOf !== signal.qAsOf || market.signal.qYes !== signal.qYes) {
        market.stability = undefined;
      }
      market.signal = signal;
      return [];
    }
    case "catalog":
      marketState(state, event.market.marketKey).catalog = event.market;
      return [];
    case "book": {
      const market = marketState(state, event.marketKey);
      if (event.outcome === "YES") market.yesBook = event.book;
      else market.noBook = event.book;
      return [];
    }
    case "volatility":
      marketState(state, event.marketKey).volatility = event.volatility;
      return [];
    case "stability":
      marketState(state, event.marketKey).stability = event.stability;
      return [];
    case "fill":
      return applyFill(state, event, config);
    case "order": {
      const market = marketState(state, event.marketKey);
      const previousOrder = existingOrder(market, event.order);
      const previousWasTerminal = previousOrder ? TERMINAL_ORDER_STATES.has(previousOrder.status) : false;
      const incomingIsTerminal = TERMINAL_ORDER_STATES.has(event.order.status);
      if (previousOrder && !previousWasTerminal && incomingIsTerminal) {
        releaseSellReservation(market, previousOrder);
      }
      if (previousOrder && event.order.orderId !== previousOrder.orderId) delete market.orders[previousOrder.orderId];
      const nextOrder = { ...event.order };
      if (previousOrder) {
        nextOrder.filledSize = Math.max(previousOrder.filledSize, nextOrder.filledSize);
        // Terminal venue feedback is monotonic. A stale LIVE/PARTIAL update
        // after a cancel/reject/fill must not reopen the order and make a later
        // duplicate terminal event release somebody else's reservation.
        if (previousWasTerminal && (!incomingIsTerminal || previousOrder.status === "FILLED")) {
          nextOrder.status = previousOrder.status;
        }
      }
      market.orders[event.order.orderId] = nextOrder;
      return [];
    }
    case "cancel-confirmed": {
      const market = marketState(state, event.marketKey);
      const order = market.orders[event.orderId];
      if (order && !TERMINAL_ORDER_STATES.has(order.status)) {
        releaseSellReservation(market, order);
        order.status = "CANCELED";
      }
      return [];
    }
    case "balance":
      state.availableCollateralUsd = event.availableCollateralUsd;
      return [];
    case "loss":
      state.loss = structuredClone(event.loss);
      if (lossLimitReasons(event.loss, config).length > 0) state.lossLatched = true;
      return state.lossLatched
        ? Object.values(state.markets).flatMap((market) => cancelOrders(market, isWorkingEntry, "loss limit latched"))
        : [];
    case "shock": {
      const market = marketState(state, event.marketKey);
      market.shockPausedUntil = Math.max(market.shockPausedUntil, event.ts + config.market_shock.entry_freeze_seconds * 1_000);
      if (event.adverse) market.requireQAfterShockAsOf = market.signal?.qAsOf ?? event.ts;
      const windowStart = event.ts - config.market_shock.correlated_shock_window_seconds * 1_000;
      state.recentShocks = state.recentShocks.filter((shock) => shock.ts >= windowStart && shock.marketKey !== event.marketKey);
      state.recentShocks.push({ marketKey: event.marketKey, ts: event.ts });
      if (new Set(state.recentShocks.map((shock) => shock.marketKey)).size >= config.market_shock.correlated_shocks_for_global_pause) {
        state.globalEntryPausedUntil = Math.max(state.globalEntryPausedUntil, event.ts + config.market_shock.global_shock_pause_seconds * 1_000);
      }
      return cancelOrders(market, isWorkingEntry, `market shock: ${event.reason}`);
    }
    case "reward":
      // Rewards are telemetry-only by contract and cannot create an action.
      return [];
    case "inventory-reconciled": {
      const market = marketState(state, event.marketKey);
      const inventory = market.inventory;
      if (event.quantity <= 1e-9) {
        market.inventory = undefined;
        return [];
      }
      const avgCost = event.costBasisUsd / event.quantity;
      if (inventory && inventory.tokenId === event.tokenId && inventory.outcome === event.outcome) {
        inventory.freeQuantity = event.quantity;
        inventory.reservedSellQuantity = Math.min(inventory.reservedSellQuantity, event.quantity);
        inventory.avgCost = avgCost;
        // Preserve recorded sale proceeds while replacing the remaining basis
        // with the venue-authoritative position basis.
        inventory.cashPaidUsd = event.costBasisUsd + inventory.cashReceivedUsd;
        return [];
      }
      const signal = market.signal;
      const catalog = market.catalog;
      const qSide = signal ? qProbabilityForOutcome(signal.qYes, event.outcome) : avgCost;
      market.inventory = {
        marketKey: event.marketKey,
        marketRef: catalog?.marketRef ?? event.marketKey,
        conditionId: catalog?.conditionId ?? "unknown",
        tokenId: event.tokenId,
        outcome: event.outcome,
        freeQuantity: event.quantity,
        reservedSellQuantity: 0,
        avgCost,
        cashPaidUsd: event.costBasisUsd,
        cashReceivedUsd: 0,
        firstFillAt: event.ts,
        anchorQAsOf: signal?.qAsOf ?? event.ts,
        anchorQSide: qSide,
        anchorFillPrice: avgCost,
        initialEdgePp: 100 * (qSide - avgCost),
        renewalUsed: false,
        exitStartedAt: event.ts - 60_000,
        exitUrgency: "urgent",
        urgentAttempts: 0,
      };
      return [];
    }
    case "redemption": {
      const market = marketState(state, event.marketKey);
      const previous = market.redemption;
      const previousAttempts = previous?.attempts ?? 0;
      const quantity = event.quantity ?? previous?.quantity;
      const payoutUsd = event.payoutUsd ?? previous?.payoutUsd;
      const reference = event.reference ?? previous?.reference;
      market.redemption = {
        status: event.status,
        attempts: event.status === "submitted" && previous?.status !== "submitted"
          ? previousAttempts + 1
          : previousAttempts,
        lastAttemptAt: event.ts,
        ...(quantity === undefined ? {} : { quantity }),
        ...(payoutUsd === undefined ? {} : { payoutUsd }),
        ...(reference === undefined ? {} : { reference }),
        ...(event.error === undefined ? {} : { error: event.error }),
      };
      market.redemptionRequested = event.status !== "failed";
      if (event.status === "confirmed") market.inventory = undefined;
      return [];
    }
    case "execution": {
      if (event.status === "accepted") {
        state.consecutiveOrderRejections = 0;
        return [];
      }
      state.consecutiveOrderRejections = (state.consecutiveOrderRejections ?? 0) + 1;
      if (state.consecutiveOrderRejections < 3) return [];
      state.globalEntryPausedUntil = Math.max(
        state.globalEntryPausedUntil,
        event.ts + config.loss_limits.three_consecutive_order_rejections_global_pause_seconds * 1_000,
      );
      return Object.values(state.markets).flatMap((candidate) =>
        cancelOrders(candidate, isWorkingEntry, "three consecutive venue order rejections"));
    }
    case "halt": {
      state.halted = true;
      state.liquidateRequested ||= event.liquidate;
      const actions = Object.values(state.markets).flatMap((market) => cancelOrders(market, () => true, "manual halt"));
      if (event.liquidate) {
        for (const market of Object.values(state.markets)) {
          if (market.inventory) market.inventory.exitStartedAt ??= event.ts - 60_000;
        }
      }
      return actions;
    }
    case "resume":
      if (!state.lossLatched || (event.acknowledgeLossReset && lossLimitReasons(state.loss, config).length === 0)) {
        if (event.acknowledgeLossReset) state.lossLatched = false;
        state.halted = false;
        state.liquidateRequested = false;
      }
      return [];
    case "timer":
      return [];
  }
}

function completeCandidate(
  market: MarketRuntimeState,
  config: MarketMakeConfig,
  excludeOwnEntryBids = false,
): NormalizedCandidate | undefined {
  if (!market.signal || !market.catalog || !market.yesBook || !market.noBook || !market.volatility || !market.stability) return undefined;
  const yesBook = excludeOwnEntryBids
    ? bookWithoutWorkingEntryBids(market, market.yesBook)
    : market.yesBook;
  const noBook = excludeOwnEntryBids
    ? bookWithoutWorkingEntryBids(market, market.noBook)
    : market.noBook;
  return normalizeCandidate({
    signal: market.signal,
    market: market.catalog,
    yesBook,
    noBook,
    volatility: market.volatility,
    stability: market.stability,
  }, config);
}

function exitActions(state: MarketMakeState, now: number, config: MarketMakeConfig): { actions: MarketMakeAction[]; records: DecisionRecord[] } {
  const actions: MarketMakeAction[] = [];
  const records: DecisionRecord[] = [];
  const lossReasons = lossLimitReasons(state.loss, config);
  for (const market of Object.values(state.markets).sort((a, b) => a.marketKey.localeCompare(b.marketKey))) {
    const inventory = market.inventory;
    const signal = market.signal;
    const catalog = market.catalog;
    const selectedBook = inventory?.outcome === "YES" ? market.yesBook : market.noBook;
    if (!inventory || !signal || !catalog || inventory.freeQuantity <= 0) continue;
    if (signal.retiredReason === "resolved") {
      const workingOrders = Object.values(market.orders).filter(isWorking);
      if (workingOrders.length > 0) {
        actions.push(...cancelOrders(market, () => true, "market resolved; cancel all orders before redemption"));
        continue;
      }
      const redemption = market.redemption;
      const retryAfterMs = Math.max(60_000, config.reconciliation.rest_reconcile_seconds * 3_000);
      const retryable = !redemption ||
        ((redemption.status === "failed" || redemption.status === "pending") &&
          now - redemption.lastAttemptAt >= retryAfterMs);
      if (retryable) {
        market.redemption = {
          status: "pending",
          attempts: redemption?.attempts ?? 0,
          lastAttemptAt: now,
        };
        market.redemptionRequested = true;
        actions.push({ kind: "redeem", marketKey: market.marketKey, marketRef: catalog.marketRef, reason: "market resolved" });
      }
      continue;
    }
    if (!selectedBook) continue;
    let decision = evaluateExit({ inventory, signal, selectedBook, now }, config);
    if (lossReasons.length > 0) decision = { ...decision, urgency: "urgent", reason: lossReasons.join(", "), cancelAdds: true };
    if (state.liquidateRequested) decision = { ...decision, urgency: "urgent", reason: "operator requested liquidation", cancelAdds: true };
    if (inventory.exitUrgency === "urgent" && decision.urgency !== "urgent") {
      decision = { ...decision, urgency: "urgent", reason: decision.reason ?? "urgent exit remains latched", cancelAdds: true };
    } else if (inventory.exitUrgency === "normal" && decision.urgency === "none") {
      decision = { ...decision, urgency: "normal", reason: decision.reason ?? "exit remains latched", cancelAdds: true };
    }
    if (decision.renewal) {
      inventory.renewalUsed = true;
      inventory.extensionUntil = decision.renewal.extensionUntil;
    }
    if (decision.cancelAdds) actions.push(...cancelOrders(market, isWorkingEntry, decision.reason ?? "exit policy canceled adds"));
    if (decision.urgency === "none") continue;
    inventory.exitStartedAt ??= now;
    inventory.exitUrgency = decision.urgency === "urgent" || inventory.exitUrgency === "urgent" ? "urgent" : "normal";
    const existingSells = Object.values(market.orders).filter((order) => order.side === "SELL" && isWorking(order));
    if (existingSells.length > 0) {
      const urgencyEscalated = inventory.exitUrgency === "urgent" && existingSells.some((order) => order.purpose !== "urgent-exit");
      const repriceDue = existingSells.some((order) => now - order.createdAt >= config.exit_policy.normal_exit_reprice_seconds * 1_000);
      if (urgencyEscalated || repriceDue) {
        actions.push(...cancelOrders(market, (order) => existingSells.includes(order), urgencyEscalated ? "exit urgency escalated" : "exit reprice interval"));
      }
      continue;
    }
    const terms = buildExitOrderTerms(decision.urgency, inventory, selectedBook, now, catalog.tickSize, config);
    if (!terms) {
      const exhausted = decision.urgency === "urgent" &&
        inventory.urgentAttempts >= config.exit_policy.urgent_exit_max_attempts;
      records.push({
        ts: now,
        marketKey: market.marketKey,
        eventType: "timer",
        decision: exhausted ? "exit-blocked" : "exit-deferred",
        reasons: [exhausted
          ? `urgent exit retry budget exhausted: ${decision.reason ?? "no bounded exit liquidity"}`
          : decision.reason ?? "no bounded exit liquidity"],
        actions: 0,
      });
      continue;
    }
    const purpose = decision.urgency === "urgent" ? "urgent-exit" : "normal-exit";
    const clientId = nextClientId(state, market.marketKey, purpose);
    const action: Extract<MarketMakeAction, { kind: "place" }> = {
      kind: "place", clientId, marketKey: market.marketKey, marketRef: catalog.marketRef, conditionId: catalog.conditionId,
      tokenId: inventory.tokenId, outcome: inventory.outcome, side: "SELL", size: terms.size, limitPrice: terms.limitPrice,
      tif: terms.tif, postOnly: terms.postOnly, purpose, reason: decision.reason ?? purpose,
    };
    if (terms.tif === "FAK" && decision.urgency === "urgent") inventory.urgentAttempts += 1;
    inventory.reservedSellQuantity += terms.size;
    planOrder(state, market, action, now);
    actions.push(action);
  }
  return { actions, records };
}

function entryActions(state: MarketMakeState, now: number, eventType: NormalizedMarketMakeEvent["type"], config: MarketMakeConfig): { actions: MarketMakeAction[]; records: DecisionRecord[] } {
  if (state.halted || state.lossLatched) return { actions: [], records: [] };
  // Execution feedback must never create a replacement order in the same
  // reduction cycle. In particular, a rejected/unknown order or a confirmed
  // cancellation is terminal feedback, not a fresh quoting signal. Reconsider
  // entries only when an input used by the entry decision changes (or on the
  // normal timer/resume heartbeat).
  const decisionDrivingEvents = new Set<NormalizedMarketMakeEvent["type"]>([
    "signal",
    "catalog",
    "book",
    "volatility",
    "stability",
    "timer",
    "resume",
  ]);
  if (!decisionDrivingEvents.has(eventType)) return { actions: [], records: [] };
  let exposure = portfolioExposure(state, config);
  const eligible: NormalizedCandidate[] = [];
  const actions: MarketMakeAction[] = [];
  const records: DecisionRecord[] = [];
  for (const market of Object.values(state.markets)) {
    const pendingEntry = Object.values(market.orders).some(isWorkingEntry);
    const candidate = completeCandidate(market, config, pendingEntry);
    if (!candidate) {
      if (pendingEntry) actions.push(...cancelOrders(market, isWorkingEntry, "entry inputs unavailable"));
      continue;
    }
    const inventory = market.inventory;
    const day = new Date(now).toISOString().slice(0, 10);
    const capReasons = candidateCapReasons(candidate, exposure, config);
    const inventoryExitInProgress =
      inventory?.exitStartedAt !== undefined ||
      inventory?.exitUrgency !== undefined ||
      (inventory?.reservedSellQuantity ?? 0) > EPSILON ||
      Object.values(market.orders).some((order) => order.side === "SELL" && isWorking(order));
    if (inventoryExitInProgress) capReasons.push("inventory-exit-in-progress");
    if (inventory && inventory.outcome !== candidate.side) capReasons.push("opposite-inventory-must-exit-first");
    if (
      inventory &&
      candidate.qAsOf <= (market.lastInventoryIncreasingQAsOf ?? inventory.anchorQAsOf)
    ) capReasons.push("awaiting-newer-same-side-q");
    if (market.lastInventoryIncreasingFillAt !== undefined && now - market.lastInventoryIncreasingFillAt < config.quote_model.post_fill_add_pause_seconds * 1_000) capReasons.push("post-fill-add-pause");
    if ((market.inventoryIncreasingFillsByUtcDay[day] ?? 0) >= config.quote_model.max_inventory_increasing_fills_per_market_per_day) capReasons.push("daily-fill-count-cap");
    const gateYesBook = pendingEntry
      ? bookWithoutWorkingEntryBids(market, market.yesBook!)
      : market.yesBook!;
    const gateNoBook = pendingEntry
      ? bookWithoutWorkingEntryBids(market, market.noBook!)
      : market.noBook!;
    const gate = gateCandidate(candidate, gateYesBook, gateNoBook, {
      now,
      globalEntryPausedUntil: state.globalEntryPausedUntil,
      marketShockPausedUntil: market.shockPausedUntil,
      requireQAfterShockAsOf: market.requireQAfterShockAsOf,
      lossLatched: state.lossLatched,
      halted: state.halted,
      capReasons: pendingEntry ? [] : capReasons,
    }, config);
    if (pendingEntry) {
      const workingEntries = Object.values(market.orders).filter(isWorkingEntry);
      const direction = config.direction_policy[candidate.side];
      const participation = liquidityParticipationCaps(
        candidate.depthWithin1cUsd,
        candidate.depthWithin2cUsd,
        config.capital.max_order_notional_usd,
        Math.min(direction.target_market_cost_usd, config.capital.hard_market_cost_usd),
        config,
      );
      const refreshedCapReasons: string[] = [];
      if (inventoryExitInProgress) refreshedCapReasons.push("inventory-exit-in-progress");
      if (exposure.totalUsd > config.capital.max_total_inventory_and_pending_entry_cost_usd + EPSILON) {
        refreshedCapReasons.push("portfolio exposure exceeds deployment cap");
      }
      if (exposure.activeMarketKeys.size > config.capital.max_active_markets) {
        refreshedCapReasons.push("active market count exceeds cap");
      }
      if ((exposure.eventUsd[candidate.eventId] ?? 0) > config.portfolio_risk.max_event_cost_usd + EPSILON) {
        refreshedCapReasons.push("event exposure exceeds cap");
      }
      if (
        (exposure.eventMarketCounts[candidate.eventId] ?? 0) >
        config.portfolio_risk.max_open_markets_per_event
      ) refreshedCapReasons.push("event market count exceeds cap");
      if (
        (exposure.familyUsd[candidate.categoryFamily] ?? 0) >
        config.portfolio_risk.max_category_family_cost_usd + EPSILON
      ) refreshedCapReasons.push("category-family exposure exceeds cap");
      if (
        candidate.manualCorrelationGroup &&
        (exposure.correlationUsd[candidate.manualCorrelationGroup] ?? 0) >
          config.portfolio_risk.max_manual_correlation_group_cost_usd + EPSILON
      ) refreshedCapReasons.push("correlation-group exposure exceeds cap");
      if (workingEntries.some((order) => order.outcome !== candidate.side || order.tokenId !== candidate.tokenId)) {
        refreshedCapReasons.push("selected entry outcome changed");
      }
      if (workingEntries.some((order) => remainingOrderQuantity(order) * order.price > participation.orderCapUsd + EPSILON)) {
        refreshedCapReasons.push("resting entry exceeds refreshed 1c/2c order participation cap");
      }
      if (marketCommittedUsd(market) > participation.marketCapUsd + EPSILON) {
        refreshedCapReasons.push("market exposure exceeds refreshed 1c/2c market participation cap");
      }
      if (workingEntries.some((order) =>
        remainingOrderQuantity(order) * order.price >
          candidate.bestBidLevelUsd * config.quote_model.size_cap_fraction_of_best_level + EPSILON)) {
        refreshedCapReasons.push("resting entry exceeds refreshed best-level participation cap");
      }
      if (workingEntries.some((order) =>
        remainingOrderQuantity(order) * order.price >
          candidate.depthWithin2cUsd * config.quote_model.size_cap_fraction_of_depth_within_2c + EPSILON)) {
        refreshedCapReasons.push("resting entry exceeds refreshed source 2c depth cap");
      }
      const expiredOrders = workingEntries.filter((order) => now - order.createdAt >= config.quote_model.quote_ttl_seconds * 1_000);
      const repriceOrders = workingEntries.filter((order) => {
        if (now - order.createdAt < config.quote_model.minimum_ordinary_rest_seconds * 1_000) return false;
        const qMoved = order.qSideAtPlacement !== undefined && Math.abs(candidate.qSide - order.qSideAtPlacement) * 100 + 1e-9 >= config.quote_model.reprice_on_q_move_pp;
        const bboMoved = order.bestBidAtPlacement !== undefined && Math.abs(candidate.bestBid - order.bestBidAtPlacement) + 1e-9 >= config.quote_model.reprice_on_bbo_move_ticks * candidate.tickSize;
        return qMoved || bboMoved;
      });
      if (!gate.passed) actions.push(...cancelOrders(market, isWorkingEntry, `entry gate failed: ${gate.reasons.join(", ")}`));
      else if (refreshedCapReasons.length > 0) actions.push(...cancelOrders(market, isWorkingEntry, refreshedCapReasons.join(", ")));
      else if (expiredOrders.length > 0) actions.push(...cancelOrders(market, (order) => expiredOrders.includes(order), "entry quote TTL"));
      else if (repriceOrders.length > 0) actions.push(...cancelOrders(market, (order) => repriceOrders.includes(order), "entry reprice threshold"));
      const resting = gate.passed && refreshedCapReasons.length === 0 && expiredOrders.length === 0 && repriceOrders.length === 0;
      records.push({
        ts: now,
        marketKey: market.marketKey,
        eventType,
        decision: resting ? "entry-resting" : "entry-canceled",
        reasons: [...gate.reasons, ...refreshedCapReasons],
        actions: actions.length,
      });
      continue;
    }
    // A Gamma refresh is cancellation-only for entry risk. The controller
    // deliberately reduces fresh catalog metadata before the same poll's Q
    // events; allowing this event to create inventory would therefore quote
    // from the previous signal. A subsequent signal, book, stability, or timer
    // event may reconsider the now-current catalog normally.
    if (eventType === "catalog") {
      records.push({
        ts: now,
        marketKey: market.marketKey,
        eventType,
        decision: gate.passed ? "entry-deferred" : "entry-rejected",
        reasons: gate.passed ? ["catalog-refresh-cancellation-only"] : gate.reasons,
        actions: 0,
        covariates: candidateCovariates(candidate),
      });
      continue;
    }
    records.push({ ts: now, marketKey: market.marketKey, eventType, decision: gate.passed ? "entry-eligible" : "entry-rejected", reasons: gate.reasons, actions: 0, covariates: candidateCovariates(candidate) });
    if (gate.passed) eligible.push(candidate);
  }

  const representedFamilies = new Set<CategoryFamily>();
  for (const market of Object.values(state.markets)) {
    if (marketCommittedUsd(market) <= 0 || !market.catalog) continue;
    const candidate = completeCandidate(market, config);
    if (candidate && candidate.categoryFamily !== "other") representedFamilies.add(candidate.categoryFamily);
  }
  const slots = Math.max(0, config.capital.max_live_orders - activeOrderCount(state));
  const selected = allocateCandidates(eligible, representedFamilies, slots, config).sort(compareCandidatePriority);
  for (const candidate of selected) {
    if (activeOrderCount(state) >= config.capital.max_live_orders) break;
    exposure = portfolioExposure(state, config);
    if (candidateCapReasons(candidate, exposure, config).length > 0) continue;
    const market = state.markets[candidate.marketKey]!;
    const totalRemaining = config.capital.max_total_inventory_and_pending_entry_cost_usd - exposure.totalUsd;
    const collateralRemaining = state.availableCollateralUsd - config.capital.minimum_free_collateral_usd - config.capital.operational_reserve_usd;
    const capacity = {
      globalRemainingUsd: Math.max(0, Math.min(totalRemaining, collateralRemaining)),
      marketCommittedUsd: marketCommittedUsd(market),
      eventRemainingUsd: Math.max(0, config.portfolio_risk.max_event_cost_usd - (exposure.eventUsd[candidate.eventId] ?? 0)),
      familyRemainingUsd: Math.max(0, config.portfolio_risk.max_category_family_cost_usd - (exposure.familyUsd[candidate.categoryFamily] ?? 0)),
      correlationRemainingUsd: candidate.manualCorrelationGroup
        ? Math.max(0, config.portfolio_risk.max_manual_correlation_group_cost_usd - (exposure.correlationUsd[candidate.manualCorrelationGroup] ?? 0))
        : Number.POSITIVE_INFINITY,
    };
    const quote = buildEntryQuote(candidate, capacity, config);
    if (!quote) continue;
    const clientId = nextClientId(state, candidate.marketKey, "entry");
    const action: Extract<MarketMakeAction, { kind: "place" }> = {
      kind: "place", clientId, marketKey: candidate.marketKey, marketRef: candidate.marketRef, conditionId: candidate.conditionId,
      tokenId: candidate.tokenId, outcome: candidate.side, side: "BUY", size: quote.size, limitPrice: quote.price,
      tif: "GTC", postOnly: true, purpose: "entry", reason: `Q-directed ${candidate.side} edge ${candidate.liveEdgePp.toFixed(2)}pp`,
    };
    planOrder(state, market, action, now, { qAsOf: candidate.qAsOf, qSide: candidate.qSide, bestBid: candidate.bestBid });
    actions.push(action);
    const record = records.findLast((candidateRecord) => candidateRecord.marketKey === candidate.marketKey);
    if (record) record.actions += 1;
  }
  return { actions, records };
}

/** Facts about a candidate that every entry decision records for offline covariate analysis. */
function candidateCovariates(candidate: NormalizedCandidate): EntryDecisionCovariates {
  return {
    side: candidate.side,
    liveEdgePp: candidate.liveEdgePp,
    qSide: candidate.qSide,
    qAsOf: candidate.qAsOf,
    forecastStatus: candidate.forecastStatus ?? "unknown",
    drawdownRiskElevated: candidate.drawdownRiskElevated,
    selectedSpreadPp: candidate.selectedSpreadPp,
    depthWithin2cUsd: candidate.depthWithin2cUsd,
    volatilityRegime: candidate.volatilityRegime,
  };
}

export function reduceMarketMake(previous: MarketMakeState, event: NormalizedMarketMakeEvent, config: MarketMakeConfig): ReducerResult {
  const state = structuredClone(previous);
  let immediate = applyEvent(state, event, config);
  const postFillCapReasons = event.type === "fill" && event.side === "BUY"
    ? hardPortfolioCapBreaches(state, config)
    : [];
  if (postFillCapReasons.length > 0) {
    state.halted = true;
    const forced = cancelEveryWorkingEntry(
      state,
      `post-fill hard-cap breach: ${postFillCapReasons.join(", ")}`,
    );
    const alreadyCanceled = new Set(immediate.flatMap((action) => action.kind === "cancel" ? [action.orderId] : []));
    immediate = [...immediate, ...forced.filter((action) => action.kind !== "cancel" || !alreadyCanceled.has(action.orderId))];
  }
  const exits = EXIT_DECISION_EVENTS.has(event.type)
    ? exitActions(state, event.ts, config)
    : { actions: [], records: [] };
  const entries = entryActions(state, event.ts, event.type, config);
  const actions = [...immediate, ...exits.actions, ...entries.actions];
  const summary: DecisionRecord = {
    ts: event.ts,
    marketKey: "marketKey" in event ? event.marketKey : event.type === "signal" ? event.signal.marketKey : event.type === "catalog" ? event.market.marketKey : undefined,
    eventType: event.type,
    decision: "event-reduced",
    reasons: [],
    actions: actions.length,
  };
  const decisions = [
    ...exits.records,
    ...entries.records,
    ...(postFillCapReasons.length > 0
      ? [{
          ts: event.ts,
          marketKey: event.type === "fill" ? event.marketKey : undefined,
          eventType: event.type,
          decision: "post-fill-hard-cap-breach",
          reasons: postFillCapReasons,
          actions: immediate.filter((action) => action.kind === "cancel").length,
        } satisfies DecisionRecord]
      : []),
    summary,
  ];
  state.decisions.push(...decisions);
  if (state.decisions.length > MAX_IN_MEMORY_DECISIONS) {
    state.decisions.splice(0, state.decisions.length - MAX_IN_MEMORY_DECISIONS);
  }
  return { state, actions, decisions };
}

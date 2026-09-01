// strategies/market-make/src/replay.ts
// Chronological offline runner with explicit fill-model sensitivity and acceptance telemetry.

import { bestAsk, bestBid, bookMid, categoryFamily } from "./math.js";
import { createInitialMarketMakeState, reduceMarketMake } from "./reducer.js";
import { portfolioExposure } from "./risk.js";
import { marketMakeConfigHash } from "./preset.js";
import { MarketMakeConfigSchema, MarketMakeReplayBundleSchema, type MarketMakeConfig } from "./schema.js";
import type {
  CategoryFamily,
  InventoryCycle,
  MarketCatalogSnapshot,
  MarketMakeAction,
  MarketMakeReplayBundle,
  MarketMakeReplayMetrics,
  MarketMakeReplayReport,
  MarketMakeReplayReportWithMetrics,
  MarketMakeState,
  NormalizedMarketMakeEvent,
  Outcome,
  ReplayCapitalUtilizationMetrics,
  ReplayFeeMetrics,
  ReplayFillMetrics,
  ReplayFillModel,
  ReplayInventoryDurationMetrics,
  ReplayMarkoutMetric,
  ReplayPerformanceCut,
  ReplayPnlMetrics,
  ReplayRateMetric,
  ReplayUsdMetric,
  TrackedOrder,
} from "./types.js";

export interface ReplayMarketMakeOptions {
  fillModel: ReplayFillModel;
}

type FillEvent = Extract<NormalizedMarketMakeEvent, { type: "fill" }>;
type BookEvent = Extract<NormalizedMarketMakeEvent, { type: "book" }>;

interface ReplayTags {
  marketKey: string;
  direction: Outcome | "UNKNOWN";
  category: string;
  categoryFamily: CategoryFamily | "unknown";
  eventId: string;
}

interface FillObservation extends ReplayTags {
  ts: number;
  fillId: string;
  orderKey: string;
  side: "BUY" | "SELL";
  tokenId: string;
  size: number;
  price: number;
  notionalUsd: number;
  feeUsd?: number;
  modeled: boolean;
  entryOrder: boolean;
}

interface RewardObservation extends ReplayTags {
  amountUsd: number;
}

interface RedemptionObservation extends ReplayTags {
  ts: number;
  payoutReported: boolean;
  quantityReported: boolean;
  accountedQuantity: number;
  unmatchedQuantity: number;
  accountedPayoutUsd: number;
  complete: boolean;
  unavailableReason?: string;
}

interface InventoryCycleObservation extends ReplayTags {
  openedAt: number;
  endedAt: number;
  closed: boolean;
}

interface InventoryLedger extends ReplayTags {
  tokenId: string;
  quantity: number;
  grossOpenCostUsd: number;
  knownOpenBuyFeesUsd: number;
  unknownOpenBuyFeeQuantity: number;
  realizedGrossUsd: number;
  realizedKnownFeesUsd: number;
  realizedFeeMissing: boolean;
  unmatchedSellQuantity: number;
  cycleStartedAt?: number;
}

interface BookObservation {
  ts: number;
  mid?: number;
  bid?: number;
}

interface FillContext {
  effectiveSize: number;
  order?: TrackedOrder;
  orderKey: string;
  entryOrder: boolean;
}

const EPSILON = 1e-9;
const UNKNOWN = "unknown";

function shouldModelFill(order: TrackedOrder, event: BookEvent, model: ReplayFillModel): boolean {
  if (model === "queue" || order.tokenId !== event.book.tokenId || order.outcome !== event.outcome) return false;
  if (order.status !== "PLANNED" && order.status !== "LIVE" && order.status !== "PARTIAL") return false;
  if (order.side === "BUY") {
    const ask = bestAsk(event.book);
    return ask !== undefined && (model === "touch" ? ask <= order.price : ask < order.price);
  }
  const bid = bestBid(event.book);
  return bid !== undefined && (model === "touch" ? bid >= order.price : bid > order.price);
}

function countActions(counts: Record<MarketMakeAction["kind"], number>, actions: MarketMakeAction[]): void {
  for (const action of actions) counts[action.kind] += 1;
}

function resolveOrder(state: MarketMakeState, event: FillEvent): TrackedOrder | undefined {
  const market = state.markets[event.marketKey];
  if (!market) return undefined;
  return market.orders[event.orderId]
    ?? (event.clientId ? market.orders[event.clientId] : undefined)
    ?? Object.values(market.orders).find((candidate) => candidate.clientId === event.orderId);
}

function fillContext(state: MarketMakeState, event: FillEvent, proposedEntryOrderIds: Set<string>): FillContext {
  const order = resolveOrder(state, event);
  const orderKey = order?.clientId ?? event.clientId ?? event.orderId;
  const effectiveSize = state.processedFillIds[event.fillId]
    ? 0
    : order
      ? Math.min(event.size, Math.max(0, order.size - order.filledSize))
      : event.size;
  return {
    effectiveSize,
    order,
    orderKey,
    entryOrder: order?.purpose === "entry" || proposedEntryOrderIds.has(orderKey),
  };
}

function replayRate(numerator: number, denominator: number, denominatorMeaning: string): ReplayRateMetric {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? numerator / denominator : null,
    denominatorMeaning,
    ...(denominator > 0 ? {} : { unavailableReason: "denominator is zero" }),
  };
}

function usdMetric(observedUsd: number, complete: boolean, unavailableReason?: string): ReplayUsdMetric {
  return {
    valueUsd: complete ? observedUsd : null,
    observedUsd,
    complete,
    ...(!complete && unavailableReason ? { unavailableReason } : {}),
  };
}

function metadataByMarket(events: Array<{ event: NormalizedMarketMakeEvent }>, config: MarketMakeConfig): Map<string, ReplayTags> {
  const result = new Map<string, ReplayTags>();
  for (const { event } of events) {
    if (event.type !== "catalog") continue;
    result.set(event.market.marketKey, tagsFromCatalog(event.market, config));
  }
  return result;
}

function tagsFromCatalog(catalog: MarketCatalogSnapshot, config: MarketMakeConfig): ReplayTags {
  return {
    marketKey: catalog.marketKey,
    direction: "UNKNOWN",
    category: catalog.category.trim() || UNKNOWN,
    categoryFamily: categoryFamily(catalog.category, config),
    eventId: catalog.eventId || UNKNOWN,
  };
}

function tagsForMarket(marketKey: string, outcome: Outcome | "UNKNOWN", metadata: Map<string, ReplayTags>): ReplayTags {
  const known = metadata.get(marketKey);
  return {
    marketKey,
    direction: outcome,
    category: known?.category ?? UNKNOWN,
    categoryFamily: known?.categoryFamily ?? "unknown",
    eventId: known?.eventId ?? UNKNOWN,
  };
}

function ledgerKey(marketKey: string, tokenId: string, outcome: Outcome): string {
  return `${marketKey}\u0000${tokenId}\u0000${outcome}`;
}

function createLedger(tags: ReplayTags, tokenId: string): InventoryLedger {
  return {
    ...tags,
    tokenId,
    quantity: 0,
    grossOpenCostUsd: 0,
    knownOpenBuyFeesUsd: 0,
    unknownOpenBuyFeeQuantity: 0,
    realizedGrossUsd: 0,
    realizedKnownFeesUsd: 0,
    realizedFeeMissing: false,
    unmatchedSellQuantity: 0,
  };
}

function getLedger(ledgers: Map<string, InventoryLedger>, fill: FillObservation): InventoryLedger {
  const key = ledgerKey(fill.marketKey, fill.tokenId, fill.direction as Outcome);
  const existing = ledgers.get(key);
  if (existing) return existing;
  const created = createLedger(fill, fill.tokenId);
  ledgers.set(key, created);
  return created;
}

function accountFill(
  ledgers: Map<string, InventoryLedger>,
  cycles: InventoryCycleObservation[],
  fill: FillObservation,
): void {
  const ledger = getLedger(ledgers, fill);
  if (fill.side === "BUY") {
    if (!(ledger.quantity > EPSILON)) ledger.cycleStartedAt = fill.ts;
    ledger.quantity += fill.size;
    ledger.grossOpenCostUsd += fill.notionalUsd;
    if (fill.feeUsd === undefined) ledger.unknownOpenBuyFeeQuantity += fill.size;
    else ledger.knownOpenBuyFeesUsd += fill.feeUsd;
    return;
  }

  const quantityBefore = ledger.quantity;
  const sold = Math.min(fill.size, quantityBefore);
  if (sold > EPSILON) {
    const fraction = sold / quantityBefore;
    const allocatedGrossCost = ledger.grossOpenCostUsd * fraction;
    const allocatedKnownBuyFees = ledger.knownOpenBuyFeesUsd * fraction;
    const allocatedUnknownBuyFeeQuantity = ledger.unknownOpenBuyFeeQuantity * fraction;
    const allocatedSellFee = fill.feeUsd === undefined ? 0 : fill.feeUsd * (sold / fill.size);
    ledger.realizedGrossUsd += sold * fill.price - allocatedGrossCost;
    ledger.realizedKnownFeesUsd += allocatedKnownBuyFees + allocatedSellFee;
    ledger.realizedFeeMissing ||= fill.feeUsd === undefined || allocatedUnknownBuyFeeQuantity > EPSILON;
    ledger.quantity = Math.max(0, quantityBefore - sold);
    ledger.grossOpenCostUsd = Math.max(0, ledger.grossOpenCostUsd - allocatedGrossCost);
    ledger.knownOpenBuyFeesUsd = Math.max(0, ledger.knownOpenBuyFeesUsd - allocatedKnownBuyFees);
    ledger.unknownOpenBuyFeeQuantity = Math.max(0, ledger.unknownOpenBuyFeeQuantity - allocatedUnknownBuyFeeQuantity);
    if (!(ledger.quantity > EPSILON) && ledger.cycleStartedAt !== undefined) {
      cycles.push({
        marketKey: ledger.marketKey,
        direction: ledger.direction,
        category: ledger.category,
        categoryFamily: ledger.categoryFamily,
        eventId: ledger.eventId,
        openedAt: ledger.cycleStartedAt,
        endedAt: fill.ts,
        closed: true,
      });
      ledger.cycleStartedAt = undefined;
    }
  }
  ledger.unmatchedSellQuantity += Math.max(0, fill.size - sold);
}

function seedReconciledInventory(
  ledgers: Map<string, InventoryLedger>,
  event: Extract<NormalizedMarketMakeEvent, { type: "inventory-reconciled" }>,
  metadata: Map<string, ReplayTags>,
): void {
  if (!(event.quantity > EPSILON)) return;
  const key = ledgerKey(event.marketKey, event.tokenId, event.outcome);
  if (ledgers.has(key)) return;
  const tags = tagsForMarket(event.marketKey, event.outcome, metadata);
  const ledger = createLedger(tags, event.tokenId);
  ledger.quantity = event.quantity;
  ledger.grossOpenCostUsd = event.costBasisUsd;
  // Reconciliation gives an authoritative gross basis but no historical fee
  // breakdown. Gross settlement P&L remains usable; net stays explicitly null.
  ledger.unknownOpenBuyFeeQuantity = event.quantity;
  ledger.cycleStartedAt = event.ts;
  ledgers.set(key, ledger);
}

function accountRedemption(
  ledgers: Map<string, InventoryLedger>,
  cycles: InventoryCycleObservation[],
  metadata: Map<string, ReplayTags>,
  event: Extract<NormalizedMarketMakeEvent, { type: "redemption" }>,
  inventory: InventoryCycle | undefined,
  lifecycle: { quantity?: number; payoutUsd?: number } | undefined,
): RedemptionObservation {
  const quantity = event.quantity ?? lifecycle?.quantity;
  const payoutUsd = event.payoutUsd ?? lifecycle?.payoutUsd;
  let ledger = inventory
    ? ledgers.get(ledgerKey(event.marketKey, inventory.tokenId, inventory.outcome))
    : undefined;

  if (!ledger && inventory && inventory.freeQuantity > EPSILON) {
    const tags = tagsForMarket(event.marketKey, inventory.outcome, metadata);
    ledger = createLedger(tags, inventory.tokenId);
    ledger.quantity = inventory.freeQuantity;
    ledger.grossOpenCostUsd = inventory.avgCost * inventory.freeQuantity;
    ledger.unknownOpenBuyFeeQuantity = inventory.freeQuantity;
    ledger.cycleStartedAt = inventory.firstFillAt;
    ledgers.set(ledgerKey(event.marketKey, inventory.tokenId, inventory.outcome), ledger);
  }

  if (!ledger) {
    const candidates = [...ledgers.values()].filter((candidate) =>
      candidate.marketKey === event.marketKey && candidate.quantity > EPSILON);
    if (candidates.length === 1) ledger = candidates[0];
  }

  const tags = ledger ?? tagsForMarket(event.marketKey, "UNKNOWN", metadata);
  const ledgerQuantity = ledger?.quantity ?? 0;
  const settlementQuantity = quantity ?? (ledgerQuantity > EPSILON ? ledgerQuantity : undefined);
  const matchedQuantity = settlementQuantity === undefined
    ? 0
    : Math.min(ledgerQuantity, settlementQuantity);
  const unmatchedQuantity = settlementQuantity === undefined
    ? ledgerQuantity
    : Math.abs(ledgerQuantity - settlementQuantity);
  let accountedPayoutUsd = 0;

  if (ledger && ledgerQuantity > EPSILON) {
    if (payoutUsd !== undefined && settlementQuantity !== undefined && settlementQuantity > EPSILON && matchedQuantity > EPSILON) {
      const matchedFraction = matchedQuantity / ledgerQuantity;
      accountedPayoutUsd = payoutUsd * (matchedQuantity / settlementQuantity);
      const allocatedGrossCost = ledger.grossOpenCostUsd * matchedFraction;
      const allocatedKnownBuyFees = ledger.knownOpenBuyFeesUsd * matchedFraction;
      const allocatedUnknownBuyFeeQuantity = ledger.unknownOpenBuyFeeQuantity * matchedFraction;
      ledger.realizedGrossUsd += accountedPayoutUsd - allocatedGrossCost;
      ledger.realizedKnownFeesUsd += allocatedKnownBuyFees;
      ledger.realizedFeeMissing ||= allocatedUnknownBuyFeeQuantity > EPSILON;
    }

    if (ledger.cycleStartedAt !== undefined) {
      cycles.push({
        marketKey: ledger.marketKey,
        direction: ledger.direction,
        category: ledger.category,
        categoryFamily: ledger.categoryFamily,
        eventId: ledger.eventId,
        openedAt: ledger.cycleStartedAt,
        endedAt: event.ts,
        closed: true,
      });
    }
    // A confirmed redemption is authoritative closure. Missing or mismatched
    // payout data makes accounting incomplete; it must not leave phantom open
    // inventory or invent settlement proceeds.
    ledger.quantity = 0;
    ledger.grossOpenCostUsd = 0;
    ledger.knownOpenBuyFeesUsd = 0;
    ledger.unknownOpenBuyFeeQuantity = 0;
    ledger.cycleStartedAt = undefined;
  }

  const complete = Boolean(ledger) && payoutUsd !== undefined && settlementQuantity !== undefined && unmatchedQuantity <= EPSILON;
  const unavailableReason = !ledger
    ? "confirmed redemption could not be matched to replay inventory"
    : payoutUsd === undefined
      ? "confirmed redemption omits payoutUsd"
      : settlementQuantity === undefined
        ? "confirmed redemption quantity is unavailable"
        : unmatchedQuantity > EPSILON
          ? "confirmed redemption quantity does not match replay inventory"
          : undefined;
  return {
    marketKey: tags.marketKey,
    direction: tags.direction,
    category: tags.category,
    categoryFamily: tags.categoryFamily,
    eventId: tags.eventId,
    ts: event.ts,
    payoutReported: payoutUsd !== undefined,
    quantityReported: quantity !== undefined,
    accountedQuantity: matchedQuantity,
    unmatchedQuantity,
    accountedPayoutUsd,
    complete,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

function bookSeriesKey(marketKey: string, tokenId: string, outcome: Outcome): string {
  return `${marketKey}\u0000${tokenId}\u0000${outcome}`;
}

function buildBookSeries(indexed: Array<{ event: NormalizedMarketMakeEvent }>): Map<string, BookObservation[]> {
  const result = new Map<string, BookObservation[]>();
  for (const { event } of indexed) {
    if (event.type !== "book") continue;
    const key = bookSeriesKey(event.marketKey, event.book.tokenId, event.outcome);
    const observations = result.get(key) ?? [];
    observations.push({ ts: event.ts, mid: bookMid(event.book), bid: bestBid(event.book) });
    result.set(key, observations);
  }
  return result;
}

function firstObservationAtOrAfter(observations: BookObservation[], target: number): BookObservation | undefined {
  let low = 0;
  let high = observations.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const observation = observations[middle];
    if (observation && observation.ts < target) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < observations.length; index += 1) {
    const observation = observations[index];
    if (observation?.mid !== undefined) return observation;
  }
  return undefined;
}

function latestExecutableBid(ledger: InventoryLedger, bookSeries: Map<string, BookObservation[]>): number | undefined {
  const observations = bookSeries.get(bookSeriesKey(ledger.marketKey, ledger.tokenId, ledger.direction as Outcome)) ?? [];
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index];
    if (observation && observation.bid !== undefined && observation.ts + EPSILON >= (ledger.cycleStartedAt ?? 0)) return observation.bid;
  }
  return undefined;
}

function buildFeeMetrics(fills: FillObservation[]): ReplayFeeMetrics {
  const reported = fills.filter((fill) => fill.feeUsd !== undefined);
  const reportedUsd = reported.reduce((sum, fill) => sum + (fill.feeUsd ?? 0), 0);
  const complete = reported.length === fills.length;
  return {
    reportedUsd,
    totalUsd: complete ? reportedUsd : null,
    fillsWithReportedFee: reported.length,
    effectiveFillEvents: fills.length,
    coverage: replayRate(reported.length, fills.length, "effective fill events"),
    ...(!complete ? { unavailableReason: "one or more effective fills omit feeUsd" } : {}),
  };
}

function buildRedemptionMetrics(redemptions: RedemptionObservation[]): ReplayPnlMetrics["redemptions"] {
  const withPayout = redemptions.filter((redemption) => redemption.payoutReported);
  const observedProceeds = redemptions.reduce((sum, redemption) => sum + redemption.accountedPayoutUsd, 0);
  const complete = redemptions.every((redemption) => redemption.complete);
  const firstFailure = redemptions.find((redemption) => !redemption.complete)?.unavailableReason;
  return {
    confirmedRedemptions: redemptions.length,
    redemptionsWithReportedPayout: withPayout.length,
    payoutCoverage: replayRate(withPayout.length, redemptions.length, "confirmed redemption events"),
    proceeds: usdMetric(observedProceeds, complete, firstFailure ?? "one or more redemptions lack complete settlement accounting"),
    accountedQuantity: redemptions.reduce((sum, redemption) => sum + redemption.accountedQuantity, 0),
    unmatchedQuantity: redemptions.reduce((sum, redemption) => sum + redemption.unmatchedQuantity, 0),
  };
}

function buildPnlMetrics(
  ledgers: InventoryLedger[],
  fills: FillObservation[],
  redemptions: RedemptionObservation[],
  rewardsUsd: number,
  bookSeries: Map<string, BookObservation[]>,
): ReplayPnlMetrics {
  let realizedGross = 0;
  let realizedKnownFees = 0;
  let unrealizedGross = 0;
  let unrealizedNet = 0;
  let unmatchedSellQuantity = 0;
  let realizedFeeMissing = false;
  let openFeeMissing = false;
  let pricedOpenInventoryPositions = 0;
  let missingMarks = 0;
  let openInventoryPositions = 0;

  for (const ledger of ledgers) {
    realizedGross += ledger.realizedGrossUsd;
    realizedKnownFees += ledger.realizedKnownFeesUsd;
    unmatchedSellQuantity += ledger.unmatchedSellQuantity;
    realizedFeeMissing ||= ledger.realizedFeeMissing;
    if (!(ledger.quantity > EPSILON)) continue;
    openInventoryPositions += 1;
    openFeeMissing ||= ledger.unknownOpenBuyFeeQuantity > EPSILON;
    const mark = latestExecutableBid(ledger, bookSeries);
    if (mark === undefined) {
      missingMarks += 1;
      continue;
    }
    pricedOpenInventoryPositions += 1;
    const gross = mark * ledger.quantity - ledger.grossOpenCostUsd;
    unrealizedGross += gross;
    unrealizedNet += gross - ledger.knownOpenBuyFeesUsd;
  }

  const accountingComplete = unmatchedSellQuantity <= EPSILON;
  const redemptionMetrics = buildRedemptionMetrics(redemptions);
  const redemptionAccountingComplete = redemptionMetrics.proceeds.complete;
  const realizedGrossComplete = accountingComplete && redemptionAccountingComplete;
  const realizedNetComplete = realizedGrossComplete && !realizedFeeMissing;
  const unrealizedGrossComplete = accountingComplete && missingMarks === 0;
  const unrealizedNetComplete = unrealizedGrossComplete && !openFeeMissing;
  const realizedNet = realizedGross - realizedKnownFees;
  const netObserved = realizedNet + unrealizedNet + rewardsUsd;
  const netComplete = realizedNetComplete && unrealizedNetComplete;
  const unmatchedReason = "unmatched SELL quantity prevents complete cost-basis accounting";
  const realizedIncompleteReason = !accountingComplete
    ? unmatchedReason
    : !redemptionAccountingComplete
      ? redemptionMetrics.proceeds.unavailableReason
      : undefined;

  return {
    realizedGross: usdMetric(realizedGross, realizedGrossComplete, realizedIncompleteReason),
    realizedNetAfterFees: usdMetric(
      realizedNet,
      realizedNetComplete,
      realizedIncompleteReason ?? "one or more realized fills or reconciled positions lack complete fee data",
    ),
    unrealizedGrossAtExecutableBid: usdMetric(
      unrealizedGross,
      unrealizedGrossComplete,
      accountingComplete ? "one or more open positions lack a terminal executable bid" : unmatchedReason,
    ),
    unrealizedNetAfterFeesAtExecutableBid: usdMetric(
      unrealizedNet,
      unrealizedNetComplete,
      accountingComplete && missingMarks === 0
        ? "one or more open BUY fills omit feeUsd"
        : accountingComplete
          ? "one or more open positions lack a terminal executable bid"
          : unmatchedReason,
    ),
    rewardsUsd,
    netAfterFeesAndRewards: usdMetric(
      netObserved,
      netComplete,
      "complete net P&L requires matched inventory, reported relevant fees, and executable terminal bids",
    ),
    fees: buildFeeMetrics(fills),
    redemptions: redemptionMetrics,
    openInventoryPositions,
    pricedOpenInventoryPositions,
    unmatchedSellQuantity,
  };
}

function buildInventoryDuration(cycles: InventoryCycleObservation[]): ReplayInventoryDurationMetrics {
  const durations = cycles.map((cycle) => Math.max(0, (cycle.endedAt - cycle.openedAt) / 1_000)).sort((a, b) => a - b);
  if (durations.length === 0) {
    return {
      cycles: 0,
      closedCycles: 0,
      openCycles: 0,
      averageSeconds: null,
      medianSeconds: null,
      maximumSeconds: null,
      unavailableReason: "no inventory cycles were observed",
    };
  }
  const middle = Math.floor(durations.length / 2);
  const median = durations.length % 2 === 1
    ? durations[middle]!
    : (durations[middle - 1]! + durations[middle]!) / 2;
  return {
    cycles: durations.length,
    closedCycles: cycles.filter((cycle) => cycle.closed).length,
    openCycles: cycles.filter((cycle) => !cycle.closed).length,
    averageSeconds: durations.reduce((sum, duration) => sum + duration, 0) / durations.length,
    medianSeconds: median,
    maximumSeconds: durations.at(-1)!,
  };
}

function buildMarkouts(
  fills: FillObservation[],
  horizons: number[],
  replayEndedAt: number | undefined,
  bookSeries: Map<string, BookObservation[]>,
): ReplayMarkoutMetric[] {
  return [...new Set(horizons)].sort((a, b) => a - b).map((horizonSeconds) => {
    const eligible = replayEndedAt === undefined
      ? []
      : fills.filter((fill) => fill.ts + horizonSeconds * 1_000 <= replayEndedAt);
    const observed: Array<{ pp: number; notionalUsd: number; lagSeconds: number }> = [];
    for (const fill of eligible) {
      const target = fill.ts + horizonSeconds * 1_000;
      const series = bookSeries.get(bookSeriesKey(fill.marketKey, fill.tokenId, fill.direction as Outcome)) ?? [];
      const mark = firstObservationAtOrAfter(series, target);
      if (mark?.mid === undefined) continue;
      const pp = 100 * (fill.side === "BUY" ? mark.mid - fill.price : fill.price - mark.mid);
      observed.push({ pp, notionalUsd: fill.notionalUsd, lagSeconds: (mark.ts - target) / 1_000 });
    }
    const totalWeight = observed.reduce((sum, row) => sum + row.notionalUsd, 0);
    const unavailableReason = eligible.length === 0
      ? "no fills reached this horizon before replay end"
      : observed.length === 0
        ? "no valid two-sided book was observed at or after this horizon"
        : undefined;
    return {
      horizonSeconds,
      eligibleFillCount: eligible.length,
      observedFillCount: observed.length,
      coverage: replayRate(observed.length, eligible.length, "fills that reached the markout horizon before replay end"),
      meanPp: observed.length > 0 ? observed.reduce((sum, row) => sum + row.pp, 0) / observed.length : null,
      notionalWeightedMeanPp: totalWeight > 0
        ? observed.reduce((sum, row) => sum + row.pp * row.notionalUsd, 0) / totalWeight
        : null,
      meanObservationLagSeconds: observed.length > 0
        ? observed.reduce((sum, row) => sum + row.lagSeconds, 0) / observed.length
        : null,
      ...(unavailableReason ? { unavailableReason } : {}),
    };
  });
}

function buildPerformanceCut(
  ledgers: InventoryLedger[],
  fills: FillObservation[],
  redemptions: RedemptionObservation[],
  rewards: RewardObservation[],
  cycles: InventoryCycleObservation[],
  horizons: number[],
  replayEndedAt: number | undefined,
  bookSeries: Map<string, BookObservation[]>,
  selector: (candidate: ReplayTags) => boolean,
): ReplayPerformanceCut {
  const selectedLedgers = ledgers.filter(selector);
  const selectedFills = fills.filter(selector);
  const selectedRedemptions = redemptions.filter(selector);
  const selectedRewards = rewards.filter(selector);
  const selectedCycles = cycles.filter(selector);
  const markets = new Set<string>();
  for (const row of [...selectedLedgers, ...selectedFills, ...selectedRedemptions, ...selectedRewards]) markets.add(row.marketKey);
  const rewardsUsd = selectedRewards.reduce((sum, reward) => sum + reward.amountUsd, 0);
  const buyNotionalUsd = selectedFills.filter((fill) => fill.side === "BUY").reduce((sum, fill) => sum + fill.notionalUsd, 0);
  const sellNotionalUsd = selectedFills.filter((fill) => fill.side === "SELL").reduce((sum, fill) => sum + fill.notionalUsd, 0);
  return {
    markets: markets.size,
    effectiveFillEvents: selectedFills.length,
    filledOrders: new Set(selectedFills.map((fill) => fill.orderKey)).size,
    buyNotionalUsd,
    sellNotionalUsd,
    turnoverUsd: buyNotionalUsd + sellNotionalUsd,
    pnl: buildPnlMetrics(selectedLedgers, selectedFills, selectedRedemptions, rewardsUsd, bookSeries),
    inventoryDuration: buildInventoryDuration(selectedCycles),
    markouts: buildMarkouts(selectedFills, horizons, replayEndedAt, bookSeries),
  };
}

function mapCuts(
  keys: string[],
  selector: (key: string, candidate: ReplayTags) => boolean,
  ledgers: InventoryLedger[],
  fills: FillObservation[],
  redemptions: RedemptionObservation[],
  rewards: RewardObservation[],
  cycles: InventoryCycleObservation[],
  horizons: number[],
  replayEndedAt: number | undefined,
  bookSeries: Map<string, BookObservation[]>,
): Record<string, ReplayPerformanceCut> {
  return Object.fromEntries([...new Set(keys)].sort().map((key) => [
    key,
    buildPerformanceCut(
      ledgers,
      fills,
      redemptions,
      rewards,
      cycles,
      horizons,
      replayEndedAt,
      bookSeries,
      (candidate) => selector(key, candidate),
    ),
  ]));
}

function capitalMetrics(
  config: MarketMakeConfig,
  observationSeconds: number,
  peakDeployedUsd: number,
  deployedUsdSeconds: number,
): ReplayCapitalUtilizationMetrics {
  const averageDeployedUsd = observationSeconds > 0 ? deployedUsdSeconds / observationSeconds : null;
  const deploymentLimitUsd = config.capital.max_total_inventory_and_pending_entry_cost_usd;
  const sizingBankrollUsd = config.capital.sizing_bankroll_usd;
  return {
    basis: "inventory-cost-plus-pending-entry",
    deploymentLimitUsd,
    sizingBankrollUsd,
    observationSeconds,
    peakDeployedUsd,
    averageDeployedUsd,
    peakFractionOfDeploymentLimit: peakDeployedUsd / deploymentLimitUsd,
    averageFractionOfDeploymentLimit: averageDeployedUsd === null ? null : averageDeployedUsd / deploymentLimitUsd,
    peakFractionOfSizingBankroll: peakDeployedUsd / sizingBankrollUsd,
    averageFractionOfSizingBankroll: averageDeployedUsd === null ? null : averageDeployedUsd / sizingBankrollUsd,
    ...(averageDeployedUsd === null ? { unavailableReason: "replay has no positive-duration observation window" } : {}),
  };
}

export function replayMarketMake(
  bundleInput: MarketMakeReplayBundle,
  configInput: MarketMakeConfig,
  options: ReplayMarketMakeOptions,
): MarketMakeReplayReportWithMetrics {
  if (!(["queue", "trade-through", "touch"] as const).includes(options.fillModel)) {
    throw new Error(`unknown market-make fill model: ${String(options.fillModel)}`);
  }
  const bundle = MarketMakeReplayBundleSchema.parse(bundleInput) as MarketMakeReplayBundle;
  const config = MarketMakeConfigSchema.parse(configInput);
  const indexed = bundle.events.map((event, index) => ({ event, index }));
  indexed.sort((a, b) => a.event.ts - b.event.ts || a.index - b.index);
  const marketMetadata = metadataByMarket(indexed, config);
  const bookSeries = buildBookSeries(indexed);
  let state = createInitialMarketMakeState(config);
  const actionsByKind: Record<MarketMakeAction["kind"], number> = { place: 0, cancel: 0, redeem: 0 };
  let actionsProposed = 0;
  const decisions: MarketMakeReplayReport["decisions"] = [];
  const proposedEntryOrderIds = new Set<string>();
  const filledOrderIds = new Set<string>();
  const filledEntryOrderIds = new Set<string>();
  const filledProposedEntryOrderIds = new Set<string>();
  const fills: FillObservation[] = [];
  const redemptions: RedemptionObservation[] = [];
  const rewards: RewardObservation[] = [];
  const ledgers = new Map<string, InventoryLedger>();
  const closedCycles: InventoryCycleObservation[] = [];
  let explicitEffectiveFillEvents = 0;
  let modeledEffectiveFillEvents = 0;
  let ignoredOrDuplicateInputFillEvents = 0;
  let priorExposureUsd = 0;
  let peakDeployedUsd = 0;
  let deployedUsdSeconds = 0;
  let capitalTimestamp = indexed.at(0)?.event.ts;

  const recordActions = (actions: MarketMakeAction[]): void => {
    actionsProposed += actions.length;
    countActions(actionsByKind, actions);
    for (const action of actions) {
      if (action.kind === "place" && action.purpose === "entry") proposedEntryOrderIds.add(action.clientId);
    }
  };

  const processFill = (event: FillEvent, modeled: boolean): void => {
    const context = fillContext(state, event, proposedEntryOrderIds);
    const reduced = reduceMarketMake(state, event, config);
    state = reduced.state;
    decisions.push(...reduced.decisions);
    recordActions(reduced.actions);
    if (!(context.effectiveSize > EPSILON)) {
      if (!modeled) ignoredOrDuplicateInputFillEvents += 1;
      return;
    }
    if (modeled) modeledEffectiveFillEvents += 1;
    else explicitEffectiveFillEvents += 1;
    const tags = tagsForMarket(event.marketKey, event.outcome, marketMetadata);
    const observation: FillObservation = {
      ...tags,
      ts: event.ts,
      fillId: event.fillId,
      orderKey: context.orderKey,
      side: event.side,
      tokenId: event.tokenId,
      size: context.effectiveSize,
      price: event.price,
      notionalUsd: context.effectiveSize * event.price,
      ...(event.feeUsd === undefined ? {} : { feeUsd: event.feeUsd }),
      modeled,
      entryOrder: context.entryOrder,
    };
    fills.push(observation);
    filledOrderIds.add(context.orderKey);
    if (context.entryOrder) filledEntryOrderIds.add(context.orderKey);
    if (proposedEntryOrderIds.has(context.orderKey)) filledProposedEntryOrderIds.add(context.orderKey);
    accountFill(ledgers, closedCycles, observation);
  };

  for (const { event } of indexed) {
    if (capitalTimestamp !== undefined) {
      deployedUsdSeconds += priorExposureUsd * Math.max(0, (event.ts - capitalTimestamp) / 1_000);
      capitalTimestamp = event.ts;
    }

    if (event.type === "fill") {
      processFill(event, false);
    } else {
      const priorRedemption = event.type === "redemption"
        ? state.markets[event.marketKey]?.redemption
        : undefined;
      const priorInventory = event.type === "redemption"
        ? state.markets[event.marketKey]?.inventory
        : undefined;
      const duplicateConfirmation = event.type === "redemption" &&
        event.status === "confirmed" &&
        priorRedemption?.status === "confirmed";
      const reduced = reduceMarketMake(state, event, config);
      state = reduced.state;
      decisions.push(...reduced.decisions);
      recordActions(reduced.actions);

      if (event.type === "inventory-reconciled") {
        seedReconciledInventory(ledgers, event, marketMetadata);
      }

      if (event.type === "redemption" && event.status === "confirmed" && !duplicateConfirmation) {
        redemptions.push(accountRedemption(
          ledgers,
          closedCycles,
          marketMetadata,
          event,
          priorInventory,
          priorRedemption,
        ));
      }

      if (event.type === "reward") {
        rewards.push({ ...tagsForMarket(event.marketKey, "UNKNOWN", marketMetadata), amountUsd: event.amountUsd });
      }

      if (event.type === "book" && options.fillModel !== "queue") {
        const market = state.markets[event.marketKey];
        const modelable = market
          ? Object.values(market.orders).filter((order) => shouldModelFill(order, event, options.fillModel))
          : [];
        for (const order of modelable) {
          const remaining = Math.max(0, order.size - order.filledSize);
          if (!(remaining > 0)) continue;
          processFill({
            type: "fill",
            ts: event.ts,
            fillId: `replay:${options.fillModel}:${event.ts}:${order.orderId}:${order.filledSize}`,
            orderId: order.orderId,
            marketKey: order.marketKey,
            tokenId: order.tokenId,
            outcome: order.outcome,
            side: order.side,
            size: remaining,
            price: order.price,
          }, true);
        }
      }
    }

    priorExposureUsd = portfolioExposure(state, config).totalUsd;
    peakDeployedUsd = Math.max(peakDeployedUsd, priorExposureUsd);
  }

  const first = indexed.at(0)?.event.ts;
  const last = indexed.at(-1)?.event.ts;
  const marketDirections = new Map<string, Set<Outcome>>();
  for (const fill of fills) {
    const outcomes = marketDirections.get(fill.marketKey) ?? new Set<Outcome>();
    if (fill.direction !== "UNKNOWN") outcomes.add(fill.direction);
    marketDirections.set(fill.marketKey, outcomes);
  }
  for (const reward of rewards) {
    const outcomes = marketDirections.get(reward.marketKey);
    reward.direction = outcomes?.size === 1 ? [...outcomes][0]! : "UNKNOWN";
  }

  const cycles = [...closedCycles];
  if (last !== undefined) {
    for (const ledger of ledgers.values()) {
      if (ledger.quantity > EPSILON && ledger.cycleStartedAt !== undefined) {
        cycles.push({
          marketKey: ledger.marketKey,
          direction: ledger.direction,
          category: ledger.category,
          categoryFamily: ledger.categoryFamily,
          eventId: ledger.eventId,
          openedAt: ledger.cycleStartedAt,
          endedAt: last,
          closed: false,
        });
      }
    }
  }

  const ledgerValues = [...ledgers.values()];
  const horizons = config.telemetry.markout_horizons_seconds;
  const totalRewardsUsd = rewards.reduce((sum, reward) => sum + reward.amountUsd, 0);
  const fillMetrics: ReplayFillMetrics = {
    inputFillEvents: indexed.filter(({ event }) => event.type === "fill").length,
    explicitEffectiveFillEvents,
    modeledEffectiveFillEvents,
    ignoredOrDuplicateInputFillEvents,
    effectiveFillEvents: fills.length,
    filledOrders: filledOrderIds.size,
    filledEntryOrders: filledEntryOrderIds.size,
    totalQuantity: fills.reduce((sum, fill) => sum + fill.size, 0),
    totalNotionalUsd: fills.reduce((sum, fill) => sum + fill.notionalUsd, 0),
    proposedEntryOrderFillRate: replayRate(
      filledProposedEntryOrderIds.size,
      proposedEntryOrderIds.size,
      "distinct strategy-proposed entry order client ids",
    ),
  };

  const categoryKeys = [...fills, ...redemptions, ...rewards].map((row) => row.category);
  const categoryFamilyKeys = [...fills, ...redemptions, ...rewards].map((row) => row.categoryFamily);
  const eventKeys = [...fills, ...redemptions, ...rewards].map((row) => row.eventId);
  const directionKeys: Array<Outcome | "UNKNOWN"> = ["YES", "NO", "UNKNOWN"];
  const cutsByDirection = mapCuts(
    directionKeys,
    (key, candidate) => candidate.direction === key,
    ledgerValues,
    fills,
    redemptions,
    rewards,
    cycles,
    horizons,
    last,
    bookSeries,
  ) as Record<Outcome | "UNKNOWN", ReplayPerformanceCut>;
  const cutsByCategory = mapCuts(
    categoryKeys,
    (key, candidate) => candidate.category === key,
    ledgerValues,
    fills,
    redemptions,
    rewards,
    cycles,
    horizons,
    last,
    bookSeries,
  );
  const cutsByCategoryFamily = mapCuts(
    categoryFamilyKeys,
    (key, candidate) => candidate.categoryFamily === key,
    ledgerValues,
    fills,
    redemptions,
    rewards,
    cycles,
    horizons,
    last,
    bookSeries,
  );
  const cutsByEvent = mapCuts(
    eventKeys,
    (key, candidate) => candidate.eventId === key,
    ledgerValues,
    fills,
    redemptions,
    rewards,
    cycles,
    horizons,
    last,
    bookSeries,
  );

  const metrics: MarketMakeReplayMetrics = {
    fills: fillMetrics,
    pnl: buildPnlMetrics(ledgerValues, fills, redemptions, totalRewardsUsd, bookSeries),
    inventoryDuration: buildInventoryDuration(cycles),
    capitalUtilization: capitalMetrics(
      config,
      first === undefined || last === undefined ? 0 : Math.max(0, (last - first) / 1_000),
      peakDeployedUsd,
      deployedUsdSeconds,
    ),
    markouts: buildMarkouts(fills, horizons, last, bookSeries),
    cuts: {
      byDirection: cutsByDirection,
      byCategory: cutsByCategory,
      byCategoryFamily: cutsByCategoryFamily,
      byEvent: cutsByEvent,
    },
  };

  const caveatByModel: Record<ReplayFillModel, string> = {
    queue: "Queue model fills only explicit recorded fill events; missing queue-depletion data remains unfilled.",
    "trade-through": "Trade-through model assumes a full fill only after the opposite touch moves strictly through the resting limit.",
    touch: "Touch model assumes a full fill when the opposite touch reaches the limit and is optimistic sensitivity only.",
  };
  return {
    schemaVersion: "cassie-market-make-replay-report/1",
    configHash: marketMakeConfigHash(config),
    bankrollBasis: {
      basis: "configured-reference",
      policyMode: config.cassie_overrides.bankroll.mode,
      sizingBankrollUsd: config.capital.sizing_bankroll_usd,
      maximumSizingBankrollUsd: config.cassie_overrides.bankroll.maximum_sizing_bankroll_usd,
    },
    fillModel: options.fillModel,
    source: bundle.source,
    startedAt: first === undefined ? undefined : new Date(first).toISOString(),
    endedAt: last === undefined ? undefined : new Date(last).toISOString(),
    eventsProcessed: indexed.length,
    actionsProposed,
    actionsByKind,
    decisions,
    finalState: state,
    metrics,
    caveats: [
      caveatByModel[options.fillModel],
      "Historical results without contemporaneous two-sided BBO, fees, and authenticated fills are diagnostic rather than executable P&L.",
      "Liquidity rewards are recorded only when supplied as events and never alter gates, sizing, or holding decisions.",
      "Markouts use the first valid two-sided midpoint at or after each horizon; coverage and observation lag are reported explicitly.",
      "Unreported fees, missing redemption payouts, and missing executable terminal bids remain null where required rather than being assumed zero.",
    ],
  };
}

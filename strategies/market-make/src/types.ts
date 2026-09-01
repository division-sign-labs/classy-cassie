// strategies/market-make/src/types.ts
// Runtime-independent contracts for the deterministic market-making reducer.

export type Outcome = "YES" | "NO";
export type CategoryFamily = "international" | "domestic" | "macro_business" | "culture_tech" | "other";
export type VolatilityRegime = "dead" | "normal" | "high" | "extreme";
export type ForecastStatus = "converged" | "converging" | "sideways" | "diverging" | "caution" | "warning";

export interface BookLevel {
  price: number;
  /** Outcome-token quantity, not USD. */
  size: number;
}

export interface TokenBook {
  tokenId: string;
  bids: BookLevel[];
  asks: BookLevel[];
  ts: number;
}

export interface PublishedSignalInput {
  id: string;
  marketKey: string;
  nativeMarketId: string;
  conditionId: string;
  publishedAt: number;
  /** Frozen publication values are intentionally 0..100. */
  entryQ: number;
  entryPm: number;
  /** Current canonical YES probability is intentionally 0..1. */
  latestQ: number;
  qAsOf: number;
  active: boolean;
  livePriced: boolean;
  suppressionReason?: string | null;
  retiredReason?: "flipped" | "fading_q" | "expired" | "resolved" | null;
  forecastStatus?: ForecastStatus;
  drawdownRiskElevated?: boolean;
}

export interface NormalizedSignal extends PublishedSignalInput {
  qYesAtPublish: number;
  marketYesAtPublish: number;
  qYes: number;
}

export interface MarketCatalogSnapshot {
  marketKey: string;
  nativeMarketId: string;
  conditionId: string;
  marketRef: string;
  eventId: string;
  category: string;
  manualCorrelationGroup?: string;
  yesTokenId: string;
  noTokenId: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  acceptingOrders: boolean;
  orderbookEnabled: boolean;
  endsAt: number;
  volume24hUsd: number;
  tickSize: number;
  minOrderSize: number;
  rewardRateUsd?: number;
}

export interface VolatilitySnapshot {
  rv24Pp: number;
  acceleration: number;
}

export interface StabilitySnapshot {
  validSince: number;
  maxMoveAwayFromQPp: number;
}

export interface NormalizedCandidate {
  marketKey: string;
  marketRef: string;
  nativeMarketId: string;
  conditionId: string;
  eventId: string;
  category: string;
  categoryFamily: CategoryFamily;
  manualCorrelationGroup?: string;
  signalId: string;
  qAsOf: number;
  side: Outcome;
  tokenId: string;
  qSide: number;
  midSide: number;
  yesMid: number;
  noMid: number;
  liveEdgePp: number;
  selectedSpreadPp: number;
  depthWithin1cUsd: number;
  depthWithin2cUsd: number;
  bestBidLevelUsd: number;
  bestBid: number;
  bestAsk: number;
  tickSize: number;
  minOrderSize: number;
  volume24hUsd: number;
  forecastStatus?: ForecastStatus;
  retiredReason?: NormalizedSignal["retiredReason"];
  drawdownRiskElevated: boolean;
  volatility: VolatilitySnapshot;
  volatilityRegime: VolatilityRegime;
  stability: StabilitySnapshot;
  rewardRateUsd: number;
  signal: NormalizedSignal;
  market: MarketCatalogSnapshot;
}

export interface GateDecision {
  passed: boolean;
  reasons: string[];
  hardSanityFailure: boolean;
}

export type OrderPurpose = "entry" | "inventory-reduction" | "normal-exit" | "urgent-exit";

export type MarketMakeAction =
  | {
      kind: "place";
      clientId: string;
      marketKey: string;
      marketRef: string;
      conditionId: string;
      tokenId: string;
      outcome: Outcome;
      side: "BUY" | "SELL";
      size: number;
      limitPrice: number;
      tif: "GTC" | "FAK";
      postOnly: boolean;
      purpose: OrderPurpose;
      reason: string;
    }
  | {
      kind: "cancel";
      orderId: string;
      marketKey: string;
      marketRef: string;
      reason: string;
    }
  | {
      kind: "redeem";
      marketKey: string;
      marketRef: string;
      reason: string;
    };

export interface QuoteCapacity {
  globalRemainingUsd: number;
  marketCommittedUsd: number;
  eventRemainingUsd: number;
  familyRemainingUsd: number;
  correlationRemainingUsd: number;
}

export interface EntryQuote {
  price: number;
  size: number;
  notionalUsd: number;
  requestedUsd: number;
  marketInventoryCapUsd: number;
  limitingCap: string;
}

export type ExitUrgency = "none" | "normal" | "urgent";

export interface InventoryCycle {
  marketKey: string;
  marketRef: string;
  conditionId: string;
  tokenId: string;
  outcome: Outcome;
  freeQuantity: number;
  reservedSellQuantity: number;
  avgCost: number;
  cashPaidUsd: number;
  cashReceivedUsd: number;
  firstFillAt: number;
  anchorQAsOf: number;
  anchorQSide: number;
  anchorFillPrice: number;
  initialEdgePp: number;
  renewalUsed: boolean;
  extensionUntil?: number;
  exitStartedAt?: number;
  exitUrgency?: Exclude<ExitUrgency, "none">;
  urgentAttempts: number;
}

export interface ExitDecision {
  urgency: ExitUrgency;
  reason?: string;
  cancelAdds: boolean;
  remainingEdgePp: number;
  capturedFraction: number;
  renewal?: { extensionUntil: number; qAsOf: number };
}

export interface TrackedOrder {
  orderId: string;
  clientId: string;
  marketKey: string;
  marketRef: string;
  conditionId: string;
  tokenId: string;
  outcome: Outcome;
  side: "BUY" | "SELL";
  size: number;
  filledSize: number;
  price: number;
  tif: "GTC" | "FAK";
  postOnly: boolean;
  qAsOfAtPlacement?: number;
  qSideAtPlacement?: number;
  bestBidAtPlacement?: number;
  purpose: OrderPurpose;
  status: "PLANNED" | "LIVE" | "PARTIAL" | "CANCEL_PENDING" | "CANCELED" | "FILLED" | "REJECTED" | "UNKNOWN";
  createdAt: number;
}

export interface MarketRuntimeState {
  marketKey: string;
  signal?: NormalizedSignal;
  catalog?: MarketCatalogSnapshot;
  yesBook?: TokenBook;
  noBook?: TokenBook;
  volatility?: VolatilitySnapshot;
  stability?: StabilitySnapshot;
  inventory?: InventoryCycle;
  orders: Record<string, TrackedOrder>;
  lastInventoryIncreasingFillAt?: number;
  /** Q version consumed by the most recent inventory-increasing fill. */
  lastInventoryIncreasingQAsOf?: number;
  inventoryIncreasingFillsByUtcDay: Record<string, number>;
  shockPausedUntil: number;
  requireQAfterShockAsOf?: number;
  redemption?: {
    status: "pending" | "submitted" | "failed" | "confirmed";
    attempts: number;
    lastAttemptAt: number;
    /** Outcome shares covered by this redemption lifecycle, when verified. */
    quantity?: number;
    /** Venue-reported or position-derived settlement proceeds; zero is valid. */
    payoutUsd?: number;
    /** Public venue transaction/reference id only; never a signed payload. */
    reference?: string;
    error?: string;
  };
  /** @deprecated Read only when restoring a pre-lifecycle v1 snapshot. */
  redemptionRequested?: boolean;
  lastDecision?: DecisionRecord;
}

export interface LossSnapshot {
  marketLossUsd: Record<string, number>;
  rolling24hLossUsd: number;
  drawdownUsd: number;
}

export interface MarketMakeState {
  schemaVersion: "cassie-market-make-state/1";
  sequence: number;
  markets: Record<string, MarketRuntimeState>;
  processedFillIds: Record<string, true>;
  recentShocks: Array<{ marketKey: string; ts: number }>;
  globalEntryPausedUntil: number;
  consecutiveOrderRejections: number;
  halted: boolean;
  liquidateRequested: boolean;
  lossLatched: boolean;
  loss: LossSnapshot;
  availableCollateralUsd: number;
  decisions: DecisionRecord[];
}

export interface DecisionRecord {
  ts: number;
  marketKey?: string;
  eventType: NormalizedMarketMakeEvent["type"];
  decision: string;
  reasons: string[];
  actions: number;
  /** Runtime-only sizing identity attached before a live decision is persisted. */
  sizing?: {
    policyConfigHash: string;
    effectiveConfigHash: string;
    bankrollMode: "live" | "fixed";
    bankrollObserved: boolean;
    bankrollEntryReady: boolean;
    bankrollRefreshPending: boolean;
    strategyCapitalUsd: number;
    effectiveBankrollUsd: number;
    bankrollReferenceUsd: number;
    bankrollCeilingUsd?: number;
    bankrollScale: number;
  };
}

export type NormalizedMarketMakeEvent =
  | { type: "signal"; ts: number; signal: PublishedSignalInput }
  | { type: "catalog"; ts: number; market: MarketCatalogSnapshot }
  | { type: "book"; ts: number; marketKey: string; outcome: Outcome; book: TokenBook }
  | { type: "volatility"; ts: number; marketKey: string; volatility: VolatilitySnapshot }
  | { type: "stability"; ts: number; marketKey: string; stability: StabilitySnapshot }
  | {
      type: "fill";
      ts: number;
      fillId: string;
      orderId: string;
      clientId?: string;
      marketKey: string;
      tokenId: string;
      outcome: Outcome;
      side: "BUY" | "SELL";
      size: number;
      price: number;
      feeUsd?: number;
    }
  | { type: "order"; ts: number; marketKey: string; order: TrackedOrder }
  | { type: "cancel-confirmed"; ts: number; marketKey: string; orderId: string }
  | { type: "timer"; ts: number }
  | { type: "balance"; ts: number; availableCollateralUsd: number }
  | { type: "loss"; ts: number; loss: LossSnapshot }
  | { type: "shock"; ts: number; marketKey: string; adverse: boolean; reason: string }
  | { type: "reward"; ts: number; marketKey: string; amountUsd: number }
  | {
      type: "inventory-reconciled";
      ts: number;
      marketKey: string;
      tokenId: string;
      outcome: Outcome;
      quantity: number;
      costBasisUsd: number;
      reason: string;
    }
  | {
      type: "redemption";
      ts: number;
      marketKey: string;
      status: "submitted" | "failed" | "confirmed";
      quantity?: number;
      payoutUsd?: number;
      /** Public venue transaction/reference id only; never a signed payload. */
      reference?: string;
      error?: string;
    }
  | {
      type: "execution";
      ts: number;
      marketKey: string;
      clientId: string;
      status: "accepted" | "rejected";
      reason?: string;
    }
  | { type: "halt"; ts: number; liquidate: boolean }
  | { type: "resume"; ts: number; acknowledgeLossReset: boolean };

export interface ReducerResult {
  state: MarketMakeState;
  actions: MarketMakeAction[];
  decisions: DecisionRecord[];
}

export type ReplayFillModel = "queue" | "trade-through" | "touch";

export interface MarketMakeReplayBundle {
  schemaVersion: "cassie-market-make-replay/1";
  generatedAt: string;
  source: string;
  events: NormalizedMarketMakeEvent[];
}

export interface ReplayRateMetric {
  numerator: number;
  denominator: number;
  rate: number | null;
  denominatorMeaning: string;
  unavailableReason?: string;
}

export interface ReplayUsdMetric {
  /** Complete value, or null when the normalized bundle lacks an input needed to value it faithfully. */
  valueUsd: number | null;
  /** Sum from the subset that can be valued; never promoted to the complete value when coverage is partial. */
  observedUsd: number;
  complete: boolean;
  unavailableReason?: string;
}

export interface ReplayFeeMetrics {
  reportedUsd: number;
  totalUsd: number | null;
  fillsWithReportedFee: number;
  effectiveFillEvents: number;
  coverage: ReplayRateMetric;
  unavailableReason?: string;
}

export interface ReplayPnlMetrics {
  realizedGross: ReplayUsdMetric;
  realizedNetAfterFees: ReplayUsdMetric;
  unrealizedGrossAtExecutableBid: ReplayUsdMetric;
  unrealizedNetAfterFeesAtExecutableBid: ReplayUsdMetric;
  rewardsUsd: number;
  netAfterFeesAndRewards: ReplayUsdMetric;
  fees: ReplayFeeMetrics;
  redemptions: ReplayRedemptionMetrics;
  openInventoryPositions: number;
  pricedOpenInventoryPositions: number;
  unmatchedSellQuantity: number;
}

export interface ReplayRedemptionMetrics {
  confirmedRedemptions: number;
  redemptionsWithReportedPayout: number;
  payoutCoverage: ReplayRateMetric;
  /** Total confirmed settlement proceeds, null unless every redemption is faithfully accounted. */
  proceeds: ReplayUsdMetric;
  accountedQuantity: number;
  unmatchedQuantity: number;
}

export interface ReplayInventoryDurationMetrics {
  cycles: number;
  closedCycles: number;
  openCycles: number;
  averageSeconds: number | null;
  medianSeconds: number | null;
  maximumSeconds: number | null;
  unavailableReason?: string;
}

export interface ReplayCapitalUtilizationMetrics {
  /** Inventory at average cost plus pending BUY notional, matching portfolio risk accounting. */
  basis: "inventory-cost-plus-pending-entry";
  deploymentLimitUsd: number;
  sizingBankrollUsd: number;
  observationSeconds: number;
  peakDeployedUsd: number;
  averageDeployedUsd: number | null;
  peakFractionOfDeploymentLimit: number;
  averageFractionOfDeploymentLimit: number | null;
  peakFractionOfSizingBankroll: number;
  averageFractionOfSizingBankroll: number | null;
  unavailableReason?: string;
}

export interface ReplayMarkoutMetric {
  horizonSeconds: number;
  /** Fills old enough to have reached this horizon before the replay ended. */
  eligibleFillCount: number;
  observedFillCount: number;
  coverage: ReplayRateMetric;
  meanPp: number | null;
  notionalWeightedMeanPp: number | null;
  meanObservationLagSeconds: number | null;
  unavailableReason?: string;
}

export interface ReplayPerformanceCut {
  markets: number;
  effectiveFillEvents: number;
  filledOrders: number;
  buyNotionalUsd: number;
  sellNotionalUsd: number;
  turnoverUsd: number;
  pnl: ReplayPnlMetrics;
  inventoryDuration: ReplayInventoryDurationMetrics;
  markouts: ReplayMarkoutMetric[];
}

export interface ReplayFillMetrics {
  inputFillEvents: number;
  explicitEffectiveFillEvents: number;
  modeledEffectiveFillEvents: number;
  ignoredOrDuplicateInputFillEvents: number;
  effectiveFillEvents: number;
  filledOrders: number;
  filledEntryOrders: number;
  totalQuantity: number;
  totalNotionalUsd: number;
  proposedEntryOrderFillRate: ReplayRateMetric;
}

export interface MarketMakeReplayMetrics {
  fills: ReplayFillMetrics;
  pnl: ReplayPnlMetrics;
  inventoryDuration: ReplayInventoryDurationMetrics;
  capitalUtilization: ReplayCapitalUtilizationMetrics;
  markouts: ReplayMarkoutMetric[];
  cuts: {
    byDirection: Record<Outcome | "UNKNOWN", ReplayPerformanceCut>;
    byCategory: Record<string, ReplayPerformanceCut>;
    byCategoryFamily: Partial<Record<CategoryFamily | "unknown", ReplayPerformanceCut>>;
    byEvent: Record<string, ReplayPerformanceCut>;
  };
}

export interface MarketMakeReplayReport {
  schemaVersion: "cassie-market-make-replay-report/1";
  /** Additive identity fields; absent only on reports persisted before v0.2.3. */
  configHash?: string;
  bankrollBasis?: {
    basis: "configured-reference";
    policyMode: "live" | "fixed";
    sizingBankrollUsd: number;
    maximumSizingBankrollUsd: number | null;
  };
  fillModel: ReplayFillModel;
  source: string;
  startedAt?: string;
  endedAt?: string;
  eventsProcessed: number;
  actionsProposed: number;
  actionsByKind: Record<MarketMakeAction["kind"], number>;
  decisions: DecisionRecord[];
  finalState: MarketMakeState;
  /** Additive v1 telemetry; optional here so previously persisted/constructed v1 reports remain valid. */
  metrics?: MarketMakeReplayMetrics;
  caveats: string[];
}

/** Reports produced by the current replay runner always carry the additive acceptance telemetry. */
export interface MarketMakeReplayReportWithMetrics extends MarketMakeReplayReport {
  configHash: string;
  bankrollBasis: NonNullable<MarketMakeReplayReport["bankrollBasis"]>;
  metrics: MarketMakeReplayMetrics;
}

export interface MarketMakeRunStatus {
  strategyId: "market-make";
  schemaVersion: "q-directed-polymarket-mm/1";
  configHash: string;
  halted: boolean;
  lossLatched: boolean;
  activeMarkets: number;
  liveOrders: number;
  deployedUsd: number;
  lastEventAt?: number;
}

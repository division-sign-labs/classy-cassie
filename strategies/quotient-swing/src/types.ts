// strategies/quotient-swing/src/types.ts
// Public, account-local inputs and deterministic decision records.
import type { OrderBook, Position, StrategyContext } from "@quotient-forecasting/cassie-core";

export type SwingSide = "LONG" | "SHORT";
export type SwingAssetClass = "equity" | "commodity";

export interface SwingOutlook {
  id: string;
  assetKey: string;
  marketRef: string;
  basisId: string;
  targetFamilyKey: string;
  anchorAt: number;
  publishedAt: number;
  observedAt: number;
  status: string;
  freshnessState: string;
  freshnessReason: string | null;
  mode: string | null;
  basisVerified: boolean;
  provider: string;
  priceField: string;
  window: string;
  candleInterval: string | null;
  groundingStatus: string;
  rangeStatus: "complete" | "clamped" | "unknown";
  method: "full_quantile_curve" | "published_percentiles";
  spotAtObservation: number;
  expectedPrice: number;
  expectedLogReturn: number;
  directionalSide: "bullish" | "bearish" | "neutral";
  medianPrice: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  sigmaTotal: number;
  /** Signed distance from the observation spot to the median, in units of sigmaTotal. */
  spotGapSigma: number;
  scoreSigma: number | null;
  probabilityAboveSpot: number | null;
}

export interface SwingMarketSnapshot {
  assetKey: string;
  marketRef: string;
  assetClass: SwingAssetClass;
  active: boolean;
  isolatedSupported: boolean;
  maxLeverage: number;
  maintenanceMarginRate: number;
  marginTiers?: Array<{ lowerBound: number; maxLeverage: number; maintenanceMarginRate: number }>;
  sizeDecimals: number;
  minNotional: number;
  priceTick: number;
  book: OrderBook;
  markPrice: number;
  volume24hUsd: number;
  oraclePrice: number;
  /** Signed decimal payment per hour: positive longs pay, negative shorts pay. */
  fundingHourly: number;
  fundingObservedAt: number;
  makerFeeRate: number;
  takerFeeRate: number;
  outlooks: SwingOutlook[];
}

export interface SwingHeldPosition extends Position {
  side: SwingSide;
  liquidationPrice?: number;
  isolatedMarginUsd?: number;
  leverage?: number;
}

export interface SwingOpenOrder {
  id: string;
  marketRef: string;
  clientId?: string;
  purpose: "entry" | "exit" | "stop" | "target";
  size: number;
  filledSize: number;
  price: number;
  createdAt: number;
}

export interface SwingSnapshot {
  now: number;
  nav: number;
  /** Net transfers since the previous snapshot; excludes trade P&L and funding. */
  netCashFlow: number;
  availableMarginUsd: number;
  coveredAssetKeys: string[];
  markets: SwingMarketSnapshot[];
  positions: SwingHeldPosition[];
  openOrders: SwingOpenOrder[];
  accountObservedAt: number;
  accountReconciled: boolean;
}

export interface SwingCandidate {
  marketRef: string;
  assetKey: string;
  assetClass: SwingAssetClass;
  side: SwingSide;
  outlook: SwingOutlook;
  entryPrice: number;
  minNotional: number;
  stopPrice: number;
  targetPrice: number;
  stopFraction: number;
  gapSigma: number;
  /** Realizable log return to the median after round-trip costs; the ranking key. */
  netEdge: number;
  rank: number;
  costFraction: number;
  fundingFraction: number;
  remainingHours: number;
  horizonHours: number;
  themes: string[];
}

export interface SwingEntryRecord {
  marketRef: string;
  assetKey: string;
  assetClass: SwingAssetClass;
  side: SwingSide;
  outlookId: string;
  basisId: string;
  targetFamilyKey: string;
  originalAnchorAt: number;
  submittedAt: number;
  filledAt?: number;
  entryPrice: number;
  initialStop: number;
  stopPrice: number;
  targetPrice: number;
  size: number;
  leverage: number;
  marginUsd: number;
  reservedNotional: number;
  stopRiskUsd: number;
  fundingFraction: number;
  themes: string[];
  clientId: string;
  orderId?: string;
  status: "planned" | "accepted" | "held" | "exiting";
  lastForecastId: string;
  staleSince?: number;
  exitSubmittedAt?: number;
}

export interface SwingState {
  version: 1;
  highWaterNav: number;
  lastNav: number;
  lastAt: number;
  halted: boolean;
  haltReason?: string;
  entries: Record<string, SwingEntryRecord>;
  cooldowns: Record<string, number>;
}

export type SwingDecision =
  | { kind: "enter"; candidate: SwingCandidate; record: SwingEntryRecord; notional: number; size: number; leverage: number; marginUsd: number; liquidationPrice: number; clientId: string }
  | { kind: "exit"; marketRef: string; reason: string; urgent: boolean; limitPrice?: number; postOnly?: boolean }
  | { kind: "target"; marketRef: string; targetPrice: number; reason: string }
  | { kind: "cancel"; marketRef: string; orderId: string; reason: string };

export interface SwingReduction {
  state: SwingState;
  decisions: SwingDecision[];
  candidates: SwingCandidate[];
  rejected: Array<{ marketRef: string; reason: string }>;
  drawdown: number;
}

export interface SwingSnapshotProvider {
  snapshot(ctx: StrategyContext): Promise<SwingSnapshot>;
}

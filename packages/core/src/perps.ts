// packages/core/src/perps.ts
// Explicit perp accounting and execution contracts. No signing or strategy policy.
import type { Order, OrderAck, OrderBook, Position, Quote } from "./types.js";

export interface PerpInstrument {
  marketRef: string;
  assetId: number;
  dex: string;
  collateralToken: number;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
  strictIsolated: boolean;
  minNotional: number;
  maintenanceMarginRate: number;
  marginTiers?: Array<{ lowerBound: number; maxLeverage: number; maintenanceMarginRate: number }>;
  deployerFeeScale: number;
  growthMode: boolean;
  active: boolean;
}

export interface PerpMarketSnapshot {
  instrument: PerpInstrument;
  quote: Quote;
  book: OrderBook;
  markPrice: number;
  oraclePrice: number;
  fundingRateHourly: number;
  makerFeeRate: number;
  takerFeeRate: number;
  ts: number;
}

export interface PerpDexBalance {
  dex: string;
  /** Authoritative DEX account value, already including unrealized P&L. */
  equity: number;
  availableCollateral: number;
  marginUsed: number;
  grossNotional: number;
}

export interface PerpAccountSnapshot extends PerpDexBalance {
  abstraction: string;
  collateral: "USDC";
  /** Separate Standard-mode balances, whose totals equal the account fields. Multi-DEX snapshots use dex="multi". */
  dexBalances?: PerpDexBalance[];
  /** Unified accounts have one authoritative USDC balance covering these DEXs. */
  sharedCollateral?: boolean;
  dexes?: string[];
  positions: Position[];
  openOrders: Order[];
  ts: number;
}

export interface PerpCashFlow {
  id: string;
  ts: number;
  /** Positive deposits / negative withdrawals into this DEX; excludes trading and funding. */
  amount: number;
  /** Includes both sides of internal DEX transfers; their aggregate is zero. */
  byDex?: Record<string, number>;
}

export interface PerpCashFlowResult {
  flows: PerpCashFlow[];
  complete: boolean;
}

export interface PerpLeverageRequest {
  marketRef: string;
  leverage: number;
  marginMode: "isolated";
}

export interface PerpStopRequest {
  marketRef: string;
  positionSide: "LONG" | "SHORT";
  size: number;
  stopPx: number;
  slippagePct: number;
  clientId: string;
}

/** Unknown means submission must remain reserved until authoritative reconciliation. */
export type PerpOrderLookup = { found: false; definitive: boolean } | { found: true; order: Order; ack: OrderAck };

export interface PerpCycle {
  id: string;
  marketRef: string;
  side: "LONG" | "SHORT";
  status: "pending" | "open" | "exiting" | "closed" | "blocked";
  anchorAt: number;
  createdAt: number;
  openedAt?: number;
  closedAt?: number;
  initialStopPx: number;
  stopPx: number;
  entryPrice: number;
  initialRiskUsd: number;
  desiredNotional: number;
  filledSize: number;
  leverage: number;
  themes: string[];
  stopOrderId?: string;
  stopClientId?: string;
  stopConfirmedAt?: number;
  /** Executor-owned take-profit: a resting reduce-only limit at this price. */
  targetPx?: number;
  targetOrderId?: string;
  targetClientId?: string;
  targetConfirmedAt?: number;
  targetFilledSize?: number;
  entryOrderIds: string[];
  entryClientIds: string[];
  exitReason?: string;
  provenance?: Record<string, unknown>;
}

export interface PerpExecutionState {
  cycles: PerpCycle[];
  /** The two deliberate stops: an operator halt or the configured drawdown limit. */
  halted: boolean;
  haltReason?: string;
  highWaterEquity: number;
  drawdownPct: number;
  lastReconciledAt?: number;
  cashFlowsComplete: boolean;
  /** Why entries wait without a halt; clears on its own when the read succeeds. */
  entriesPaused?: string;
  /** Markets with venue exposure the ledger does not own; entries there wait. */
  unmanagedMarkets?: string[];
  /** Markets whose cycle or submission is being resolved from venue evidence. */
  reconcilingMarkets?: string[];
}

// packages/core/src/types.ts
// Shared domain types for cassie. Everything here is runtime-agnostic and
// free of side effects.
import type { PerpAccountSnapshot, PerpCashFlowResult, PerpExecutionState, PerpInstrument, PerpLeverageRequest, PerpMarketSnapshot, PerpOrderLookup, PerpStopRequest } from "./perps.js";

export type VenueId = "polymarket" | "kalshi" | "hyperliquid" | "lighter" | "fixture";

/**
 * Venues whose instruments are binary YES/NO outcome markets. Use this where
 * the semantics are prediction-vs-perp; keep `=== "polymarket"` only for
 * Polymarket-specific gates (bridge funding, geoblock).
 */
export function isPredictionVenue(venue: VenueId): boolean {
  return venue === "polymarket" || venue === "kalshi";
}

/** Side of a held position. Prediction markets use YES/NO, perps use LONG/SHORT. */
export type PositionSide = "YES" | "NO" | "LONG" | "SHORT";

/** Side of an order at the adapter level. */
export type OrderSide = "BUY" | "SELL";

export type Tif = "GTC" | "GTD" | "FOK" | "IOC" | "FAK";

export interface Balance {
  asset: string;
  /** Total balance including amounts locked in orders/positions. */
  total: number;
  /** Freely spendable. */
  available: number;
}

/** Read-only account context; funding collateral is not strategy NAV. */
export interface PerpPortfolioScope {
  dex: string;
  dexes?: string[];
  accountMode: string;
  fundingBalance: number;
  fundingAvailable: number;
}

export interface Position {
  marketRef: string;
  /** Venue-native outcome token actually held, when available. */
  tokenId?: string;
  /** Prediction-market condition identity, when available. */
  conditionId?: string;
  /** Explicit binary outcome for adapters that expose it. */
  outcome?: "YES" | "NO";
  side: PositionSide;
  /** Base units: outcome shares (prediction markets) or contracts (perps). */
  size: number;
  avgPrice: number;
  /** Venue-reported current price in this position's own side/token space. */
  currentPrice?: number;
  unrealizedPnl?: number;
  realizedPnl?: number;
  /** Prediction markets: market has resolved and the position is redeemable. */
  redeemable?: boolean;
  /** Human-readable market/instrument name when the venue provides one. */
  label?: string;
  leverage?: number;
  marginMode?: "cross" | "isolated";
  marginUsed?: number;
  liquidationPrice?: number;
}

/** Public identifiers returned after a venue redemption settles. */
export interface RedemptionReceipt {
  transactionHash?: string;
  transactionId?: string;
}

/** Durable submission boundary; receipt identifiers contain no signing material. */
export interface RedemptionHooks {
  beforeSubmit(): Promise<void>;
  submitted(receipt: RedemptionReceipt): Promise<void>;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  marketRef: string;
  bids: BookLevel[]; // sorted best (highest) first
  asks: BookLevel[]; // sorted best (lowest) first
  /** Observation time (ms). Freshness and skew gates key off this, never off the venue’s own stamp. */
  ts: number;
  /** The venue’s own book timestamp (ms) when it reports one; informational. */
  venueTs?: number;
}

export interface Quote {
  marketRef: string;
  bid: number;
  ask: number;
  mid: number;
  /** 24h traded volume in quote currency (USD). */
  volume24h: number;
  spreadBps: number;
  ts: number;
}

export interface OrderIntent {
  marketRef: string;
  /**
   * Exact venue token selected by an identity-validated strategy. Adapters
   * must verify that it belongs to marketRef's condition before using it.
   */
  tokenId?: string;
  /** Prediction-market condition identity carried for reconciliation. */
  conditionId?: string;
  side: OrderSide;
  /**
   * Prediction venues only: which outcome token this order trades. marketRef
   * stays the YES-token ref (§7); the adapter resolves the actual token from
   * (marketRef, outcome). Entering NO = BUY with outcome "NO". Perps ignore it.
   */
  outcome?: "YES" | "NO";
  /** Base units (shares/contracts). */
  size: number;
  /** Limit price. Market-style execution is a limit priced to cross the spread. */
  limitPrice: number;
  tif: Tif;
  /** Reject a limit order that would immediately take liquidity. */
  postOnly?: boolean;
  /** Optional venue expiry in Unix seconds. Local TTL remains authoritative. */
  expiration?: number;
  /** Non-authoritative lifecycle label. Risk derives exposure from balances. */
  purpose?: "entry" | "normal-exit" | "urgent-exit" | "target";
  clientId: string;
  /** Perps only: reduce-only flag for exits. */
  reduceOnly?: boolean;
  /**
   * Native trigger attachment where the venue supports it (Hyperliquid TP/SL,
   * Lighter SL/TP). Ignored by venues without native triggers — the engine
   * manages synthetic triggers for those (see engine/triggers).
   */
  triggers?: {
    stopPx?: number;
    tpPx?: number;
  };
}

export type OrderStatus = "open" | "filled" | "partial" | "canceled" | "rejected";

export interface OrderAck {
  orderId: string;
  clientId?: string;
  status: OrderStatus;
  filledSize?: number;
  avgFillPrice?: number;
  /**
   * Venue token actually traded, as resolved from (marketRef, outcome).
   * marketRef stays the YES-token ref (§7), so a NO order trades a token the
   * caller never named. Settlement reconciliation uses this exact token.
   */
  tokenId?: string;
  /** Wallet that holds the resulting position (Polymarket Deposit Wallet). */
  funder?: string;
  /** Local, non-secret digest of the SDK-created signed order. */
  preparedHash?: string;
}

export interface Order {
  id: string;
  clientId?: string;
  marketRef: string;
  tokenId?: string;
  conditionId?: string;
  outcome?: "YES" | "NO";
  side: OrderSide;
  size: number;
  filledSize: number;
  price: number;
  tif?: Tif;
  status: OrderStatus;
  createdAt?: number;
  reduceOnly?: boolean;
  isTrigger?: boolean;
  isPositionTpsl?: boolean;
  triggerPrice?: number;
  triggerKind?: "sl" | "tp";
}

export interface Fill {
  /** Settlement-aware readers may return pending/failed records; only CONFIRMED changes inventory. */
  settlementStatus?: "MATCHED" | "MINED" | "CONFIRMED" | "RETRYING" | "FAILED";
  id: string;
  orderId?: string;
  marketRef: string;
  tokenId?: string;
  conditionId?: string;
  outcome?: "YES" | "NO";
  /** Maker order associated with an account-side maker fill. */
  makerOrderId?: string;
  /** Incremental matched quantity represented by this event. */
  matchedAmountDelta?: number;
  side: OrderSide;
  size: number;
  price: number;
  ts: number;
  fee?: number;
}

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type CandleInterval = "1h" | "4h" | "1d";

export interface FundingAddress {
  chain: string;
  address: string;
  asset: string;
  minimum: number;
  note?: string;
}

export interface FundingInstructions {
  venue: VenueId;
  addresses: FundingAddress[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Accounts and credentials
// ---------------------------------------------------------------------------

/**
 * Non-secret account descriptor persisted in bot config. Secrets live in the
 * keystore (local) or encrypted runtime secrets (deployed).
 */
export type VenueAccount =
  | {
      venue: "polymarket";
      /** EOA that signs orders. */
      signerAddress: string;
      /** Deposit Wallet (funder). Distinct from the signer — confusing the two is the classic 401. */
      funder: string;
      /** Polymarket signature type. 3 = Deposit Wallet (POLY_1271), the default for new accounts. */
      signatureType: number;
      /** Per-chain bridge deposit addresses issued by bridge.polymarket.com. */
      bridgeAddresses?: Record<string, string>;
    }
  | {
      venue: "hyperliquid";
      /** Master EOA address. Owns funds; its key never leaves the local keystore. */
      masterAddress: string;
      /** Approved agent (API wallet) address. Its key is runtime-eligible. */
      agentAddress?: string;
      agentName?: string;
    }
  | {
      venue: "lighter";
      /** Ethereum L1 address that registered the account. Key stays local. */
      l1Address: string;
      accountIndex?: number;
      apiKeyIndex?: number;
      /** CCTP intent deposit address, per source chain. */
      intentAddresses?: Record<string, string>;
    }
  | {
      venue: "kalshi";
      /**
       * Kalshi API key id (a UUID; non-secret). The paired RSA private key is
       * the secret and lives in the keystore. A Kalshi bot has no venue wallet;
       * the master EOA generated at init stays local-only bot identity.
       */
      keyId: string;
    }
  | {
      venue: "fixture";
      address: string;
    };

/**
 * Runtime-eligible credentials: the JSON blob that reaches a deployed runtime
 * as an environment file, or is decrypted into memory by a local run.
 * Hyperliquid master keys, Lighter L1 keys, and Polymarket Relayer/Builder keys
 * are never part of this. Polymarket is the explicit exception: its pinned SDK
 * requires the raw venue signer in the runtime. Treat that signer as deployed
 * authority and never reuse it as a Splits treasury signer.
 */
export type RuntimeCreds =
  | {
      venue: "polymarket";
      signerPk: string;
      funder: string;
      signatureType: number;
      l2: { apiKey: string; secret: string; passphrase: string };
    }
  | {
      venue: "hyperliquid";
      agentPk: string;
      masterAddress: string;
    }
  | {
      venue: "lighter";
      apiPrivateKey: string;
      accountIndex: number;
      apiKeyIndex: number;
    }
  | {
      venue: "kalshi";
      keyId: string;
      /**
       * RSA private key as single-line base64 PKCS#8 DER — never a multi-line
       * PEM, which the deploy env-file path rejects. Decoded by the adapter via
       * createPrivateKey({format: "der", type: "pkcs8"}).
       */
      privateKeyB64: string;
    }
  | {
      venue: "fixture";
    };

// ---------------------------------------------------------------------------
// Signals (§7) — the Quotient signal contract
// ---------------------------------------------------------------------------

export interface Signal {
  id: string;
  ts: string; // ISO timestamp
  venue: VenueId;
  /** Polymarket: CLOB token ID of the YES token. Perps: instrument symbol. */
  marketRef: string;
  side: PositionSide;
  /** Model probability (prediction markets). */
  prob?: number;
  /** Market price at signal time. */
  refPrice: number;
  /** |prob - price| in percentage points. */
  spreadPp?: number;
  /** Venue resolution/close time in epoch ms, when the feed carries one. */
  endsAt?: number;
  ttlSec: number;
  /** Settlement-aware strategies bind working orders to these exact published terms. */
  settlementBasis?: string;
  rulesHash?: string;
}

/** Latest Quotient forecast for a market, independent of signal publication. */
export interface MarketForecast {
  id: string;
  ts: string;
  venue: VenueId;
  /** Polymarket: CLOB token ID of the YES token. */
  marketRef: string;
  /** Quotient's calibrated probability for the YES outcome. */
  probYes: number;
  /** Venue resolution/close time in epoch ms, when the feed carries one. */
  endsAt?: number;
}

// ---------------------------------------------------------------------------
// Strategy contract (§3)
// ---------------------------------------------------------------------------

export type Action =
  | {
      kind: "enter";
      marketRef: string;
      side: PositionSide;
      /** Desired position notional in USD. The engine sizes and risk-checks it. */
      notional: number;
      /** Skip the entry if risk/capacity would reduce it below this USD notional. */
      minNotional?: number;
      /** Optional price bound; defaults to a crossing limit within the slippage band. */
      limitPrice?: number;
      tif?: "GTC" | "IOC";
      postOnly?: boolean;
      stopPx?: number;
      /** Protected perp entries: take-profit price the executor rests as a reduce-only limit. */
      targetPx?: number;
      leverage?: number;
      /** Required for protected perp entries. Stable across submission retries. */
      clientId?: string;
      anchorAt?: number;
      themes?: string[];
      reason?: string;
      /**
       * Decision provenance persisted with the resulting order: the signal or
       * forecast identity, live edge, target, current exposure, and cap
       * headroom that produced it. Free-form but JSON-serializable.
       */
      provenance?: Record<string, unknown>;
    }
  | {
      kind: "exit";
      marketRef: string;
      /** Fraction of the currently held position, in (0, 1]. */
      fraction?: number;
      limitPrice?: number;
      tif?: "GTC" | "IOC";
      postOnly?: boolean;
      urgent?: boolean;
      reason?: string;
      /** Decision provenance persisted with the resulting order. */
      provenance?: Record<string, unknown>;
    }
  | { kind: "protect"; marketRef: string; stopPx: number; reason: string }
  /** Move a protected perp cycle's take-profit; it must stay on the favorable side of entry. */
  | { kind: "target"; marketRef: string; targetPx: number; reason: string }
  | {
      kind: "redeem";
      marketRef: string;
      reason?: string;
    }
  | {
      /** Explicit passive/exit order emitted by an event-driven strategy. */
      kind: "place";
      marketRef: string;
      conditionId: string;
      tokenId: string;
      outcome: "YES" | "NO";
      side: OrderSide;
      /** Requested shares. The executor may only reduce this. */
      size: number;
      limitPrice: number;
      tif: Extract<Tif, "GTC" | "FAK">;
      postOnly: boolean;
      purpose: "entry" | "normal-exit" | "urgent-exit";
      reason: string;
    }
  | {
      kind: "cancel";
      orderId: string;
      marketRef: string;
      reason: string;
    };

export interface StrategyContext {
  /** Durable directional executions, present only for adaptive Polymarket signals. */
  execution?: import("./engine/prediction-execution.js").PredictionExecutionSnapshot;
  botId: string;
  venueId: VenueId;
  /** The strategy's own config block (validated by the strategy). */
  config: unknown;
  signals: SignalSource;
  venue: VenueReadApi;
  positions: Position[];
  openOrders: Order[];
  /** Account equity in USD (collateral + position value). */
  equity: number;
  perpAccount?: PerpAccountSnapshot;
  perpExecution?: PerpExecutionState;
  log: Logger;
  now: () => number;
  /** Persistent per-strategy scratch state (JSON-serializable). */
  memory: StrategyMemory;
}

export interface StrategyMemory {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export interface Strategy {
  id: string;
  /** Called on schedule; pure decision — the engine executes through the risk module. */
  tick(ctx: StrategyContext): Promise<Action[]>;
  /** Observe the engine result so persistent strategy budgets reflect placed orders only. */
  onActionResult?(ctx: StrategyContext, action: Action, result: StrategyActionResult): Promise<void>;
}

export interface StrategyActionResult {
  placed: boolean;
  /** Parent admission reserves once; child acknowledgements are not strategy placements. */
  executionId?: string;
  /** Final order notional after engine risk/capacity caps. Present for placed entries. */
  placedNotional?: number;
  /** Final order size in base units after engine risk/capacity caps. */
  placedSize?: number;
  /** Final limit price the order carried. */
  limitPrice?: number;
  orderId?: string;
  clientId?: string;
  status?: OrderStatus;
  /** Size the venue reported filled in the placement acknowledgement, when known. */
  filledSize?: number;
  avgFillPrice?: number;
  /** Engine clock when the order was accepted. */
  placedAt?: number;
}

/** Metadata persisted after SDK signing and before the venue POST. */
export interface PreparedOrderMeta {
  preparedHash: string;
  tokenId: string;
  conditionId?: string;
  outcome?: "YES" | "NO";
  /** Exact size and price after the venue SDK's tick/lot normalization. */
  limitPrice?: number;
  size?: number;
}

export interface OrderLifecycleHooks {
  onPrepared(meta: PreparedOrderMeta): Promise<void>;
}

/** Async-iterable venue stream with an explicit, idempotent close. */
export type RealtimeSubscription<T = unknown> = AsyncIterable<T> & {
  close(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Venue adapter contract (§3)
// ---------------------------------------------------------------------------

/** Read-only slice of a venue adapter, bound to an account. Strategies see only this. */
export interface VenueReadApi {
  executionMarket?(marketRef: string, outcome: "YES" | "NO"): Promise<PredictionExecutionMarket>;
  balances(): Promise<Balance[]>;
  positions(): Promise<Position[]>;
  book(marketRef: string): Promise<OrderBook>;
  quote(marketRef: string): Promise<Quote>;
  openOrders(): Promise<Order[]>;
  fills(sinceTs: number): Promise<Fill[]>;
  /** Canonical parent event for cross-market exposure caps. */
  eventRef?(marketRef: string): Promise<string | undefined>;
  candles?(marketRef: string, interval: CandleInterval, lookback: number): Promise<Candle[]>;
  perpInstruments?(): Promise<PerpInstrument[]>;
  perpAccountSnapshot?(): Promise<PerpAccountSnapshot>;
  perpMarketSnapshot?(marketRef: string): Promise<PerpMarketSnapshot>;
}

/** Wizard-driven setup UI, injected by the CLI so adapters stay headless. */
export interface SetupContext {
  botId: string;
  /** Ask the operator a free-text question (value may be pasted from a dashboard). */
  ask(question: string, opts?: { secret?: boolean; default?: string }): Promise<string>;
  /** Ask a yes/no question. */
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  /**
   * Ask the operator to pick one of a fixed set of choices, returning the
   * chosen `value`. Optional: adapters fall back to `ask` when a host (tests,
   * non-interactive drivers) does not implement it.
   */
  select?(question: string, choices: Array<{ value: string; title: string; description?: string }>): Promise<string>;
  print(message: string): void;
  /** Poll until `check` resolves non-null. Prints `waitingMsg` while polling. */
  poll<T>(waitingMsg: string, check: () => Promise<T | null>, opts?: { intervalMs?: number; timeoutMs?: number }): Promise<T>;
  /**
   * Poll immediately while allowing an interactive operator to skip the wait.
   * Returns null only when skipped; headless hosts may omit this capability.
   */
  pollSkippable?<T>(
    waitingMsg: string,
    check: () => Promise<T | null>,
    opts?: { intervalMs?: number; timeoutMs?: number },
  ): Promise<T | null>;
  /** Read a decrypted secret from the local keystore. */
  getSecret(role: string): Promise<string | null>;
  /** Persist a secret into the local keystore. */
  putSecret(role: string, value: string, meta?: { address?: string; runtimeEligible?: boolean }): Promise<void>;
  /** Operator-level defaults shared across bots (e.g. a Builder API key). */
  getOperatorDefault?(name: string): Promise<string | null>;
  setOperatorDefault?(name: string, value: string): Promise<void>;
  /** Open a URL in the operator's browser (falls back to printing it). */
  openUrl?(url: string): void;
}

export interface AwaitFundingOpts {
  intervalMs?: number;
  timeoutMs?: number;
  onPoll?: (msg: string) => void;
}

/** Fresh selected-outcome inputs used for directional execution and risk checks. */
export interface PredictionExecutionMarket {
  marketRef: string;
  conditionId: string;
  tokenId: string;
  outcome: "YES" | "NO";
  tickSize: number;
  minOrderSize: number;
  acceptingOrders: boolean;
  observedAt: number;
  book: OrderBook;
  quote: Quote;
}

/** Authenticated cumulative matches include quantities still awaiting settlement. */
export interface PredictionOrderState {
  orderId: string;
  status: "open" | "matched" | "canceled" | "expired" | "unknown";
  size: number;
  matchedSize: number;
  observedAt: number;
}

export interface PredictionCancellationResult {
  status: "canceled" | "not-canceled";
  reason?: string;
  /** Venue says the order is no longer open; fills still require reconciliation. */
  notOpen?: boolean;
}

export interface TokenBalanceOptions {
  /** Force a venue-side chain refresh before reading; throws a transient error if the refresh budget denies it. */
  refresh?: boolean;
}

export interface VenueAdapter {
  executionMarket?(marketRef: string, outcome: "YES" | "NO"): Promise<PredictionExecutionMarket>;
  executionOrder?(acct: VenueAccount, orderId: string): Promise<PredictionOrderState | null>;
  cancelOrderChecked?(acct: VenueAccount, orderId: string): Promise<PredictionCancellationResult>;
  id: VenueId;
  /** Date the adapter's endpoints/contracts were last verified against venue docs. */
  verifiedAgainst: string;
  /** True when the venue maps stops/TP to native trigger orders (HL, Lighter). */
  supportsNativeTriggers?: boolean;
  setup(ctx: SetupContext): Promise<VenueAccount>;
  fundingInstructions(acct: VenueAccount): Promise<FundingInstructions>;
  awaitFunding(acct: VenueAccount, opts?: AwaitFundingOpts): Promise<Balance>;
  /**
   * Full interactive §6 funding flow for the wizard / `cassie fund`: prints
   * addresses, polls for arrival, submits venue-side steps (bridge deposit,
   * approvals, agent/API-key provisioning), and returns the updated account.
   * Wizard falls back to fundingInstructions + awaitFunding when absent.
   */
  runFundingFlow?(ctx: SetupContext, acct: VenueAccount): Promise<VenueAccount>;
  balances(acct: VenueAccount): Promise<Balance[]>;
  portfolioScope?(acct: VenueAccount): Promise<PerpPortfolioScope>;
  positions(acct: VenueAccount): Promise<Position[]>;
  book(marketRef: string): Promise<OrderBook>;
  quote(marketRef: string): Promise<Quote>;
  /** Round down to executable share precision before reserving an order; must be idempotent. */
  normalizeOrderSize?(size: number): number;
  placeOrder(acct: VenueAccount, order: OrderIntent): Promise<OrderAck>;
  /**
   * Crash-safe order path used by market making. The adapter signs through its
   * pinned SDK, invokes onPrepared before POST, then submits the same order.
   */
  placeOrderWithLifecycle?(
    acct: VenueAccount,
    order: OrderIntent,
    hooks: OrderLifecycleHooks,
  ): Promise<OrderAck>;
  cancelOrder(acct: VenueAccount, id: string): Promise<void>;
  cancelAll(acct: VenueAccount): Promise<void>;
  openOrders(acct: VenueAccount): Promise<Order[]>;
  fills(acct: VenueAccount, sinceTs: number): Promise<Fill[]>;
  /** Includes pending and failed settlement records for controllers with a durable settlement journal. */
  tradeSettlements?(acct: VenueAccount, sinceTs: number): Promise<Fill[]>;
  /** Canonical parent event for cross-market exposure caps. */
  eventRef?(marketRef: string): Promise<string | undefined>;
  candles?(marketRef: string, interval: CandleInterval, lookback: number): Promise<Candle[]>;
  /** Exact outcome-token book; avoids manufacturing NO from YES. */
  tokenBook?(tokenId: string): Promise<OrderBook>;
  /**
   * Authenticated total token shares; callers subtract their outstanding SELL reservations.
   * `refresh: true` forces a venue-side chain re-sync and throws a transient error when the
   * venue's update budget denies it; opportunistic readers accept a recently synced value.
   */
  tokenBalance?(acct: VenueAccount, tokenId: string, opts?: TokenBalanceOptions): Promise<number>;
  /** A confirmed fill changed this token's inventory; the next read re-syncs it. */
  invalidateTokenBalance?(tokenId: string): void;
  /** Venue-native realtime feeds. Payload normalization belongs to the runtime adapter. */
  subscribeMarketData?(tokenIds: string[]): Promise<RealtimeSubscription>;
  subscribeUserData?(): Promise<RealtimeSubscription>;
  /** Dead man's switch keep-alive, where the venue supports one. */
  heartbeat?(acct: VenueAccount): Promise<void>;
  /** Resolution redemption (Polymarket). */
  redeem?(acct: VenueAccount, position: Position, hooks?: RedemptionHooks): Promise<RedemptionReceipt | undefined>;
  redemptionStatus?(acct: VenueAccount, receipt: RedemptionReceipt): Promise<"pending" | "confirmed" | "failed">;
  /**
   * Withdraw collateral to an external address. Runs locally through the
   * wizard context because it signs with the master/L1 key, which stays in
   * the local keystore. Returns a human-readable receipt (tx hash or id).
   */
  withdraw?(ctx: SetupContext, acct: VenueAccount, params: { to: string; amount: number | "all" }): Promise<string>;
  /** Current funding rate as a decimal per 8h (perps venues). */
  fundingRate?(marketRef: string): Promise<number>;
  perpInstruments?(): Promise<PerpInstrument[]>;
  perpAccountSnapshot?(acct: VenueAccount): Promise<PerpAccountSnapshot>;
  perpMarketSnapshot?(acct: VenueAccount, marketRef: string): Promise<PerpMarketSnapshot>;
  perpCashFlows?(acct: VenueAccount, sinceTs: number): Promise<PerpCashFlowResult>;
  configurePerpLeverage?(acct: VenueAccount, request: PerpLeverageRequest): Promise<void>;
  placePerpStop?(acct: VenueAccount, request: PerpStopRequest): Promise<OrderAck>;
  lookupPerpOrder?(acct: VenueAccount, clientId: string): Promise<PerpOrderLookup>;
  disarmScheduledCancel?(acct: VenueAccount): Promise<void>;
}

// ---------------------------------------------------------------------------
// Signals source
// ---------------------------------------------------------------------------

export interface SignalQuery {
  venue?: VenueId;
  marketRef?: string;
}

export interface ForecastQuery {
  venue?: VenueId;
  marketRefs: string[];
}

/**
 * Signal/forecast source abstraction (live Quotient API | fixtures).
 * HARD RULE: this surface never accepts account state. Financial fields
 * (P&L, balances, account size) must not flow toward the signal API.
 */
export interface SignalSource {
  /** Last successful complete signal refresh, distinct from forecast publication time. */
  refreshedAt?(): number | undefined;
  latest(query: SignalQuery): Promise<Signal[]>;
  /** Held-market forecasts are independent of whether an entry signal is active. */
  forecasts?(query: ForecastQuery): Promise<MarketForecast[]>;
}

// ---------------------------------------------------------------------------
// Logging / errors / alerts
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export interface ErrorRecord {
  ts: number;
  level: LogLevel;
  code: string;
  venue?: VenueId;
  message: string;
  context?: unknown;
  tickSeq?: number;
}

export const ALERT_KINDS = [
  "entry",
  "exit",
  "flip",
  "fill",
  "partial-fill-timeout",
  "skipped-order",
  "deposit",
  "deploy",
  "error",
  "deadman",
  "resolution",
  "test",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** realized: from a fill, fee deducted. executable: at the order's limit price, before the fill. */
export type AlertPnlBasis = "realized" | "executable";

export interface AlertMarket {
  ref: string;
  /** Human title: the market question, ticker, or `COIN-PERP`. */
  title?: string;
  outcome?: "YES" | "NO";
  url?: string;
}

export interface AlertTrade {
  side: OrderSide;
  size: number;
  price: number;
  notionalUsd?: number;
  feeUsd?: number;
  orderId?: string;
  maker?: boolean;
  /** The held side the trade opens or closes: YES/NO, or LONG/SHORT for perps. */
  positionSide?: PositionSide;
  /** True when this is an executed fill rather than an order placement. */
  filled?: boolean;
}

export interface AlertPnl {
  usd?: number;
  pct?: number;
  basis: AlertPnlBasis;
}

export interface AlertEvent {
  kind: AlertKind;
  botId: string;
  message: string;
  /** Debug metadata. Rendered last. */
  data?: Record<string, unknown>;
  /** ISO time of the underlying event. */
  at?: string;
  venue?: VenueId;
  strategy?: string;
  market?: AlertMarket;
  trade?: AlertTrade;
  pnl?: AlertPnl;
  /** Plain-words cause, rendered before the debug metadata. */
  reason?: string;
}

export interface Alerter {
  send(event: AlertEvent): Promise<void>;
  /** Drain buffered deliveries (shutdown, `cassie alerts test`). */
  flush?(): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// State store — implemented by runtime-node (better-sqlite3)
// ---------------------------------------------------------------------------

export interface LogQuery {
  level?: LogLevel;
  tail?: number;
}

export interface StateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  appendError(rec: ErrorRecord): Promise<void>;
  readErrors(q?: LogQuery): Promise<ErrorRecord[]>;
}

// ---------------------------------------------------------------------------
// Thesis intake (§13)
// ---------------------------------------------------------------------------

export type Confidence = "low" | "medium" | "high";
export type Timeframe = "intraday" | "days" | "weeks" | "quarter";
export type Magnitude = "small" | "meaningful" | "repricing";

export interface ThesisTicket {
  venue: "hyperliquid" | "lighter" | "polymarket" | "kalshi";
  instrument: string;
  side: PositionSide;
  confidence: Confidence;
  timeframe: Timeframe;
  magnitude: Magnitude;
  invalidationPx?: number;
  riskBudgetPct: number;
  notes?: string;
  /**
   * The trade's reasoning in the operator's own words, retained with its alert.
   */
  reasoningSummary?: string;
  /** Path to an alternative mappings file. */
  mappings?: string;
}

/** One computed line on a filled ticket: answer → rule → number. */
export interface TicketLine {
  field: string;
  value: string;
  provenance: string;
  warning?: boolean;
}

export interface FilledTicket {
  ticket: ThesisTicket;
  entryPx: number;
  stopPx: number;
  /** Fixed take-profit, absent when a trailing stop is used instead. */
  tpPx?: number;
  /** Trailing stop distance in bps of entry, when magnitude/timeframe select trailing. */
  trailBps?: number;
  /** Position size in base units. */
  size: number;
  notional: number;
  leverage: number;
  liqPx: number;
  /** Both sizing computations, shown with their arithmetic. */
  sizing: { fixedFractionalRisk: number; quarterKellyRisk: number; chosen: "fixed-fractional" | "quarter-kelly" };
  lines: TicketLine[];
  /** Guardrail violations that require a second explicit confirm to override. */
  violations: string[];
  warnings: string[];
}

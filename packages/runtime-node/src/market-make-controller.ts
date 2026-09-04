// packages/runtime-node/src/market-make-controller.ts

import { createHash } from "node:crypto";
import {
  QUOTIENT_CALL_COST_USD,
  executableLiquidationValue,
} from "@quotient-forecasting/cassie-core";
import type {
  Alerter,
  AlertKind,
  Balance,
  Fill,
  Logger,
  MarketMakeExactForecast,
  MarketMakeQuotientClient,
  MarketMakeSignalRow,
  Order,
  OrderAck,
  OrderIntent,
  PolymarketCatalogClient,
  PolymarketMarketCatalog,
  Position,
  RealtimeSubscription,
  StateStore,
  VenueAccount,
  VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import {
  MarketMakeConfigSchema,
  NormalizedMarketMakeEventSchema,
  bestBidLevelUsd,
  createInitialMarketMakeState,
  effectiveMarketMakeBankrollUsd,
  evaluateShock,
  exitBidDepthUsd,
  liquidityParticipationCaps,
  lossLimitReasons,
  marketCommittedUsd,
  marketMakeConfigForBankroll,
  marketMakeConfigHash,
  reduceMarketMake,
  type DecisionRecord,
  type MarketCatalogSnapshot,
  type MarketMakeAction,
  type MarketMakeConfig,
  type MarketMakeState,
  type NormalizedMarketMakeEvent,
  type PublishedSignalInput,
  type StabilitySnapshot,
  type TokenBook,
  type TrackedOrder,
  type VolatilitySnapshot,
} from "@quotient-forecasting/strategy-market-make";
import {
  MarketMakeStateStore,
  marketMakeActivationHash,
  type MarketMakeOrder,
  type MarketMakeOrderPurpose,
  type MarketMakeStateStatus,
} from "./market-make-state.js";

const REDUCER_SNAPSHOT_KEY = "market-make:reducer-state:v1";
const SNAPSHOT_SCHEMA = "cassie-market-make-controller-snapshot/1";
const EPSILON = 1e-9;
const FILL_CURSOR_OVERLAP_MS = 5 * 60 * 1_000;
const CANCEL_FAILURE_ESCALATION = 3;
// Market websocket messages are book-change wake signals. Bursts are coalesced
// on the wall clock so a busy subscription cannot become a REST storm.
const MARKET_WAKE_MIN_INTERVAL_MS = 2_000;
// A transient venue read failure (rate limit, 5xx, socket reset) is retried on
// the next cadence instead of degrading, as long as an authoritative snapshot
// succeeded within this window. Beyond it the controller degrades as before.
// A poll over dozens of markets can itself run for a minute or more, so the
// window is measured in minutes, not in ticks.
const AUTHORITATIVE_READ_TOLERANCE_MS = 5 * 60 * 1_000;
// Markets whose YES and NO books are requested at the same time during a poll.
const BOOK_FETCH_CONCURRENCY = 8;
// A decision that changed nothing (no action, same verdict, same reasons as the
// last one persisted for that market) is re-persisted only as a periodic
// heartbeat, so the telemetry table records transitions and samples rather
// than one identical rejection per market per book tick.
const DECISION_HEARTBEAT_MS = 15 * 60 * 1_000;
// Every event is durably appended before it is reduced and replayed at startup,
// so the reducer snapshot is a cache. Serialising it after every one of the
// hundreds of events in a poll was the runtime’s dominant CPU and disk cost.
const REDUCER_SNAPSHOT_MIN_INTERVAL_MS = 5_000;

function isTransientVenueReadError(error: unknown): boolean {
  const candidate = error as { status?: unknown; retryAfter?: unknown; code?: unknown } | null;
  if (candidate && typeof candidate === "object") {
    if (candidate.retryAfter !== undefined) return true;
    if ([429, 502, 503, 504].includes(Number(candidate.status))) return true;
    if (typeof candidate.code === "string" &&
      ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(candidate.code)) {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return /rate limited|too many requests|internal server error|bad gateway|service unavailable|gateway time-?out|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i
    .test(message);
}

type QuotientClient = Pick<MarketMakeQuotientClient, "activeSignals" | "exactForecasts" | "spentUsd">;
type CatalogClient = Pick<PolymarketCatalogClient, "market"> & Partial<Pick<PolymarketCatalogClient, "recover">>;
type SnapshotStore = Pick<StateStore, "get" | "set" | "appendError">;
type LoggerLike = Pick<Logger, "debug" | "info" | "warn" | "error">;

export interface MarketMakeMetricsInput {
  now: number;
  marketKey: string;
  signal: PublishedSignalInput;
  catalog: MarketCatalogSnapshot;
  yesBook: TokenBook;
  noBook: TokenBook;
}

export interface MarketMakeMetricsProvider {
  snapshots(input: MarketMakeMetricsInput): Promise<{
    volatility: VolatilitySnapshot;
    stability: StabilitySnapshot;
  }>;
}

export interface MarketMakeControllerDeps {
  config: MarketMakeConfig;
  stateStore: MarketMakeStateStore;
  snapshotStore: SnapshotStore;
  venue: VenueAdapter;
  account: VenueAccount;
  quotient: QuotientClient;
  catalog: CatalogClient;
  botId?: string;
  alerter?: Alerter;
  log?: LoggerLike;
}

export interface MarketMakeControllerOptions {
  deploymentId: string;
  now?: () => number;
  autoSchedule?: boolean;
  enableSubscriptions?: boolean;
  heartbeatIntervalMs?: number;
  metricsProvider?: MarketMakeMetricsProvider;
}

export interface MarketMakeTickResult {
  at: number;
  signals: number;
  exactForecasts: number;
  catalogs: number;
  books: number;
  fills: number;
  actions: number;
  decisions: number;
}

export interface MarketMakeDryRunResult {
  at: number;
  actions: MarketMakeAction[];
  decisions: DecisionRecord[];
  state: MarketMakeState;
}

export interface MarketMakeReconcileResult {
  at: number;
  applied: boolean;
  balances: number;
  positions: number;
  openOrders: number;
  fills: number;
  unknownOrders: number;
  canceledUnknownOrders: number;
  books: number;
  proposalHash: string;
  proposals: {
    unknownOrdersToCancel: Array<{
      venueOrderId?: string;
      clientOrderId?: string;
      marketKey: string;
      tokenId: string;
      outcome: "YES" | "NO";
      side: "BUY" | "SELL";
      remainingQuantity: number;
      limitPrice: number;
    }>;
    residualInventory: Array<{
      marketKey: string;
      tokenId: string;
      outcome: "YES" | "NO";
      quantity: number;
      costBasisUsd: number;
      managed: boolean;
      reason: "unmanaged" | "missing-durable-cycle" | "identity-conflict" | "quantity-mismatch" | "venue-position-absent";
      application: "observe-and-authorize-repeated-reconciliation";
    }>;
    inventoryApplication: {
      mode: "repeated-authoritative-snapshots";
      minimumMatchingSnapshots: number;
      note: string;
    };
  };
}

export interface MarketMakeControllerStatus {
  strategyId: "market-make";
  schemaVersion: "q-directed-polymarket-mm/1";
  configHash: string;
  effectiveConfigHash: string;
  deploymentId: string;
  bankrollMode: "live" | "fixed";
  bankrollObserved: boolean;
  bankrollEntryReady: boolean;
  bankrollRefreshPending: boolean;
  strategyCapitalUsd: number;
  effectiveBankrollUsd: number;
  bankrollReferenceUsd: number;
  bankrollCeilingUsd?: number;
  bankrollScale: number;
  settlementQuiescent: boolean;
  settlementQuiescentAt?: number;
  started: boolean;
  lifecycle: MarketMakeStateStatus["lifecycle"];
  activationCurrent: boolean;
  haltReason?: string;
  loss: MarketMakeStateStatus["loss"];
  availability: MarketMakeStateStatus["availability"];
  lastReconciliation?: MarketMakeStateStatus["lastReconciliation"];
  counts: MarketMakeStateStatus["counts"];
  halted: boolean;
  lossLatched: boolean;
  activeMarkets: number;
  liveOrders: number;
  deployedUsd: number;
  lastEventAt?: number;
  lastTickAt?: number;
  lastError?: string;
  quotientSpentUsd: number;
  quotientDailySpendUsd: number;
  persistence: MarketMakeStateStatus;
}

interface PersistedReducerSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA;
  configHash: string;
  deploymentId?: string;
  effectiveBankrollUsd?: number;
  lastEventSeq: number;
  savedAt: number;
  quotientSpendUtcDay: string;
  quotientSpendUsd: number;
  lastQuotientPollAt?: number;
  bookHistory: Record<string, Array<{ ts: number; mid: number }>>;
  bookObservations?: Record<string, BookObservation[]>;
  lastShocks?: Record<string, EmittedShock>;
  lossHistory?: LossHistoryPoint[];
  orderAbsences?: Record<string, OrderAbsenceTracker>;
  cancelFailures?: Record<string, number>;
  cancelAllIssuedAt?: number;
  inventoryMismatches?: Record<string, InventoryMismatchTracker>;
  inventoryCorrectionWatermarks?: Record<string, InventoryCorrectionWatermark>;
  suppressedAuthoritativeFillIds?: Record<string, true>;
  marketStreamRecovery?: StreamRecoveryGate;
  userStreamRecovery?: StreamRecoveryGate;
  stability: Record<string, StabilityTracker>;
  state: MarketMakeState;
}

interface VenueSnapshot {
  at: number;
  balances: Balance[];
  positions: Position[];
  orders: Order[];
  fills: Fill[];
}

interface PollResult {
  signals: number;
  exactForecasts: number;
  catalogs: number;
  books: number;
  actions: number;
  decisions: number;
}

interface EventResult {
  applied: boolean;
  actions: number;
  decisions: number;
}

interface InventoryReconciliationResult {
  actions: number;
  consistent: boolean;
  reconciled: number;
}

interface CatalogCacheEntry {
  value: MarketCatalogSnapshot;
  fetchedAt: number;
}

interface StabilityTracker {
  qAsOf: number;
  outcome: "YES" | "NO";
  validSince: number;
  bestDistancePp: number;
  maxMoveAwayFromQPp: number;
}

interface BookObservation {
  ts: number;
  yesMid: number;
  noMid: number;
  yesSpreadPp: number;
  noSpreadPp: number;
  yesBidDepthUsd: number;
  noBidDepthUsd: number;
}

interface EmittedShock {
  ts: number;
  fingerprint: string;
}

interface BankrollIncreaseCandidate {
  fingerprint: string;
  strategyCapitalUsd: number;
  effectiveBankrollUsd: number;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface LossHistoryPoint {
  ts: number;
  navUsd: number;
}

interface OrderAbsenceTracker {
  count: number;
  firstAbsentAt: number;
  lastAbsentAt: number;
  cancelAllIssuedAt?: number;
}

interface InventoryMismatchTracker {
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  expectedQuantity: number;
  venueQuantity: number;
  fingerprint?: string;
}

interface InventoryCorrectionWatermark {
  tokenId: string;
  correctedAt: number;
  remainingCoveredSellQuantity: number;
}

type StreamKind = "market" | "user";

interface StreamRecoveryGate {
  generation: number;
  reason: string;
  requiredAt: number;
  reconnectedAt?: number;
  reconnectReconcileSequence?: number;
  messageAt?: number;
  messageAfterReconcileSequence?: number;
  reconciledAt?: number;
}

const silentLog: LoggerLike = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function finiteTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a valid timestamp`);
  return parsed;
}

function retiredReason(value: string | undefined): PublishedSignalInput["retiredReason"] {
  return value === "flipped" || value === "fading_q" || value === "expired" || value === "resolved"
    ? value
    : undefined;
}

function mid(book: TokenBook): number | undefined {
  const bid = book.bids.reduce<number | undefined>((best, level) => best === undefined || level.price > best ? level.price : best, undefined);
  const ask = book.asks.reduce<number | undefined>((best, level) => best === undefined || level.price < best ? level.price : best, undefined);
  return bid === undefined || ask === undefined || bid >= ask ? undefined : (bid + ask) / 2;
}

function statePurpose(purpose: string): MarketMakeOrderPurpose {
  if (purpose === "entry") return "ADD";
  if (purpose === "urgent-exit") return "LIQUIDATE";
  return "EXIT";
}

function reducerPurpose(order: MarketMakeOrder | undefined, side: "BUY" | "SELL"): TrackedOrder["purpose"] {
  if (!order) return side === "BUY" ? "entry" : "inventory-reduction";
  if (order.purpose === "ADD") return "entry";
  if (order.purpose === "LIQUIDATE") return "urgent-exit";
  if (order.purpose === "EXIT") return "normal-exit";
  return side === "BUY" ? "entry" : "inventory-reduction";
}

function reducerOrderStatus(status: OrderAck["status"] | Order["status"]): TrackedOrder["status"] {
  if (status === "filled") return "FILLED";
  if (status === "partial") return "PARTIAL";
  if (status === "canceled") return "CANCELED";
  if (status === "rejected") return "REJECTED";
  return "LIVE";
}

function stateReducerStatus(status: MarketMakeOrder["status"]): TrackedOrder["status"] {
  if (status === "FILLED") return "FILLED";
  if (status === "CANCELED") return "CANCELED";
  if (status === "REJECTED") return "REJECTED";
  if (status === "CANCEL_PENDING") return "CANCEL_PENDING";
  if (status === "PARTIALLY_FILLED") return "PARTIAL";
  if (status === "UNKNOWN" || status === "SIGNED" || status === "SUBMITTING") return "UNKNOWN";
  if (status === "OPEN") return "LIVE";
  return "PLANNED";
}

function orderIsResting(order: MarketMakeOrder): boolean {
  // SIGNED/SUBMITTING can already have reached the venue when the local POST
  // or acknowledgement is interrupted. Keep the dead-man lease alive until
  // every potentially resting order is authoritatively terminal.
  return ["SIGNED", "SUBMITTING", "UNKNOWN", "OPEN", "PARTIALLY_FILLED", "CANCEL_PENDING"].includes(order.status);
}

function eventDigest(event: NormalizedMarketMakeEvent): string {
  if (event.type === "fill") return `fill:${event.fillId}`;
  return `${event.type}:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`;
}

function economicNumber(value: number, label: string): string {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return Object.is(value, -0) ? "0" : String(value);
}

function canonicalHashValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalHashValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalHashValue(nested)]),
    );
  }
  return value;
}

function canonicalRowSort<T>(rows: T[]): T[] {
  return rows.sort((left, right) =>
    JSON.stringify(canonicalHashValue(left)).localeCompare(JSON.stringify(canonicalHashValue(right))));
}

function mapCatalog(value: PolymarketMarketCatalog): MarketCatalogSnapshot {
  return { ...value };
}

function isReducerState(value: unknown): value is MarketMakeState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === "cassie-market-make-state/1" &&
    typeof record.sequence === "number" &&
    typeof record.markets === "object" && record.markets !== null &&
    typeof record.processedFillIds === "object" && record.processedFillIds !== null;
}

function runtimeBankrollPolicy(config: MarketMakeConfig): {
  mode: "live" | "fixed";
  ceilingUsd?: number;
} {
  const bankroll = config.cassie_overrides.bankroll;
  return {
    mode: bankroll.mode,
    ...(bankroll.maximum_sizing_bankroll_usd === null
      ? {}
      : { ceilingUsd: bankroll.maximum_sizing_bankroll_usd }),
  };
}

/**
 * Polymarket exposes collateral cash separately from outcome inventory. Value
 * open inventory at acquisition cost so converting cash into shares does not
 * make the sizing base collapse or oscillate with every book tick. Open BUYs
 * are deliberately absent: their cash is still present in collateral and is
 * independently reserved by MarketMakeStateStore.
 */
export function marketMakeStrategyCapitalUsd(collateralTotalUsd: number, positions: Position[]): number {
  if (!Number.isFinite(collateralTotalUsd) || collateralTotalUsd < 0) {
    throw new Error("authoritative Polymarket collateral must be a finite non-negative number");
  }
  const seen = new Set<string>();
  const inventoryCost = positions.reduce((sum, position, index) => {
    if (!Number.isFinite(position.size) || position.size < 0) {
      throw new Error(`authoritative Polymarket position ${index} has invalid size`);
    }
    if (!Number.isFinite(position.avgPrice) || position.avgPrice < 0 || position.avgPrice > 1) {
      throw new Error(`authoritative Polymarket position ${index} has invalid average price`);
    }
    if (position.outcome !== "YES" && position.outcome !== "NO") {
      throw new Error(`authoritative Polymarket position ${index} lacks binary outcome identity`);
    }
    if (!position.tokenId) {
      throw new Error(`authoritative Polymarket position ${index} lacks token identity`);
    }
    const identity = `${position.tokenId}:${position.outcome}`;
    if (seen.has(identity)) {
      throw new Error(`authoritative Polymarket positions contain duplicate token ${position.tokenId}`);
    }
    seen.add(identity);
    return sum + position.size * position.avgPrice;
  }, 0);
  return collateralTotalUsd + inventoryCost;
}

export class MarketMakeController {
  readonly policyConfig: MarketMakeConfig;
  readonly configHash: string;
  readonly deploymentId: string;

  private readonly stateStore: MarketMakeStateStore;
  private readonly snapshotStore: SnapshotStore;
  private readonly venue: VenueAdapter;
  private readonly account: VenueAccount;
  private readonly quotient: QuotientClient;
  private readonly catalogClient: CatalogClient;
  private readonly botId: string;
  private readonly alerter?: Alerter;
  private readonly log: LoggerLike;
  private readonly now: () => number;
  private readonly autoSchedule: boolean;
  private readonly enableSubscriptions: boolean;
  private readonly heartbeatIntervalMs: number;
  private readonly metricsProvider?: MarketMakeMetricsProvider;

  private runtimeConfig: MarketMakeConfig;
  private bankrollObserved = false;
  private bankrollEntryReady = false;
  private bankrollRefreshPending = false;
  private strategyCapitalUsd = 0;
  private effectiveBankrollUsd = 0;
  private bankrollIncreaseCandidate?: BankrollIncreaseCandidate;
  private settlementQuiescent = false;
  private settlementQuiescentAt?: number;
  private reducerState: MarketMakeState;
  private queue: Promise<void> = Promise.resolve();
  private started = false;
  private reconciliationApproved = false;
  private shuttingDown = false;
  private tickTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeatInFlight?: Promise<void>;
  private marketSubscription?: RealtimeSubscription;
  private userSubscription?: RealtimeSubscription;
  private marketSubscriptionKey = "";
  private subscriptionTasks = new Set<Promise<void>>();
  private wakeQueued = false;
  private userWakePending = false;
  private marketWakeTimer?: ReturnType<typeof setTimeout>;
  private lastMarketWakeWallClockAt?: number;
  private lastAuthoritativeSnapshotAt?: number;
  private readonly lastPersistedDecision = new Map<string, { fingerprint: string; ts: number }>();
  private reducerSnapshotDirtySeq?: number;
  private lastReducerSnapshotWallClockAt = 0;
  private reconcileSequence = 0;
  private lastEventAt?: number;
  private lastTickAt?: number;
  private lastError?: string;
  private lastFillCursor = 0;
  private quotientSpendUtcDay = "";
  private quotientSpendUsd = 0;
  private lastQuotientPollAt?: number;
  private lastPositions: Position[] = [];
  private catalogCache = new Map<string, CatalogCacheEntry>();
  private bookHistory = new Map<string, Array<{ ts: number; mid: number }>>();
  private bookObservations = new Map<string, BookObservation[]>();
  private lastShocks = new Map<string, EmittedShock>();
  private lossHistory: LossHistoryPoint[] = [];
  private orderAbsences = new Map<string, OrderAbsenceTracker>();
  private cancelFailures = new Map<string, number>();
  private cancelAllIssuedAt?: number;
  private inventoryMismatches = new Map<string, InventoryMismatchTracker>();
  private inventoryCorrectionWatermarks = new Map<string, InventoryCorrectionWatermark>();
  private suppressedAuthoritativeFillIds = new Set<string>();
  private heartbeatSuppressed = false;
  private stability = new Map<string, StabilityTracker>();
  private lastMarketStreamAt?: number;
  private lastUserStreamAt?: number;
  private userWakeGeneration = 0;
  private lastMarketRestAt?: number;
  private lastUserRestAt?: number;
  private marketStreamRecovery?: StreamRecoveryGate;
  private userStreamRecovery?: StreamRecoveryGate;
  private alertFingerprints = new Map<string, number>();

  private get config(): MarketMakeConfig {
    return this.runtimeConfig;
  }

  constructor(deps: MarketMakeControllerDeps, options: MarketMakeControllerOptions) {
    this.policyConfig = MarketMakeConfigSchema.parse(deps.config);
    this.runtimeConfig = this.policyConfig;
    // The immutable policy reference is the conservative fallback. A matching
    // deployment may restore its last proven scale for loss/exit supervision,
    // but live entry authorization always starts closed and requires fresh
    // repeated observations. Fresh decreases still apply immediately.
    this.effectiveBankrollUsd = this.policyConfig.capital.sizing_bankroll_usd;
    this.bankrollEntryReady = runtimeBankrollPolicy(this.policyConfig).mode === "fixed";
    this.configHash = marketMakeConfigHash(this.policyConfig);
    this.deploymentId = options.deploymentId.trim();
    if (!this.deploymentId) throw new Error("market-make deploymentId must not be empty");
    if (deps.venue.id !== "polymarket") {
      throw new Error(`market-make is Polymarket-only; received venue adapter ${deps.venue.id}`);
    }
    if (deps.account.venue !== "polymarket") {
      throw new Error(`market-make requires a Polymarket account; received ${deps.account.venue}`);
    }
    if (!deps.venue.tokenBook) throw new Error("market-make requires exact outcome-token books");
    if (!deps.venue.placeOrderWithLifecycle) throw new Error("market-make requires crash-safe order lifecycle hooks");

    this.stateStore = deps.stateStore;
    this.snapshotStore = deps.snapshotStore;
    this.venue = deps.venue;
    this.account = deps.account;
    this.quotient = deps.quotient;
    this.catalogClient = deps.catalog;
    this.botId = deps.botId?.trim() || "market-make";
    this.alerter = deps.alerter;
    this.log = deps.log ?? silentLog;
    this.now = options.now ?? (() => Date.now());
    this.autoSchedule = options.autoSchedule ?? true;
    this.enableSubscriptions = options.enableSubscriptions ?? true;
    if (this.enableSubscriptions && (!deps.venue.subscribeMarketData || !deps.venue.subscribeUserData)) {
      throw new Error("market-make realtime supervision requires both market-data and user-data subscriptions");
    }
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    if (!Number.isFinite(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0) {
      throw new Error("heartbeatIntervalMs must be positive");
    }
    this.metricsProvider = options.metricsProvider;
    this.reducerState = createInitialMarketMakeState(this.config);
    this.reducerState.halted = true;
  }

  async start(): Promise<MarketMakeControllerStatus> {
    if (this.started) return this.status();
    this.shuttingDown = false;
    const persistenceBefore = this.stateStore.status();
    const priorApproved =
      persistenceBefore.configuredHash === this.configHash &&
      persistenceBefore.deploymentId === this.deploymentId &&
      persistenceBefore.lastReconciliation?.ok === true &&
      persistenceBefore.deploymentUpdatedAt !== undefined &&
      persistenceBefore.lastReconciliation.ts >= persistenceBefore.deploymentUpdatedAt;
    this.reconciliationApproved = priorApproved;
    await this.restoreReducerState();
    this.reducerState.halted = true;
    this.stateStore.setDeployment({
      configHash: this.configHash,
      deploymentId: this.deploymentId,
      now: this.now(),
    });
    this.started = true;
    try {
      if (priorApproved) {
        await this.tickInternal();
        if (this.stateStore.canRestoreActivation(this.configHash, this.deploymentId)) {
          await this.processEvent({ type: "resume", ts: this.now(), acknowledgeLossReset: false });
        } else {
          await this.processEvent({ type: "halt", ts: this.now(), liquidate: false });
        }
      } else {
        // First/config-changed startup is preview-only. `cassie run` must not
        // adopt inventory or cancel an external order before the operator has
        // reviewed and explicitly applied reconciliation.
        await this.reconcileInternal(false);
        await this.liveDryRun(true);
        this.stateStore.halt("startup requires reviewed reconciliation apply and explicit resume", this.now());
        await this.processEvent({ type: "halt", ts: this.now(), liquidate: false }, false);
      }
      if (this.enableSubscriptions) await this.startSubscriptions();
      if (this.autoSchedule) this.scheduleNextTick();
      this.startHeartbeatLoop();
      return this.status();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.stateStore.halt(`startup failed: ${this.lastError}`, this.now());
      this.reducerState.halted = true;
      await this.cleanupFailedStart();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.tickTimer = undefined;
    this.heartbeatTimer = undefined;
    await Promise.allSettled([
      this.marketSubscription?.close(),
      this.userSubscription?.close(),
    ].filter((value): value is Promise<void> => value !== undefined));
    this.marketSubscription = undefined;
    this.userSubscription = undefined;
    if (this.config.reconciliation.cancel_all_on_shutdown && this.reconciliationApproved) {
      try {
        await this.venue.cancelAll(this.account);
        await this.reconcileInternal(true);
      } catch (error) {
        this.log.error("market-make shutdown cancellation/reconciliation failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await Promise.allSettled([...this.subscriptionTasks]);
    this.started = false;
  }

  private async cleanupFailedStart(): Promise<void> {
    this.shuttingDown = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.tickTimer = undefined;
    this.heartbeatTimer = undefined;
    const market = this.marketSubscription;
    const user = this.userSubscription;
    this.marketSubscription = undefined;
    this.userSubscription = undefined;
    this.marketSubscriptionKey = "";
    await Promise.allSettled([market?.close(), user?.close()].filter(
      (value): value is Promise<void> => value !== undefined,
    ));
    await Promise.allSettled([...this.subscriptionTasks]);
    this.subscriptionTasks.clear();
    if (this.marketWakeTimer) clearTimeout(this.marketWakeTimer);
    this.marketWakeTimer = undefined;
    this.wakeQueued = false;
    this.userWakePending = false;
    this.heartbeatInFlight = undefined;
    this.started = false;
    this.shuttingDown = false;
  }

  tick(): Promise<MarketMakeTickResult> {
    return this.serialized(async () => {
      if (!this.started) throw new Error("market-make controller is not started");
      try {
        return await this.tickInternal();
      } catch (error) {
        await this.degrade(error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
  }

  status(): MarketMakeControllerStatus {
    const persistence = this.stateStore.status();
    const bankroll = runtimeBankrollPolicy(this.policyConfig);
    const reference = this.policyConfig.capital.sizing_bankroll_usd;
    let activeMarkets = 0;
    let liveOrders = 0;
    let deployedUsd = 0;
    for (const market of Object.values(this.reducerState.markets)) {
      const working = Object.values(market.orders).filter((order) =>
        !["CANCELED", "FILLED", "REJECTED"].includes(order.status));
      if (market.inventory || working.length > 0) activeMarkets += 1;
      liveOrders += working.length;
      if (market.inventory) deployedUsd += Math.max(0, market.inventory.cashPaidUsd - market.inventory.cashReceivedUsd);
      deployedUsd += working
        .filter((order) => order.side === "BUY")
        .reduce((sum, order) => sum + Math.max(0, order.size - order.filledSize) * order.price, 0);
    }
    return {
      strategyId: "market-make",
      schemaVersion: this.config.schema_version,
      configHash: this.configHash,
      effectiveConfigHash: marketMakeConfigHash(this.config),
      deploymentId: this.deploymentId,
      bankrollMode: bankroll.mode,
      bankrollObserved: this.bankrollObserved,
      bankrollEntryReady: this.bankrollEntryReady,
      bankrollRefreshPending: this.bankrollRefreshPending,
      strategyCapitalUsd: this.strategyCapitalUsd,
      effectiveBankrollUsd: this.effectiveBankrollUsd,
      bankrollReferenceUsd: reference,
      ...(bankroll.ceilingUsd === undefined ? {} : { bankrollCeilingUsd: bankroll.ceilingUsd }),
      bankrollScale: reference > 0 ? this.effectiveBankrollUsd / reference : 0,
      settlementQuiescent: this.settlementQuiescent,
      ...(this.settlementQuiescentAt === undefined ? {} : { settlementQuiescentAt: this.settlementQuiescentAt }),
      started: this.started,
      lifecycle: persistence.lifecycle,
      activationCurrent: persistence.activationCurrent,
      ...(persistence.haltReason === undefined ? {} : { haltReason: persistence.haltReason }),
      loss: persistence.loss,
      availability: persistence.availability,
      ...(persistence.lastReconciliation === undefined ? {} : { lastReconciliation: persistence.lastReconciliation }),
      counts: persistence.counts,
      halted: this.reducerState.halted,
      lossLatched: this.reducerState.lossLatched,
      activeMarkets,
      liveOrders,
      deployedUsd,
      ...(this.lastEventAt === undefined ? {} : { lastEventAt: this.lastEventAt }),
      ...(this.lastTickAt === undefined ? {} : { lastTickAt: this.lastTickAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      quotientSpentUsd: this.quotient.spentUsd,
      quotientDailySpendUsd: this.quotientSpendUsd,
      persistence,
    };
  }

  stateSnapshot(): MarketMakeState {
    return structuredClone(this.reducerState);
  }

  async dryRun(): Promise<MarketMakeDryRunResult> {
    return this.serialized(() => this.liveDryRun());
  }

  /**
   * Read a fresh venue/Q/Gamma snapshot and reduce it entirely in memory.
   * This intentionally bypasses processEvent: no event, decision, lifecycle,
   * reservation, order, or reducer trading-state change is persisted and no
   * action is submitted. Paid API calls still advance the durable daily spend
   * meter. A halted bot is previewed as-if resumed, while loss latches remain
   * authoritative.
   */
  private async liveDryRun(hydrateInputs = false): Promise<MarketMakeDryRunResult> {
    const at = this.now();
    const venue = await this.readVenueSnapshot();
    this.resetQuotientBudgetIfNeeded(at);
    const canCallDiscovery = this.canSpendQuotient(QUOTIENT_CALL_COST_USD.signals);
    const activeRows = canCallDiscovery ? await this.quotient.activeSignals(500) : [];
    if (canCallDiscovery) {
      this.recordQuotientSpend(QUOTIENT_CALL_COST_USD.signals);
      await this.saveReducerState();
    }
    const newest = new Map<string, MarketMakeSignalRow>();
    for (const row of activeRows) {
      const existing = newest.get(row.marketKey);
      if (!existing || finiteTimestamp(row.forecastAt, "forecastAt") > finiteTimestamp(existing.forecastAt, "forecastAt")) {
        newest.set(row.marketKey, row);
      }
    }

    const catalogs = new Map<string, MarketCatalogSnapshot>();
    for (const row of newest.values()) {
      // A discovery candidate we cannot catalog is simply not a candidate. Held
      // inventory keeps its catalog from reducer state below, so skipping here
      // withholds new entry rather than halting the whole strategy.
      try {
        catalogs.set(row.marketKey, mapCatalog(await this.catalogClient.market(row.marketKey, row.nativeMarketId, row.conditionId)));
      } catch (error) {
        this.log.warn("market-make skipped an uncatalogable discovery candidate", {
          marketKey: row.marketKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const [key, cached] of this.catalogCache) if (!catalogs.has(key)) catalogs.set(key, cached.value);
    for (const [key, market] of Object.entries(this.reducerState.markets)) {
      if (market.catalog && !catalogs.has(key)) catalogs.set(key, market.catalog);
    }

    const marketKeyFor = (marketRef: string, tokenId?: string, conditionId?: string): string | undefined => {
      for (const [key, market] of catalogs) {
        if (
          market.marketRef === marketRef ||
          market.yesTokenId === tokenId ||
          market.noTokenId === tokenId ||
          (conditionId && market.conditionId.toLowerCase() === conditionId.toLowerCase())
        ) return key;
      }
      return undefined;
    };
    const heldKeys = new Set(
      Object.entries(this.reducerState.markets)
        .filter(([, market]) => market.inventory)
        .map(([key]) => key),
    );
    for (const position of venue.positions) {
      const key = marketKeyFor(position.marketRef, position.tokenId, position.conditionId);
      if (key) heldKeys.add(key);
    }
    const exactRows: MarketMakeExactForecast[] = [];
    const missingHeld = [...heldKeys].filter((key) => !newest.has(key));
    for (let offset = 0; offset < missingHeld.length; offset += 10) {
      if (!this.canSpendQuotient(QUOTIENT_CALL_COST_USD.lookup)) break;
      exactRows.push(...await this.quotient.exactForecasts(missingHeld.slice(offset, offset + 10)));
      this.recordQuotientSpend(QUOTIENT_CALL_COST_USD.lookup);
      await this.saveReducerState();
    }

    let state = structuredClone(this.reducerState);
    state.halted = false;
    const actions: MarketMakeAction[] = [];
    const decisions: DecisionRecord[] = [];
    const apply = (event: NormalizedMarketMakeEvent): void => {
      const reduced = reduceMarketMake(state, event, this.config);
      this.attachDecisionSizing(reduced.decisions);
      state = reduced.state;
      actions.push(...reduced.actions);
      decisions.push(...reduced.decisions);
    };

    for (const fill of venue.fills.sort((a, b) => a.ts - b.ts)) {
      const stored = fill.orderId ? this.findStoredOrder(fill.orderId) : undefined;
      const tokenId = fill.tokenId ?? stored?.tokenId;
      const outcome = fill.outcome ?? stored?.outcome;
      const marketKey = stored?.marketKey ?? marketKeyFor(fill.marketRef, tokenId, fill.conditionId);
      if (!stored || !marketKey || !tokenId || (outcome !== "YES" && outcome !== "NO")) continue;
      apply({
        type: "fill",
        ts: fill.ts,
        fillId: `${fill.id}:${fill.makerOrderId ?? fill.orderId ?? "none"}:${fill.matchedAmountDelta ?? fill.size}`,
        orderId: stored.venueOrderId ?? stored.clientOrderId,
        marketKey,
        tokenId,
        outcome,
        side: fill.side,
        size: fill.matchedAmountDelta ?? fill.size,
        price: fill.price,
        ...(fill.fee === undefined ? {} : { feeUsd: fill.fee }),
      });
    }
    for (const order of venue.orders) {
      const stored = this.findStoredOrder(order.id) ?? (order.clientId ? this.stateStore.getOrder(order.clientId) : undefined);
      const marketKey = stored?.marketKey ?? marketKeyFor(order.marketRef, order.tokenId, order.conditionId);
      const tokenId = order.tokenId ?? stored?.tokenId;
      const outcome = order.outcome ?? stored?.outcome;
      const market = marketKey ? catalogs.get(marketKey) : undefined;
      if (!marketKey || !tokenId || (outcome !== "YES" && outcome !== "NO")) continue;
      apply({
        type: "order",
        ts: at,
        marketKey,
        order: {
          orderId: order.id,
          clientId: order.clientId ?? stored?.clientOrderId ?? `external:${order.id}`,
          marketKey,
          marketRef: market?.marketRef ?? order.marketRef,
          conditionId: order.conditionId ?? market?.conditionId ?? "unknown",
          tokenId,
          outcome,
          side: order.side,
          size: order.size,
          filledSize: order.filledSize,
          price: order.price,
          tif: order.tif === "FAK" ? "FAK" : "GTC",
          postOnly: stored?.postOnly ?? false,
          purpose: reducerPurpose(stored, order.side),
          status: stored ? stateReducerStatus(stored.status) : reducerOrderStatus(order.status),
          createdAt: order.createdAt ?? at,
        },
      });
    }
    apply({
      type: "balance",
      ts: at,
      availableCollateralUsd: this.reducerAvailableCollateral(this.collateralBalance(venue.balances).available),
    });
    for (const row of newest.values()) apply({ type: "signal", ts: at, signal: this.publishedSignal(row, at) });
    for (const exact of exactRows) {
      const market = catalogs.get(exact.marketKey);
      if (!market) continue;
      const previous = state.markets[exact.marketKey]?.signal;
      apply({
        type: "signal",
        ts: at,
        signal: {
          id: previous?.id ?? `exact:${exact.marketKey}`,
          marketKey: exact.marketKey,
          nativeMarketId: market.nativeMarketId,
          conditionId: market.conditionId,
          publishedAt: previous?.publishedAt ?? finiteTimestamp(exact.forecastAt, "exact.forecastAt"),
          entryQ: previous?.entryQ ?? exact.qYes * 100,
          entryPm: previous?.entryPm ?? 50,
          latestQ: exact.qYes,
          qAsOf: finiteTimestamp(exact.forecastAt, "exact.forecastAt"),
          active: false,
          livePriced: false,
          suppressionReason: previous?.suppressionReason ?? null,
          retiredReason: retiredReason(exact.retiredReason),
          forecastStatus: exact.forecastStatus.state,
          drawdownRiskElevated: exact.forecastStatus.drawdownRiskElevated,
        },
      });
    }

    const stabilityBefore = new Map(this.stability);
    try {
      for (const [marketKey, market] of [...catalogs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (!newest.has(marketKey) && !heldKeys.has(marketKey)) continue;
        apply({ type: "catalog", ts: at, market });
        const [yesRaw, noRaw] = await Promise.all([
          this.venue.tokenBook!(market.yesTokenId),
          this.venue.tokenBook!(market.noTokenId),
        ]);
        const yesBook: TokenBook = { tokenId: market.yesTokenId, bids: yesRaw.bids, asks: yesRaw.asks, ts: yesRaw.ts };
        const noBook: TokenBook = { tokenId: market.noTokenId, bids: noRaw.bids, asks: noRaw.asks, ts: noRaw.ts };
        // Books are observed after the dry run began; stamping them with its
        // start time would make every one look skewed or stale at the gate.
        apply({ type: "book", ts: this.now(), marketKey, outcome: "YES", book: yesBook });
        apply({ type: "book", ts: this.now(), marketKey, outcome: "NO", book: noBook });
        const signal = state.markets[marketKey]?.signal;
        if (!signal) continue;
        const computed = this.metricsProvider
          ? await this.metricsProvider.snapshots({ now: at, marketKey, signal, catalog: market, yesBook, noBook })
          : this.calculateMetrics(marketKey, signal, yesBook, noBook);
        apply({ type: "volatility", ts: at, marketKey, volatility: computed.volatility });
        apply({ type: "stability", ts: at, marketKey, stability: computed.stability });
      }
    } finally {
      this.stability = stabilityBefore;
    }
    apply({ type: "timer", ts: at });
    if (hydrateInputs) {
      for (const [marketKey, catalog] of catalogs) {
        this.catalogCache.set(marketKey, { value: structuredClone(catalog), fetchedAt: at });
      }
      for (const [marketKey, source] of Object.entries(state.markets)) {
        const target = this.reducerState.markets[marketKey] ??= {
          marketKey,
          orders: {},
          inventoryIncreasingFillsByUtcDay: {},
          shockPausedUntil: 0,
        };
        if (source.signal) target.signal = structuredClone(source.signal);
        if (source.catalog) target.catalog = structuredClone(source.catalog);
        if (source.yesBook) target.yesBook = structuredClone(source.yesBook);
        if (source.noBook) target.noBook = structuredClone(source.noBook);
        if (source.volatility) target.volatility = structuredClone(source.volatility);
        if (source.stability) target.stability = structuredClone(source.stability);
      }
      await this.saveReducerState();
    }
    return { at, actions, decisions, state };
  }

  halt(options: { liquidate?: boolean } = {}): Promise<MarketMakeControllerStatus> {
    return this.serialized(async () => {
      const now = this.now();
      if (options.liquidate && this.stateStore.status().lifecycle === "EXIT_BLOCKED") {
        for (const market of Object.values(this.reducerState.markets)) {
          if (market.inventory?.exitUrgency === "urgent") market.inventory.urgentAttempts = 0;
        }
        this.stateStore.resetExitBlockedForOperatorLiquidation(
          "operator reviewed EXIT_BLOCKED and requested another bounded liquidation window",
          now,
        );
      }
      this.stateStore.halt(options.liquidate ? "operator halt with liquidation" : "operator halt", now);
      await this.processEvent({ type: "halt", ts: now, liquidate: options.liquidate ?? false });
      return this.status();
    });
  }

  resume(options: { acknowledgeLossReset?: boolean } = {}): Promise<MarketMakeControllerStatus> {
    return this.serialized(async () => {
      if (!this.started) throw new Error("market-make controller is not started");
      if (!this.reconciliationApproved) {
        throw new Error("cannot resume: explicit reviewed reconciliation apply is required for this deployment");
      }
      await this.reconcileInternal(true);
      const inventory = await this.adoptResidualInventory(this.lastPositions);
      if (!inventory.consistent) {
        throw new Error("cannot resume: venue inventory does not match durable market-make state");
      }
      await this.pollMarketInputs(this.lastPositions);
      if (this.enableSubscriptions) await this.startSubscriptions();
      if (this.streamRecoveryBlockReason()?.endsWith("has not been followed by authoritative reconciliation")) {
        // The (re)subscription above is only proven by a reconciliation that
        // completes after it. Take that read now instead of refusing resume
        // until the next scheduled tick happens to run.
        await this.reconcileInternal(true);
      }
      const streamBlock = this.streamRecoveryBlockReason();
      if (streamBlock) throw new Error(`cannot resume: ${streamBlock}`);
      const now = this.now();
      const acknowledgeLossReset = options.acknowledgeLossReset ?? false;
      const persistence = this.stateStore.status();
      const durableLossIsLatched = persistence.loss.latched;
      const lossIsLatched = durableLossIsLatched || this.reducerState.lossLatched;
      const accountIsFlat =
        this.lastPositions.every((position) => position.size <= EPSILON) &&
        persistence.counts.activeInventoryCycles === 0 &&
        persistence.counts.activeOrders === 0 &&
        persistence.availability.collateralReservedUsd <= EPSILON &&
        persistence.availability.tokens.every((token) =>
          token.totalQuantity <= EPSILON &&
          token.reservedQuantity <= EPSILON &&
          token.freeQuantity <= EPSILON) &&
        Object.values(this.reducerState.markets).every((market) =>
          market.inventory === undefined &&
          Object.values(market.orders).every((order) =>
            ["CANCELED", "FILLED", "REJECTED"].includes(order.status)));
      const rebaseLoss = acknowledgeLossReset && (lossIsLatched || accountIsFlat);
      const rebasedLoss = rebaseLoss
        ? {
            marketLossUsd: { ...this.reducerState.loss.marketLossUsd },
            rolling24hLossUsd: 0,
            drawdownUsd: 0,
          }
        : undefined;
      if (rebasedLoss) {
        const currentReasons = lossLimitReasons(rebasedLoss, this.config);
        if (currentReasons.length > 0) {
          throw new Error(
            `cannot reset loss stop while current marked market loss still breaches limits: ${currentReasons.join(", ")}`,
          );
        }
      }
      this.stateStore.resume({
        configHash: this.configHash,
        deploymentId: this.deploymentId,
        now,
        acknowledgeLossReset,
        rebaseUnlatchedLoss: rebaseLoss && !durableLossIsLatched,
      });
      if (rebasedLoss) {
        // The durable reset rebases high-water NAV. Drop the matching
        // in-memory rolling window too, or its pre-reset NAV points would
        // immediately re-latch the acknowledged stop on the next tick.
        this.lossHistory = [];
        this.reducerState.loss = rebasedLoss;
      }
      this.marketStreamRecovery = undefined;
      this.userStreamRecovery = undefined;
      await this.processEvent({
        type: "resume",
        ts: now,
        acknowledgeLossReset,
      });
      try {
        await this.heartbeatOnce();
      } catch (error) {
        const reason = `heartbeat failure while resuming: ${error instanceof Error ? error.message : String(error)}`;
        await this.degrade(reason);
        throw new Error(reason);
      }
      return this.status();
    });
  }

  reconcile(options: { apply?: boolean; expectedProposalHash?: string } = {}): Promise<MarketMakeReconcileResult> {
    return this.serialized(async () => {
      const apply = options.apply ?? false;
      const result = await this.reconcileInternal(apply, options.expectedProposalHash, apply);
      if (apply) {
        await this.adoptResidualInventory(this.lastPositions);
        result.books = await this.resnapshotBooks();
        this.reconciliationApproved = true;
      }
      return result;
    });
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    // Every operation leaves the on-disk reducer snapshot current; the write
    // throttle only coalesces the burst of events inside one operation.
    const flushed = async (): Promise<T> => {
      try {
        return await work();
      } finally {
        await this.flushReducerState().catch((error) => {
          this.log.error("market-make reducer snapshot flush failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    };
    const result = this.queue.then(flushed, flushed);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private emptyTick(at: number): MarketMakeTickResult {
    return { at, signals: 0, exactForecasts: 0, catalogs: 0, books: 0, fills: 0, actions: 0, decisions: 0 };
  }

  /**
   * A venue read that failed for a transient reason (rate limit, 5xx, socket
   * reset) is retried on the next cadence rather than degrading, provided an
   * authoritative snapshot succeeded recently. Returns true when the failure
   * was absorbed; the caller then skips the rest of its cycle.
   */
  private tolerateTransientReadFailure(context: string, error: unknown): boolean {
    if (!isTransientVenueReadError(error)) return false;
    const now = this.now();
    const lastGood = this.lastAuthoritativeSnapshotAt;
    if (lastGood === undefined || now - lastGood > AUTHORITATIVE_READ_TOLERANCE_MS) return false;
    this.log.warn("market-make transient venue read failure; retrying on the next cadence", {
      context,
      error: error instanceof Error ? error.message : String(error),
      lastAuthoritativeSnapshotAgeMs: now - lastGood,
    });
    return true;
  }

  private async tickInternal(): Promise<MarketMakeTickResult> {
    const at = this.now();
    if (!this.reconciliationApproved) {
      try {
        const reconciliation = await this.reconcileInternal(false);
        this.lastTickAt = this.now();
        return this.emptyTick(reconciliation.at);
      } catch (error) {
        if (!this.tolerateTransientReadFailure("tick reconciliation", error)) throw error;
        this.lastTickAt = this.now();
        return this.emptyTick(at);
      }
    }
    let reconciliation: MarketMakeReconcileResult;
    try {
      reconciliation = await this.reconcileInternal(true);
    } catch (error) {
      if (!this.tolerateTransientReadFailure("tick reconciliation", error)) throw error;
      this.lastTickAt = this.now();
      return this.emptyTick(at);
    }
    await this.checkStreamFreshness(at);
    // Venue balances are authoritative. Reconcile/adopt them before any Q/book
    // event is allowed to plan inventory-increasing actions.
    const inventory = await this.adoptResidualInventory(this.lastPositions);
    const polled = await this.pollMarketInputs(this.lastPositions, this.quotientPollDue(at));
    const timer = await this.processEvent({ type: "timer", ts: this.now() });
    await this.heartbeatOnce();
    this.lastTickAt = this.now();
    this.lastError = undefined;
    await this.saveReducerState();
    if (this.enableSubscriptions) await this.refreshMarketSubscription();
    if (this.enableSubscriptions) await this.startSubscriptions();
    return {
      at,
      signals: polled.signals,
      exactForecasts: polled.exactForecasts,
      catalogs: polled.catalogs,
      books: polled.books,
      fills: reconciliation.fills,
      actions: polled.actions + inventory.actions + timer.actions,
      decisions: polled.decisions + timer.decisions,
    };
  }

  private async restoreReducerState(): Promise<void> {
    const raw = await this.snapshotStore.get(REDUCER_SNAPSHOT_KEY);
    let lastEventSeq = 0;
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<PersistedReducerSnapshot>;
      if (parsed.schemaVersion !== SNAPSHOT_SCHEMA || !isReducerState(parsed.state)) {
        throw new Error("market-make reducer snapshot is invalid or unsupported");
      }
      // The last proven scale is safe to restore for loss and exit
      // supervision only when both policy and deployment identities match.
      // Live entry authorization is intentionally never restored.
      if (
        runtimeBankrollPolicy(this.policyConfig).mode === "live" &&
        parsed.configHash === this.configHash &&
        parsed.deploymentId === this.deploymentId &&
        typeof parsed.effectiveBankrollUsd === "number" &&
        Number.isFinite(parsed.effectiveBankrollUsd) &&
        parsed.effectiveBankrollUsd > 0
      ) {
        this.applyRuntimeBankroll(parsed.effectiveBankrollUsd);
      }
      this.reducerState = structuredClone(parsed.state);
      this.reducerState.consecutiveOrderRejections ??= 0;
      for (const market of Object.values(this.reducerState.markets)) {
        if (!market.redemption && market.redemptionRequested) {
          market.redemption = {
            status: "failed",
            attempts: 1,
            lastAttemptAt: Number(parsed.savedAt ?? this.now()),
            error: "legacy redemption state restored for verification",
          };
        }
      }
      lastEventSeq = Number(parsed.lastEventSeq ?? 0);
      this.quotientSpendUtcDay = typeof parsed.quotientSpendUtcDay === "string" ? parsed.quotientSpendUtcDay : "";
      this.quotientSpendUsd = Number(parsed.quotientSpendUsd ?? 0);
      this.lastQuotientPollAt = parsed.lastQuotientPollAt === undefined
        ? undefined
        : Number(parsed.lastQuotientPollAt);
      if (parsed.bookHistory && typeof parsed.bookHistory === "object") {
        const cutoff = this.now() - 7 * 24 * 60 * 60 * 1_000;
        for (const [marketKey, rawPoints] of Object.entries(parsed.bookHistory)) {
          if (!Array.isArray(rawPoints)) continue;
          const points = rawPoints
            .filter((point): point is { ts: number; mid: number } =>
              Boolean(point) && Number.isFinite(point.ts) && Number.isFinite(point.mid) && point.ts >= cutoff)
            .sort((left, right) => left.ts - right.ts);
          if (points.length) this.bookHistory.set(marketKey, points);
        }
      }
      if (parsed.bookObservations && typeof parsed.bookObservations === "object") {
        const cutoff = this.now() - 20 * 60 * 1_000;
        for (const [marketKey, rawPoints] of Object.entries(parsed.bookObservations)) {
          if (!Array.isArray(rawPoints)) continue;
          const points = rawPoints
            .filter((point): point is BookObservation => this.validBookObservation(point) && point.ts >= cutoff)
            .sort((left, right) => left.ts - right.ts);
          if (points.length) this.bookObservations.set(marketKey, points);
        }
      }
      if (parsed.lastShocks && typeof parsed.lastShocks === "object") {
        for (const [marketKey, shock] of Object.entries(parsed.lastShocks)) {
          if (shock && Number.isFinite(shock.ts) && typeof shock.fingerprint === "string") {
            this.lastShocks.set(marketKey, { ...shock });
          }
        }
      }
      if (Array.isArray(parsed.lossHistory)) {
        const cutoff = this.now() - 24 * 60 * 60 * 1_000;
        this.lossHistory = parsed.lossHistory
          .filter((point): point is LossHistoryPoint =>
            Boolean(point) && Number.isFinite(point.ts) && Number.isFinite(point.navUsd) && point.ts >= cutoff)
          .sort((left, right) => left.ts - right.ts);
      }
      if (parsed.orderAbsences && typeof parsed.orderAbsences === "object") {
        for (const [clientOrderId, tracker] of Object.entries(parsed.orderAbsences)) {
          if (
            tracker && Number.isSafeInteger(tracker.count) && tracker.count > 0 &&
            Number.isFinite(tracker.firstAbsentAt) && Number.isFinite(tracker.lastAbsentAt) &&
            (tracker.cancelAllIssuedAt === undefined || Number.isFinite(tracker.cancelAllIssuedAt))
          ) this.orderAbsences.set(clientOrderId, { ...tracker });
        }
      }
      if (parsed.cancelFailures && typeof parsed.cancelFailures === "object") {
        for (const [clientOrderId, count] of Object.entries(parsed.cancelFailures)) {
          if (Number.isSafeInteger(count) && count > 0) this.cancelFailures.set(clientOrderId, count);
        }
      }
      if (parsed.cancelAllIssuedAt !== undefined && Number.isFinite(parsed.cancelAllIssuedAt)) {
        this.cancelAllIssuedAt = parsed.cancelAllIssuedAt;
      }
      if (parsed.inventoryMismatches && typeof parsed.inventoryMismatches === "object") {
        for (const [key, tracker] of Object.entries(parsed.inventoryMismatches)) {
          if (
            tracker && Number.isSafeInteger(tracker.count) && tracker.count > 0 &&
            Number.isFinite(tracker.firstSeenAt) && Number.isFinite(tracker.lastSeenAt) &&
            Number.isFinite(tracker.expectedQuantity) && Number.isFinite(tracker.venueQuantity)
          ) this.inventoryMismatches.set(key, {
            ...tracker,
            ...(typeof tracker.fingerprint === "string" ? { fingerprint: tracker.fingerprint } : {}),
          });
        }
      }
      if (parsed.inventoryCorrectionWatermarks && typeof parsed.inventoryCorrectionWatermarks === "object") {
        for (const [marketKey, watermark] of Object.entries(parsed.inventoryCorrectionWatermarks)) {
          if (
            watermark && typeof watermark.tokenId === "string" && watermark.tokenId.length > 0 &&
            Number.isFinite(watermark.correctedAt) &&
            Number.isFinite(watermark.remainingCoveredSellQuantity) &&
            watermark.remainingCoveredSellQuantity > EPSILON
          ) this.inventoryCorrectionWatermarks.set(marketKey, { ...watermark });
        }
      }
      if (parsed.suppressedAuthoritativeFillIds && typeof parsed.suppressedAuthoritativeFillIds === "object") {
        for (const [fillId, suppressed] of Object.entries(parsed.suppressedAuthoritativeFillIds)) {
          if (suppressed === true) this.suppressedAuthoritativeFillIds.add(fillId);
        }
      }
      if (this.validStreamRecoveryGate(parsed.marketStreamRecovery)) {
        this.marketStreamRecovery = { ...parsed.marketStreamRecovery };
      }
      if (this.validStreamRecoveryGate(parsed.userStreamRecovery)) {
        this.userStreamRecovery = { ...parsed.userStreamRecovery };
      }
      if (parsed.stability && typeof parsed.stability === "object") {
        for (const [marketKey, tracker] of Object.entries(parsed.stability)) {
          if (
            tracker &&
            Number.isFinite(tracker.qAsOf) &&
            (tracker.outcome === "YES" || tracker.outcome === "NO") &&
            Number.isFinite(tracker.validSince) &&
            Number.isFinite(tracker.bestDistancePp) &&
            Number.isFinite(tracker.maxMoveAwayFromQPp)
          ) this.stability.set(marketKey, { ...tracker });
        }
      }
    } else {
      this.reducerState = createInitialMarketMakeState(this.config);
    }

    // Replay only the events the snapshot has not absorbed. Exporting the whole
    // database here once loaded the decision telemetry (hundreds of MB after a
    // day of watching dozens of markets) and exhausted the heap on a 1GB box.
    for (const row of this.stateStore.readEventsAfter(lastEventSeq)) {
      const seq = row.seq;
      const parsed = NormalizedMarketMakeEventSchema.safeParse(row.payload);
      if (!parsed.success) throw new Error(`persisted market-make event ${row.eventId} is invalid`);
      const event = parsed.data as NormalizedMarketMakeEvent;
      this.reducerState = reduceMarketMake(this.reducerState, event, this.config).state;
      this.rememberEvent(event);
      lastEventSeq = seq;
    }
    this.hydrateCachesFromReducer();
    this.lastFillCursor = this.stateStore.latestFillTimestamp();
    await this.saveReducerState(lastEventSeq);
  }

  private hydrateCachesFromReducer(): void {
    for (const [marketKey, market] of Object.entries(this.reducerState.markets)) {
      if (market.catalog) this.catalogCache.set(marketKey, { value: market.catalog, fetchedAt: 0 });
      if (market.yesBook) this.rememberBook(marketKey, market.yesBook);
    }
  }

  private shouldPersistDecision(decision: DecisionRecord): boolean {
    if (decision.actions > 0) return true;
    const key = decision.marketKey ?? `portfolio:${decision.decision}`;
    // The sizing identity is part of the verdict: a deposit that rescales limits
    // must leave a persisted row even when the reasons did not change.
    const sizing = decision.sizing;
    const fingerprint = [
      decision.decision,
      [...decision.reasons].sort().join(","),
      sizing?.effectiveConfigHash ?? "",
      sizing?.effectiveBankrollUsd ?? "",
      sizing?.bankrollEntryReady ?? "",
    ].join("|");
    const previous = this.lastPersistedDecision.get(key);
    if (previous && previous.fingerprint === fingerprint && decision.ts - previous.ts < DECISION_HEARTBEAT_MS) return false;
    this.lastPersistedDecision.set(key, { fingerprint, ts: decision.ts });
    return true;
  }

  /** Mark the snapshot stale after an event and write it at most every few seconds. */
  private async persistReducerStateThrottled(seq: number): Promise<void> {
    this.reducerSnapshotDirtySeq = Math.max(this.reducerSnapshotDirtySeq ?? 0, seq);
    if (Date.now() - this.lastReducerSnapshotWallClockAt < REDUCER_SNAPSHOT_MIN_INTERVAL_MS) return;
    await this.flushReducerState();
  }

  /** Write the snapshot now if any event has been reduced since the last write. */
  private async flushReducerState(): Promise<void> {
    if (this.reducerSnapshotDirtySeq === undefined) return;
    await this.saveReducerState(this.reducerSnapshotDirtySeq);
  }

  private async saveReducerState(lastEventSeq?: number): Promise<void> {
    this.reducerSnapshotDirtySeq = undefined;
    this.lastReducerSnapshotWallClockAt = Date.now();
    const latest = lastEventSeq ?? this.stateStore.readEvents(1)[0]?.seq ?? 0;
    const snapshot: PersistedReducerSnapshot = {
      schemaVersion: SNAPSHOT_SCHEMA,
      configHash: this.configHash,
      deploymentId: this.deploymentId,
      effectiveBankrollUsd: this.effectiveBankrollUsd,
      lastEventSeq: latest,
      savedAt: this.now(),
      quotientSpendUtcDay: this.quotientSpendUtcDay,
      quotientSpendUsd: this.quotientSpendUsd,
      ...(this.lastQuotientPollAt === undefined ? {} : { lastQuotientPollAt: this.lastQuotientPollAt }),
      bookHistory: Object.fromEntries(
        [...this.bookHistory].map(([marketKey, points]) => [marketKey, this.compactBookHistory(points)]),
      ),
      bookObservations: Object.fromEntries(
        [...this.bookObservations].map(([marketKey, points]) => [marketKey, points.filter((point) => point.ts >= this.now() - 20 * 60 * 1_000)]),
      ),
      lastShocks: Object.fromEntries(this.lastShocks),
      lossHistory: this.lossHistory.filter((point) => point.ts >= this.now() - 24 * 60 * 60 * 1_000),
      orderAbsences: Object.fromEntries(this.orderAbsences),
      cancelFailures: Object.fromEntries(this.cancelFailures),
      ...(this.cancelAllIssuedAt === undefined ? {} : { cancelAllIssuedAt: this.cancelAllIssuedAt }),
      inventoryMismatches: Object.fromEntries(this.inventoryMismatches),
      inventoryCorrectionWatermarks: Object.fromEntries(this.inventoryCorrectionWatermarks),
      suppressedAuthoritativeFillIds: Object.fromEntries(
        [...this.suppressedAuthoritativeFillIds].map((fillId) => [fillId, true] as const),
      ),
      ...(this.marketStreamRecovery === undefined ? {} : { marketStreamRecovery: this.marketStreamRecovery }),
      ...(this.userStreamRecovery === undefined ? {} : { userStreamRecovery: this.userStreamRecovery }),
      stability: Object.fromEntries(this.stability),
      state: this.reducerState,
    };
    await this.snapshotStore.set(REDUCER_SNAPSHOT_KEY, JSON.stringify(snapshot));
  }

  private attachDecisionSizing(decisions: DecisionRecord[]): void {
    const bankroll = runtimeBankrollPolicy(this.policyConfig);
    const reference = this.policyConfig.capital.sizing_bankroll_usd;
    const sizing: NonNullable<DecisionRecord["sizing"]> = {
      policyConfigHash: this.configHash,
      effectiveConfigHash: marketMakeConfigHash(this.config),
      bankrollMode: bankroll.mode,
      bankrollObserved: this.bankrollObserved,
      bankrollEntryReady: this.bankrollEntryReady,
      bankrollRefreshPending: this.bankrollRefreshPending,
      strategyCapitalUsd: this.strategyCapitalUsd,
      effectiveBankrollUsd: this.effectiveBankrollUsd,
      bankrollReferenceUsd: reference,
      ...(bankroll.ceilingUsd === undefined ? {} : { bankrollCeilingUsd: bankroll.ceilingUsd }),
      bankrollScale: reference > 0 ? this.effectiveBankrollUsd / reference : 0,
    };
    for (const decision of decisions) decision.sizing = { ...sizing };
  }

  private async processEvent(event: NormalizedMarketMakeEvent, execute = true): Promise<EventResult> {
    if ([
      "fill",
      "order",
      "cancel-confirmed",
      "reward",
      "inventory-reconciled",
      "redemption",
      "execution",
    ].includes(event.type)) {
      this.settlementQuiescent = false;
    }
    const eventId = eventDigest(event);
    if (!this.stateStore.appendEvent({
      eventId,
      ts: event.ts,
      type: event.type,
      ...(event.type === "signal"
        ? { marketKey: event.signal.marketKey }
        : event.type === "catalog"
          ? { marketKey: event.market.marketKey }
          : "marketKey" in event
            ? { marketKey: event.marketKey }
            : {}),
      payload: event,
    })) {
      return { applied: false, actions: 0, decisions: 0 };
    }
    const lifecycleBefore = this.stateStore.status().lifecycle;
    const rejectionsBefore = this.reducerState.consecutiveOrderRejections ?? 0;
    const pauseBefore = this.reducerState.globalEntryPausedUntil;
    const reduced = reduceMarketMake(this.reducerState, event, this.config);
    this.attachDecisionSizing(reduced.decisions);
    this.reducerState = reduced.state;
    const terminalExit = reduced.decisions.find((decision) => decision.decision === "exit-blocked");
    const postFillHardCap = reduced.decisions.find((decision) => decision.decision === "post-fill-hard-cap-breach");
    let forcedBlockedCancels: Array<Extract<MarketMakeAction, { kind: "cancel" }>> = [];
    let terminalExitError: { reason: string; marketKey?: string } | undefined;
    let postFillHardCapError: { reason: string; marketKey?: string } | undefined;
    if (terminalExit) {
      const reason = terminalExit.reasons.join("; ") || "bounded urgent exit retry budget exhausted";
      this.reducerState.halted = true;
      this.stateStore.setExitOnlyLifecycle("EXIT_BLOCKED", reason, event.ts);
      if (lifecycleBefore !== "EXIT_BLOCKED") {
        forcedBlockedCancels = this.cancelActionsForEveryWorkingEntry(
          "EXIT_BLOCKED cancels every resting inventory add",
        );
      }
      terminalExitError = {
        reason,
        ...(terminalExit.marketKey === undefined ? {} : { marketKey: terminalExit.marketKey }),
      };
    }
    if (postFillHardCap) {
      const reason = postFillHardCap.reasons.join("; ") || "late BUY fill breached a hard portfolio cap";
      this.reducerState.halted = true;
      if (!terminalExit && lifecycleBefore !== "EXIT_BLOCKED") {
        this.stateStore.setExitOnlyLifecycle("RISK_EXIT_ONLY", reason, event.ts);
      }
      postFillHardCapError = {
        reason,
        ...(postFillHardCap.marketKey === undefined ? {} : { marketKey: postFillHardCap.marketKey }),
      };
    }
    this.rememberEvent(event);
    const seq = this.stateStore.readEvents(1)[0]?.seq ?? 0;
    for (let index = 0; index < reduced.decisions.length; index += 1) {
      const decision = reduced.decisions[index]!;
      if (!this.shouldPersistDecision(decision)) continue;
      this.stateStore.appendDecision({
        decisionId: `${eventId}:${index}`,
        ts: decision.ts,
        kind: decision.decision,
        decision,
        marketKey: decision.marketKey,
        configHash: this.configHash,
        rationale: decision.reasons.join("; "),
      });
    }
    await this.persistReducerStateThrottled(seq);
    if (
      rejectionsBefore < 3 &&
      (this.reducerState.consecutiveOrderRejections ?? 0) >= 3 &&
      this.reducerState.globalEntryPausedUntil > pauseBefore
    ) {
      await this.operationalError(
        "MM_ORDER_REJECTION_PAUSE",
        "three consecutive venue order rejections paused all new entries",
        { pausedUntil: this.reducerState.globalEntryPausedUntil },
      );
    }
    const actions = [
      ...forcedBlockedCancels,
      ...reduced.actions.filter((action) =>
        action.kind !== "cancel" || !forcedBlockedCancels.some((forced) => forced.orderId === action.orderId)),
    ];
    if (execute) {
      for (const action of actions) await this.executeAction(action, event.ts);
    }
    if (terminalExitError) {
      await this.operationalError("MM_EXIT_BLOCKED", terminalExitError.reason, {
        ...(terminalExitError.marketKey === undefined ? {} : { marketKey: terminalExitError.marketKey }),
        lifecycle: "EXIT_BLOCKED",
      });
    }
    if (postFillHardCapError) {
      await this.operationalError("MM_POST_FILL_HARD_CAP_BREACH", postFillHardCapError.reason, {
        ...(postFillHardCapError.marketKey === undefined ? {} : { marketKey: postFillHardCapError.marketKey }),
        lifecycle: terminalExit ? "EXIT_BLOCKED" : "RISK_EXIT_ONLY",
      });
    }
    return { applied: true, actions: actions.length, decisions: reduced.decisions.length };
  }

  private cancelActionsForEveryWorkingEntry(
    reason: string,
    includeUnknown = true,
  ): Array<Extract<MarketMakeAction, { kind: "cancel" }>> {
    const actions: Array<Extract<MarketMakeAction, { kind: "cancel" }>> = [];
    for (const market of Object.values(this.reducerState.markets)) {
      for (const order of Object.values(market.orders)) {
        if (
          order.purpose !== "entry" || order.side !== "BUY" ||
          ["CANCELED", "FILLED", "REJECTED", "CANCEL_PENDING"].includes(order.status)
        ) continue;
        const stored = this.findStoredOrder(order.orderId) ?? this.findStoredOrder(order.clientId);
        if (!includeUnknown && (stored?.purpose === "UNKNOWN" || stored?.status === "UNKNOWN")) continue;
        order.status = "CANCEL_PENDING";
        actions.push({
          kind: "cancel",
          orderId: order.orderId,
          marketKey: market.marketKey,
          marketRef: order.marketRef,
          reason,
        });
      }
    }
    return actions;
  }

  private entryBudgetReady(): boolean {
    return runtimeBankrollPolicy(this.policyConfig).mode === "fixed" ||
      (this.bankrollObserved && this.bankrollEntryReady && !this.bankrollRefreshPending &&
        this.effectiveBankrollUsd > EPSILON);
  }

  private async enforceEntryBudgetGate(now: number): Promise<void> {
    const reserveFloor = this.config.capital.minimum_free_collateral_usd +
      this.config.capital.operational_reserve_usd;
    const reserveReady = this.stateStore.availability().collateralFreeUsd + EPSILON >= reserveFloor;
    if (this.entryBudgetReady() && reserveReady) return;
    const reason = this.entryBudgetReady()
      ? "authoritative free collateral fell below the configured reserve floor"
      : this.bankrollRefreshPending
        ? "funded bankroll increase is pausing adds until the settlement window and repeated snapshots pass"
        : "live bankroll is zero or has not passed repeated authoritative observation";
    const actions = this.cancelActionsForEveryWorkingEntry(
      reason,
      false,
    );
    for (const action of actions) await this.executeAction(action, now);
    if (actions.length > 0) await this.saveReducerState();
  }

  private rememberEvent(event: NormalizedMarketMakeEvent): void {
    this.lastEventAt = Math.max(this.lastEventAt ?? 0, event.ts);
    if (event.type === "book" && event.outcome === "YES") this.rememberBook(event.marketKey, event.book);
  }

  private rememberBook(marketKey: string, book: TokenBook): void {
    const value = mid(book);
    if (value === undefined) return;
    const history = this.bookHistory.get(marketKey) ?? [];
    if (!history.some((point) => point.ts === book.ts && Math.abs(point.mid - value) <= EPSILON)) {
      history.push({ ts: book.ts, mid: value });
      history.sort((a, b) => a.ts - b.ts);
    }
    this.bookHistory.set(marketKey, this.compactBookHistory(history));
  }

  private compactBookHistory(points: Array<{ ts: number; mid: number }>): Array<{ ts: number; mid: number }> {
    const now = this.now();
    const cutoff = now - 7 * 24 * 60 * 60 * 1_000;
    const highFrequencyCutoff = now - 20 * 60 * 1_000;
    const hourly = new Map<number, { ts: number; mid: number }>();
    const recent: Array<{ ts: number; mid: number }> = [];
    for (const point of points.sort((left, right) => left.ts - right.ts)) {
      if (point.ts < cutoff) continue;
      if (point.ts >= highFrequencyCutoff) recent.push(point);
      else hourly.set(Math.floor(point.ts / 3_600_000), point);
    }
    return [...hourly.values(), ...recent];
  }

  private validBookObservation(value: unknown): value is BookObservation {
    if (!value || typeof value !== "object") return false;
    const point = value as Record<string, unknown>;
    return ["ts", "yesMid", "noMid", "yesSpreadPp", "noSpreadPp", "yesBidDepthUsd", "noBidDepthUsd"]
      .every((key) => Number.isFinite(point[key]));
  }

  private validStreamRecoveryGate(value: unknown): value is StreamRecoveryGate {
    if (!value || typeof value !== "object") return false;
    const gate = value as Record<string, unknown>;
    return Number.isSafeInteger(gate.generation) && Number(gate.generation) > 0 &&
      typeof gate.reason === "string" && gate.reason.length > 0 &&
      Number.isFinite(gate.requiredAt) &&
      ["reconnectedAt", "reconnectReconcileSequence", "messageAt", "messageAfterReconcileSequence", "reconciledAt"]
        .every((key) => gate[key] === undefined || Number.isFinite(gate[key]));
  }

  private async executeAction(action: MarketMakeAction, now: number): Promise<void> {
    if (action.kind === "place") await this.executePlace(action, now);
    else if (action.kind === "cancel") await this.executeCancel(action, now);
    else if (action.kind === "redeem") await this.executeRedemption(action);
  }

  private async executeRedemption(action: Extract<MarketMakeAction, { kind: "redeem" }>): Promise<void> {
    const inventory = this.reducerState.markets[action.marketKey]?.inventory;
    if (!inventory) return;
    if (!this.venue.redeem) {
      await this.processEvent({
        type: "redemption",
        ts: this.now(),
        marketKey: action.marketKey,
        status: "failed",
        error: "venue adapter does not support redemption",
      });
      return;
    }

    let positions: Position[];
    try {
      positions = await this.venue.positions(this.account);
      this.lastPositions = positions;
    } catch (error) {
      await this.processEvent({
        type: "redemption",
        ts: this.now(),
        marketKey: action.marketKey,
        status: "failed",
        error: `pre-redemption position verification failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    const position = this.redemptionPosition(action.marketKey, inventory.tokenId, positions);
    if (!position) {
      await this.processEvent({
        type: "redemption",
        ts: this.now(),
        marketKey: action.marketKey,
        status: "failed",
        error: "position absent during pre-submission check; awaiting repeated reconciliation",
      });
      return;
    }
    this.inventoryMismatches.delete(this.redemptionVerificationKey(action.marketKey));
    if (!position.redeemable) {
      await this.processEvent({
        type: "redemption",
        ts: this.now(),
        marketKey: action.marketKey,
        status: "failed",
        error: "venue position is not currently redeemable",
      });
      return;
    }

    // Persist the attempt before the external call. A crash or timeout after
    // submission is then verification-only and can never blindly submit a
    // duplicate redemption transaction.
    const payoutUsd = position.currentPrice === undefined
      ? undefined
      : position.currentPrice * position.size;
    await this.processEvent({
      type: "redemption",
      ts: this.now(),
      marketKey: action.marketKey,
      status: "submitted",
      quantity: position.size,
      ...(payoutUsd !== undefined && Number.isFinite(payoutUsd) && payoutUsd >= 0 ? { payoutUsd } : {}),
    });
    try {
      const receipt = await this.venue.redeem(this.account, position);
      const reference = receipt?.transactionHash ?? receipt?.transactionId;
      if (reference) {
        await this.processEvent({
          type: "redemption",
          ts: this.now(),
          marketKey: action.marketKey,
          status: "submitted",
          reference,
        });
      }
    } catch (error) {
      const message = `redemption outcome uncertain: ${error instanceof Error ? error.message : String(error)}`;
      await this.processEvent({
        type: "redemption",
        ts: this.now(),
        marketKey: action.marketKey,
        status: "submitted",
        error: message,
      });
      await this.operationalError("MM_REDEMPTION_UNCERTAIN", message, { marketKey: action.marketKey });
      return;
    }

    try {
      const verified = await this.venue.positions(this.account);
      this.lastPositions = verified;
      if (!this.redemptionPosition(action.marketKey, inventory.tokenId, verified)) {
        await this.observeSubmittedRedemptionAbsence(
          action.marketKey,
          inventory.tokenId,
          inventory.outcome,
          this.now(),
        );
      }
    } catch (error) {
      // Submission may already be final. Leave it SUBMITTED and verify again
      // on a later reconciliation instead of falsely declaring failure.
      this.log.warn("market-make redemption submitted but could not yet be verified", {
        marketKey: action.marketKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private redemptionPosition(marketKey: string, tokenId: string, positions: Position[]): Position | undefined {
    return positions.find((position) =>
      position.size > EPSILON &&
      position.tokenId === tokenId &&
      this.marketKeyFor(position.marketRef, position.tokenId, position.conditionId) === marketKey);
  }

  private redemptionVerificationKey(marketKey: string): string {
    return `redemption:${marketKey}`;
  }

  private async observeSubmittedRedemptionAbsence(
    marketKey: string,
    tokenId: string,
    outcome: "YES" | "NO",
    now: number,
  ): Promise<boolean> {
    const key = this.redemptionVerificationKey(marketKey);
    const tracker = this.noteInventoryMismatch(key, `${marketKey}:${tokenId}:zero`, 1, 0, now);
    const threshold = Math.max(2, this.config.global_kill_switches.unresolved_inventory_mismatch_cycles);
    if (tracker.count < threshold) {
      await this.saveReducerState();
      return false;
    }
    if (this.stateStore.listOrders({ activeOnly: true, marketKey }).length > 0) {
      await this.saveReducerState();
      return false;
    }
    await this.confirmRedemption(marketKey, tokenId, outcome);
    return true;
  }

  private async confirmRedemption(
    marketKey: string,
    tokenId: string,
    outcome: "YES" | "NO",
  ): Promise<void> {
    const now = this.now();
    if (this.stateStore.listOrders({ activeOnly: true, marketKey }).length > 0) {
      throw new Error(`cannot confirm redemption for ${marketKey} while orders remain unresolved`);
    }
    this.stateStore.reconcileInventoryQuantity({ marketKey, tokenId, quantity: 0, costBasisUsd: 0, now });
    await this.processEvent({ type: "redemption", ts: now, marketKey, status: "confirmed" });
    this.inventoryMismatches.delete(`market:${marketKey}`);
    this.inventoryMismatches.delete(this.redemptionVerificationKey(marketKey));
    await this.alert("resolution", `Redemption confirmed for ${marketKey}`, {
      marketKey,
      asset: tokenId,
      outcome,
    });
    this.log.info("market-make redemption confirmed by zero venue position", { marketKey, tokenId, outcome });
  }

  private async executePlace(action: Extract<MarketMakeAction, { kind: "place" }>, now: number): Promise<void> {
    if (action.purpose === "entry" && !this.stateStore.status().activationCurrent) {
      await this.emitRejectedAction(action, "entry blocked while activation is not current", now);
      return;
    }
    if (action.purpose === "entry" && !this.entryBudgetReady()) {
      await this.emitRejectedAction(action, "entry blocked until funded bankroll is authoritatively established", now);
      return;
    }
    const available = this.stateStore.availability(action.tokenId);
    const reserveFloor = this.config.capital.minimum_free_collateral_usd + this.config.capital.operational_reserve_usd;
    const maxSize = action.side === "BUY"
      ? Math.max(0, available.collateralFreeUsd - reserveFloor) / action.limitPrice
      : available.tokens.find((token) => token.tokenId === action.tokenId)?.freeQuantity ?? 0;
    const size = Math.min(action.size, maxSize);
    if (!(size > EPSILON)) {
      await this.emitRejectedAction(action, `no free ${action.side === "BUY" ? "collateral" : "inventory"}`, now);
      return;
    }

    const cycleId = this.cycleIdFor(action, now);
    const intent: OrderIntent = {
      marketRef: action.marketRef,
      conditionId: action.conditionId,
      tokenId: action.tokenId,
      outcome: action.outcome,
      side: action.side,
      size,
      limitPrice: action.limitPrice,
      tif: action.tif,
      postOnly: action.postOnly,
      purpose: action.purpose === "entry" ? "entry" : action.purpose === "urgent-exit" ? "urgent-exit" : "normal-exit",
      clientId: action.clientId,
    };
    let prepared = false;
    try {
      this.stateStore.reserveOrder({
        clientOrderId: action.clientId,
        marketKey: action.marketKey,
        ...(cycleId ? { cycleId } : {}),
        tokenId: action.tokenId,
        outcome: action.outcome,
        side: action.side,
        purpose: statePurpose(action.purpose),
        quantity: size,
        limitPrice: action.limitPrice,
        tif: action.tif,
        postOnly: action.postOnly,
        now,
        metadata: { reason: action.reason, ...this.reducerPlacement(action.marketKey, action.clientId) },
      });
      const revalidation = await this.revalidateBeforeSubmit(action, size, now);
      if (revalidation !== undefined) {
        this.stateStore.rejectOrder(action.clientId, revalidation, this.now());
        await this.emitRejectedAction(action, revalidation, this.now(), size);
        return;
      }
      const ack = await this.venue.placeOrderWithLifecycle!(this.account, intent, {
        onPrepared: async (meta) => {
          prepared = true;
          this.stateStore.recordSignedOrderHash(action.clientId, meta.preparedHash, this.now());
          this.stateStore.markOrderSubmitting(action.clientId, this.now());
        },
      });
      if (ack.preparedHash && !prepared) {
        this.stateStore.recordSignedOrderHash(action.clientId, ack.preparedHash, this.now());
        this.stateStore.markOrderSubmitting(action.clientId, this.now());
        prepared = true;
      }
      const cumulativeAck = ack.status === "filled" || ack.status === "partial";
      if (ack.status === "rejected") {
        this.stateStore.rejectOrder(action.clientId, "venue rejected order", this.now());
      } else if (ack.status === "canceled") {
        this.stateStore.acknowledgeOrder(action.clientId, ack.orderId, this.now());
        this.stateStore.confirmCancellation(action.clientId, this.now());
      } else if (cumulativeAck) {
        this.stateStore.acknowledgeOrderUnknown(
          action.clientId,
          ack.orderId,
          "cumulative fill acknowledgement awaiting authoritative trade feed",
          this.now(),
        );
      } else {
        this.stateStore.acknowledgeOrder(action.clientId, ack.orderId, this.now());
      }
      const placement = this.reducerPlacement(action.marketKey, action.clientId, ack.orderId);
      await this.processEvent({
        type: "order",
        ts: this.now(),
        marketKey: action.marketKey,
        order: {
          orderId: ack.orderId,
          clientId: action.clientId,
          marketKey: action.marketKey,
          marketRef: action.marketRef,
          conditionId: action.conditionId,
          tokenId: ack.tokenId ?? action.tokenId,
          outcome: action.outcome,
          side: action.side,
          size,
          filledSize: 0,
          price: action.limitPrice,
          tif: action.tif,
          postOnly: action.postOnly,
          ...placement,
          purpose: action.purpose,
          status: cumulativeAck ? "UNKNOWN" : reducerOrderStatus(ack.status),
          createdAt: now,
        },
      });
      await this.processEvent({
        type: "execution",
        ts: this.now(),
        marketKey: action.marketKey,
        clientId: action.clientId,
        status: ack.status === "rejected" ? "rejected" : "accepted",
        ...(ack.status === "rejected" ? { reason: "venue rejected order" } : {}),
      });
      if (action.side === "SELL" && (ack.status === "canceled" || ack.status === "rejected")) {
        await this.processEvent({
          type: "cancel-confirmed",
          ts: this.now(),
          marketKey: action.marketKey,
          orderId: ack.orderId,
        });
      }
      if (cumulativeAck) {
        // ACK fill fields are cumulative and have no stable trade id. Keep all
        // risk reserved until the authoritative trade feed is reconciled. A
        // post-only order reaching this ambiguous path also revokes entry
        // activation so later actions from the same reduction cannot add risk.
        if (this.stateStore.status().lifecycle !== "EXIT_BLOCKED") {
          this.stateStore.setExitOnlyLifecycle(
            "RECONCILING",
            `cumulative venue acknowledgement for ${action.clientId} awaits authoritative fills`,
            this.now(),
          );
        }
        await this.processEvent({ type: "halt", ts: this.now(), liquidate: false });
        await this.reconcileInternal(true);
        await this.adoptResidualInventory(this.lastPositions);
      }
      if (ack.status === "open" || ack.status === "partial") {
        try {
          await this.heartbeatOnce();
        } catch (error) {
          // The venue has already acknowledged this order. Heartbeat failure
          // is a liveness incident, not an ambiguous placement, so it must
          // never fall into the submission catch and rewrite OPEN as UNKNOWN.
          const reason = `heartbeat failed after acknowledged order ${ack.orderId}: ${error instanceof Error ? error.message : String(error)}`;
          try {
            await this.latchEmergencyDegrade(reason);
          } catch (latchError) {
            this.lastError = reason;
            this.reducerState.halted = true;
            try {
              this.stateStore.setExitOnlyLifecycle("DATA_DEGRADED", reason, this.now());
            } catch (persistenceError) {
              this.log.error("market-make could not persist post-ack heartbeat degradation", {
                orderId: ack.orderId,
                error: persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
              });
            }
            this.log.error("market-make post-ack heartbeat safety latch failed", {
              orderId: ack.orderId,
              error: latchError instanceof Error ? latchError.message : String(latchError),
            });
          }
          try {
            await this.degrade(reason);
          } catch (degradeError) {
            this.log.error("market-make post-ack heartbeat degradation failed", {
              orderId: ack.orderId,
              error: degradeError instanceof Error ? degradeError.message : String(degradeError),
            });
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const persisted = this.stateStore.getOrder(action.clientId);
      if (prepared || persisted?.signedOrderHash) {
        this.stateStore.markSubmissionUnknown(action.clientId, message, this.now());
      } else if (persisted) {
        this.stateStore.rejectOrder(action.clientId, message, this.now());
      }
      await this.processEvent({
        type: "order",
        ts: this.now(),
        marketKey: action.marketKey,
        order: {
          orderId: persisted?.venueOrderId ?? action.clientId,
          clientId: action.clientId,
          marketKey: action.marketKey,
          marketRef: action.marketRef,
          conditionId: action.conditionId,
          tokenId: action.tokenId,
          outcome: action.outcome,
          side: action.side,
          size,
          filledSize: persisted?.filledQuantity ?? 0,
          price: action.limitPrice,
          tif: action.tif,
          postOnly: action.postOnly,
          ...this.reducerPlacement(action.marketKey, action.clientId, persisted?.venueOrderId),
          purpose: action.purpose,
          status: prepared ? "UNKNOWN" : "REJECTED",
          createdAt: now,
        },
      });
      if (action.side === "SELL" && !prepared) {
        await this.processEvent({
          type: "cancel-confirmed",
          ts: this.now(),
          marketKey: action.marketKey,
          orderId: persisted?.venueOrderId ?? action.clientId,
        });
      }
      this.log.error("market-make order failed", { clientId: action.clientId, error: message, ambiguous: prepared });
    }
  }

  private async emitRejectedAction(
    action: Extract<MarketMakeAction, { kind: "place" }>,
    reason: string,
    now: number,
    size = action.size,
  ): Promise<void> {
    await this.processEvent({
      type: "order",
      ts: now,
      marketKey: action.marketKey,
      order: {
        orderId: action.clientId,
        clientId: action.clientId,
        marketKey: action.marketKey,
        marketRef: action.marketRef,
        conditionId: action.conditionId,
        tokenId: action.tokenId,
        outcome: action.outcome,
        side: action.side,
        size,
        filledSize: 0,
        price: action.limitPrice,
        tif: action.tif,
        postOnly: action.postOnly,
        ...this.reducerPlacement(action.marketKey, action.clientId),
        purpose: action.purpose,
        status: "REJECTED",
        createdAt: now,
      },
    });
    if (action.side === "SELL") {
      await this.processEvent({
        type: "cancel-confirmed",
        ts: now,
        marketKey: action.marketKey,
        orderId: action.clientId,
      });
    }
    await this.alert("skipped-order", `Market-make order skipped: ${reason}`, {
      clientId: action.clientId,
      marketKey: action.marketKey,
      outcome: action.outcome,
      side: action.side,
      purpose: action.purpose,
    });
    this.log.warn("market-make action rejected before venue submission", { clientId: action.clientId, reason });
  }

  private cycleIdFor(action: Extract<MarketMakeAction, { kind: "place" }>, now: number): string | undefined {
    const active = this.stateStore.listInventoryCycles(true).find((cycle) => cycle.marketKey === action.marketKey);
    if (action.purpose === "entry") return active?.cycleId ?? `cycle:${action.marketKey}:${action.outcome}:${action.clientId}`;
    if (active) return active.cycleId;
    const inventory = this.reducerState.markets[action.marketKey]?.inventory;
    if (!inventory) return undefined;
    const cycleId = `cycle:${action.marketKey}:${inventory.outcome}:${inventory.firstFillAt}`;
    try {
      this.stateStore.createInventoryCycle({
        cycleId,
        marketKey: action.marketKey,
        outcome: inventory.outcome,
        tokenId: inventory.tokenId,
        status: "RESIDUAL",
        quantity: inventory.freeQuantity,
        costBasisUsd: inventory.avgCost * inventory.freeQuantity,
        firstFillAt: inventory.firstFillAt,
        anchorQVersion: String(inventory.anchorQAsOf),
        anchorQProbability: inventory.anchorQSide,
        anchorExecutionPrice: inventory.anchorFillPrice,
        renewalUsed: inventory.renewalUsed,
        createdAt: now,
      });
    } catch (error) {
      const existing = this.stateStore.listInventoryCycles(true).find((cycle) => cycle.marketKey === action.marketKey);
      if (existing) return existing.cycleId;
      throw error;
    }
    return cycleId;
  }

  private async executeCancel(action: Extract<MarketMakeAction, { kind: "cancel" }>, now: number): Promise<void> {
    const stored = this.findStoredOrder(action.orderId);
    if (stored && ["CANCELED", "FILLED", "REJECTED"].includes(stored.status)) return;
    const venueId = stored?.venueOrderId ?? (action.orderId.startsWith("mm:") ? undefined : action.orderId);
    const ambiguous = stored !== undefined && (
      ["SIGNED", "SUBMITTING", "UNKNOWN"].includes(stored.status) ||
      this.orderAbsences.has(stored.clientOrderId)
    );
    if (ambiguous && stored) {
      this.orderAbsences.set(stored.clientOrderId, this.orderAbsences.get(stored.clientOrderId) ?? {
        count: 0,
        firstAbsentAt: now,
        lastAbsentAt: now,
      });
    }
    if (stored) this.stateStore.requestCancel(stored.clientOrderId, now);
    if (!venueId) return;
    try {
      await this.venue.cancelOrder(this.account, venueId);
      if (ambiguous) return;
      if (stored) this.stateStore.confirmCancellation(stored.clientOrderId, this.now());
      await this.processEvent({
        type: "cancel-confirmed",
        ts: this.now(),
        marketKey: action.marketKey,
        orderId: action.orderId,
      });
    } catch (error) {
      this.log.warn("market-make cancel remains pending", {
        orderId: venueId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private findStoredOrder(id: string): MarketMakeOrder | undefined {
    return this.stateStore.getOrder(id) ?? this.stateStore.listOrders().find((order) => order.venueOrderId === id);
  }

  private reducerPlacement(
    marketKey: string,
    clientId: string,
    orderId?: string,
  ): Pick<TrackedOrder, "qAsOfAtPlacement" | "qSideAtPlacement" | "bestBidAtPlacement"> {
    const orders = Object.values(this.reducerState.markets[marketKey]?.orders ?? {});
    const planned = orders.find((order) =>
      order.clientId === clientId || order.orderId === clientId || (orderId !== undefined && order.orderId === orderId));
    return {
      ...(planned?.qAsOfAtPlacement === undefined ? {} : { qAsOfAtPlacement: planned.qAsOfAtPlacement }),
      ...(planned?.qSideAtPlacement === undefined ? {} : { qSideAtPlacement: planned.qSideAtPlacement }),
      ...(planned?.bestBidAtPlacement === undefined ? {} : { bestBidAtPlacement: planned.bestBidAtPlacement }),
    };
  }

  private async revalidateBeforeSubmit(
    action: Extract<MarketMakeAction, { kind: "place" }>,
    size: number,
    now: number,
  ): Promise<string | undefined> {
    const market = this.reducerState.markets[action.marketKey];
    const catalog = this.catalogCache.get(action.marketKey)?.value ?? market?.catalog;
    if (!market || !catalog) return "market catalog disappeared before submission";
    const checkedAt = this.now();
    if (action.purpose === "entry") {
      const streamBlock = this.streamRecoveryBlockReason();
      if (streamBlock) return streamBlock;
      const runtime = this.stateStore.status();
      const ownReservation = this.stateStore.getOrder(action.clientId)?.status === "RESERVED";
      const otherTransitional = this.stateStore.listOrders({ activeOnly: true }).some((order) =>
        order.clientOrderId !== action.clientId &&
        ["RESERVED", "SIGNED", "SUBMITTING", "UNKNOWN", "CANCEL_PENDING"].includes(order.status));
      const activationIdentityCurrent =
        runtime.lifecycle === "ACTIVE" &&
        runtime.configuredHash === this.configHash &&
        runtime.deploymentId === this.deploymentId &&
        runtime.activationConfigHash === this.configHash &&
        runtime.activationDeploymentId === this.deploymentId &&
        runtime.activationHash === marketMakeActivationHash(this.configHash, this.deploymentId) &&
        runtime.lastReconciliation?.ok === true &&
        runtime.deploymentUpdatedAt !== undefined &&
        runtime.lastReconciliation.ts >= runtime.deploymentUpdatedAt &&
        !runtime.loss.latched &&
        ownReservation &&
        !otherTransitional;
      if ((!runtime.activationCurrent && !activationIdentityCurrent) || this.reducerState.halted || this.reducerState.lossLatched) {
        return "entry authorization changed before submission";
      }
      if (
        !catalog.active || catalog.closed || catalog.archived ||
        !catalog.acceptingOrders || !catalog.orderbookEnabled
      ) return "market stopped accepting entries before submission";
      if (this.reducerState.globalEntryPausedUntil > checkedAt) {
        return "global entry pause became active before submission";
      }
      const planned = Object.values(market.orders).find((order) => order.clientId === action.clientId);
      if (!planned || planned.status !== "PLANNED") {
        return "planned entry was canceled or superseded before submission";
      }
      if (catalog.endsAt - checkedAt < this.config.market_catalog.minimum_seconds_to_end_at_entry * 1_000) {
        return "market is too close to its end before submission";
      }
      if (market.shockPausedUntil > checkedAt) return "market shock pause became active before submission";
      if (
        market.requireQAfterShockAsOf !== undefined &&
        (market.signal?.qAsOf ?? 0) <= market.requireQAfterShockAsOf
      ) return "entry awaits a post-shock Q version";
    }
    const [yesRaw, noRaw] = await Promise.all([
      this.venue.tokenBook!(catalog.yesTokenId),
      this.venue.tokenBook!(catalog.noTokenId),
    ]);
    const yesBook: TokenBook = { tokenId: catalog.yesTokenId, bids: yesRaw.bids, asks: yesRaw.asks, ts: yesRaw.ts };
    const noBook: TokenBook = { tokenId: catalog.noTokenId, bids: noRaw.bids, asks: noRaw.asks, ts: noRaw.ts };
    const staleMs = this.config.market_data.market_data_stale_seconds * 1_000;
    const skewMs = this.config.global_kill_switches.max_clock_skew_seconds * 1_000;
    if (
      checkedAt - yesBook.ts > staleMs || checkedAt - noBook.ts > staleMs ||
      yesBook.ts - checkedAt > skewMs || noBook.ts - checkedAt > skewMs
    ) return "book became stale or clock-skewed before submission";
    const selected = action.outcome === "YES" ? yesBook : noBook;
    const bestBid = selected.bids.reduce((best, level) => Math.max(best, level.price), 0);
    const bestAsk = selected.asks.reduce((best, level) => Math.min(best, level.price), Number.POSITIVE_INFINITY);
    if (!(bestBid > 0) || !Number.isFinite(bestAsk) || bestBid >= bestAsk) return "selected-token book became invalid before submission";
    if (action.postOnly) {
      if (action.side === "BUY" && action.limitPrice >= bestAsk - EPSILON) return "post-only BUY would cross current ask";
      if (action.side === "SELL" && action.limitPrice <= bestBid + EPSILON) return "post-only SELL would cross current bid";
    }
    if (action.purpose !== "entry") return undefined;
    if (!market.signal?.active) return "signal became inactive before submission";
    if (checkedAt - market.signal.qAsOf > this.config.quotient_feed.new_entry_max_forecast_age_seconds * 1_000) {
      return "Q became stale before submission";
    }
    const placement = this.reducerPlacement(action.marketKey, action.clientId);
    if (placement.qAsOfAtPlacement !== undefined && market.signal.qAsOf !== placement.qAsOfAtPlacement) {
      return "Q version changed before submission";
    }
    const spreadPp = (bestAsk - bestBid) * 100;
    if (
      spreadPp > this.config.eligibility.max_selected_token_book_spread_pp + EPSILON ||
      spreadPp > this.config.eligibility.hard_max_selected_token_book_spread_pp + EPSILON
    ) return "selected-token spread widened beyond entry limit";
    const yesMid = mid(yesBook);
    const noMid = mid(noBook);
    if (yesMid === undefined || noMid === undefined) return "YES/NO book became empty or crossed";
    if (Math.abs(yesMid + noMid - 1) * 100 > this.config.market_data.max_yes_no_midpoint_complement_error_pp + EPSILON) {
      return "YES/NO midpoint complement check failed before submission";
    }
    const selectedMid = action.outcome === "YES" ? yesMid : noMid;
    const qSide = action.outcome === "YES" ? market.signal.qYes : 1 - market.signal.qYes;
    const liveEdgePp = (qSide - selectedMid) * 100;
    const direction = this.config.direction_policy[action.outcome];
    if (
      liveEdgePp + EPSILON < direction.minimum_edge_pp ||
      liveEdgePp > direction.maximum_edge_pp + EPSILON ||
      liveEdgePp > this.config.eligibility.q_market_edge_max_pp + EPSILON
    ) return "live Q edge left the configured entry band before submission";
    if (!(selectedMid > this.config.eligibility.min_selected_side_price && selectedMid < this.config.eligibility.max_selected_side_price)) {
      return "selected-token price left its entry interval before submission";
    }
    if (qSide + EPSILON < this.config.eligibility.min_q_probability_on_selected_side) {
      return "selected-side Q probability fell below its entry minimum";
    }
    const depth1c = exitBidDepthUsd(selected, 1);
    const depth2c = exitBidDepthUsd(selected, 2);
    const liquidity = this.config.cassie_overrides.liquidity;
    if (depth1c + EPSILON < liquidity.minimum_exit_bid_depth_1c_usd) {
      return "selected-token exit bid depth within 1c fell below its minimum";
    }
    if (depth2c + EPSILON < liquidity.minimum_exit_bid_depth_2c_usd) {
      return "selected-token exit bid depth within 2c fell below its minimum";
    }
    if (depth2c + EPSILON < this.config.eligibility.min_live_depth_usd_within_2c) {
      return "selected-token depth fell below entry minimum";
    }
    const participation = liquidityParticipationCaps(
      depth1c,
      depth2c,
      this.config.capital.max_order_notional_usd,
      Math.min(direction.target_market_cost_usd, this.config.capital.hard_market_cost_usd),
      this.config,
    );
    const plannedNotional = action.size * action.limitPrice;
    const existingCommitted = Math.max(0, marketCommittedUsd(market) - plannedNotional);
    const allowedNotional = Math.min(
      participation.orderCapUsd,
      Math.max(0, participation.marketCapUsd - existingCommitted),
      depth2c * this.config.quote_model.size_cap_fraction_of_depth_within_2c,
      bestBidLevelUsd(selected) * this.config.quote_model.size_cap_fraction_of_best_level,
    );
    if (size * action.limitPrice > allowedNotional + EPSILON) {
      return "entry exceeds refreshed quote-model liquidity cap";
    }
    const availability = this.stateStore.availability(action.tokenId);
    const reserveFloor = this.config.capital.minimum_free_collateral_usd + this.config.capital.operational_reserve_usd;
    if (availability.collateralFreeUsd + EPSILON < reserveFloor) return "entry would consume protected collateral reserves";
    return undefined;
  }

  private async reconcileInternal(
    apply: boolean,
    expectedProposalHash?: string,
    requireProposalHash = false,
  ): Promise<MarketMakeReconcileResult> {
    // Any new authoritative read attempt invalidates the previous withdrawal
    // proof. Only the end of a successful applied reconciliation may publish
    // a fresh quiescent result.
    this.settlementQuiescent = false;
    const userWakeGeneration = this.userWakeGeneration;
    const reconciliationSequence = ++this.reconcileSequence;
    const snapshot = await this.readVenueSnapshot();
    if (this.enableSubscriptions) this.lastUserRestAt = snapshot.at;
    const mappedOrders = snapshot.orders
      .filter((order) => order.size - order.filledSize > EPSILON)
      .map((order) => this.reconciledOrder(order));
    const proposedUnknownByIdentity = new Map<string, MarketMakeReconcileResult["proposals"]["unknownOrdersToCancel"][number]>();
    const addUnknownProposal = (order: {
      venueOrderId?: string;
      clientOrderId?: string;
      marketKey: string;
      tokenId: string;
      outcome: "YES" | "NO";
      side: "BUY" | "SELL";
      remainingQuantity: number;
      limitPrice: number;
    }): void => {
      const identity = order.venueOrderId ?? order.clientOrderId;
      if (!identity) return;
      proposedUnknownByIdentity.set(identity, {
        ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}),
        ...(order.clientOrderId ? { clientOrderId: order.clientOrderId } : {}),
        marketKey: order.marketKey,
        tokenId: order.tokenId,
        outcome: order.outcome,
        side: order.side,
        remainingQuantity: order.remainingQuantity,
        limitPrice: order.limitPrice,
      });
    };
    for (const order of mappedOrders) {
      if (order.purpose === "UNKNOWN") addUnknownProposal(order);
    }
    for (const order of this.stateStore.listOrders({ activeOnly: true })) {
      if (order.purpose !== "UNKNOWN" && order.status !== "UNKNOWN") continue;
      addUnknownProposal({
        ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}),
        clientOrderId: order.clientOrderId,
        marketKey: order.marketKey,
        tokenId: order.tokenId,
        outcome: order.outcome,
        side: order.side,
        remainingQuantity: Math.max(0, order.quantity - order.filledQuantity),
        limitPrice: order.limitPrice,
      });
    }
    const unknownOrderProposals = [...proposedUnknownByIdentity.values()]
      .sort((left, right) =>
        (left.venueOrderId ?? left.clientOrderId ?? "").localeCompare(right.venueOrderId ?? right.clientOrderId ?? ""));
    const observedInventory = snapshot.positions.flatMap((position) => {
      if (!(position.size > EPSILON) || !position.tokenId || (position.outcome !== "YES" && position.outcome !== "NO")) return [];
      const marketKey = this.marketKeyFor(position.marketRef, position.tokenId, position.conditionId);
      return [{
        marketKey,
        tokenId: position.tokenId,
        outcome: position.outcome,
        quantity: position.size,
        costBasisUsd: Math.max(0, position.avgPrice * position.size),
        managed: !marketKey.startsWith("unmanaged:"),
      }];
    });
    const expectedInventory = new Map(
      this.stateStore.listInventoryCycles(true).map((cycle) => [cycle.marketKey, {
        tokenId: cycle.tokenId,
        outcome: cycle.outcome,
        quantity: cycle.quantity,
        costBasisUsd: cycle.costBasisUsd,
      }]),
    );
    for (const [marketKey, market] of Object.entries(this.reducerState.markets)) {
      if (!market.inventory || expectedInventory.has(marketKey)) continue;
      expectedInventory.set(marketKey, {
        tokenId: market.inventory.tokenId,
        outcome: market.inventory.outcome,
        quantity: market.inventory.freeQuantity,
        costBasisUsd: Math.max(0, market.inventory.avgCost * market.inventory.freeQuantity),
      });
    }
    const observedByMarket = new Map<string, typeof observedInventory>();
    for (const row of observedInventory) {
      const rows = observedByMarket.get(row.marketKey) ?? [];
      rows.push(row);
      observedByMarket.set(row.marketKey, rows);
    }
    const residualInventory: MarketMakeReconcileResult["proposals"]["residualInventory"] = observedInventory.flatMap((row) => {
      const expected = expectedInventory.get(row.marketKey);
      const observedRows = observedByMarket.get(row.marketKey) ?? [];
      const reason = !row.managed
        ? "unmanaged"
        : !expected
          ? "missing-durable-cycle"
          : observedRows.length !== 1 || expected.tokenId !== row.tokenId || expected.outcome !== row.outcome
            ? "identity-conflict"
            : Math.abs(expected.quantity - row.quantity) > 0.01
              ? "quantity-mismatch"
              : undefined;
      return reason === undefined ? [] : [{
        ...row,
        reason,
        application: "observe-and-authorize-repeated-reconciliation" as const,
      }];
    });
    for (const [marketKey, expected] of expectedInventory) {
      if ((observedByMarket.get(marketKey) ?? []).length > 0) continue;
      residualInventory.push({
        marketKey,
        tokenId: expected.tokenId,
        outcome: expected.outcome,
        quantity: 0,
        costBasisUsd: 0,
        managed: true,
        reason: "venue-position-absent",
        application: "observe-and-authorize-repeated-reconciliation",
      });
    }
    residualInventory.sort((left, right) =>
      `${left.marketKey}:${left.tokenId}:${left.outcome}`.localeCompare(`${right.marketKey}:${right.tokenId}:${right.outcome}`));
    const proposals: MarketMakeReconcileResult["proposals"] = {
      unknownOrdersToCancel: unknownOrderProposals,
      residualInventory,
      inventoryApplication: {
        mode: "repeated-authoritative-snapshots",
        minimumMatchingSnapshots: Math.max(1, this.config.global_kill_switches.unresolved_inventory_mismatch_cycles),
        note: "apply authorizes observation; adoption/correction occurs only after the configured repeated-snapshot and late-fill gates pass",
      },
    };
    const proposalHash = this.reconciliationProposalHash(snapshot, proposals);
    const unknownOrders = unknownOrderProposals.length;
    this.lastPositions = snapshot.positions;
    if (apply && requireProposalHash) {
      if (!expectedProposalHash) {
        throw new Error("reconciliation apply requires the proposal hash from a fresh report-only preview");
      }
      if (expectedProposalHash !== proposalHash) {
        throw new Error(`reconciliation proposal changed since preview (expected ${expectedProposalHash}, observed ${proposalHash})`);
      }
    }
    const settlementQuiescent = this.bankrollSnapshotIsSettlementQuiescent(
      snapshot,
      residualInventory.length > 0,
    );
    this.observeRuntimeBankroll(snapshot, settlementQuiescent, apply);
    if (!apply) {
      return {
        at: snapshot.at,
        applied: false,
        balances: snapshot.balances.length,
        positions: snapshot.positions.length,
        openOrders: snapshot.orders.length,
        fills: snapshot.fills.length,
        unknownOrders,
        canceledUnknownOrders: 0,
        books: 0,
        proposalHash,
        proposals,
      };
    }
    this.prepareAmbiguousOrdersForReconciliation(snapshot.orders, snapshot.at);

    const reconciliationId = `runtime:${snapshot.at}:${reconciliationSequence}`;
    const tokenBalances = snapshot.positions.flatMap((position) =>
      position.tokenId && (position.outcome === "YES" || position.outcome === "NO")
        ? [{
            tokenId: position.tokenId,
            marketKey: this.marketKeyFor(position.marketRef, position.tokenId, position.conditionId),
            outcome: position.outcome,
            totalQuantity: position.size,
          }]
        : [],
    );
    const collateral = this.collateralBalance(snapshot.balances);
    const activeBefore = this.stateStore.listOrders({ activeOnly: true });
    this.stateStore.reconcileSnapshot({
      reconciliationId: `${reconciliationId}:open`,
      ts: snapshot.at,
      collateralTotalUsd: collateral.total,
      balances: tokenBalances,
      openOrders: mappedOrders,
      completeBalances: true,
      completeOpenOrders: false,
      source: "polymarket-rest-pre-fill",
    });

    let appliedFills = 0;
    for (const fill of snapshot.fills.sort((a, b) => a.ts - b.ts)) {
      if (await this.ingestFill(fill)) appliedFills += 1;
    }
    for (const order of snapshot.orders) await this.ingestOrder(order, snapshot.at);
    await this.processEvent({
      type: "balance",
      ts: snapshot.at,
      availableCollateralUsd: this.reducerAvailableCollateral(collateral.available),
    });

    this.stateStore.reconcileSnapshot({
      reconciliationId: `${reconciliationId}:final`,
      ts: snapshot.at,
      collateralTotalUsd: collateral.total,
      balances: tokenBalances,
      openOrders: mappedOrders,
      completeBalances: true,
      // A single absent REST page is not enough to release a signed risk
      // reservation. resolveAbsentOrders() quarantines it across snapshots,
      // cancels globally, and only then confirms a terminal state.
      completeOpenOrders: false,
      source: "polymarket-rest-authoritative",
    });
    await this.retryCancelPendingOrders(snapshot.orders, snapshot.at);
    await this.resolveAbsentOrders(snapshot.orders, snapshot.at);
    const activeAfter = new Map(this.stateStore.listOrders({ activeOnly: true }).map((order) => [order.clientOrderId, order]));
    for (const previous of activeBefore) {
      if (!activeAfter.has(previous.clientOrderId)) {
        await this.emitPersistedOrderState(this.stateStore.getOrder(previous.clientOrderId) ?? previous, snapshot.at);
      }
    }
    await this.recoverReducerOrders(snapshot.orders, snapshot.at);
    await this.enforceEntryBudgetGate(snapshot.at);

    let canceledUnknownOrders = 0;
    const proposedUnknownIds = new Set(unknownOrderProposals.flatMap((order) =>
      [order.venueOrderId, order.clientOrderId].filter((id): id is string => Boolean(id))));
    for (const order of this.stateStore.listOrders({ activeOnly: true })) {
      if ((order.purpose !== "UNKNOWN" && order.status !== "UNKNOWN") || !order.venueOrderId) continue;
      if (!proposedUnknownIds.has(order.venueOrderId) && !proposedUnknownIds.has(order.clientOrderId)) continue;
      try {
        this.orderAbsences.set(order.clientOrderId, this.orderAbsences.get(order.clientOrderId) ?? {
          count: 0,
          firstAbsentAt: snapshot.at,
          lastAbsentAt: snapshot.at,
        });
        this.stateStore.requestCancel(order.clientOrderId, snapshot.at);
        await this.venue.cancelOrder(this.account, order.venueOrderId);
        // A successful cancel bounds only the unknown remainder. It cannot
        // disprove a cumulative fill whose authoritative trade is delayed.
        canceledUnknownOrders += 1;
      } catch (error) {
        this.log.warn("unmanaged order cancellation remains pending", {
          orderId: order.venueOrderId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.enforceUnresolvedOrderGate(snapshot.at);
    this.lastPositions = snapshot.positions;
    this.lastAuthoritativeSnapshotAt = snapshot.at;
    this.lastFillCursor = Math.max(this.lastFillCursor, ...snapshot.fills.map((fill) => fill.ts), 0);
    this.markStreamReconciled(reconciliationSequence, snapshot.at);
    if (settlementQuiescent && userWakeGeneration === this.userWakeGeneration) {
      this.settlementQuiescent = true;
      this.settlementQuiescentAt = snapshot.at;
    } else {
      this.settlementQuiescent = false;
    }
    await this.saveReducerState();
    return {
      at: snapshot.at,
      applied: true,
      balances: snapshot.balances.length,
      positions: snapshot.positions.length,
      openOrders: snapshot.orders.length,
      fills: appliedFills,
      unknownOrders,
      canceledUnknownOrders,
      books: 0,
      proposalHash,
      proposals,
    };
  }

  private prepareAmbiguousOrdersForReconciliation(venueOrders: Order[], now: number): void {
    const present = new Set(venueOrders.flatMap((order) => [order.id, order.clientId].filter((id): id is string => Boolean(id))));
    for (const order of this.stateStore.listOrders({ activeOnly: true })) {
      if (present.has(order.clientOrderId) || (order.venueOrderId && present.has(order.venueOrderId))) continue;
      if (order.status === "RESERVED") {
        this.stateStore.rejectOrder(order.clientOrderId, "reserved order was never prepared before restart", now);
      } else if (order.status === "SIGNED") {
        this.stateStore.markSubmissionUnknown(order.clientOrderId, "signed order recovered without acknowledgement", now);
      }
    }
  }

  private venueOrderIdentities(venueOrders: Order[]): Set<string> {
    return new Set(
      venueOrders.flatMap((order) => [order.id, order.clientId].filter((id): id is string => Boolean(id))),
    );
  }

  /** Retry known cancel-pending orders while the authoritative snapshot still shows them live. */
  private async retryCancelPendingOrders(venueOrders: Order[], now: number): Promise<void> {
    const present = this.venueOrderIdentities(venueOrders);
    for (const order of this.stateStore.listOrders({ activeOnly: true })) {
      if (order.status !== "CANCEL_PENDING" || !order.venueOrderId) continue;
      if (!present.has(order.venueOrderId) && !present.has(order.clientOrderId)) continue;
      try {
        await this.venue.cancelOrder(this.account, order.venueOrderId);
        if (this.orderAbsences.has(order.clientOrderId)) continue;
        this.stateStore.confirmCancellation(order.clientOrderId, this.now());
        this.cancelFailures.delete(order.clientOrderId);
        await this.processEvent({
          type: "cancel-confirmed",
          ts: this.now(),
          marketKey: order.marketKey,
          orderId: order.venueOrderId,
        });
      } catch (error) {
        const failures = (this.cancelFailures.get(order.clientOrderId) ?? 0) + 1;
        this.cancelFailures.set(order.clientOrderId, failures);
        this.log.warn("market-make cancel retry failed", {
          orderId: order.venueOrderId,
          failures,
          error: error instanceof Error ? error.message : String(error),
        });
        if (failures >= CANCEL_FAILURE_ESCALATION) {
          await this.issueCancelAllQuarantine(now, `cancel failed ${failures} times for ${order.clientOrderId}`);
        }
      }
    }
  }

  /**
   * Keep absent signed/submitted orders reserved across multiple independent
   * REST snapshots. Before releasing them, issue cancel-all and require a
   * later snapshot to remain absent. This closes the POST/eventual-consistency
   * window without inventing a fill.
   */
  private async resolveAbsentOrders(venueOrders: Order[], now: number): Promise<void> {
    const present = this.venueOrderIdentities(venueOrders);
    const active = this.stateStore.listOrders({ activeOnly: true });
    for (const order of active) {
      if (present.has(order.clientOrderId) || (order.venueOrderId && present.has(order.venueOrderId))) {
        this.orderAbsences.delete(order.clientOrderId);
        continue;
      }
      if (order.status === "RESERVED") {
        this.stateStore.rejectOrder(order.clientOrderId, "reserved order was never signed or submitted", now);
        await this.emitPersistedOrderState(this.stateStore.getOrder(order.clientOrderId)!, now);
        continue;
      }
      if (order.status === "SIGNED") {
        this.stateStore.markSubmissionUnknown(
          order.clientOrderId,
          "signed order is absent from the current venue snapshot",
          now,
        );
      }
      const previous = this.orderAbsences.get(order.clientOrderId);
      const tracker: OrderAbsenceTracker = {
        count: (previous?.count ?? 0) + 1,
        firstAbsentAt: previous?.firstAbsentAt ?? now,
        lastAbsentAt: now,
        ...(previous?.cancelAllIssuedAt === undefined ? {} : { cancelAllIssuedAt: previous.cancelAllIssuedAt }),
      };
      this.orderAbsences.set(order.clientOrderId, tracker);
    }

    const threshold = Math.max(2, this.config.global_kill_switches.unresolved_inventory_mismatch_cycles);
    const needsCancelAll = [...this.orderAbsences.entries()].some(([clientOrderId, tracker]) =>
      tracker.count >= threshold &&
      tracker.cancelAllIssuedAt === undefined &&
      this.stateStore.getOrder(clientOrderId) !== undefined,
    );
    if (needsCancelAll) await this.issueCancelAllQuarantine(now, "ambiguous order absent across reconciliation snapshots");

    for (const [clientOrderId, tracker] of [...this.orderAbsences]) {
      if (tracker.cancelAllIssuedAt === undefined || now <= tracker.cancelAllIssuedAt) continue;
      const order = this.stateStore.getOrder(clientOrderId);
      if (!order || !this.stateStore.listOrders({ activeOnly: true }).some((candidate) => candidate.clientOrderId === clientOrderId)) {
        this.orderAbsences.delete(clientOrderId);
        continue;
      }
      if (present.has(order.clientOrderId) || (order.venueOrderId && present.has(order.venueOrderId))) continue;
      this.stateStore.confirmCancellation(clientOrderId, now);
      await this.emitPersistedOrderState(this.stateStore.getOrder(clientOrderId)!, now);
      this.orderAbsences.delete(clientOrderId);
      this.cancelFailures.delete(clientOrderId);
    }
  }

  private async issueCancelAllQuarantine(now: number, reason: string): Promise<void> {
    // One successful cancel-all covers every currently ambiguous order. Do not
    // release reservations until a later venue snapshot confirms absence.
    if (
      this.cancelAllIssuedAt !== undefined &&
      now - this.cancelAllIssuedAt < this.config.reconciliation.rest_reconcile_seconds * 1_000
    ) return;
    try {
      await this.venue.cancelAll(this.account);
      this.cancelAllIssuedAt = now;
      for (const order of this.stateStore.listOrders({ activeOnly: true })) {
        // Every potentially resting submitted order, including an ordinary
        // OPEN/PARTIALLY_FILLED acknowledgement that vanished from REST, must
        // receive the cancel-all watermark before its reservation is released.
        if (order.status === "RESERVED") continue;
        const tracker = this.orderAbsences.get(order.clientOrderId) ?? {
          count: 1,
          firstAbsentAt: now,
          lastAbsentAt: now,
        };
        this.orderAbsences.set(order.clientOrderId, { ...tracker, cancelAllIssuedAt: now });
      }
      this.heartbeatSuppressed = false;
      this.log.warn("market-make issued cancel-all quarantine", { reason });
    } catch (error) {
      // Keep the venue dead-man heartbeat alive until authoritative
      // reconciliation proves the outstanding orders are gone. Cancellation
      // retries remain controlled rather than relying on heartbeat expiry.
      this.heartbeatSuppressed = false;
      this.reducerState.halted = true;
      if (this.stateStore.status().lifecycle !== "EXIT_BLOCKED") {
        this.stateStore.setExitOnlyLifecycle(
          "DATA_DEGRADED",
          `cancel-all failed while quarantining ambiguous orders: ${error instanceof Error ? error.message : String(error)}`,
          now,
        );
      }
      // Reduce the halt even when every affected reducer order was already
      // CANCEL_PENDING, then retry every durable working order individually.
      // Heartbeats continue until reconciliation makes those orders terminal.
      await this.processEvent({ type: "halt", ts: now, liquidate: false });
      await this.retryEveryWorkingOrderCancellation(now, reason);
      this.log.error("market-make cancel-all quarantine failed; halt is latched and each working order was retried", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.operationalError(
        "MM_CANCEL_ALL_FAILED",
        `cancel-all failed while quarantining ambiguous orders: ${error instanceof Error ? error.message : String(error)}`,
        { reason },
      );
    }
  }

  private async retryEveryWorkingOrderCancellation(
    now: number,
    reason: string,
    emitReducerEvents = true,
  ): Promise<void> {
    for (const order of this.stateStore.listOrders({ activeOnly: true })) {
      const ambiguous =
        this.orderAbsences.has(order.clientOrderId) ||
        ["SIGNED", "SUBMITTING", "UNKNOWN"].includes(order.status);
      this.stateStore.requestCancel(order.clientOrderId, now);
      if (!order.venueOrderId) continue;
      try {
        await this.venue.cancelOrder(this.account, order.venueOrderId);
        if (ambiguous) continue;
        this.stateStore.confirmCancellation(order.clientOrderId, this.now());
        this.cancelFailures.delete(order.clientOrderId);
        if (emitReducerEvents) {
          await this.processEvent({
            type: "cancel-confirmed",
            ts: this.now(),
            marketKey: order.marketKey,
            orderId: order.venueOrderId,
          });
        }
      } catch (error) {
        const failures = (this.cancelFailures.get(order.clientOrderId) ?? 0) + 1;
        this.cancelFailures.set(order.clientOrderId, failures);
        this.log.warn("market-make individual cancellation retry failed after cancel-all failure", {
          clientOrderId: order.clientOrderId,
          venueOrderId: order.venueOrderId,
          reason,
          failures,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async enforceUnresolvedOrderGate(now: number): Promise<void> {
    const unresolved = this.stateStore.listOrders({ activeOnly: true }).filter((order) =>
      ["RESERVED", "SIGNED", "SUBMITTING", "UNKNOWN", "CANCEL_PENDING"].includes(order.status));
    if (unresolved.length === 0) {
      this.heartbeatSuppressed = false;
      if (this.orderAbsences.size === 0) this.cancelAllIssuedAt = undefined;
      return;
    }
    const reason = `${unresolved.length} unresolved order state(s) require reconciliation`;
    const lifecycle = this.stateStore.status().lifecycle;
    if (!["DATA_DEGRADED", "RISK_EXIT_ONLY", "EXIT_BLOCKED"].includes(lifecycle)) {
      this.stateStore.setExitOnlyLifecycle("RECONCILING", reason, now);
    }
    if (!this.reducerState.halted) await this.processEvent({ type: "halt", ts: now, liquidate: false });
  }

  private async recoverReducerOrders(venueOrders: Order[], now: number): Promise<void> {
    const present = new Set(venueOrders.flatMap((order) => [order.id, order.clientId].filter((id): id is string => Boolean(id))));
    for (const market of Object.values(this.reducerState.markets)) {
      for (const order of Object.values(market.orders)) {
        if (["CANCELED", "FILLED", "REJECTED"].includes(order.status)) continue;
        const persisted = this.findStoredOrder(order.orderId) ?? this.stateStore.getOrder(order.clientId);
        if (persisted) {
          if (["CANCELED", "FILLED", "REJECTED"].includes(persisted.status)) {
            await this.emitPersistedOrderState(persisted, now);
          }
          continue;
        }
        if (present.has(order.orderId) || present.has(order.clientId)) continue;
        await this.processEvent({
          type: "order",
          ts: now,
          marketKey: order.marketKey,
          order: { ...order, status: "REJECTED" },
        });
      }
    }
  }

  private async emitPersistedOrderState(order: MarketMakeOrder, ts: number): Promise<void> {
    const market = this.reducerState.markets[order.marketKey];
    const catalog = this.catalogCache.get(order.marketKey)?.value ?? market?.catalog;
    const reducer = Object.values(market?.orders ?? {}).find((candidate) =>
      candidate.clientId === order.clientOrderId || candidate.orderId === order.venueOrderId);
    await this.processEvent({
      type: "order",
      ts,
      marketKey: order.marketKey,
      order: {
        orderId: order.venueOrderId ?? order.clientOrderId,
        clientId: order.clientOrderId,
        marketKey: order.marketKey,
        marketRef: catalog?.marketRef ?? reducer?.marketRef ?? order.marketKey,
        conditionId: catalog?.conditionId ?? reducer?.conditionId ?? "unknown",
        tokenId: order.tokenId,
        outcome: order.outcome,
        side: order.side,
        size: order.quantity,
        filledSize: order.filledQuantity,
        price: order.limitPrice,
        tif: order.tif === "FAK" ? "FAK" : "GTC",
        postOnly: order.postOnly,
        ...(reducer?.qAsOfAtPlacement === undefined ? {} : { qAsOfAtPlacement: reducer.qAsOfAtPlacement }),
        ...(reducer?.qSideAtPlacement === undefined ? {} : { qSideAtPlacement: reducer.qSideAtPlacement }),
        ...(reducer?.bestBidAtPlacement === undefined ? {} : { bestBidAtPlacement: reducer.bestBidAtPlacement }),
        purpose: reducerPurpose(order, order.side),
        status: stateReducerStatus(order.status),
        createdAt: order.createdAt,
      },
    });
  }

  private async readVenueSnapshot(): Promise<VenueSnapshot> {
    const at = this.now();
    // REST trade indexes can publish a trade after a newer matchedAt value has
    // already advanced our cursor. Re-read a bounded overlap and rely on the
    // durable composite fill id for idempotency.
    const fillSince = Math.max(0, this.lastFillCursor - FILL_CURSOR_OVERLAP_MS);
    const [balances, positions, orders, fills] = await Promise.all([
      this.venue.balances(this.account),
      this.venue.positions(this.account),
      this.venue.openOrders(this.account),
      this.venue.fills(this.account, fillSince),
    ]);
    return { at, balances, positions, orders, fills };
  }

  private collateralBalance(balances: Balance[]): { total: number; available: number } {
    const collateral = balances.find((balance) => /^(p?usd[cet]?|usdc)$/i.test(balance.asset));
    if (!collateral) throw new Error("authoritative Polymarket snapshot has no collateral balance");
    const total = Number(collateral.total);
    const available = Number(collateral.available);
    if (!Number.isFinite(total) || total < 0 || !Number.isFinite(available) || available < 0) {
      throw new Error("authoritative Polymarket collateral balance is invalid");
    }
    if (available > total + EPSILON) {
      throw new Error("authoritative Polymarket available collateral exceeds total collateral");
    }
    return { total, available };
  }

  private reducerAvailableCollateral(venueAvailableUsd: number): number {
    return Math.max(0, Math.min(venueAvailableUsd, this.effectiveBankrollUsd));
  }

  private authoritativeEconomicSnapshot(snapshot: VenueSnapshot): Record<string, unknown> {
    const balances = canonicalRowSort(snapshot.balances.map((balance, index) => ({
      asset: balance.asset,
      total: economicNumber(balance.total, `authoritative balance ${index} total`),
      available: economicNumber(balance.available, `authoritative balance ${index} available`),
    })));
    const positions = canonicalRowSort(snapshot.positions.map((position, index) => {
      const marketKey = this.marketKeyFor(position.marketRef, position.tokenId, position.conditionId);
      return {
        marketKey,
        managed: !marketKey.startsWith("unmanaged:"),
        marketRef: position.marketRef,
        tokenId: position.tokenId ?? null,
        conditionId: position.conditionId ?? null,
        outcome: position.outcome ?? null,
        side: position.side,
        quantity: economicNumber(position.size, `authoritative position ${index} size`),
        averageCost: economicNumber(position.avgPrice, `authoritative position ${index} average price`),
        costBasisUsd: economicNumber(
          position.size * position.avgPrice,
          `authoritative position ${index} cost basis`,
        ),
        redeemable: position.redeemable === true,
      };
    }));
    const orders = canonicalRowSort(snapshot.orders.map((order, index) => ({
      id: order.id,
      clientId: order.clientId ?? null,
      marketRef: order.marketRef,
      tokenId: order.tokenId ?? null,
      conditionId: order.conditionId ?? null,
      outcome: order.outcome ?? null,
      side: order.side,
      quantity: economicNumber(order.size, `authoritative order ${index} size`),
      filledQuantity: economicNumber(order.filledSize, `authoritative order ${index} filled size`),
      limitPrice: economicNumber(order.price, `authoritative order ${index} price`),
      tif: order.tif ?? null,
      status: order.status,
      createdAt: order.createdAt === undefined
        ? null
        : economicNumber(order.createdAt, `authoritative order ${index} createdAt`),
    })));
    const fills = canonicalRowSort(snapshot.fills.map((fill, index) => ({
      id: fill.id,
      orderId: fill.orderId ?? null,
      makerOrderId: fill.makerOrderId ?? null,
      marketRef: fill.marketRef,
      tokenId: fill.tokenId ?? null,
      conditionId: fill.conditionId ?? null,
      outcome: fill.outcome ?? null,
      side: fill.side,
      quantity: economicNumber(fill.size, `authoritative fill ${index} size`),
      matchedAmountDelta: fill.matchedAmountDelta === undefined
        ? null
        : economicNumber(fill.matchedAmountDelta, `authoritative fill ${index} matched amount delta`),
      price: economicNumber(fill.price, `authoritative fill ${index} price`),
      fee: fill.fee === undefined ? null : economicNumber(fill.fee, `authoritative fill ${index} fee`),
      matchedAt: economicNumber(fill.ts, `authoritative fill ${index} timestamp`),
    })));
    return { balances, positions, orders, fills };
  }

  private reconciliationProposalHash(
    snapshot: VenueSnapshot,
    proposals: MarketMakeReconcileResult["proposals"],
  ): string {
    const payload = canonicalHashValue({
      authoritativeEconomicSnapshot: this.authoritativeEconomicSnapshot(snapshot),
      proposals,
    });
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  private bankrollSnapshotFingerprint(snapshot: VenueSnapshot): string {
    return createHash("sha256")
      .update(JSON.stringify(canonicalHashValue(this.authoritativeEconomicSnapshot(snapshot))))
      .digest("hex");
  }

  private bankrollSnapshotIsSettlementQuiescent(
    snapshot: VenueSnapshot,
    hasResidualInventory: boolean,
  ): boolean {
    const venueHasActiveOrder = snapshot.orders.some((order) =>
      (order.status === "open" || order.status === "partial") &&
      order.size - order.filledSize > EPSILON);
    const durableOrders = this.stateStore.listOrders();
    const durableHasActiveOrder = durableOrders.some((order) =>
      !["CANCELED", "FILLED", "REJECTED"].includes(order.status));
    // A venue can report a canceled/filled order before its trade index or
    // position endpoint catches up. Keep every recently live durable order in
    // the same overlap quarantine used for late fills, even after its absence
    // tracker has been cleared.
    const hasRecentPotentiallyRestingOrder = durableOrders.some((order) => {
      if (order.status === "REJECTED") return false;
      const lastLifecycleAt = Math.max(
        order.createdAt,
        order.signedAt ?? 0,
        order.submittedAt ?? 0,
        order.acknowledgedAt ?? 0,
        order.cancelRequestedAt ?? 0,
        order.canceledAt ?? 0,
        order.terminalAt ?? 0,
      );
      return lastLifecycleAt >= snapshot.at - FILL_CURSOR_OVERLAP_MS;
    });
    const hasRecentFill = snapshot.fills.some((fill) =>
      fill.ts >= snapshot.at - FILL_CURSOR_OVERLAP_MS);
    const hasRedeemablePosition = snapshot.positions.some((position) => position.redeemable === true);
    const hasInventoryUncertainty =
      hasResidualInventory ||
      this.inventoryMismatches.size > 0 ||
      this.inventoryCorrectionWatermarks.size > 0 ||
      this.orderAbsences.size > 0 ||
      Object.values(this.reducerState.markets).some((market) =>
        market.redemption !== undefined && market.redemption.status !== "confirmed");
    return !venueHasActiveOrder &&
      !durableHasActiveOrder &&
      !hasRecentPotentiallyRestingOrder &&
      !hasRecentFill &&
      !hasRedeemablePosition &&
      !hasInventoryUncertainty;
  }

  /**
   * Apply supervisory bankroll decreases immediately. An increase, and every
   * restart's entry authorization, needs repeated clean, byte-equivalent
   * economic snapshots because Polymarket's independent REST balance,
   * position, order, and fill reads are not one atomic account snapshot.
   */
  private observeRuntimeBankroll(
    snapshot: VenueSnapshot,
    safeToIncrease: boolean,
    allowIncrease: boolean,
  ): void {
    const collateral = this.collateralBalance(snapshot.balances);
    const strategyCapitalUsd = marketMakeStrategyCapitalUsd(collateral.total, snapshot.positions);
    const targetEffectiveUsd = effectiveMarketMakeBankrollUsd(this.policyConfig, strategyCapitalUsd);
    const policy = runtimeBankrollPolicy(this.policyConfig);
    this.bankrollObserved = true;
    this.strategyCapitalUsd = strategyCapitalUsd;

    if (policy.mode === "fixed") {
      this.bankrollIncreaseCandidate = undefined;
      this.bankrollRefreshPending = false;
      if (Math.abs(targetEffectiveUsd - this.effectiveBankrollUsd) > EPSILON) {
        this.applyRuntimeBankroll(targetEffectiveUsd);
      }
      this.bankrollEntryReady = true;
      return;
    }

    if (targetEffectiveUsd < this.effectiveBankrollUsd - EPSILON) {
      this.applyRuntimeBankroll(targetEffectiveUsd);
    }
    if (targetEffectiveUsd <= EPSILON) {
      this.bankrollIncreaseCandidate = undefined;
      this.bankrollEntryReady = false;
      this.bankrollRefreshPending = false;
      return;
    }

    const needsIncrease = targetEffectiveUsd > this.effectiveBankrollUsd + EPSILON;
    this.bankrollRefreshPending = needsIncrease;
    const needsFreshEntryAuthorization = !this.bankrollEntryReady;
    if (!needsIncrease && !needsFreshEntryAuthorization) {
      this.bankrollIncreaseCandidate = undefined;
      return;
    }
    if (!safeToIncrease) {
      this.bankrollIncreaseCandidate = undefined;
      return;
    }

    const fingerprint = this.bankrollSnapshotFingerprint(snapshot);
    const previous = this.bankrollIncreaseCandidate;
    const matching = previous?.fingerprint === fingerprint &&
      Math.abs(previous.strategyCapitalUsd - strategyCapitalUsd) <= EPSILON &&
      Math.abs(previous.effectiveBankrollUsd - targetEffectiveUsd) <= EPSILON;
    const candidate: BankrollIncreaseCandidate = matching
      ? { ...previous, count: previous.count + 1, lastSeenAt: snapshot.at }
      : {
          fingerprint,
          strategyCapitalUsd,
          effectiveBankrollUsd: targetEffectiveUsd,
          count: 1,
          firstSeenAt: snapshot.at,
          lastSeenAt: snapshot.at,
        };
    this.bankrollIncreaseCandidate = candidate;
    const required = Math.max(2, this.policyConfig.global_kill_switches.unresolved_inventory_mismatch_cycles);
    if (candidate.count >= required && allowIncrease) {
      if (needsIncrease) this.applyRuntimeBankroll(targetEffectiveUsd);
      this.bankrollEntryReady = true;
      this.bankrollRefreshPending = false;
      this.bankrollIncreaseCandidate = undefined;
    }
  }

  private applyRuntimeBankroll(effectiveBankrollUsd: number): void {
    this.effectiveBankrollUsd = effectiveBankrollUsd;
    this.runtimeConfig = effectiveBankrollUsd > 0
      ? marketMakeConfigForBankroll(this.policyConfig, effectiveBankrollUsd)
      : this.policyConfig;
  }

  private reconciledOrder(order: Order): Parameters<MarketMakeStateStore["reconcileSnapshot"]>[0]["openOrders"][number] {
    const stored = this.findStoredOrder(order.id) ?? (order.clientId ? this.stateStore.getOrder(order.clientId) : undefined);
    const marketKey = stored?.marketKey ?? this.marketKeyFor(order.marketRef, order.tokenId, order.conditionId);
    const outcome = order.outcome ?? stored?.outcome;
    const tokenId = order.tokenId ?? stored?.tokenId;
    if (!tokenId || (outcome !== "YES" && outcome !== "NO")) {
      throw new Error(`open Polymarket order ${order.id} lacks explicit token/outcome identity`);
    }
    return {
      venueOrderId: order.id,
      ...(order.clientId ?? stored?.clientOrderId ? { clientOrderId: order.clientId ?? stored!.clientOrderId } : {}),
      marketKey,
      ...(stored?.cycleId ? { cycleId: stored.cycleId } : {}),
      tokenId,
      outcome,
      side: order.side,
      purpose: stored?.purpose ?? "UNKNOWN",
      remainingQuantity: Math.max(0, order.size - order.filledSize),
      limitPrice: order.price,
      tif: order.tif ?? "GTC",
      postOnly: stored?.postOnly ?? false,
    };
  }

  private async ingestOrder(order: Order, ts: number): Promise<void> {
    const stored = this.findStoredOrder(order.id) ?? (order.clientId ? this.stateStore.getOrder(order.clientId) : undefined);
    const marketKey = stored?.marketKey ?? this.marketKeyFor(order.marketRef, order.tokenId, order.conditionId);
    const catalog = this.catalogCache.get(marketKey)?.value ?? this.reducerState.markets[marketKey]?.catalog;
    const tokenId = order.tokenId ?? stored?.tokenId;
    const outcome = order.outcome ?? stored?.outcome;
    if (!tokenId || (outcome !== "YES" && outcome !== "NO")) return;
    const placement = this.reducerPlacement(marketKey, stored?.clientOrderId ?? order.clientId ?? `external:${order.id}`, order.id);
    await this.processEvent({
      type: "order",
      ts,
      marketKey,
      order: {
        orderId: order.id,
        clientId: order.clientId ?? stored?.clientOrderId ?? `external:${order.id}`,
        marketKey,
        marketRef: catalog?.marketRef ?? order.marketRef,
        conditionId: order.conditionId ?? catalog?.conditionId ?? "unknown",
        tokenId,
        outcome,
        side: order.side,
        size: order.size,
        filledSize: order.filledSize,
        price: order.price,
        tif: order.tif === "FAK" ? "FAK" : "GTC",
        postOnly: stored?.postOnly ?? false,
        ...placement,
        purpose: reducerPurpose(stored, order.side),
        status: stored ? stateReducerStatus(stored.status) : reducerOrderStatus(order.status),
        createdAt: order.createdAt ?? ts,
      },
    });
  }

  private async ingestFill(fill: Fill): Promise<boolean> {
    const stored = fill.orderId ? this.findStoredOrder(fill.orderId) : undefined;
    const tokenId = fill.tokenId ?? stored?.tokenId;
    const outcome = fill.outcome ?? stored?.outcome;
    const marketKey = stored?.marketKey ?? this.marketKeyFor(fill.marketRef, tokenId, fill.conditionId);
    if (!stored || !tokenId || (outcome !== "YES" && outcome !== "NO")) {
      this.log.warn("fill could not be joined to a persisted market-make order; balance reconciliation remains authoritative", {
        fillId: fill.id,
        orderId: fill.orderId,
      });
      return false;
    }
    const fillQuantity = fill.matchedAmountDelta ?? fill.size;
    const fillId = `${fill.id}:${fill.makerOrderId ?? fill.orderId ?? "none"}:${fillQuantity}`;
    if (this.reducerState.processedFillIds[fillId] || this.suppressedAuthoritativeFillIds.has(fillId)) return false;
    const correction = this.inventoryCorrectionWatermarks.get(marketKey);
    if (
      fill.side === "SELL" && correction?.tokenId === tokenId &&
      fill.ts <= correction.correctedAt
    ) {
      this.suppressedAuthoritativeFillIds.add(fillId);
      const coveredBefore = correction.remainingCoveredSellQuantity;
      correction.remainingCoveredSellQuantity = Math.max(
        0,
        coveredBefore - fillQuantity,
      );
      if (fillQuantity > coveredBefore + EPSILON) {
        await this.operationalError(
          "MM_LATE_FILL_EXCEEDS_CORRECTION",
          "a delayed SELL fill exceeded the quantity covered by the authoritative inventory correction",
          { fillId, marketKey, fillQuantity, coveredQuantity: coveredBefore },
        );
      }
      if (correction.remainingCoveredSellQuantity <= EPSILON) {
        this.inventoryCorrectionWatermarks.delete(marketKey);
      } else {
        this.inventoryCorrectionWatermarks.set(marketKey, correction);
      }
      await this.saveReducerState();
      this.log.info("market-make ignored a delayed SELL fill already covered by an authoritative inventory correction", {
        fillId,
        marketKey,
        correctedAt: correction.correctedAt,
      });
      return false;
    }
    const signal = this.reducerState.markets[marketKey]?.signal;
    const placement = this.reducerPlacement(marketKey, stored.clientOrderId, stored.venueOrderId);
    const hadInventory = Boolean(this.reducerState.markets[marketKey]?.inventory);
    const result = this.stateStore.recordFill({
      fillId,
      venueTradeId: fill.id,
      clientOrderId: stored.clientOrderId,
      quantity: fillQuantity,
      price: fill.price,
      feeUsd: fill.fee,
      ts: fill.ts,
      ...(placement.qAsOfAtPlacement !== undefined && placement.qSideAtPlacement !== undefined
        ? {
            anchorQVersion: String(placement.qAsOfAtPlacement),
            anchorQProbability: placement.qSideAtPlacement,
          }
        : signal
        ? {
            anchorQVersion: String(signal.qAsOf),
            anchorQProbability: outcome === "YES" ? signal.qYes : 1 - signal.qYes,
          }
        : {}),
      raw: { makerOrderId: fill.makerOrderId },
    });
    await this.processEvent({
      type: "fill",
      ts: fill.ts,
      fillId,
      orderId: stored.venueOrderId ?? stored.clientOrderId,
      clientId: stored.clientOrderId,
      marketKey,
      tokenId,
      outcome,
      side: fill.side,
      size: fillQuantity,
      price: fill.price,
      ...(fill.fee === undefined ? {} : { feeUsd: fill.fee }),
    });
    if (result.inserted) {
      const orderId = stored.venueOrderId ?? stored.clientOrderId;
      const data = {
        fillId,
        orderId,
        asset: tokenId,
        funder: this.account.venue === "polymarket" ? this.account.funder : undefined,
        marketKey,
        outcome,
        side: fill.side,
        size: fillQuantity,
        price: fill.price,
        feeUsd: fill.fee,
      };
      await this.alert("fill", `${fill.side} ${outcome} fill on ${marketKey}`, data);
      const hasInventory = Boolean(this.reducerState.markets[marketKey]?.inventory);
      if (fill.side === "BUY" && !hadInventory && hasInventory) {
        await this.alert("entry", `Opened ${outcome} inventory on ${marketKey}`, data);
      } else if (fill.side === "SELL" && hadInventory && !hasInventory) {
        await this.alert("exit", `Closed ${outcome} inventory on ${marketKey}`, data);
      }
    }
    return result.inserted;
  }

  private marketKeyFor(marketRef: string, tokenId?: string, conditionId?: string): string {
    for (const [key, cached] of this.catalogCache) {
      const market = cached.value;
      if (
        market.marketRef === marketRef ||
        market.yesTokenId === tokenId ||
        market.noTokenId === tokenId ||
        (conditionId && market.conditionId.toLowerCase() === conditionId.toLowerCase())
      ) return key;
    }
    for (const [key, market] of Object.entries(this.reducerState.markets)) {
      const catalog = market.catalog;
      if (catalog && (catalog.marketRef === marketRef || catalog.yesTokenId === tokenId || catalog.noTokenId === tokenId)) return key;
    }
    return `unmanaged:${conditionId ?? tokenId ?? marketRef}`;
  }

  private async pollMarketInputs(positions: Position[], refreshForecasts = true): Promise<PollResult> {
    const now = this.now();
    this.resetQuotientBudgetIfNeeded(now);
    let discoveryQueried = false;
    let budgetExhausted = false;
    let activeRows: MarketMakeSignalRow[] = [];
    if (refreshForecasts) {
      this.lastQuotientPollAt = now;
      if (this.canSpendQuotient(QUOTIENT_CALL_COST_USD.signals)) {
        activeRows = await this.quotient.activeSignals(500);
        this.recordQuotientSpend(QUOTIENT_CALL_COST_USD.signals);
        discoveryQueried = true;
      } else {
        budgetExhausted = true;
      }
    }
    const newest = new Map<string, MarketMakeSignalRow>();
    for (const row of activeRows) {
      const existing = newest.get(row.marketKey);
      if (!existing || finiteTimestamp(row.forecastAt, "forecastAt") > finiteTimestamp(existing.forecastAt, "forecastAt")) {
        newest.set(row.marketKey, row);
      }
    }
    let catalogs = 0;
    for (const row of newest.values()) {
      if (await this.refreshCatalog(row.marketKey, row.nativeMarketId, row.conditionId, now)) catalogs += 1;
    }

    const heldKeys = new Set(
      Object.values(this.reducerState.markets)
        .filter((market) => market.inventory)
        .map((market) => market.marketKey),
    );
    for (const position of positions) {
      const key = this.marketKeyFor(position.marketRef, position.tokenId, position.conditionId);
      if (!key.startsWith("unmanaged:")) heldKeys.add(key);
    }
    const forecastLookupKeys = new Set(heldKeys);
    for (const [marketKey, market] of Object.entries(this.reducerState.markets)) {
      if (Object.values(market.orders).some((order) => !["CANCELED", "FILLED", "REJECTED"].includes(order.status))) {
        forecastLookupKeys.add(marketKey);
      }
    }
    // Gamma lifecycle must continue refreshing for held/resting markets even
    // after they disappear from the active discovery feed.
    for (const marketKey of forecastLookupKeys) {
      const catalog = this.catalogCache.get(marketKey)?.value ?? this.reducerState.markets[marketKey]?.catalog;
      if (catalog && await this.refreshCatalog(marketKey, catalog.nativeMarketId, catalog.conditionId, now)) catalogs += 1;
    }

    // Reduce every relevant Gamma refresh before processing any Quotient
    // signal from this poll. Submission revalidation reads catalogCache, so
    // allowing signals to run first would size new entries/top-ups against
    // stale reducer event/family metadata while validating against the fresh
    // catalog snapshot.
    let actions = 0;
    let decisions = 0;
    for (const [marketKey, cached] of [...this.catalogCache.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!newest.has(marketKey) && !forecastLookupKeys.has(marketKey)) continue;
      const catalogResult = await this.processEvent({ type: "catalog", ts: now, market: cached.value });
      actions += catalogResult.actions;
      decisions += catalogResult.decisions;
    }

    const missingHeld = [...forecastLookupKeys].filter((key) => !newest.has(key));
    const exactRows: MarketMakeExactForecast[] = [];
    if (refreshForecasts) {
      for (let offset = 0; offset < missingHeld.length; offset += 10) {
        if (!this.canSpendQuotient(QUOTIENT_CALL_COST_USD.lookup)) {
          budgetExhausted = true;
          break;
        }
        exactRows.push(...await this.quotient.exactForecasts(missingHeld.slice(offset, offset + 10)));
        this.recordQuotientSpend(QUOTIENT_CALL_COST_USD.lookup);
      }
    }

    for (const row of newest.values()) {
      const result = await this.processEvent({ type: "signal", ts: now, signal: this.publishedSignal(row, now) });
      actions += result.actions;
      decisions += result.decisions;
    }
    for (const [marketKey, market] of Object.entries(this.reducerState.markets)) {
      if (!market.signal || newest.has(marketKey) || (!discoveryQueried && !budgetExhausted) || heldKeys.has(marketKey)) continue;
      const result = await this.processEvent({
        type: "signal",
        ts: now,
        signal: { ...market.signal, active: false, livePriced: false },
      });
      actions += result.actions;
      decisions += result.decisions;
    }
    if (budgetExhausted) {
      for (const [marketKey, market] of Object.entries(this.reducerState.markets)) {
        if (!market.signal || !market.signal.active) continue;
        const result = await this.processEvent({
          type: "signal",
          ts: now,
          signal: { ...market.signal, active: false, livePriced: false },
        });
        actions += result.actions;
        decisions += result.decisions;
      }
    }
    for (const exact of exactRows) {
      const market = this.reducerState.markets[exact.marketKey];
      const catalog = this.catalogCache.get(exact.marketKey)?.value ?? market?.catalog;
      if (!catalog) continue;
      const previous = market?.signal;
      const signal: PublishedSignalInput = {
        id: previous?.id ?? `exact:${exact.marketKey}`,
        marketKey: exact.marketKey,
        nativeMarketId: catalog.nativeMarketId,
        conditionId: catalog.conditionId,
        publishedAt: previous?.publishedAt ?? finiteTimestamp(exact.forecastAt, "exact.forecastAt"),
        entryQ: previous?.entryQ ?? exact.qYes * 100,
        entryPm: previous?.entryPm ?? 50,
        latestQ: exact.qYes,
        qAsOf: finiteTimestamp(exact.forecastAt, "exact.forecastAt"),
        active: false,
        livePriced: false,
        suppressionReason: previous?.suppressionReason ?? null,
        retiredReason: retiredReason(exact.retiredReason),
        forecastStatus: exact.forecastStatus.state,
        drawdownRiskElevated: exact.forecastStatus.drawdownRiskElevated,
      };
      const result = await this.processEvent({ type: "signal", ts: now, signal });
      actions += result.actions;
      decisions += result.decisions;
    }
    for (const position of positions) {
      if (!position.redeemable) continue;
      const marketKey = this.marketKeyFor(position.marketRef, position.tokenId, position.conditionId);
      const previous = this.reducerState.markets[marketKey]?.signal;
      if (!previous) continue;
      const result = await this.processEvent({
        type: "signal",
        ts: now,
        signal: { ...previous, active: false, livePriced: false, retiredReason: "resolved" },
      });
      actions += result.actions;
      decisions += result.decisions;
    }

    const knownKeys = Object.entries(this.reducerState.markets)
      .filter(([, market]) => market.signal && market.catalog)
      .map(([marketKey]) => marketKey);
    const bookResult = await this.fetchAndReduceBooks(new Set([...newest.keys(), ...heldKeys, ...knownKeys]));
    actions += bookResult.actions;
    decisions += bookResult.decisions;

    return {
      signals: newest.size,
      exactForecasts: exactRows.length,
      catalogs,
      books: bookResult.books,
      actions,
      decisions,
    };
  }

  private publishedSignal(row: MarketMakeSignalRow, now: number): PublishedSignalInput {
    return {
      id: row.signalId,
      marketKey: row.marketKey,
      nativeMarketId: row.nativeMarketId,
      conditionId: row.conditionId,
      publishedAt: finiteTimestamp(row.publishedAt, "publishedAt"),
      entryQ: row.entryQYes * 100,
      entryPm: row.entryMarketYes * 100,
      latestQ: row.qYes,
      qAsOf: finiteTimestamp(row.forecastAt, "forecastAt"),
      active: row.isActive,
      // Quotient's discovery quote is audit-only. The reducer separately
      // requires fresh local books for both exact outcome tokens before entry.
      livePriced: true,
      suppressionReason: row.suppressionReason ?? null,
      retiredReason: retiredReason(row.retiredReason),
      forecastStatus: row.forecastStatus.state,
      drawdownRiskElevated: row.forecastStatus.drawdownRiskElevated,
    };
  }

  private resetQuotientBudgetIfNeeded(now: number): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.quotientSpendUtcDay === day) return;
    this.quotientSpendUtcDay = day;
    this.quotientSpendUsd = 0;
  }

  private canSpendQuotient(cost: number): boolean {
    return this.quotientSpendUsd + cost <= this.config.quotient_feed.daily_api_cost_cap_usd + EPSILON;
  }

  private recordQuotientSpend(cost: number): void {
    this.quotientSpendUsd += cost;
  }

  private quotientPollDue(now: number): boolean {
    this.resetQuotientBudgetIfNeeded(now);
    if (this.lastQuotientPollAt === undefined) return true;
    const active = Object.values(this.reducerState.markets).some((market) =>
      Boolean(market.inventory) || Object.values(market.orders).some((order) =>
        !["CANCELED", "FILLED", "REJECTED"].includes(order.status)),
    );
    const cadence = active
      ? this.config.quotient_feed.active_poll_seconds
      : this.config.quotient_feed.idle_poll_seconds;
    return now - this.lastQuotientPollAt >= cadence * 1_000;
  }

  private async refreshCatalog(marketKey: string, nativeMarketId: string, conditionId: string, now: number): Promise<boolean> {
    const cached = this.catalogCache.get(marketKey);
    if (cached && now - cached.fetchedAt < this.config.market_catalog.gamma_refresh_seconds * 1_000) return false;
    const catalog = mapCatalog(await this.catalogClient.market(marketKey, nativeMarketId, conditionId));
    this.catalogCache.set(marketKey, { value: catalog, fetchedAt: now });
    this.stateStore.upsertMarket({
      marketKey,
      conditionId: catalog.conditionId,
      eventId: catalog.eventId,
      categoryFamily: catalog.category,
      yesTokenId: catalog.yesTokenId,
      noTokenId: catalog.noTokenId,
      gammaStatus: catalog.closed ? "closed" : catalog.active ? "active" : "inactive",
      metadata: catalog,
      updatedAt: now,
    });
    return true;
  }

  private async fetchAndReduceBooks(keys: Set<string>): Promise<{ books: number; actions: number; decisions: number }> {
    let books = 0;
    let actions = 0;
    let decisions = 0;
    // Fetch every market’s books with bounded concurrency, then reduce them in
    // stable key order. Serial round trips from the droplet to the CLOB made a
    // 57-market tick take minutes; the reducer still sees a deterministic order.
    const ordered = [...keys].sort().flatMap((marketKey) => {
      const catalog = this.catalogCache.get(marketKey)?.value ?? this.reducerState.markets[marketKey]?.catalog;
      return catalog ? [{ marketKey, catalog }] : [];
    });
    // Each batch is reduced as soon as it lands, so a book is never more than
    // one batch’s round trip old when its freshness gate is evaluated.
    for (let offset = 0; offset < ordered.length; offset += BOOK_FETCH_CONCURRENCY) {
      const batch = ordered.slice(offset, offset + BOOK_FETCH_CONCURRENCY);
      const fetched = await Promise.all(batch.map(async ({ marketKey, catalog }) => {
        const [yesRaw, noRaw] = await Promise.all([
          this.venue.tokenBook!(catalog.yesTokenId),
          this.venue.tokenBook!(catalog.noTokenId),
        ]);
        return {
          marketKey,
          catalog,
          yesBook: { tokenId: catalog.yesTokenId, bids: yesRaw.bids, asks: yesRaw.asks, ts: yesRaw.ts } satisfies TokenBook,
          noBook: { tokenId: catalog.noTokenId, bids: noRaw.bids, asks: noRaw.asks, ts: noRaw.ts } satisfies TokenBook,
        };
      }));
      if (this.enableSubscriptions) this.lastMarketRestAt = this.now();
      for (const { marketKey, catalog, yesBook, noBook } of fetched) {
      const shock = await this.observeShock(marketKey, yesBook, noBook, this.now());
      actions += shock.actions;
      decisions += shock.decisions;
      for (const [outcome, book] of [["YES", yesBook], ["NO", noBook]] as const) {
        const result = await this.processEvent({ type: "book", ts: this.now(), marketKey, outcome, book });
        actions += result.actions;
        decisions += result.decisions;
        books += 1;
      }
      const signal = this.reducerState.markets[marketKey]?.signal;
      if (!signal) continue;
      const metrics = this.metricsProvider
        ? await this.metricsProvider.snapshots({ now: this.now(), marketKey, signal, catalog, yesBook, noBook })
        : this.calculateMetrics(marketKey, signal, yesBook, noBook);
      const volatility = await this.processEvent({ type: "volatility", ts: this.now(), marketKey, volatility: metrics.volatility });
      const stability = await this.processEvent({ type: "stability", ts: this.now(), marketKey, stability: metrics.stability });
      actions += volatility.actions + stability.actions;
      decisions += volatility.decisions + stability.decisions;
      }
    }
    const loss = await this.updateLossState(this.now());
    actions += loss.actions;
    decisions += loss.decisions;
    return { books, actions, decisions };
  }

  private bookStats(book: TokenBook): { mid?: number; spreadPp: number; bidDepthUsd: number } {
    const value = mid(book);
    const bestBid = book.bids.reduce((best, level) => Math.max(best, level.price), 0);
    const bestAsk = book.asks.reduce((best, level) => Math.min(best, level.price), Number.POSITIVE_INFINITY);
    return {
      ...(value === undefined ? {} : { mid: value }),
      spreadPp: bestBid > 0 && Number.isFinite(bestAsk) && bestAsk > bestBid ? (bestAsk - bestBid) * 100 : Number.POSITIVE_INFINITY,
      bidDepthUsd: book.bids
        .filter((level) => level.price > 0 && level.size > 0 && level.price + EPSILON >= bestBid - 0.02)
        .reduce((sum, level) => sum + level.price * level.size, 0),
    };
  }

  private async observeShock(
    marketKey: string,
    yesBook: TokenBook,
    noBook: TokenBook,
    at: number,
  ): Promise<EventResult> {
    const yes = this.bookStats(yesBook);
    const no = this.bookStats(noBook);
    if (
      yes.mid === undefined || no.mid === undefined ||
      !Number.isFinite(yes.spreadPp) || !Number.isFinite(no.spreadPp)
    ) {
      return this.emitShockOnce(marketKey, at, true, ["book-corrupt-or-gap"]);
    }
    const current: BookObservation = {
      ts: at,
      yesMid: yes.mid,
      noMid: no.mid,
      yesSpreadPp: yes.spreadPp,
      noSpreadPp: no.spreadPp,
      yesBidDepthUsd: yes.bidDepthUsd,
      noBidDepthUsd: no.bidDepthUsd,
    };
    const history = this.bookObservations.get(marketKey) ?? [];
    const market = this.reducerState.markets[marketKey];
    const selected = market?.inventory?.outcome ?? (market?.signal && market.signal.qYes >= yes.mid ? "YES" : "NO");
    const selectedMid = (point: BookObservation): number => selected === "YES" ? point.yesMid : point.noMid;
    const selectedSpread = (point: BookObservation): number => selected === "YES" ? point.yesSpreadPp : point.noSpreadPp;
    const selectedDepth = (point: BookObservation): number => selected === "YES" ? point.yesBidDepthUsd : point.noBidDepthUsd;
    const before = (target: number): BookObservation | undefined => {
      for (let index = history.length - 1; index >= 0; index -= 1) {
        if (history[index]!.ts <= target) return history[index];
      }
      return undefined;
    };
    const p60 = before(at - 60_000);
    const p5m = before(at - 5 * 60_000);
    const p15m = before(at - 15 * 60_000);
    const move = (prior: BookObservation | undefined): number => prior ? (selectedMid(current) - selectedMid(prior)) * 100 : 0;
    const trailingSpreads = history
      .filter((point) => point.ts >= at - 5 * 60_000)
      .map(selectedSpread)
      .filter((value) => Number.isFinite(value) && value > EPSILON)
      .sort((left, right) => left - right);
    const medianSpread = trailingSpreads.length
      ? trailingSpreads[Math.floor((trailingSpreads.length - 1) / 2)]!
      : selectedSpread(current);
    const depth60 = p60 ? selectedDepth(p60) : selectedDepth(current);
    const move60sPp = move(p60);
    const move5mPp = move(p5m);
    const move15mPp = move(p15m);
    const liquidityDeteriorated = selectedSpread(current) > medianSpread + EPSILON || selectedDepth(current) < depth60 - EPSILON;
    const adverse = move15mPp < -EPSILON || move5mPp < -EPSILON || move60sPp < -EPSILON || liquidityDeteriorated;
    const decision = evaluateShock({
      move60sPp,
      move5mPp,
      move15mPp,
      spreadMultipleVs5mMedian: medianSpread > EPSILON ? selectedSpread(current) / medianSpread : 1,
      depthDropFraction60s: depth60 > EPSILON ? Math.max(0, (depth60 - selectedDepth(current)) / depth60) : 0,
      adverse,
    }, this.config);
    history.push(current);
    const cutoff = at - 20 * 60 * 1_000;
    while (history[0] && history[0].ts < cutoff) history.shift();
    this.bookObservations.set(marketKey, history);
    return decision.shocked
      ? this.emitShockOnce(marketKey, at, decision.adverse, decision.reasons)
      : { applied: false, actions: 0, decisions: 0 };
  }

  private async emitShockOnce(
    marketKey: string,
    at: number,
    adverse: boolean,
    reasons: string[],
  ): Promise<EventResult> {
    const fingerprint = `${adverse ? "adverse" : "favorable"}:${reasons.join(",")}`;
    const previous = this.lastShocks.get(marketKey);
    if (previous?.fingerprint === fingerprint && at - previous.ts < this.config.market_shock.entry_freeze_seconds * 1_000) {
      return { applied: false, actions: 0, decisions: 0 };
    }
    this.lastShocks.set(marketKey, { ts: at, fingerprint });
    return this.processEvent({ type: "shock", ts: at, marketKey, adverse, reason: reasons.join(",") });
  }

  private async updateLossState(at: number): Promise<EventResult> {
    const marketLossUsd: Record<string, number> = {};
    let liquidationValueUsd = 0;
    for (const [marketKey, market] of Object.entries(this.reducerState.markets)) {
      const inventory = market.inventory;
      if (!inventory || inventory.freeQuantity <= EPSILON) {
        marketLossUsd[marketKey] = 0;
        continue;
      }
      const selected = inventory.outcome === "YES" ? market.yesBook : market.noBook;
      const liquidation = selected
        ? executableLiquidationValue(
            { marketRef: inventory.tokenId, bids: selected.bids, asks: selected.asks, ts: selected.ts },
            inventory.freeQuantity,
            { maxConcessionPp: this.config.exit_policy.urgent_exit_max_concession_pp },
          )
        : { netValueUsd: 0 };
      liquidationValueUsd += liquidation.netValueUsd;
      const cyclePnlUsd = inventory.cashReceivedUsd + liquidation.netValueUsd - inventory.cashPaidUsd;
      marketLossUsd[marketKey] = Math.max(0, -cyclePnlUsd);
    }
    const prior = this.stateStore.lossState();
    const navUsd = this.stateStore.availability().collateralTotalUsd + liquidationValueUsd;
    const highWaterUsd = Math.max(prior.highWaterUsd ?? navUsd, navUsd);
    const drawdownUsd = Math.max(0, highWaterUsd - navUsd);
    this.lossHistory.push({ ts: at, navUsd });
    const cutoff = at - 24 * 60 * 60 * 1_000;
    this.lossHistory = this.lossHistory.filter((point) => point.ts >= cutoff);
    const rollingNavLoss = Math.max(0, ...this.lossHistory.map((point) => point.navUsd - navUsd));
    const rolling24hLossUsd = Math.max(
      rollingNavLoss,
      Object.values(marketLossUsd).reduce((sum, value) => sum + value, 0),
    );
    this.stateStore.updateLossMark({ now: at, rolling24hLossUsd, drawdownUsd, navUsd, highWaterUsd });
    for (const [marketKey, marketLossUsdValue] of Object.entries(marketLossUsd)) {
      this.stateStore.updateLossMark({
        now: at,
        rolling24hLossUsd,
        drawdownUsd,
        navUsd,
        highWaterUsd,
        marketKey,
        marketLossUsd: marketLossUsdValue,
      });
    }
    const loss = { marketLossUsd, rolling24hLossUsd, drawdownUsd };
    const reasons = lossLimitReasons(loss, this.config);
    if (reasons.length > 0) {
      const before = this.stateStore.status();
      this.stateStore.latchLoss(reasons.join(", "), at);
      if (before.lifecycle === "EXIT_BLOCKED") {
        this.stateStore.setExitOnlyLifecycle(
          "EXIT_BLOCKED",
          before.haltReason ?? "bounded urgent exit retry budget exhausted",
          at,
        );
      }
      if (!before.loss.latched) {
        await this.operationalError("MM_LOSS_LATCHED", reasons.join(", "), {
          rolling24hLossUsd,
          drawdownUsd,
        });
      }
    }
    return this.processEvent({ type: "loss", ts: at, loss });
  }

  private calculateMetrics(
    marketKey: string,
    signal: PublishedSignalInput,
    yesBook: TokenBook,
    noBook: TokenBook,
  ): { volatility: VolatilitySnapshot; stability: StabilitySnapshot } {
    const now = this.now();
    const history = this.bookHistory.get(marketKey) ?? [];
    const hourly = new Map<number, number>();
    for (const point of history) hourly.set(Math.floor(point.ts / 3_600_000), point.mid);
    const points = [...hourly.entries()].sort(([a], [b]) => a - b).map(([hour, value]) => ({ ts: hour * 3_600_000, value }));
    const rv = (from: number, to: number): number => {
      const selected = points.filter((point) => point.ts >= from && point.ts <= to);
      let squares = 0;
      for (let index = 1; index < selected.length; index += 1) {
        const changePp = (selected[index]!.value - selected[index - 1]!.value) * 100;
        squares += changePp * changePp;
      }
      return Math.sqrt(squares);
    };
    const rv24Pp = rv(now - 24 * 3_600_000, now);
    const prior: number[] = [];
    for (let day = 2; day <= 7; day += 1) {
      prior.push(rv(now - day * 24 * 3_600_000, now - (day - 1) * 24 * 3_600_000));
    }
    const nonzero = prior.filter((value) => value > EPSILON);
    const meanPrior = nonzero.length ? nonzero.reduce((sum, value) => sum + value, 0) / nonzero.length : 0;
    const acceleration = meanPrior > EPSILON ? rv24Pp / meanPrior : 0;

    const yesMid = mid(yesBook) ?? 0.5;
    const noMid = mid(noBook) ?? 0.5;
    const outcome = signal.latestQ >= yesMid ? "YES" : "NO";
    const qSide = outcome === "YES" ? signal.latestQ : 1 - signal.latestQ;
    const selectedMid = outcome === "YES" ? yesMid : noMid;
    const distancePp = Math.abs(qSide - selectedMid) * 100;
    let tracker = this.stability.get(marketKey);
    if (!tracker || tracker.qAsOf !== signal.qAsOf || tracker.outcome !== outcome) {
      tracker = { qAsOf: signal.qAsOf, outcome, validSince: now, bestDistancePp: distancePp, maxMoveAwayFromQPp: 0 };
    } else {
      tracker.bestDistancePp = Math.min(tracker.bestDistancePp, distancePp);
      tracker.maxMoveAwayFromQPp = Math.max(tracker.maxMoveAwayFromQPp, distancePp - tracker.bestDistancePp);
    }
    this.stability.set(marketKey, tracker);
    return {
      volatility: { rv24Pp, acceleration },
      stability: { validSince: tracker.validSince, maxMoveAwayFromQPp: tracker.maxMoveAwayFromQPp },
    };
  }

  private async adoptResidualInventory(positions: Position[]): Promise<InventoryReconciliationResult> {
    const now = this.now();
    await this.recoverHeldPositionCatalogs(positions, now);
    const threshold = Math.max(1, this.config.global_kill_switches.unresolved_inventory_mismatch_cycles);
    const tolerance = 0.01;
    const venueByMarket = new Map<string, Array<{
      tokenId: string;
      outcome: "YES" | "NO";
      quantity: number;
      costBasisUsd: number;
    }>>();
    let actions = 0;
    let reconciled = 0;
    let consistent = true;
    const redemptionsAwaitingRepeatedZero = new Set<string>();

    for (const [marketKey, market] of Object.entries(this.reducerState.markets)) {
      const inventory = market.inventory;
      const redemption = market.redemption;
      if (!inventory || redemption?.status !== "submitted") continue;
      if (this.redemptionPosition(marketKey, inventory.tokenId, positions)) {
        this.inventoryMismatches.delete(this.redemptionVerificationKey(marketKey));
        continue;
      }
      redemptionsAwaitingRepeatedZero.add(marketKey);
      consistent = false;
      if (now - redemption.lastAttemptAt < this.config.reconciliation.rest_reconcile_seconds * 1_000) continue;
      if (await this.observeSubmittedRedemptionAbsence(
        marketKey,
        inventory.tokenId,
        inventory.outcome,
        now,
      )) reconciled += 1;
    }

    for (const position of positions) {
      if (!(position.size > EPSILON)) continue;
      if (!position.tokenId || (position.outcome !== "YES" && position.outcome !== "NO")) {
        consistent = false;
        continue;
      }
      const marketKey = this.marketKeyFor(position.marketRef, position.tokenId, position.conditionId);
      if (marketKey.startsWith("unmanaged:")) {
        consistent = false;
        const fingerprint = `${marketKey}:${position.tokenId}:${position.outcome}`;
        this.noteInventoryMismatch(
          `unmanaged:${position.tokenId}`,
          fingerprint,
          0,
          position.size,
          now,
        );
        continue;
      }
      const candidates = venueByMarket.get(marketKey) ?? [];
      const existing = candidates.find((candidate) => candidate.tokenId === position.tokenId);
      if (existing) {
        existing.quantity += position.size;
        existing.costBasisUsd += Math.max(0, position.avgPrice * position.size);
      } else {
        candidates.push({
          tokenId: position.tokenId,
          outcome: position.outcome,
          quantity: position.size,
          costBasisUsd: Math.max(0, position.avgPrice * position.size),
        });
      }
      venueByMarket.set(marketKey, candidates);
    }

    const cyclesByMarket = new Map(
      this.stateStore.listInventoryCycles(true).map((cycle) => [cycle.marketKey, cycle]),
    );
    const marketKeys = new Set([
      ...venueByMarket.keys(),
      ...Object.entries(this.reducerState.markets)
        .filter(([, market]) => market.inventory)
        .map(([marketKey]) => marketKey),
      ...cyclesByMarket.keys(),
    ]);
    const seenTrackers = new Set<string>();

    for (const marketKey of marketKeys) {
      const venue = venueByMarket.get(marketKey) ?? [];
      const market = this.reducerState.markets[marketKey];
      const reducerInventory = market?.inventory;
      const durableInventory = cyclesByMarket.get(marketKey);
      const expectedQuantity = reducerInventory?.freeQuantity ?? durableInventory?.quantity ?? 0;
      const venueQuantity = venue.reduce((sum, candidate) => sum + candidate.quantity, 0);
      const trackerKey = `market:${marketKey}`;

      // A submitted redemption is verification-only. Never let the generic
      // balance-repair path turn a single omitted position row into a
      // confirmed redemption or clear its inventory early.
      if (redemptionsAwaitingRepeatedZero.has(marketKey) && this.reducerState.markets[marketKey]?.inventory) {
        seenTrackers.add(trackerKey);
        continue;
      }

      if (venue.length > 1) {
        consistent = false;
        seenTrackers.add(trackerKey);
        this.noteInventoryMismatch(
          trackerKey,
          `${marketKey}:opposite-outcomes:${venue.map((candidate) => candidate.tokenId).sort().join(",")}`,
          expectedQuantity,
          venueQuantity,
          now,
        );
        continue;
      }

      const authoritative = venue[0];
      const authoritativeTokenId = authoritative?.tokenId ?? reducerInventory?.tokenId ?? durableInventory?.tokenId;
      const authoritativeOutcome = authoritative?.outcome ?? reducerInventory?.outcome ?? durableInventory?.outcome;
      if (!authoritativeTokenId || (authoritativeOutcome !== "YES" && authoritativeOutcome !== "NO")) continue;
      const tokenConflict =
        (reducerInventory !== undefined && reducerInventory.tokenId !== authoritativeTokenId) ||
        (durableInventory !== undefined && durableInventory.tokenId !== authoritativeTokenId);
      const reducerMismatch = reducerInventory === undefined
        ? venueQuantity > tolerance
        : Math.abs(reducerInventory.freeQuantity - venueQuantity) > tolerance;
      const durableMismatch = durableInventory === undefined
        ? venueQuantity > tolerance
        : Math.abs(durableInventory.quantity - venueQuantity) > tolerance;
      if (!tokenConflict && !reducerMismatch && !durableMismatch) {
        this.inventoryMismatches.delete(trackerKey);
        continue;
      }

      consistent = false;
      seenTrackers.add(trackerKey);
      const fingerprint = [
        marketKey,
        reducerInventory?.tokenId ?? "none",
        durableInventory?.tokenId ?? "none",
        authoritativeTokenId,
        tokenConflict ? "conflict" : "quantity",
      ].join(":");
      const tracker = this.noteInventoryMismatch(
        trackerKey,
        fingerprint,
        expectedQuantity,
        venueQuantity,
        now,
      );
      if (tokenConflict || tracker.count < threshold) continue;
      if (this.recentOrderCanExplainInventoryDelta(marketKey, venueQuantity - expectedQuantity, now)) {
        continue;
      }

      const costBasisUsd = authoritative?.costBasisUsd ?? 0;
      if (venueQuantity > tolerance && !market?.signal) continue;
      if (venueQuantity > tolerance && !durableInventory) {
        const signal = market!.signal!;
        this.stateStore.createInventoryCycle({
          cycleId: `residual:${marketKey}:${authoritativeTokenId}`,
          marketKey,
          outcome: authoritativeOutcome,
          tokenId: authoritativeTokenId,
          status: "RESIDUAL",
          quantity: venueQuantity,
          costBasisUsd,
          firstFillAt: now,
          anchorQVersion: String(signal.qAsOf),
          anchorQProbability: authoritativeOutcome === "YES" ? signal.qYes : 1 - signal.qYes,
          anchorExecutionPrice: Math.min(1, Math.max(0, costBasisUsd / venueQuantity)),
          createdAt: now,
        });
      } else if (durableInventory) {
        this.stateStore.reconcileInventoryQuantity({
          marketKey,
          tokenId: authoritativeTokenId,
          quantity: venueQuantity,
          costBasisUsd,
          now,
        });
      }
      if (venueQuantity + tolerance < expectedQuantity) {
        const covered = expectedQuantity - venueQuantity;
        const previousWatermark = this.inventoryCorrectionWatermarks.get(marketKey);
        this.inventoryCorrectionWatermarks.set(marketKey, {
          tokenId: authoritativeTokenId,
          correctedAt: now,
          remainingCoveredSellQuantity:
            previousWatermark?.tokenId === authoritativeTokenId
              ? previousWatermark.remainingCoveredSellQuantity + covered
              : covered,
        });
      }
      await this.processEvent({
        type: "inventory-reconciled",
        ts: now,
        marketKey,
        tokenId: authoritativeTokenId,
        outcome: authoritativeOutcome,
        quantity: venueQuantity,
        costBasisUsd,
        reason: "venue position quantity remained authoritative across reconciliation snapshots",
      }, false);
      this.inventoryMismatches.delete(trackerKey);
      reconciled += 1;
    }

    for (const key of [...this.inventoryMismatches.keys()]) {
      if (key.startsWith("market:") && !seenTrackers.has(key)) this.inventoryMismatches.delete(key);
    }

    if (!consistent) {
      const reason = "venue inventory does not match durable market-make inventory; explicit reconciliation and resume required";
      if (this.stateStore.status().lifecycle !== "EXIT_BLOCKED") this.stateStore.halt(reason, now);
      if (!this.reducerState.halted || !this.reducerState.liquidateRequested) {
        const halted = await this.processEvent({ type: "halt", ts: now, liquidate: true });
        actions += halted.actions;
      }
      await this.saveReducerState();
    }
    return { actions, consistent, reconciled };
  }

  private async recoverHeldPositionCatalogs(positions: Position[], now: number): Promise<void> {
    if (!this.catalogClient.recover) return;
    for (const position of positions) {
      if (
        !(position.size > EPSILON) ||
        !position.tokenId ||
        (position.outcome !== "YES" && position.outcome !== "NO") ||
        !this.marketKeyFor(position.marketRef, position.tokenId, position.conditionId).startsWith("unmanaged:")
      ) continue;
      try {
        const recovered = await this.catalogClient.recover({
          ...(position.conditionId ? { conditionId: position.conditionId } : {}),
          clobTokenId: position.tokenId,
        });
        const catalog = mapCatalog(recovered.catalog);
        const expectedToken = position.outcome === "YES" ? catalog.yesTokenId : catalog.noTokenId;
        if (expectedToken !== position.tokenId) {
          throw new Error(`recovered ${position.outcome} token ${expectedToken} does not match held token ${position.tokenId}`);
        }
        this.catalogCache.set(recovered.marketKey, { value: catalog, fetchedAt: now });
        this.stateStore.upsertMarket({
          marketKey: recovered.marketKey,
          conditionId: catalog.conditionId,
          eventId: catalog.eventId,
          categoryFamily: catalog.category,
          yesTokenId: catalog.yesTokenId,
          noTokenId: catalog.noTokenId,
          gammaStatus: catalog.closed ? "closed" : catalog.active ? "active" : "inactive",
          metadata: catalog,
          updatedAt: now,
        });
        await this.processEvent({ type: "catalog", ts: now, market: catalog }, false);
      } catch (error) {
        const message = `could not recover held-position Gamma identity: ${error instanceof Error ? error.message : String(error)}`;
        this.log.error("market-make could not recover held-position Gamma identity", {
          tokenId: position.tokenId,
          conditionId: position.conditionId,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.operationalError("MM_CATALOG_RECOVERY_FAILED", message, {
          tokenId: position.tokenId,
          conditionId: position.conditionId,
        });
      }
    }
  }

  private noteInventoryMismatch(
    key: string,
    fingerprint: string,
    expectedQuantity: number,
    venueQuantity: number,
    now: number,
  ): InventoryMismatchTracker {
    const previous = this.inventoryMismatches.get(key);
    const sameObservation = previous?.lastSeenAt === now;
    const sameMismatch = previous?.fingerprint === fingerprint;
    const tracker: InventoryMismatchTracker = {
      count: sameMismatch ? (sameObservation ? previous.count : previous.count + 1) : 1,
      firstSeenAt: sameMismatch ? previous.firstSeenAt : now,
      lastSeenAt: now,
      expectedQuantity,
      venueQuantity,
      fingerprint,
    };
    this.inventoryMismatches.set(key, tracker);
    return tracker;
  }

  private recentOrderCanExplainInventoryDelta(marketKey: string, delta: number, now: number): boolean {
    if (Math.abs(delta) <= 0.01) return false;
    const explanatorySide = delta < 0 ? "SELL" : "BUY";
    return this.stateStore.listOrders({ marketKey }).some((order) =>
      order.side === explanatorySide &&
      order.status !== "REJECTED" &&
      order.quantity - order.filledQuantity > EPSILON &&
      now - order.updatedAt <= FILL_CURSOR_OVERLAP_MS);
  }

  /** Markets whose books must be supervised: those carrying inventory or a working order. */
  private supervisedBookKeys(): Set<string> {
    return new Set(
      Object.entries(this.reducerState.markets)
        .filter(([, market]) => market.catalog && (market.inventory || Object.values(market.orders).some((order) => !["CANCELED", "FILLED", "REJECTED"].includes(order.status))))
        .map(([key]) => key),
    );
  }

  private async resnapshotBooks(): Promise<number> {
    return (await this.fetchAndReduceBooks(this.supervisedBookKeys())).books;
  }

  private scheduleNextTick(): void {
    if (!this.started || this.shuttingDown || !this.autoSchedule) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    // Supervisory reconciliation/books run at the strategy's fast cadence;
    // pollMarketInputs separately due-gates paid Quotient refreshes.
    const delay = this.config.reconciliation.rest_reconcile_seconds * 1_000;
    this.tickTimer = setTimeout(() => {
      void this.tick()
        .catch((error) => this.log.error("scheduled market-make tick failed", { error: error instanceof Error ? error.message : String(error) }))
        .finally(() => this.scheduleNextTick());
    }, delay);
    this.tickTimer.unref?.();
  }

  private startHeartbeatLoop(): void {
    if (!this.venue.heartbeat || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatOnce().catch((error) => {
        const reason = `heartbeat failure: ${error instanceof Error ? error.message : String(error)}`;
        this.log.error("market-make heartbeat failed", { error: reason });
        void this.latchEmergencyDegrade(reason)
          .catch((latchError) => this.log.error("market-make immediate heartbeat safety latch failed", {
            error: latchError instanceof Error ? latchError.message : String(latchError),
          }))
          .finally(() => {
            void this.serialized(() => this.degrade(reason)).catch((degradeError) => {
              this.log.error("market-make queued heartbeat degradation failed", {
                error: degradeError instanceof Error ? degradeError.message : String(degradeError),
              });
            });
          });
      });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private async heartbeatOnce(): Promise<void> {
    if (this.heartbeatSuppressed) return;
    if (!this.venue.heartbeat || !this.stateStore.listOrders({ activeOnly: true }).some(orderIsResting)) return;
    if (this.heartbeatInFlight) return this.heartbeatInFlight;
    const pending = this.venue.heartbeat(this.account);
    const tracked = pending.finally(() => {
      if (this.heartbeatInFlight === tracked) this.heartbeatInFlight = undefined;
    });
    this.heartbeatInFlight = tracked;
    return tracked;
  }

  private async startSubscriptions(): Promise<void> {
    if (this.venue.subscribeUserData && !this.userSubscription) {
      this.userSubscription = await this.venue.subscribeUserData();
      this.lastUserStreamAt = this.now();
      this.markStreamReconnected("user", this.lastUserStreamAt);
      this.consumeSubscription(this.userSubscription, "user");
    }
    await this.refreshMarketSubscription();
  }

  private async refreshMarketSubscription(): Promise<void> {
    if (!this.enableSubscriptions || !this.venue.subscribeMarketData) return;
    const tokenIds = [...this.catalogCache.values()]
      .flatMap((entry) => [entry.value.yesTokenId, entry.value.noTokenId])
      .sort();
    const key = [...new Set(tokenIds)].join(",");
    if (!key || key === this.marketSubscriptionKey) return;
    const previous = this.marketSubscription;
    this.marketSubscription = undefined;
    this.marketSubscriptionKey = "";
    await previous?.close();
    const subscription = await this.venue.subscribeMarketData([...new Set(tokenIds)]);
    this.marketSubscription = subscription;
    this.marketSubscriptionKey = key;
    this.lastMarketStreamAt = this.now();
    this.markStreamReconnected("market", this.lastMarketStreamAt);
    this.consumeSubscription(subscription, "market");
  }

  private consumeSubscription(subscription: RealtimeSubscription, kind: StreamKind): void {
    const task = (async () => {
      try {
        for await (const _event of subscription) {
          if (this.shuttingDown) break;
          const messageAt = this.now();
          if (kind === "market") this.lastMarketStreamAt = messageAt;
          else {
            this.lastUserStreamAt = messageAt;
            this.userWakeGeneration += 1;
            // User messages are opaque wake signals. Until their REST follow-
            // up completes, an earlier flat/settled proof is no longer safe
            // for a withdrawal.
            this.settlementQuiescent = false;
          }
          this.markStreamMessage(kind, messageAt);
          // The pinned adapter currently exposes an opaque SDK payload. Treat
          // it only as a wake-up signal; exact books/orders/fills are reread
          // through typed REST APIs before the reducer acts.
          this.queueWake(kind);
        }
        if (!this.shuttingDown && this.currentSubscription(kind) === subscription) {
          await this.handleSubscriptionFailure(kind, subscription, `${kind} websocket closed`);
        }
      } catch (error) {
        if (!this.shuttingDown && this.currentSubscription(kind) === subscription) {
          await this.handleSubscriptionFailure(
            kind,
            subscription,
            `${kind} websocket failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    })();
    this.subscriptionTasks.add(task);
    void task.finally(() => this.subscriptionTasks.delete(task));
  }

  private currentSubscription(kind: StreamKind): RealtimeSubscription | undefined {
    return kind === "market" ? this.marketSubscription : this.userSubscription;
  }

  private async handleSubscriptionFailure(
    kind: StreamKind,
    subscription: RealtimeSubscription,
    reason: string,
  ): Promise<void> {
    if (this.currentSubscription(kind) !== subscription) return;
    if (kind === "market") {
      this.marketSubscription = undefined;
      this.marketSubscriptionKey = "";
    } else {
      this.userSubscription = undefined;
    }
    this.requireStreamRecovery(kind, reason, this.now());
    // This safety lane deliberately does not wait behind a paid Q/Gamma tick:
    // latch entry-off and cancel at the venue first, then serialize reducer
    // bookkeeping when the ordinary controller lane becomes available.
    await this.latchEmergencyDegrade(reason);
    try {
      await this.startSubscriptions();
    } catch (error) {
      this.log.error("market-make websocket reconnect failed", {
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    void this.serialized(() => this.degrade(reason)).catch((error) => {
      this.log.error("market-make queued websocket degradation failed", {
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private queueWake(kind: StreamKind): void {
    if (this.shuttingDown) return;
    if (kind === "user") {
      // Account activity: re-read orders, fills, and positions immediately.
      // A message arriving mid-read schedules one trailing follow-up so a
      // fill that lands during the read is not deferred to the next tick.
      if (this.wakeQueued) {
        this.userWakePending = true;
        return;
      }
      this.wakeQueued = true;
      void this.serialized(() => this.runWake("user")).finally(() => {
        this.wakeQueued = false;
        if (this.userWakePending) {
          this.userWakePending = false;
          this.queueWake("user");
        }
      });
      return;
    }
    // A market message is a book change. It only matters for markets that
    // carry inventory or working orders, and bursts are coalesced on the wall
    // clock so a busy subscription cannot become a REST storm. Account state
    // is not re-read here: fills arrive on the user stream and the periodic
    // tick reconciles on its own cadence.
    if (!this.marketRecoveryReconcilePending() && this.supervisedBookKeys().size === 0) return;
    if (this.marketWakeTimer) return;
    const wallClock = Date.now();
    const elapsed = this.lastMarketWakeWallClockAt === undefined
      ? Number.POSITIVE_INFINITY
      : wallClock - this.lastMarketWakeWallClockAt;
    if (elapsed >= MARKET_WAKE_MIN_INTERVAL_MS) {
      this.lastMarketWakeWallClockAt = wallClock;
      void this.serialized(() => this.runWake("market"));
      return;
    }
    this.marketWakeTimer = setTimeout(() => {
      this.marketWakeTimer = undefined;
      if (this.shuttingDown) return;
      this.lastMarketWakeWallClockAt = Date.now();
      void this.serialized(() => this.runWake("market"));
    }, MARKET_WAKE_MIN_INTERVAL_MS - elapsed);
    this.marketWakeTimer.unref?.();
  }

  /** A post-reconnect market message is waiting for the reconciliation that proves recovery. */
  private marketRecoveryReconcilePending(): boolean {
    const gate = this.marketStreamRecovery;
    return gate !== undefined && gate.messageAt !== undefined && gate.reconciledAt === undefined;
  }

  private async runWake(kind: StreamKind): Promise<void> {
    if (this.shuttingDown) return;
    try {
      if (kind === "user" || this.marketRecoveryReconcilePending()) {
        await this.reconcileInternal(true);
        await this.adoptResidualInventory(this.lastPositions);
      }
      await this.resnapshotBooks();
      await this.flushReducerState();
    } catch (error) {
      if (this.tolerateTransientReadFailure(`${kind}-websocket-event`, error)) return;
      await this.degrade(`${kind}-websocket-event: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async checkStreamFreshness(at: number): Promise<void> {
    if (!this.enableSubscriptions) return;
    // A silent stream is not a dead stream. The CLOB market channel pushes
    // only on book changes and the user channel only on account activity, so
    // a quiet book or a flat account legitimately hears nothing for minutes.
    // Socket death surfaces through the subscription ending. The kill switch
    // therefore fires only when there is exposure to supervise, the stream
    // is silent, and the typed REST reads that supervise it have gone stale.
    if (this.supervisedBookKeys().size === 0) return;
    // REST reads land once per tick, and a tick can run long behind a slow
    // paid poll, so their freshness is judged against the read-tolerance
    // window rather than the (shorter) stream-silence threshold.
    const marketRestStaleMs = Math.max(
      this.config.global_kill_switches.market_websocket_stale_seconds * 1_000,
      AUTHORITATIVE_READ_TOLERANCE_MS,
    );
    const userRestStaleMs = Math.max(
      this.config.global_kill_switches.user_websocket_stale_seconds * 1_000,
      AUTHORITATIVE_READ_TOLERANCE_MS,
    );
    if (
      this.marketSubscription && this.lastMarketStreamAt !== undefined &&
      at - this.lastMarketStreamAt > this.config.global_kill_switches.market_websocket_stale_seconds * 1_000 &&
      !(this.lastMarketRestAt !== undefined && at - this.lastMarketRestAt <= marketRestStaleMs)
    ) {
      const reason = "market websocket and REST market data are stale";
      this.requireStreamRecovery("market", reason, at);
      await this.latchEmergencyDegrade(reason);
      await this.degrade(reason);
      const previous = this.marketSubscription;
      this.marketSubscription = undefined;
      this.marketSubscriptionKey = "";
      await previous.close();
      await this.refreshMarketSubscription();
      return;
    }
    if (
      this.userSubscription && this.lastUserStreamAt !== undefined &&
      at - this.lastUserStreamAt > this.config.global_kill_switches.user_websocket_stale_seconds * 1_000 &&
      !(this.lastUserRestAt !== undefined && at - this.lastUserRestAt <= userRestStaleMs)
    ) {
      const reason = "user websocket and REST account data are stale";
      this.requireStreamRecovery("user", reason, at);
      await this.latchEmergencyDegrade(reason);
      await this.degrade(reason);
      const previous = this.userSubscription;
      this.userSubscription = undefined;
      await previous.close();
      await this.startSubscriptions();
    }
  }

  private streamRecovery(kind: StreamKind): StreamRecoveryGate | undefined {
    return kind === "market" ? this.marketStreamRecovery : this.userStreamRecovery;
  }

  private setStreamRecovery(kind: StreamKind, gate: StreamRecoveryGate): void {
    if (kind === "market") this.marketStreamRecovery = gate;
    else this.userStreamRecovery = gate;
  }

  private requireStreamRecovery(kind: StreamKind, reason: string, at: number): void {
    const previous = this.streamRecovery(kind);
    this.setStreamRecovery(kind, {
      generation: (previous?.generation ?? 0) + 1,
      reason,
      requiredAt: at,
    });
  }

  private markStreamReconnected(kind: StreamKind, at: number): void {
    const gate = this.streamRecovery(kind);
    if (!gate) return;
    gate.reconnectedAt = at;
    gate.reconnectReconcileSequence = this.reconcileSequence;
    gate.messageAt = undefined;
    gate.messageAfterReconcileSequence = undefined;
    gate.reconciledAt = undefined;
  }

  private markStreamMessage(kind: StreamKind, at: number): void {
    const gate = this.streamRecovery(kind);
    if (!gate || gate.reconnectedAt === undefined) return;
    gate.messageAt = at;
    gate.messageAfterReconcileSequence = this.reconcileSequence;
    gate.reconciledAt = undefined;
  }

  private markStreamReconciled(sequence: number, at: number): void {
    for (const [kind, gate] of [
      ["market", this.marketStreamRecovery],
      ["user", this.userStreamRecovery],
    ] as const) {
      if (!gate || gate.reconnectedAt === undefined) continue;
      const afterMessage =
        gate.messageAt !== undefined &&
        gate.messageAfterReconcileSequence !== undefined &&
        sequence > gate.messageAfterReconcileSequence;
      // The market channel replays a book snapshot for every subscribed
      // token on connect, so a post-reconnect message is guaranteed there.
      // The user channel pushes only on account activity, so a quiet or flat
      // account can never prove delivery with a message: a fresh subscription
      // followed by an authoritative REST reconciliation is its proof.
      const afterReconnect =
        kind === "user" &&
        gate.reconnectReconcileSequence !== undefined &&
        sequence > gate.reconnectReconcileSequence;
      if (afterMessage || afterReconnect) gate.reconciledAt = at;
    }
  }

  private streamRecoveryBlockReason(): string | undefined {
    if (!this.enableSubscriptions) return undefined;
    for (const [kind, gate] of [
      ["market", this.marketStreamRecovery],
      ["user", this.userStreamRecovery],
    ] as const) {
      if (!gate) continue;
      if (gate.reconnectedAt === undefined) return `${kind} websocket has not reconnected`;
      if (kind === "market" && gate.messageAt === undefined) return `${kind} websocket has not delivered a post-reconnect message`;
      if (gate.reconciledAt === undefined) {
        return kind === "market"
          ? `${kind} websocket message has not been followed by authoritative reconciliation`
          : `${kind} websocket reconnect has not been followed by authoritative reconciliation`;
      }
    }
    return undefined;
  }

  private async latchEmergencyDegrade(reason: string): Promise<void> {
    const now = this.now();
    this.lastError = reason;
    this.reducerState.halted = true;
    this.stateStore.setExitOnlyLifecycle("DATA_DEGRADED", reason, now);
    let cancellationFailure: string | undefined;
    try {
      await this.venue.cancelAll(this.account);
      this.cancelAllIssuedAt = now;
      for (const order of this.stateStore.listOrders({ activeOnly: true })) {
        const tracker = this.orderAbsences.get(order.clientOrderId) ?? {
          count: 0,
          firstAbsentAt: now,
          lastAbsentAt: now,
        };
        this.orderAbsences.set(order.clientOrderId, { ...tracker, cancelAllIssuedAt: now });
        this.stateStore.requestCancel(order.clientOrderId, now);
      }
    } catch (error) {
      cancellationFailure = `emergency cancel-all failed: ${error instanceof Error ? error.message : String(error)}`;
      await this.retryEveryWorkingOrderCancellation(now, reason, false);
    }
    // Safety mutation/cancellation is deliberately ahead of logging and
    // outbound alert delivery, which may be slow or unavailable.
    await this.saveReducerState();
    await this.operationalError("MM_DATA_DEGRADED", reason);
    if (cancellationFailure) {
      await this.operationalError("MM_CANCEL_ALL_FAILED", cancellationFailure, { trigger: reason });
    }
  }

  private async degrade(reason: string): Promise<void> {
    this.lastError = reason;
    this.reducerState.halted = true;
    if (this.stateStore.status().lifecycle !== "EXIT_BLOCKED") {
      this.stateStore.setExitOnlyLifecycle("DATA_DEGRADED", reason, this.now());
    }
    await this.operationalError("MM_DATA_DEGRADED", reason);
    try {
      await this.processEvent({ type: "halt", ts: this.now(), liquidate: false });
    } catch (error) {
      this.log.error("market-make failed to cancel orders while degrading", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async alert(kind: AlertKind, message: string, data?: Record<string, unknown>): Promise<void> {
    if (!this.alerter) return;
    try {
      await this.alerter.send({ kind, botId: this.botId, message, ...(data ? { data } : {}) });
    } catch (error) {
      this.log.warn("market-make alert delivery failed", {
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async operationalError(
    code: string,
    message: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    const now = this.now();
    const fingerprint = `${code}:${message}:${JSON.stringify(context ?? {})}`;
    const prior = this.alertFingerprints.get(fingerprint);
    try {
      await this.snapshotStore.appendError({
        ts: now,
        level: "error",
        code,
        venue: "polymarket",
        message,
        ...(context ? { context } : {}),
      });
    } catch (error) {
      this.log.warn("market-make structured error persistence failed", {
        code,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Every incident remains in the structured error log. Only the outbound
    // interruption is deduplicated, so repeated failures stay auditable.
    if (prior !== undefined && now - prior < 5 * 60_000) return;
    this.alertFingerprints.set(fingerprint, now);
    await this.alert("error", message, { code, ...(context ?? {}) });
  }
}

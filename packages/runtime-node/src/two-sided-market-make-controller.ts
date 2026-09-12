// packages/runtime-node/src/two-sided-market-make-controller.ts
// Continuous complementary bid/ask quoting with a compact checkpoint in the bot's existing SQLite file.

import { createHash } from "node:crypto";
import type {
  Fill, Logger, MarketMakeQuotientClient, MarketMakeSignalRow, Order, OrderBook, OrderIntent, PolymarketCatalogClient,
  PolymarketMarketCatalog, Position, RealtimeSubscription, StateStore, VenueAccount, VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import { isTransientVenueError, retryAfterMs as sharedRetryAfterMs } from "@quotient-forecasting/cassie-core";
import {
  MarketMakeConfigSchema, categoryFamily, marketMakeConfigForBankroll, marketMakeConfigHash, planTwoSidedQuotes, planAdaptiveQuotes,
  type AdaptiveForecast, type AdaptiveMovement, type MarketMakeConfig, type TwoSidedPlan, type TwoSidedQuote,
} from "@quotient-forecasting/strategy-market-make";

const CHECKPOINT_KEY = "market-make:two-sided:v1";
const EPSILON = 1e-8;
const CASH_TOLERANCE_USD = 0.00001;
const FILL_OVERLAP_MS = 5 * 60_000;
const RECENT_RECEIPT_MS = 24 * 60 * 60_000;
const SETTLEMENT_DELAY_MS = 5_000;
const ACCOUNT_POLL_MS = 60_000;
const MAX_RETRY_MS = 5 * 60_000;
const silentLog = { info() {}, warn() {}, error() {} };
interface CachedAdaptiveForecast {
  value?: AdaptiveForecast;
  fetchedAt?: number;
  nextAttemptAt: number;
  failures: number;
}
type ReceiptStatus = "RESERVED" | "SIGNED" | "OPEN" | "UNKNOWN" | "CANCEL_PENDING" | "CANCELED" | "FILLED" | "REJECTED";

export interface Receipt extends TwoSidedQuote {
  clientId: string;
  venueId?: string;
  preparedHash?: string;
  status: ReceiptStatus;
  filled: number;
  observedFilled?: number;
  failedFilled?: number;
  createdAt: number;
  updatedAt: number;
  cancelRequestedAt?: number;
  absentSince?: number;
  absentCount?: number;
  error?: string;
  entryForecast?: AdaptiveForecast;
  firstFillAt?: number;
}
export interface Inventory {
  tokenId: string;
  marketKey: string;
  outcome: "YES" | "NO";
  quantity: number;
  averageCost: number;
  firstHeldAt: number;
  initialEdgePp?: number;
  qBacked?: boolean;
  exitReason?: string;
}
export interface Checkpoint {
  schemaVersion: "two-sided-checkpoint/1";
  configHash: string;
  deploymentId: string;
  approved: boolean;
  active: boolean;
  haltReason?: string;
  sequence: number;
  collateralUsd: number;
  confirmedCollateralUsd?: number;
  collateralUnsettled?: boolean;
  inventory: Record<string, Inventory>;
  orders: Record<string, Receipt>;
  markets: Record<string, PolymarketMarketCatalog>;
  fillIds: Record<string, number>;
  fillCursor: number;
  initialEquityUsd?: number;
  highWaterUsd?: number;
  lossLatched: boolean;
  lastReconciledAt?: number;
  lastTradingAt?: number;
  equityHistory?: Array<{ ts: number; equity: number }>;
  realizedPnlUsd?: number;
  reduceOnly?: boolean;
  recoverablePause?: boolean;
  venueRetry?: { failures: number; nextAttemptAt: number; reason: string };
  settlements?: Record<string, { orderId: string; status: NonNullable<Fill["settlementStatus"]>; quantity: number; price: number; ts: number }>;
  redemptions?: Record<string, { marketKey: string; conditionId: string; tokenIds: string[]; status: "WAITING_ORDERS" | "REQUESTED" | "SUBMITTED" | "UNKNOWN" | "CONFIRMED"; requestedAt: number; operatorRequired: boolean; transactionHash?: string; transactionId?: string; error?: string }>;
  /** Latest entry/exit inputs only; no forecast history or order-book telemetry. */
  forecasts?: Record<string, CachedAdaptiveForecast>;
}
interface VenueSnapshot {
  at: number;
  collateralUsd: number;
  orders: Order[];
  positions: Position[];
  fills: Fill[];
}
export interface TwoSidedMarketMakeControllerDeps {
  config: MarketMakeConfig;
  stateStore: StateStore;
  venue: VenueAdapter;
  account: VenueAccount;
  catalog: Pick<PolymarketCatalogClient, "market"> & Partial<Pick<PolymarketCatalogClient, "recover" | "activeMarkets">>;
  quotient?: Pick<MarketMakeQuotientClient, "activeSignals" | "spentUsd"> & Partial<Pick<MarketMakeQuotientClient, "exactForecasts">>;
  botId?: string;
  log?: Pick<Logger, "info" | "warn" | "error">;
  alerter?: unknown;
}
export interface TwoSidedMarketMakeControllerOptions {
  deploymentId: string;
  now?: () => number;
  autoSchedule?: boolean;
  enableSubscriptions?: boolean;
  heartbeatIntervalMs?: number;
}
export interface TwoSidedReconcileResult {
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
    unknownOrdersToCancel: Array<{ venueOrderId?: string; clientOrderId?: string; tokenId?: string; side: string; remainingQuantity: number; limitPrice: number }>;
    residualInventory: Position[];
    inventoryApplication: { mode: "authoritative-token-balances"; note: string };
  };
}
function working(order: Receipt): boolean {
  return !["CANCELED", "FILLED", "REJECTED"].includes(order.status);
}
function remaining(order: Receipt): number { return Math.max(0, order.size - order.filled); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function fillIdentity(fill: Fill): string {
  return `${fill.id}:${fill.makerOrderId ?? fill.orderId ?? "none"}`;
}
const transientVenueError = isTransientVenueError;
/** The shared helper returns undefined when the venue gave no hint; this lane treats that as no delay. */
function retryAfterMs(error: unknown): number { return sharedRetryAfterMs(error) ?? 0; }

export class TwoSidedMarketMakeController {
  private readonly config: MarketMakeConfig;
  private readonly configHash: string;
  private readonly now: () => number;
  private readonly log: Pick<Logger, "info" | "warn" | "error">;
  private checkpoint: Checkpoint;
  private started = false;
  private stopping = false;
  private queue: Promise<unknown> = Promise.resolve();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private tickTimer?: ReturnType<typeof setTimeout>;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private heartbeatPending?: Promise<void>;
  private userSubscription?: RealtimeSubscription;
  private marketSubscription?: RealtimeSubscription;
  private marketSubscriptionKey = "";
  private discoveryAt = 0;
  private candidates: PolymarketMarketCatalog[] = [];
  private lastSnapshot?: VenueSnapshot;
  private positionSnapshot?: { at: number; positions: Position[] };
  private lastTickAt?: number;
  private lastError?: string;
  private unsettledTokens = new Set<string>();
  private unsettledOrders = new Set<string>();
  private safetyGeneration = 0;
  private wakePending = false;
  private userWakePending = false;
  private lastPlans: Array<{ market: PolymarketMarketCatalog; plan: TwoSidedPlan }> = [];
  private markedEquityUsd?: number;
  private movement = new Map<string, Array<{ at: number; mid: number }>>();
  private signalDiscoveryAt = Number.NEGATIVE_INFINITY;
  private signalRows: MarketMakeSignalRow[] = [];
  private signalCatalogs = new Map<string, PolymarketMarketCatalog>();
  private signalCatalogAttempts = new Map<string, number>();

  constructor(private readonly deps: TwoSidedMarketMakeControllerDeps, private readonly options: TwoSidedMarketMakeControllerOptions) {
    this.config = MarketMakeConfigSchema.parse(deps.config);
    if (!this.config.two_sided) throw new Error("two-sided market making requires two_sided configuration");
    if (this.config.two_sided.adaptive && !deps.quotient?.exactForecasts) throw new Error("adaptive market making requires exact Quotient forecasts");
    if (deps.venue.id !== "polymarket" || deps.account.venue !== "polymarket") throw new Error("two-sided market making is Polymarket-only");
    if (!deps.venue.tokenBook || !deps.venue.placeOrderWithLifecycle) throw new Error("two-sided market making requires exact token books and prepared-order lifecycle support");
    if (!options.deploymentId.trim()) throw new Error("deploymentId is required");
    this.configHash = marketMakeConfigHash(this.config);
    this.now = options.now ?? Date.now;
    this.log = deps.log ?? silentLog;
    this.checkpoint = {
      schemaVersion: "two-sided-checkpoint/1", configHash: this.configHash, deploymentId: options.deploymentId,
      approved: false, active: false, sequence: 0, collateralUsd: 0, inventory: {}, orders: {}, markets: {},
      fillIds: {}, fillCursor: 0, lossLatched: false,
    };
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async save(): Promise<void> {
    const cutoff = this.now() - RECENT_RECEIPT_MS;
    for (const [id, order] of Object.entries(this.checkpoint.orders)) {
      if (!working(order) && order.updatedAt < cutoff) delete this.checkpoint.orders[id];
    }
    for (const [id, ts] of Object.entries(this.checkpoint.fillIds)) {
      if (ts < this.fillSince()) delete this.checkpoint.fillIds[id];
    }
    const requiredMarkets = new Set([...Object.values(this.checkpoint.orders).map((row) => row.marketKey), ...Object.values(this.checkpoint.inventory).filter((row) => row.quantity > EPSILON).map((row) => row.marketKey)]);
    for (const redemption of Object.values(this.checkpoint.redemptions ?? {})) if (redemption.status !== "CONFIRMED") requiredMarkets.add(redemption.marketKey);
    for (const key of Object.keys(this.checkpoint.markets)) if (!requiredMarkets.has(key)) delete this.checkpoint.markets[key];
    for (const [id, settlement] of Object.entries(this.checkpoint.settlements ?? {})) {
      if (!this.checkpoint.orders[settlement.orderId] && settlement.ts < cutoff) delete this.checkpoint.settlements![id];
    }
    for (const [id, redemption] of Object.entries(this.checkpoint.redemptions ?? {})) {
      if (redemption.status === "CONFIRMED" && redemption.requestedAt < cutoff) delete this.checkpoint.redemptions![id];
    }
    await this.deps.stateStore.set(CHECKPOINT_KEY, JSON.stringify(this.checkpoint));
  }
  async start() {
    if (this.started) return this.status();
    const raw = await this.deps.stateStore.get(CHECKPOINT_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Checkpoint;
      if (saved.schemaVersion !== "two-sided-checkpoint/1" || !saved.orders || !saved.inventory || !saved.markets) {
        throw new Error("invalid two-sided checkpoint; cannot restore live order ownership");
      }
      if (!Number.isSafeInteger(saved.sequence) || saved.sequence < 0 || !Number.isFinite(saved.collateralUsd) || saved.collateralUsd < 0 ||
        (saved.confirmedCollateralUsd !== undefined && (!Number.isFinite(saved.confirmedCollateralUsd) || saved.confirmedCollateralUsd < -CASH_TOLERANCE_USD)) ||
        Object.values(saved.inventory).some((row) => !Number.isFinite(row.quantity) || row.quantity < 0 || !Number.isFinite(row.averageCost) || row.averageCost < 0) ||
        Object.values(saved.orders).some((row) => !Number.isFinite(row.size) || row.size <= 0 || !Number.isFinite(row.limitPrice) || row.limitPrice <= 0 || row.limitPrice >= 1 || !Number.isFinite(row.filled) || row.filled < 0 || row.filled > row.size + EPSILON)) {
        throw new Error("invalid numeric trading state in two-sided checkpoint");
      }
      this.checkpoint = saved;
      for (const redemption of Object.values(this.checkpoint.redemptions ?? {})) {
        if (redemption.status === "REQUESTED") { redemption.status = "UNKNOWN"; redemption.operatorRequired = true; redemption.error = "redemption request was interrupted; verify the transaction before retrying"; }
      }
    }
    const sameIdentity = this.checkpoint.configHash === this.configHash && this.checkpoint.deploymentId === this.options.deploymentId;
    if (!sameIdentity) {
      this.checkpoint.approved = false;
      this.checkpoint.active = false;
      this.checkpoint.recoverablePause = false;
      this.checkpoint.haltReason = "configuration or deployment changed; reviewed reconciliation required";
      this.checkpoint.configHash = this.configHash;
      this.checkpoint.deploymentId = this.options.deploymentId;
    }
    this.started = true;
    this.stopping = false;
    this.startHeartbeat();
    try {
      const snapshot = await this.readSnapshot();
      if (this.checkpoint.approved) await this.applySnapshot(snapshot);
      else {
        this.lastSnapshot = snapshot;
        this.checkpoint.collateralUsd = snapshot.collateralUsd;
        this.checkpoint.active = false;
        this.checkpoint.haltReason ??= "review reconciliation and resume to activate two-sided quoting";
      }
      if (this.checkpoint.active && this.hasUnknown()) await this.failClosed("unresolved prepared order recovered at startup");
      await this.save();
      await this.startSubscriptions();
      if (this.options.autoSchedule !== false) this.schedule();
      return this.status();
    } catch (error) {
      if (transientVenueError(error)) {
        await this.pauseForVenue(error);
        if (this.options.autoSchedule !== false) this.schedule();
        return this.status();
      }
      this.started = false;
      this.stopTimers();
      throw error;
    }
  }
  private stopTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.heartbeatTimer = undefined;
    this.tickTimer = undefined;
    this.wakeTimer = undefined;
  }
  async shutdown(): Promise<void> {
    this.safetyGeneration += 1;
    this.stopping = true;
    this.stopTimers();
    await Promise.allSettled([this.marketSubscription?.close(), this.userSubscription?.close()]);
    this.marketSubscription = undefined;
    this.userSubscription = undefined;
    await this.serialized(async () => {
      // Keep the explicit activation intent across an orderly service restart.
      if (this.checkpoint.approved) await this.cancelWorking("service shutdown");
      await this.save();
      this.started = false;
    });
  }

  status() {
    const orders = Object.values(this.checkpoint.orders).filter(working);
    const inventory = Object.values(this.checkpoint.inventory).filter((row) => row.quantity > EPSILON);
    const reserved = orders.filter((order) => order.side === "BUY").reduce((sum, order) => sum + remaining(order) * order.limitPrice, 0);
    const tokens = inventory.map((row) => {
      const reservedQuantity = orders.filter((order) => order.side === "SELL" && order.tokenId === row.tokenId).reduce((sum, order) => sum + remaining(order), 0);
      return { tokenId: row.tokenId, marketKey: row.marketKey, outcome: row.outcome, totalQuantity: row.quantity, reservedQuantity, freeQuantity: Math.max(0, row.quantity - reservedQuantity) };
    });
    const scale = this.bankrollScale();
    const strategyCapitalUsd = this.checkpoint.collateralUsd + inventory.reduce((sum, row) => sum + row.quantity * row.averageCost, 0);
    const drawdownUsd = Math.max(0, (this.checkpoint.highWaterUsd ?? strategyCapitalUsd) - (this.markedEquityUsd ?? strategyCapitalUsd));
    const rollingStart = this.checkpoint.equityHistory?.[0]?.equity ?? this.checkpoint.initialEquityUsd ?? strategyCapitalUsd;
    const loss = { latched: this.checkpoint.lossLatched, realizedPnlUsd: this.checkpoint.realizedPnlUsd ?? 0, markedPnlUsd: (this.markedEquityUsd ?? strategyCapitalUsd) - (this.checkpoint.initialEquityUsd ?? strategyCapitalUsd), rolling24hLossUsd: Math.max(0, rollingStart - (this.markedEquityUsd ?? strategyCapitalUsd)), drawdownUsd, highWaterUsd: this.checkpoint.highWaterUsd ?? strategyCapitalUsd };
    const lifecycle = this.checkpoint.lossLatched ? "RISK_EXIT_ONLY" as const : this.checkpoint.recoverablePause ? "DATA_DEGRADED" as const : this.checkpoint.active ? "ACTIVE" as const : "HALTED" as const;
    const availability = { collateralTotalUsd: this.checkpoint.collateralUsd, collateralReservedUsd: reserved, collateralFreeUsd: Math.max(0, this.checkpoint.collateralUsd - reserved), tokens };
    const counts = { activeOrders: orders.length, unknownOrders: orders.filter((order) => ["SIGNED", "UNKNOWN"].includes(order.status)).length, cancelPendingOrders: orders.filter((order) => order.status === "CANCEL_PENDING").length, activeInventoryCycles: inventory.length };
    const settled = this.unsettledTokens.size === 0 && this.unsettledOrders.size === 0 && !this.hasUnknown() && !this.pendingRedemption() && !this.checkpoint.collateralUnsettled;
    const activationCurrent = this.checkpoint.approved && this.checkpoint.active && settled;
    const lastReconciliation = this.checkpoint.lastReconciledAt === undefined ? undefined : { id: `two-sided:${this.checkpoint.lastReconciledAt}`, ts: this.checkpoint.lastReconciledAt, ok: settled };
    const persistence = { lifecycle, activationCurrent, configuredHash: this.configHash, deploymentId: this.options.deploymentId, haltReason: this.checkpoint.haltReason, counts, loss, availability, lastReconciliation };
    return {
      strategyId: "market-make" as const, mode: this.config.two_sided?.adaptive ? "q-adaptive" as const : "two-sided" as const, schemaVersion: this.config.schema_version,
      configHash: this.configHash, effectiveConfigHash: marketMakeConfigHash(this.effectiveConfig()), deploymentId: this.options.deploymentId,
      bankrollMode: this.config.cassie_overrides.bankroll.mode, bankrollObserved: this.lastSnapshot !== undefined,
      bankrollEntryReady: this.checkpoint.approved && settled, bankrollRefreshPending: this.checkpoint.collateralUnsettled === true,
      strategyCapitalUsd, effectiveBankrollUsd: this.config.capital.sizing_bankroll_usd * scale,
      bankrollReferenceUsd: this.config.capital.sizing_bankroll_usd, bankrollScale: scale,
      started: this.started, halted: !this.checkpoint.active, lifecycle, activationCurrent,
      haltReason: this.checkpoint.haltReason, lossLatched: this.checkpoint.lossLatched, loss, counts, availability, persistence,
      activeMarkets: new Set([...orders.map((row) => row.marketKey), ...inventory.map((row) => row.marketKey)]).size,
      liveOrders: orders.length, deployedUsd: reserved + inventory.reduce((sum, row) => sum + row.quantity * row.averageCost, 0),
      lastTickAt: this.lastTickAt, lastError: this.lastError, lastReconciliation,
      accountPollSeconds: this.accountPollMs() / 1_000,
      lastPositionPollAt: this.positionSnapshot?.at,
      venueRetry: this.checkpoint.venueRetry ? { ...this.checkpoint.venueRetry } : undefined,
      settlementQuiescent: orders.length === 0 && settled && this.now() - (this.checkpoint.lastTradingAt ?? 0) >= FILL_OVERLAP_MS,
      settlementQuiescentAt: this.checkpoint.lastReconciledAt, quotientSpentUsd: this.deps.quotient?.spentUsd ?? 0,
      markets: this.lastPlans.map(({ market, plan }) => ({ marketKey: market.marketKey, question: market.question, eligible: plan.eligible, reasons: plan.reasons, ...(plan.context.adaptive ? { adaptive: plan.context.adaptive } : {}) })),
      redemptions: Object.values(this.checkpoint.redemptions ?? {}),
    };
  }
  stateSnapshot() { return structuredClone(this.checkpoint); }
  private bankrollScale(): number {
    if (this.config.cassie_overrides.bankroll.mode === "fixed") return 1;
    const basis = Object.values(this.checkpoint.inventory).reduce((sum, row) => sum + row.quantity * row.averageCost, 0);
    const ceiling = this.config.cassie_overrides.bankroll.maximum_sizing_bankroll_usd ?? Number.POSITIVE_INFINITY;
    return Math.max(0, Math.min(ceiling, this.checkpoint.collateralUsd + basis) / this.config.capital.sizing_bankroll_usd);
  }
  private effectiveConfig(): MarketMakeConfig {
    const bankroll = this.config.capital.sizing_bankroll_usd * this.bankrollScale();
    return bankroll > 0 ? marketMakeConfigForBankroll(this.config, bankroll) : this.config;
  }
  private async readRetry<T>(read: () => Promise<T>): Promise<T> {
    if (this.venueCoolingDown()) throw Object.assign(new Error(`venue retry cooldown: ${this.checkpoint.venueRetry!.reason}`), { name: "VenueCooldownError" });
    try { return await read(); }
    catch (error) {
      if (transientVenueError(error)) this.deferVenueRetry(error);
      throw error;
    }
  }
  private accountPollMs(): number { return Math.max(ACCOUNT_POLL_MS, this.config.reconciliation.rest_reconcile_seconds * 1_000); }
  private venueCoolingDown(): boolean { return this.now() < (this.checkpoint.venueRetry?.nextAttemptAt ?? 0); }
  private deferVenueRetry(error: unknown): void {
    // A parallel snapshot can fail on several endpoints. Count it once, and do
    // not let stream wakes extend the same cooldown indefinitely.
    if (this.venueCoolingDown()) {
      const requested = retryAfterMs(error);
      if (requested > 0) this.checkpoint.venueRetry!.nextAttemptAt = Math.max(this.checkpoint.venueRetry!.nextAttemptAt, this.now() + requested);
      return;
    }
    const failures = (this.checkpoint.venueRetry?.failures ?? 0) + 1;
    const delay = Math.max(Math.min(MAX_RETRY_MS, ACCOUNT_POLL_MS * 2 ** Math.min(failures - 1, 10)), retryAfterMs(error));
    this.checkpoint.venueRetry = { failures, nextAttemptAt: this.now() + delay, reason: String(error) };
    this.log.warn("venue requests paused; automatic retry scheduled", { failures, retryInSeconds: delay / 1_000, error: String(error) });
  }
  private async pauseForVenue(error: unknown): Promise<void> {
    this.deferVenueRetry(error);
    this.lastError = String(error);
    if (this.checkpoint.active) await this.failClosed(`venue supervision temporarily unavailable: ${String(error)}`, true);
    else await this.save();
  }
  private async readPositions(useCache: boolean): Promise<Position[]> {
    // Public discovery is minute-paced; authenticated balances and fill receipts
    // still update managed tokens immediately after a user-stream notification.
    if (!useCache || !this.deps.venue.tokenBalance || !this.positionSnapshot || this.now() - this.positionSnapshot.at >= this.accountPollMs()) {
      const positions = await this.readRetry(() => this.deps.venue.positions(this.deps.account));
      this.positionSnapshot = { at: this.now(), positions: structuredClone(positions) };
    }
    return structuredClone(this.positionSnapshot.positions);
  }
  private async readSnapshot(usePositionCache = false): Promise<VenueSnapshot> {
    const at = this.now();
    const [positions, orders, fills] = await Promise.all([
      this.readPositions(usePositionCache),
      this.readRetry(() => this.deps.venue.openOrders(this.deps.account)),
      this.readRetry(() => this.deps.venue.tradeSettlements
        ? this.deps.venue.tradeSettlements(this.deps.account, this.fillSince())
        : this.deps.venue.fills(this.deps.account, this.fillSince())),
    ]);
    for (const position of positions) {
      if (!position.tokenId || !["YES", "NO"].includes(position.outcome ?? "") || !Number.isFinite(position.size) || position.size < 0 || !Number.isFinite(position.avgPrice) || position.avgPrice < 0 || position.avgPrice > 1) throw new Error("authoritative token inventory is invalid");
    }
    // The public positions index can trail settlement. For tokens this bot
    // owns or has traded, authenticated conditional balances are authoritative.
    // Preserve unrelated positions so reconciliation still exposes them.
    if (this.deps.venue.tokenBalance) {
      const managed = new Set([
        ...Object.values(this.checkpoint.inventory).filter((row) => row.quantity > EPSILON || positions.some((position) => position.tokenId === row.tokenId)).map((row) => row.tokenId),
        ...Object.values(this.checkpoint.orders).filter(working).map((row) => row.tokenId),
        ...fills.flatMap((fill) => { const order = this.findReceipt(fill.makerOrderId) ?? this.findReceipt(fill.orderId); return order ? [order.tokenId] : []; }),
      ]);
      const exact = await Promise.all([...managed].map(async (tokenId) => {
        const quantity = await this.readRetry(() => this.deps.venue.tokenBalance!(this.deps.account, tokenId));
        if (!Number.isFinite(quantity) || quantity < 0) throw new Error(`invalid authenticated token balance for ${tokenId}`);
        return { tokenId, quantity };
      }));
      for (const { tokenId, quantity } of exact) {
        const existing = positions.find((row) => row.tokenId === tokenId);
        if (existing) { existing.size = quantity; continue; }
        if (quantity <= EPSILON) continue;
        const order = Object.values(this.checkpoint.orders).find((row) => row.tokenId === tokenId);
        const held = this.checkpoint.inventory[tokenId];
        const market = Object.values(this.checkpoint.markets).find((row) => row.yesTokenId === tokenId || row.noTokenId === tokenId);
        if (!market) throw new Error(`managed token ${tokenId} has no durable market identity`);
        const outcome = tokenId === market.yesTokenId ? "YES" : "NO";
        positions.push({ marketRef: market.marketRef, tokenId, conditionId: market.conditionId, outcome, side: outcome,
          size: quantity, avgPrice: held?.averageCost ?? order?.limitPrice ?? 0 });
      }
    }
    if (orders.some((order) => !order.id || !order.tokenId || !order.conditionId || !["YES", "NO"].includes(order.outcome ?? "") ||
      !Number.isFinite(order.size) || order.size <= 0 || !Number.isFinite(order.filledSize) || order.filledSize < 0 || order.filledSize > order.size + EPSILON ||
      !Number.isFinite(order.price) || order.price <= 0 || order.price >= 1)) throw new Error("authoritative open order is invalid");
    // Read cash last: a confirmed fill must not be paired with a collateral
    // observation from before its token settlement. The durable cash ledger
    // below additionally catches independently lagging venue caches.
    const balances = await this.readRetry(() => this.deps.venue.balances(this.deps.account));
    const cash = balances.find((row) => /^(p?usd[cet]?|usdc)$/i.test(row.asset));
    if (!cash || !Number.isFinite(cash.total) || cash.total < 0) throw new Error("authoritative collateral balance is invalid");
    return { at, collateralUsd: cash.total, positions, orders, fills };
  }
  private findReceipt(id?: string): Receipt | undefined {
    return id ? this.checkpoint.orders[id] ?? Object.values(this.checkpoint.orders).find((row) => row.venueId === id) : undefined;
  }
  private hasUnknown(): boolean {
    return Object.values(this.checkpoint.orders).some((order) => ["SIGNED", "UNKNOWN"].includes(order.status));
  }
  private pendingRedemption(): boolean {
    return Object.values(this.checkpoint.redemptions ?? {}).some((row) => row.status !== "CONFIRMED");
  }
  private fillSince(): number {
    const oldest = Math.min(...Object.values(this.checkpoint.orders).filter(working).map((row) => row.createdAt), Number.POSITIVE_INFINITY);
    return Math.max(0, Math.min(this.checkpoint.fillCursor - FILL_OVERLAP_MS, oldest - FILL_OVERLAP_MS));
  }
  private async applySnapshot(snapshot: VenueSnapshot, adopt = false): Promise<void> {
    this.lastSnapshot = snapshot;
    this.checkpoint.confirmedCollateralUsd ??= this.checkpoint.collateralUsd;
    for (const fill of snapshot.fills.sort((a, b) => a.ts - b.ts)) {
      const id = fillIdentity(fill);
      if (this.checkpoint.fillIds[id] !== undefined) continue;
      const order = this.findReceipt(fill.makerOrderId) ?? this.findReceipt(fill.orderId);
      if (!order) { if (!fill.settlementStatus || fill.settlementStatus === "CONFIRMED") { this.checkpoint.fillIds[id] = fill.ts; this.checkpoint.fillCursor = Math.max(this.checkpoint.fillCursor, fill.ts); } continue; }
      const quantity = fill.matchedAmountDelta ?? fill.size;
      if (!Number.isFinite(quantity) || !(quantity > 0) || !Number.isFinite(fill.price) || fill.price <= 0 || fill.price >= 1 ||
        !Number.isFinite(fill.fee ?? 0) || (fill.fee ?? 0) < 0 ||
        fill.tokenId !== order.tokenId || fill.side !== order.side || fill.outcome !== order.outcome ||
        quantity > order.size + EPSILON) throw new Error(`invalid fill identity or quantity for ${order.clientId}`);
      const priorSettlement = this.checkpoint.settlements?.[id];
      if (priorSettlement && (Math.abs(priorSettlement.quantity - quantity) > EPSILON || Math.abs(priorSettlement.price - fill.price) > EPSILON)) {
        throw new Error(`settlement terms changed for ${id}`);
      }
      if (priorSettlement?.status === "FAILED") {
        if (fill.settlementStatus !== "FAILED") throw new Error(`terminal failed settlement changed status for ${id}`);
        continue;
      }
      if (fill.settlementStatus && fill.settlementStatus !== "CONFIRMED") {
        this.checkpoint.settlements ??= {};
        const previous = this.checkpoint.settlements[id];
        this.checkpoint.settlements[id] = { orderId: order.clientId, status: fill.settlementStatus, quantity, price: fill.price, ts: fill.ts };
        order.observedFilled = Math.max(order.observedFilled ?? 0, order.filled + quantity);
        if (fill.settlementStatus === "FAILED" && previous?.status !== "FAILED") order.failedFilled = (order.failedFilled ?? 0) + quantity;
        continue;
      }
      if (this.checkpoint.settlements?.[id]) delete this.checkpoint.settlements[id];
      if (order.filled + quantity > order.size + EPSILON) throw new Error(`confirmed fill exceeds order ${order.clientId}`);
      this.checkpoint.fillIds[id] = fill.ts;
      this.checkpoint.fillCursor = Math.max(this.checkpoint.fillCursor, fill.ts);
      order.filled += quantity;
      order.firstFillAt = Math.min(order.firstFillAt ?? fill.ts, fill.ts);
      this.checkpoint.lastTradingAt = this.now();
      order.updatedAt = this.now();
      if (remaining(order) <= EPSILON) order.status = "FILLED";
      const held = this.checkpoint.inventory[order.tokenId] ?? {
        tokenId: order.tokenId, marketKey: order.marketKey, outcome: order.outcome, quantity: 0, averageCost: 0, firstHeldAt: fill.ts,
      };
      if (order.side === "BUY") {
        this.checkpoint.confirmedCollateralUsd -= quantity * fill.price + (fill.fee ?? 0);
        if (held.quantity <= EPSILON) {
          held.firstHeldAt = fill.ts;
          const forecast = order.entryForecast;
          held.initialEdgePp = forecast ? ((order.outcome === "YES" ? forecast.qYes : 1 - forecast.qYes) - fill.price) * 100 : undefined;
          held.qBacked = held.initialEdgePp === undefined ? undefined : held.initialEdgePp >= this.config.exit_policy.same_side_refresh_min_edge_to_hold_pp;
          held.exitReason = undefined;
        }
        held.averageCost = (held.quantity * held.averageCost + quantity * fill.price + (fill.fee ?? 0)) / (held.quantity + quantity);
        held.quantity += quantity;
      } else {
        if (quantity > held.quantity + EPSILON) throw new Error(`SELL fill exceeds tracked inventory for ${order.clientId}`);
        this.checkpoint.realizedPnlUsd = (this.checkpoint.realizedPnlUsd ?? 0) + quantity * (fill.price - held.averageCost) - (fill.fee ?? 0);
        this.checkpoint.confirmedCollateralUsd += quantity * fill.price - (fill.fee ?? 0);
        held.quantity = Math.max(0, held.quantity - quantity);
      }
      this.checkpoint.inventory[order.tokenId] = held;
      this.log.info("two-sided fill", { orderId: order.venueId, marketKey: order.marketKey, side: order.side, outcome: order.outcome, size: quantity, price: fill.price });
    }
    const present = new Set(snapshot.orders.map((order) => order.id));
    this.unsettledOrders.clear();
    for (const settlement of Object.values(this.checkpoint.settlements ?? {})) {
      if (!["CONFIRMED", "FAILED"].includes(settlement.status)) this.unsettledOrders.add(settlement.orderId);
    }
    for (const order of Object.values(this.checkpoint.orders).filter(working)) {
      if (order.status === "RESERVED") { order.status = "REJECTED"; continue; }
      const venueOrder = order.venueId ? snapshot.orders.find((row) => row.id === order.venueId) : undefined;
      if (venueOrder) {
        if (venueOrder.tokenId !== order.tokenId || venueOrder.side !== order.side || venueOrder.outcome !== order.outcome ||
          venueOrder.conditionId !== order.conditionId || Math.abs(venueOrder.price - order.limitPrice) > EPSILON || Math.abs(venueOrder.size - order.size) > EPSILON) {
          order.status = "UNKNOWN";
          order.error = "venue order differs from exact prepared terms";
          continue;
        }
        order.absentSince = undefined;
        order.absentCount = 0;
        order.observedFilled = Math.max(order.observedFilled ?? 0, venueOrder.filledSize);
        if (order.observedFilled > order.filled + (order.failedFilled ?? 0) + EPSILON) this.unsettledOrders.add(order.clientId);
        if (order.status !== "CANCEL_PENDING") order.status = "OPEN";
      } else {
        order.absentSince ??= snapshot.at;
        order.absentCount = (order.absentCount ?? 0) + 1;
        if (!order.venueId && ["SIGNED", "UNKNOWN"].includes(order.status)) continue;
        if ((order.observedFilled ?? 0) > order.filled + (order.failedFilled ?? 0) + EPSILON || this.unsettledOrders.has(order.clientId)) { this.unsettledOrders.add(order.clientId); continue; }
        if (order.cancelRequestedAt !== undefined && snapshot.at - order.cancelRequestedAt >= SETTLEMENT_DELAY_MS && order.absentCount >= 2) {
          order.status = remaining(order) <= EPSILON ? "FILLED" : "CANCELED";
          order.updatedAt = this.now();
        } else if (order.venueId && order.absentCount >= 2 && snapshot.at - order.createdAt >= 5_000) {
          await this.cancel(order, "known order disappeared from authoritative open orders");
        }
      }
    }
    if (adopt) {
      this.checkpoint.confirmedCollateralUsd = snapshot.collateralUsd;
      const priorInventory = this.checkpoint.inventory;
      this.checkpoint.inventory = {};
      for (const position of snapshot.positions) {
        if (!(position.size > EPSILON)) continue;
        const market = Object.values(this.checkpoint.markets).find((row) => row.yesTokenId === position.tokenId || row.noTokenId === position.tokenId);
        const previous = priorInventory[position.tokenId!];
        const sameCycle = previous && previous.quantity > EPSILON && previous.outcome === position.outcome && previous.marketKey === market?.marketKey;
        const receipts = Object.values(this.checkpoint.orders).filter((row) => row.tokenId === position.tokenId && row.filled > EPSILON);
        const buys = receipts.filter((row) => row.side === "BUY");
        const accounted = receipts.reduce((sum, row) => sum + (row.side === "BUY" ? row.filled : -row.filled), 0);
        // Repair the legacy adoption-clock reset only when one durable BUY and
        // its sells fully explain this holding. Order creation is a conservative
        // lower bound when the older receipt did not retain its first fill time.
        const provenEntry = buys.length === 1 && Math.abs(accounted - position.size) < EPSILON
          ? buys[0]!.firstFillAt ?? buys[0]!.createdAt : undefined;
        // A reviewed reconciliation updates quantities, not the original thesis
        // clock. Unknown imported holdings get no invented Q-entry evidence.
        this.checkpoint.inventory[position.tokenId!] = {
          ...(sameCycle ? previous : {}),
          tokenId: position.tokenId!, marketKey: market?.marketKey ?? `unmanaged:${position.conditionId ?? position.tokenId}`,
          outcome: position.outcome as "YES" | "NO", quantity: position.size, averageCost: position.avgPrice,
          firstHeldAt: Math.min(sameCycle ? previous.firstHeldAt : this.now(), provenEntry ?? this.now()),
        };
      }
    }
    this.unsettledTokens.clear();
    const positionQuantities = new Map(snapshot.positions.map((position) => [position.tokenId!, position.size]));
    for (const redemption of Object.values(this.checkpoint.redemptions ?? {})) {
      if (adopt &&
        redemption.tokenIds.every((tokenId) => (positionQuantities.get(tokenId) ?? 0) <= EPSILON)) {
        for (const tokenId of redemption.tokenIds) if (this.checkpoint.inventory[tokenId]) this.checkpoint.inventory[tokenId]!.quantity = 0;
        redemption.status = "CONFIRMED";
        redemption.operatorRequired = false;
      }
    }
    for (const tokenId of new Set([...Object.keys(this.checkpoint.inventory), ...positionQuantities.keys()])) {
      if (Math.abs((this.checkpoint.inventory[tokenId]?.quantity ?? 0) - (positionQuantities.get(tokenId) ?? 0)) > EPSILON) this.unsettledTokens.add(tokenId);
    }
    this.checkpoint.collateralUnsettled = Math.abs(snapshot.collateralUsd - this.checkpoint.confirmedCollateralUsd) > CASH_TOLERANCE_USD;
    this.checkpoint.collateralUsd = Math.max(0, Math.min(snapshot.collateralUsd, this.checkpoint.confirmedCollateralUsd));
    if (!this.checkpoint.collateralUnsettled) this.checkpoint.confirmedCollateralUsd = snapshot.collateralUsd;
    const foreign = snapshot.orders.filter((order) => !this.findReceipt(order.id));
    if (this.checkpoint.active && foreign.length > 0) await this.failClosed("unexpected external orders require reviewed reconciliation");
    if (this.checkpoint.active && this.hasUnknown()) await this.failClosed("an ambiguous prepared order requires reconciliation");
    for (const order of Object.values(this.checkpoint.orders)) {
      if (order.status === "CANCEL_PENDING" && order.venueId && present.has(order.venueId)) await this.cancel(order, "retry pending cancellation");
    }
    this.checkpoint.lastReconciledAt = snapshot.at;
    this.checkpoint.initialEquityUsd ??= snapshot.collateralUsd + Object.values(this.checkpoint.inventory).reduce((sum, row) => sum + row.quantity * row.averageCost, 0);
    this.checkpoint.highWaterUsd ??= this.checkpoint.initialEquityUsd;
    await this.save();
  }

  private proposal(snapshot: VenueSnapshot): TwoSidedReconcileResult {
    const unknown = snapshot.orders.filter((order) => !this.findReceipt(order.id));
    const ambiguous = Object.values(this.checkpoint.orders).filter((row) => ["SIGNED", "UNKNOWN"].includes(row.status));
    const economic = {
      configHash: this.configHash,
      deploymentId: this.options.deploymentId,
      collateral: snapshot.collateralUsd,
      positions: snapshot.positions.map((row) => [row.tokenId, row.size, row.avgPrice]).sort(),
      orders: snapshot.orders.map((row) => [row.id, row.tokenId, row.side, row.size, row.filledSize, row.price]).sort(),
      unknown: unknown.map((row) => row.id).sort(),
      ambiguous: ambiguous.map((row) => [row.clientId, row.preparedHash, row.size, row.limitPrice]).sort(),
      fills: snapshot.fills.map((row) => [fillIdentity(row), row.tokenId, row.side, row.size, row.matchedAmountDelta, row.price, row.settlementStatus ?? "CONFIRMED"]).sort(),
      ownership: Object.values(this.checkpoint.orders).filter(working).map((row) => [row.clientId, row.venueId, row.status, row.size, row.filled]).sort(),
      redemptions: Object.values(this.checkpoint.redemptions ?? {}).map((row) => [row.conditionId, row.status, row.operatorRequired, row.tokenIds]).sort(),
    };
    return {
      at: snapshot.at, applied: false, balances: 1, positions: snapshot.positions.length,
      openOrders: snapshot.orders.length, fills: snapshot.fills.length, unknownOrders: unknown.length + ambiguous.length,
      canceledUnknownOrders: 0, books: 0, proposalHash: digest(economic),
      proposals: {
        unknownOrdersToCancel: [...unknown.map((row) => ({ venueOrderId: row.id, tokenId: row.tokenId, side: row.side, remainingQuantity: row.size - row.filledSize, limitPrice: row.price })), ...ambiguous.map((row) => ({ venueOrderId: row.venueId, clientOrderId: row.clientId, tokenId: row.tokenId, side: row.side, remainingQuantity: remaining(row), limitPrice: row.limitPrice }))],
        residualInventory: snapshot.positions,
        inventoryApplication: { mode: "authoritative-token-balances", note: "Apply adopts both outcome balances and cancels the listed unowned orders; activation remains explicit." },
      },
    };
  }
  reconcile(options: { apply?: boolean; expectedProposalHash?: string } = {}): Promise<TwoSidedReconcileResult> {
    return this.serialized(async () => {
      const snapshot = await this.readSnapshot();
      const result = this.proposal(snapshot);
      if (!options.apply) return result;
      if (this.checkpoint.active) throw new Error("halt two-sided quoting before applying reviewed reconciliation");
      if (!options.expectedProposalHash || options.expectedProposalHash !== result.proposalHash) throw new Error("reconciliation apply requires the unchanged proposal hash from a fresh preview");
      for (const row of result.proposals.unknownOrdersToCancel) {
        if (row.venueOrderId) await this.deps.venue.cancelOrder(this.deps.account, row.venueOrderId);
        else await this.deps.venue.cancelAll(this.deps.account);
        result.canceledUnknownOrders += 1;
      }
      let verified = snapshot;
      if (result.canceledUnknownOrders > 0) {
        const canceledAt = this.now();
        let clean = 0;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          verified = await this.readSnapshot();
          clean = verified.orders.length === 0 ? clean + 1 : 0;
          if (clean >= 2 && this.now() - canceledAt >= SETTLEMENT_DELAY_MS) break;
        }
        if (verified.orders.length > 0 || this.now() - canceledAt < SETTLEMENT_DELAY_MS || clean < 2) throw new Error("reviewed cancellation is still settling; retry reconciliation after authenticated order absence");
        for (const row of Object.values(this.checkpoint.orders)) {
          if (["SIGNED", "UNKNOWN"].includes(row.status)) { row.status = "CANCELED"; row.updatedAt = this.now(); }
        }
      }
      await this.recoverCatalogs(verified.positions);
      await this.applySnapshot(verified, true);
      this.checkpoint.approved = true;
      await this.save();
      return { ...result, applied: true };
    });
  }
  resume(options: { acknowledgeLossReset?: boolean } = {}) {
    return this.serialized(async () => {
      if (!this.started || !this.checkpoint.approved) throw new Error("review and apply reconciliation before resuming this deployment");
      await this.applySnapshot(await this.readSnapshot());
      if (this.lastSnapshot!.orders.some((row) => !this.findReceipt(row.id))) throw new Error("cannot resume with unowned venue orders; review reconciliation first");
      if (this.hasUnknown() || Object.values(this.checkpoint.orders).some((row) => row.status === "CANCEL_PENDING")) throw new Error("cannot resume while order submission or cancellation is unresolved");
      if (this.unsettledTokens.size > 0 || this.unsettledOrders.size > 0 || this.checkpoint.collateralUnsettled) throw new Error("cannot resume while fills, cash, and token balances disagree");
      if (this.pendingRedemption()) throw new Error("resolved inventory requires redemption settlement or operator recovery before resuming");
      if (this.checkpoint.lossLatched && !options.acknowledgeLossReset) throw new Error("loss stop requires explicit acknowledgement");
      if (options.acknowledgeLossReset) {
        this.checkpoint.lossLatched = false;
        this.checkpoint.initialEquityUsd = this.markedEquityUsd ?? this.status().strategyCapitalUsd;
        this.checkpoint.highWaterUsd = this.checkpoint.initialEquityUsd;
        this.checkpoint.equityHistory = [{ ts: this.now(), equity: this.checkpoint.initialEquityUsd }];
      }
      this.checkpoint.active = true;
      this.checkpoint.recoverablePause = false;
      this.checkpoint.reduceOnly = false;
      this.checkpoint.haltReason = undefined;
      await this.save();
      await this.quoteCycle();
      return this.status();
    });
  }
  halt(options: { liquidate?: boolean } = {}) {
    return this.serialized(async () => {
      this.safetyGeneration += 1;
      this.checkpoint.active = false;
      this.checkpoint.recoverablePause = false;
      this.checkpoint.reduceOnly = options.liquidate ?? false;
      this.checkpoint.haltReason = options.liquidate ? "operator halt; passive inventory reduction requested" : "operator halt";
      await this.save();
      await this.cancelWorking("operator halt");
      if (options.liquidate) await this.quoteCycle(true);
      return this.status();
    });
  }

  tick(options: { scheduled?: boolean } = {}) {
    return this.serialized(async () => {
      try {
        if (!this.started) throw new Error("two-sided controller is not started");
        if (this.venueCoolingDown()) {
          if (this.checkpoint.active) await this.pauseForVenue(Object.assign(new Error(this.checkpoint.venueRetry!.reason), { name: "VenueCooldownError" }));
          return this.emptyTick();
        }
        if (options.scheduled && !this.checkpoint.venueRetry && this.lastSnapshot && this.now() - this.lastSnapshot.at < this.accountPollMs()) return this.emptyTick();
        if (!this.checkpoint.approved) { this.lastSnapshot = await this.readSnapshot(true); this.checkpoint.venueRetry = undefined; await this.save(); return this.emptyTick(); }
        await this.applySnapshot(await this.readSnapshot(true));
        await this.handleResolvedInventory();
        if (this.checkpoint.recoverablePause && !this.checkpoint.lossLatched && !this.hasUnknown() && !this.pendingRedemption() && !this.checkpoint.collateralUnsettled &&
          this.unsettledOrders.size === 0 && this.unsettledTokens.size === 0 &&
          Object.values(this.checkpoint.orders).every((row) => !working(row)) && this.lastSnapshot!.orders.length === 0) {
          this.checkpoint.active = true;
          this.checkpoint.recoverablePause = false;
          this.checkpoint.haltReason = undefined;
          await this.save();
          this.log.info("two-sided quoting automatically recovered after clean venue reconciliation");
        }
        const actions = this.checkpoint.active || this.checkpoint.reduceOnly ? await this.quoteCycle(this.checkpoint.reduceOnly) : 0;
        this.lastTickAt = this.now();
        if (!this.venueCoolingDown()) { this.checkpoint.venueRetry = undefined; this.lastError = undefined; await this.save(); }
        if (!this.venueCoolingDown()) await this.startSubscriptions();
        return { ...this.emptyTick(), actions };
      } catch (error) {
        this.lastError = String(error);
        if (transientVenueError(error)) { await this.pauseForVenue(error); return this.emptyTick(); }
        await this.failClosed(`venue supervision unavailable: ${String(error)}`);
        throw error;
      }
    });
  }
  private emptyTick() { return { at: this.now(), signals: 0, exactForecasts: 0, catalogs: this.candidates.length, books: this.lastPlans.length * 2, fills: 0, actions: 0, decisions: this.lastPlans.length }; }
  private async handleResolvedInventory(): Promise<void> {
    if (!this.checkpoint.approved || !this.lastSnapshot) return;
    for (const position of this.lastSnapshot.positions.filter((row) => row.redeemable && row.size > EPSILON && row.conditionId)) {
      const market = Object.values(this.checkpoint.markets).find((row) => row.conditionId === position.conditionId);
      if (!market) continue;
      this.checkpoint.redemptions ??= {};
      const redemption = this.checkpoint.redemptions[market.conditionId] ??= {
        marketKey: market.marketKey, conditionId: market.conditionId, tokenIds: [market.yesTokenId, market.noTokenId],
        status: "WAITING_ORDERS", requestedAt: this.now(), operatorRequired: false,
      };
      if (redemption.status !== "WAITING_ORDERS") continue;
      const workingOrders = Object.values(this.checkpoint.orders).filter((order) => working(order) && order.marketKey === market.marketKey);
      if (workingOrders.length > 0) { for (const order of workingOrders) await this.cancel(order, "market resolved; drain quotes before redemption"); continue; }
      if (this.unsettledOrders.size || this.unsettledTokens.size) continue;
      redemption.status = "UNKNOWN";
      redemption.requestedAt = this.now();
      redemption.operatorRequired = true;
      redemption.error = "resolved inventory requires local redemption authority and reviewed reconciliation; runtime trade credentials cannot redeem";
      this.checkpoint.reduceOnly = this.checkpoint.active || this.checkpoint.reduceOnly === true;
      await this.save();
      await this.failClosed(redemption.error);
    }
  }
  private async recoverCatalogs(positions: Position[]): Promise<void> {
    for (const position of positions.filter((row) => row.size > EPSILON)) {
      if (Object.values(this.checkpoint.markets).some((row) => row.yesTokenId === position.tokenId || row.noTokenId === position.tokenId)) continue;
      if (!this.deps.catalog.recover) throw new Error(`cannot identify held token ${position.tokenId}`);
      const recovered = await this.deps.catalog.recover({ conditionId: position.conditionId, clobTokenId: position.tokenId });
      if (!recovered) throw new Error(`cannot recover held token ${position.tokenId}`);
      this.checkpoint.markets[recovered.marketKey] = recovered.catalog;
    }
  }
  private async discover(): Promise<void> {
    if (this.candidates.length > 0 && this.now() - this.discoveryAt < 60_000) return;
    if (this.deps.catalog.activeMarkets) this.candidates = await this.deps.catalog.activeMarkets({ limit: 100 });
    else if (this.deps.quotient) {
      const rows = await this.deps.quotient.activeSignals(100);
      this.candidates = (await Promise.all(rows.map((row) => this.deps.catalog.market(row.marketKey, row.nativeMarketId, row.conditionId).catch(() => undefined))))
        .filter((row): row is PolymarketMarketCatalog => row !== undefined);
    } else this.candidates = Object.values(this.checkpoint.markets);
    if (this.config.two_sided?.adaptive && this.deps.quotient) await this.includeAdaptiveSignalMarkets();
    this.discoveryAt = this.now();
    for (const market of Object.values(this.checkpoint.markets)) {
      const refreshed = this.candidates.find((row) => row.marketKey === market.marketKey);
      if (refreshed) this.checkpoint.markets[market.marketKey] = refreshed;
      else {
        try { this.checkpoint.markets[market.marketKey] = await this.deps.catalog.market(market.marketKey, market.nativeMarketId, market.conditionId); }
        catch (error) { this.log.warn("two-sided market metadata refresh failed", { marketKey: market.marketKey, error: String(error) }); }
      }
    }
  }
  private async includeAdaptiveSignalMarkets(): Promise<void> {
    const policy = this.config.two_sided!.adaptive!;
    if (this.now() - this.signalDiscoveryAt >= policy.forecast_refresh_seconds * 1_000) {
      this.signalDiscoveryAt = this.now();
      try { this.signalRows = await this.deps.quotient!.activeSignals(100); }
      catch (error) {
        const retry = typeof error === "object" && error !== null && "retryAfterMs" in error ? Number(error.retryAfterMs) : 0;
        if (Number.isFinite(retry)) this.signalDiscoveryAt += Math.max(0, retry - policy.forecast_refresh_seconds * 1_000);
        this.log.warn("adaptive signal discovery unavailable; retaining existing market universe");
      }
    }
    const active = this.signalRows.filter((row) => row.isActive && row.marketKey.startsWith("polymarket:") && !row.suppressionReason);
    const activeKeys = new Set(active.map((row) => row.marketKey));
    for (const key of this.signalCatalogs.keys()) if (!activeKeys.has(key)) this.signalCatalogs.delete(key);
    for (const key of this.signalCatalogAttempts.keys()) if (!activeKeys.has(key)) this.signalCatalogAttempts.delete(key);
    const needed = active.filter((row) => !this.candidates.some((market) => market.marketKey === row.marketKey)
      && this.now() - (this.signalCatalogAttempts.get(row.marketKey) ?? Number.NEGATIVE_INFINITY) >= policy.forecast_refresh_seconds * 1_000)
      .sort((a, b) => (this.signalCatalogAttempts.get(a.marketKey) ?? Number.NEGATIVE_INFINITY)
        - (this.signalCatalogAttempts.get(b.marketKey) ?? Number.NEGATIVE_INFINITY)).slice(0, 5);
    await Promise.all(needed.map(async (row) => {
      this.signalCatalogAttempts.set(row.marketKey, this.now());
      try {
        const market = await this.deps.catalog.market(row.marketKey, row.nativeMarketId, row.conditionId);
        if (market.marketKey === row.marketKey && market.conditionId === row.conditionId) this.signalCatalogs.set(row.marketKey, market);
      } catch { /* Other signals and held markets continue through a metadata failure. */ }
    }));
    this.candidates = [...this.candidates, ...this.signalCatalogs.values()]
      .filter((row, index, all) => all.findIndex((candidate) => candidate.marketKey === row.marketKey) === index)
      .sort((a, b) => Number(activeKeys.has(b.marketKey)) - Number(activeKeys.has(a.marketKey)) || b.volume24hUsd - a.volume24hUsd);
    // The signal feed already paid for these exact forecasts. Reuse them only
    // after venue identity is matched; a repeated observation is not a revision.
    this.checkpoint.forecasts ??= {};
    for (const row of active) {
      const market = this.candidates.find((candidate) => candidate.marketKey === row.marketKey && candidate.conditionId === row.conditionId);
      const at = Date.parse(row.forecastAt);
      const previous = this.checkpoint.forecasts[row.marketKey];
      if (!market || !Number.isFinite(at) || at > this.now() + policy.clock_skew_seconds * 1_000
        || !Number.isFinite(row.qYes) || row.qYes < 0 || row.qYes > 1 || (previous?.value && at <= previous.value.forecastAt)) continue;
      this.checkpoint.forecasts[row.marketKey] = {
        value: { marketKey: row.marketKey, qYes: row.qYes, forecastAt: at, forecastStatus: row.forecastStatus.state,
          drawdownRiskElevated: row.forecastStatus.drawdownRiskElevated }, fetchedAt: this.now(),
        nextAttemptAt: this.now() + policy.forecast_refresh_seconds * 1_000, failures: 0,
      };
    }
  }
  private async plans(inventory = this.checkpoint.inventory): Promise<Array<{ market: PolymarketMarketCatalog; plan: TwoSidedPlan }>> {
    await this.discover();
    const config = this.effectiveConfig();
    const requiredKeys = new Set([
      ...Object.values(inventory).filter((row) => row.quantity > EPSILON).map((row) => row.marketKey),
      ...Object.values(this.checkpoint.orders).filter(working).map((row) => row.marketKey),
    ]);
    let ordered = [...Object.values(this.checkpoint.markets).filter((row) => requiredKeys.has(row.marketKey)), ...this.candidates]
      .filter((row, index, all) => all.findIndex((candidate) => candidate.marketKey === row.marketKey) === index);
    if (config.two_sided?.adaptive) {
      // Spend and research cadence are independent of fast executable-book reads.
      // One bounded batch per live cycle; a preview can load the whole shortlist.
      await this.refreshAdaptiveForecasts(ordered, requiredKeys);
      ordered = ordered.filter((market) => requiredKeys.has(market.marketKey) || this.checkpoint.forecasts?.[market.marketKey]?.value);
    }
    const result: Array<{ market: PolymarketMarketCatalog; plan: TwoSidedPlan }> = [];
    const target = Math.min(config.two_sided!.target_markets, config.capital.max_active_markets);
    const representedEvents = new Set(Object.values(this.checkpoint.markets).filter((row) => requiredKeys.has(row.marketKey)).map((row) => row.eventId));
    const selectionOrders = Object.values(this.checkpoint.orders).filter(working).map((row) => structuredClone(row));
    for (const market of ordered) {
      if (!requiredKeys.has(market.marketKey) && result.filter((row) => row.plan.quotes.length > 0).length >= target) continue;
      if (!requiredKeys.has(market.marketKey) && representedEvents.has(market.eventId)) continue;
      try {
        const [yesBook, noBook] = await Promise.all([
          this.readRetry(() => this.deps.venue.tokenBook!(market.yesTokenId)),
          this.readRetry(() => this.deps.venue.tokenBook!(market.noTokenId)),
        ]);
        const now = this.now();
        if ([yesBook, noBook].some((book) => now - book.ts > config.market_data.market_data_stale_seconds * 1_000 || book.ts - now > config.global_kill_switches.max_clock_skew_seconds * 1_000)) throw new Error("stale or clock-skewed order book");
        const plan = this.planMarket(market, yesBook, noBook, inventory);
        if (!requiredKeys.has(market.marketKey) && plan.quotes.length > 0) {
          const capped = this.capPair(plan.quotes, selectionOrders);
          if (selectionOrders.length + capped.length > config.capital.max_live_orders) capped.length = 0;
          plan.quotes = capped;
          if (capped.length === 0) { plan.eligible = false; plan.reasons.push("portfolio-quote-capacity-unavailable"); }
          for (const quote of capped) selectionOrders.push({ ...quote, clientId: `selection:${market.marketKey}:${quote.lane}`, status: "RESERVED", filled: 0, createdAt: now, updatedAt: now });
        }
        result.push({ market, plan });
        if (plan.quotes.length > 0) representedEvents.add(market.eventId);
      } catch (error) {
        if (transientVenueError(error)) throw error;
        if (requiredKeys.has(market.marketKey)) {
          for (const order of Object.values(this.checkpoint.orders).filter((row) => working(row) && row.marketKey === market.marketKey)) {
            // A failed preview never changes live orders.
            if (this.inLiveQuoteCycle) await this.cancel(order, `market data unavailable: ${String(error)}`);
          }
        }
        this.log.warn("two-sided candidate unavailable", { marketKey: market.marketKey, error: String(error) });
      }
    }
    return result;
  }
  private inLiveQuoteCycle = false;
  private planningReduceOnly = false;
  private async refreshAdaptiveForecasts(markets: PolymarketMarketCatalog[], required: Set<string>): Promise<void> {
    const policy = this.config.two_sided?.adaptive;
    if (!policy || !this.deps.quotient?.exactForecasts) return;
    this.checkpoint.forecasts ??= {};
    const cache = this.checkpoint.forecasts;
    const now = this.now();
    const optional = markets.filter((row) => !required.has(row.marketKey)
      && row.active && !row.closed && row.acceptingOrders
      && row.volume24hUsd >= this.config.two_sided!.minimum_volume_24h_usd);
    // Rotate previously unqueried candidates through the same bounded cache;
    // a missing Q on the highest-volume markets must not starve the rest.
    optional.sort((a, b) => (cache[a.marketKey]?.nextAttemptAt ?? 0) - (cache[b.marketKey]?.nextAttemptAt ?? 0)
      || b.volume24hUsd - a.volume24hUsd || a.marketKey.localeCompare(b.marketKey));
    const selected = [...markets.filter((row) => required.has(row.marketKey)), ...optional.slice(0, policy.max_forecast_candidates)];
    const due = selected.filter((row) => !Number.isFinite(cache[row.marketKey]?.nextAttemptAt) || cache[row.marketKey]!.nextAttemptAt <= now);
    const batchLimit = this.started ? 10 : policy.max_forecast_candidates + required.size;
    const keys = [...new Set(due.map((row) => row.marketKey))].slice(0, batchLimit);
    for (let offset = 0; offset < keys.length; offset += 10) {
      const batch = keys.slice(offset, offset + 10);
      try {
        const rows = await this.deps.quotient.exactForecasts(batch);
        const fetchedAt = this.now();
        for (const key of batch) {
          const prior = cache[key];
          const incoming = rows.filter((row) => row.marketKey === key).sort((a, b) => Date.parse(b.forecastAt) - Date.parse(a.forecastAt))[0];
          const at = incoming ? Date.parse(incoming.forecastAt) : Number.NaN;
          const acceptable = incoming && Number.isFinite(at) && at <= fetchedAt + policy.clock_skew_seconds * 1_000
            && Number.isFinite(incoming.qYes) && incoming.qYes >= 0 && incoming.qYes <= 1
            && (!prior?.value || at >= prior.value.forecastAt);
          cache[key] = {
            ...prior, nextAttemptAt: fetchedAt + policy.forecast_refresh_seconds * 1_000, failures: 0,
            ...(acceptable ? { fetchedAt, value: {
              marketKey: key, qYes: incoming.qYes, forecastAt: at,
              forecastStatus: incoming.retiredReason === "resolved" || incoming.retiredReason === "fading_q" ? "warning" : incoming.forecastStatus.state,
              drawdownRiskElevated: incoming.forecastStatus.drawdownRiskElevated,
            } } : {}),
          };
        }
      } catch (error) {
        for (const key of batch) {
          const prior = cache[key];
          const failures = (prior?.failures ?? 0) + 1;
          const retryAfter = typeof error === "object" && error !== null && "retryAfterMs" in error ? Number(error.retryAfterMs) : 0;
          const backoff = Math.max(Math.min(900_000, 30_000 * 2 ** Math.min(failures - 1, 5)), Number.isFinite(retryAfter) ? retryAfter : 0);
          cache[key] = { ...prior, failures, nextAttemptAt: this.now() + backoff };
        }
        // Keep supervised exits and still-usable last-good Q. Do not persist raw
        // response/error bodies, credentials, or an invented new forecast time.
        this.log.warn("adaptive forecast refresh unavailable; retaining last-good forecast", { markets: batch.length });
      }
      if (this.started) await this.save();
    }
    const keep = new Set([...required, ...markets.map((row) => row.marketKey)]);
    for (const key of Object.keys(cache)) if (!keep.has(key)) delete cache[key];
    for (const key of this.movement.keys()) if (!keep.has(key)) this.movement.delete(key);
  }
  private planMarket(market: PolymarketMarketCatalog, yesBook: OrderBook, noBook: OrderBook, inventory = this.checkpoint.inventory): TwoSidedPlan {
    const config = this.effectiveConfig();
    const now = this.now();
    const input = {
      market, yesBook: { ...this.externalBook(yesBook, market.yesTokenId), tokenId: market.yesTokenId },
      noBook: { ...this.externalBook(noBook, market.noTokenId), tokenId: market.noTokenId },
      inventory: { yesQuantity: inventory[market.yesTokenId]?.quantity ?? 0, noQuantity: inventory[market.noTokenId]?.quantity ?? 0,
        yesAverageCost: inventory[market.yesTokenId]?.averageCost, noAverageCost: inventory[market.noTokenId]?.averageCost },
      now, baseOrderUsd: config.capital.base_order_notional_usd, maxOrderUsd: config.capital.max_order_notional_usd,
      maxMarketUsd: config.capital.hard_market_cost_usd, minimumSecondsToEnd: config.market_catalog.minimum_seconds_to_end_at_entry,
      policy: config.two_sided!,
    };
    const policy = config.two_sided?.adaptive;
    if (!policy) return planTwoSidedQuotes(input);
    let movement: AdaptiveMovement | undefined;
    const bid = Math.max(...input.yesBook.bids.map((row) => row.price), 0);
    const ask = Math.min(...input.yesBook.asks.map((row) => row.price), 1);
    if (bid > 0 && ask < 1 && bid < ask && now - yesBook.ts <= policy.book_max_age_seconds * 1_000 && yesBook.ts <= now + policy.clock_skew_seconds * 1_000) {
      const mid = (bid + ask) / 2;
      const cutoff = now - policy.movement_window_seconds * 1_000;
      const history = (this.movement.get(market.marketKey) ?? []).filter((row) => row.at >= cutoff && row.at <= now);
      const reference = history[0];
      if (reference) movement = { observedAt: now, referenceAt: reference.at, referenceYesMid: reference.mid, yesMid: mid };
      if (!history.length || now - history.at(-1)!.at >= 5_000) history.push({ at: now, mid });
      this.movement.set(market.marketKey, history.slice(-121));
    }
    // Preserve Q-supported surplus until convergence, invalidation or its original
    // holding deadline. Complete sets retain bounded spread recycling; forced
    // reductions still sell only unmatched shares.
    const delta = input.inventory.yesQuantity - input.inventory.noQuantity;
    const held = delta > EPSILON ? inventory[market.yesTokenId] : delta < -EPSILON ? inventory[market.noTokenId] : undefined;
    const forced = this.planningReduceOnly || this.checkpoint.reduceOnly || this.checkpoint.lossLatched;
    const plan = planAdaptiveQuotes(input, this.checkpoint.forecasts?.[market.marketKey]?.value, movement, {
      firstHeldAt: held?.firstHeldAt, initialEdgePp: held?.initialEdgePp, qBacked: held?.qBacked,
      maximumHoldSeconds: config.exit_policy.default_hard_hold_seconds,
      minimumHoldEdgePp: config.exit_policy.same_side_refresh_min_edge_to_hold_pp,
      remainingEdgeExitPp: config.exit_policy.remaining_live_q_edge_exit_pp,
      capturedGapFraction: config.exit_policy.captured_initial_gap_fraction_exit,
      forceReduceReason: forced ? "adaptive-inventory-risk-reduction" : held?.exitReason,
    });
    if (this.inLiveQuoteCycle && held) {
      if (plan.context.adaptive?.inventoryAction === "hold") held.qBacked = true;
      const reason = plan.context.adaptive?.inventoryReason;
      if (reason && ["adaptive-inventory-q-invalidated", "adaptive-inventory-converged", "adaptive-inventory-gap-captured",
        "adaptive-inventory-hold-ceiling", "adaptive-forecast-warning", "adaptive-forecast-stale"].includes(reason)) held.exitReason ??= reason;
    }
    return plan;
  }
  private externalBook(book: OrderBook, tokenId: string): OrderBook {
    const bids = book.bids.map((level) => ({ ...level }));
    for (const order of Object.values(this.checkpoint.orders).filter((row) => working(row) && row.side === "BUY" && row.tokenId === tokenId && row.venueId)) {
      const level = bids.find((row) => Math.abs(row.price - order.limitPrice) < EPSILON);
      if (level) level.size = Math.max(0, level.size - remaining(order));
    }
    return { ...book, bids: bids.filter((row) => row.size > EPSILON) };
  }
  private normalized(size: number): number { return this.deps.venue.normalizeOrderSize?.(size) ?? size; }
  private buyHeadroom(marketKey: string, otherOrders: Receipt[]): number {
    const config = this.effectiveConfig();
    const market = this.checkpoint.markets[marketKey] ?? this.candidates.find((row) => row.marketKey === marketKey);
    const metadata = (key: string) => this.checkpoint.markets[key] ?? this.candidates.find((row) => row.marketKey === key);
    const inventory = Object.values(this.checkpoint.inventory);
    const buys = otherOrders.filter((row) => row.side === "BUY");
    const committedMarkets = new Set([...inventory.filter((row) => row.quantity > EPSILON).map((row) => row.marketKey), ...otherOrders.map((row) => row.marketKey)]);
    if (!committedMarkets.has(marketKey) && committedMarkets.size >= config.capital.max_active_markets) return 0;
    const committed = (matches: (key: string) => boolean) =>
      inventory.filter((row) => matches(row.marketKey)).reduce((sum, row) => sum + row.quantity * row.averageCost, 0) +
      buys.filter((row) => matches(row.marketKey)).reduce((sum, row) => sum + remaining(row) * row.limitPrice, 0);
    const reserved = buys.reduce((sum, row) => sum + remaining(row) * row.limitPrice, 0);
    return Math.max(0, Math.min(
      this.checkpoint.collateralUsd - reserved - config.capital.minimum_free_collateral_usd - config.capital.operational_reserve_usd,
      config.capital.max_total_inventory_and_pending_entry_cost_usd - committed(() => true),
      config.capital.hard_market_cost_usd - committed((key) => key === marketKey),
      market ? config.portfolio_risk.max_event_cost_usd - committed((key) => metadata(key)?.eventId === market.eventId) : 0,
      market ? config.portfolio_risk.max_category_family_cost_usd - committed((key) => categoryFamily(metadata(key)?.category ?? "", config) === categoryFamily(market.category, config)) : 0,
      market?.manualCorrelationGroup ? config.portfolio_risk.max_manual_correlation_group_cost_usd - committed((key) => metadata(key)?.manualCorrelationGroup === market.manualCorrelationGroup) : Number.POSITIVE_INFINITY,
    ));
  }
  private capQuote(quote: TwoSidedQuote, otherOrders = Object.values(this.checkpoint.orders).filter(working), preparingClientId?: string): TwoSidedQuote | undefined {
    const config = this.effectiveConfig();
    // Only the in-flight onPrepared callback can exclude its own known, not-yet-
    // submitted SIGNED receipt. Other prepared/unknown receipts still block risk.
    const unknown = Object.values(this.checkpoint.orders).some((row) => ["SIGNED", "UNKNOWN"].includes(row.status)
      && !(row.clientId === preparingClientId && row.status === "SIGNED"));
    if (this.unsettledOrders.size > 0 || unknown) return undefined;
    if (Object.values(this.checkpoint.redemptions ?? {}).some((row) => row.marketKey === quote.marketKey && row.status !== "CONFIRMED")) return undefined;
    let size = quote.size;
    if (quote.side === "SELL") {
      const reserved = otherOrders.filter((row) => row.side === "SELL" && row.tokenId === quote.tokenId).reduce((sum, row) => sum + remaining(row), 0);
      const ledger = this.checkpoint.inventory[quote.tokenId]?.quantity ?? 0;
      const authoritative = this.lastSnapshot?.positions.find((row) => row.tokenId === quote.tokenId)?.size ?? 0;
      size = Math.min(size, Math.max(0, Math.min(ledger, authoritative) - reserved));
    } else {
      if (this.unsettledTokens.size > 0 || this.checkpoint.collateralUnsettled || this.checkpoint.lossLatched || unknown || this.pendingRedemption()) return undefined;
      const free = Math.min(this.buyHeadroom(quote.marketKey, otherOrders), config.capital.max_order_notional_usd);
      size = Math.min(size, free / quote.limitPrice);
      const market = this.checkpoint.markets[quote.marketKey] ?? this.candidates.find((row) => row.marketKey === quote.marketKey);
      if (market) {
        const delta = (this.checkpoint.inventory[market.yesTokenId]?.quantity ?? 0) - (this.checkpoint.inventory[market.noTokenId]?.quantity ?? 0);
        const sameSidePending = otherOrders.filter((row) => row.marketKey === quote.marketKey &&
          ((row.side === "BUY" && row.outcome === quote.outcome) || (row.side === "SELL" && row.outcome !== quote.outcome)))
          .reduce((sum, row) => sum + remaining(row), 0);
        const directionalShares = quote.outcome === "YES" ? delta : -delta;
        size = Math.min(size, Math.max(0, config.two_sided!.maximum_unpaired_notional_usd / quote.limitPrice - directionalShares - sameSidePending));
      }
    }
    size = this.normalized(size);
    const market = this.checkpoint.markets[quote.marketKey] ?? this.candidates.find((row) => row.marketKey === quote.marketKey);
    const opposite = otherOrders.find((row) => row.marketKey === quote.marketKey && row.lane !== quote.lane);
    if (opposite && market) {
      const economicPrice = (row: TwoSidedQuote) => row.outcome === "YES" ? row.limitPrice : 1 - row.limitPrice;
      const spread = quote.lane === "ask" ? economicPrice(quote) - economicPrice(opposite) : economicPrice(opposite) - economicPrice(quote);
      if (spread + EPSILON < market.tickSize * config.two_sided!.minimum_pair_spread_ticks) return undefined;
    }
    return size > EPSILON && size + EPSILON >= (market?.minOrderSize ?? 0) ? { ...quote, size } : undefined;
  }
  private capPair(quotes: TwoSidedQuote[], otherOrders: Receipt[]): TwoSidedQuote[] {
    const capped = quotes.map((quote) => this.capQuote(quote, otherOrders)).filter((quote): quote is TwoSidedQuote => quote !== undefined);
    if (quotes.length !== 2 || quotes.some((quote) => quote.side !== "BUY")) return capped;
    if (capped.length !== 2) return [];
    const size = this.normalized(Math.min(...capped.map((quote) => quote.size), this.buyHeadroom(quotes[0]!.marketKey, otherOrders) / capped.reduce((sum, quote) => sum + quote.limitPrice, 0)));
    const market = this.checkpoint.markets[quotes[0]!.marketKey] ?? this.candidates.find((row) => row.marketKey === quotes[0]!.marketKey);
    return size > EPSILON && size + EPSILON >= (market?.minOrderSize ?? 0) ? capped.map((quote) => ({ ...quote, size })) : [];
  }
  private async markLoss(plans: Array<{ market: PolymarketMarketCatalog; plan: TwoSidedPlan }>): Promise<void> {
    if (this.unsettledTokens.size || this.unsettledOrders.size || this.pendingRedemption() || this.checkpoint.collateralUnsettled) return;
    let equity = this.checkpoint.collateralUsd;
    const marketLoss = new Map<string, number>();
    for (const held of Object.values(this.checkpoint.inventory)) {
      if (held.quantity <= EPSILON) continue;
      const plan = plans.find((row) => row.market.marketKey === held.marketKey)?.plan;
      const bid = held.outcome === "YES" ? plan?.context.yesBid : plan?.context.noBid;
      if (bid === undefined) return;
      equity += held.quantity * bid;
      marketLoss.set(held.marketKey, (marketLoss.get(held.marketKey) ?? 0) + held.quantity * (held.averageCost - bid));
    }
    this.markedEquityUsd = equity;
    this.checkpoint.highWaterUsd = Math.max(this.checkpoint.highWaterUsd ?? equity, equity);
    const history = (this.checkpoint.equityHistory ?? []).filter((point) => point.ts >= this.now() - 24 * 60 * 60_000);
    if (history.length === 0 || this.now() - history.at(-1)!.ts >= 60_000) history.push({ ts: this.now(), equity });
    this.checkpoint.equityHistory = history;
    const loss = this.status().loss;
    const limits = this.effectiveConfig().loss_limits;
    if (!this.checkpoint.lossLatched && ([...marketLoss.values()].some((value) => value >= limits.max_marked_loss_per_market_usd) ||
      loss.drawdownUsd >= limits.max_strategy_drawdown_usd || loss.rolling24hLossUsd >= limits.max_rolling_24h_loss_usd)) {
      this.checkpoint.lossLatched = true;
      this.checkpoint.reduceOnly = true;
      await this.failClosed("two-sided marked inventory loss limit reached");
    }
  }
  private async quoteCycle(reduceOnly = false): Promise<number> {
    if (this.venueCoolingDown()) return 0;
    this.inLiveQuoteCycle = true;
    this.planningReduceOnly = reduceOnly;
    try {
      const plans = await this.plans();
      this.lastPlans = plans;
      if (!this.lastSnapshot || this.now() - this.lastSnapshot.at >= this.accountPollMs()) {
        await this.applySnapshot(await this.readSnapshot(true));
      }
      await this.markLoss(plans);
      let actions = 0;
      for (const { market, plan } of plans) {
        this.checkpoint.markets[market.marketKey] = market;
        const aged = this.config.two_sided?.adaptive ? false
          : Object.values(this.checkpoint.inventory).some((row) => row.marketKey === market.marketKey && row.quantity > EPSILON && this.now() - row.firstHeldAt >= this.config.two_sided!.maximum_inventory_age_seconds * 1_000);
        let desired = plan.quotes.filter((quote) => (!(reduceOnly || aged || this.checkpoint.lossLatched) || quote.side === "SELL"));
        const current = Object.values(this.checkpoint.orders).filter((order) => working(order) && order.marketKey === market.marketKey);
        if (current.length === 0) desired = this.capPair(desired, Object.values(this.checkpoint.orders).filter(working));
        const routeChanged = current.some((order) => {
          const target = desired.find((quote) => quote.lane === order.lane);
          return target && (target.side !== order.side || target.tokenId !== order.tokenId);
        });
        if (routeChanged) {
          for (const order of current) { await this.cancel(order, "inventory changed complementary quote route"); actions += 1; }
          continue;
        }
        for (const lane of ["bid", "ask"] as const) {
          const existing = current.find((order) => order.lane === lane && working(order));
          const target = desired.find((quote) => quote.lane === lane);
          if (existing) {
            if (!target) { await this.cancel(existing, "quote no longer fits live liquidity or inventory limits"); actions += 1; continue; }
            if (existing.status !== "OPEN") continue;
            if (this.unsettledOrders.size === 0) {
              const allowed = this.capQuote(target, Object.values(this.checkpoint.orders).filter((row) => working(row) && row.clientId !== existing.clientId));
              if (!allowed || remaining(existing) > allowed.size + EPSILON) {
                await this.cancel(existing, "resting quote exceeds refreshed inventory, cash, or liquidity limit"); actions += 1; continue;
              }
            }
            const age = this.now() - existing.createdAt;
            const move = Math.abs(existing.limitPrice - target.limitPrice);
            const outsideEnvelope = this.config.two_sided?.adaptive && (existing.side === "BUY"
              ? existing.limitPrice > target.limitPrice + EPSILON : existing.limitPrice < target.limitPrice - EPSILON);
            if (outsideEnvelope) {
              await this.cancel(existing, "adaptive quote outside current price-risk envelope"); actions += 1; continue;
            }
            if (age >= this.config.two_sided!.minimum_rest_seconds * 1_000 && move + EPSILON >= market.tickSize * this.config.two_sided!.reprice_ticks) {
              await this.cancel(existing, "meaningful spread quote repricing"); actions += 1;
            }
            continue;
          }
          if (!target || (!this.checkpoint.active && !(this.checkpoint.reduceOnly && target.side === "SELL"))) continue;
          if (Object.values(this.checkpoint.orders).filter(working).length >= this.config.capital.max_live_orders) continue;
          const quote = this.capQuote(target);
          if (!quote) continue;
          await this.place(quote);
          actions += 1;
        }
      }
      await this.save();
      await this.startSubscriptions();
      return actions;
    } catch (error) {
      if (transientVenueError(error)) { await this.pauseForVenue(error); return 0; }
      throw error;
    } finally { this.inLiveQuoteCycle = false; this.planningReduceOnly = false; }
  }
  dryRun() {
    return this.serialized(async () => {
      // A separate timer-free instance keeps preview mutations away from the
      // independent heartbeat safety lane and never writes a checkpoint.
      const shadow = new TwoSidedMarketMakeController(this.deps, { ...this.options, autoSchedule: false, enableSubscriptions: false });
      shadow.checkpoint = this.stateSnapshot();
      shadow.candidates = structuredClone(this.candidates);
      shadow.discoveryAt = this.discoveryAt;
      shadow.signalDiscoveryAt = this.signalDiscoveryAt;
      shadow.signalRows = structuredClone(this.signalRows);
      shadow.signalCatalogs = new Map(structuredClone([...this.signalCatalogs]));
      shadow.signalCatalogAttempts = new Map(this.signalCatalogAttempts);
      shadow.movement = new Map(structuredClone([...this.movement]));
      shadow.unsettledOrders = new Set(this.unsettledOrders);
      shadow.unsettledTokens = new Set(this.unsettledTokens);
      const snapshot = await shadow.readSnapshot();
      return shadow.previewSnapshot(snapshot);
    });
  }
  private async previewSnapshot(snapshot: VenueSnapshot) {
        const originalInventory = this.checkpoint.inventory;
        this.checkpoint.collateralUsd = snapshot.collateralUsd;
        this.lastSnapshot = snapshot;
        await this.discover();
        this.checkpoint.inventory = {};
        for (const position of snapshot.positions) {
          const market = [...Object.values(this.checkpoint.markets), ...this.candidates].find((row) => row.yesTokenId === position.tokenId || row.noTokenId === position.tokenId);
          const previous = originalInventory[position.tokenId!];
          const sameCycle = previous && previous.quantity > EPSILON && previous.marketKey === market?.marketKey && previous.outcome === position.outcome;
          if (market) this.checkpoint.inventory[position.tokenId!] = { ...(sameCycle ? previous : {}), tokenId: position.tokenId!, marketKey: market.marketKey, outcome: position.outcome as "YES" | "NO", quantity: position.size, averageCost: position.avgPrice, firstHeldAt: sameCycle ? previous.firstHeldAt : this.now() };
        }
        const plans = await this.plans();
        const actions: Array<TwoSidedQuote & { kind: "place"; clientId: string; tif: "GTC"; postOnly: true; purpose: "entry" | "normal-exit" }> = [];
        for (const { market, plan } of plans) {
          this.checkpoint.markets[market.marketKey] = market;
          const existing = Object.values(this.checkpoint.orders).filter(working);
          const unoccupied = plan.quotes.filter((quote) => !existing.some((order) => order.marketKey === quote.marketKey && order.lane === quote.lane));
          for (const quote of this.capPair(unoccupied, existing)) {
            if (Object.values(this.checkpoint.orders).filter(working).length >= this.config.capital.max_live_orders) break;
            const capped = this.capQuote(quote);
            if (!capped) continue;
            const clientId = `preview:${quote.marketKey}:${quote.lane}`;
            actions.push({ kind: "place", ...capped, clientId, tif: "GTC", postOnly: true, purpose: quote.side === "BUY" ? "entry" : "normal-exit" });
            this.checkpoint.orders[clientId] = { ...capped, clientId, status: "RESERVED", filled: 0, createdAt: this.now(), updatedAt: this.now() };
          }
        }
        return { at: this.now(), actions, decisions: plans.map(({ market, plan }) => ({ ts: this.now(), marketKey: market.marketKey, eventType: "book" as const, actions: plan.quotes.length, decision: plan.eligible ? "two-sided-quotable" : "two-sided-rejected", reasons: plan.reasons })), state: this.stateSnapshot() };
  }
  private async place(quote: TwoSidedQuote): Promise<void> {
    const safetyGeneration = this.safetyGeneration;
    const market = this.checkpoint.markets[quote.marketKey];
    if (!market || !this.lastSnapshot || this.venueCoolingDown() || this.now() - this.lastSnapshot.at >= this.accountPollMs()) return;
    // Rebuild both economic lanes from current books immediately before
    // signing. A quote cannot rely on the early part of a discovery scan.
    const [yesBook, noBook] = await Promise.all([
      this.readRetry(() => this.deps.venue.tokenBook!(market.yesTokenId)),
      this.readRetry(() => this.deps.venue.tokenBook!(market.noTokenId)),
    ]);
    const currentConfig = this.effectiveConfig();
    if ([yesBook, noBook].some((book) => this.now() - book.ts > currentConfig.market_data.venue_quote_max_age_seconds * 1_000 || book.ts - this.now() > currentConfig.global_kill_switches.max_clock_skew_seconds * 1_000)) return;
    const refreshed = this.planMarket(market, yesBook, noBook).quotes.find((row) => row.lane === quote.lane && row.side === quote.side && row.tokenId === quote.tokenId);
    if (!refreshed) return;
    const recapped = this.capQuote({ ...refreshed, size: Math.min(quote.size, refreshed.size) });
    if (!recapped) return;
    quote = recapped;
    const book = quote.outcome === "YES" ? yesBook : noBook;
    const bid = Math.max(...book.bids.map((row) => row.price), 0);
    const ask = Math.min(...book.asks.map((row) => row.price), 1);
    if (this.now() - book.ts > this.config.market_data.venue_quote_max_age_seconds * 1_000 || bid >= ask || (quote.side === "BUY" ? quote.limitPrice >= ask - EPSILON : quote.limitPrice <= bid + EPSILON)) return;
    const authorized = () => this.checkpoint.active || (this.checkpoint.reduceOnly && quote.side === "SELL");
    if (safetyGeneration !== this.safetyGeneration || !authorized()) return;
    if (quote.side === "SELL") {
      if (!this.deps.venue.tokenBalance) throw new Error("live SELL requires an authenticated exact token balance read");
      const balance = await this.readRetry(() => this.deps.venue.tokenBalance!(this.deps.account, quote.tokenId));
      if (!Number.isFinite(balance) || balance < 0) throw new Error("invalid exact token balance");
      const reserved = Object.values(this.checkpoint.orders).filter((row) => working(row) && row.side === "SELL" && row.tokenId === quote.tokenId).reduce((sum, row) => sum + remaining(row), 0);
      const size = this.normalized(Math.min(quote.size, Math.max(0, balance - reserved)));
      const minimum = this.checkpoint.markets[quote.marketKey]?.minOrderSize ?? 0;
      if (!(size > EPSILON) || size + EPSILON < minimum) return;
      quote = { ...quote, size };
    }
    if (safetyGeneration !== this.safetyGeneration || this.unsettledOrders.size > 0) return;
    if (this.now() - book.ts > currentConfig.market_data.venue_quote_max_age_seconds * 1_000) return;
    const clientId = `mm2:${this.options.deploymentId}:${++this.checkpoint.sequence}`;
    const forecast = this.config.two_sided?.adaptive && quote.side === "BUY" ? this.checkpoint.forecasts?.[quote.marketKey]?.value : undefined;
    const order: Receipt = { ...quote, clientId, status: "RESERVED", filled: 0, createdAt: this.now(), updatedAt: this.now(),
      ...(forecast ? { entryForecast: structuredClone(forecast) } : {}) };
    this.checkpoint.orders[clientId] = order;
    await this.save();
    const intent: OrderIntent = { ...quote, clientId, tif: "GTC", postOnly: true, purpose: quote.side === "BUY" ? "entry" : "normal-exit" };
    let stoppedBeforePost = false;
    try {
      const ack = await this.deps.venue.placeOrderWithLifecycle!(this.deps.account, intent, {
        onPrepared: async (meta) => {
          const assertStillPermitted = () => {
            const abort = (reason: string): never => {
              stoppedBeforePost = true;
              throw new Error(`${reason}; POST aborted`);
            };
            if (safetyGeneration !== this.safetyGeneration || this.stopping || !authorized()) {
              abort("activation changed while preparing order");
            }
            if (this.venueCoolingDown() || !this.lastSnapshot || this.now() - this.lastSnapshot.at >= this.accountPollMs()) {
              abort("account supervision expired while preparing order");
            }
            if ([yesBook, noBook].some((row) => this.now() - row.ts > currentConfig.market_data.venue_quote_max_age_seconds * 1_000
              || row.ts - this.now() > currentConfig.global_kill_switches.max_clock_skew_seconds * 1_000)) {
              abort("order books expired while preparing order");
            }
            // Preparation and the durable SIGNED write can cross a Q expiry,
            // inventory-age boundary or quote-risk change. Reuse the same
            // planner and risk caps, excluding only this order's own reserve.
            const candidate = this.planMarket(market, yesBook, noBook).quotes.find((row) => row.lane === order.lane
              && row.side === order.side && row.tokenId === order.tokenId);
            const allowed = candidate && this.capQuote(candidate, Object.values(this.checkpoint.orders)
              .filter((row) => working(row) && row.clientId !== clientId), clientId);
            if (!allowed || order.size > allowed.size + EPSILON || (order.side === "BUY"
              ? order.limitPrice > allowed.limitPrice + EPSILON : order.limitPrice < allowed.limitPrice - EPSILON)) {
              abort("quote no longer fits current forecast, inventory or capital limits");
            }
          };
          assertStillPermitted();
          order.preparedHash = meta.preparedHash;
          order.status = "SIGNED";
          await this.save();
          assertStillPermitted();
        },
      });
      order.venueId = ack.orderId;
      order.status = ack.status === "rejected" ? "REJECTED" : ack.status === "canceled" ? "CANCELED" : "OPEN";
      if (ack.status === "filled" || ack.status === "partial") order.observedFilled = ack.filledSize ?? (ack.status === "filled" ? quote.size : 0);
      order.updatedAt = this.now();
      this.checkpoint.lastTradingAt = this.now();
      if (ack.status === "filled" || ack.status === "partial") this.unsettledOrders.add(clientId);
      await this.save();
      this.log.info("two-sided order acknowledged", { orderId: ack.orderId, marketKey: quote.marketKey, lane: quote.lane, side: quote.side, outcome: quote.outcome, size: quote.size, price: quote.limitPrice });
      if (safetyGeneration !== this.safetyGeneration) await this.cancel(order, "acknowledgement arrived after activation was revoked");
    } catch (error) {
      order.status = order.preparedHash && !stoppedBeforePost ? "UNKNOWN" : "REJECTED";
      order.error = String(error);
      order.updatedAt = this.now();
      await this.save();
      if (order.preparedHash && !stoppedBeforePost) await this.failClosed(`ambiguous submission for ${clientId}`);
      else if (transientVenueError(error)) throw error;
      else this.log.warn("two-sided order rejected before preparation", { clientId, error: String(error) });
    }
    if (order.venueId && working(order)) {
      try { await this.heartbeat(); }
      catch (error) { await this.heartbeatFailed(error); }
    }
  }
  private async cancel(order: Receipt, reason: string): Promise<void> {
    if (!working(order)) return;
    if (order.venueId || !["SIGNED", "UNKNOWN"].includes(order.status)) order.status = "CANCEL_PENDING";
    order.cancelRequestedAt ??= this.now();
    await this.save();
    if (!order.venueId) return;
    try {
      await this.deps.venue.cancelOrder(this.deps.account, order.venueId);
      // Release only after a subsequent authenticated snapshot confirms absence.
      this.log.info("two-sided cancellation requested", { orderId: order.venueId, marketKey: order.marketKey, reason });
    } catch (error) {
      this.log.warn("two-sided cancellation will retry", { orderId: order.venueId, error: String(error) });
      if (transientVenueError(error)) { this.deferVenueRetry(error); throw error; }
    }
  }
  private async cancelWorking(reason: string): Promise<void> {
    for (const order of Object.values(this.checkpoint.orders).filter(working)) await this.cancel(order, reason);
  }
  private async failClosed(reason: string, retryable = false): Promise<void> {
    this.safetyGeneration += 1;
    this.checkpoint.recoverablePause = retryable && (this.checkpoint.active || this.checkpoint.recoverablePause === true) && this.checkpoint.approved && !this.checkpoint.lossLatched;
    this.checkpoint.active = false;
    this.checkpoint.haltReason = reason;
    this.lastError = reason;
    for (const order of Object.values(this.checkpoint.orders).filter(working)) {
      if (order.venueId || !["SIGNED", "UNKNOWN"].includes(order.status)) order.status = "CANCEL_PENDING";
      order.cancelRequestedAt ??= this.now();
    }
    await this.save();
    try {
      await this.deps.venue.cancelAll(this.deps.account);
      await this.save();
    } catch (error) { this.log.error("two-sided emergency cancellation failed", { reason, error: String(error) }); }
  }
  private startHeartbeat(): void {
    if (!this.deps.venue.heartbeat || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => { void this.heartbeat().catch((error) => this.heartbeatFailed(error).catch((failure) => this.log.error("two-sided heartbeat shutdown failed", { error: String(failure) }))); }, this.options.heartbeatIntervalMs ?? 5_000);
    this.heartbeatTimer.unref?.();
  }
  private async heartbeatFailed(error: unknown): Promise<void> {
    if (transientVenueError(error)) await this.pauseForVenue(error);
    else {
      const status = (error as { status?: number } | undefined)?.status;
      await this.failClosed(`heartbeat failed: ${String(error)}`, !(status !== undefined && status >= 400 && status < 500));
    }
  }
  private async heartbeat(): Promise<void> {
    // During a supervision outage, let the venue's dead-man switch cancel any
    // quotes the emergency cancellation could not reach. Do not renew them blind.
    if (this.checkpoint.recoverablePause || this.venueCoolingDown()) return;
    if (!this.deps.venue.heartbeat || !Object.values(this.checkpoint.orders).some(working)) return;
    if (this.heartbeatPending) return this.heartbeatPending;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const pending = Promise.race([
      this.deps.venue.heartbeat(this.deps.account),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("heartbeat exceeded four seconds")), 4_000); timeout.unref?.(); }),
    ]).finally(() => { if (timeout) clearTimeout(timeout); this.heartbeatPending = undefined; });
    this.heartbeatPending = pending;
    return pending;
  }
  private schedule(): void {
    if (!this.started || this.stopping || this.options.autoSchedule === false) return;
    this.tickTimer = setTimeout(() => { void this.tick({ scheduled: true }).catch((error) => this.log.warn("two-sided tick will retry", { error: String(error) })).finally(() => this.schedule()); }, this.accountPollMs());
    this.tickTimer.unref?.();
  }
  private wake(kind: "market" | "user" = "user"): void {
    if (this.venueCoolingDown()) return;
    if (kind === "user") this.userWakePending = true;
    if (this.wakePending || this.stopping) return;
    this.wakePending = true;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      const accountDirty = this.userWakePending;
      this.userWakePending = false;
      const wake = accountDirty || !this.lastSnapshot || this.now() - this.lastSnapshot.at >= this.accountPollMs()
        ? this.tick()
        : this.serialized(async () => { if (this.checkpoint.active) await this.quoteCycle(); });
      void wake.catch(async (error) => {
        if (transientVenueError(error)) await this.pauseForVenue(error);
        else await this.failClosed(`stream supervision unavailable: ${String(error)}`);
      }).catch((error) => this.log.error("two-sided stream recovery failed", { error: String(error) }))
        .finally(() => { this.wakePending = false; if (this.userWakePending) this.wake("user"); });
    }, 2_000);
    this.wakeTimer.unref?.();
  }
  private async startSubscriptions(): Promise<void> {
    if (this.options.enableSubscriptions === false || this.stopping) return;
    if (!this.userSubscription && this.deps.venue.subscribeUserData) {
      this.userSubscription = await this.deps.venue.subscribeUserData();
      this.consume(this.userSubscription, "user");
    }
    const keys = new Set([
      ...Object.values(this.checkpoint.orders).filter(working).map((row) => row.marketKey),
      ...Object.values(this.checkpoint.inventory).filter((row) => row.quantity > EPSILON).map((row) => row.marketKey),
    ]);
    const tokens = [...keys].flatMap((key) => { const market = this.checkpoint.markets[key]; return market ? [market.yesTokenId, market.noTokenId] : []; }).sort();
    const key = tokens.join(",");
    if (key && key !== this.marketSubscriptionKey && this.deps.venue.subscribeMarketData) {
      const previous = this.marketSubscription;
      this.marketSubscription = undefined;
      this.marketSubscriptionKey = key;
      await previous?.close();
      this.marketSubscription = await this.deps.venue.subscribeMarketData(tokens);
      this.consume(this.marketSubscription, "market");
    }
  }
  private consume(subscription: RealtimeSubscription, kind: "market" | "user"): void {
    void (async () => {
      try { for await (const _event of subscription) { if (this.stopping) return; this.wake(kind); } }
      catch (error) { this.log.warn("two-sided stream disconnected; REST supervision remains active", { kind, error: String(error) }); }
      if (this.stopping || (kind === "market" ? this.marketSubscription : this.userSubscription) !== subscription) return;
      if (kind === "market") { this.marketSubscription = undefined; this.marketSubscriptionKey = ""; }
      else this.userSubscription = undefined;
      this.wake();
    })();
  }
}

export type TwoSidedMarketMakeControllerStatus = ReturnType<TwoSidedMarketMakeController["status"]>;

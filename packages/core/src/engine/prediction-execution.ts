// packages/core/src/engine/prediction-execution.ts
// Durable directional prediction execution; strategy output never signs or places orders.
import type { BotConfig } from "../config.js";
import type { Action, Alerter, Balance, Fill, Logger, Order, OrderBook, OrderIntent, Position, PredictionCancellationResult, PredictionExecutionMarket, Signal, StateStore, StrategyActionResult, VenueAccount, VenueAdapter } from "../types.js";
import { getJson, setJson } from "../state.js";
import { closingPnl } from "../alerts/format.js";
import { isTransientVenueError, retryAfterMs } from "../venues/transient.js";
import { checkCapacity } from "../risk/capacity.js";
import { derivePredictionExecutionMetrics, type PredictionExecutionMetrics } from "./prediction-execution-metrics.js";
import { positionMarketValue } from "../portfolio.js";
import { RefusalLog } from "./refusal-log.js";

export const PREDICTION_EXECUTION_KEY = "prediction:execution:v1";

/** Changing strategy or mode cannot discard an executor's unresolved obligations. */
export async function assertPredictionExecutionSettled(state: StateStore): Promise<void> {
  const saved = await getJson<Checkpoint>(state, PREDICTION_EXECUTION_KEY);
  if (!saved) return;
  if (saved.version !== 1 || !saved.children || !saved.parents
    || Object.values(saved.children).some(child => !["terminal", "rejected"].includes(child.status))
    || Object.values(saved.parents).some(parent => !["completed", "canceled"].includes(parent.status))
    || Object.keys(saved.queuedExits ?? {}).length > 0
    || Object.values(saved.settlements ?? {}).some(fill => !["CONFIRMED", "FAILED"].includes(fill.status))) {
    throw new Error("unresolved adaptive prediction execution; restart in adaptive mode and reconcile orders and fills before changing execution mode or strategy");
  }
}
const EPS = 1e-8;
const BOOK_AGE_MS = 10_000;
const MINIMUM_REST_MS = 10_000;
const FILL_OVERLAP_MS = 300_000;
/** A venue that cannot be read for this long stops resting orders gracefully; shorter outages only defer. */
const SUPERVISION_STALE_MS = 60_000;
const SNAPSHOT_TIMEOUT_MS = 8_000;
/** Cold starts resolve market metadata for every token in the settlement history before the caches warm. */
const COLD_START_TIMEOUT_MS = 30_000;
const SNAPSHOT_REUSE_MS = 3_000;
/** Idle accounts do not need the five-second cadence used to supervise live execution. */
const IDLE_RECONCILE_MS = 30_000;
const DEFAULT_DEFER_MS = 5_000;
const DEFER_LOG_INTERVAL_MS = 30_000;
/** An ambiguous POST is resolved from venue evidence; after this long with no trace it is treated as never landed. */
const AMBIGUOUS_RESOLVE_MS = 30_000;
const KALSHI_CROSSING_WINDOW_MS = 30_000;
/** Taker fee allowance on free cash for a crossing entry: protocol rate × p(1−p) plus the builder fee. */
const ENTRY_TAKER_FEE_ALLOWANCE = 0.02;
/**
 * One CLOB size unit. Fill receipts carry five decimals and the position index four,
 * so any smaller residue between them is rounding, never missing inventory.
 */
export const INVENTORY_DUST_SHARES = 0.01;
type DirectionalAction = Extract<Action, { kind: "enter" | "exit" }>;
type ParentStatus = "active" | "canceling" | "completed" | "canceled";
type ChildStatus = "reserved" | "signed" | "unknown" | "open" | "canceling" | "terminal" | "rejected";

export interface PredictionExecutionParentSummary {
  id: string;
  marketRef: string;
  tokenId: string;
  conditionId: string;
  outcome: "YES" | "NO";
  side: "BUY" | "SELL";
  status: ParentStatus;
  admittedAt: number;
  deadlineAt: number;
  filledSize: number;
  filledNotionalUsd: number;
  feeUsd: number;
  reservedNotionalUsd: number;
  reservedSize: number;
  remainingSize: number;
  priorMarketSize: number;
  childOrderIds: string[];
  firstFillAt?: number;
  lastFillAt?: number;
  terminalAt?: number;
  signalId?: string;
  signalTs?: string;
  qHeld?: number;
  provenance?: Record<string, unknown>;
  reason: string;
  urgent: boolean;
  arrivalBid?: number;
  arrivalAsk?: number;
  /** End of the marketable-limit window that follows the maker deadline (Polymarket entries). */
  crossingDeadlineAt?: number;
  cancelReason?: string;
  metrics?: PredictionExecutionMetrics;
}

export interface PredictionSupervisionDeferral {
  deferredSince: number;
  until: number;
  stage: string;
  reason: string;
}

export interface PredictionExecutionSnapshot {
  parents: PredictionExecutionParentSummary[];
  blocked: boolean;
  queuedExitCount?: number;
  unsettledFillCount?: number;
  /** Present only while the operator pause is latched. */
  haltReason?: string;
  /** Markets whose latest submission is being resolved from venue evidence. */
  reconcilingMarkets?: string[];
  /** Markets holding a resting order this executor did not place; entries there wait. */
  unownedMarkets?: string[];
  refreshedAt?: number;
  entryCooldowns: Record<string, { admittedAt: number; refreshedAt: number }>;
  dailySpentUsd: Record<string, number>;
  /** Present while venue reads are being retried instead of canceling orders. */
  supervision?: PredictionSupervisionDeferral;
}

interface Parent extends Omit<PredictionExecutionParentSummary, "reservedNotionalUsd" | "reservedSize" | "remainingSize" | "childOrderIds"> {
  targetSize: number;
  maximumPrice: number;
  minimumPrice?: number;
  budgetUsd: number;
  minimumEdge: number;
  minimumNotional: number;
  children: string[];
  lastExitDecision?: "hold" | "normal" | "urgent";
  lastExitEvaluationAt?: number;
  fakSubmitted?: boolean;
  /** Set when the single marketable-limit crossing child is reserved; never cross twice. */
  crossingAt?: number;
  minOrderSize?: number;
  inventoryObserved?: boolean;
  lastValidatedBookAt?: number;
  /** SELL only: the held position's size-weighted average entry price at admission, the P&L basis for its fills. */
  entryAvgPrice?: number;
}

interface Child {
  id: string;
  parentId: string;
  intent: OrderIntent;
  status: ChildStatus;
  createdAt: number;
  venueId?: string;
  preparedHash?: string;
  observedMatched: number;
  confirmedSize: number;
  failedSize: number;
  terminalObservedAt?: number;
  terminalFirstObservedAt?: number;
  terminalObservations?: number;
  cancelRequestedAt?: number;
  cancelAcceptedAt?: number;
  cancelFailures?: number;
  notOpenAt?: number;
  nextCancelAt?: number;
  reconciliationError?: string;
  reconciliationErrorSince?: number;
  reconciliationTransient?: boolean;
  /** A settlement record that contradicts this order; stops its parent, never the account. */
  settlementError?: string;
  error?: string;
  /** Set when a signed POST failed ambiguously; cleared by adoption or rejection. */
  unknownSince?: number;
  unknownPasses?: number;
}

/** One venue view per supervision pass; SELL sizing never reads inventory from here. */
interface PortfolioSnapshot {
  balances: Balance[];
  cash: number;
  positions: Position[];
  tokenBalances: Map<string, number>;
  observedAt: number;
}

interface Settlement {
  childId: string;
  quantity: number;
  price: number;
  fee: number;
  ts: number;
  status: NonNullable<Fill["settlementStatus"]>;
  alertedAt?: number;
}

interface Checkpoint {
  version: 1;
  sequence: number;
  parents: Record<string, Parent>;
  children: Record<string, Child>;
  settlements: Record<string, Settlement>;
  entryCooldowns: PredictionExecutionSnapshot["entryCooldowns"];
  dailySpentUsd: Record<string, number>;
  refreshedAt?: number;
  initializedAt: number;
  lastSettlementScanAt?: number;
  queuedExits: Record<string, { action: Extract<Action, { kind: "exit" }>; evaluatedAt: number }>;
}

export interface PredictionExecutorDeps {
  botId: string;
  adapter: VenueAdapter;
  account: VenueAccount;
  state: StateStore;
  config: BotConfig;
  log: Logger;
  alerter?: Alerter;
  now?: () => number;
}

export interface PredictionSupervisionOptions {
  /** Scheduled passes can defer idle account reads; explicit supervision still forces a read. */
  routine?: boolean;
  paused?: boolean;
  signals?: Signal[];
  refreshedAt?: number;
  exitDecisions?: Record<string, "hold" | "normal" | "urgent">;
  exitsEvaluatedAt?: number;
}

function working(child: Child): boolean { return child.status !== "terminal" && child.status !== "rejected"; }
function active(parent: Parent): boolean { return ["active", "canceling"].includes(parent.status); }
function finitePositive(value: number): boolean { return Number.isFinite(value) && value > 0; }
function floorTick(value: number, tick: number): number { return Number((Math.floor((value + EPS) / tick) * tick).toFixed(8)); }
function ceilTick(value: number, tick: number): number { return Number((Math.ceil((value - EPS) / tick) * tick).toFixed(8)); }
function probability(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1; }

export class PredictionExecutor {
  private checkpoint?: Checkpoint;
  private loading?: Promise<Checkpoint>;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private heartbeatPending?: Promise<boolean>;
  private safetyGeneration = 0;
  private paused = false;
  private operatorPaused = false;
  private stopping = false;
  private signals?: Signal[];
  private lastReconciledAt?: number;
  private readonly startedAt: number;
  private portfolio?: PortfolioSnapshot;
  private deferral?: { since: number; until: number; stage: string; reason: string; loggedAt: number };
  private readonly refusals: RefusalLog;
  /** Resting orders this executor did not place, and the markets they sit in. In memory: a restart re-observes them. */
  private unownedOrderIds = new Set<string>();
  private unownedMarkets = new Set<string>();
  private heartbeatFailureLoggedAt = 0;
  /** Set while the venue's dead-man renewal fails; new orders would be cancelled by it within seconds. In memory. */
  private heartbeatFailing = false;

  constructor(private readonly d: PredictionExecutorDeps) {
    this.now = d.now ?? Date.now; this.startedAt = this.now();
    this.refusals = new RefusalLog(d.log, this.now);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(fn, fn);
    this.queue = pending.catch(() => {});
    return pending;
  }

  /** Late read results cannot mutate state; late cancellation still requires reconciliation. */
  private async rpc<T>(label: string, operation: () => Promise<T>, onTimeout?: () => void, timeoutMs = 4000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(Object.assign(new Error(`${label} exceeded ${timeoutMs === 4000 ? "four" : timeoutMs / 1000} seconds`), { name: "TimeoutError" }));
        }, timeoutMs);
        timer.unref?.();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async load(): Promise<Checkpoint> {
    if (this.checkpoint) return this.checkpoint;
    this.loading ??= (async () => {
      const saved = await getJson<Checkpoint>(this.d.state, PREDICTION_EXECUTION_KEY);
      if (saved && saved.version !== 1) throw new Error("unsupported prediction execution checkpoint");
      if (saved) {
        // Earlier runtimes latched an account-wide halt in the checkpoint; every market now resolves on its own.
        const legacy = saved as Checkpoint & { haltReason?: string };
        if (legacy.haltReason) { this.d.log.warn("legacy prediction halt ignored; execution resolves per market", { reason: legacy.haltReason }); delete legacy.haltReason; }
        for (const parent of Object.values(saved.parents)) if ((parent.status as string) === "blocked") parent.status = "active";
      }
      this.checkpoint = saved ?? { version: 1, sequence: 0, parents: {}, children: {}, settlements: {}, entryCooldowns: {}, dailySpentUsd: {}, initializedAt: this.now(), queuedExits: {} };
      this.checkpoint.queuedExits ??= {};
      return this.checkpoint;
    })();
    return this.loading;
  }

  private save(): Promise<void> { return setJson(this.d.state, PREDICTION_EXECUTION_KEY, this.checkpoint!); }
  private strategyNumber(key: string, fallback: number): number {
    const value = (this.d.config.strategy.config as Record<string, unknown> | undefined)?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }
  private latestSignal(marketRef: string): Signal | undefined {
    const candidates = (this.signals ?? []).filter(signal => signal.venue === this.d.config.venue && signal.marketRef === marketRef)
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    const latest = candidates[0];
    if (!latest || !Number.isFinite(Date.parse(latest.ts))) return undefined;
    if (candidates.some(signal => signal.ts === latest.ts && signal.side !== latest.side)) return undefined;
    return latest;
  }
  private get entryDuration(): number { return (this.d.config.execution?.entryDeadlineSec ?? (this.commodities ? this.strategyNumber("entryDeadlineSec", 20) : 120)) * 1000; }
  private get exitDuration(): number { return (this.d.config.execution?.exitPassiveSec ?? (this.commodities ? this.strategyNumber("exitPassiveSec", 20) : 60)) * 1000; }
  /** Polymarket entries only: how long a marketable limit may work after the maker deadline. */
  private get entryCrossingDuration(): number { return this.commodities ? 0 : (this.d.config.execution?.entryCrossingSec ?? 60) * 1000; }
  private entryPhase(p: Parent): "maker" | "taker" | "expired" {
    const now = this.now();
    if (now < p.deadlineAt) return "maker";
    return p.crossingDeadlineAt !== undefined && now < p.crossingDeadlineAt ? "taker" : "expired";
  }

  private deferring(): boolean { return this.deferral !== undefined && this.now() < this.deferral.until; }
  /** A transient venue failure keeps orders and retries; the log line repeats at most every thirty seconds. */
  private defer(stage: string, error: unknown, minMs = 0): void {
    const now = this.now();
    const until = now + Math.max(minMs, retryAfterMs(error) ?? DEFAULT_DEFER_MS);
    const current = this.deferral;
    const announce = !current || current.stage !== stage || now - current.loggedAt >= DEFER_LOG_INTERVAL_MS;
    if (announce) {
      this.d.log.warn("prediction supervision deferred", { stage, retryAfterMs: until - now, error: String(error), ...(current ? { deferredMs: now - current.since } : {}) });
    }
    this.deferral = { since: current?.since ?? now, until: Math.max(until, current?.until ?? 0), stage, reason: String(error), loggedAt: announce ? now : current!.loggedAt };
  }
  private clearDeferral(): void {
    if (!this.deferral) return;
    this.d.log.info("prediction supervision resumed", { deferredMs: this.now() - this.deferral.since });
    this.deferral = undefined;
  }

  /** One account view per pass. Reused within a few seconds; dropped on every fill or acknowledgement. */
  private async portfolioSnapshot(maxAgeMs: number): Promise<PortfolioSnapshot> {
    const cached = this.portfolio;
    if (cached && this.now() - cached.observedAt <= maxAgeMs) return cached;
    const c = this.checkpoint!;
    const observedAt = this.now();
    const [balances, positions] = await this.rpc("portfolio", () => Promise.all([this.d.adapter.balances(this.d.account), this.d.adapter.positions(this.d.account)]), undefined, SNAPSHOT_TIMEOUT_MS);
    const cash = balances.filter(b => ["pUSD", "USDC", "USD"].includes(b.asset)).reduce((sum, b) => sum + b.total, 0);
    if (!Number.isFinite(cash) || cash < 0) throw new Error("invalid collateral snapshot");
    // Authenticated token balances supply inventory the public position index has not caught up
    // with. Only tokens with an active parent, a recent settlement, or an unobserved fill can lag.
    const tokens = new Set(Object.values(c.parents)
      .filter(p => active(p) || (p.filledSize > 0 && !p.inventoryObserved) || this.now() - (p.terminalAt ?? p.admittedAt) < FILL_OVERLAP_MS)
      .map(p => p.tokenId));
    const tokenBalances = new Map(await Promise.all([...tokens].map(async tokenId =>
      [tokenId, await this.rpc("token balance", () => this.d.adapter.tokenBalance!(this.d.account, tokenId), undefined, SNAPSHOT_TIMEOUT_MS)] as const)));
    for (const quantity of tokenBalances.values()) if (!Number.isFinite(quantity) || quantity < 0) throw new Error("invalid authenticated inventory snapshot");
    const snapshot: PortfolioSnapshot = { balances, cash, positions, tokenBalances, observedAt };
    this.portfolio = snapshot;
    return snapshot;
  }
  private get commodities(): boolean { return this.d.config.strategy.id === "kalshi-commodities" && this.d.adapter.id === "kalshi"; }
  private entryUnitCost(price: number, provenance?: Record<string, unknown>): number {
    if (!this.commodities) return price;
    const rate = provenance?.takerFeeRate;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > .5) throw new Error("commodity fee rate unavailable");
    return price + rate * price * (1 - price) + .01;
  }

  private requireSupport(): void {
    const a = this.d.adapter;
    if ((!this.commodities && a.id !== "polymarket") || !a.executionMarket || !a.executionOrder || !a.cancelOrderChecked || !a.placeOrderWithLifecycle || !a.tradeSettlements || !a.tokenBalance || (a.id === "polymarket" && !a.heartbeat)) {
      throw new Error("managed prediction execution requires authoritative venue execution APIs");
    }
  }

  /** Startup reconciles every retained receipt before admitting more risk. */
  recover(): Promise<void> {
    return this.serial(async () => {
      this.requireSupport();
      const c = await this.load();
      for (const child of Object.values(c.children)) {
        if (child.status === "reserved") child.status = "rejected";
        else if (child.status === "signed") {
          // A POST interrupted by the restart is resolved from venue evidence like any other.
          child.status = "unknown"; child.unknownSince = this.now(); child.unknownPasses = 0;
        }
      }
      await this.save();
      await this.reconcile(COLD_START_TIMEOUT_MS);
      for (const p of Object.values(c.parents).filter(active)) {
        if (p.side === "BUY" && this.now() >= (p.crossingDeadlineAt ?? p.deadlineAt)) {
          await this.stopParent(p, p.crossingDeadlineAt === undefined ? "entry deadline elapsed during restart" : "entry crossing window elapsed during restart");
        }
      }
      await this.save();
    });
  }

  admit(action: DirectionalAction, positions: Position[]): Promise<StrategyActionResult> {
    return this.serial(() => this.admitInternal(action, positions));
  }

  /** Every refused admission names its reason once per market; a silent gate hid a nine-hour outage. */
  private refuse(action: DirectionalAction, reason: string, data?: Record<string, unknown>): StrategyActionResult {
    this.refusals.refuse(`admit:${action.marketRef}`, `${action.kind} refused for ${action.marketRef}: ${reason}`, data);
    return { placed: false };
  }

  private async admitInternal(action: DirectionalAction, positions: Position[], exitEvaluatedAt = this.now()): Promise<StrategyActionResult> {
      this.requireSupport();
      const c = await this.load();
      // A supervision pass moments ago already applied every settlement; admission reuses it.
      if (this.now() - (this.lastReconciledAt ?? 0) > SNAPSHOT_REUSE_MS) {
        try { await this.reconcile(); }
        catch (error) {
          if (!isTransientVenueError(error)) throw error;
          this.defer("reconcile", error);
          return this.refuse(action, "supervision deferred (reconcile)");
        }
      }
      const existing = Object.values(c.parents).find(p => p.marketRef === action.marketRef && active(p));
      if (existing) {
        if (action.kind === "exit") {
          if (existing.side === "BUY") {
            c.queuedExits[action.marketRef] = { action, evaluatedAt: this.now() };
            await this.stopParent(existing, "entry preempted by position exit");
          } else {
            existing.lastExitDecision = action.urgent ? "urgent" : "normal";
            existing.lastExitEvaluationAt = this.now();
            if (action.urgent && !existing.urgent) {
              existing.urgent = true;
              for (const child of this.children(existing).filter(working)) await this.cancel(child, "exit became urgent");
            }
          }
          await this.save();
        }
        return { placed: false, executionId: existing.id };
      }
      if (this.stopping) return this.refuse(action, "shutting down");
      if (this.paused) return this.refuse(action, "execution paused");
      if (this.deferring()) return this.refuse(action, `supervision deferred (${this.deferral!.stage})`);
      if (this.heartbeatFailing && action.kind === "enter") return this.refuse(action, "venue heartbeat failing");
      if (action.kind === "enter" && this.unownedMarkets.has(action.marketRef)) return this.refuse(action, "an order this executor did not place rests in this market");
      if (this.commodities && action.kind === "enter" && Object.values(c.parents).some(p => active(p) && p.marketRef !== action.marketRef
        && p.provenance?.asset === action.provenance?.asset)) return this.refuse(action, "another market of the same asset is working");
      const held = positions.filter(p => p.marketRef === action.marketRef && p.size > EPS);
      const outcome = action.kind === "enter" ? action.side : held[0]?.outcome ?? held[0]?.side;
      if (outcome !== "YES" && outcome !== "NO") return this.refuse(action, "no held outcome to act on");
      if (held.some(p => (p.outcome ?? p.side) !== outcome)) return this.refuse(action, "mixed outcomes held");
      if (action.kind === "enter") {
        const previous = c.entryCooldowns[action.marketRef];
        const cooldown = this.strategyNumber("signalPollIntervalMin", 5) * 60_000;
        if (previous && (this.now() - previous.admittedAt < cooldown || (c.refreshedAt ?? 0) <= previous.refreshedAt)) return this.refuse(action, "entry cooldown until the next signal refresh");
        if (!c.refreshedAt) return this.refuse(action, "no refreshed signals yet");
      } else {
        const lastAttempt = Object.values(c.parents).filter(p => p.marketRef === action.marketRef && p.side === "SELL" && p.fakSubmitted && p.terminalAt !== undefined)
          .reduce((latest, p) => Math.max(latest, p.terminalAt!), 0);
        if (lastAttempt && this.now() - lastAttempt < this.strategyNumber("exitRetrySec", 300) * 1000) return this.refuse(action, "exit retry cooldown");
      }
      let market: PredictionExecutionMarket;
      let snapshot: PortfolioSnapshot | undefined;
      try {
        market = await this.rpc("execution market", () => this.d.adapter.executionMarket!(action.marketRef, outcome));
        snapshot = action.kind === "enter" ? await this.portfolioSnapshot(SNAPSHOT_REUSE_MS) : undefined;
      } catch (error) {
        if (!isTransientVenueError(error)) throw error;
        this.defer("admission", error);
        return this.refuse(action, "supervision deferred (admission)");
      }
      this.validateMarket(market, action.marketRef, outcome, action.kind === "exit" && (action.urgent === true || this.exitDuration === 0));
      const external = this.externalBook(market.book, market.tokenId);
      const bid = external.bids[0]!.price;
      const ask = external.asks[0]?.price ?? bid;
      const provenance = action.provenance;
      const latestSignal = this.latestSignal(action.marketRef);
      const rawQ = provenance?.qHeld ?? (latestSignal?.side === outcome ? latestSignal.prob : undefined);
      const minimumEdge = this.strategyNumber("entrySpreadPp", 10) / 100;
      if (action.kind === "enter" && !probability(rawQ)) return this.refuse(action, "no usable Q probability");
      const maximumPrice = action.kind === "enter"
        ? floorTick(Math.min(ask, (rawQ as number) - minimumEdge, action.limitPrice ?? 1), market.tickSize)
        : 1;
      if (!(maximumPrice > 0) || (action.kind === "enter" && maximumPrice + EPS < bid)) return this.refuse(action, "price bound below the best bid", { maximumPrice, bid, ask });
      const cash = snapshot?.cash ?? 0;
      const reserved = Object.values(c.parents).filter(p => active(p) && p.side === "BUY").reduce((sum, p) => sum + this.remaining(p) * p.maximumPrice, 0);
      const budget = action.kind === "enter" ? Math.min(action.notional, this.d.config.risk.maxOrderNotional, Math.max(0, cash - reserved)) : 0;
      const heldSize = held.reduce((sum, p) => sum + p.size, 0);
      const pricedSize = held.reduce((sum, p) => sum + (p.avgPrice > 0 ? p.size : 0), 0);
      const entryAvgPrice = action.kind === "exit" && pricedSize > EPS
        ? held.reduce((sum, p) => sum + (p.avgPrice > 0 ? p.size * p.avgPrice : 0), 0) / pricedSize : undefined;
      const desiredSize = action.kind === "enter" ? budget / this.entryUnitCost(maximumPrice, provenance) : heldSize * Math.min(1, Math.max(0, action.fraction ?? 1));
      const cap = checkCapacity({ side: action.kind === "enter" ? "BUY" : "SELL", desiredSize, refPrice: action.kind === "enter" ? maximumPrice : bid, book: external,
        quote: { ...market.quote, bid, ask, mid: (bid + ask) / 2 }, risk: action.kind === "exit" ? { ...this.d.config.risk, minDailyVolume: 0 } : this.d.config.risk,
        minimumNotional: action.kind === "enter" ? action.minNotional : undefined, enforceMinimumNotional: action.kind === "enter" });
      if (!cap.ok) return this.refuse(action, `capacity: ${cap.skipReasons.join("; ")}`);
      let size = this.normalize(cap.size);
      if (action.kind === "exit") {
        let balance: number;
        try { balance = await this.rpc("token balance", () => this.d.adapter.tokenBalance!(this.d.account, market.tokenId, { refresh: true })); }
        catch (error) {
          if (!isTransientVenueError(error)) throw error;
          this.defer("admission", error);
          return this.refuse(action, "supervision deferred (inventory)");
        }
        size = this.normalize(Math.min(size, balance));
      }
      if (!(size > EPS) || (action.kind === "enter" && size + EPS < market.minOrderSize)) return this.refuse(action, "size below the venue minimum", { size, minOrderSize: market.minOrderSize });
      const now = this.now();
      const id = `prediction:${this.d.botId}:${++c.sequence}`;
      const p: Parent = { id, marketRef: action.marketRef, tokenId: market.tokenId, conditionId: market.conditionId, outcome,
        side: action.kind === "enter" ? "BUY" : "SELL", status: "active", admittedAt: now,
        deadlineAt: now + (action.kind === "enter" ? this.entryDuration : this.exitDuration), targetSize: size, maximumPrice,
        ...(action.kind === "enter" && this.entryCrossingDuration > 0 ? { crossingDeadlineAt: now + this.entryDuration + this.entryCrossingDuration } : {}),
        minOrderSize: market.minOrderSize,
        ...(action.kind === "exit" && action.limitPrice !== undefined ? { minimumPrice: action.limitPrice } : {}), budgetUsd: budget,
        minimumEdge, minimumNotional: action.kind === "enter" ? Math.max(this.d.config.risk.minViableNotional, action.minNotional ?? 0) : 0,
        filledSize: 0, filledNotionalUsd: 0, feeUsd: 0, children: [], priorMarketSize: heldSize,
        ...(entryAvgPrice !== undefined ? { entryAvgPrice } : {}),
        arrivalBid: bid, ...(external.asks.length ? { arrivalAsk: ask } : {}),
        reason: action.reason ?? (action.kind === "enter" ? "signal entry" : "position exit"), urgent: action.kind === "exit" && action.urgent === true,
        ...(typeof provenance?.signalId === "string" ? { signalId: provenance.signalId } : {}),
        ...(typeof provenance?.signalTs === "string" ? { signalTs: provenance.signalTs } : {}),
        ...(probability(rawQ) ? { qHeld: rawQ } : {}), ...(provenance ? { provenance } : {}),
        ...(action.kind === "exit" ? { lastExitDecision: action.urgent ? "urgent" as const : "normal" as const, lastExitEvaluationAt: exitEvaluatedAt } : {}) };
      c.parents[id] = p;
      this.refusals.resolve(`admit:${action.marketRef}`);
      if (p.side === "BUY") c.entryCooldowns[p.marketRef] = { admittedAt: now, refreshedAt: c.refreshedAt ?? 0 };
      await this.save();
      await this.workParent(p, market, snapshot);
      return { placed: false, executionId: id };
  }

  supervise(options: PredictionSupervisionOptions = {}): Promise<void> {
    // Latch pause synchronously so a signing operation currently awaiting IO cannot POST afterward.
    if (options.paused !== undefined) this.operatorPaused = options.paused;
    if (options.paused) { this.paused = true; this.safetyGeneration += 1; }
    return this.serial(async () => {
      this.requireSupport();
      const c = await this.load();
      this.paused = this.stopping || this.operatorPaused;
      if (options.signals) this.signals = options.signals;
      if (options.refreshedAt !== undefined && Number.isFinite(options.refreshedAt) && options.refreshedAt > (c.refreshedAt ?? 0)) c.refreshedAt = options.refreshedAt;
      for (const p of Object.values(c.parents).filter(active)) {
        const decision = options.exitDecisions?.[p.marketRef];
        if (p.side === "SELL" && decision && options.exitsEvaluatedAt !== undefined && options.exitsEvaluatedAt >= (p.lastExitEvaluationAt ?? 0)) {
          p.lastExitDecision = decision; p.lastExitEvaluationAt = options.exitsEvaluatedAt;
          if (decision === "urgent") p.urgent = true;
        }
      }
      for (const [marketRef, queued] of Object.entries(c.queuedExits)) {
        const action = queued.action;
        const decision = options.exitDecisions?.[marketRef];
        if (!action.urgent) {
          if (decision === "hold") { delete c.queuedExits[marketRef]; continue; }
          if ((decision === "normal" || decision === "urgent") && options.exitsEvaluatedAt !== undefined) queued.evaluatedAt = options.exitsEvaluatedAt;
          if (decision === "urgent") action.urgent = true;
          const freshness = Math.min(60_000, this.d.config.tickIntervalMin * 60_000);
          if (!action.urgent && (!decision || this.now() - queued.evaluatedAt > freshness)) continue;
        }
        if (this.paused || this.deferring() || Object.values(c.parents).some(p => p.marketRef === marketRef && active(p))) continue;
        const prior = Object.values(c.parents).filter(p => p.marketRef === marketRef && p.side === "BUY").sort((a, b) => b.admittedAt - a.admittedAt)[0];
        if (!prior) { delete c.queuedExits[marketRef]; continue; }
        let quantity: number;
        try { quantity = await this.rpc("token balance", () => this.d.adapter.tokenBalance!(this.d.account, prior.tokenId)); }
        catch (error) {
          if (!isTransientVenueError(error)) throw error;
          this.defer("queued exit", error);
          continue;
        }
        if (!(quantity > EPS)) { delete c.queuedExits[marketRef]; continue; }
        const positions: Position[] = [{ marketRef, tokenId: prior.tokenId, conditionId: prior.conditionId, outcome: prior.outcome, side: prior.outcome,
          size: quantity, avgPrice: prior.filledSize > 0 ? prior.filledNotionalUsd / prior.filledSize : 0 }];
        const result = await this.admitInternal(action, positions, queued.evaluatedAt);
        if (result.executionId) {
          c.parents[result.executionId]!.lastExitEvaluationAt = queued.evaluatedAt;
          delete c.queuedExits[marketRef];
        }
      }
      await this.save();
      if (options.routine && !this.deferral && this.lastReconciledAt !== undefined
        && this.now() - this.lastReconciledAt < IDLE_RECONCILE_MS && !this.needsFastSupervision(c)) return;
      let snapshot: PortfolioSnapshot | undefined;
      try { await this.reconcile(); }
      catch (error) {
        const anchor = Math.max(this.lastReconciledAt ?? 0, c.lastSettlementScanAt ?? 0, this.startedAt);
        if (isTransientVenueError(error) && this.now() - anchor <= SUPERVISION_STALE_MS) {
          // Orders stay resting; the engine skips new actions until a pass succeeds.
          this.defer("reconcile", error);
          await this.save();
          throw error;
        }
        // A persistent read failure keeps orders resting and retries; parents stop one at a
        // time through their own reconciliation-age and stale-supervision rules.
        this.defer("reconcile", error, DEFER_LOG_INTERVAL_MS);
        await this.save();
        throw error;
      }
      try { snapshot = await this.portfolioSnapshot(0); }
      catch (error) {
        if (!isTransientVenueError(error)) throw error;
        this.defer("snapshot", error);
      }
      let skipped = false;
      for (const p of Object.values(c.parents).filter(active)) {
        const pending = this.children(p).filter(child => working(child) && (child.reconciliationError || child.settlementError));
        if (this.paused) await this.stopParent(p, "execution paused");
        else if (pending.some(child => child.settlementError || !child.reconciliationTransient || this.now() - (child.reconciliationErrorSince ?? this.now()) > SUPERVISION_STALE_MS)) {
          await this.stopParent(p, "order reconciliation pending");
        } else if (pending.length) {
          // A throttled order read keeps the order resting; nothing is re-quoted from a partial view.
          skipped = true;
        } else if (p.status === "canceling") {
          await this.stopParent(p, p.cancelReason ?? "order cancellation pending");
        } else {
          try { await this.workParent(p, undefined, snapshot); }
          catch (error) {
            if (isTransientVenueError(error) && this.now() - Math.max(p.lastValidatedBookAt ?? p.admittedAt, this.startedAt) <= SUPERVISION_STALE_MS) {
              this.defer("work", error);
              skipped = true;
              continue;
            }
            await this.stopParent(p, `execution book unavailable: ${String(error)}`);
          }
        }
      }
      if (snapshot && !skipped) this.clearDeferral();
      await this.save();
    });
  }

  private needsFastSupervision(c: Checkpoint): boolean {
    return Object.values(c.parents).some(p => active(p)
      || (p.terminalAt !== undefined && this.now() - p.terminalAt < FILL_OVERLAP_MS))
      || Object.values(c.children).some(working)
      || Object.keys(c.queuedExits).length > 0
      || Object.values(c.settlements).some(fill => !["CONFIRMED", "FAILED"].includes(fill.status))
      || this.unownedOrderIds.size > 0;
  }

  private children(p: Parent): Child[] { return p.children.map(id => this.checkpoint!.children[id]!).filter(Boolean); }
  private remaining(p: Parent): number { return Math.max(0, p.targetSize - p.filledSize); }
  private normalize(size: number): number { return this.d.adapter.normalizeOrderSize?.(Math.max(0, size)) ?? Math.floor(Math.max(0, size) * 100) / 100; }

  private validateMarket(m: PredictionExecutionMarket, ref: string, outcome: "YES" | "NO", bidOnly = false): void {
    const b = m.book;
    if (m.marketRef !== ref || m.outcome !== outcome || !m.tokenId || !m.conditionId || !finitePositive(m.tickSize) || m.tickSize >= 1 || !finitePositive(m.minOrderSize)) throw new Error("invalid execution market identity or terms");
    if (!m.acceptingOrders || !Number.isFinite(m.observedAt) || this.now() - m.observedAt > BOOK_AGE_MS || m.observedAt - this.now() > 1000) throw new Error("market is not accepting orders or metadata is stale");
    if (!Number.isFinite(b.ts) || this.now() - b.ts > BOOK_AGE_MS || b.ts - this.now() > 1000) throw new Error("stale execution book");
    if (b.bids.some(l => !probability(l.price) || !finitePositive(l.size)) || b.asks.some(l => !probability(l.price) || !finitePositive(l.size))) throw new Error("invalid execution book levels");
    if (!b.bids.length || (!bidOnly && !b.asks.length) || (b.asks.length && b.bids[0]!.price >= b.asks[0]!.price)) throw new Error("empty or crossed execution book");
  }

  private externalBook(book: OrderBook, tokenId: string): OrderBook {
    const bids = book.bids.map(l => ({ ...l })); const asks = book.asks.map(l => ({ ...l }));
    for (const child of Object.values(this.checkpoint!.children).filter(c => working(c) && c.venueId && c.intent.tokenId === tokenId)) {
      const levels = child.intent.side === "BUY" ? bids : asks;
      const level = levels.find(l => Math.abs(l.price - child.intent.limitPrice) <= EPS);
      if (level) level.size = Math.max(0, level.size - Math.max(0, child.intent.size - child.observedMatched));
    }
    return { ...book, bids: bids.filter(l => l.size > EPS), asks: asks.filter(l => l.size > EPS) };
  }

  private async workParent(p: Parent, supplied?: PredictionExecutionMarket, snapshot?: PortfolioSnapshot): Promise<void> {
    const children = this.children(p);
    const current = children.find(working);
    if (p.status === "canceling") {
      if (current) await this.cancel(current, p.cancelReason ?? "parent stopped");
      else this.finishParent(p);
      return;
    }
    const entryCross = this.commodities && p.side === "BUY" && (this.d.config.strategy.config.entryStyle !== "adaptive" || this.now() >= p.deadlineAt);
    const polymarketEntry = !this.commodities && p.side === "BUY";
    const phase = polymarketEntry ? this.entryPhase(p) : undefined;
    if (phase === "expired") { await this.stopParent(p, p.crossingDeadlineAt === undefined ? "entry deadline" : "entry crossing window expired"); return; }
    if (entryCross && this.now() > p.deadlineAt + KALSHI_CROSSING_WINDOW_MS) { await this.stopParent(p, "entry crossing window expired"); return; }
    if (p.side === "SELL" && !p.urgent && p.lastExitDecision === "hold") { await this.stopParent(p, "exit condition cleared"); return; }
    if (this.remaining(p) <= EPS) { if (!current) this.finish(p, "completed"); return; }
    if ((p.fakSubmitted || p.crossingAt !== undefined) && !current) { this.finishParent(p); return; }
    if (current?.status === "canceling" || current?.status === "unknown" || current?.status === "signed") return;
    if (p.side === "BUY" && this.signals) {
      const signal = this.latestSignal(p.marketRef);
      const ttl = Math.min(this.d.config.signals.maxAgeSec, signal?.ttlSec ?? this.d.config.signals.maxAgeSec) * 1000;
      if (!signal || signal.side !== p.outcome || !probability(signal.prob) || !Number.isFinite(ttl) || ttl <= 0 || this.now() - Date.parse(signal.ts) > ttl || Date.parse(signal.ts) - this.now() > 1000) {
        await this.stopParent(p, "entry signal is no longer eligible"); return;
      }
      if (this.commodities && (signal.settlementBasis !== p.provenance?.settlementBasis || signal.rulesHash !== p.provenance?.rulesHash
        || !signal.endsAt || signal.endsAt - this.now() < this.strategyNumber("minHoursToClose", 2) * 3_600_000)) {
        await this.stopParent(p, "settlement terms changed or entry cutoff passed"); return;
      }
      p.maximumPrice = Math.min(p.maximumPrice, signal.prob - p.minimumEdge);
    }
    const m = supplied ?? await this.rpc("execution market", () => this.d.adapter.executionMarket!(p.marketRef, p.outcome));
    const crossing = entryCross || phase === "taker" || (p.side === "SELL" && (p.urgent || this.now() >= p.deadlineAt || this.remaining(p) + EPS < m.minOrderSize));
    this.validateMarket(m, p.marketRef, p.outcome, crossing && p.side === "SELL");
    if (m.tokenId !== p.tokenId || m.conditionId !== p.conditionId) throw new Error("execution token identity changed");
    const b = this.externalBook(m.book, m.tokenId);
    if (!b.bids.length || ((!crossing || p.side === "BUY") && !b.asks.length)) { await this.stopParent(p, "no external executable book"); return; }
    const bid = b.bids[0]!.price, ask = b.asks[0]?.price ?? bid, tick = m.tickSize;
    p.lastValidatedBookAt = Math.min(m.book.ts, m.observedAt);
    if (polymarketEntry && !current && this.remaining(p) + EPS < m.minOrderSize) { this.finish(p, "completed"); return; }
    if (phase === "taker" && p.crossingAt !== undefined && current) {
      // The crossing remainder rests at the bound until the window closes; it is never chased.
      if (current.intent.limitPrice > p.maximumPrice + EPS) await this.cancel(current, "price bound moved below the crossing remainder");
      return;
    }
    if (p.side === "BUY") {
      const latestSignal = this.latestSignal(p.marketRef);
      const signalQ = latestSignal?.side === p.outcome ? latestSignal.prob : this.signals ? undefined : p.qHeld;
      const maximumEdge = this.d.config.strategy.config.maxEntrySpreadPp === null ? Number.POSITIVE_INFINITY : this.strategyNumber("maxEntrySpreadPp", 30) / 100;
      if (!probability(signalQ) || (!this.commodities && (signalQ - (bid + ask) / 2 + EPS < p.minimumEdge || signalQ - (bid + ask) / 2 > maximumEdge + EPS))) {
        await this.stopParent(p, "live entry edge is outside its configured band"); return;
      }
      if (this.commodities) {
        const rawEdge = signalQ - ask;
        const rate = typeof p.provenance?.takerFeeRate === "number" ? p.provenance.takerFeeRate : NaN;
        const robust = (bid + ask) / 2 + this.strategyNumber("qWeight", .5) * (signalQ - (bid + ask) / 2) - this.strategyNumber("uncertaintyPp", 1) / 100;
        const fee = rate * (ask * (1 - ask) + robust * (1 - robust)) + .02;
        const fair = Math.min(p.qHeld ?? 0, robust - fee);
        if (!Number.isFinite(fair) || ask - bid > this.strategyNumber("maxSpread", .05) + EPS || rawEdge < this.strategyNumber("rawMinEdgePp", 5) / 100 - EPS
          || rawEdge > maximumEdge + EPS || fair - ask < p.minimumEdge - EPS) {
          await this.stopParent(p, "commodity executable edge or spread deteriorated"); return;
        }
        p.maximumPrice = Math.min(p.maximumPrice, floorTick(fair - p.minimumEdge, tick));
      }
      const exitDepth = b.bids.filter(level => level.price + EPS >= bid - .02).reduce((sum, level) => sum + level.size * level.price, 0);
      if (exitDepth + EPS < this.strategyNumber("minExitDepth2cUsd", 2500)) { await this.stopParent(p, "entry exit liquidity fell below its minimum"); return; }
      if (this.commodities && this.remaining(p) * p.maximumPrice > Math.min(exitDepth, (b.asks[0]?.size ?? 0) * ask) * this.strategyNumber("depthParticipationPct", 2) / 100 + EPS) {
        await this.stopParent(p, "commodity depth participation exceeded after book change"); return;
      }
      if (snapshot) {
        const headroom = await this.entryHeadroom(p, m, snapshot);
        if (this.remaining(p) * p.maximumPrice > headroom + EPS) { await this.stopParent(p, "parent commitment exceeds refreshed portfolio capacity"); return; }
      }
    }
    const age = this.now() - p.admittedAt;
    if (crossing && p.side === "SELL" && !p.urgent) {
      const freshness = Math.min(60_000, this.d.config.tickIntervalMin * 60_000);
      if (p.lastExitDecision !== "normal" || p.lastExitEvaluationAt === undefined || this.now() - p.lastExitEvaluationAt > freshness
        || (this.now() >= p.deadlineAt && p.lastExitEvaluationAt < p.deadlineAt)) {
        if (current) await this.cancel(current, "normal exit awaits fresh evaluation");
        return;
      }
    }
    let price: number;
    if (p.side === "BUY" && crossing && this.commodities) {
      price = floorTick(Math.min(ask, p.maximumPrice), tick);
      if (price < ask - EPS) { await this.stopParent(p, "marketable entry exceeds original price bound"); return; }
    } else if (p.side === "BUY" && crossing) {
      // Take every offer inside the bound; the remainder rests there at the top of the book.
      if (ask > p.maximumPrice + EPS) { await this.stopParent(p, "entry deadline reached with ask above price limit"); return; }
      price = floorTick(p.maximumPrice, tick);
    } else if (p.side === "BUY") {
      // Polymarket rests at the most aggressive maker price; Kalshi keeps its three-phase ladder.
      const ladder = age / this.entryDuration;
      const requested = !this.commodities ? ask - tick : ladder < .25 ? Math.min(bid + tick, ask - tick) : ladder < .5 ? floorTick((bid + ask) / 2, tick) : ask - tick;
      price = floorTick(Math.min(requested, ask - tick, p.maximumPrice), tick);
      if (price + EPS < bid || !(price > 0)) { await this.stopParent(p, "entry price bound is no longer competitive"); return; }
    } else if (crossing) {
      price = ceilTick(Math.max(bid * (1 - this.d.config.risk.slippagePct / 100), p.minimumPrice ?? tick), tick);
    } else {
      const phase = age / this.exitDuration;
      const requested = phase < 1 / 3 ? Math.max(ask - tick, bid + tick) : phase < 2 / 3 ? ceilTick((bid + ask) / 2, tick) : bid + tick;
      price = ceilTick(Math.max(requested, bid + tick, p.minimumPrice ?? tick), tick);
    }
    if (!probability(price)) { await this.stopParent(p, "invalid bounded order price"); return; }
    if (this.now() - m.book.ts > BOOK_AGE_MS) { await this.stopParent(p, "book expired during risk checks"); return; }
    if (current) {
      if (current.intent.postOnly === !crossing && Math.abs(current.intent.limitPrice - price) + EPS < tick) return;
      const safety = crossing || (p.side === "BUY" && current.intent.limitPrice > p.maximumPrice + EPS);
      // Without a portfolio view a resting order cannot be replaced, so it is not canceled for a phase change.
      if (!safety && (this.now() - current.createdAt < MINIMUM_REST_MS || (polymarketEntry && !snapshot))) return;
      await this.cancel(current, crossing ? (p.side === "BUY" ? "passive entry transitioning to marketable limit" : "passive exit transitioning to FAK") : "quote phase or external book changed");
      return;
    }
    if (Object.values(this.checkpoint!.children).some(c => working(c) && this.checkpoint!.parents[c.parentId]?.marketRef === p.marketRef)) return;
    if (this.heartbeatFailing) { this.refusals.refuse("heartbeat", "no new orders while the venue heartbeat is failing; resting orders expire on the venue"); return; }
    let size = this.normalize(this.remaining(p));
    if (p.side === "BUY") {
      if (!snapshot) return; // no new commitment while the account view is being retried
      const cash = snapshot.cash;
      const otherReserved = Object.values(this.checkpoint!.parents).filter(other => other.id !== p.id && active(other) && other.side === "BUY")
        .reduce((sum, other) => sum + this.remaining(other) * other.maximumPrice, 0);
      const unitCost = this.entryUnitCost(price, p.provenance);
      const cashUnitCost = unitCost * (polymarketEntry && crossing ? 1 + ENTRY_TAKER_FEE_ALLOWANCE : 1);
      size = this.normalize(Math.min(size, Math.max(0, p.budgetUsd - p.filledNotionalUsd - p.feeUsd) / unitCost, Math.max(0, cash - otherReserved) / cashUnitCost));
      // The crossing child is bounded by the target that passed capacity at admission; its
      // remainder rests as a maker, so the visible-depth participation cap does not apply.
      if (!(polymarketEntry && crossing)) {
        const cap = checkCapacity({ side: "BUY", desiredSize: size, refPrice: price, book: b, quote: m.quote, risk: this.d.config.risk, enforceMinimumNotional: false });
        if (!cap.ok) { await this.stopParent(p, "entry no longer passes volume or depth checks"); return; }
        size = this.normalize(cap.size);
      }
      if (size + EPS < m.minOrderSize) { await this.stopParent(p, "remaining entry is below venue minimum"); return; }
    } else {
      const balance = await this.rpc("token balance", () => this.d.adapter.tokenBalance!(this.d.account, p.tokenId, { refresh: true }));
      if (!Number.isFinite(balance) || balance < 0) throw new Error("invalid authenticated token balance");
      size = this.normalize(Math.min(size, balance));
      if (crossing) {
        const depth = b.bids.filter(l => l.price + EPS >= price).reduce((sum, l) => sum + l.size, 0);
        size = this.normalize(Math.min(size, depth * this.d.config.risk.depthCapPct / 100, this.d.config.risk.maxOrderNotional / bid));
      }
    }
    if (!(size > EPS)) { await this.stopParent(p, crossing ? "exit has no executable size inside price bound" : "no free order size"); return; }
    if (!crossing && size + EPS < m.minOrderSize) { await this.stopParent(p, "order remainder is below venue minimum"); return; }
    if (polymarketEntry && crossing) {
      this.d.log.info("prediction entry crossing", { executionId: p.id, ask, cap: p.maximumPrice, price, size, windowEndsAt: p.crossingDeadlineAt });
    }
    await this.place(p, { marketRef: p.marketRef, tokenId: p.tokenId, conditionId: p.conditionId, outcome: p.outcome, side: p.side, size, limitPrice: price,
      tif: crossing ? (this.commodities || p.side === "SELL" ? "FAK" : "GTC") : "GTC", postOnly: !crossing,
      ...(this.commodities && !crossing ? { expiration: Math.ceil(Math.max(this.now() + 1000, p.deadlineAt) / 1000) } : {}),
      purpose: p.side === "BUY" ? "entry" : p.urgent ? "urgent-exit" : "normal-exit", clientId: "" }, m);
  }

  private async place(p: Parent, intent: OrderIntent, m: PredictionExecutionMarket): Promise<void> {
    const c = this.checkpoint!;
    const generation = this.safetyGeneration;
    const id = `${p.id}:child:${++c.sequence}`;
    intent.clientId = id;
    const child: Child = { id, parentId: p.id, intent, status: "reserved", createdAt: this.now(), observedMatched: 0, confirmedSize: 0, failedSize: 0 };
    c.children[id] = child; p.children.push(id);
    if (intent.tif === "FAK") p.fakSubmitted = true;
    if (!this.commodities && intent.side === "BUY" && !intent.postOnly) p.crossingAt = this.now();
    await this.save();
    let stoppedBeforePost = false;
    try {
      const ack = await this.rpc("order submission", () => this.d.adapter.placeOrderWithLifecycle!(this.d.account, intent, { onPrepared: async meta => {
        const horizon = intent.postOnly ? p.deadlineAt : this.commodities ? p.deadlineAt + KALSHI_CROSSING_WINDOW_MS : (p.crossingDeadlineAt ?? p.deadlineAt);
        if (this.paused || this.stopping || generation !== this.safetyGeneration || p.status !== "active" || this.now() - m.book.ts > BOOK_AGE_MS || (p.side === "BUY" && this.now() >= horizon)) {
          stoppedBeforePost = true; throw new Error("execution authorization or book expired before POST");
        }
        if (meta.tokenId !== p.tokenId || (meta.conditionId && meta.conditionId !== p.conditionId)) { stoppedBeforePost = true; throw new Error("prepared token identity mismatch"); }
        const signedPrice = meta.limitPrice ?? intent.limitPrice, signedSize = meta.size ?? intent.size;
        if (!probability(signedPrice) || !finitePositive(signedSize) || signedSize > intent.size + EPS || (intent.side === "BUY" ? signedPrice > intent.limitPrice + EPS : signedPrice + EPS < intent.limitPrice)) {
          stoppedBeforePost = true; throw new Error("prepared terms exceed authorized size or price");
        }
        child.intent = { ...intent, limitPrice: signedPrice, size: signedSize };
        child.preparedHash = meta.preparedHash; child.status = "signed"; await this.save();
        if (generation !== this.safetyGeneration) { stoppedBeforePost = true; throw new Error("execution halted before POST"); }
      } }), () => { this.safetyGeneration += 1; });
      child.venueId = ack.orderId;
      child.observedMatched = ack.filledSize ?? (ack.status === "filled" ? child.intent.size : 0);
      child.status = ack.status === "rejected" ? "rejected" : "open";
      if (!ack.orderId && child.status !== "rejected") throw new Error("venue acknowledgement omitted order id");
      if (ack.status === "canceled") { child.status = "canceling"; child.cancelRequestedAt = this.now(); }
      this.portfolio = undefined;
      await this.save();
      this.d.log.info("prediction order acknowledged", { executionId: p.id, orderId: child.venueId, side: p.side, outcome: p.outcome, size: child.intent.size, price: child.intent.limitPrice, postOnly: intent.postOnly });
      if (generation !== this.safetyGeneration || this.paused) await this.cancel(child, "acknowledgement arrived after stop");
    } catch (error) {
      const rejected = stoppedBeforePost || (error as { submissionRejected?: boolean })?.submissionRejected === true || !child.preparedHash;
      child.status = rejected ? "rejected" : "unknown";
      child.error = String(error);
      // An ambiguous POST reserves only this market until the venue shows whether it landed.
      if (!rejected) { child.unknownSince = this.now(); child.unknownPasses = 0; }
      await this.save();
      this.d.log.warn("prediction submission failed", { executionId: p.id, marketRef: p.marketRef, ambiguous: !rejected, error: String(error) });
    }
    if (working(child)) await this.heartbeat().catch(() => undefined);
  }

  /** Recheck portfolio caps without mistaking a delayed public position for free risk. */
  private async entryHeadroom(parent: Parent, market: PredictionExecutionMarket, snapshot: PortfolioSnapshot): Promise<number> {
    const c = this.checkpoint!;
    const { cash, positions } = snapshot;
    const exposure = new Map<string, number>();
    let positionValue = 0;
    for (const position of positions) {
      if (!(position.size > EPS)) continue;
      exposure.set(position.marketRef, (exposure.get(position.marketRef) ?? 0) + position.size * position.avgPrice);
      positionValue += positionMarketValue(position);
    }
    // Authenticated token balances supply inventory that the public position index has not caught up with.
    for (const [tokenId, quantity] of snapshot.tokenBalances) {
      const tracked = Object.values(c.parents).filter(candidate => candidate.tokenId === tokenId);
      const p = tracked.sort((a, b) => b.admittedAt - a.admittedAt)[0];
      if (!p) continue;
      const visible = positions.filter(position => position.tokenId === tokenId || (position.marketRef === p.marketRef && (position.outcome ?? position.side) === p.outcome));
      const invisible = Math.max(0, quantity - visible.reduce((sum, position) => sum + position.size, 0));
      if (invisible <= INVENTORY_DUST_SHARES + EPS) for (const candidate of tracked) candidate.inventoryObserved = true;
      const average = p.filledSize > 0 ? p.filledNotionalUsd / p.filledSize : visible[0]?.avgPrice ?? p.maximumPrice;
      exposure.set(p.marketRef, (exposure.get(p.marketRef) ?? 0) + invisible * average);
      positionValue += invisible * (p.tokenId === market.tokenId ? market.quote.mid : average);
    }
    let otherReserved = 0;
    for (const p of Object.values(c.parents).filter(p => p.id !== parent.id && active(p) && p.side === "BUY")) {
      const reserve = this.remaining(p) * p.maximumPrice;
      otherReserved += reserve;
      exposure.set(p.marketRef, (exposure.get(p.marketRef) ?? 0) + reserve);
    }
    const cfg = this.d.config.strategy.config;
    const mode = cfg.allocationMode ?? ("dailyBudgetUsd" in cfg || "positionBudgetPct" in cfg ? "daily-budget" : "portfolio-kelly");
    let headroom = Math.max(0, cash - otherReserved);
    if (mode === "daily-budget") {
      const today = new Date(this.now()).toISOString().slice(0, 10);
      return Math.min(headroom, Math.max(0, this.strategyNumber("dailyBudgetUsd", 100) - (c.dailySpentUsd[today] ?? 0) - otherReserved));
    }
    const equity = cash + positionValue;
    if (this.commodities) {
      const asset = parent.provenance?.asset, direction = parent.provenance?.direction;
      const allowed = ["oil", "gold", "btc", "copper", "silver"];
      const theme = (a: string): string => ["oil", "copper"].includes(a) ? "cyclical" : "monetary";
      if (typeof asset !== "string" || !allowed.includes(asset) || typeof direction !== "string") return 0;
      let gross = 0, sameAsset = 0, sameTheme = 0, sameDirection = 0;
      for (const [ref, cost] of exposure) {
        if (cost <= EPS) continue;
        const identity = ref === parent.marketRef ? parent : Object.values(c.parents).find(p => p.marketRef === ref && p.provenance?.asset);
        const otherAsset = identity?.provenance?.asset, otherDirection = identity?.provenance?.direction;
        if (typeof otherAsset !== "string" || !allowed.includes(otherAsset) || typeof otherDirection !== "string") return 0;
        if (otherAsset === asset && ref !== parent.marketRef) return 0;
        gross += cost;
        if (otherAsset === asset) sameAsset += cost;
        if (theme(otherAsset) === theme(asset)) sameTheme += cost;
        if (otherDirection === direction) sameDirection += cost;
      }
      headroom = Math.min(headroom, equity * this.strategyNumber("grossCapPct", 10) / 100 - gross,
        equity * this.strategyNumber("assetCapPct", 2.5) / 100 - sameAsset,
        equity * this.strategyNumber("themeCapPct", 5) / 100 - sameTheme,
        equity * this.strategyNumber("directionCapPct", 6) / 100 - sameDirection);
    }
    const refs = [...new Set([parent.marketRef, ...[...exposure].filter(([, amount]) => amount > EPS).map(([ref]) => ref)])];
    const events = new Map(await Promise.all(refs.map(async ref => [ref, await this.rpc("event identity", async () => this.d.adapter.eventRef?.(ref))] as const)));
    const event = events.get(parent.marketRef);
    if (!event) return 0;
    let eventExposure = 0;
    for (const [ref, amount] of exposure) {
      if (!(amount > EPS)) continue;
      const candidate = events.get(ref);
      if (!candidate) return 0;
      if (candidate === event) eventExposure += amount;
    }
    headroom = Math.min(headroom, Math.max(0, equity * this.strategyNumber("marketCapPct", 2.5) / 100 - (exposure.get(parent.marketRef) ?? 0)),
      Math.max(0, equity * this.strategyNumber("eventCapPct", 5) / 100 - eventExposure));
    return headroom;
  }

  private async reconcile(timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<void> {
    const c = await this.load();
    const oldest = Math.min(c.lastSettlementScanAt ?? c.initializedAt, ...Object.values(c.children).filter(working).map(child => child.createdAt),
      ...Object.values(c.settlements).filter(settlement => !["CONFIRMED", "FAILED"].includes(settlement.status)).map(settlement => settlement.ts));
    const scanStartedAt = this.now();
    const fills = await this.rpc("trade settlements", () => this.d.adapter.tradeSettlements!(this.d.account, Math.max(0, oldest - FILL_OVERLAP_MS)), undefined, timeoutMs);
    for (const fill of fills) this.applySettlement(fill);
    const orders = await this.rpc("open orders", () => this.d.adapter.openOrders(this.d.account), undefined, timeoutMs);
    const owned = new Set(Object.values(c.children).flatMap(child => child.venueId ? [child.venueId] : []));
    for (const child of Object.values(c.children).filter(child => child.status === "unknown")) await this.resolveUnknown(child, orders, fills, owned);
    this.noteUnownedOrders(orders, owned);
    await Promise.all(Object.values(c.children).filter(working).map(async child => {
      if (!child.venueId) return;
      try {
        await this.reconcileChild(child, orders);
        child.reconciliationError = undefined;
        child.reconciliationErrorSince = undefined;
        child.reconciliationTransient = undefined;
      } catch (error) {
        const message = String(error);
        if (child.reconciliationError !== message) this.d.log.warn("prediction order reconciliation pending", { orderId: child.venueId, error: message });
        child.reconciliationError = message;
        child.reconciliationErrorSince ??= this.now();
        child.reconciliationTransient = isTransientVenueError(error);
        this.resetTerminalObservations(child);
      }
    }));
    for (const p of Object.values(c.parents).filter(active)) {
      if (!this.children(p).some(working)) {
        if (p.status === "canceling" || p.filledSize + EPS >= p.targetSize || p.fakSubmitted || p.crossingAt !== undefined) this.finishParent(p);
      }
    }
    this.lastReconciledAt = scanStartedAt;
    c.lastSettlementScanAt = scanStartedAt;
    await this.save();
    await this.alertConfirmedFills();
  }

  /** One bad settlement record pins its own order; it no longer aborts the pass for every market. */
  private applySettlement(fill: Fill): void {
    const c = this.checkpoint!;
    const child = Object.values(c.children).find(o => o.venueId === (fill.makerOrderId ?? fill.orderId));
    try { this.applyFill(fill); if (child) delete child.settlementError; }
    catch (error) {
      const message = String(error);
      if (!child) { this.refusals.refuse(`settlement:${fill.id}`, "prediction settlement could not be applied", { fillId: fill.id, error: message }); return; }
      if (child.settlementError !== message) this.d.log.warn("prediction settlement inconsistent with its order", { orderId: child.venueId, error: message });
      child.settlementError = message;
      this.resetTerminalObservations(child);
    }
  }

  /**
   * A signed POST whose answer was lost is resolved from what the venue shows: an unowned
   * order with the signed terms is adopted, an unowned settlement on the parent's token is
   * adopted, and an unchanged inventory after a short wait means the order never landed.
   * Only this market waits meanwhile.
   */
  private async resolveUnknown(child: Child, orders: Order[], fills: Fill[], owned: Set<string>): Promise<void> {
    const c = this.checkpoint!;
    const p = c.parents[child.parentId]!;
    const since = child.createdAt - 5_000;
    const adopt = (venueId: string, how: string): void => {
      child.venueId = venueId; child.status = "open"; owned.add(venueId);
      child.unknownSince = undefined; child.unknownPasses = undefined;
      this.refusals.resolve(`unknown:${child.id}`);
      this.d.log.info(`prediction submission adopted ${how}`, { executionId: p.id, orderId: venueId, marketRef: p.marketRef });
    };
    const order = orders.find(o => !owned.has(o.id) && o.tokenId === child.intent.tokenId && o.side === child.intent.side
      && Math.abs(o.price - child.intent.limitPrice) <= EPS && Math.abs(o.size - child.intent.size) <= .011 && (o.createdAt === undefined || o.createdAt >= since));
    if (order) { adopt(order.id, "from the venue's open orders"); child.observedMatched = Math.max(child.observedMatched, order.filledSize); return; }
    const settled = fills.find(f => { const id = f.makerOrderId ?? f.orderId; return id !== undefined && !owned.has(id) && f.tokenId === p.tokenId && f.side === p.side && f.ts >= since; });
    if (settled) {
      const venueId = (settled.makerOrderId ?? settled.orderId)!;
      adopt(venueId, "from a settlement");
      for (const fill of fills) if ((fill.makerOrderId ?? fill.orderId) === venueId) this.applySettlement(fill);
      return;
    }
    child.unknownPasses = (child.unknownPasses ?? 0) + 1;
    const unknownFor = this.now() - (child.unknownSince ?? child.createdAt);
    if (child.unknownPasses < 2 || unknownFor < AMBIGUOUS_RESOLVE_MS) return;
    let quantity: number;
    try { quantity = await this.rpc("ambiguous-order token balance", () => this.d.adapter.tokenBalance!(this.d.account, p.tokenId, { refresh: true })); }
    catch (error) { this.refusals.refuse(`unknown:${child.id}`, "ambiguous submission awaits an inventory read", { executionId: p.id, marketRef: p.marketRef, error: String(error) }); return; }
    const expected = p.priorMarketSize + (p.side === "BUY" ? 1 : -1) * p.filledSize;
    if (Number.isFinite(quantity) && Math.abs(quantity - expected) <= INVENTORY_DUST_SHARES + EPS) {
      child.status = "rejected"; child.error = "no order, settlement or inventory change observed after an ambiguous submission";
      this.refusals.resolve(`unknown:${child.id}`);
      this.d.log.info("prediction submission resolved as not placed", { executionId: p.id, marketRef: p.marketRef, unknownForMs: unknownFor });
      return;
    }
    if (unknownFor >= FILL_OVERLAP_MS) {
      child.status = "terminal"; child.error = "ambiguous submission released after the settlement window with unattributed inventory";
      this.refusals.resolve(`unknown:${child.id}`);
      this.d.log.warn("prediction submission released with unattributed inventory", { executionId: p.id, marketRef: p.marketRef, quantity, expected });
      return;
    }
    this.refusals.refuse(`unknown:${child.id}`, "ambiguous submission has unattributed inventory; awaiting settlement", { executionId: p.id, marketRef: p.marketRef, quantity, expected });
  }

  /** Orders this executor did not place (an operator's manual order, a lost receipt) pause entries in their market only. */
  private noteUnownedOrders(orders: Order[], owned: Set<string>): void {
    const unowned = orders.filter(order => !owned.has(order.id));
    const ids = new Set(unowned.map(order => order.id));
    for (const order of unowned) {
      if (!this.unownedOrderIds.has(order.id)) this.d.log.warn("unowned open order; entries in its market wait until it clears", { orderId: order.id, marketRef: order.marketRef, side: order.side, price: order.price, size: order.size });
    }
    for (const id of this.unownedOrderIds) if (!ids.has(id)) this.d.log.info("unowned open order cleared", { orderId: id });
    this.unownedOrderIds = ids;
    this.unownedMarkets = new Set(unowned.map(order => order.marketRef));
  }

  private resetTerminalObservations(child: Child): void {
    child.terminalFirstObservedAt = undefined;
    child.terminalObservedAt = undefined;
    child.terminalObservations = 0;
  }

  private observeTerminal(child: Child, waitMs: number, since = 0): boolean {
    const observedAt = this.now();
    child.terminalFirstObservedAt ??= observedAt;
    if (observedAt > (child.terminalObservedAt ?? 0)) {
      child.terminalObservedAt = observedAt;
      child.terminalObservations = (child.terminalObservations ?? 0) + 1;
    }
    return (child.terminalObservations ?? 0) >= 2 && observedAt - Math.max(since, child.terminalFirstObservedAt) >= waitMs;
  }

  private async reconcileChild(child: Child, orders: Order[]): Promise<void> {
      const listed = orders.some(candidate => candidate.id === child.venueId);
      // Confirmed settlement for the entire signed quantity is terminal even if
      // the venue has already discarded its order-detail record (notably FAKs).
      if (!listed && child.confirmedSize + EPS >= child.intent.size && !this.pendingSettlements(child)) {
        if (this.observeTerminal(child, 5000)) child.status = "terminal";
        return;
      }
      const order = await this.rpc("order state", () => this.d.adapter.executionOrder!(this.d.account, child.venueId!));
      if (listed || order?.status === "open" || order?.status === "unknown") {
        if (listed || order?.status === "open") { child.cancelAcceptedAt = undefined; child.notOpenAt = undefined; }
        this.resetTerminalObservations(child);
      }
      if (!order && (child.cancelAcceptedAt !== undefined || child.notOpenAt !== undefined) && !listed) {
        // A confirmed cancellation plus repeated absence can outlive the venue's
        // order-detail record. Keep the reservation for the full late-fill window
        // and reconcile every known match before releasing it.
        if (child.notOpenAt !== undefined && child.cancelAcceptedAt === undefined) {
          const parent = this.checkpoint!.parents[child.parentId]!;
          const quantity = await this.rpc("missing-order token balance", () => this.d.adapter.tokenBalance!(this.d.account, parent.tokenId, { refresh: true }));
          const expected = parent.priorMarketSize + (parent.side === "BUY" ? 1 : -1) * parent.filledSize;
          // A missing trade or external inventory change keeps this market
          // reserved. Never manufacture a fill from the inventory difference.
          if (!Number.isFinite(quantity) || Math.abs(quantity - expected) > INVENTORY_DUST_SHARES + EPS) {
            this.resetTerminalObservations(child);
            return;
          }
        }
        if (this.observeTerminal(child, FILL_OVERLAP_MS, child.cancelAcceptedAt ?? child.notOpenAt) &&
          child.confirmedSize + child.failedSize + EPS >= child.observedMatched &&
          !this.pendingSettlements(child)) child.status = "terminal";
        return;
      }
      if (!order || order.status === "unknown") return;
      if (order.orderId !== child.venueId || Math.abs(order.size - child.intent.size) > .011 || !Number.isFinite(order.matchedSize) || order.matchedSize < 0 || order.matchedSize > child.intent.size + EPS || !Number.isFinite(order.observedAt) || this.now() - order.observedAt > BOOK_AGE_MS || order.observedAt - this.now() > 1000) throw new Error(`invalid authoritative order state for ${child.id}`);
      child.observedMatched = Math.max(child.observedMatched, order.matchedSize);
      const terminal = ["matched", "canceled", "expired"].includes(order.status) && !listed;
      if (terminal && this.observeTerminal(child, 5000) && child.confirmedSize + child.failedSize + EPS >= child.observedMatched && !this.pendingSettlements(child)) child.status = "terminal";
  }

  /** Persist deduplication before best-effort delivery; notifications never block execution. */
  private async alertConfirmedFills(): Promise<void> {
    if (!this.d.alerter) return;
    const c = this.checkpoint!;
    const pending = Object.entries(c.settlements).filter(([, fill]) => fill.status === "CONFIRMED" && fill.alertedAt === undefined);
    if (!pending.length) return;
    for (const [, fill] of pending) fill.alertedAt = this.now();
    await this.save();
    for (const [settlementId, fill] of pending) {
      const child = c.children[fill.childId]!;
      const parent = c.parents[child.parentId]!;
      const held = this.portfolio?.positions.find(p => parent.tokenId !== undefined && p.tokenId === parent.tokenId)
        ?? this.portfolio?.positions.find(p => p.marketRef === parent.marketRef && (p.outcome ?? p.side) === parent.outcome);
      const pnl = parent.side === "SELL"
        ? closingPnl(parent.entryAvgPrice ?? held?.avgPrice, parent.outcome, fill.quantity, fill.price, fill.fee, "realized")
          ?? (typeof parent.provenance?.executablePnlPct === "number" ? { pct: parent.provenance.executablePnlPct, basis: "executable" as const } : undefined)
        : undefined;
      void this.rpc("fill notification", () => this.d.alerter!.send({
        kind: parent.side === "BUY" ? "entry" : "exit", botId: this.d.botId,
        message: `${parent.side === "BUY" ? "Entry" : "Exit"} filled: ${fill.quantity} ${parent.outcome} @ ${fill.price}`,
        data: { executionId: parent.id, orderId: child.venueId, settlementId, marketRef: parent.marketRef,
          feeUsd: fill.fee, maker: child.intent.postOnly === true, reason: parent.reason },
        at: new Date(Number.isFinite(fill.ts) ? fill.ts : this.now()).toISOString(),
        venue: this.d.adapter.id, strategy: this.d.config.strategy.id,
        market: { ref: parent.marketRef, ...(held?.label ? { title: held.label } : {}), outcome: parent.outcome,
          ...(this.d.adapter.id === "polymarket" ? { tokenId: parent.tokenId, conditionId: parent.conditionId } : {}) },
        trade: { side: parent.side, size: fill.quantity, price: fill.price, notionalUsd: fill.quantity * fill.price,
          ...(fill.fee !== undefined ? { feeUsd: fill.fee } : {}), ...(child.venueId ? { orderId: child.venueId } : {}),
          maker: child.intent.postOnly === true, positionSide: parent.outcome, filled: true },
        ...(pnl ? { pnl } : {}),
        ...(parent.reason ? { reason: parent.reason } : {}),
      })).catch(error => this.d.log.warn("prediction fill notification failed", { error: String(error) }));
    }
  }

  private pendingSettlements(child: Child): boolean {
    return Object.values(this.checkpoint!.settlements).some(s => s.childId === child.id && s.status !== "CONFIRMED" && s.status !== "FAILED");
  }

  private applyFill(fill: Fill): void {
    const c = this.checkpoint!;
    const child = Object.values(c.children).find(o => o.venueId === (fill.makerOrderId ?? fill.orderId));
    if (!child) return;
    const parent = c.parents[child.parentId]!;
    const quantity = fill.matchedAmountDelta ?? fill.size;
    if (!fill.id || !finitePositive(quantity) || !probability(fill.price) || !Number.isFinite(fill.fee ?? 0) || (fill.fee ?? 0) < 0 || fill.tokenId !== parent.tokenId || fill.side !== parent.side || fill.outcome !== parent.outcome || (fill.conditionId && fill.conditionId !== parent.conditionId)) throw new Error(`invalid settlement terms for ${child.id}`);
    const status = fill.settlementStatus ?? "CONFIRMED";
    const settlementId = `${fill.id}:${child.venueId}`;
    const previous = c.settlements[settlementId];
    if (previous && (previous.childId !== child.id || Math.abs(previous.quantity - quantity) > EPS || Math.abs(previous.price - fill.price) > EPS)) throw new Error(`settlement identity changed for ${fill.id}`);
    if (previous?.status === "CONFIRMED") return;
    if (previous?.status === "FAILED") { if (status !== "FAILED") throw new Error(`failed settlement changed for ${fill.id}`); return; }
    c.settlements[settlementId] = { childId: child.id, quantity, price: fill.price, fee: fill.fee ?? 0, ts: fill.ts, status };
    const childSettlements = Object.values(c.settlements).filter(s => s.childId === child.id);
    const observed = childSettlements.reduce((sum, s) => sum + s.quantity, 0);
    if (observed > child.intent.size + EPS) throw new Error(`settlements exceed child order ${child.id}`);
    child.observedMatched = Math.max(child.observedMatched, observed);
    if (status === "FAILED") { child.failedSize += quantity; return; }
    if (status !== "CONFIRMED") return;
    child.confirmedSize += quantity;
    parent.filledSize += quantity;
    parent.filledNotionalUsd += quantity * fill.price;
    parent.feeUsd += fill.fee ?? 0;
    parent.firstFillAt = Math.min(parent.firstFillAt ?? fill.ts, fill.ts);
    parent.lastFillAt = Math.max(parent.lastFillAt ?? fill.ts, fill.ts);
    parent.inventoryObserved = false;
    this.portfolio = undefined;
    this.d.adapter.invalidateTokenBalance?.(parent.tokenId);
    if (parent.filledSize > parent.targetSize + EPS) throw new Error(`fills exceed parent target ${parent.id}`);
    if (parent.side === "BUY") {
      const day = new Date(fill.ts).toISOString().slice(0, 10);
      c.dailySpentUsd[day] = (c.dailySpentUsd[day] ?? 0) + quantity * fill.price + (fill.fee ?? 0);
    }
    const pnl = parent.side === "SELL" ? closingPnl(parent.entryAvgPrice, parent.outcome, quantity, fill.price, fill.fee, "realized") : undefined;
    this.d.log.info("prediction fill confirmed", { executionId: parent.id, orderId: child.venueId, side: parent.side, size: quantity, price: fill.price, fee: fill.fee ?? 0,
      ...(parent.entryAvgPrice !== undefined ? { entryAvgPrice: parent.entryAvgPrice } : {}), ...(pnl ? { pnlUsd: pnl.usd, pnlPct: pnl.pct } : {}) });
  }

  private async cancel(child: Child, reason: string): Promise<void> {
    if (!working(child)) return;
    // Reconciliation clears this acknowledgement if the order is observed live.
    if (child.cancelAcceptedAt !== undefined || child.notOpenAt !== undefined || child.confirmedSize + EPS >= child.intent.size || child.observedMatched + EPS >= child.intent.size) return;
    if (child.nextCancelAt !== undefined && this.now() < child.nextCancelAt) return;
    if (child.status === "reserved") { child.status = "rejected"; await this.save(); return; }
    if (child.status !== "unknown") child.status = "canceling";
    child.cancelRequestedAt ??= this.now();
    await this.save();
    if (!child.venueId) return;
    try {
      const result = await this.rpc("order cancellation", () => this.d.adapter.cancelOrderChecked!(this.d.account, child.venueId!));
      this.recordCancellation(child, result);
      this.d.log.info("prediction cancellation requested", { executionId: child.parentId, orderId: child.venueId, reason, confirmed: result.status === "canceled", ...(result.notOpen ? { notOpen: true } : {}) });
    } catch (error) { child.error = String(error); child.cancelFailures = (child.cancelFailures ?? 0) + 1; this.d.log.warn("prediction cancellation remains pending", { orderId: child.venueId, error: String(error) }); }
    if (child.cancelFailures) child.nextCancelAt = this.now() + Math.min(60_000, 5000 * 2 ** Math.min(child.cancelFailures - 1, 4));
    await this.save();
  }

  private recordCancellation(child: Child, result: PredictionCancellationResult): void {
    if (result.status === "canceled") { child.cancelFailures = 0; child.cancelAcceptedAt = this.now(); child.nextCancelAt = undefined; }
    else if (result.notOpen) { child.cancelFailures = 0; child.notOpenAt ??= this.now(); child.nextCancelAt = undefined; child.error = result.reason; }
    else {
      child.error = result.reason ?? "venue did not cancel order";
      child.cancelFailures = (child.cancelFailures ?? 0) + 1;
      child.nextCancelAt = this.now() + Math.min(60_000, 5000 * 2 ** Math.min(child.cancelFailures - 1, 4));
    }
  }

  private async stopParent(parent: Parent, reason: string): Promise<void> {
    if (!active(parent)) return;
    parent.status = "canceling";
    parent.cancelReason = reason;
    await this.save();
    for (const child of this.children(parent).filter(working)) await this.cancel(child, reason);
    if (!this.children(parent).some(working)) this.finishParent(parent);
    await this.save();
  }

  private finish(p: Parent, status: "completed" | "canceled"): void { p.status = status; p.terminalAt ??= this.now(); }
  /** A parent that crossed is complete once nothing tradable remains; otherwise it ends as canceled-with-partial. */
  private finishParent(p: Parent): void {
    const remaining = this.remaining(p);
    const untradable = p.crossingAt !== undefined && p.minOrderSize !== undefined && remaining + EPS < p.minOrderSize;
    const status = remaining <= EPS || untradable ? "completed" : "canceled";
    this.finish(p, status);
    if (p.crossingAt !== undefined) this.d.log.info("prediction entry crossing finished", { executionId: p.id, filledSize: p.filledSize, remaining, status });
  }
  cancelMarket(marketRef: string, reason: string): Promise<void> {
    this.safetyGeneration += 1;
    return this.serial(async () => { const c = await this.load(); delete c.queuedExits[marketRef]; for (const p of Object.values(c.parents).filter(p => active(p) && p.marketRef === marketRef)) await this.stopParent(p, reason); });
  }

  cancelAll(reason = "execution stopped"): Promise<void> {
    this.operatorPaused = true; this.paused = true; this.safetyGeneration += 1;
    return this.serial(async () => { const c = await this.load(); c.queuedExits = {}; for (const p of Object.values(c.parents).filter(active)) await this.stopParent(p, reason); await this.reconcile(); });
  }

  /** Permanent, synchronous admission latch used before the runtime drains a slow tick. */
  beginShutdown(): Promise<void> {
    this.stopping = true;
    this.paused = true;
    this.safetyGeneration += 1;
    return this.cancelAll("runtime shutting down");
  }

  /** Operator resume clears the pause; order state is resolved by ordinary reconciliation. */
  resume(): Promise<void> {
    return this.serial(async () => {
      if (this.stopping) throw new Error("prediction execution is shutting down");
      await this.load();
      this.operatorPaused = false;
      this.paused = false;
      try { await this.reconcile(COLD_START_TIMEOUT_MS); }
      catch (error) {
        if (!isTransientVenueError(error)) throw error;
        this.defer("reconcile", error);
      }
      await this.save();
    });
  }

  /** Independent safety lane: never queues a heartbeat behind slow strategy or venue reads. */
  async heartbeat(): Promise<boolean> {
    const c = await this.load();
    // With nothing resting there is nothing to renew, except to learn that a failing venue heartbeat has recovered.
    if (!Object.values(c.children).some(working) && !this.heartbeatFailing) return false;
    if (this.heartbeatPending) return this.heartbeatPending;
    const pending = (async () => {
      const resting = Object.values(c.children).filter(child => working(child) && child.intent.tif === "GTC" &&
        child.confirmedSize + EPS < child.intent.size && child.observedMatched + EPS < child.intent.size &&
        child.cancelAcceptedAt === undefined && child.notOpenAt === undefined &&
        (child.nextCancelAt === undefined || this.now() >= child.nextCancelAt));
      // A post-only child expires at the maker deadline; a crossing remainder at the end of its window.
      const horizon = (child: Child): number => {
        const parent = c.parents[child.parentId]!;
        return child.intent.postOnly ? parent.deadlineAt : (parent.crossingDeadlineAt ?? parent.deadlineAt);
      };
      const expired = resting.filter(child => this.now() >= horizon(child));
      if (expired.length) {
        // Ordinary deadlines cancel immediately without turning a scheduled expiry
        // into a permanent account halt. Suppress this beat until cancellation is known.
        this.safetyGeneration += 1;
        const results = await Promise.all(expired.map(async child => ({ child, result: child.venueId
          ? await this.rpc("deadline cancellation", () => this.d.adapter.cancelOrderChecked!(this.d.account, child.venueId!)) : undefined })));
        void this.serial(async () => {
          for (const { child, result } of results) {
            const parent = c.parents[child.parentId]!;
            // A maker child expiring with a crossing window ahead is only canceled; the supervise lane crosses.
            if (parent.side === "BUY" && !this.commodities && this.now() >= (parent.crossingDeadlineAt ?? parent.deadlineAt)) {
              parent.status = "canceling"; parent.cancelReason = parent.crossingDeadlineAt === undefined ? "entry deadline" : "entry crossing window expired";
            }
            if (working(child) && child.venueId) {
              child.status = "canceling"; child.cancelRequestedAt ??= this.now();
              if (result) this.recordCancellation(child, result);
            }
          }
          await this.save();
        }).catch(error => this.d.log.error("prediction deadline persistence failed", { error: String(error) }));
        return false;
      }
      const stale = resting.filter(child => {
        const parent = c.parents[child.parentId]!;
        return this.now() - Math.max(parent.lastValidatedBookAt ?? child.createdAt, this.startedAt) > SUPERVISION_STALE_MS
          || this.now() - Math.max(this.lastReconciledAt ?? child.createdAt, this.startedAt) > SUPERVISION_STALE_MS;
      });
      if (stale.length) {
        // The venue has been unreadable for a minute: cancel what rests, per parent, without
        // latching an account halt. A failed cancellation leaves the dead-man's switch to expire.
        this.safetyGeneration += 1;
        const results = await Promise.all(stale.map(async child => ({ child, result: child.venueId
          ? await this.rpc("stale cancellation", () => this.d.adapter.cancelOrderChecked!(this.d.account, child.venueId!)).catch((error: unknown) => { child.error = String(error); return undefined; })
          : undefined })));
        this.d.log.warn("prediction supervision stale; canceling resting orders without halting the account", {
          orderIds: stale.map(child => child.venueId), staleForMs: SUPERVISION_STALE_MS });
        void this.serial(async () => {
          for (const { child, result } of results) {
            const parent = c.parents[child.parentId]!;
            if (active(parent)) { parent.status = "canceling"; parent.cancelReason = "supervision stale for more than 60 seconds"; }
            if (working(child) && child.venueId) {
              child.status = "canceling"; child.cancelRequestedAt ??= this.now();
              if (result) this.recordCancellation(child, result);
            }
          }
          await this.save();
        }).catch(error => this.d.log.error("prediction stale-supervision persistence failed", { error: String(error) }));
        return false;
      }
      if (this.d.adapter.heartbeat) await this.rpc("prediction heartbeat", () => this.d.adapter.heartbeat!(this.d.account));
      if (this.heartbeatFailing) { this.heartbeatFailing = false; this.refusals.resolve("heartbeat", "venue heartbeat recovered; new orders resume"); }
      return true;
    })().catch(error => {
      // The venue's dead-man switch cancels resting orders if renewals lapse, and reconciliation
      // observes that per order. New orders wait for a successful renewal; nothing is halted.
      const now = this.now();
      this.heartbeatFailing = true;
      if (now - this.heartbeatFailureLoggedAt >= DEFER_LOG_INTERVAL_MS) {
        this.heartbeatFailureLoggedAt = now;
        this.d.log.warn("prediction heartbeat failed; resting orders expire on the venue if renewals keep failing", { error: String(error) });
      }
      throw error;
    }).finally(() => { this.heartbeatPending = undefined; });
    this.heartbeatPending = pending;
    return pending;
  }

  snapshot(): Promise<PredictionExecutionSnapshot> {
    return this.serial(async () => {
      const c = await this.load();
      const parents = Object.values(c.parents).map((p): PredictionExecutionParentSummary => {
        const remaining = this.remaining(p);
        const { targetSize: _target, maximumPrice: _max, minimumPrice: _min, budgetUsd: _budget, minimumEdge: _edge, minimumNotional: _minimum,
          children: _children, lastExitDecision: _decision, lastExitEvaluationAt: _evaluated, fakSubmitted: _fak, crossingAt: _crossing, minOrderSize: _minSize,
          inventoryObserved: _inventory, lastValidatedBookAt: _bookTime, ...summary } = p;
        return { ...summary, remainingSize: remaining, reservedNotionalUsd: active(p) && p.side === "BUY" ? remaining * p.maximumPrice : 0,
          reservedSize: active(p) && p.side === "SELL" ? remaining : 0, childOrderIds: this.children(p).flatMap(child => child.venueId ? [child.venueId] : []),
          metrics: derivePredictionExecutionMetrics({ targetSize: p.targetSize, side: p.side, arrivalBid: p.arrivalBid, arrivalAsk: p.arrivalAsk,
            admittedAt: p.admittedAt, terminalAt: p.terminalAt,
            children: this.children(p).map(child => ({ postOnly: child.intent.postOnly === true, createdAt: child.createdAt, cancelRequestedAt: child.cancelRequestedAt })),
            fills: Object.values(c.settlements).filter(fill => fill.status === "CONFIRMED" && c.children[fill.childId]?.parentId === p.id)
              .map(fill => ({ size: fill.quantity, price: fill.price, fee: fill.fee, ts: fill.ts, postOnly: c.children[fill.childId]!.intent.postOnly === true })),
          }) };
      });
      const deferral = this.deferral;
      const reconcilingMarkets = [...new Set(Object.values(c.children).filter(child => child.status === "unknown").map(child => c.parents[child.parentId]!.marketRef))];
      return structuredClone({ parents, blocked: this.operatorPaused, queuedExitCount: Object.keys(c.queuedExits).length,
        unsettledFillCount: Object.values(c.settlements).filter(fill => !["CONFIRMED", "FAILED"].includes(fill.status)).length,
        ...(this.operatorPaused ? { haltReason: "operator pause" } : {}),
        ...(reconcilingMarkets.length ? { reconcilingMarkets } : {}), ...(this.unownedMarkets.size ? { unownedMarkets: [...this.unownedMarkets] } : {}),
        ...(c.refreshedAt ? { refreshedAt: c.refreshedAt } : {}), entryCooldowns: c.entryCooldowns, dailySpentUsd: c.dailySpentUsd,
        ...(deferral ? { supervision: { deferredSince: deferral.since, until: deferral.until, stage: deferral.stage, reason: deferral.reason } } : {}) });
    });
  }
}

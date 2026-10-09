// packages/core/src/engine/engine.ts
// The runtime-agnostic engine (§10): tick = pull signals → strategy decisions →
// risk checks → execute → reconcile fills → alert → persist. Ticks are
// idempotent and guarded by a monotonic tick sequence in the StateStore: tick
// ids come from the interval slot, so a restart mid-interval re-presents one.

import type {
  Action,
  AlertEvent,
  Alerter,
  Logger,
  Order,
  OrderAck,
  OrderIntent,
  OrderSide,
  OrderStatus,
  Position,
  PositionSide,
  RedemptionReceipt,
  Quote,
  Signal,
  SignalSource,
  StateStore,
  Strategy,
  StrategyActionResult,
  StrategyContext,
  StrategyMemory,
  VenueAccount,
  VenueAdapter,
  VenueReadApi,
} from "../types.js";
import type { BotConfig } from "../config.js";
import { closingPnl } from "../alerts/format.js";
import { checkCapacity, type CapacityResult } from "../risk/capacity.js";
import { mirrorBookForNo, mirrorQuoteForNo } from "./mirror.js";
import { StateKeys, getJson, setJson } from "../state.js";
import { PerpExecutor, isProtectiveOrder } from "./perp-execution.js";
import { PredictionExecutor, assertPredictionExecutionSettled } from "./prediction-execution.js";
import { positionMarketValue } from "../portfolio.js";
import { isRateLimitError } from "../venues/transient.js";
import { RefusalLog } from "./refusal-log.js";
import { SportsHoldGuard, SPORTS_HOLD_REASON } from "./sports-hold.js";

export interface ArmedTrigger {
  marketRef: string;
  outcome?: "YES" | "NO";
  posSide: PositionSide;
  kind: "stop" | "tp" | "trail";
  /** Trigger level for stop/tp. */
  level?: number;
  /** Trail distance in bps for trail. */
  trailBps?: number;
  /** High-water for held assets; low-water for a SHORT position. */
  waterMark?: number;
  armedAt: number;
  /** A fired synthetic exit stays required until inventory and working orders are gone. */
  firedAt?: number;
}

export interface ManualOrderParams {
  marketRef: string;
  outcome?: "YES" | "NO";
  side: OrderSide;
  size: number;
  limitPrice?: number;
  tif?: "GTC" | "IOC" | "FOK";
  reduceOnly?: boolean;
  stopPx?: number;
  tpPx?: number;
  trailBps?: number;
  /** Per-order slippage tolerance as a percentage from the touch; overrides risk.slippagePct. */
  slippagePct?: number;
  /**
   * Operator rationale from the thesis or the CLI's --note, retained in alerts.
   */
  note?: string;
}

export interface ManualOrderResult {
  placed: boolean;
  orderId?: string;
  size: number;
  limitPrice: number;
  skipReasons: string[];
  notes: string[];
  syntheticTriggers: boolean;
}

export interface EngineDeps {
  botId: string;
  config: BotConfig;
  adapter: VenueAdapter;
  account: VenueAccount;
  strategy: Strategy;
  signals: SignalSource;
  alerter: Alerter;
  state: StateStore;
  log: Logger;
  now?: () => number;
}

export interface TickResult {
  seq: number;
  skipped: boolean;
  skipReason?: string;
  actions: number;
  ordersPlaced: number;
  errors: number;
}

const LOCK_TTL_MS = 120_000;
const PENDING_REDEMPTIONS_KEY = "engine:pending-redemptions";
/** Lowest price valid on both prediction venues; a sell at this floor takes every resting bid. */
const MARKET_EXIT_PRICE = 0.01;

interface RedemptionRecord {
  status: "pending" | "confirmed";
  at: number;
  receipt?: RedemptionReceipt;
  /** Retained after the venue removes the redeemed position. */
  position?: Position;
}

/**
 * The venue refused an order the engine deliberately submitted below the
 * entry-only minimum-notional floor (a strategy exit closing a small
 * position). Reported under its own error code so untradeable dust is
 * distinguishable from an ordinary rejected exit in the error table and alerts.
 */
export class VenueDustRejectionError extends Error {
  readonly code = "venue-dust-rejected" as const;
  constructor(
    message: string,
    readonly detail: {
      marketRef: string;
      outcome?: "YES" | "NO";
      side: OrderSide;
      size: number;
      limitPrice: number;
      notionalUsd: number;
      minimumNotionalUsd: number;
      venueMessage: string;
    },
  ) {
    super(message);
    this.name = "VenueDustRejectionError";
  }
}

/** Durable per-order decision record keyed by venue order id (`orders:decision:<id>`). */
export interface OrderDecisionRecord {
  ts: number;
  botId: string;
  marketRef: string;
  tokenId?: string;
  conditionId?: string;
  outcome?: "YES" | "NO";
  side: OrderSide;
  size: number;
  limitPrice: number;
  notionalUsd: number;
  tif: string;
  reason: string;
  alertKind: AlertEvent["kind"];
  ackStatus: OrderStatus;
  ackFilledSize?: number;
  capacityNotes: string[];
  /** Strategy-supplied provenance (signal id/timestamp, edge, target, exposure, headroom). */
  provenance?: Record<string, unknown>;
  /** Exits: the held average price at placement, the basis for realized P&L at fill. */
  entryAvgPrice?: number;
  /** The held side the order opens or closes. */
  positionSide?: PositionSide;
}

export const orderDecisionKey = (orderId: string): string => `orders:decision:${orderId}`;

const ALERT_PROVENANCE_KEYS = [
  "signalId",
  "signalTs",
  "liveEdgePp",
  "targetUsd",
  "currentMarketUsd",
  "currentEventUsd",
  "headroomUsd",
  "limitingCap",
  "exitReason",
  "entryQPct",
  "currentQPct",
  "remainingEdgePp",
  "qRetreatPp",
  "executablePnlPct",
  "positionAgeDays",
  "adverseCrossConfirmations",
  "flipConfirmations",
  "confirmingForecastIds",
] as const;

/** The alert carries the explanatory subset; the durable decision record keeps everything. */
function alertProvenance(provenance: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ALERT_PROVENANCE_KEYS) {
    const value = provenance[key];
    if (value === undefined) continue;
    out[key] = typeof value === "number" ? Math.round(value * 100) / 100 : value;
  }
  return out;
}

interface AdvanceableSource {
  advance(): void;
}
function isAdvanceable(s: SignalSource): s is SignalSource & AdvanceableSource {
  return typeof (s as Partial<AdvanceableSource>).advance === "function";
}

type MinimumSkipOrder = { marketRef: string; outcome?: "YES" | "NO"; side: OrderSide };
function minimumSkipKey(p: MinimumSkipOrder): string {
  return `${p.side}:${p.marketRef}:${p.outcome ?? ""}`;
}

export class Engine {
  private readonly d: EngineDeps;
  private readonly now: () => number;
  /** Human market titles seen on venue positions, keyed by marketRef. */
  private readonly marketTitles = new Map<string, string>();
  private readonly perps?: PerpExecutor;
  private readonly predictions?: PredictionExecutor;
  private predictionSignals?: { signals: Signal[]; refreshedAt?: number };
  private predictionExitDecisions?: Record<string, "hold" | "normal" | "urgent">;
  private predictionExitsEvaluatedAt?: number;
  private triggerCheck?: Promise<void>;
  private readonly redemptions = new Map<string, Promise<number>>();
  private redemptionsStopping = false;
  /** Orders below a venue or notional minimum: logged, never alerted. */
  private readonly minimumSkips: RefusalLog;
  private readonly sportsHold: SportsHoldGuard;

  constructor(deps: EngineDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => Date.now());
    this.sportsHold = new SportsHoldGuard({ ...deps, now: this.now });
    this.minimumSkips = new RefusalLog(deps.log, this.now);
    if (deps.config.strategy.id === "quotient-swing") this.perps = new PerpExecutor({ ...deps, config: deps.config.strategy.config });
    if ((deps.config.venue === "polymarket" && ["signals", "flip-flat"].includes(deps.config.strategy.id) && deps.config.execution?.mode !== "legacy")
      || (deps.config.venue === "kalshi" && deps.config.strategy.id === "kalshi-commodities")) {
      this.predictions = new PredictionExecutor({ ...deps, sportsHold: this.sportsHold });
    }
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  /**
   * Run one tick. `tickId`, when provided by the runtime scheduler, makes
   * at-least-once delivery safe: a retried alarm re-presents the same tickId
   * and the engine no-ops instead of double-executing entries.
   */
  async tick(opts: { tickId?: number } = {}): Promise<TickResult> {
    const { state, log } = this.d;
    const lastSeq = Number((await state.get(StateKeys.tickSeq)) ?? "0");
    const seq = opts.tickId ?? lastSeq + 1;

    if (seq <= lastSeq) {
      log.info(`tick ${seq} already completed (last=${lastSeq}); skipping (alarm retry)`);
      return { seq, skipped: true, skipReason: "already-completed", actions: 0, ordersPlaced: 0, errors: 0 };
    }
    const lock = await getJson<{ seq: number; ts: number }>(state, StateKeys.tickLock);
    if (lock && lock.seq === seq && this.now() - lock.ts < LOCK_TTL_MS) {
      log.info(`tick ${seq} already in progress; skipping (concurrent retry)`);
      return { seq, skipped: true, skipReason: "in-progress", actions: 0, ordersPlaced: 0, errors: 0 };
    }
    if (!this.perps && (await state.get(StateKeys.paused)) === "true") {
      return { seq, skipped: true, skipReason: "paused", actions: 0, ordersPlaced: 0, errors: 0 };
    }
    await setJson(state, StateKeys.tickLock, { seq, ts: this.now() });

    let actionsCount = 0;
    let ordersPlaced = 0;
    let errors = 0;
    let redemptionWork = Promise.resolve(0);

    try {
      if (this.perps) {
        await this.perps.reconcile();
      } else {
      if (this.predictions) await this.supervisePredictions().catch(async (err) => {
        // Execution keeps its reservations on read failures; each market resolves on its own.
        errors += 1;
        await this.recordError(seq, "prediction-reconcile", err);
      });
      await this.reconcileFills(seq).catch(async (err) => {
        errors += 1;
        await this.recordError(seq, "reconcile-fills", err);
      });

      await this.expireStaleOrders(seq).catch(async (err) => {
        errors += 1;
        await this.recordError(seq, "order-ttl", err);
      });

      await this.checkTriggers(seq).catch(async (err) => {
        errors += 1;
        await this.recordError(seq, "triggers", err);
      });
      }

      try {
        const ctx = await this.buildStrategyContext();
        // Settlement belongs to account maintenance, independent of signal or
        // strategy failures. Slow relayer confirmations run outside trading.
        if (this.d.adapter.redeem && !this.redemptionsStopping) {
          const resolved = await this.redemptionCandidates(ctx.positions);
          actionsCount += resolved.length;
          const tasks = resolved.map(([key, position]) => {
            const running = this.redemptions.get(key);
            if (running) return running;
            const task = this.redeemPosition(position, ctx)
              .then(() => 0, async error => { await this.recordError(seq, "action-redeem", error, { marketRef: position.marketRef }); return 1; })
              .finally(() => this.redemptions.delete(key));
            this.redemptions.set(key, task);
            return task;
          });
          redemptionWork = Promise.all(tasks).then(results => results.reduce((sum, errors) => sum + errors, 0));
        }
        const actions = (await this.d.strategy.tick(ctx)).filter(action => !this.d.adapter.redeem || action.kind !== "redeem");
        if (this.predictions) {
          // Quotient reads already retried inside the signal source. A final
          // failure must not abandon the tick: entries stop (no fresh signals)
          // while held positions are still supervised and exits still execute.
          const signals = await this.d.signals.latest({ venue: this.d.config.venue }).catch(error => {
            log.warn(`quotient unavailable after retries; canceling entries while supervising exits: ${(error as Error).message}`);
            return [];
          });
          this.predictionSignals = { signals, refreshedAt: this.d.signals.refreshedAt?.() ?? this.now() };
          this.predictionExitDecisions = Object.fromEntries(ctx.positions.map(position => [position.marketRef, "hold" as const]));
          for (const action of actions) {
            if (action.kind === "exit") this.predictionExitDecisions[action.marketRef] = action.urgent ? "urgent" : "normal";
          }
          this.predictionExitsEvaluatedAt = this.now();
          await this.supervisePredictions().catch(async (err) => {
            errors += 1;
            await this.recordError(seq, "prediction-reconcile", err);
          });
        }
        actionsCount += actions.length;
        for (const action of actions) {
          try {
            const result = await this.executeAction(action, ctx);
            if (result.placed) ordersPlaced += 1;
            await this.d.strategy.onActionResult?.(ctx, action, result);
          } catch (err) {
            errors += 1;
            if (err instanceof VenueDustRejectionError) {
              await this.recordError(seq, err.code, err, { ...err.detail });
            } else {
              await this.recordError(seq, `action-${action.kind}`, err, { marketRef: action.marketRef });
            }
          }
        }
      } catch (err) {
        errors += 1;
        await this.recordError(seq, "strategy-tick", err);
      }

      // Fast settlements are reflected in this tick's result. A slow relayer
      // keeps its durable receipt and in-flight task without blocking orders.
      let redemptionTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        errors += await Promise.race([redemptionWork, new Promise<number>(resolve => {
          redemptionTimer = setTimeout(() => resolve(0), 100);
        })]);
      } finally { if (redemptionTimer) clearTimeout(redemptionTimer); }

      await this.maintainDeadMansSwitch().catch(async (err) => {
        errors += 1;
        await this.recordError(seq, "deadman", err);
      });

      await state.set(StateKeys.tickSeq, String(seq));
      if (isAdvanceable(this.d.signals)) this.d.signals.advance();
    } finally {
      await state.delete(StateKeys.tickLock);
    }

    log.info(`tick ${seq} done: actions=${actionsCount} orders=${ordersPlaced} errors=${errors}`);
    return { seq, skipped: false, actions: actionsCount, ordersPlaced, errors };
  }

  // -------------------------------------------------------------------------
  // Strategy context
  // -------------------------------------------------------------------------

  private readApi(): VenueReadApi {
    const { adapter, account } = this.d;
    return {
      balances: () => adapter.balances(account),
      positions: () => adapter.positions(account),
      book: (m) => adapter.book(m),
      quote: (m) => adapter.quote(m),
      openOrders: () => adapter.openOrders(account),
      fills: (since) => adapter.fills(account, since),
      eventRef: adapter.eventRef ? (m) => adapter.eventRef!(m) : undefined,
      executionMarket: adapter.executionMarket ? (m, outcome) => adapter.executionMarket!(m, outcome) : undefined,
      candles: adapter.candles ? (m, i, l) => adapter.candles!(m, i, l) : undefined,
      perpInstruments: adapter.perpInstruments ? () => adapter.perpInstruments!() : undefined,
      perpAccountSnapshot: adapter.perpAccountSnapshot ? () => adapter.perpAccountSnapshot!(account) : undefined,
      perpMarketSnapshot: adapter.perpMarketSnapshot ? m => adapter.perpMarketSnapshot!(account, m) : undefined,
    };
  }

  private strategyMemory(): StrategyMemory {
    const { state } = this.d;
    return {
      get: <T>(key: string) => getJson<T>(state, StateKeys.strategyMemory(key)),
      set: <T>(key: string, value: T) => setJson(state, StateKeys.strategyMemory(key), value),
    };
  }

  /**
   * A read-only StrategyContext for out-of-band strategy previews (the agent
   * strategy's dry run). Callers must not execute actions with it — orders go
   * through tick()/manualOrder(), where the risk module runs.
   */
  async strategyContext(): Promise<StrategyContext> {
    return this.buildStrategyContext();
  }

  private async buildStrategyContext(): Promise<StrategyContext> {
    const { adapter, account, botId, config, signals, log } = this.d;
    if (this.perps) {
      const snapshot = await this.perps.snapshot();
      this.rememberTitles(snapshot.positions);
      return { botId, venueId: adapter.id, config: config.strategy.config, signals, venue: this.readApi(), positions: snapshot.positions,
        openOrders: snapshot.openOrders, equity: snapshot.equity, perpAccount: snapshot, perpExecution: await this.perps.status(), log,
        now: this.now, memory: this.strategyMemory() };
    }
    const [positions, openOrders, balances] = await Promise.all([
      adapter.positions(account),
      adapter.openOrders(account),
      adapter.balances(account),
    ]);
    this.rememberTitles(positions);
    const collateral = balances.reduce((s, b) => s + b.total, 0);
    const posValue = positions.reduce((s, p) => s + positionMarketValue(p), 0);
    const lifecycleRefs = [...positions.map(p => p.marketRef), ...openOrders.map(o => o.marketRef)];
    if (this.sportsHold.enabled) {
      const currentSignals = await signals.latest({ venue: config.venue }).catch(() => []);
      await this.sportsHold.refresh(lifecycleRefs, currentSignals);
    }
    return {
      botId,
      venueId: adapter.id,
      config: config.strategy.config,
      signals,
      venue: this.readApi(),
      positions,
      sportsHolds: lifecycleRefs.filter(ref => this.sportsHold.isHeld(ref)),
      openOrders,
      equity: adapter.id === "hyperliquid" ? collateral : collateral + posValue,
      ...(this.predictions ? { execution: await this.predictions.snapshot() } : {}),
      log,
      now: this.now,
      memory: this.strategyMemory(),
    };
  }

  // -------------------------------------------------------------------------
  // Action execution (risk module runs before every fill, §9)
  // -------------------------------------------------------------------------

  private async executeAction(action: Action, ctx: StrategyContext): Promise<StrategyActionResult> {
    if (this.perps) return this.perps.execute(action);
    if ((action.kind === "enter" || action.kind === "exit") && this.sportsHold.enabled) {
      await this.sportsHold.refresh([action.marketRef]);
      if (this.sportsHold.isHeld(action.marketRef)) {
        this.d.log.info(`${action.kind} deferred for ${action.marketRef}: ${SPORTS_HOLD_REASON}`);
        return { placed: false };
      }
    }
    if (this.predictions && (action.kind === "enter" || action.kind === "exit")) {
      return this.predictions.admit(action, ctx.positions);
    }
    if (!this.predictions) await assertPredictionExecutionSettled(this.d.state);
    const { adapter, account } = this.d;
    switch (action.kind) {
      case "protect": throw new Error("native protection updates require a protected perp strategy");
      case "target": throw new Error("target orders require a protected perp strategy");
      case "enter": {
        const isPrediction = action.side === "YES" || action.side === "NO";
        const outcome = isPrediction ? (action.side as "YES" | "NO") : undefined;
        const orderSide: OrderSide = action.side === "SHORT" ? "SELL" : "BUY";
        return this.placeChecked({
          marketRef: action.marketRef,
          outcome,
          side: orderSide,
          desiredNotional: action.notional,
          minimumNotional: action.minNotional,
          limitPrice: action.limitPrice,
          reason: action.reason ?? "strategy-entry",
          alertKind: "entry",
          alertMessage: `enter ${action.side} ${shortRef(action.marketRef)}`,
          provenance: action.provenance,
          positionSide: action.side,
        });
      }
      case "exit": {
        const pos = ctx.positions.find((p) => p.marketRef === action.marketRef);
        if (!pos || pos.size <= 0) {
          this.d.log.warn(`exit action for ${action.marketRef} but no position held`);
          return { placed: false };
        }
        const isPrediction = pos.side === "YES" || pos.side === "NO";
        const orderSide: OrderSide = pos.side === "SHORT" ? "BUY" : "SELL";
        // A strategy exit on a prediction market is a decision to be out: sell the
        // whole position into the book now instead of resting a limit near the bid.
        const marketExit = isPrediction && action.urgent === true;
        const result = await this.placeChecked({
          ...(marketExit ? { market: true } : {}),
          marketRef: action.marketRef,
          outcome: isPrediction ? (pos.side as "YES" | "NO") : undefined,
          side: orderSide,
          desiredSize: pos.size,
          reduceOnly: !isPrediction,
          // The minimum-notional floor is an entry-only rule. A strategy exit
          // must be able to close a small position; slippage and depth still apply.
          enforceMinimumNotional: false,
          reason: action.reason ?? "strategy-exit",
          alertKind: "exit",
          alertMessage: `exit ${pos.side} ${shortRef(action.marketRef)}${action.reason ? ` (${action.reason})` : ""}`,
          provenance: action.provenance,
          entryAvgPrice: pos.avgPrice,
          positionSide: pos.side,
        });
        if (result.placed) await this.disarmTriggers(action.marketRef);
        return result;
      }
      case "redeem": {
        const pos = ctx.positions.find((p) => p.marketRef === action.marketRef && p.redeemable && p.size > 0);
        if (pos) await this.redeemPosition(pos, ctx);
        return { placed: false };
      }
      case "cancel": {
        if (this.predictions) {
          await this.predictions.cancelMarket(action.marketRef, action.reason);
          return { placed: false };
        }
        await adapter.cancelOrder(account, action.orderId);
        return { placed: false };
      }
      case "place":
        throw new Error(
          "explicit market-making orders require the market-make controller and passive risk executor",
        );
    }
  }

  /** Index pending receipts before submission so confirmation can resume without a live position. */
  private async redemptionCandidates(positions: readonly Position[]): Promise<Array<[string, Position]>> {
    const candidates = new Map(positions.filter(p => p.redeemable && p.size > 0)
      .map(p => [(p.conditionId ?? p.marketRef).toLowerCase(), p]));
    for (const id of await getJson<string[]>(this.d.state, PENDING_REDEMPTIONS_KEY) ?? []) {
      const saved = await getJson<RedemptionRecord>(this.d.state, `engine:redemption:${id}`);
      if (saved?.status === "pending" && saved.position) candidates.set(id, saved.position);
    }
    await setJson(this.d.state, PENDING_REDEMPTIONS_KEY, [...candidates.keys()]);
    return [...candidates];
  }

  private async redeemPosition(pos: Position, ctx: StrategyContext): Promise<void> {
    const { adapter, account, state } = this.d;
    if (!adapter.redeem) return;
    // One SDK redemption burns both outcomes. Retain its receipt across ticks,
    // indexer lag and process restarts; ambiguous submissions are never replayed.
    const key = `engine:redemption:${(pos.conditionId ?? pos.marketRef).toLowerCase()}`;
    const previous = await getJson<RedemptionRecord>(state, key);
    if (previous?.status === "confirmed") return;
    if (previous?.status === "pending") {
      // Upgrade a pre-snapshot pending record while the position is still available.
      const record = { ...previous, position: previous.position ?? { ...pos } };
      if (!previous.position) await setJson(state, key, record);
      const status = record.receipt && adapter.redemptionStatus
        ? await adapter.redemptionStatus(account, record.receipt) : "pending";
      if (status === "confirmed") {
        await this.confirmRedemption(key, record);
      } else if (status === "failed") {
        // Only an authoritative terminal failure releases the submission fence.
        await state.delete(key);
      } else {
        this.d.log.warn(`redemption pending for ${shortRef(pos.marketRef)}; awaiting settlement before retry`, record.receipt);
      }
      return;
    }
    const working = ctx.openOrders.filter(order => order.marketRef === pos.marketRef);
    const managed = ctx.execution?.parents.some(parent => parent.marketRef === pos.marketRef &&
      ["active", "canceling"].includes(parent.status));
    if (working.length || managed) {
      if (this.predictions) await this.predictions.cancelMarket(pos.marketRef, "market resolved; cancel before redemption");
      else for (const order of working) await adapter.cancelOrder(account, order.id);
      return;
    }
    const record = { status: "pending" as const, at: this.now(), position: { ...pos } };
    const receipt = await adapter.redeem(account, pos, {
      beforeSubmit: () => setJson(state, key, record),
      submitted: receipt => setJson(state, key, { ...record, receipt }),
    });
    await this.confirmRedemption(key, { ...record, receipt });
  }

  private async confirmRedemption(key: string, record: RedemptionRecord & { position: Position }): Promise<void> {
    await setJson(this.d.state, key, { ...record, status: "confirmed" });
    const pos = record.position;
    await this.disarmTriggers(pos.marketRef);
    // Dollars per held-outcome share. Zero is a reported loss, not missing data.
    const payout = pos.currentPrice;
    await this.alert({
      kind: "resolution",
      botId: this.d.botId,
      message: `redeemed resolved position ${pos.side} ${shortRef(pos.marketRef)}`,
      data: { size: pos.size, conditionId: pos.conditionId, entryAvgPrice: pos.avgPrice, ...(payout !== undefined ? { payout } : {}), ...record.receipt },
      ...this.baseAlert(),
      market: this.alertMarket(pos.marketRef, pos.outcome ?? (pos.side === "YES" || pos.side === "NO" ? pos.side : undefined), pos.label, pos),
      ...(payout !== undefined ? optionalPnl(closingPnl(pos.avgPrice, pos.side, pos.size, payout, 0, "realized")) : {}),
      reason: "market resolved; position redeemed",
    });
  }

  private async quoteFor(marketRef: string, outcome?: "YES" | "NO") {
    if (outcome && this.d.adapter.executionMarket) {
      const { book, quote, minOrderSize } = await this.d.adapter.executionMarket(marketRef, outcome);
      return { book, quote, minOrderSize };
    }
    const [book, quote] = await Promise.all([this.d.adapter.book(marketRef), this.d.adapter.quote(marketRef)]);
    if (outcome === "NO") return { book: mirrorBookForNo(book), quote: mirrorQuoteForNo(quote), minOrderSize: undefined };
    return { book, quote, minOrderSize: undefined };
  }

  private async placeChecked(p: {
    marketRef: string;
    outcome?: "YES" | "NO";
    side: OrderSide;
    desiredNotional?: number;
    desiredSize?: number;
    minimumNotional?: number;
    limitPrice?: number;
    tif?: "GTC" | "IOC" | "FOK";
    reduceOnly?: boolean;
    triggers?: { stopPx?: number; tpPx?: number };
    /** False for exits: the minimum-notional floor is an entry-only rule. */
    enforceMinimumNotional?: boolean;
    reason: string;
    alertKind: AlertEvent["kind"];
    alertMessage: string;
    provenance?: Record<string, unknown>;
    /** Exits: held average price, for P&L. */
    entryAvgPrice?: number;
    positionSide?: PositionSide;
    /** Prediction exits: the whole size, immediate-or-cancel, at any price. */
    market?: boolean;
  }): Promise<StrategyActionResult> {
    const { adapter, account, config, botId } = this.d;
    const { book, quote, minOrderSize } = await this.quoteFor(p.marketRef, p.outcome);
    const refPrice = p.limitPrice ?? quote.mid;
    const desiredSize = p.desiredSize ?? (p.desiredNotional ?? 0) / refPrice;
    const enforceMinimumNotional = p.enforceMinimumNotional ?? true;

    const risk = config.risk;
    const cap: CapacityResult = p.market
      ? { ok: true, size: desiredSize, limitPrice: MARKET_EXIT_PRICE, bandDepth: 0, capped: false, skipReasons: [],
          notes: ["market exit: whole position at any price"] }
      : checkCapacity({
        side: p.side,
        desiredSize,
        refPrice,
        book,
        quote,
        risk,
        minimumNotional: p.minimumNotional,
        enforceMinimumNotional,
      });
    if (!cap.ok) {
      if (cap.belowMinimum) return this.skipBelowMinimum(p, cap.skipReasons.join("; "));
      await this.alert({
        kind: "skipped-order",
        botId,
        message: `skipped ${p.side} ${shortRef(p.marketRef)}: ${cap.skipReasons.join("; ")}`,
        ...this.baseAlert(),
        market: this.alertMarket(p.marketRef, p.outcome),
        reason: cap.skipReasons.join("; "),
      });
      return { placed: false };
    }
    const limitPrice = round(p.limitPrice ?? cap.limitPrice, 6);
    const entrySpendCeiling =
      p.side === "BUY" && p.desiredNotional !== undefined
        ? Math.min(p.desiredNotional, risk.maxOrderNotional)
        : undefined;
    const cappedSize =
      entrySpendCeiling !== undefined
        ? floorSizeToNotionalCap(cap.size, limitPrice, entrySpendCeiling, 6)
        : round(cap.size, 6);
    // Reservations must match the quantity the venue will sign. Flooring may
    // also put a small top-up below the venue's share minimum.
    const size = adapter.normalizeOrderSize?.(cappedSize) ?? cappedSize;
    // A market exit's limit is only a floor; the venue fills it at the resting bids.
    const placedNotional = size * (p.market && quote.bid > 0 ? quote.bid : limitPrice);
    const effectiveMinimumNotional = Math.max(risk.minViableNotional, p.minimumNotional ?? 0);
    const knownMinimum = minOrderSize !== undefined && Number.isFinite(minOrderSize) && minOrderSize > 0;
    // The venue refuses any order below its share minimum, exits included.
    if (knownMinimum && size + 1e-9 < minOrderSize) {
      return this.skipBelowMinimum(p, `size ${size} is below venue minimum ${minOrderSize}`);
    }
    if (p.side === "BUY" && enforceMinimumNotional && minOrderSize !== undefined && !knownMinimum) {
      await this.alert({
        kind: "skipped-order",
        botId,
        message: `skipped BUY ${shortRef(p.marketRef)}: venue minimum ${minOrderSize} is not usable`,
        ...this.baseAlert(),
        market: this.alertMarket(p.marketRef, p.outcome),
        reason: `venue minimum ${minOrderSize} is not usable`,
      });
      return { placed: false };
    }
    if (
      entrySpendCeiling !== undefined &&
      (size <= 0 || placedNotional < effectiveMinimumNotional)
    ) {
      return this.skipBelowMinimum(p, size <= 0
        ? "entry size rounds to zero at the final limit price"
        : `capped notional $${placedNotional.toFixed(2)} < minimum notional $${effectiveMinimumNotional} — skip rather than dribble`);
    }
    this.minimumSkips.resolve(minimumSkipKey(p));
    const entrySizeCapped = entrySpendCeiling !== undefined && size < cap.size;
    const intent: OrderIntent = {
      marketRef: p.marketRef,
      outcome: p.outcome,
      side: p.side,
      size,
      limitPrice,
      tif: p.tif ?? (p.market ? "IOC" : "GTC"),
      clientId: `${botId}-${this.now()}-${Math.floor(Math.random() * 1e6)}`,
      reduceOnly: p.reduceOnly,
      triggers: p.triggers,
    };
    const belowEntryFloor = !enforceMinimumNotional && placedNotional < effectiveMinimumNotional;
    const dustRejection = (venueMessage: string): VenueDustRejectionError =>
      new VenueDustRejectionError(
        `venue rejected untradeable dust: ${p.side} ${size} ${shortRef(p.marketRef)} ` +
          `($${placedNotional.toFixed(2)} is below the $${effectiveMinimumNotional} entry floor, ` +
          `which the engine does not apply to exits): ${venueMessage}`,
        {
          marketRef: p.marketRef,
          outcome: p.outcome,
          side: p.side,
          size,
          limitPrice,
          notionalUsd: placedNotional,
          minimumNotionalUsd: effectiveMinimumNotional,
          venueMessage,
        },
      );
    let ack: OrderAck;
    try {
      ack = await adapter.placeOrder(account, intent);
    } catch (err) {
      const venueMessage = err instanceof Error ? err.message : String(err);
      if (belowEntryFloor) throw dustRejection(venueMessage);
      throw err;
    }
    if (ack.status === "rejected" && belowEntryFloor) {
      throw dustRejection(`acknowledged as rejected (order ${ack.orderId})`);
    }
    const placedAt = this.now();
    const decision: OrderDecisionRecord = {
      ts: placedAt,
      botId,
      marketRef: p.marketRef,
      ...(ack.tokenId ? { tokenId: ack.tokenId } : {}),
      ...(ack.conditionId ? { conditionId: ack.conditionId } : {}),
      outcome: p.outcome,
      side: p.side,
      size: intent.size,
      limitPrice: intent.limitPrice,
      notionalUsd: placedNotional,
      tif: intent.tif,
      reason: p.reason,
      alertKind: p.alertKind,
      ackStatus: ack.status,
      ...(ack.filledSize !== undefined ? { ackFilledSize: ack.filledSize } : {}),
      capacityNotes: cap.notes,
      ...(p.provenance ? { provenance: p.provenance } : {}),
      ...(p.entryAvgPrice !== undefined ? { entryAvgPrice: p.entryAvgPrice } : {}),
      ...(p.positionSide !== undefined ? { positionSide: p.positionSide } : {}),
    };
    await setJson(this.d.state, `orders:placed:${ack.orderId}`, { ts: placedAt, intent, ...(p.provenance ? { provenance: p.provenance } : {}) });
    // The placed record is deleted at TTL cancel; the decision record is
    // permanent so venue history stays explainable after the order is gone.
    await setJson(this.d.state, orderDecisionKey(ack.orderId), decision);
    await this.alert({
      kind: p.alertKind,
      botId,
      message: `${p.alertMessage}: ${p.side} ${intent.size} @ ${intent.limitPrice}${cap.capped || entrySizeCapped ? " (size capped)" : ""}`,
      data: {
        orderId: ack.orderId,
        status: ack.status,
        // Exact venue identity for settlement reconciliation.
        ...(ack.tokenId ? { asset: ack.tokenId } : {}),
        ...(ack.funder ? { funder: ack.funder } : {}),
        reason: p.reason,
        ...(cap.notes.length ? { capacity: cap.notes.join("; ") } : {}),
        ...(p.provenance ? { provenance: alertProvenance(p.provenance) } : {}),
      },
      ...this.baseAlert(placedAt),
      market: this.alertMarket(p.marketRef, p.outcome, undefined, ack),
      trade: {
        side: p.side,
        size: intent.size,
        price: intent.limitPrice,
        notionalUsd: placedNotional,
        orderId: ack.orderId,
        ...(p.positionSide ? { positionSide: p.positionSide } : {}),
        ...(ack.status === "filled" ? { filled: true } : {}),
      },
      ...(p.alertKind === "exit" ? optionalPnl(exitPnl(p.entryAvgPrice, p.positionSide, intent.size, intent.limitPrice, p.provenance)) : {}),
      reason: p.reason,
    });
    return {
      placed: ack.status !== "rejected",
      ...(p.desiredNotional !== undefined ? { placedNotional } : {}),
      placedSize: intent.size,
      limitPrice: intent.limitPrice,
      orderId: ack.orderId,
      clientId: intent.clientId,
      status: ack.status,
      ...(ack.filledSize !== undefined ? { filledSize: ack.filledSize } : {}),
      placedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Manual trading (§10)
  // -------------------------------------------------------------------------

  async manualOrder(p: ManualOrderParams): Promise<ManualOrderResult> {
    const { adapter, account, config, botId } = this.d;
    if (this.predictions) {
      throw new Error("manual orders require legacy execution mode; adaptive signals bots manage orders through their strategy");
    }
    await assertPredictionExecutionSettled(this.d.state);
    const { book, quote } = await this.quoteFor(p.marketRef, p.outcome);
    const refPrice = p.limitPrice ?? quote.mid;
    const risk = {
      ...config.risk,
      ...(p.slippagePct !== undefined ? { slippagePct: p.slippagePct } : {}),
    };
    const cap = checkCapacity({ side: p.side, desiredSize: p.size, refPrice, book, quote, risk });
    if (!cap.ok) {
      return {
        placed: false,
        size: 0,
        limitPrice: refPrice,
        skipReasons: cap.skipReasons,
        notes: cap.notes,
        syntheticTriggers: false,
      };
    }
    const native = adapter.supportsNativeTriggers === true;
    const intent: OrderIntent = {
      marketRef: p.marketRef,
      outcome: p.outcome,
      side: p.side,
      size: round(cap.size, 6),
      limitPrice: round(p.limitPrice ?? cap.limitPrice, 6),
      tif: p.tif ?? "GTC",
      clientId: `${botId}-manual-${this.now()}`,
      reduceOnly: p.reduceOnly,
      triggers: native ? { stopPx: p.stopPx, tpPx: p.tpPx } : undefined,
    };
    // Read the holding before the order changes it: its average price is the P&L basis.
    const heldSide: PositionSide = p.outcome ?? (p.side === "BUY" ? "LONG" : "SHORT");
    let held: Position | undefined;
    try {
      const positions = await adapter.positions(account);
      this.rememberTitles(positions);
      if (p.reduceOnly) {
        held = positions.find((pos) => pos.marketRef === p.marketRef && (!p.outcome || (pos.outcome ?? pos.side) === p.outcome));
      }
    } catch {
      // Titles and P&L on the alert are best-effort; the order proceeds.
    }
    const ack = await adapter.placeOrder(account, intent);
    const positionSide: PositionSide = held?.side ?? heldSide;
    await setJson(this.d.state, `orders:placed:${ack.orderId}`, {
      ts: this.now(),
      intent: { ...intent, ...(ack.tokenId ? { tokenId: ack.tokenId } : {}), ...(ack.conditionId ? { conditionId: ack.conditionId } : {}) },
      ...(held ? { entryAvgPrice: held.avgPrice, positionSide } : {}),
    });

    // Manual and thesis-driven orders retain the operator's rationale in alerts.
    await this.alert({
      kind: p.reduceOnly ? "exit" : "entry",
      botId,
      message: `${p.reduceOnly ? "exit" : "enter"} ${p.outcome ?? p.side} ${shortRef(p.marketRef)}: ${p.side} ${intent.size} @ ${intent.limitPrice}`,
      data: {
        orderId: ack.orderId,
        status: ack.status,
        ...(ack.tokenId ? { asset: ack.tokenId } : {}),
        ...(ack.funder ? { funder: ack.funder } : {}),
        ...(p.note ? { note: p.note } : {}),
        source: "manual",
      },
      ...this.baseAlert(),
      market: this.alertMarket(p.marketRef, p.outcome, undefined, ack),
      trade: {
        side: p.side,
        size: intent.size,
        price: intent.limitPrice,
        notionalUsd: intent.size * intent.limitPrice,
        orderId: ack.orderId,
        positionSide,
        ...(ack.status === "filled" ? { filled: true } : {}),
      },
      ...(held ? optionalPnl(closingPnl(held.avgPrice, positionSide, intent.size, intent.limitPrice, 0, "executable")) : {}),
      reason: p.note ?? "manual order",
    });

    let synthetic = false;
    if (!native && (p.stopPx !== undefined || p.tpPx !== undefined || p.trailBps !== undefined)) {
      synthetic = true;
      const posSide: PositionSide = p.outcome ?? (p.side === "BUY" ? "LONG" : "SHORT");
      if (p.stopPx !== undefined) await this.armTrigger({ marketRef: p.marketRef, outcome: p.outcome, posSide, kind: "stop", level: p.stopPx, armedAt: this.now() });
      if (p.tpPx !== undefined) await this.armTrigger({ marketRef: p.marketRef, outcome: p.outcome, posSide, kind: "tp", level: p.tpPx, armedAt: this.now() });
      if (p.trailBps !== undefined) await this.armTrigger({ marketRef: p.marketRef, outcome: p.outcome, posSide, kind: "trail", trailBps: p.trailBps, waterMark: quote.mid, armedAt: this.now() });
    } else if (native && p.trailBps !== undefined) {
      // Native venues get stop/tp mapped; trails stay engine-managed everywhere.
      synthetic = true;
      const posSide: PositionSide = p.side === "BUY" ? "LONG" : "SHORT";
      await this.armTrigger({ marketRef: p.marketRef, posSide, kind: "trail", trailBps: p.trailBps, waterMark: quote.mid, armedAt: this.now() });
    }

    return {
      placed: true,
      orderId: ack.orderId,
      size: intent.size,
      limitPrice: intent.limitPrice,
      skipReasons: [],
      notes: cap.notes,
      syntheticTriggers: synthetic,
    };
  }

  // -------------------------------------------------------------------------
  // Synthetic triggers (§10): monitor on tick + a tighter trigger-check
  // schedule while armed. Best-effort at poll cadence.
  // -------------------------------------------------------------------------

  private async loadTriggers(): Promise<ArmedTrigger[]> {
    return (await getJson<ArmedTrigger[]>(this.d.state, StateKeys.triggers)) ?? [];
  }

  private async armTrigger(t: ArmedTrigger): Promise<void> {
    const all = await this.loadTriggers();
    all.push(t);
    await setJson(this.d.state, StateKeys.triggers, all);
  }

  async disarmTriggers(marketRef: string): Promise<void> {
    const all = await this.loadTriggers();
    await setJson(
      this.d.state,
      StateKeys.triggers,
      all.filter((t) => t.marketRef !== marketRef),
    );
  }

  async hasArmedTriggers(): Promise<boolean> {
    return (await this.loadTriggers()).length > 0;
  }

  /** Check all armed synthetic triggers against current quotes; fire crossing exits. */
  checkTriggers(seq?: number): Promise<void> {
    if (this.triggerCheck) return this.triggerCheck;
    this.triggerCheck = this.checkTriggersOnce(seq).finally(() => { this.triggerCheck = undefined; });
    return this.triggerCheck;
  }

  private async checkTriggersOnce(seq?: number): Promise<void> {
    const triggers = await this.loadTriggers();
    if (triggers.length === 0) return;
    const positions = await this.d.adapter.positions(this.d.account);
    await this.sportsHold.refresh(triggers.map(t => t.marketRef));
    this.rememberTitles(positions);
    const execution = await this.predictions?.snapshot();
    const remaining: ArmedTrigger[] = [];
    for (const t of triggers) {
      const isPrediction = t.posSide === "YES" || t.posSide === "NO";
      const outcome = t.outcome ?? (isPrediction ? t.posSide as "YES" | "NO" : undefined);
      let pos = positions.find((p) => p.marketRef === t.marketRef && (!outcome || (p.outcome ?? p.side) === outcome));
      const parents = execution?.parents.filter(parent => parent.marketRef === t.marketRef && parent.outcome === outcome) ?? [];
      const unresolved = parents.some(parent => ["active", "canceling"].includes(parent.status));
      const entry = parents.filter(parent => parent.side === "BUY" && (parent.filledSize > 0 || ["active", "canceling"].includes(parent.status)))
        .sort((a, b) => b.admittedAt - a.admittedAt)[0];
      const tracked = entry ?? parents.find(parent => ["active", "canceling"].includes(parent.status));
      if (this.predictions && isPrediction && (tracked || pos?.tokenId)) {
        const tokenId = tracked?.tokenId ?? pos!.tokenId!;
        try {
          if (!this.d.adapter.tokenBalance) throw new Error("authenticated token balance is unavailable");
          const quantity = await this.d.adapter.tokenBalance(this.d.account, tokenId);
          if (!Number.isFinite(quantity) || quantity < 0) throw new Error("invalid authenticated token balance");
          if (quantity <= 0 && !unresolved) continue;
          pos = {
            ...pos, marketRef: t.marketRef, tokenId, outcome, side: outcome!, size: quantity,
            conditionId: tracked?.conditionId ?? pos?.conditionId,
            avgPrice: pos?.avgPrice ?? (entry && entry.filledSize > 0 ? entry.filledNotionalUsd / entry.filledSize : 0),
          };
        } catch (error) {
          this.d.log.warn(`synthetic ${t.kind} retained for ${t.marketRef}: ${(error as Error).message}`);
          remaining.push(t);
          continue;
        }
      }
      if (!pos || (pos.size <= 0 && !unresolved)) continue;
      if (isPrediction && this.sportsHold.isHeld(t.marketRef)) { remaining.push(t); continue; }
      // Both YES and NO are held long in their own token price space.
      const bullish = t.posSide !== "SHORT";
      let fired = t.firedAt !== undefined;
      if (!fired) {
        const { quote } = await this.quoteFor(t.marketRef, outcome);
        if (t.kind === "stop" && t.level !== undefined) {
          fired = bullish ? quote.mid <= t.level : quote.mid >= t.level;
        } else if (t.kind === "tp" && t.level !== undefined) {
          fired = bullish ? quote.mid >= t.level : quote.mid <= t.level;
        } else if (t.kind === "trail" && t.trailBps !== undefined) {
          const mark = t.waterMark ?? quote.mid;
          t.waterMark = bullish ? Math.max(mark, quote.mid) : Math.min(mark, quote.mid);
          const dist = (t.waterMark * t.trailBps) / 10_000;
          fired = bullish ? quote.mid <= t.waterMark - dist : quote.mid >= t.waterMark + dist;
        }
      }
      if (!fired) {
        remaining.push(t);
        continue;
      }
      if (this.predictions && isPrediction) {
        if (t.firedAt === undefined) {
          t.firedAt = this.now();
          await setJson(this.d.state, StateKeys.triggers, triggers);
        }
        await this.predictions.admit({ kind: "exit", marketRef: t.marketRef, urgent: true, reason: `synthetic-${t.kind}` }, [pos]);
        // Keep supervising partial or blocked exits until inventory is gone.
        remaining.push(t);
        continue;
      }
      await this.placeChecked({
        marketRef: t.marketRef,
        outcome: t.outcome,
        side: t.posSide === "SHORT" ? "BUY" : "SELL",
        desiredSize: pos.size,
        reduceOnly: !isPrediction,
        enforceMinimumNotional: false,
        reason: `synthetic-${t.kind}`,
        alertKind: "exit",
        alertMessage: `synthetic ${t.kind} fired for ${t.posSide} ${shortRef(t.marketRef)}`,
        entryAvgPrice: pos.avgPrice,
        positionSide: t.posSide,
      });
    }
    await setJson(this.d.state, StateKeys.triggers, remaining);
  }

  // -------------------------------------------------------------------------
  // Fills, TTL, dead man's switch
  // -------------------------------------------------------------------------

  private async reconcileFills(seq: number): Promise<void> {
    const { adapter, account, state, botId } = this.d;
    const since = Number((await state.get(StateKeys.lastFillTs)) ?? "0");
    const fills = await adapter.fills(account, since);
    if (fills.length === 0) return;
    let maxTs = since;
    // Titles for the markets just filled; best-effort, never blocks the alert.
    await adapter.positions(account).then((positions) => this.rememberTitles(positions), () => undefined);
    for (const f of fills) {
      maxTs = Math.max(maxTs, f.ts);
      const decision = f.orderId ? await getJson<OrderDecisionRecord>(state, orderDecisionKey(f.orderId)) : undefined;
      const placed = f.orderId && !decision
        ? await getJson<{ entryAvgPrice?: number; positionSide?: PositionSide; intent?: OrderIntent }>(state, `orders:placed:${f.orderId}`)
        : undefined;
      const closing = decision ? decision.alertKind === "exit" : placed?.intent?.reduceOnly === true || placed?.entryAvgPrice !== undefined;
      const entryAvgPrice = decision?.entryAvgPrice ?? placed?.entryAvgPrice;
      const positionSide = decision?.positionSide ?? placed?.positionSide ?? f.outcome;
      await this.alert({
        kind: "fill",
        botId,
        message: `fill: ${f.side} ${f.size} ${shortRef(f.marketRef)} @ ${f.price}`,
        data: { orderId: f.orderId, fee: f.fee },
        ...this.baseAlert(f.ts),
        market: this.alertMarket(f.marketRef, f.outcome ?? decision?.outcome ?? placed?.intent?.outcome, undefined, {
          tokenId: f.tokenId ?? decision?.tokenId ?? placed?.intent?.tokenId,
          conditionId: f.conditionId ?? decision?.conditionId ?? placed?.intent?.conditionId,
        }),
        trade: {
          side: f.side,
          size: f.size,
          price: f.price,
          notionalUsd: f.size * f.price,
          ...(f.fee !== undefined ? { feeUsd: f.fee } : {}),
          ...(f.orderId ? { orderId: f.orderId } : {}),
          ...(positionSide ? { positionSide } : {}),
          filled: true,
        },
        ...(closing ? optionalPnl(closingPnl(entryAvgPrice, positionSide, f.size, f.price, f.fee, "realized")) : {}),
        ...(decision?.reason ? { reason: decision.reason } : {}),
      });
    }
    await state.set(StateKeys.lastFillTs, String(maxTs + 1));
  }

  private async expireStaleOrders(seq: number): Promise<void> {
    const { adapter, account, config, botId } = this.d;
    const open = await adapter.openOrders(account);
    const cutoff = this.now() - config.risk.orderTtlSec * 1000;
    const managed = new Set((await this.predictions?.snapshot())?.parents.flatMap(parent => parent.childOrderIds) ?? []);
    for (const o of open) {
      if (managed.has(o.id)) continue;
      if (isProtectiveOrder(o)) continue;
      const placedRec = await getJson<{ ts: number }>(this.d.state, `orders:placed:${o.id}`);
      if (this.predictions && !placedRec) continue;
      const createdAt = o.createdAt ?? placedRec?.ts;
      if (createdAt === undefined || createdAt > cutoff) continue;
      await adapter.cancelOrder(account, o.id);
      await this.d.state.delete(`orders:placed:${o.id}`);
      await this.alert({
        kind: o.filledSize > 0 ? "partial-fill-timeout" : "skipped-order",
        botId,
        message:
          o.filledSize > 0
            ? `order ${o.id} partially filled ${o.filledSize}/${o.size}, remainder canceled at TTL`
            : `order ${o.id} unfilled after ${config.risk.orderTtlSec}s, canceled`,
        data: { marketRef: o.marketRef, side: o.side, price: o.price },
        ...this.baseAlert(),
        market: this.alertMarket(o.marketRef, o.outcome),
        trade: { side: o.side, size: o.size, price: o.price, orderId: o.id },
        reason: o.filledSize > 0
          ? `partially filled ${o.filledSize}/${o.size}; remainder canceled`
          : `unfilled after ${config.risk.orderTtlSec}s; canceled`,
      });
    }
  }

  private async maintainDeadMansSwitch(): Promise<void> {
    await this.heartbeatIfResting();
  }

  /**
   * Send one dead-man's-switch keep-alive if any order is resting. Returns
   * whether orders are resting, so runtimes can drive a fast (~5s for
   * Polymarket) heartbeat loop while true and stop it when false (§10).
   */
  async heartbeatIfResting(): Promise<boolean> {
    if (this.perps) return false;
    if (this.predictions) return this.predictions.heartbeat();
    const { adapter, account } = this.d;
    if (!adapter.heartbeat) return false;
    const open = await adapter.openOrders(account);
    if (open.length === 0) return false;
    await adapter.heartbeat(account);
    return true;
  }

  /** Cancel all resting orders (used by local runtime shutdown). */
  async cancelAllResting(): Promise<void> {
    if (this.perps) return this.perps.cancelWorkingOrders();
    if (this.predictions) await this.predictions.cancelAll("operator cancellation");
    await this.d.adapter.cancelAll(this.d.account);
  }

  get adaptivePredictionExecution(): boolean { return this.predictions !== undefined; }
  async recoverPredictions(): Promise<void> {
    if (this.predictions) await this.predictions.recover();
    else await assertPredictionExecutionSettled(this.d.state);
  }
  async resumePredictions(): Promise<void> { await this.predictions?.resume(); }
  beginPredictionShutdown(): Promise<void> {
    this.redemptionsStopping = true;
    return this.predictions?.beginShutdown() ?? Promise.resolve();
  }
  /** The runtime keeps the store open until every submitted receipt is journaled. */
  async drainRedemptions(): Promise<void> {
    this.redemptionsStopping = true;
    await Promise.allSettled([...this.redemptions.values()]);
  }
  async predictionStatus() { return this.predictions?.snapshot(); }
  async supervisePredictions(): Promise<void> {
    await this.predictions?.supervise({
      routine: this.d.adapter.id === "polymarket",
      paused: (await this.d.state.get(StateKeys.paused)) === "true",
      ...this.predictionSignals,
      exitDecisions: this.predictionExitDecisions,
      exitsEvaluatedAt: this.predictionExitsEvaluatedAt,
    });
  }
  async cancelPredictionOrder(orderId: string): Promise<boolean> {
    if (!this.predictions) return false;
    const parent = (await this.predictions.snapshot()).parents.find(parent => parent.childOrderIds.includes(orderId));
    if (!parent) return false;
    await this.predictions.cancelMarket(parent.marketRef, "operator cancellation");
    return true;
  }

  async supervisePerps(): Promise<void> { await this.perps?.reconcile(); }
  async perpStatus() { return this.perps?.status(); }
  async haltPerps(): Promise<void> { await this.perps?.halt(); }
  async resumePerps(acknowledgeLossReset = false): Promise<void> { await this.perps?.resume(acknowledgeLossReset); }

  // -------------------------------------------------------------------------
  // Errors and alerts (§14): structured error table + deduped Telegram alert
  // -------------------------------------------------------------------------

  /**
   * An order below a minimum is not an order. The strategy asks again on every
   * tick, so log the reason once per market and send no alert.
   */
  private skipBelowMinimum(p: MinimumSkipOrder, reason: string): StrategyActionResult {
    this.minimumSkips.refuse(minimumSkipKey(p), `skipped ${p.side} ${shortRef(p.marketRef)}: ${reason}`);
    return { placed: false };
  }

  private async alert(event: AlertEvent): Promise<void> {
    try {
      await this.d.alerter.send(event);
    } catch (err) {
      this.d.log.warn(`alert delivery failed: ${(err as Error).message}`);
    }
  }

  private async recordError(seq: number, code: string, err: unknown, context?: Record<string, unknown>): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.d.log.error(`[${code}] ${message}`, context);
    await this.d.state.appendError({
      ts: this.now(),
      level: "error",
      code,
      venue: this.d.adapter.id,
      message,
      context,
      tickSeq: seq,
    });

    // Dedup within the configured window so a flapping venue doesn't flood chat.
    const windowMs = this.d.config.alerts.errorDedupMin * 60_000;
    // One venue cooldown can fail several stages, with a different countdown or
    // request cursor each time. Keep every error above, but send one rate-limit alert.
    const fingerprint = isRateLimitError(err)
      ? `venue-rate-limit:${this.d.adapter.id}`
      : `${code}:${message.slice(0, 80)}`;
    const seen = (await getJson<Record<string, number>>(this.d.state, StateKeys.alertFingerprints)) ?? {};
    const last = seen[fingerprint] ?? 0;
    if (this.now() - last < windowMs) return;
    for (const [k, ts] of Object.entries(seen)) {
      if (this.now() - ts > windowMs) delete seen[k];
    }
    seen[fingerprint] = this.now();
    await setJson(this.d.state, StateKeys.alertFingerprints, seen);
    await this.alert({
      kind: "error",
      botId: this.d.botId,
      message: `error [${code}]: ${message.slice(0, 200)}`,
      data: { tick: seq, fingerprint },
      ...this.baseAlert(),
      ...(typeof context?.marketRef === "string" ? { market: this.alertMarket(context.marketRef) } : {}),
    });
  }

  private rememberTitles(positions: readonly Position[]): void {
    for (const p of positions) if (p.label) this.marketTitles.set(p.marketRef, p.label);
  }

  private alertMarket(ref: string, outcome?: "YES" | "NO", title?: string,
    identity: Pick<Position, "tokenId" | "conditionId"> = {}): NonNullable<AlertEvent["market"]> {
    const known = title ?? this.marketTitles.get(ref);
    return { ref, ...(known ? { title: known } : {}), ...(outcome ? { outcome } : {}),
      ...(identity.tokenId ? { tokenId: identity.tokenId } : {}), ...(identity.conditionId ? { conditionId: identity.conditionId } : {}) };
  }

  /** Where and when, shared by every alert this engine sends. */
  private baseAlert(atMs?: number): Pick<AlertEvent, "at" | "venue" | "strategy"> {
    return { at: new Date(atMs ?? this.now()).toISOString(), venue: this.d.adapter.id, strategy: this.d.config.strategy.id };
  }
}

function optionalPnl(pnl: AlertEvent["pnl"] | undefined): Pick<AlertEvent, "pnl"> {
  return pnl ? { pnl } : {};
}

/** Exit P&L at the limit price; else the strategy's own executable P&L estimate. */
function exitPnl(
  entryAvgPrice: number | undefined,
  positionSide: PositionSide | undefined,
  size: number,
  price: number,
  provenance: Record<string, unknown> | undefined,
): AlertEvent["pnl"] | undefined {
  const computed = closingPnl(entryAvgPrice, positionSide, size, price, 0, "executable");
  if (computed) return computed;
  const pct = provenance?.executablePnlPct;
  return typeof pct === "number" && Number.isFinite(pct) ? { pct, basis: "executable" } : undefined;
}

function shortRef(marketRef: string): string {
  return marketRef.length > 18 ? `${marketRef.slice(0, 8)}…${marketRef.slice(-6)}` : marketRef;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Floor a rounded order size so its worst-case limit notional cannot exceed a USD cap. */
function floorSizeToNotionalCap(size: number, limitPrice: number, notionalCap: number, dp: number): number {
  if (
    !Number.isFinite(size) ||
    !Number.isFinite(limitPrice) ||
    !Number.isFinite(notionalCap) ||
    size <= 0 ||
    limitPrice <= 0 ||
    notionalCap <= 0
  ) {
    return 0;
  }
  const scale = 10 ** dp;
  let units = Math.floor(Math.min(size, notionalCap / limitPrice) * scale);
  while (units > 0 && (units / scale) * limitPrice > notionalCap) units -= 1;
  return units / scale;
}

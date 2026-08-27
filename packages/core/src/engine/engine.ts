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
  OrderIntent,
  OrderSide,
  Position,
  PositionSide,
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
import { checkCapacity } from "../risk/capacity.js";
import { mirrorBookForNo, mirrorQuoteForNo } from "./mirror.js";
import { StateKeys, getJson, setJson } from "../state.js";

export interface ArmedTrigger {
  marketRef: string;
  outcome?: "YES" | "NO";
  posSide: PositionSide;
  kind: "stop" | "tp" | "trail";
  /** Trigger level for stop/tp. */
  level?: number;
  /** Trail distance in bps for trail. */
  trailBps?: number;
  /** High-water (LONG/YES) or low-water (SHORT/NO) mark for trail. */
  waterMark?: number;
  armedAt: number;
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
  /** Skip §9 volume-floor eligibility (still slippage/depth-capped). Manual override only. */
  ignoreVolumeFloor?: boolean;
  /** Per-order slippage tolerance as a percentage from the touch; overrides risk.slippagePct. */
  slippagePct?: number;
  /**
   * Human-facing rationale for this trade, written for readers rather than
   * logs — a thesis `reasoningSummary`, or `--note` on the CLI. Carried into
   * the order alert so a feed publisher can use it as the post caption.
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

interface AdvanceableSource {
  advance(): void;
}
function isAdvanceable(s: SignalSource): s is SignalSource & AdvanceableSource {
  return typeof (s as Partial<AdvanceableSource>).advance === "function";
}

export class Engine {
  private readonly d: EngineDeps;
  private readonly now: () => number;

  constructor(deps: EngineDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => Date.now());
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
    if ((await state.get(StateKeys.paused)) === "true") {
      return { seq, skipped: true, skipReason: "paused", actions: 0, ordersPlaced: 0, errors: 0 };
    }
    await setJson(state, StateKeys.tickLock, { seq, ts: this.now() });

    let actionsCount = 0;
    let ordersPlaced = 0;
    let errors = 0;

    try {
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

      try {
        const ctx = await this.buildStrategyContext();
        const actions = await this.d.strategy.tick(ctx);
        actionsCount = actions.length;
        for (const action of actions) {
          try {
            const result = await this.executeAction(action, ctx);
            if (result.placed) ordersPlaced += 1;
            await this.d.strategy.onActionResult?.(ctx, action, result);
          } catch (err) {
            errors += 1;
            await this.recordError(seq, `action-${action.kind}`, err, { marketRef: action.marketRef });
          }
        }
      } catch (err) {
        errors += 1;
        await this.recordError(seq, "strategy-tick", err);
      }

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
      candles: adapter.candles ? (m, i, l) => adapter.candles!(m, i, l) : undefined,
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
    const [positions, openOrders, balances] = await Promise.all([
      adapter.positions(account),
      adapter.openOrders(account),
      adapter.balances(account),
    ]);
    const collateral = balances.reduce((s, b) => s + b.total, 0);
    const posValue = positions.reduce((s, p) => s + p.size * p.avgPrice + (p.unrealizedPnl ?? 0), 0);
    return {
      botId,
      venueId: adapter.id,
      config: config.strategy.config,
      signals,
      venue: this.readApi(),
      positions,
      openOrders,
      equity: collateral + posValue,
      log,
      now: this.now,
      memory: this.strategyMemory(),
    };
  }

  // -------------------------------------------------------------------------
  // Action execution (risk module runs before every fill, §9)
  // -------------------------------------------------------------------------

  private async executeAction(action: Action, ctx: StrategyContext): Promise<StrategyActionResult> {
    const { adapter, account } = this.d;
    switch (action.kind) {
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
        const result = await this.placeChecked({
          marketRef: action.marketRef,
          outcome: isPrediction ? (pos.side as "YES" | "NO") : undefined,
          side: orderSide,
          desiredSize: pos.size,
          reduceOnly: !isPrediction,
          reason: action.reason ?? "strategy-exit",
          alertKind: "exit",
          alertMessage: `exit ${pos.side} ${shortRef(action.marketRef)}${action.reason ? ` (${action.reason})` : ""}`,
        });
        if (result.placed) await this.disarmTriggers(action.marketRef);
        return result;
      }
      case "redeem": {
        const pos = ctx.positions.find((p) => p.marketRef === action.marketRef);
        if (!pos || !adapter.redeem) return { placed: false };
        await adapter.redeem(account, pos);
        await this.alert({
          kind: "resolution",
          botId: this.d.botId,
          message: `redeemed resolved position ${pos.side} ${shortRef(action.marketRef)}`,
          data: { size: pos.size },
        });
        return { placed: false };
      }
    }
  }

  private async quoteFor(marketRef: string, outcome?: "YES" | "NO") {
    const [book, quote] = await Promise.all([this.d.adapter.book(marketRef), this.d.adapter.quote(marketRef)]);
    if (outcome === "NO") return { book: mirrorBookForNo(book), quote: mirrorQuoteForNo(quote) };
    return { book, quote };
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
    ignoreVolumeFloor?: boolean;
    reason: string;
    alertKind: AlertEvent["kind"];
    alertMessage: string;
  }): Promise<StrategyActionResult> {
    const { adapter, account, config, botId } = this.d;
    const { book, quote } = await this.quoteFor(p.marketRef, p.outcome);
    const refPrice = p.limitPrice ?? quote.mid;
    const desiredSize = p.desiredSize ?? (p.desiredNotional ?? 0) / refPrice;

    const risk = p.ignoreVolumeFloor ? { ...config.risk, minDailyVolume: 0 } : config.risk;
    const cap = checkCapacity({
      side: p.side,
      desiredSize,
      refPrice,
      book,
      quote,
      risk,
      minimumNotional: p.minimumNotional,
    });
    if (!cap.ok) {
      await this.alert({
        kind: "skipped-order",
        botId,
        message: `skipped ${p.side} ${shortRef(p.marketRef)}: ${cap.skipReasons.join("; ")}`,
      });
      return { placed: false };
    }
    const limitPrice = p.limitPrice ?? cap.limitPrice;
    const intent: OrderIntent = {
      marketRef: p.marketRef,
      outcome: p.outcome,
      side: p.side,
      size: round(cap.size, 6),
      limitPrice: round(limitPrice, 6),
      tif: p.tif ?? "GTC",
      clientId: `${botId}-${this.now()}-${Math.floor(Math.random() * 1e6)}`,
      reduceOnly: p.reduceOnly,
      triggers: p.triggers,
    };
    const ack = await adapter.placeOrder(account, intent);
    await setJson(this.d.state, `orders:placed:${ack.orderId}`, { ts: this.now(), intent });
    await this.alert({
      kind: p.alertKind,
      botId,
      message: `${p.alertMessage}: ${p.side} ${intent.size} @ ${intent.limitPrice}${cap.capped ? " (size capped)" : ""}`,
      data: {
        orderId: ack.orderId,
        status: ack.status,
        // Trade reference for downstream publishers (Ares position cards).
        ...(ack.tokenId ? { asset: ack.tokenId } : {}),
        ...(ack.funder ? { funder: ack.funder } : {}),
        ...(ack.builderCode ? { builderCode: ack.builderCode } : {}),
        reason: p.reason,
        ...(cap.notes.length ? { capacity: cap.notes.join("; ") } : {}),
      },
    });
    return {
      placed: ack.status !== "rejected",
      ...(p.desiredNotional !== undefined ? { placedNotional: round(intent.size * intent.limitPrice, 6) } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Manual trading (§10)
  // -------------------------------------------------------------------------

  async manualOrder(p: ManualOrderParams): Promise<ManualOrderResult> {
    const { adapter, account, config, botId } = this.d;
    const { book, quote } = await this.quoteFor(p.marketRef, p.outcome);
    const refPrice = p.limitPrice ?? quote.mid;
    const risk = {
      ...config.risk,
      ...(p.ignoreVolumeFloor ? { minDailyVolume: 0 } : {}),
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
    const ack = await adapter.placeOrder(account, intent);
    await setJson(this.d.state, `orders:placed:${ack.orderId}`, { ts: this.now(), intent });

    // Manual and thesis-driven orders raise the same alert a strategy entry
    // does. Without this they were invisible to every alert sink — including
    // any feed publisher, which is exactly where a thesis belongs.
    await this.alert({
      kind: p.reduceOnly ? "exit" : "entry",
      botId,
      message: `${p.reduceOnly ? "exit" : "enter"} ${p.outcome ?? p.side} ${shortRef(p.marketRef)}: ${p.side} ${intent.size} @ ${intent.limitPrice}`,
      data: {
        orderId: ack.orderId,
        status: ack.status,
        ...(ack.tokenId ? { asset: ack.tokenId } : {}),
        ...(ack.funder ? { funder: ack.funder } : {}),
        ...(ack.builderCode ? { builderCode: ack.builderCode } : {}),
        ...(p.note ? { note: p.note } : {}),
        source: "manual",
      },
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
  async checkTriggers(seq?: number): Promise<void> {
    const triggers = await this.loadTriggers();
    if (triggers.length === 0) return;
    const positions = await this.d.adapter.positions(this.d.account);
    const remaining: ArmedTrigger[] = [];
    for (const t of triggers) {
      const pos = positions.find((p) => p.marketRef === t.marketRef);
      if (!pos || pos.size <= 0) continue; // position gone; drop trigger
      const { quote } = await this.quoteFor(t.marketRef, t.outcome);
      const bullish = t.posSide === "LONG" || t.posSide === "YES";
      let fired = false;
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
      if (!fired) {
        remaining.push(t);
        continue;
      }
      const isPrediction = t.posSide === "YES" || t.posSide === "NO";
      await this.placeChecked({
        marketRef: t.marketRef,
        outcome: t.outcome,
        side: t.posSide === "SHORT" ? "BUY" : "SELL",
        desiredSize: pos.size,
        reduceOnly: !isPrediction,
        ignoreVolumeFloor: true, // a firing stop must exit even in a quiet market
        reason: `synthetic-${t.kind}`,
        alertKind: "exit",
        alertMessage: `synthetic ${t.kind} fired for ${t.posSide} ${shortRef(t.marketRef)}`,
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
    for (const f of fills) {
      maxTs = Math.max(maxTs, f.ts);
      await this.alert({
        kind: "fill",
        botId,
        message: `fill: ${f.side} ${f.size} ${shortRef(f.marketRef)} @ ${f.price}`,
        data: { orderId: f.orderId, fee: f.fee },
      });
    }
    await state.set(StateKeys.lastFillTs, String(maxTs + 1));
  }

  private async expireStaleOrders(seq: number): Promise<void> {
    const { adapter, account, config, botId } = this.d;
    const open = await adapter.openOrders(account);
    const cutoff = this.now() - config.risk.orderTtlSec * 1000;
    for (const o of open) {
      const placedRec = await getJson<{ ts: number }>(this.d.state, `orders:placed:${o.id}`);
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
    const { adapter, account } = this.d;
    if (!adapter.heartbeat) return false;
    const open = await adapter.openOrders(account);
    if (open.length === 0) return false;
    await adapter.heartbeat(account);
    return true;
  }

  /** Cancel all resting orders (used by local runtime shutdown). */
  async cancelAllResting(): Promise<void> {
    await this.d.adapter.cancelAll(this.d.account);
  }

  // -------------------------------------------------------------------------
  // Errors and alerts (§14): structured error table + deduped Telegram alert
  // -------------------------------------------------------------------------

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
    const fingerprint = `${code}:${message.slice(0, 80)}`;
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
    });
  }
}

function shortRef(marketRef: string): string {
  return marketRef.length > 18 ? `${marketRef.slice(0, 8)}…${marketRef.slice(-6)}` : marketRef;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

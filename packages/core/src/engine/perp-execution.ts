// packages/core/src/engine/perp-execution.ts
// Durable, engine-owned perp execution. Strategy/model output never signs or places orders.
import { createHash } from "node:crypto";
import type { Action, Alerter, Logger, Order, OrderAck, OrderIntent, Position, StateStore, StrategyActionResult, VenueAccount, VenueAdapter } from "../types.js";
import type { PerpAccountSnapshot, PerpCycle, PerpExecutionState, PerpMarketSnapshot } from "../perps.js";
import { getJson, setJson } from "../state.js";
import { checkCapacity } from "../risk/capacity.js";
import { formatBoundedHlPrice } from "../venues/hyperliquid-perps.js";
import { HyperliquidOrderNotSubmittedError, HyperliquidOrderRejectedError, toCloid } from "../venues/hyperliquid.js";

export const PERP_EXECUTION_KEY = "perp:execution:v1";
const OVERLAP_MS = 5 * 60_000;

interface Submission {
  intent: OrderIntent;
  cycleId: string;
  createdAt: number;
  status: "prepared" | "unknown" | "accepted" | "terminal";
  orderId?: string;
  ack?: OrderAck;
  rejectionReason?: string;
}
interface Cycle extends PerpCycle {
  seenPositionAt?: number;
  absentSince?: number;
  stopGeneration?: number;
  exitTargetSize?: number;
  lastExitSubmitAt?: number;
  szDecimals?: number;
  maintenanceMarginRate?: number;
  fundingStressHourly?: number;
  costFraction?: number;
  /** Keep all generations until flat; a lost replacement ack must not orphan the old stop. */
  stopOrderIds?: string[];
  stopClientIds?: string[];
  pendingStopClientId?: string;
  /** Take-profit generations, kept until flat for the same reason as stops. */
  targetGeneration?: number;
  targetOrderIds?: string[];
  targetClientIds?: string[];
  pendingTargetClientId?: string;
  targetRetryAt?: number;
}
interface Ledger extends Omit<PerpExecutionState, "cycles"> {
  version: 1;
  configHash: string;
  /** Hash of PROTECTION_KEYS for the configuration the ledger was last enabled under. */
  protectionHash?: string;
  cycles: Cycle[];
  submissions: Record<string, Submission>;
  initializedAt: number;
  fillSince: number;
  seenFills: string[];
  flowSince: number;
  seenFlows: string[];
  cumulativeCashFlow: number;
  lastEquity: number;
  shutdownQuietUntil?: number;
}
export interface PerpExecutorDeps {
  botId: string;
  config: Record<string, unknown>;
  adapter: VenueAdapter;
  account: VenueAccount;
  state: StateStore;
  alerter: Alerter;
  log: Logger;
  now?: () => number;
  /** Tests may advance an injected clock; production uses an ordinary timer. */
  sleep?: (ms: number) => Promise<void>;
}

function positive(n: number): boolean { return Number.isFinite(n) && n > 0; }
export function isProtectiveOrder(order: Order): boolean {
  return order.reduceOnly === true && order.isTrigger === true;
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/**
 * Settings that shape protection of an open position. A configuration change
 * that leaves these untouched (sizing, slots, budgets) may be resumed with
 * exposure; a change to any of them still requires a flat book.
 */
const PROTECTION_KEYS = ["stopSigmaMultiple", "liquidationStopMultiple", "emergencyGapFraction", "maxHoldHours",
  "minHorizonHours", "maxHorizonHours", "maxSlippageBps", "drawdownHaltFraction", "exitRetryMin"] as const;
function protectionHash(config: Record<string, unknown>): string {
  return hash(Object.fromEntries(PROTECTION_KEYS.map(key => [key, config[key] ?? null])));
}
function orderAck(order: Order): OrderAck {
  return { orderId: order.id, clientId: order.clientId, status: order.status, filledSize: order.filledSize };
}
function sameClient(venueId: string | undefined, localId: string | undefined): boolean {
  return !!venueId && !!localId && (venueId === localId || venueId.toLowerCase() === toCloid(localId));
}
function fundingStress(m: PerpMarketSnapshot, side: "LONG" | "SHORT"): number {
  const direction = side === "LONG" ? 1 : -1;
  return Math.max(0, direction * m.fundingRateHourly);
}

export class PerpExecutor {
  private readonly now: () => number;
  private readonly configHash: string;
  private readonly protectionHash: string;
  private readyInThisProcess = false;
  constructor(private readonly d: PerpExecutorDeps) {
    this.now = d.now ?? Date.now;
    this.configHash = hash(d.config);
    this.protectionHash = protectionHash(d.config);
  }
  private n(key: string, fallback: number): number {
    const value = this.d.config[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }
  private async ledger(): Promise<Ledger> {
    return await getJson<Ledger>(this.d.state, PERP_EXECUTION_KEY) ?? {
      version: 1, configHash: this.configHash, cycles: [], submissions: {},
      initializedAt: this.now(), halted: true, haltReason: "startup-readiness",
      highWaterEquity: 0, drawdownPct: 0, lastEquity: 0, cashFlowsComplete: false,
      fillSince: this.now() - OVERLAP_MS, seenFills: [], flowSince: this.now(), seenFlows: [], cumulativeCashFlow: 0,
    };
  }
  private save(s: Ledger): Promise<void> {
    // A ledger running under its enabled configuration records that configuration's
    // protection settings, so a later sizing-only change can be resumed with exposure.
    if (s.configHash === this.configHash && !s.protectionHash) s.protectionHash = this.protectionHash;
    return setJson(this.d.state, PERP_EXECUTION_KEY, s);
  }
  private pause(ms: number): Promise<void> { return this.d.sleep?.(ms) ?? new Promise(resolve => setTimeout(resolve, ms)); }
  private async reconcileCancel(s: Ledger, id: string): Promise<void> {
    try { await this.d.adapter.cancelOrder(this.d.account, id); }
    catch { s.halted = true; s.haltReason = "working-order-cancel-unknown"; }
  }
  private ownsStop(c: Cycle, o: Order): boolean {
    return o.id === c.stopOrderId || (c.stopOrderIds ?? []).includes(o.id) ||
      [c.stopClientId, c.pendingStopClientId, ...(c.stopClientIds ?? [])].some(id => sameClient(o.clientId, id));
  }
  private ownsTarget(c: Cycle, o: Order): boolean {
    return o.id === c.targetOrderId || (c.targetOrderIds ?? []).includes(o.id) ||
      [c.targetClientId, c.pendingTargetClientId, ...(c.targetClientIds ?? [])].some(id => sameClient(o.clientId, id));
  }
  /** Orders that shutdown and entry cancellation leave on the venue: native stops and owned take-profits. */
  private retained(s: Ledger, o: Order): boolean {
    return isProtectiveOrder(o) || s.cycles.some(c => c.status !== "closed" && this.ownsTarget(c, o));
  }
  private ownsSubmission(s: Ledger, o: Order): boolean {
    return Object.values(s.submissions).some(sub => o.id === sub.orderId || sameClient(o.clientId, sub.intent.clientId));
  }
  private unmanaged(s: Ledger, a: PerpAccountSnapshot): boolean {
    const active = s.cycles.filter(c => c.status !== "closed");
    return a.positions.some(p => p.size > 0 && !active.some(c => c.marketRef === p.marketRef && c.side === p.side && p.marginMode === "isolated")) ||
      a.openOrders.some(o => !this.ownsSubmission(s, o) && !active.some(c => this.ownsStop(c, o) || this.ownsTarget(c, o)));
  }
  private validStop(c: Cycle, p: Position, o: Order): boolean {
    if (o.marketRef !== c.marketRef || !this.ownsStop(c, o) || !isProtectiveOrder(o) || o.triggerKind !== "sl" ||
      !["open", "partial"].includes(o.status) || o.side !== (c.side === "LONG" ? "SELL" : "BUY")) return false;
    const remaining = o.size - (o.filledSize ?? 0);
    const expected = c.szDecimals === undefined ? c.stopPx : Number(formatBoundedHlPrice(c.stopPx, c.szDecimals, o.side));
    return Math.abs(remaining - p.size) <= Math.max(1e-9, p.size * 1e-8) &&
      Math.abs((o.triggerPrice ?? NaN) - expected) <= Math.max(1e-9, expected * 1e-10);
  }
  private rememberStop(c: Cycle, id: string): void {
    c.stopOrderIds = [...new Set([...(c.stopOrderIds ?? []), ...(c.stopOrderId ? [c.stopOrderId] : []), id])];
  }
  private validTarget(c: Cycle, p: Position, o: Order): boolean {
    if (!positive(c.targetPx ?? NaN) || o.marketRef !== c.marketRef || !this.ownsTarget(c, o) || o.reduceOnly !== true || o.isTrigger === true ||
      !["open", "partial"].includes(o.status) || o.side !== (c.side === "LONG" ? "SELL" : "BUY")) return false;
    const remaining = o.size - (o.filledSize ?? 0);
    const expected = c.szDecimals === undefined ? c.targetPx! : Number(formatBoundedHlPrice(c.targetPx!, c.szDecimals, o.side));
    return Math.abs(remaining - p.size) <= Math.max(1e-9, p.size * 1e-8) &&
      Math.abs(o.price - expected) <= Math.max(1e-9, expected * 1e-10);
  }
  private rememberTarget(c: Cycle, id: string): void {
    c.targetOrderIds = [...new Set([...(c.targetOrderIds ?? []), ...(c.targetOrderId ? [c.targetOrderId] : []), id])];
  }
  private async alert(kind: "entry" | "exit" | "error" | "fill" | "skipped-order", message: string, data?: Record<string, unknown>): Promise<void> {
    // The journal carries the reason even when alert delivery is misconfigured.
    if (kind === "error" || kind === "skipped-order") this.d.log.warn(`${message}${data?.detail !== undefined ? `: ${String(data.detail)}` : ""}`);
    await this.d.alerter.send({ kind, botId: this.d.botId, message, data }).catch(e => this.d.log.warn(`alert failed: ${String(e)}`));
  }
  async status(): Promise<PerpExecutionState> {
    const s = await this.ledger();
    return { cycles: s.cycles, halted: s.halted, haltReason: s.haltReason, highWaterEquity: s.highWaterEquity,
      drawdownPct: s.drawdownPct, lastReconciledAt: s.lastReconciledAt, cashFlowsComplete: s.cashFlowsComplete };
  }
  async snapshot(): Promise<PerpAccountSnapshot> {
    const { adapter, account } = this.d;
    if (!adapter.perpAccountSnapshot) throw new Error("venue lacks authoritative perp accounting");
    const a = await adapter.perpAccountSnapshot(account);
    if (a.abstraction !== "standard" || a.dex !== "xyz" || a.collateral !== "USDC") throw new Error("Quotient Swing requires a Standard-mode xyz USDC account");
    if (![a.equity, a.availableCollateral, a.marginUsed, a.grossNotional].every(n => Number.isFinite(n) && n >= 0) || !Number.isFinite(a.ts) || this.now() - a.ts > 60_000 || a.ts > this.now() + 5_000) throw new Error("invalid or stale perp account snapshot");
    return a;
  }
  async halt(reason = "operator"): Promise<void> {
    const s = await this.ledger(); s.halted = true; s.haltReason = reason; await this.save(s);
    await this.cancelEntries();
  }
  private automaticStartupAllowed(s: Ledger): boolean {
    if (!s.halted || s.haltReason === "shutdown-complete") return true;
    // Only pristine ledgers can migrate the former first-run activation gate.
    return (s.haltReason === "startup-readiness" || s.haltReason === "activation-required") &&
      s.cycles.length === 0 && Object.keys(s.submissions).length === 0;
  }
  private async assertReadyToEnable(s: Ledger, acknowledgeLossReset = false): Promise<void> {
    if (!s.cashFlowsComplete) throw new Error("cash-flow reconciliation is incomplete");
    // Only live cycles can hold unresolved protection; a closed cycle's markers are history.
    if (s.cycles.some(c => c.status !== "closed" && (c.status === "blocked" || c.pendingStopClientId)) || Object.values(s.submissions).some(o => o.status === "unknown" || o.status === "prepared")) throw new Error("unresolved perp execution must reconcile before resume");
    if (this.unmanaged(s, await this.snapshot())) throw new Error("unmanaged venue exposure must be resolved before resume");
    if (s.drawdownPct >= this.n("drawdownHaltFraction", .25) * 100 && !acknowledgeLossReset) throw new Error("loss stop requires an explicit loss-reset acknowledgement");
  }
  /** Normal run/restart checks readiness; recovery from any real halt is explicit. */
  async start(): Promise<void> {
    this.readyInThisProcess = false;
    const initial = await this.ledger();
    const allowed = this.automaticStartupAllowed(initial);
    try {
      // Reconciliation/protection continue even when an operator or safety halt is latched.
      await this.reconcile();
      const s = await this.ledger();
      if (!allowed || !this.automaticStartupAllowed(s)) return;
      if (s.configHash !== this.configHash) throw new Error("configuration changed; explicit recovery is required");
      await this.assertReadyToEnable(s);
      s.halted = false; delete s.haltReason; await this.save(s);
      this.readyInThisProcess = true;
    } catch (error) {
      const s = await this.ledger();
      if (this.automaticStartupAllowed(s)) {
        s.halted = true; s.haltReason = "startup-readiness-failed"; await this.save(s);
      }
      throw error;
    }
  }
  async resume(acknowledgeLossReset = false): Promise<void> {
    this.readyInThisProcess = false;
    await this.reconcile();
    const s = await this.ledger();
    if (s.configHash !== this.configHash) {
      const exposed = s.cycles.some(c => c.status !== "closed");
      if (exposed && s.protectionHash !== this.protectionHash) {
        throw new Error("configuration changed with active exposure; restore its original configuration");
      }
      s.configHash = this.configHash;
    }
    s.protectionHash = this.protectionHash;
    await this.assertReadyToEnable(s, acknowledgeLossReset);
    if (acknowledgeLossReset) { s.highWaterEquity = s.lastEquity; s.drawdownPct = 0; }
    s.halted = false; delete s.haltReason; await this.save(s);
    this.readyInThisProcess = true;
  }
  async cancelEntries(): Promise<void> {
    const orders = await this.d.adapter.openOrders(this.d.account);
    const s = await this.ledger();
    for (const o of orders) if (!o.reduceOnly && this.ownsSubmission(s, o) && !isProtectiveOrder(o)) await this.d.adapter.cancelOrder(this.d.account, o.id);
  }
  /**
   * Shutdown preflight. Call while the runtime and state store are still alive.
   * A rejection means keep reconciliation running with additions halted.
   */
  async cancelWorkingOrders(): Promise<void> {
    this.readyInThisProcess = false;
    const { adapter, account } = this.d;
    const initial = await this.ledger();
    const automaticRestart = this.automaticStartupAllowed(initial);
    initial.halted = true;
    if (automaticRestart) initial.haltReason = "shutdown-pending";
    await this.save(initial);
    if (!adapter.disarmScheduledCancel) throw new Error("Shutdown not confirmed: native-stop cancel timer cannot be disarmed");
    await adapter.disarmScheduledCancel(account);
    const started = this.now();
    const deadline = started + 5_000;
    let settleUntil = Math.max(started, initial.shutdownQuietUntil ?? 0);
    let lastProblem = "venue state not confirmed";
    for (let attempt = 0; attempt < 12; attempt++) {
      const s = await this.ledger();
      let cancellationUnconfirmed = false;
      for (const o of await adapter.openOrders(account)) {
        if (!this.ownsSubmission(s, o) || this.retained(s, o)) continue;
        // Cancellation can race a last partial fill. Leave time for account
        // indexing before accepting terminal-order/flat-position evidence.
        settleUntil = this.now() + 5_000;
        s.shutdownQuietUntil = settleUntil; await this.save(s);
        try { await adapter.cancelOrder(account, o.id); }
        catch { cancellationUnconfirmed = true; }
      }
      // Even a failed cancellation must not skip protection for actual fills.
      await this.reconcile();
      const current = await this.ledger();
      const fresh = await this.snapshot();
      const working = fresh.openOrders.some(o => this.ownsSubmission(current, o) && !this.retained(current, o));
      const unresolved = Object.values(current.submissions).some(sub => sub.status !== "terminal");
      const active = current.cycles.filter(c => c.status !== "closed");
      const missingPosition = active.some(c => {
        const filled = c.filledSize > 0 || Object.values(current.submissions).some(sub =>
          sub.cycleId === c.id && !sub.intent.reduceOnly && (sub.ack?.filledSize ?? 0) > 0);
        return filled && !fresh.positions.some(p => p.marketRef === c.marketRef && p.size > 0);
      });
      const unprotected = fresh.positions.some(p => p.size > 0 && !active.some(c =>
        c.marketRef === p.marketRef && c.side === p.side && p.marginMode === "isolated" &&
        fresh.openOrders.some(o => this.validStop(c, p, o))));
      const incompleteExit = active.some(c => c.status === "blocked" || c.pendingStopClientId ||
        (c.status === "exiting" && fresh.positions.some(p => p.marketRef === c.marketRef && p.size > 0)));
      const unmanaged = this.unmanaged(current, fresh);
      if (!working && !unresolved && !missingPosition && !unprotected && !incompleteExit && !unmanaged && this.now() >= settleUntil) {
        // Last venue action removes the global timer; protective orders stay.
        await adapter.disarmScheduledCancel(account);
        // A healthy stop is restartable, but shutdown must not erase a prior
        // operator/loss halt or a safety fault encountered during cancellation.
        if (automaticRestart && current.haltReason === "shutdown-pending") current.haltReason = "shutdown-complete";
        delete current.shutdownQuietUntil; await this.save(current);
        return;
      }
      lastProblem = working ? "working orders remain" : unresolved ? "order acknowledgement unresolved"
        : missingPosition ? "filled position not yet reconciled" : unprotected ? "native stop not confirmed for every position"
        : incompleteExit ? "protection or required exit remains incomplete" : unmanaged ? "unmanaged exposure remains"
        : "waiting for post-cancellation position indexing";
      if (cancellationUnconfirmed) lastProblem += "; cancellation acknowledgement unconfirmed";
      if (this.now() >= deadline) break;
      await this.pause(Math.min(500, deadline - this.now()));
    }
    const final = await this.ledger(); final.halted = true; final.haltReason = "shutdown-unconfirmed"; await this.save(final);
    throw new Error(`Shutdown not confirmed: ${lastProblem}. Keep the runtime running to reconcile and protect exposure.`);
  }

  /** Serialized by the runtime with order submissions; no research/LLM work here. */
  async reconcile(): Promise<void> {
    const { adapter, account } = this.d;
    if (!adapter.disarmScheduledCancel || !adapter.lookupPerpOrder || !adapter.placePerpStop || !adapter.perpCashFlows) throw new Error("venue lacks protected perp execution capabilities");
    await adapter.disarmScheduledCancel(account);
    const a = await this.snapshot();
    const s = await this.ledger();
    if (s.configHash !== this.configHash) { s.halted = true; s.haltReason = "config-drift"; }

    // A ledger outage must halt additions, not prevent protecting a live fill.
    const flow = await adapter.perpCashFlows(account, Math.max(s.initializedAt, s.flowSince - OVERLAP_MS))
      .catch(() => ({ complete: false, flows: [] }));
    s.cashFlowsComplete = flow.complete;
    if (!flow.complete) { s.halted = true; s.haltReason = "cash-flow-incomplete"; }
    let netFlow = 0;
    for (const f of flow.flows) {
      if (s.seenFlows.includes(f.id)) continue;
      if (!Number.isFinite(f.amount) || !Number.isFinite(f.ts)) throw new Error("invalid perp cash flow");
      netFlow += f.amount; s.seenFlows.push(f.id); s.flowSince = Math.max(s.flowSince, f.ts);
    }
    // Unitize deposits/withdrawals: they change capital, not the return high-water mark.
    if (s.lastEquity > 0 && netFlow !== 0) s.highWaterEquity *= Math.max(0, (s.lastEquity + netFlow) / s.lastEquity);
    s.cumulativeCashFlow += netFlow;
    s.highWaterEquity = Math.max(s.highWaterEquity, a.equity);
    s.lastEquity = a.equity;
    s.drawdownPct = s.highWaterEquity > 0 ? Math.max(0, 100 * (1 - a.equity / s.highWaterEquity)) : 0;
    if (s.drawdownPct >= this.n("drawdownHaltFraction", .25) * 100) { s.halted = true; s.haltReason = "drawdown"; }

    // Resolve lost responses by stable client id. Never resubmit an unknown request.
    for (const sub of Object.values(s.submissions)) {
      if (sub.status === "terminal") continue;
      const visible = a.openOrders.find(o => o.id === sub.orderId || sameClient(o.clientId, sub.intent.clientId));
      if (visible) {
        sub.orderId = visible.id; sub.status = "accepted"; sub.ack = orderAck(visible);
      } else {
        const lookup = await adapter.lookupPerpOrder(account, sub.intent.clientId).catch(() => ({ found: false as const, definitive: false }));
        if (lookup.found) {
          sub.orderId = lookup.order.id; sub.ack = lookup.ack;
          sub.status = ["open", "partial"].includes(lookup.order.status) ? "accepted" : "terminal";
        } else if (lookup.definitive && this.now() - sub.createdAt >= OVERLAP_MS) sub.status = "terminal";
        else if (sub.status === "prepared") sub.status = "unknown";
      }
      const cycle = s.cycles.find(c => c.id === sub.cycleId);
      if (cycle && sub.orderId && !sub.intent.reduceOnly && !cycle.entryOrderIds.includes(sub.orderId)) cycle.entryOrderIds.push(sub.orderId);
      if (cycle && !sub.intent.reduceOnly && (sub.ack?.filledSize ?? 0) > 0) {
        cycle.openedAt ??= sub.createdAt;
        if (positive(sub.ack?.avgFillPrice ?? NaN)) cycle.entryPrice = sub.ack!.avgFillPrice!;
      }
      if (visible && !visible.reduceOnly && (s.halted || this.now() - sub.createdAt >= this.n("entryTtlMin", 15) * 60_000)) await this.reconcileCancel(s, visible.id);
    }
    // A flat, settled ledger has no owned fill to discover. Venue exposure is
    // still checked from the authoritative account snapshot below, and cash
    // flows above remain current even while there are no strategy positions.
    const needsFillHistory = s.cycles.some(c => c.status !== "closed") ||
      Object.values(s.submissions).some(sub => sub.status !== "terminal");
    const fills = needsFillHistory ? await adapter.fills(account, Math.max(0, s.fillSince - OVERLAP_MS)).catch(() => {
      s.halted = true; s.haltReason = "fill-reconciliation-unavailable"; return [];
    }) : [];
    for (const f of fills) {
      if (s.seenFills.includes(f.id)) continue;
      const target = f.orderId === undefined ? undefined
        : s.cycles.find(c => c.status !== "closed" && (c.targetOrderId === f.orderId || (c.targetOrderIds ?? []).includes(f.orderId!)));
      if (target) {
        target.targetFilledSize = (target.targetFilledSize ?? 0) + f.size;
        target.exitReason ??= "target";
        s.seenFills.push(f.id); s.fillSince = Math.max(s.fillSince, f.ts);
        await this.alert("fill", `${f.side} ${f.size} ${f.marketRef} @ ${f.price} (take-profit)`, { fee: f.fee, orderId: f.orderId, reason: "target" });
        continue;
      }
      const sub = Object.values(s.submissions).find(o => o.orderId === f.orderId);
      if (!sub) continue;
      const c = s.cycles.find(cycle => cycle.id === sub.cycleId);
      if (c && !sub.intent.reduceOnly) c.openedAt = Math.min(c.openedAt ?? f.ts, f.ts);
      s.seenFills.push(f.id); s.fillSince = Math.max(s.fillSince, f.ts);
      await this.alert("fill", `${f.side} ${f.size} ${f.marketRef} @ ${f.price}`, { fee: f.fee, orderId: f.orderId });
    }
    s.seenFills = s.seenFills.slice(-20_000); s.seenFlows = s.seenFlows.slice(-20_000);
    const knownOrders = new Set(Object.values(s.submissions).map(x => x.orderId));
    if (this.unmanaged(s, a)) { s.halted = true; s.haltReason = "unmanaged-exposure"; }
    for (const c of s.cycles.filter(c => c.status !== "closed")) {
      const pos = a.positions.find(p => p.marketRef === c.marketRef && p.size > 0);
      if (!pos) {
        const pending = Object.values(s.submissions).some(o => o.cycleId === c.id && (o.status !== "terminal" || this.now() - o.createdAt < OVERLAP_MS));
        if (pending) continue;
        c.absentSince ??= this.now();
        if (this.now() - c.absentSince < 5_000) continue;
        // Only a confirmed flat venue snapshot permits removing the remaining stop and take-profit.
        for (const o of a.openOrders.filter(o => this.ownsStop(c, o) || this.ownsTarget(c, o))) await adapter.cancelOrder(account, o.id);
        if ((c.targetFilledSize ?? 0) > 0) c.exitReason ??= "target";
        c.status = "closed"; c.closedAt = this.now(); c.filledSize = 0;
        delete c.pendingStopClientId; delete c.pendingTargetClientId;
        continue;
      }
      delete c.absentSince;
      if (pos.side !== c.side || pos.marginMode !== "isolated") {
        c.status = "blocked"; s.halted = true; s.haltReason = "position-identity-mismatch"; continue;
      }
      c.seenPositionAt = this.now(); c.openedAt ??= this.now(); c.filledSize = pos.size; c.entryPrice = pos.avgPrice;
      if (c.status === "pending") c.status = "open";
      await this.ensureStop(s, c, pos, a.openOrders);
      const mark = pos.currentPrice ?? pos.avgPrice;
      const distance = Math.abs(mark - c.stopPx);
      const liq = pos.liquidationPrice;
      const stopBreached = c.side === "LONG" ? mark <= c.stopPx : mark >= c.stopPx;
      let fundingKnown = true;
      if (adapter.fundingRate) {
        try {
          const hourly = (await adapter.fundingRate(c.marketRef)) / 8;
          if (!Number.isFinite(hourly)) throw new Error("invalid funding rate");
          c.fundingStressHourly = Math.max(c.fundingStressHourly ?? 0, (c.side === "LONG" ? 1 : -1) * hourly, 0);
        } catch { fundingKnown = false; s.halted = true; s.haltReason = "funding-unavailable"; }
      }
      const maintenance = c.maintenanceMarginRate ?? .025;
      const funding = (c.fundingStressHourly ?? 0) * Math.max(0, (c.anchorAt - this.now()) / 3_600_000) /
        (1 - (c.side === "LONG" ? 1 : -1) * maintenance);
      const actualDistance = (c.side === "LONG" ? mark - (liq ?? NaN) : (liq ?? NaN) - mark) / mark;
      const requiredDistance = this.n("liquidationStopMultiple", 1.5) * distance / mark + this.n("emergencyGapFraction", .02) + funding;
      const liqUnsafe = !fundingKnown || !positive(liq ?? NaN) || !Number.isFinite(actualDistance) || actualDistance < requiredDistance;
      if (stopBreached || liqUnsafe || this.now() >= Math.min(c.anchorAt, (c.openedAt ?? c.createdAt) + 120 * 3_600_000)) {
        c.exitReason = stopBreached ? "protective-stop" : liqUnsafe ? "liquidation-buffer" : "time-limit";
        c.exitTargetSize = 0; c.status = "exiting";
      }
      if (distance <= 0 || !Number.isFinite(distance)) { s.halted = true; s.haltReason = "invalid-stop"; }
      // The take-profit follows the status decision so an exiting cycle removes it before any exit order.
      const targetsClear = await this.ensureTarget(s, c, pos, a.openOrders);
      if (c.status === "exiting" && c.exitTargetSize !== undefined && pos.size > c.exitTargetSize + 1e-9) {
        const existing = Object.values(s.submissions).find(x => x.cycleId === c.id && x.intent.reduceOnly && x.status !== "terminal");
        if (existing?.orderId && this.now() - existing.createdAt >= 5 * 60_000) await this.reconcileCancel(s, existing.orderId);
        else if (!existing && targetsClear && this.now() - (c.lastExitSubmitAt ?? 0) >= 5_000) {
          await this.save(s);
          await this.submitExit(s, c, pos, Math.max(0, pos.size - c.exitTargetSize), true);
        }
      } else if (c.status === "exiting" && c.exitTargetSize !== undefined && pos.size <= c.exitTargetSize + 1e-9) {
        c.status = "open"; delete c.exitTargetSize;
      }
    }
    if (s.halted) {
      for (const o of a.openOrders) if (!o.reduceOnly && knownOrders.has(o.id)) await this.reconcileCancel(s, o.id);
    }
    s.lastReconciledAt = this.now(); await this.save(s);
  }

  private async ensureStop(s: Ledger, c: Cycle, pos: Position, orders: Order[]): Promise<void> {
    const { adapter, account } = this.d;
    const confirm = async (valid: Order, visible: Order[]) => {
      this.rememberStop(c, valid.id);
      c.stopOrderId = valid.id; c.stopConfirmedAt = this.now();
      if (sameClient(valid.clientId, c.pendingStopClientId)) delete c.pendingStopClientId;
      await this.save(s);
      // Preserve ownership of every generation across cancellation failures.
      // A new, fully verified stop must exist before any predecessor is removed.
      for (const old of visible.filter(o => o.id !== valid.id && this.ownsStop(c, o))) {
        try { await adapter.cancelOrder(account, old.id); }
        catch { s.halted = true; s.haltReason = "old-stop-cancel-unknown"; }
      }
    };
    try {
      // Recover old persisted cycles without guessing a tick size.
      if (c.szDecimals === undefined && adapter.perpInstruments) {
        c.szDecimals = (await adapter.perpInstruments()).find(i => i.marketRef === c.marketRef)?.szDecimals;
      }
      const valid = orders.find(o => this.validStop(c, pos, o));
      if (valid) { await confirm(valid, orders); return; }
      // A lost stop response is resolved before another trigger is submitted.
      const pending = c.pendingStopClientId ?? (!c.stopOrderId ? c.stopClientId : undefined);
      if (pending) {
        const visible = orders.find(o => sameClient(o.clientId, pending));
        const found = visible ? { found: true as const, order: visible } : await adapter.lookupPerpOrder!(account, pending);
        if (found.found) {
          this.rememberStop(c, found.order.id);
          if (["open", "partial"].includes(found.order.status)) {
            if (!this.validStop(c, pos, found.order)) throw new Error("pending native stop does not match required protection");
            await confirm(found.order, orders); delete c.pendingStopClientId; return;
          }
          delete c.pendingStopClientId;
        } else if (!found.definitive) {
          s.halted = true; s.haltReason = "stop-ack-unknown"; c.exitTargetSize = 0; c.status = "exiting"; return;
        } else delete c.pendingStopClientId;
      }
      c.stopGeneration = (c.stopGeneration ?? 0) + 1;
      c.stopClientId = `${c.id}-sl-${c.stopGeneration}`;
      c.pendingStopClientId = c.stopClientId;
      c.stopClientIds = [...new Set([...(c.stopClientIds ?? []), c.stopClientId])];
      if (c.stopOrderId) this.rememberStop(c, c.stopOrderId);
      await this.save(s);
      const ack = await adapter.placePerpStop!(account, { marketRef: c.marketRef, positionSide: c.side,
        size: pos.size, stopPx: c.stopPx, slippagePct: this.n("emergencyGapFraction", .02) * 100, clientId: c.stopClientId });
      if (ack.status === "rejected") throw new Error("protective stop rejected");
      this.rememberStop(c, ack.orderId);
      // The venue has acknowledged the stop with an order id. A deferred or lagging
      // read of the open-order index is not evidence the stop is missing: keep the
      // generation pending and let the next supervision pass confirm it by client id.
      let visible: Order[];
      try { visible = await adapter.openOrders(account); }
      catch (error) {
        if (!(error as { retryable?: boolean }).retryable) throw error;
        await this.save(s);
        this.d.log.warn(`protective stop for ${c.marketRef} acknowledged (${ack.orderId}); venue index read deferred, confirming next pass`);
        return;
      }
      const actual = visible.find(o => o.id === ack.orderId || sameClient(o.clientId, c.pendingStopClientId));
      if (!actual) {
        if (ack.status === "filled" || ack.status === "canceled") throw new Error("protective stop did not rest on the venue");
        await this.save(s);
        this.d.log.warn(`protective stop for ${c.marketRef} acknowledged (${ack.orderId}) but not yet indexed; confirming next pass`);
        return;
      }
      if (!this.validStop(c, pos, actual)) throw new Error("protective stop geometry not confirmed in venue open orders");
      await confirm(actual, visible); delete c.pendingStopClientId;
    } catch (error) {
      s.halted = true; s.haltReason = "protection-failed"; c.status = "exiting"; c.exitTargetSize = 0; c.exitReason = "protection-failed";
      await this.save(s);
      await this.alert("error", `Protection failed for ${c.marketRef}; additions halted and bounded exit required`, { detail: String(error) });
    }
  }

  /**
   * Executor-owned take-profit: a resting reduce-only limit at the cycle's
   * target price, sized to the live position. It is not protection, so a
   * failure here logs, alerts and retries later without halting additions.
   * Returns false while an owned take-profit may still rest on the venue.
   */
  private async ensureTarget(s: Ledger, c: Cycle, pos: Position, orders: Order[]): Promise<boolean> {
    const { adapter, account } = this.d;
    const cancel = async (o: Order): Promise<boolean> => {
      try { await adapter.cancelOrder(account, o.id); return true; }
      catch (error) { this.d.log.warn(`take-profit cancel unconfirmed for ${c.marketRef}: ${String(error)}`); return false; }
    };
    if (c.status !== "open" || c.exitTargetSize !== undefined || !positive(c.targetPx ?? NaN)) {
      let clear = true;
      for (const o of orders.filter(o => this.ownsTarget(c, o))) clear = (await cancel(o)) && clear;
      return clear;
    }
    const confirm = async (valid: Order, visible: Order[]) => {
      this.rememberTarget(c, valid.id);
      c.targetOrderId = valid.id; c.targetConfirmedAt = this.now(); delete c.targetRetryAt;
      if (sameClient(valid.clientId, c.pendingTargetClientId)) delete c.pendingTargetClientId;
      await this.save(s);
      // A new, fully verified take-profit exists before any predecessor is removed.
      for (const old of visible.filter(o => o.id !== valid.id && this.ownsTarget(c, o))) await cancel(old);
    };
    try {
      const valid = orders.find(o => this.validTarget(c, pos, o));
      if (valid) { await confirm(valid, orders); return true; }
      const pending = c.pendingTargetClientId;
      if (pending) {
        const visible = orders.find(o => sameClient(o.clientId, pending));
        const found = visible ? { found: true as const, order: visible } : await adapter.lookupPerpOrder!(account, pending);
        if (found.found) {
          this.rememberTarget(c, found.order.id);
          if (["open", "partial"].includes(found.order.status) && this.validTarget(c, pos, found.order)) { await confirm(found.order, orders); return true; }
          // A resting mismatch is replaced below and cancelled once the replacement is verified.
          delete c.pendingTargetClientId;
        } else if (!found.definitive) {
          // A lost acknowledgement never becomes a second reduce-only order.
          return true;
        } else delete c.pendingTargetClientId;
      }
      if (this.now() < (c.targetRetryAt ?? 0)) return true;
      c.targetGeneration = (c.targetGeneration ?? 0) + 1;
      c.targetClientId = `${c.id}-tp-${c.targetGeneration}`;
      c.pendingTargetClientId = c.targetClientId;
      c.targetClientIds = [...new Set([...(c.targetClientIds ?? []), c.targetClientId])];
      if (c.targetOrderId) this.rememberTarget(c, c.targetOrderId);
      await this.save(s);
      const ack = await adapter.placeOrder(account, { marketRef: c.marketRef, side: c.side === "LONG" ? "SELL" : "BUY", size: pos.size,
        limitPrice: c.targetPx!, tif: "GTC", postOnly: false, reduceOnly: true, purpose: "target", clientId: c.targetClientId });
      if (ack.status === "rejected") throw new HyperliquidOrderRejectedError("take-profit order rejected");
      this.rememberTarget(c, ack.orderId);
      if (ack.status === "filled" || ack.status === "canceled") {
        // The target was already through the book; the fill closes the cycle on the next flat snapshot.
        delete c.pendingTargetClientId;
        if ((ack.filledSize ?? 0) > 0) c.exitReason ??= "target";
        await this.save(s); return true;
      }
      // A partial immediate fill shrinks the position; the remainder is verified against it next pass.
      if ((ack.filledSize ?? 0) > 0) { await this.save(s); return true; }
      const visible = await adapter.openOrders(account);
      const actual = visible.find(o => o.id === ack.orderId || sameClient(o.clientId, c.pendingTargetClientId));
      if (!actual || !this.validTarget(c, pos, actual)) throw new Error("take-profit not confirmed in venue open orders");
      await confirm(actual, visible);
    } catch (error) {
      // A definite refusal has no live order to look up. Release this generation
      // and retry after the backoff; ambiguous acknowledgements retain it.
      if (error instanceof HyperliquidOrderNotSubmittedError) delete c.pendingTargetClientId;
      c.targetRetryAt = this.now() + 60_000;
      await this.save(s);
      this.d.log.warn(`take-profit for ${c.marketRef} not confirmed: ${String(error)}`);
      await this.alert("error", `Take-profit for ${c.marketRef} not confirmed; native stop retained`, { detail: String(error) });
    }
    return true;
  }

  async execute(action: Action): Promise<StrategyActionResult> {
    if (action.kind === "enter") return this.enter(action);
    const s = await this.ledger();
    const c = s.cycles.find(c => c.marketRef === action.marketRef && c.status !== "closed");
    if (action.kind === "cancel") {
      const order = (await this.d.adapter.openOrders(this.d.account)).find(o => o.id === action.orderId);
      if (order && this.ownsSubmission(s, order) && !isProtectiveOrder(order)) await this.d.adapter.cancelOrder(this.d.account, action.orderId);
      return { placed: false };
    }
    if (!c) return { placed: false };
    if (action.kind === "protect") {
      if (!positive(action.stopPx) || (c.side === "LONG" ? action.stopPx < c.stopPx : action.stopPx > c.stopPx)) throw new Error("protective stops may only tighten");
      c.stopPx = action.stopPx; await this.save(s); await this.reconcile(); return { placed: false };
    }
    if (action.kind === "target") {
      if (!positive(action.targetPx) || (c.side === "LONG" ? action.targetPx <= c.entryPrice : action.targetPx >= c.entryPrice)) throw new Error("target must stay on the favorable side of entry");
      c.targetPx = action.targetPx; await this.save(s); await this.reconcile(); return { placed: false };
    }
    if (action.kind !== "exit") throw new Error("unsupported action for protected perp strategy");
    const a = await this.snapshot(); const p = a.positions.find(p => p.marketRef === c.marketRef && p.size > 0);
    if (!p) return { placed: false };
    const fraction = action.fraction ?? 1;
    if (!positive(fraction) || fraction > 1) throw new Error("invalid exit fraction");
    if (c.status === "exiting") return { placed: false };
    // A strategy exit replaces the resting take-profit; two reduce-only orders must not compete for one position.
    for (const o of a.openOrders.filter(o => this.ownsTarget(c, o))) {
      try { await this.d.adapter.cancelOrder(this.d.account, o.id); }
      catch (error) {
        await this.alert("error", `Take-profit cancel unconfirmed for ${c.marketRef}; exit deferred`, { detail: String(error) });
        return { placed: false };
      }
    }
    c.status = "exiting"; c.exitReason = action.reason; c.exitTargetSize = p.size * (1 - fraction);
    await this.save(s);
    return this.submitExit(s, c, p, p.size * fraction, action.urgent ?? false, action.limitPrice, action.postOnly);
  }

  private async enter(action: Extract<Action, { kind: "enter" }>): Promise<StrategyActionResult> {
    if (!this.readyInThisProcess) return { placed: false };
    const s = await this.ledger();
    if (s.halted || s.configHash !== this.configHash || !s.cashFlowsComplete || !s.lastReconciledAt || this.now() - s.lastReconciledAt > 60_000) return { placed: false };
    if (action.side !== "LONG" && action.side !== "SHORT") throw new Error("perp entries require LONG or SHORT");
    if (!action.clientId || !positive(action.stopPx ?? NaN) || !positive(action.anchorAt ?? NaN) || !positive(action.notional) || !Number.isInteger(action.leverage)) throw new Error("incomplete protected perp entry");
    const repeated = s.submissions[action.clientId];
    if (repeated) return { placed: repeated.status !== "terminal", orderId: repeated.orderId, clientId: action.clientId, status: repeated.ack?.status };
    if (s.cycles.some(c => c.marketRef === action.marketRef && c.status !== "closed")) return { placed: false };
    const { adapter, account } = this.d;
    if (!adapter.perpMarketSnapshot || !adapter.configurePerpLeverage) throw new Error("missing perp execution support");
    const a = await this.snapshot();
    if (this.unmanaged(s, a)) { s.halted = true; s.haltReason = "unmanaged-exposure"; await this.save(s); return { placed: false }; }
    if (s.highWaterEquity > 0 && 1 - a.equity / s.highWaterEquity >= this.n("drawdownHaltFraction", .25)) {
      // A new loss between reconciliation and submission cannot bypass the
      // halt. A concurrent withdrawal is resolved by the next cash-flow pass.
      s.halted = true; s.haltReason = "drawdown"; await this.save(s); return { placed: false };
    }
    const m = await adapter.perpMarketSnapshot(account, action.marketRef);
    if (m.instrument.dex !== "xyz" || m.instrument.marketRef !== action.marketRef || m.instrument.collateralToken !== 0 || !m.instrument.active || a.equity <= 0) return { placed: false };
    const now = this.now(); const bookAge = this.n("maxBookAgeSec", 30) * 1000;
    const horizon = (action.anchorAt! - now) / 3_600_000;
    if (horizon < Math.max(24, this.n("minHorizonHours", 24)) || horizon > Math.min(120, this.n("maxHorizonHours", 120))) return { placed: false };
    const bid = m.book.bids[0]?.price; const ask = m.book.asks[0]?.price;
    const timestamps = [m.ts, m.book.ts, m.book.venueTs ?? m.book.ts, m.quote.ts];
    if (!positive(bid ?? NaN) || !positive(ask ?? NaN) || bid! >= ask! || timestamps.some(t => !Number.isFinite(t) || now - t > bookAge || t > now + 5_000)) return { placed: false };
    if (m.book.marketRef !== action.marketRef || m.quote.marketRef !== action.marketRef ||
      [...m.book.bids, ...m.book.asks].some(l => !positive(l.price) || !Number.isFinite(l.size) || l.size < 0) ||
      ![m.quote.bid, m.quote.ask, m.quote.mid, m.markPrice, m.oraclePrice].every(positive) ||
      m.quote.bid !== bid || m.quote.ask !== ask || m.quote.mid < bid! || m.quote.mid > ask! ||
      !Number.isFinite(m.fundingRateHourly) ||
      ![m.makerFeeRate, m.takerFeeRate, m.quote.spreadBps, m.quote.volume24h].every(n => Number.isFinite(n) && n >= 0) ||
      !Number.isInteger(m.instrument.szDecimals) || m.instrument.szDecimals < 0 || m.instrument.szDecimals > 6 ||
      !positive(m.instrument.maintenanceMarginRate) || m.instrument.maintenanceMarginRate >= 1 ||
      !Number.isInteger(m.instrument.maxLeverage) || m.instrument.maxLeverage < 1 || !positive(m.instrument.minNotional)) return { placed: false };
    const spreadBps = (ask! - bid!) / m.quote.mid * 10_000;
    if (spreadBps > this.n("maxSpreadBps", 20) || m.quote.spreadBps > this.n("maxSpreadBps", 20) || m.quote.volume24h < 100_000 ||
      Math.abs(m.markPrice / m.oraclePrice - 1) > this.n("maxOracleGapFraction", .01)) return { placed: false };
    const long = action.side === "LONG";
    const touch = long ? m.quote.ask : m.quote.bid;
    const slippagePct = this.n("maxSlippageBps", 20) / 100;
    const crossing = touch * (1 + (long ? 1 : -1) * slippagePct / 100);
    const price = action.limitPrice ?? (action.postOnly ? (long ? m.quote.bid : m.quote.ask) : crossing);
    if (!positive(price) || (long ? price > crossing : price < crossing)) return { placed: false };
    const stop = action.stopPx!;
    if (long ? stop >= price : stop <= price) return { placed: false };
    const target = action.targetPx ?? NaN;
    if (!positive(target) || (long ? target <= price : target >= price)) return { placed: false };
    const leverage = action.leverage!;
    if (leverage < 1 || leverage > Math.min(this.n("maxLeverage", 20), m.instrument.maxLeverage)) return { placed: false };
    const stopFraction = Math.abs(price - stop) / price;
    const fundingHourly = fundingStress(m, action.side);
    const funding = fundingHourly * horizon;
    const costs = (action.postOnly ? m.makerFeeRate : m.takerFeeRate) + m.takerFeeRate + spreadBps / 10_000 +
      2 * this.n("maxSlippageBps", 20) / 10_000 + funding;
    const perUnitRisk = stopFraction + costs;
    const liqFraction = (1 / leverage - m.instrument.maintenanceMarginRate) / (1 - (long ? 1 : -1) * m.instrument.maintenanceMarginRate);
    if (liqFraction <= this.n("liquidationStopMultiple", 1.5) * stopFraction + this.n("emergencyGapFraction", .02) +
      funding / (1 - (long ? 1 : -1) * m.instrument.maintenanceMarginRate)) return { placed: false };
    const active = s.cycles.filter(c => c.status !== "closed");
    if (active.length >= this.n("maxPositions", 4)) return { placed: false };
    const reserved = (c: Cycle): number => {
      const p = a.positions.find(p => p.marketRef === c.marketRef);
      const held = (p?.size ?? 0) * (p?.currentPrice ?? c.entryPrice);
      const pending = Object.values(s.submissions).some(x => x.cycleId === c.id && !x.intent.reduceOnly && x.status !== "terminal");
      return pending || !c.seenPositionAt ? Math.max(held, c.desiredNotional) : held;
    };
    const gross = active.reduce((sum, c) => sum + reserved(c), 0);
    const riskFraction = (c: Cycle) => Math.abs(c.entryPrice - c.stopPx) / c.entryPrice + (c.costFraction ?? 0);
    const totalRisk = active.reduce((sum, c) => sum + reserved(c) * riskFraction(c), 0);
    const margin = active.reduce((sum, c) => sum + reserved(c) * (1 / c.leverage +
      (c.fundingStressHourly ?? 0) * Math.max(0, (c.anchorAt - now) / 3_600_000)), 0);
    // Standard-mode withdrawable collateral need not reserve unfilled orders.
    // Deduct locally reserved, not-yet-posted margin before issuing another ticket.
    const pendingMargin = active.reduce((sum, c) => {
      const p = a.positions.find(p => p.marketRef === c.marketRef);
      const held = (p?.size ?? 0) * (p?.currentPrice ?? c.entryPrice);
      return sum + Math.max(0, reserved(c) - held) / c.leverage + reserved(c) *
        (c.fundingStressHourly ?? 0) * Math.max(0, (c.anchorAt - now) / 3_600_000);
    }, 0);
    const marginPerUnit = 1 / leverage + funding;
    const themes = [...new Set(action.themes ?? [])];
    if (!themes.length || themes.some(t => typeof t !== "string" || t.trim() === "")) return { placed: false };
    let notional = Math.min(action.notional, a.equity * this.n("singleNotionalNav", 2),
      a.equity * this.n("grossNotionalNav", 4) - gross,
      (a.equity * this.n("totalStopRiskPct", 15) / 100 - totalRisk) / perUnitRisk,
      a.equity * this.n("riskMaxPct", 10) / 100 / perUnitRisk,
      a.equity * this.n("singleMarginPct", 15) / 100 / marginPerUnit,
      (a.equity * this.n("totalMarginPct", 50) / 100 - margin) / marginPerUnit,
      Math.max(0, a.availableCollateral - pendingMargin) / marginPerUnit);
    for (const theme of themes) {
      const peers = active.filter(c => c.themes.includes(theme));
      const exposure = peers.reduce((v, c) => v + reserved(c), 0);
      const risk = peers.reduce((v, c) => v + reserved(c) * riskFraction(c), 0);
      notional = Math.min(notional, a.equity * this.n("themeNotionalNav", 2) - exposure,
        (a.equity * this.n("themeStopRiskPct", 7.5) / 100 - risk) / perUnitRisk);
    }
    if (!positive(notional)) return { placed: false };
    const cap = checkCapacity({ side: long ? "BUY" : "SELL", desiredSize: notional / price, refPrice: price, book: m.book, quote: m.quote,
      risk: { slippagePct, depthCapPct: 100, minDailyVolume: 100_000, minViableNotional: Math.max(10, m.instrument.minNotional), maxOrderNotional: notional, orderTtlSec: 900 } });
    if (!cap.ok) return { placed: false };
    const step = 10 ** -m.instrument.szDecimals;
    const size = Math.floor(cap.size / step) * step;
    if (size * price < Math.max(10, m.instrument.minNotional)) return { placed: false };
    const tier = m.instrument.marginTiers?.filter(t => size * price >= t.lowerBound).sort((x, y) => y.lowerBound - x.lowerBound)[0];
    if (tier && (leverage > tier.maxLeverage || tier.maintenanceMarginRate > m.instrument.maintenanceMarginRate)) return { placed: false };
    // Exit-side capacity is checked for the entire proposed position.
    const exitLevels = long ? m.book.bids : m.book.asks;
    const exitTouch = exitLevels[0]?.price ?? 0;
    const exitDepth = exitLevels.filter(l => long ? l.price >= exitTouch * .995 : l.price <= exitTouch * 1.005).reduce((v, l) => v + l.size, 0);
    if (exitDepth < size) return { placed: false };
    const c: Cycle = { id: action.clientId!, marketRef: action.marketRef, side: action.side, status: "pending", anchorAt: action.anchorAt!,
      createdAt: now, initialStopPx: stop, stopPx: stop, targetPx: target, entryPrice: price, initialRiskUsd: size * price * perUnitRisk, desiredNotional: size * price,
      filledSize: 0, leverage, themes, szDecimals: m.instrument.szDecimals, maintenanceMarginRate: m.instrument.maintenanceMarginRate,
      fundingStressHourly: fundingHourly, costFraction: costs, entryOrderIds: [], entryClientIds: [action.clientId!], provenance: action.provenance };
    s.cycles.push(c); await this.save(s);
    await adapter.configurePerpLeverage(account, { marketRef: c.marketRef, leverage, marginMode: "isolated" });
    const intent: OrderIntent = { marketRef: c.marketRef, side: long ? "BUY" : "SELL", size, limitPrice: price,
      tif: action.postOnly ? "GTC" : action.tif ?? "IOC", postOnly: action.postOnly, reduceOnly: false, clientId: action.clientId!, purpose: "entry" };
    const result = await this.submit(s, c, intent);
    if ((result.filledSize ?? 0) > 0) {
      // The fill acknowledgement is proof of execution, not permission to
      // invent a position. Give the authoritative account index a short window
      // to catch up before placing a size-verified native stop.
      // Poll the position index alone (one light read per attempt); a full account
      // snapshot here would spend the read budget the stop placement needs next.
      let observed = false;
      for (let attempt = 0; attempt < 11; attempt++) {
        const positions = await adapter.positions(account).catch(() => [] as Position[]);
        if (positions.some(p => p.marketRef === c.marketRef && p.side === c.side && p.size > 0)) { observed = true; break; }
        if (attempt < 10) await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!observed) {
        const current = await this.ledger(); current.halted = true; current.haltReason = "filled-position-not-visible"; await this.save(current);
        await this.alert("error", `Filled ${c.marketRef} is not yet visible in venue positions; additions halted and reconciliation retained`);
      }
    }
    // Reconcile immediately after every acknowledgement so a partial fill receives protection.
    await this.reconcile();
    return result;
  }

  private async submitExit(s: Ledger, c: Cycle, p: Position, size: number, urgent: boolean, limitPrice?: number, postOnly?: boolean): Promise<StrategyActionResult> {
    const { adapter, account } = this.d;
    const [book, quote] = await Promise.all([adapter.book(c.marketRef), adapter.quote(c.marketRef)]);
    const buy = c.side === "SHORT";
    if (p.side !== c.side || !positive(size) || !positive(quote.mid) || !positive(quote.bid) || !positive(quote.ask) ||
      quote.ask <= quote.bid || book.marketRef !== c.marketRef || quote.marketRef !== c.marketRef ||
      [...book.bids, ...book.asks].some(l => !positive(l.price) || !Number.isFinite(l.size) || l.size < 0) ||
      [book.ts, book.venueTs ?? book.ts, quote.ts].some(t => !Number.isFinite(t) || this.now() - t > this.n("maxBookAgeSec", 30) * 1000 || t > this.now() + 5_000)) {
      await this.alert("error", `Exit data invalid or stale for ${c.marketRef}; native protection retained`); return { placed: false };
    }
    const slippagePct = urgent ? this.n("emergencyGapFraction", .02) * 100 : .5;
    const cap = checkCapacity({ side: buy ? "BUY" : "SELL", desiredSize: Math.min(size, p.size), refPrice: quote.mid, book, quote,
      risk: { slippagePct, depthCapPct: 100, minDailyVolume: 0, minViableNotional: 0, maxOrderNotional: Number.MAX_SAFE_INTEGER, orderTtlSec: 300 }, enforceMinimumNotional: false });
    if (!cap.ok) { await this.alert("error", `Exit blocked by liquidity for ${c.marketRef}`, { reasons: cap.skipReasons }); return { placed: false }; }
    const passive = !urgent && (postOnly ?? true);
    const price = limitPrice ?? (passive ? (buy ? quote.bid : quote.ask) : cap.limitPrice);
    if (!positive(price) || (buy ? price > cap.limitPrice : price < cap.limitPrice)) return { placed: false };
    const intent: OrderIntent = { marketRef: c.marketRef, side: buy ? "BUY" : "SELL", size: cap.size, limitPrice: price,
      tif: passive ? "GTC" : "IOC", postOnly: passive, reduceOnly: true, purpose: urgent ? "urgent-exit" : "normal-exit",
      clientId: `${c.id}-exit-${this.now()}` };
    c.lastExitSubmitAt = this.now();
    return this.submit(s, c, intent);
  }
  private async submit(s: Ledger, c: Cycle, intent: OrderIntent): Promise<StrategyActionResult> {
    const sub: Submission = { intent, cycleId: c.id, createdAt: this.now(), status: "prepared" };
    s.submissions[intent.clientId] = sub;
    await this.save(s);
    try {
      const ack = await this.d.adapter.placeOrder(this.d.account, intent);
      if (ack.status === "rejected") return this.rejectSubmission(s, c, sub, "venue rejected the order", ack);
      sub.ack = ack; sub.orderId = ack.orderId; sub.status = ["open", "partial"].includes(ack.status) ? "accepted" : "terminal";
      if (!intent.reduceOnly) {
        c.entryOrderIds.push(ack.orderId);
        if ((ack.filledSize ?? 0) > 0) { c.openedAt ??= this.now(); c.filledSize = ack.filledSize!; c.entryPrice = ack.avgFillPrice ?? c.entryPrice; }
      }
      await this.save(s);
      await this.alert(intent.reduceOnly ? "exit" : "entry", `${intent.side} ${intent.size} ${intent.marketRef} @ ${intent.limitPrice}`, {
        orderId: ack.orderId, status: ack.status, stop: c.stopPx, stopRiskUsd: c.initialRiskUsd, leverage: c.leverage, reason: c.exitReason ?? c.provenance?.reason });
      return { placed: true, placedNotional: intent.size * intent.limitPrice, placedSize: intent.size,
        limitPrice: intent.limitPrice, orderId: ack.orderId, clientId: intent.clientId, status: ack.status, filledSize: ack.filledSize, avgFillPrice: ack.avgFillPrice, placedAt: sub.createdAt };
    } catch (error) {
      if (error instanceof HyperliquidOrderNotSubmittedError) return this.rejectSubmission(s, c, sub, error.message);
      sub.status = "unknown"; s.halted = true; s.haltReason = "submission-unknown"; await this.save(s);
      await this.alert("error", `Order acknowledgement unknown for ${intent.marketRef}; reservation retained`, { clientId: intent.clientId });
      throw error;
    }
  }

  private async rejectSubmission(s: Ledger, c: Cycle, sub: Submission, reason: string, ack?: OrderAck): Promise<StrategyActionResult> {
    sub.status = "terminal";
    sub.rejectionReason = reason;
    sub.ack = ack ?? { orderId: toCloid(sub.intent.clientId), clientId: sub.intent.clientId, status: "rejected", filledSize: 0 };
    if (!sub.intent.reduceOnly && !c.openedAt && c.filledSize === 0) {
      c.status = "closed"; c.closedAt = this.now();
    }
    await this.save(s);
    await this.alert("skipped-order", `Order not placed for ${c.marketRef}: ${reason}`, { clientId: sub.intent.clientId, purpose: sub.intent.purpose });
    return { placed: false, status: "rejected", clientId: sub.intent.clientId, placedNotional: 0, placedSize: 0, filledSize: 0 };
  }
}

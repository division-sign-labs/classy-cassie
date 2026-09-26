// packages/core/src/engine/perp-execution.ts
// Durable, engine-owned perp execution. Strategy/model output never signs or places orders.
import { createHash } from "node:crypto";
import type { Action, AlertEvent, Alerter, Fill, Logger, Order, OrderAck, OrderIntent, Position, StateStore, StrategyActionResult, VenueAccount, VenueAdapter } from "../types.js";
import type { PerpAccountSnapshot, PerpCashFlowResult, PerpCycle, PerpExecutionState, PerpMarketSnapshot } from "../perps.js";
import { getJson, setJson } from "../state.js";
import { closingPnl } from "../alerts/format.js";
import { checkCapacity } from "../risk/capacity.js";
import { formatBoundedHlPrice, hyperliquidDex } from "../venues/hyperliquid-perps.js";
import { HyperliquidOrderNotSubmittedError, HyperliquidOrderRejectedError, toCloid } from "../venues/hyperliquid.js";
import { isTransientVenueError, retryAfterMs } from "../venues/transient.js";
import { RefusalLog } from "./refusal-log.js";

export const PERP_EXECUTION_KEY = "perp:execution:v1";
const OVERLAP_MS = 5 * 60_000;
/** A cycle whose protective stop cannot be confirmed for this long exits on its own; other markets keep trading. */
export const PROTECTION_DEADLINE_MS = 3 * 60_000;
/** A submission the venue never acknowledges nor lists is released after this long. */
export const SUBMISSION_UNKNOWN_DEADLINE_MS = 10 * 60_000;
/** A stop whose acknowledgement the venue can neither confirm nor deny is re-placed after this long. */
const STOP_PENDING_RETRY_MS = 30_000;
export type PerpReadKind = "fills" | "cashFlows" | "funding";
export interface PerpReadOutage { since: number; lastAt: number; error: string }
export type PerpReadOutages = Partial<Record<PerpReadKind, PerpReadOutage>>;
const READ_LABEL: Record<PerpReadKind, string> = { fills: "fills", cashFlows: "cash-flow", funding: "funding" };
/** deferred: retry next pass; failed: not a transient failure. Either pauses entries until the read succeeds. */
type ReadVerdict = "ok" | "deferred" | "failed";

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
  /** Protection bookkeeping: when a stop first failed to confirm, and when a stop ack was left pending. */
  protectionFailedSince?: number;
  protectionError?: string;
  stopPendingSince?: number;
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
  /** Persist the accounted DEX set so adding a funded DEX is capital, not trading profit. */
  accountDexes?: string[];
  sharedCollateral?: boolean;
  /** Local read-budget backpressure clears after a complete reconciliation, independently of safety halts. */
  deferredRead?: "cash-flow-deferred" | "fill-history-deferred";
  /** A failed final fill read remains required even after the venue becomes flat. */
  fillsComplete?: boolean;
  /** Venue reads currently failing, keyed by read; one entry spans a contiguous run of failures. */
  readOutages?: PerpReadOutages;
  /** Markets holding venue exposure this ledger does not own; entries there wait. */
  unmanagedMarkets?: string[];
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
  private readonly refusals: RefusalLog;
  /** Set by the first completed reconciliation in this process; entries wait for it. */
  private reconciledAt?: number;
  private legacyHaltLogged = false;
  constructor(private readonly d: PerpExecutorDeps) {
    this.now = d.now ?? Date.now;
    this.configHash = hash(d.config);
    this.protectionHash = protectionHash(d.config);
    this.refusals = new RefusalLog(d.log, this.now);
  }
  private n(key: string, fallback: number): number {
    const value = this.d.config[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }
  private async ledger(): Promise<Ledger> {
    const saved = await getJson<Ledger>(this.d.state, PERP_EXECUTION_KEY);
    if (!saved) return {
      version: 1, configHash: this.configHash, cycles: [], submissions: {},
      initializedAt: this.now(), halted: false,
      highWaterEquity: 0, drawdownPct: 0, lastEquity: 0, cashFlowsComplete: false,
      fillSince: this.now() - OVERLAP_MS, seenFills: [], flowSince: this.now(), seenFlows: [], cumulativeCashFlow: 0,
    };
    // Earlier runtimes latched every failure as an account-wide halt. Only the two
    // deliberate stops survive a load; everything else is resolved by reconciliation.
    if (saved.halted && saved.haltReason !== "operator" && saved.haltReason !== "drawdown") {
      if (!this.legacyHaltLogged) { this.d.log.warn("legacy perp halt ignored; execution resolves per market", { reason: saved.haltReason }); this.legacyHaltLogged = true; }
      saved.halted = false; delete saved.haltReason;
    }
    const legacy = saved as Ledger & { readOutageHalt?: unknown; shutdownQuietUntil?: unknown };
    delete legacy.readOutageHalt; delete legacy.shutdownQuietUntil;
    return saved;
  }
  private save(s: Ledger): Promise<void> {
    // A ledger running under its enabled configuration records that configuration's
    // protection settings, so a later sizing-only change can be resumed with exposure.
    if (s.configHash === this.configHash && !s.protectionHash) s.protectionHash = this.protectionHash;
    return setJson(this.d.state, PERP_EXECUTION_KEY, s);
  }
  private async reconcileCancel(_s: Ledger, id: string): Promise<void> {
    try { await this.d.adapter.cancelOrder(this.d.account, id); this.refusals.resolve(`cancel:${id}`); }
    catch (error) { this.refusals.refuse(`cancel:${id}`, `working order ${id} cancel unconfirmed; retrying next pass`, { error: String(error) }); }
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
  /** Markets with venue exposure this ledger does not own: a manual position, or an order nothing here placed. */
  private unmanagedMarkets(s: Ledger, a: PerpAccountSnapshot): string[] {
    const active = s.cycles.filter(c => c.status !== "closed");
    const refs = new Set<string>();
    for (const p of a.positions) if (p.size > 0 && !active.some(c => c.marketRef === p.marketRef && c.side === p.side && p.marginMode === "isolated")) refs.add(p.marketRef);
    for (const o of a.openOrders) if (!this.ownsSubmission(s, o) && !active.some(c => this.ownsStop(c, o) || this.ownsTarget(c, o))) refs.add(o.marketRef);
    return [...refs].sort();
  }
  /**
   * A fill acknowledged before the position index caught up closes its cycle as absent.
   * When that position then appears, the cycle is reopened so it gets its stop; nothing
   * halts meanwhile. Only cycles that never saw their position qualify.
   */
  private reopenUnseenCycles(s: Ledger, a: PerpAccountSnapshot): void {
    const active = s.cycles.filter(c => c.status !== "closed");
    for (const p of a.positions.filter(p => p.size > 0 && p.marginMode === "isolated")) {
      if (active.some(c => c.marketRef === p.marketRef && c.side === p.side)) continue;
      const candidate = s.cycles.filter(c => c.status === "closed" && c.marketRef === p.marketRef && c.side === p.side && !c.seenPositionAt
        && this.now() - (c.closedAt ?? 0) < OVERLAP_MS && (c.openedAt !== undefined || Object.values(s.submissions).some(sub => sub.cycleId === c.id && !sub.intent.reduceOnly && (sub.ack?.filledSize ?? 0) > 0)))
        .sort((x, y) => (y.closedAt ?? 0) - (x.closedAt ?? 0))[0];
      if (!candidate) continue;
      candidate.status = "open"; delete candidate.closedAt; delete candidate.absentSince;
      active.push(candidate);
      this.d.log.warn(`perp position in ${p.marketRef} appeared after its cycle closed; cycle ${candidate.id} reopened for protection`);
    }
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
  private async alert(
    kind: "entry" | "exit" | "error" | "fill" | "skipped-order",
    message: string,
    data?: Record<string, unknown>,
    extra: Pick<AlertEvent, "at" | "market" | "trade" | "pnl" | "reason"> = {},
  ): Promise<void> {
    // The journal carries the reason even when alert delivery is misconfigured.
    if (kind === "error" || kind === "skipped-order") this.d.log.warn(`${message}${data?.detail !== undefined ? `: ${String(data.detail)}` : ""}`);
    await this.d.alerter.send({
      kind, botId: this.d.botId, message, data,
      venue: this.d.adapter.id, strategy: "quotient-swing",
      ...extra,
      at: extra.at ?? new Date(this.now()).toISOString(),
    }).catch(e => this.d.log.warn(`alert failed: ${String(e)}`));
  }
  private perpMarket(marketRef: string): NonNullable<AlertEvent["market"]> {
    return { ref: marketRef, title: `${marketRef}-PERP` };
  }
  /**
   * Books a venue read outcome. One outage spans a contiguous run of failures. Either
   * kind of failure pauses entries until the read succeeds; neither latches a halt.
   */
  private noteRead(s: Ledger, kind: PerpReadKind, error?: unknown): ReadVerdict {
    if (error === undefined) {
      if (s.readOutages?.[kind]) this.d.log.info(`perp ${READ_LABEL[kind]} read recovered`);
      if (s.readOutages) { delete s.readOutages[kind]; if (!Object.keys(s.readOutages).length) delete s.readOutages; }
      return "ok";
    }
    const now = this.now(); const detail = String(error);
    const transient = isTransientVenueError(error);
    const outage = s.readOutages?.[kind] ?? { since: now, lastAt: now, error: detail };
    if (!s.readOutages?.[kind]) {
      if (transient) this.d.log.warn(`perp ${READ_LABEL[kind]} read deferred; retrying next pass`, { error: detail, retryAfterMs: retryAfterMs(error) });
      else this.d.log.warn(`perp ${READ_LABEL[kind]} read failed; entries wait until it succeeds`, { error: detail });
    }
    outage.lastAt = now; outage.error = detail;
    (s.readOutages ??= {})[kind] = outage;
    return transient ? "deferred" : "failed";
  }
  /** Why entries wait without a halt: a deferred or incomplete read, or no reconciliation yet in this process. */
  private entriesPaused(s: Ledger): string | undefined {
    if (this.reconciledAt === undefined || this.now() - this.reconciledAt > 60_000) return "reconciliation-pending";
    if (s.deferredRead) return s.deferredRead;
    if (!s.cashFlowsComplete) return "cash-flow-incomplete";
    if (s.fillsComplete === false) return "fills-incomplete";
    return undefined;
  }
  private reconcilingMarkets(s: Ledger): string[] {
    const refs = new Set<string>();
    for (const c of s.cycles) if (c.status === "blocked" || (c.status !== "closed" && (c.pendingStopClientId || c.protectionFailedSince !== undefined))) refs.add(c.marketRef);
    for (const sub of Object.values(s.submissions)) if (sub.status === "unknown") refs.add(sub.intent.marketRef);
    return [...refs].sort();
  }
  async status(): Promise<PerpExecutionState & { readOutages?: PerpReadOutages }> {
    const s = await this.ledger();
    const reconciling = this.reconcilingMarkets(s);
    return { cycles: s.cycles, halted: s.halted, haltReason: s.haltReason, highWaterEquity: s.highWaterEquity,
      drawdownPct: s.drawdownPct, lastReconciledAt: s.lastReconciledAt, cashFlowsComplete: s.cashFlowsComplete,
      entriesPaused: this.entriesPaused(s), unmanagedMarkets: s.unmanagedMarkets?.length ? s.unmanagedMarkets : undefined,
      reconcilingMarkets: reconciling.length ? reconciling : undefined, readOutages: s.readOutages };
  }
  async snapshot(): Promise<PerpAccountSnapshot> {
    const { adapter, account } = this.d;
    if (!adapter.perpAccountSnapshot) throw new Error("venue lacks authoritative perp accounting");
    const a = await adapter.perpAccountSnapshot(account);
    const balances = a.dexBalances ?? [a];
    const dexes = a.sharedCollateral ? a.dexes ?? [] : balances.map(b => b.dex);
    if (a.abstraction !== (a.sharedCollateral ? "unified" : "standard") || a.collateral !== "USDC" || !dexes.length
      || dexes.some(dex => dex !== "xyz" && dex !== "") || new Set(dexes).size !== dexes.length
      || (a.sharedCollateral && a.dexBalances !== undefined)
      || a.dex !== (dexes.length > 1 ? "multi" : dexes[0]!)) throw new Error("Quotient Swing requires Standard or Unified main/xyz USDC accounts");
    if (![a.equity, a.availableCollateral, a.marginUsed, a.grossNotional].every(n => Number.isFinite(n) && n >= 0) || !Number.isFinite(a.ts) || this.now() - a.ts > 60_000 || a.ts > this.now() + 5_000) throw new Error("invalid or stale perp account snapshot");
    for (const key of ["equity", "availableCollateral", "marginUsed", "grossNotional"] as const) {
      if (balances.some(b => !Number.isFinite(b[key]) || b[key] < 0)
        || Math.abs(balances.reduce((sum, b) => sum + b[key], 0) - a[key]) > 1e-6) throw new Error("perp DEX balances do not match account totals");
    }
    if ([...a.positions, ...a.openOrders].some(p => !dexes.includes(hyperliquidDex(p.marketRef)))) throw new Error("perp exposure is outside account DEX scope");
    return a;
  }
  /** The operator stop: entries halt and working entries are canceled; protection keeps running. */
  async halt(): Promise<void> {
    const s = await this.ledger(); s.halted = true; s.haltReason = "operator"; await this.save(s);
    await this.cancelEntries();
  }
  /**
   * Clears the operator or drawdown stop. A drawdown beyond the configured limit needs an
   * explicit loss-reset acknowledgement; everything else is ordinary reconciliation.
   */
  async resume(acknowledgeLossReset = false): Promise<void> {
    try { await this.reconcile(); }
    catch (error) {
      if (!isTransientVenueError(error)) throw error;
      this.d.log.warn(`perp reconciliation deferred during resume: ${String(error)}`);
    }
    const s = await this.ledger();
    const drawdownLatched = s.haltReason === "drawdown" || s.drawdownPct >= this.n("drawdownHaltFraction", .25) * 100;
    if (drawdownLatched && !acknowledgeLossReset) throw new Error("loss stop requires an explicit loss-reset acknowledgement");
    if (acknowledgeLossReset) { s.highWaterEquity = s.lastEquity; s.drawdownPct = 0; }
    s.configHash = this.configHash; s.protectionHash = this.protectionHash;
    s.halted = false; delete s.haltReason; await this.save(s);
  }
  async cancelEntries(): Promise<void> {
    const orders = await this.d.adapter.openOrders(this.d.account);
    const s = await this.ledger();
    for (const o of orders) if (!o.reduceOnly && this.ownsSubmission(s, o) && !isProtectiveOrder(o)) await this.d.adapter.cancelOrder(this.d.account, o.id);
  }
  /**
   * Shutdown: best effort only. Native stops stay on the venue without this process, so
   * the only work is canceling working entries; a fill that lands meanwhile gets its stop
   * from the next process's first reconciliation. Nothing here writes a halt or throws.
   */
  async cancelWorkingOrders(): Promise<void> {
    const { adapter, account } = this.d;
    const step = async (label: string, run: () => Promise<unknown>): Promise<void> => {
      try { await run(); } catch (error) { this.d.log.warn(`shutdown ${label} failed: ${String(error)}`); }
    };
    if (adapter.disarmScheduledCancel) await step("cancel-timer disarm", () => adapter.disarmScheduledCancel!(account));
    await step("entry cancellation", () => this.cancelEntries());
    await step("final reconciliation", () => this.reconcile());
  }

  /** Serialized by the runtime with order submissions; no research/LLM work here. */
  async reconcile(): Promise<void> {
    const { adapter, account } = this.d;
    if (!adapter.disarmScheduledCancel || !adapter.lookupPerpOrder || !adapter.placePerpStop || !adapter.perpCashFlows) throw new Error("venue lacks protected perp execution capabilities");
    await adapter.disarmScheduledCancel(account);
    const a = await this.snapshot();
    const s = await this.ledger();
    let deferredRead: Ledger["deferredRead"];
    const defer = (reason: NonNullable<Ledger["deferredRead"]>) => { deferredRead = reason; s.deferredRead = reason; };
    if (s.configHash !== this.configHash) {
      // The bot JSON is the configuration of record; a deploy is how it changes. Open cycles keep their own stop and horizon.
      this.d.log.info("perp configuration changed; accepted", { exposed: s.cycles.some(c => c.status !== "closed"), protectionChanged: s.protectionHash !== this.protectionHash });
      s.configHash = this.configHash; s.protectionHash = this.protectionHash;
    }

    // A ledger outage must halt additions, not prevent protecting a live fill.
    // A deferred read keeps the previous completeness verdict until the venue answers.
    let flow: PerpCashFlowResult | undefined;
    let flowError: unknown;
    try { flow = await adapter.perpCashFlows(account, Math.max(s.initializedAt, s.flowSince - OVERLAP_MS)); }
    catch (error) { flowError = error; }
    this.noteRead(s, "cashFlows", flowError);
    // An incomplete interval, or no answer at all, pauses entries until a complete read arrives.
    if (flow) s.cashFlowsComplete = flow.complete;
    else defer("cash-flow-deferred");
    // Keep the prior equity and cursor together until the full cash-flow interval is known.
    // Otherwise a delayed withdrawal can look like a loss and latch the drawdown halt.
    if (flow?.complete) {
      const balances = a.dexBalances ?? [a];
      const dexes = a.sharedCollateral ? a.dexes! : balances.map(b => b.dex);
      const previousDexes = s.accountDexes ?? (s.lastEquity > 0 ? ["xyz"] : dexes);
      if (previousDexes.some(dex => !dexes.includes(dex))) throw new Error("cannot remove a DEX from existing perp accounting");
      if (s.sharedCollateral && !a.sharedCollateral) throw new Error("cannot split an existing shared collateral ledger");
      const migrating = a.sharedCollateral && !s.sharedCollateral && s.lastEquity > 0;
      const added = a.sharedCollateral ? [] : balances.filter(b => !previousDexes.includes(b.dex));
      let netFlow = 0;
      for (const f of flow.flows) {
        if (s.seenFlows.includes(f.id)) continue;
        if (!Number.isFinite(f.amount) || !Number.isFinite(f.ts)) throw new Error("invalid perp cash flow");
        if (f.byDex && (Object.values(f.byDex).some(v => !Number.isFinite(v))
          || Math.abs(Object.values(f.byDex).reduce((sum, v) => sum + v, 0) - f.amount) > 1e-6)) throw new Error("invalid DEX cash flow");
        if (added.length && !f.byDex) throw new Error("DEX expansion requires cash-flow attribution");
        netFlow += added.length ? previousDexes.reduce((sum, dex) => sum + (f.byDex?.[dex] ?? 0), 0) : f.amount;
      }
      // A mode change must be made while flat and preserve the reconciled balance.
      // Do not silently absorb extra spot capital or reset the existing loss history.
      if (migrating && (a.positions.length || a.openOrders.length || s.cycles.some(c => c.status !== "closed")
        || Math.abs(a.equity - s.lastEquity - netFlow) > .01)) {
        throw new Error("shared collateral migration requires a flat account with unchanged reconciled equity");
      }
      for (const f of flow.flows) {
        if (!s.seenFlows.includes(f.id)) s.seenFlows.push(f.id);
        s.flowSince = Math.max(s.flowSince, f.ts);
      }
      // Unitize deposits/withdrawals: they change capital, not the return high-water mark.
      if (s.lastEquity > 0 && netFlow !== 0) s.highWaterEquity *= Math.max(0, (s.lastEquity + netFlow) / s.lastEquity);
      s.cumulativeCashFlow += netFlow;
      if (added.length) {
        const addedEquity = added.reduce((sum, b) => sum + b.equity, 0);
        const oldEquity = a.equity - addedEquity;
        s.highWaterEquity = Math.max(s.highWaterEquity, oldEquity);
        // Preserve the existing drawdown percentage when bringing another DEX into scope.
        if (oldEquity > 0) s.highWaterEquity *= a.equity / oldEquity;
        else if (s.highWaterEquity > 0) { s.halted = true; s.haltReason = "drawdown"; s.highWaterEquity += addedEquity; }
        s.cumulativeCashFlow += addedEquity;
      }
      s.accountDexes = dexes;
      s.sharedCollateral = a.sharedCollateral === true;
      s.highWaterEquity = Math.max(s.highWaterEquity, a.equity);
      s.lastEquity = a.equity;
      s.drawdownPct = s.highWaterEquity > 0 ? Math.max(0, 100 * (1 - a.equity / s.highWaterEquity)) : 0;
      if (s.drawdownPct >= this.n("drawdownHaltFraction", .25) * 100) { s.halted = true; s.haltReason = "drawdown"; }
    }

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
        if (sub.status === "unknown" && this.now() - sub.createdAt >= SUBMISSION_UNKNOWN_DEADLINE_MS) {
          // Never resubmitted; a fill that surfaces later is protected through the position, not the order.
          sub.status = "terminal"; sub.rejectionReason = "acknowledgement never resolved";
          this.d.log.warn(`perp submission ${sub.intent.clientId} for ${sub.intent.marketRef} unresolved for ${SUBMISSION_UNKNOWN_DEADLINE_MS / 60_000} minutes; released`);
        }
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
    const needsFillHistory = s.fillsComplete === false || s.cycles.some(c => c.status !== "closed") ||
      Object.values(s.submissions).some(sub => sub.status !== "terminal");
    let fillsComplete = true;
    let fills: Fill[] = [];
    if (needsFillHistory) {
      let fillsError: unknown;
      try { fills = await adapter.fills(account, Math.max(0, s.fillSince - OVERLAP_MS)); }
      catch (error) { fillsError = error; }
      if (this.noteRead(s, "fills", fillsError) !== "ok") {
        // Fill processing waits for a complete read; the account snapshot still drives exposure, stops and closures.
        fillsComplete = false;
        defer("fill-history-deferred");
      }
    }
    s.fillsComplete = fillsComplete;
    for (const f of fills) {
      if (s.seenFills.includes(f.id)) continue;
      const target = f.orderId === undefined ? undefined
        : s.cycles.find(c => c.status !== "closed" && (c.targetOrderId === f.orderId || (c.targetOrderIds ?? []).includes(f.orderId!)));
      if (target) {
        target.targetFilledSize = (target.targetFilledSize ?? 0) + f.size;
        target.exitReason ??= "target";
        s.seenFills.push(f.id); s.fillSince = Math.max(s.fillSince, f.ts);
        const tpPnl = closingPnl(target.entryPrice, target.side, f.size, f.price, f.fee, "realized");
        await this.alert("fill", `${f.side} ${f.size} ${f.marketRef} @ ${f.price} (take-profit)`, { fee: f.fee, orderId: f.orderId, reason: "target", fillId: f.id }, {
          at: new Date(f.ts).toISOString(), market: this.perpMarket(f.marketRef),
          trade: { side: f.side, size: f.size, price: f.price, notionalUsd: f.size * f.price, ...(f.fee !== undefined ? { feeUsd: f.fee } : {}),
            ...(f.orderId ? { orderId: f.orderId } : {}), positionSide: target.side, filled: true },
          ...(tpPnl ? { pnl: tpPnl } : {}), reason: "target" });
        continue;
      }
      const sub = Object.values(s.submissions).find(o => o.orderId === f.orderId);
      if (!sub) continue;
      const c = s.cycles.find(cycle => cycle.id === sub.cycleId);
      if (c && !sub.intent.reduceOnly) c.openedAt = Math.min(c.openedAt ?? f.ts, f.ts);
      s.seenFills.push(f.id); s.fillSince = Math.max(s.fillSince, f.ts);
      const fillPnl = c && sub.intent.reduceOnly ? closingPnl(c.entryPrice, c.side, f.size, f.price, f.fee, "realized") : undefined;
      await this.alert("fill", `${f.side} ${f.size} ${f.marketRef} @ ${f.price}`, { fee: f.fee, orderId: f.orderId, fillId: f.id }, {
        at: new Date(f.ts).toISOString(), market: this.perpMarket(f.marketRef),
        trade: { side: f.side, size: f.size, price: f.price, notionalUsd: f.size * f.price, ...(f.fee !== undefined ? { feeUsd: f.fee } : {}),
          ...(f.orderId ? { orderId: f.orderId } : {}), ...(c ? { positionSide: c.side } : {}), filled: true },
        ...(fillPnl ? { pnl: fillPnl } : {}),
        ...(sub.intent.reduceOnly && c?.exitReason ? { reason: c.exitReason } : {}) });
    }
    s.seenFills = s.seenFills.slice(-20_000); s.seenFlows = s.seenFlows.slice(-20_000);
    const knownOrders = new Set(Object.values(s.submissions).map(x => x.orderId));
    this.reopenUnseenCycles(s, a);
    const unmanaged = this.unmanagedMarkets(s, a);
    for (const ref of unmanaged) this.refusals.refuse(`unmanaged:${ref}`, `unmanaged venue exposure in ${ref}; entries there wait until it is resolved`);
    for (const ref of s.unmanagedMarkets ?? []) if (!unmanaged.includes(ref)) this.refusals.resolve(`unmanaged:${ref}`, `unmanaged exposure in ${ref} cleared`);
    if (unmanaged.length) s.unmanagedMarkets = unmanaged; else delete s.unmanagedMarkets;
    // Funding is read once per exposed market so one venue outage is booked once per pass.
    const fundingHourly = new Map<string, number>();
    let fundingError: unknown;
    if (adapter.fundingRate) {
      const exposed = new Set(s.cycles.filter(c => c.status !== "closed" && a.positions.some(p => p.marketRef === c.marketRef && p.size > 0)).map(c => c.marketRef));
      for (const marketRef of exposed) {
        try {
          const hourly = (await adapter.fundingRate(marketRef)) / 8;
          if (!Number.isFinite(hourly)) throw new Error("invalid funding rate");
          fundingHourly.set(marketRef, hourly);
        } catch (error) { fundingError ??= error; }
      }
    }
    const fundingRead = this.noteRead(s, "funding", fundingError);
    for (const c of s.cycles.filter(c => c.status !== "closed")) {
      const pos = a.positions.find(p => p.marketRef === c.marketRef && p.size > 0);
      if (!pos) {
        const pending = Object.values(s.submissions).some(o => o.cycleId === c.id && (o.status !== "terminal" || this.now() - o.createdAt < OVERLAP_MS));
        if (pending || !fillsComplete) continue;
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
        // The venue shows a position this cycle cannot claim; the cycle waits, other markets do not.
        c.status = "blocked";
        this.refusals.refuse(`mismatch:${c.id}`, `perp position in ${c.marketRef} does not match its cycle (${pos.side}, ${pos.marginMode ?? "unknown margin"}); cycle blocked until it does`);
        continue;
      }
      if (c.status === "blocked") { c.status = "open"; this.refusals.resolve(`mismatch:${c.id}`, `perp position in ${c.marketRef} matches its cycle again`); }
      c.seenPositionAt = this.now(); c.openedAt ??= this.now(); c.filledSize = pos.size; c.entryPrice = pos.avgPrice;
      if (c.status === "pending") c.status = "open";
      await this.ensureStop(s, c, pos, a.openOrders);
      const mark = pos.currentPrice ?? pos.avgPrice;
      const distance = Math.abs(mark - c.stopPx);
      const liq = pos.liquidationPrice;
      const stopBreached = c.side === "LONG" ? mark <= c.stopPx : mark >= c.stopPx;
      let fundingKnown = true;
      if (adapter.fundingRate) {
        const hourly = fundingHourly.get(c.marketRef);
        if (hourly !== undefined) c.fundingStressHourly = Math.max(c.fundingStressHourly ?? 0, (c.side === "LONG" ? 1 : -1) * hourly, 0);
        // A deferred read leaves the last known funding stress in the buffer check; a hard failure keeps the exit.
        else fundingKnown = fundingRead !== "failed" && c.fundingStressHourly !== undefined;
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
      if ((distance <= 0 || !Number.isFinite(distance)) && c.status !== "exiting") {
        c.exitReason = "invalid-stop"; c.exitTargetSize = 0; c.status = "exiting";
        this.d.log.warn(`perp stop for ${c.marketRef} is not a positive distance from the mark; exiting that cycle`);
      }
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
    if (s.halted || deferredRead) {
      for (const o of a.openOrders) if (!o.reduceOnly && knownOrders.has(o.id)) await this.reconcileCancel(s, o.id);
    }
    if (s.deferredRead && !deferredRead && !s.halted) this.d.log.info("Perp reconciliation recovered; entry checks restored");
    s.deferredRead = deferredRead;
    s.lastReconciledAt = this.now(); this.reconciledAt = s.lastReconciledAt; await this.save(s);
  }

  private async ensureStop(s: Ledger, c: Cycle, pos: Position, orders: Order[]): Promise<void> {
    const { adapter, account } = this.d;
    /** A pass ended without a verified stop. Retried next pass; only past the deadline does this cycle alone exit. */
    const unconfirmed = async (reason: string, alertFirst = false): Promise<void> => {
      const first = c.protectionFailedSince === undefined;
      c.protectionFailedSince ??= this.now(); c.protectionError = reason;
      // The retry clock for an unresolved acknowledgement starts at the failure, not at the next lookup.
      if (c.pendingStopClientId) c.stopPendingSince ??= this.now();
      await this.save(s);
      if (first && alertFirst) await this.alert("error", `Protection for ${c.marketRef} not confirmed; retrying each pass`, { detail: reason });
      else this.refusals.refuse(`protect:${c.id}`, `protective stop for ${c.marketRef} still unconfirmed; retrying`, { error: reason });
      if (this.now() - c.protectionFailedSince >= PROTECTION_DEADLINE_MS && c.status !== "exiting") {
        c.status = "exiting"; c.exitTargetSize = 0; c.exitReason = "protection-failed";
        await this.save(s);
        await this.alert("error", `Protection failed for ${c.marketRef} for ${PROTECTION_DEADLINE_MS / 60_000} minutes; bounded exit submitted`, { detail: reason });
      }
    };
    const confirm = async (valid: Order, visible: Order[]) => {
      this.rememberStop(c, valid.id);
      c.stopOrderId = valid.id; c.stopConfirmedAt = this.now();
      if (c.protectionFailedSince !== undefined || c.stopPendingSince !== undefined) this.d.log.info(`protective stop for ${c.marketRef} confirmed after a delay`);
      delete c.protectionFailedSince; delete c.protectionError; delete c.stopPendingSince;
      this.refusals.resolve(`protect:${c.id}`);
      if (sameClient(valid.clientId, c.pendingStopClientId)) delete c.pendingStopClientId;
      await this.save(s);
      // Preserve ownership of every generation across cancellation failures.
      // A new, fully verified stop must exist before any predecessor is removed.
      for (const old of visible.filter(o => o.id !== valid.id && this.ownsStop(c, o))) {
        try { await adapter.cancelOrder(account, old.id); this.refusals.resolve(`oldstop:${old.id}`); }
        catch (error) { this.refusals.refuse(`oldstop:${old.id}`, `superseded stop ${old.id} for ${c.marketRef} cancel unconfirmed; retrying next pass`, { error: String(error) }); }
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
          if (["open", "partial"].includes(found.order.status) && this.validStop(c, pos, found.order)) {
            await confirm(found.order, orders); delete c.pendingStopClientId; return;
          }
          // A resting stop with the wrong geometry is replaced below; confirm() removes it once the replacement is verified.
          delete c.pendingStopClientId;
        } else if (!found.definitive) {
          // The venue can neither confirm nor deny the stop. After a short wait a fresh generation is placed;
          // the earlier client id stays owned, so a late duplicate is cancelled by confirm(), and reduce-only
          // stops cannot over-close. No other market waits.
          c.stopPendingSince ??= this.now();
          if (this.now() - c.stopPendingSince < STOP_PENDING_RETRY_MS) { await unconfirmed(`stop ${pending} acknowledgement unresolved`); return; }
          delete c.pendingStopClientId;
        } else delete c.pendingStopClientId;
      }
      delete c.stopPendingSince;
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
        if (!(error as { retryable?: boolean }).retryable && !isTransientVenueError(error)) throw error;
        this.d.log.warn(`protective stop for ${c.marketRef} acknowledged (${ack.orderId}); venue index read deferred, confirming next pass`);
        await unconfirmed(`venue index read deferred after acknowledgement ${ack.orderId}`);
        return;
      }
      const actual = visible.find(o => o.id === ack.orderId || sameClient(o.clientId, c.pendingStopClientId));
      if (!actual) {
        if (ack.status === "filled" || ack.status === "canceled") throw new Error("protective stop did not rest on the venue");
        this.d.log.warn(`protective stop for ${c.marketRef} acknowledged (${ack.orderId}) but not yet indexed; confirming next pass`);
        await unconfirmed(`acknowledgement ${ack.orderId} not yet indexed`);
        return;
      }
      if (!this.validStop(c, pos, actual)) throw new Error("protective stop geometry not confirmed in venue open orders");
      await confirm(actual, visible); delete c.pendingStopClientId;
    } catch (error) {
      // Protection is retried every pass for this cycle alone; only past the deadline does the position exit.
      await unconfirmed(String(error), true);
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

  /** Every refused entry names its reason once per market; a silent gate hid a twenty-hour pause. */
  private refuse(marketRef: string, reason: string, data?: Record<string, unknown>): StrategyActionResult {
    this.refusals.refuse(`enter:${marketRef}`, `perp entry refused for ${marketRef}: ${reason}`, data);
    return { placed: false };
  }
  private async enter(action: Extract<Action, { kind: "enter" }>): Promise<StrategyActionResult> {
    const s = await this.ledger();
    const refuse = (reason: string, data?: Record<string, unknown>): StrategyActionResult => this.refuse(action.marketRef, reason, data);
    if (s.halted) return refuse(`halted: ${s.haltReason ?? "operator"}`);
    const paused = this.entriesPaused(s);
    if (paused) return refuse(paused);
    if (!s.lastReconciledAt || this.now() - s.lastReconciledAt > 60_000) return refuse("reconciliation stale");
    if (action.side !== "LONG" && action.side !== "SHORT") throw new Error("perp entries require LONG or SHORT");
    if (!action.clientId || !positive(action.stopPx ?? NaN) || !positive(action.anchorAt ?? NaN) || !positive(action.notional) || !Number.isInteger(action.leverage)) throw new Error("incomplete protected perp entry");
    const repeated = s.submissions[action.clientId];
    if (repeated) return { placed: repeated.status !== "terminal", orderId: repeated.orderId, clientId: action.clientId, status: repeated.ack?.status };
    if (s.cycles.some(c => c.marketRef === action.marketRef && c.status !== "closed")) return { placed: false };
    const { adapter, account } = this.d;
    if (!adapter.perpMarketSnapshot || !adapter.configurePerpLeverage) throw new Error("missing perp execution support");
    const a = await this.snapshot();
    if (this.unmanagedMarkets(s, a).includes(action.marketRef)) return refuse("unmanaged venue exposure in this market");
    if (s.highWaterEquity > 0 && 1 - a.equity / s.highWaterEquity >= this.n("drawdownHaltFraction", .25)) {
      // A new loss between reconciliation and submission cannot bypass the
      // halt. A concurrent withdrawal is resolved by the next cash-flow pass.
      s.halted = true; s.haltReason = "drawdown"; await this.save(s); return refuse("halted: drawdown");
    }
    const m = await adapter.perpMarketSnapshot(account, action.marketRef);
    const instrumentDex = hyperliquidDex(action.marketRef);
    const supported = instrumentDex === "xyz" || (instrumentDex === "" && ["BTC", "ETH"].includes(action.marketRef));
    const dexBalance = a.sharedCollateral ? a : (a.dexBalances ?? [a]).find(b => b.dex === instrumentDex);
    if (!supported || !dexBalance || m.instrument.dex !== instrumentDex || m.instrument.marketRef !== action.marketRef || m.instrument.collateralToken !== 0 || !m.instrument.active || a.equity <= 0) return refuse("instrument inactive, wrong dex or collateral, or no equity");
    const now = this.now(); const bookAge = this.n("maxBookAgeSec", 30) * 1000;
    const horizon = (action.anchorAt! - now) / 3_600_000;
    if (horizon < Math.max(24, this.n("minHorizonHours", 24)) || horizon > Math.min(120, this.n("maxHorizonHours", 120))) return refuse("horizon outside the configured bounds", { horizonHours: horizon });
    const bid = m.book.bids[0]?.price; const ask = m.book.asks[0]?.price;
    const timestamps = [m.ts, m.book.ts, m.book.venueTs ?? m.book.ts, m.quote.ts];
    if (!positive(bid ?? NaN) || !positive(ask ?? NaN) || bid! >= ask! || timestamps.some(t => !Number.isFinite(t) || now - t > bookAge || t > now + 5_000)) return refuse("book or quote invalid or stale");
    if (m.book.marketRef !== action.marketRef || m.quote.marketRef !== action.marketRef ||
      [...m.book.bids, ...m.book.asks].some(l => !positive(l.price) || !Number.isFinite(l.size) || l.size < 0) ||
      ![m.quote.bid, m.quote.ask, m.quote.mid, m.markPrice, m.oraclePrice].every(positive) ||
      m.quote.bid !== bid || m.quote.ask !== ask || m.quote.mid < bid! || m.quote.mid > ask! ||
      !Number.isFinite(m.fundingRateHourly) ||
      ![m.makerFeeRate, m.takerFeeRate, m.quote.spreadBps, m.quote.volume24h].every(n => Number.isFinite(n) && n >= 0) ||
      !Number.isInteger(m.instrument.szDecimals) || m.instrument.szDecimals < 0 || m.instrument.szDecimals > 6 ||
      !positive(m.instrument.maintenanceMarginRate) || m.instrument.maintenanceMarginRate >= 1 ||
      !Number.isInteger(m.instrument.maxLeverage) || m.instrument.maxLeverage < 1 || !positive(m.instrument.minNotional)) return refuse("market snapshot failed validation");
    const spreadBps = (ask! - bid!) / m.quote.mid * 10_000;
    if (spreadBps > this.n("maxSpreadBps", 20) || m.quote.spreadBps > this.n("maxSpreadBps", 20) || m.quote.volume24h < 100_000 ||
      Math.abs(m.markPrice / m.oraclePrice - 1) > this.n("maxOracleGapFraction", .01)) return refuse("spread, volume or oracle gap outside limits", { spreadBps, volume24h: m.quote.volume24h });
    const long = action.side === "LONG";
    const touch = long ? m.quote.ask : m.quote.bid;
    const slippagePct = this.n("maxSlippageBps", 20) / 100;
    const crossing = touch * (1 + (long ? 1 : -1) * slippagePct / 100);
    const price = action.limitPrice ?? (action.postOnly ? (long ? m.quote.bid : m.quote.ask) : crossing);
    if (!positive(price) || (long ? price > crossing : price < crossing)) return refuse("price outside the slippage bound");
    const stop = action.stopPx!;
    if (long ? stop >= price : stop <= price) return refuse("stop is not beyond the entry price");
    const target = action.targetPx ?? NaN;
    if (!positive(target) || (long ? target <= price : target >= price)) return refuse("target is not beyond the entry price");
    const leverage = action.leverage!;
    if (leverage < 1 || leverage > Math.min(this.n("maxLeverage", 20), m.instrument.maxLeverage)) return refuse("leverage outside the allowed range");
    const stopFraction = Math.abs(price - stop) / price;
    const fundingHourly = fundingStress(m, action.side);
    const funding = fundingHourly * horizon;
    const costs = (action.postOnly ? m.makerFeeRate : m.takerFeeRate) + m.takerFeeRate + spreadBps / 10_000 +
      2 * this.n("maxSlippageBps", 20) / 10_000 + funding;
    const perUnitRisk = stopFraction + costs;
    const liqFraction = (1 / leverage - m.instrument.maintenanceMarginRate) / (1 - (long ? 1 : -1) * m.instrument.maintenanceMarginRate);
    if (liqFraction <= this.n("liquidationStopMultiple", 1.5) * stopFraction + this.n("emergencyGapFraction", .02) +
      funding / (1 - (long ? 1 : -1) * m.instrument.maintenanceMarginRate)) return refuse("liquidation buffer too thin for the stop");
    const active = s.cycles.filter(c => c.status !== "closed");
    if (active.length >= this.n("maxPositions", 4)) return refuse("maximum positions reached");
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
    const pendingMarginFor = (cycles: Cycle[]) => cycles.reduce((sum, c) => {
      const p = a.positions.find(p => p.marketRef === c.marketRef);
      const held = (p?.size ?? 0) * (p?.currentPrice ?? c.entryPrice);
      return sum + Math.max(0, reserved(c) - held) / c.leverage + reserved(c) *
        (c.fundingStressHourly ?? 0) * Math.max(0, (c.anchorAt - now) / 3_600_000);
    }, 0);
    const pendingMargin = pendingMarginFor(active);
    const dexPendingMargin = pendingMarginFor(active.filter(c => hyperliquidDex(c.marketRef) === instrumentDex));
    const marginPerUnit = 1 / leverage + funding;
    const themes = [...new Set(action.themes ?? [])];
    if (!themes.length || themes.some(t => typeof t !== "string" || t.trim() === "")) return refuse("entry names no themes");
    let notional = Math.min(action.notional, a.equity * this.n("singleNotionalNav", 2),
      a.equity * this.n("grossNotionalNav", 4) - gross,
      (a.equity * this.n("totalStopRiskPct", 15) / 100 - totalRisk) / perUnitRisk,
      a.equity * this.n("riskMaxPct", 10) / 100 / perUnitRisk,
      a.equity * this.n("singleMarginPct", 15) / 100 / marginPerUnit,
      (a.equity * this.n("totalMarginPct", 50) / 100 - margin) / marginPerUnit,
      Math.max(0, a.availableCollateral - pendingMargin) / marginPerUnit,
      Math.max(0, dexBalance.availableCollateral - dexPendingMargin) / marginPerUnit);
    for (const theme of themes) {
      const peers = active.filter(c => c.themes.includes(theme));
      const exposure = peers.reduce((v, c) => v + reserved(c), 0);
      const risk = peers.reduce((v, c) => v + reserved(c) * riskFraction(c), 0);
      notional = Math.min(notional, a.equity * this.n("themeNotionalNav", 2) - exposure,
        (a.equity * this.n("themeStopRiskPct", 7.5) / 100 - risk) / perUnitRisk);
    }
    if (!positive(notional)) return refuse("no notional headroom under the risk caps");
    const cap = checkCapacity({ side: long ? "BUY" : "SELL", desiredSize: notional / price, refPrice: price, book: m.book, quote: m.quote,
      risk: { slippagePct, depthCapPct: 100, minDailyVolume: 100_000, minViableNotional: Math.max(10, m.instrument.minNotional), maxOrderNotional: notional, orderTtlSec: 900 } });
    if (!cap.ok) return refuse(`capacity: ${cap.skipReasons.join("; ")}`);
    const step = 10 ** -m.instrument.szDecimals;
    const size = Math.floor(cap.size / step) * step;
    if (size * price < Math.max(10, m.instrument.minNotional)) return refuse("size below the venue minimum notional");
    const tier = m.instrument.marginTiers?.filter(t => size * price >= t.lowerBound).sort((x, y) => y.lowerBound - x.lowerBound)[0];
    if (tier && (leverage > tier.maxLeverage || tier.maintenanceMarginRate > m.instrument.maintenanceMarginRate)) return refuse("leverage exceeds the margin tier for this size");
    // Exit-side capacity is checked for the entire proposed position.
    const exitLevels = long ? m.book.bids : m.book.asks;
    const exitTouch = exitLevels[0]?.price ?? 0;
    const exitDepth = exitLevels.filter(l => long ? l.price >= exitTouch * .995 : l.price <= exitTouch * 1.005).reduce((v, l) => v + l.size, 0);
    if (exitDepth < size) return refuse("exit-side depth below the position size");
    const c: Cycle = { id: action.clientId!, marketRef: action.marketRef, side: action.side, status: "pending", anchorAt: action.anchorAt!,
      createdAt: now, initialStopPx: stop, stopPx: stop, targetPx: target, entryPrice: price, initialRiskUsd: size * price * perUnitRisk, desiredNotional: size * price,
      filledSize: 0, leverage, themes, szDecimals: m.instrument.szDecimals, maintenanceMarginRate: m.instrument.maintenanceMarginRate,
      fundingStressHourly: fundingHourly, costFraction: costs, entryOrderIds: [], entryClientIds: [action.clientId!], provenance: action.provenance };
    s.cycles.push(c); await this.save(s);
    await adapter.configurePerpLeverage(account, { marketRef: c.marketRef, leverage, marginMode: "isolated" });
    const intent: OrderIntent = { marketRef: c.marketRef, side: long ? "BUY" : "SELL", size, limitPrice: price,
      tif: action.postOnly ? "GTC" : action.tif ?? "IOC", postOnly: action.postOnly, reduceOnly: false, clientId: action.clientId!, purpose: "entry" };
    const result = await this.submit(s, c, intent);
    this.refusals.resolve(`enter:${action.marketRef}`);
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
        // The cycle stays pending; reconciliation protects the position as soon as the index shows it.
        await this.alert("error", `Filled ${c.marketRef} is not yet visible in venue positions; its cycle waits for the index`);
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
      const placedPnl = intent.reduceOnly ? closingPnl(c.entryPrice, c.side, intent.size, intent.limitPrice, 0, "executable") : undefined;
      const placedReason = c.exitReason ?? (typeof c.provenance?.reason === "string" ? c.provenance.reason : undefined);
      await this.alert(intent.reduceOnly ? "exit" : "entry", `${intent.side} ${intent.size} ${intent.marketRef} @ ${intent.limitPrice}`, {
        orderId: ack.orderId, status: ack.status, stop: c.stopPx, stopRiskUsd: c.initialRiskUsd, leverage: c.leverage, reason: c.exitReason ?? c.provenance?.reason }, {
        at: new Date(sub.createdAt).toISOString(), market: this.perpMarket(intent.marketRef),
        trade: { side: intent.side, size: intent.size, price: intent.limitPrice, notionalUsd: intent.size * intent.limitPrice,
          orderId: ack.orderId, positionSide: c.side, ...(ack.status === "filled" ? { filled: true } : {}) },
        ...(placedPnl ? { pnl: placedPnl } : {}),
        ...(placedReason ? { reason: placedReason } : {}) });
      return { placed: true, placedNotional: intent.size * intent.limitPrice, placedSize: intent.size,
        limitPrice: intent.limitPrice, orderId: ack.orderId, clientId: intent.clientId, status: ack.status, filledSize: ack.filledSize, avgFillPrice: ack.avgFillPrice, placedAt: sub.createdAt };
    } catch (error) {
      if (error instanceof HyperliquidOrderNotSubmittedError) return this.rejectSubmission(s, c, sub, error.message);
      // This market stays reserved until the venue shows the order, a fill, or the deadline passes; others keep trading.
      sub.status = "unknown"; await this.save(s);
      await this.alert("error", `Order acknowledgement unknown for ${intent.marketRef}; reservation retained for that market`, { clientId: intent.clientId });
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
    await this.alert("skipped-order", `Order not placed for ${c.marketRef}: ${reason}`, { clientId: sub.intent.clientId, purpose: sub.intent.purpose }, {
      market: this.perpMarket(c.marketRef), reason });
    return { placed: false, status: "rejected", clientId: sub.intent.clientId, placedNotional: 0, placedSize: 0, filledSize: 0 };
  }
}

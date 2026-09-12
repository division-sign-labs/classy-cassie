// packages/core/test/perp-execution.test.ts
import { describe, expect, it, vi } from "vitest";
import { PerpExecutor, PERP_EXECUTION_KEY, isProtectiveOrder } from "../src/engine/perp-execution.js";
import { MemoryStateStore } from "../src/state.js";
import { HyperliquidOrderNotSubmittedError, HyperliquidOrderRejectedError, toCloid } from "../src/venues/hyperliquid.js";
import { formatBoundedHlPrice } from "../src/venues/hyperliquid-perps.js";
import { HyperliquidInfoDeferredError } from "../src/venues/hyperliquid-info-scheduler.js";
import type { Action, Fill, Order, OrderAck, OrderIntent, Position, VenueAdapter } from "../src/types.js";
import type { PerpAccountSnapshot, PerpCashFlow, PerpMarketSnapshot, PerpStopRequest } from "../src/perps.js";

const NOW = Date.UTC(2026, 8, 4, 12);
const ACCOUNT = { venue: "hyperliquid" as const, masterAddress: "0x1111111111111111111111111111111111111111" };

function entry(overrides: Partial<Extract<Action, { kind: "enter" }>> = {}): Extract<Action, { kind: "enter" }> {
  return { kind: "enter", marketRef: "xyz:AAPL", side: "LONG", notional: 300, limitPrice: 100,
    postOnly: true, clientId: "entry-a", stopPx: 95, targetPx: 107, anchorAt: NOW + 3 * 86_400_000, leverage: 5,
    themes: ["technology"], ...overrides };
}

function harness(config: Record<string, unknown> = {}) {
  let now = NOW;
  let seq = 0;
  let equity = 1000;
  let availableOverride: number | undefined;
  let complete = true;
  const orders = new Map<string, Order>();
  const history = new Map<string, Order>();
  const positions: Position[] = [];
  const flows: PerpCashFlow[] = [];
  const fills: Fill[] = [];
  const trace: string[] = [];
  const targetIds = new Set<string>();
  const store = new MemoryStateStore();
  const ack = (o: Order): OrderAck => ({ orderId: o.id, clientId: o.clientId, status: o.status, filledSize: o.filledSize });
  function addOrder(intent: OrderIntent): Order {
    const o: Order = { id: String(++seq), clientId: toCloid(intent.clientId), marketRef: intent.marketRef,
      side: intent.side, size: intent.size, price: intent.limitPrice, filledSize: 0, status: "open", createdAt: now,
      reduceOnly: intent.reduceOnly ?? false, isTrigger: false };
    orders.set(o.id, o); history.set(toCloid(intent.clientId), o);
    return o;
  }
  function market(marketRef: string): PerpMarketSnapshot {
    return {
      instrument: { marketRef, assetId: 120000, dex: "xyz", collateralToken: 0, szDecimals: 3,
        maxLeverage: 20, onlyIsolated: false, strictIsolated: false, minNotional: 10, maintenanceMarginRate: .025,
        marginTiers: [{ lowerBound: 0, maxLeverage: 20, maintenanceMarginRate: .025 }], deployerFeeScale: 1, growthMode: true, active: true },
      quote: { marketRef, bid: 100, ask: 100.02, mid: 100.01, spreadBps: 2, volume24h: 10_000_000, ts: now },
      book: { marketRef, bids: [{ price: 100, size: 1000 }], asks: [{ price: 100.02, size: 1000 }], ts: now, venueTs: now },
      markPrice: 100, oraclePrice: 100, fundingRateHourly: 0, makerFeeRate: .00003, takerFeeRate: .00009, ts: now,
    };
  }
  const mock = {
    perpAccountSnapshot: vi.fn(async (): Promise<PerpAccountSnapshot> => ({ equity, availableCollateral: availableOverride ?? equity - positions.reduce((v, p) => v + (p.marginUsed ?? 0), 0),
      marginUsed: positions.reduce((v, p) => v + (p.marginUsed ?? 0), 0), grossNotional: positions.reduce((v, p) => v + p.size * (p.currentPrice ?? p.avgPrice), 0),
      abstraction: "standard", collateral: "USDC", dex: "xyz", positions: structuredClone(positions), openOrders: structuredClone([...orders.values()]), ts: now })),
    positions: vi.fn(async () => structuredClone(positions)),
    perpMarketSnapshot: vi.fn(async (_account, ref: string) => market(ref)),
    perpCashFlows: vi.fn(async (_account, since: number) => ({ complete, flows: flows.filter(f => f.ts >= since && f.ts <= now) })),
    configurePerpLeverage: vi.fn(async () => {}),
    fundingRate: vi.fn(async () => 0),
    disarmScheduledCancel: vi.fn(async () => { trace.push("disarm"); }),
    openOrders: vi.fn(async () => structuredClone([...orders.values()])),
    fills: vi.fn(async (_account, since: number) => fills.filter(f => f.ts >= since)),
    lookupPerpOrder: vi.fn(async (_account, id: string) => {
      const o = history.get(toCloid(id));
      return o ? { found: true as const, order: structuredClone(o), ack: ack(o) } : { found: false as const, definitive: false };
    }),
    placeOrder: vi.fn(async (_account, intent: OrderIntent) => {
      const o = addOrder(intent); trace.push(`order:${intent.purpose ?? (intent.reduceOnly ? "exit" : "entry")}:${o.id}`);
      if (intent.purpose === "target") targetIds.add(o.id);
      return ack(o);
    }),
    placePerpStop: vi.fn(async (_account, req: PerpStopRequest) => {
      const o: Order = { id: String(++seq), clientId: toCloid(req.clientId), marketRef: req.marketRef, side: req.positionSide === "LONG" ? "SELL" : "BUY",
        size: req.size, price: req.stopPx * .98, status: "open", filledSize: 0, createdAt: now, reduceOnly: true,
        isTrigger: true, isPositionTpsl: true, triggerPrice: req.stopPx, triggerKind: "sl" };
      trace.push(`stop:${o.id}`); orders.set(o.id, o); history.set(toCloid(req.clientId), o); return ack(o);
    }),
    cancelOrder: vi.fn(async (_account, id: string) => {
      trace.push(`cancel:${id}`); const o = orders.get(id); if (o) o.status = "canceled"; orders.delete(id);
    }),
    cancelAll: vi.fn(async () => { orders.clear(); }),
    book: vi.fn(async (ref: string) => market(ref).book),
    quote: vi.fn(async (ref: string) => market(ref).quote),
  };
  const alerts = { send: vi.fn(async () => {}) };
  const deps = { botId: "swing-test", config, adapter: mock as unknown as VenueAdapter, account: ACCOUNT, state: store,
    alerter: alerts, log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, now: () => now,
    sleep: async (ms: number) => { now += ms; } };
  const executor = new PerpExecutor(deps);
  function fillEntry(clientId: string, size: number) {
    const o = history.get(toCloid(clientId));
    if (!o) throw new Error("test entry is missing");
    o.filledSize = (o.filledSize ?? 0) + size;
    o.status = o.filledSize >= o.size ? "filled" : "partial";
    if (o.status === "filled") orders.delete(o.id);
    let pos = positions.find(p => p.marketRef === o.marketRef);
    if (!pos) { pos = { marketRef: o.marketRef, side: o.side === "BUY" ? "LONG" : "SHORT", size: 0, avgPrice: o.price, currentPrice: 100, leverage: 5,
      marginMode: "isolated", marginUsed: 0, liquidationPrice: o.side === "BUY" ? 82 : 118 }; positions.push(pos); }
    pos.size += size; pos.marginUsed = pos.size * pos.avgPrice / 5;
    fills.push({ id: `fill-${fills.length}`, orderId: o.id, marketRef: o.marketRef, side: o.side, size, price: o.price, ts: now, fee: .01 });
  }
  /** Fill a resting reduce-only order (take-profit or exit) against the held position. */
  function fillOrder(orderId: string, size: number) {
    const o = orders.get(orderId);
    if (!o || !o.reduceOnly) throw new Error("test reduce-only order is missing");
    o.filledSize = (o.filledSize ?? 0) + size;
    o.status = o.filledSize >= o.size ? "filled" : "partial";
    if (o.status === "filled") orders.delete(o.id);
    const pos = positions.find(p => p.marketRef === o.marketRef);
    if (!pos) throw new Error("test position is missing");
    pos.size -= size; pos.marginUsed = pos.size * pos.avgPrice / 5;
    if (pos.size <= 1e-9) positions.splice(positions.indexOf(pos), 1);
    fills.push({ id: `fill-${fills.length}`, orderId: o.id, marketRef: o.marketRef, side: o.side, size, price: o.price, ts: now, fee: .01 });
  }
  const targets = () => [...orders.values()].filter(o => targetIds.has(o.id));
  const entries = () => mock.placeOrder.mock.calls.filter(c => !c[1].reduceOnly);
  const targetPlacements = () => mock.placeOrder.mock.calls.filter(c => c[1].purpose === "target");
  return { executor, mock, orders, positions, flows, store, trace, alerts, log: deps.log, addOrder, fillEntry, fillOrder, targets, entries, targetPlacements, market,
    advance: (ms = 1000) => { now += ms; }, time: () => now,
    setEquity: (n: number) => { equity = n; }, setComplete: (value: boolean) => { complete = value; },
    setAvailable: (n: number) => { availableOverride = n; },
    restart: (nextConfig: Record<string, unknown> = config) => new PerpExecutor({ ...deps, config: nextConfig }),
  };
}

describe("protected perp executor", () => {
  it("trades a fresh ledger as soon as the first reconciliation in this process completes", async () => {
    const h = harness();
    expect(await h.executor.execute(entry())).toEqual({ placed: false });
    expect(h.log.warn).toHaveBeenCalledWith("perp entry refused for xyz:AAPL: reconciliation-pending");
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: "reconciliation-pending" });
    await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: undefined });
    expect(await h.executor.execute(entry())).toMatchObject({ placed: true });
    expect(h.mock.configurePerpLeverage).toHaveBeenCalledWith(ACCOUNT, { marketRef: "xyz:AAPL", leverage: 5, marginMode: "isolated" });
    expect(h.mock.placeOrder).toHaveBeenCalledTimes(1);
  });

  it("ignores every legacy halt persisted by an earlier runtime except operator and drawdown", async () => {
    for (const reason of ["activation-required", "startup-readiness", "startup-readiness-failed", "shutdown-pending", "shutdown-unconfirmed", "config-drift",
      "cash-flow-incomplete", "fill-reconciliation-unavailable", "funding-unavailable", "protection-failed", "stop-ack-unknown", "submission-unknown",
      "unmanaged-exposure", "position-identity-mismatch", "invalid-stop", "filled-position-not-visible", "working-order-cancel-unknown", "old-stop-cancel-unknown"]) {
      const h = harness(); await h.executor.reconcile();
      const s = JSON.parse((await h.store.get(PERP_EXECUTION_KEY))!);
      s.halted = true; s.haltReason = reason; s.readOutageHalt = "fills"; s.shutdownQuietUntil = 1;
      await h.store.set(PERP_EXECUTION_KEY, JSON.stringify(s));
      const restarted = h.restart(); await restarted.reconcile();
      expect(await restarted.status(), reason).toMatchObject({ halted: false, haltReason: undefined });
      expect(h.log.warn).toHaveBeenCalledWith("legacy perp halt ignored; execution resolves per market", { reason });
      expect(h.log.warn.mock.calls.filter(([message]) => message === "legacy perp halt ignored; execution resolves per market")).toHaveLength(1);
      const stored = JSON.parse((await h.store.get(PERP_EXECUTION_KEY))!);
      expect(stored.halted).toBe(false); expect(stored.readOutageHalt).toBeUndefined(); expect(stored.shutdownQuietUntil).toBeUndefined();
      expect(await restarted.execute(entry()), reason).toMatchObject({ placed: true });
    }
    for (const reason of ["operator", "drawdown"]) {
      const h = harness(); await h.executor.reconcile();
      const s = JSON.parse((await h.store.get(PERP_EXECUTION_KEY))!);
      s.halted = true; s.haltReason = reason;
      await h.store.set(PERP_EXECUTION_KEY, JSON.stringify(s));
      const restarted = h.restart(); await restarted.reconcile();
      expect(await restarted.status(), reason).toMatchObject({ halted: true, haltReason: reason });
      expect(await restarted.execute(entry()), reason).toEqual({ placed: false });
    }
  });

  it("automatically reconciles a normal active restart without duplicating an entry", async () => {
    const h = harness(); await h.executor.reconcile(); await h.executor.execute(entry());
    h.fillEntry("entry-a", 3); await h.executor.reconcile();
    const restarted = h.restart(); await restarted.reconcile();
    expect(await restarted.status()).toMatchObject({ halted: false });
    expect(await restarted.execute(entry())).toMatchObject({ placed: false });
    expect(h.entries()).toHaveLength(1);
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
  });

  it("keeps a persisted active bot entry-blocked until this process has reconciled once", async () => {
    const h = harness(); await h.executor.reconcile();
    const restarted = h.restart();
    expect(await restarted.status()).toMatchObject({ halted: false, entriesPaused: "reconciliation-pending" });
    expect(await restarted.execute(entry())).toEqual({ placed: false });
    expect(h.mock.placeOrder).not.toHaveBeenCalled();
    await restarted.reconcile();
    expect(await restarted.execute(entry())).toMatchObject({ placed: true });
  });

  it("uses one account and one cash-flow read per idle supervision pass, without fill history", async () => {
    const h = harness(); await h.executor.reconcile();
    h.mock.perpAccountSnapshot.mockClear(); h.mock.perpCashFlows.mockClear(); h.mock.fills.mockClear();
    for (let tick = 0; tick < 4; tick++) { h.advance(15_000); await h.executor.reconcile(); }
    expect(h.mock.perpAccountSnapshot).toHaveBeenCalledTimes(4);
    expect(h.mock.perpCashFlows).toHaveBeenCalledTimes(4);
    expect(h.mock.fills).not.toHaveBeenCalled();
    expect(await h.executor.status()).toMatchObject({ halted: false, cashFlowsComplete: true });
  });

  it("unitizes an idle account's new external cash flow on the next supervision pass", async () => {
    const h = harness(); await h.executor.reconcile(); h.advance(15_000);
    h.setEquity(1500); h.flows.push({ id: "idle-deposit", ts: h.time(), amount: 500 });
    await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ highWaterEquity: 1500, drawdownPct: 0, cashFlowsComplete: true });
    expect(h.mock.fills).not.toHaveBeenCalled();
  });

  it("reads fills once per pass when an entry is working or a position needs protection", async () => {
    const h = harness(); await h.executor.reconcile(); await h.executor.execute(entry());
    h.mock.fills.mockClear(); h.mock.perpCashFlows.mockClear();
    h.advance(15_000); await h.executor.reconcile();
    expect(h.mock.fills).toHaveBeenCalledTimes(1);
    h.fillEntry("entry-a", 1); h.advance(15_000); await h.executor.reconcile();
    expect(h.mock.fills).toHaveBeenCalledTimes(2);
    expect(h.mock.perpCashFlows).toHaveBeenCalledTimes(2);
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
  });

  it("does not keep scanning fill history for closed and fully settled cycles", async () => {
    const h = harness(); await h.executor.reconcile(); await h.executor.execute(entry());
    for (const order of [...h.orders.values()]) await h.mock.cancelOrder(ACCOUNT, order.id);
    const stored = JSON.parse((await h.store.get(PERP_EXECUTION_KEY))!);
    stored.cycles[0].status = "closed";
    stored.submissions["entry-a"].status = "terminal";
    await h.store.set(PERP_EXECUTION_KEY, JSON.stringify(stored));
    h.mock.fills.mockClear(); h.advance(15_000); await h.executor.reconcile();
    expect(h.mock.fills).not.toHaveBeenCalled();
    expect(await h.executor.status()).toMatchObject({ halted: false });
  });

  it("keeps an operator halt latched through shutdown and restart until explicit recovery", async () => {
    const h = harness(); await h.executor.reconcile(); await h.executor.halt();
    await h.executor.cancelWorkingOrders();
    const restarted = h.restart(); await restarted.reconcile();
    expect(await restarted.status()).toMatchObject({ halted: true, haltReason: "operator" });
    expect(await restarted.execute(entry())).toEqual({ placed: false });
    expect(h.log.warn).toHaveBeenCalledWith("perp entry refused for xyz:AAPL: halted: operator");
    await restarted.resume();
    expect(await restarted.status()).toMatchObject({ halted: false });
    expect(await restarted.execute(entry())).toMatchObject({ placed: true });
  });

  it("does not automatically reset a drawdown halt during shutdown or restart", async () => {
    const h = harness(); await h.executor.reconcile(); h.setEquity(700); await h.executor.reconcile();
    await h.executor.cancelWorkingOrders();
    const restarted = h.restart(); await restarted.reconcile();
    expect(await restarted.status()).toMatchObject({ halted: true, haltReason: "drawdown", highWaterEquity: 1000 });
    expect((await restarted.status()).drawdownPct).toBeCloseTo(30);
    await expect(restarted.resume()).rejects.toThrow("loss-reset");
    await restarted.resume(true);
    expect(await restarted.status()).toMatchObject({ halted: false, highWaterEquity: 700, drawdownPct: 0 });
  });

  it("accepts configuration drift on restart, with or without exposure, and keeps each open cycle's own protection", async () => {
    const h = harness(); await h.executor.reconcile(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    await h.executor.reconcile(); await h.executor.cancelWorkingOrders();
    const restarted = h.restart({ maxPositions: 2, stopSigmaMultiple: 2, maxHoldHours: 24 }); await restarted.reconcile();
    expect(h.log.info).toHaveBeenCalledWith("perp configuration changed; accepted", { exposed: true, protectionChanged: true });
    expect(await restarted.status()).toMatchObject({ halted: false, entriesPaused: undefined });
    expect((await restarted.status()).cycles[0]).toMatchObject({ status: "open", stopPx: 95, anchorAt: NOW + 3 * 86_400_000 });
    expect(await restarted.execute(entry({ marketRef: "xyz:MSFT", clientId: "entry-b", themes: ["independent"] }))).toMatchObject({ placed: true });
    expect(JSON.parse((await h.store.get(PERP_EXECUTION_KEY))!).protectionHash).toBeDefined();
  });

  it("pauses entries on an incomplete cash-flow interval and lifts the pause on the next complete read", async () => {
    const h = harness(); h.setComplete(false); await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: "cash-flow-incomplete", cashFlowsComplete: false });
    expect(await h.executor.execute(entry())).toEqual({ placed: false });
    expect(h.log.warn).toHaveBeenCalledWith("perp entry refused for xyz:AAPL: cash-flow-incomplete");
    h.setComplete(true); await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: undefined, cashFlowsComplete: true });
    expect(await h.executor.execute(entry())).toMatchObject({ placed: true });
  });

  it("writes no halt during shutdown; the next process reconciles and trades", async () => {
    const h = harness(); await h.executor.reconcile(); h.setComplete(false);
    await h.executor.cancelWorkingOrders();
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: "cash-flow-incomplete" });
    h.setComplete(true); const restarted = h.restart(); await restarted.reconcile();
    expect(await restarted.status()).toMatchObject({ halted: false, entriesPaused: undefined });
    expect(await restarted.execute(entry())).toMatchObject({ placed: true });
  });

  it("retries protection for a restart-discovered fill every pass, trades other markets meanwhile, and exits that cycle only after the deadline", async () => {
    const h = harness(); await h.executor.reconcile(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    h.mock.placePerpStop.mockRejectedValue(new Error("protection rejected"));
    const restarted = h.restart(); await restarted.reconcile();
    expect(await restarted.status()).toMatchObject({ halted: false, reconcilingMarkets: ["xyz:AAPL"] });
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
    expect(h.mock.placeOrder.mock.calls.some(c => c[1].reduceOnly === true && c[1].purpose !== "target")).toBe(false);
    expect(h.alerts.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", message: "Protection for xyz:AAPL not confirmed; retrying each pass" }));
    expect(await restarted.execute(entry({ marketRef: "xyz:MSFT", clientId: "entry-b", themes: ["independent"] }))).toMatchObject({ placed: true });
    h.advance(60_000); await restarted.reconcile(); h.advance(60_000); await restarted.reconcile();
    expect(h.mock.placePerpStop.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect((await restarted.status()).cycles[0]!.status).toBe("open");
    h.advance(60_000); await restarted.reconcile();
    expect((await restarted.status()).cycles[0]).toMatchObject({ status: "exiting", exitReason: "protection-failed" });
    expect(h.mock.placeOrder.mock.calls.some(c => c[1].reduceOnly === true && c[1].marketRef === "xyz:AAPL")).toBe(true);
    expect((await restarted.status()).cycles[1]).toMatchObject({ marketRef: "xyz:MSFT", status: "pending" });
    expect(await restarted.status()).toMatchObject({ halted: false });
  });

  it("pauses only the market holding unmanaged exposure discovered at startup", async () => {
    const h = harness();
    h.positions.push({ marketRef: "xyz:OTHER", side: "LONG", size: 1, avgPrice: 100, currentPrice: 100, marginMode: "isolated", leverage: 5 });
    await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, unmanagedMarkets: ["xyz:OTHER"] });
    expect(h.log.warn).toHaveBeenCalledWith("unmanaged venue exposure in xyz:OTHER; entries there wait until it is resolved");
    expect(await h.executor.execute(entry({ marketRef: "xyz:OTHER", clientId: "entry-o" }))).toEqual({ placed: false });
    expect(h.mock.placeOrder).not.toHaveBeenCalled();
    expect(await h.executor.execute(entry())).toMatchObject({ placed: true });
    expect(h.mock.placePerpStop.mock.calls.every(c => c[1].marketRef !== "xyz:OTHER")).toBe(true);
    h.positions.splice(0, 1); await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ unmanagedMarkets: undefined });
    expect(h.log.info).toHaveBeenCalledWith("unmanaged exposure in xyz:OTHER cleared");
  });

  it("waits for a completed reconciliation when the first one throws, without latching anything", async () => {
    const h = harness(); await h.executor.reconcile();
    h.mock.disarmScheduledCancel.mockRejectedValueOnce(new Error("venue unavailable"));
    const restarted = h.restart(); await expect(restarted.reconcile()).rejects.toThrow("venue unavailable");
    expect(await restarted.status()).toMatchObject({ halted: false, entriesPaused: "reconciliation-pending" });
    expect(await restarted.execute(entry())).toEqual({ placed: false });
    await restarted.reconcile();
    expect(await restarted.execute(entry())).toMatchObject({ placed: true });
  });

  it("keeps a crash-persisted prepared submission reserved in its market only", async () => {
    const h = harness(); await h.executor.reconcile();
    h.mock.placeOrder.mockRejectedValueOnce(new Error("response lost"));
    await expect(h.executor.execute(entry())).rejects.toThrow("response lost");
    const s = JSON.parse((await h.store.get(PERP_EXECUTION_KEY))!);
    s.submissions["entry-a"].status = "prepared";
    await h.store.set(PERP_EXECUTION_KEY, JSON.stringify(s));
    const restarted = h.restart(); await restarted.reconcile();
    expect(await restarted.status()).toMatchObject({ halted: false, reconcilingMarkets: ["xyz:AAPL"] });
    expect(JSON.parse((await h.store.get(PERP_EXECUTION_KEY))!).submissions["entry-a"].status).toBe("unknown");
    expect(await restarted.execute(entry({ clientId: "entry-c" }))).toEqual({ placed: false });
    expect(h.mock.placeOrder).toHaveBeenCalledTimes(1);
    expect(await restarted.execute(entry({ marketRef: "xyz:MSFT", clientId: "entry-b", themes: ["independent"] }))).toMatchObject({ placed: true });
  });

  it("protects each actual partial fill and replaces protection before canceling the old stop", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry());
    h.fillEntry("entry-a", 1.25); h.advance(); await h.executor.reconcile();
    expect(h.mock.placePerpStop.mock.calls[0]![1]).toMatchObject({ size: 1.25, stopPx: 95, positionSide: "LONG" });
    const prior = [...h.orders.values()].find(isProtectiveOrder)!;
    h.fillEntry("entry-a", .5); h.advance(); await h.executor.reconcile();
    expect(h.mock.placePerpStop.mock.calls[1]![1]).toMatchObject({ size: 1.75 });
    const next = [...h.orders.values()].find(isProtectiveOrder)!;
    expect(h.trace.indexOf(`stop:${next.id}`)).toBeLessThan(h.trace.indexOf(`cancel:${prior.id}`));
    expect(h.orders.has(prior.id)).toBe(false);
    expect((await h.executor.status()).cycles[0]).toMatchObject({ status: "open", filledSize: 1.75 });
  });

  it("cancels working entries on shutdown while preserving independent native protection", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry());
    h.fillEntry("entry-a", 1); await h.executor.reconcile();
    const stop = [...h.orders.values()].find(isProtectiveOrder)!;
    await h.executor.cancelWorkingOrders();
    expect([...h.orders.keys()].sort()).toEqual([stop.id, h.targets()[0]!.id].sort());
    expect(h.mock.cancelAll).not.toHaveBeenCalled();
    expect(h.mock.disarmScheduledCancel).toHaveBeenCalled();
    expect(await h.executor.status()).toMatchObject({ halted: false });
    const restarted = h.restart(); await restarted.reconcile();
    expect(await restarted.status()).toMatchObject({ halted: false, entriesPaused: undefined });
    expect(h.orders.has(stop.id)).toBe(true);
  });

  it.each([
    "Cannot set scheduled cancel time until enough volume traded. Required: $1000000. Traded: $0.",
    "scheduleCancel acknowledgement timed out",
  ])("logs a disarm failure at shutdown, finishes the other steps and writes no halt: %s", async message => {
    const h = harness(); await h.executor.reconcile();
    h.mock.disarmScheduledCancel.mockClear().mockRejectedValueOnce(new Error(message));
    await h.executor.cancelWorkingOrders();
    expect(h.log.warn).toHaveBeenCalledWith(`shutdown cancel-timer disarm failed: Error: ${message}`);
    expect(h.mock.openOrders).toHaveBeenCalled();
    expect(h.mock.cancelAll).not.toHaveBeenCalled();
    expect(await h.executor.status()).toMatchObject({ halted: false });
    const restarted = h.restart(); await restarted.reconcile();
    expect(await restarted.execute(entry())).toMatchObject({ placed: true });
  });

  it("trades again after a shutdown the process did not survive", async () => {
    const h = harness(); await h.executor.reconcile(); await h.executor.execute(entry());
    h.fillEntry("entry-a", 3); await h.executor.reconcile();
    // SIGKILL mid-shutdown under the old runtime left this marker; it is ignored.
    const s = JSON.parse((await h.store.get(PERP_EXECUTION_KEY))!);
    s.halted = true; s.haltReason = "shutdown-pending";
    await h.store.set(PERP_EXECUTION_KEY, JSON.stringify(s));
    const restarted = h.restart(); await restarted.reconcile();
    expect(await restarted.status()).toMatchObject({ halted: false });
    expect(await restarted.execute(entry())).toMatchObject({ placed: false });
    expect(h.entries()).toHaveLength(1);
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
  });

  it("finishes shutdown through a transient venue failure without a halt", async () => {
    const h = harness(); await h.executor.reconcile();
    h.mock.openOrders.mockRejectedValueOnce(Object.assign(new Error("Unknown HTTP request error: fetch failed"), { name: "TransportError" }));
    await h.executor.cancelWorkingOrders();
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringMatching(/^shutdown entry cancellation failed: /));
    expect(await h.executor.status()).toMatchObject({ halted: false });
    const restarted = h.restart(); await restarted.reconcile();
    expect(await restarted.status()).toMatchObject({ halted: false, entriesPaused: undefined });
  });

  it("finishes shutdown while the venue is unreachable; the next process reconciles and trades", async () => {
    const h = harness(); await h.executor.reconcile(); await h.executor.execute(entry());
    h.fillEntry("entry-a", 3); await h.executor.reconcile();
    const open = h.mock.openOrders.getMockImplementation()!;
    h.mock.openOrders.mockRejectedValue(Object.assign(new Error("fetch failed"), { name: "TransportError" }));
    const before = h.time();
    await h.executor.cancelWorkingOrders();
    expect(h.time() - before).toBeLessThan(5_000);
    expect(await h.executor.status()).toMatchObject({ halted: false });
    h.mock.openOrders.mockImplementation(open);
    const restarted = h.restart(); await restarted.reconcile();
    expect(await restarted.status()).toMatchObject({ halted: false, entriesPaused: undefined });
    expect(h.entries()).toHaveLength(1);
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
    expect(await restarted.execute(entry({ clientId: "entry-b", marketRef: "xyz:MSFT", themes: ["independent"] }))).toMatchObject({ placed: true });
  });

  it("protects a final partial fill racing entry cancellation during shutdown", async () => {
    const h = harness(); await h.executor.reconcile(); await h.executor.execute(entry());
    h.fillEntry("entry-a", 1); await h.executor.reconcile();
    const cancel = h.mock.cancelOrder.getMockImplementation()!;
    h.mock.cancelOrder.mockImplementationOnce(async (account, id) => { h.fillEntry("entry-a", .75); await cancel(account, id); });
    await h.executor.cancelWorkingOrders();
    const stops = [...h.orders.values()].filter(isProtectiveOrder);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.size).toBe(1.75);
    expect(h.positions[0]!.size).toBe(1.75);
    expect(h.entries()).toHaveLength(1);
    expect(h.targets()).toHaveLength(1);
    expect(h.targets()[0]!.size).toBe(1.75);
  });

  it("keeps an unknown entry acknowledgement reserved in its market through shutdown and restart", async () => {
    const h = harness(); await h.executor.reconcile();
    h.mock.placeOrder.mockRejectedValueOnce(new Error("entry ack lost"));
    await expect(h.executor.execute(entry())).rejects.toThrow("entry ack lost");
    await h.executor.cancelWorkingOrders();
    expect(await h.executor.status()).toMatchObject({ halted: false, reconcilingMarkets: ["xyz:AAPL"] });
    expect((await h.executor.status()).cycles[0]!.status).toBe("pending");
    expect(h.mock.placeOrder).toHaveBeenCalledTimes(1);
    const restarted = h.restart(); await restarted.reconcile();
    expect(await restarted.status()).toMatchObject({ halted: false, reconcilingMarkets: ["xyz:AAPL"] });
    expect(await restarted.execute(entry({ clientId: "entry-c" }))).toEqual({ placed: false });
    expect(h.mock.placeOrder).toHaveBeenCalledTimes(1);
    expect(await restarted.execute(entry({ clientId: "entry-b", marketRef: "xyz:MSFT", themes: ["independent"] }))).toMatchObject({ placed: true });
  });

  it("logs a failed entry cancellation at shutdown while still protecting the partial fill", async () => {
    const h = harness(); await h.executor.reconcile(); await h.executor.execute(entry()); h.fillEntry("entry-a", 1);
    h.mock.cancelOrder.mockRejectedValue(new Error("cancel request failed"));
    await h.executor.cancelWorkingOrders();
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringMatching(/^shutdown entry cancellation failed: /));
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
    expect([...h.orders.values()].find(isProtectiveOrder)!.size).toBe(1);
    expect([...h.orders.values()].some(o => !isProtectiveOrder(o))).toBe(true);
    expect(await h.executor.status()).toMatchObject({ halted: false });
  });

  it("keeps retrying protection for a late fill discovered at shutdown, without a halt", async () => {
    const h = harness(); await h.executor.reconcile(); await h.executor.execute(entry());
    const cancel = h.mock.cancelOrder.getMockImplementation()!;
    h.mock.cancelOrder.mockImplementationOnce(async (account, id) => { h.fillEntry("entry-a", 1); await cancel(account, id); });
    h.mock.placePerpStop.mockRejectedValue(new Error("native stop rejected"));
    await h.executor.cancelWorkingOrders();
    expect(h.positions[0]!.size).toBe(1);
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
    expect(await h.executor.status()).toMatchObject({ halted: false, reconcilingMarkets: ["xyz:AAPL"] });
    const restarted = h.restart(); h.advance(35_000); await restarted.reconcile();
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(2);
  });

  it("retains an uncertain submission across restart in its own market, and releases it after the deadline", async () => {
    const h = harness(); await h.executor.reconcile();
    h.mock.placeOrder.mockRejectedValueOnce(new Error("transport timed out after submission"));
    await expect(h.executor.execute(entry())).rejects.toThrow("timed out");
    expect(h.alerts.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", message: "Order acknowledgement unknown for xyz:AAPL; reservation retained for that market" }));
    const restarted = h.restart();
    h.advance(300_000); await restarted.reconcile();
    expect(await restarted.status()).toMatchObject({ halted: false, reconcilingMarkets: ["xyz:AAPL"] });
    // The same client id is idempotent: it reports the existing reservation and places nothing.
    expect(await restarted.execute(entry())).toMatchObject({ clientId: "entry-a" });
    expect(await restarted.execute(entry({ clientId: "entry-c" }))).toEqual({ placed: false });
    expect(h.mock.placeOrder).toHaveBeenCalledTimes(1);
    let stored = JSON.parse((await h.store.get(PERP_EXECUTION_KEY))!);
    expect(stored.submissions["entry-a"].status).toBe("unknown");
    expect(stored.cycles[0].status).toBe("pending");
    expect(await restarted.execute(entry({ clientId: "entry-b", marketRef: "xyz:MSFT", themes: ["independent"] }))).toMatchObject({ placed: true });
    // Ten minutes with no order, fill or position: the reservation is released and the cycle closes.
    h.advance(300_000); await restarted.reconcile(); h.advance(6_000); await restarted.reconcile();
    stored = JSON.parse((await h.store.get(PERP_EXECUTION_KEY))!);
    expect(stored.submissions["entry-a"]).toMatchObject({ status: "terminal", rejectionReason: "acknowledgement never resolved" });
    expect(stored.cycles[0].status).toBe("closed");
    expect(await restarted.status()).toMatchObject({ halted: false, reconcilingMarkets: undefined });
    expect(await restarted.execute(entry({ clientId: "entry-d" }))).toMatchObject({ placed: true });
  });

  it.each(["typed-error", "rejected-ack", "preflight-deferral"])("releases a definitely unplaced entry without halting (%s)", async (source) => {
    const h = harness(); await h.executor.resume();
    if (source === "typed-error") h.mock.placeOrder.mockRejectedValueOnce(new HyperliquidOrderRejectedError("Post only order would have immediately matched"));
    else if (source === "preflight-deferral") h.mock.placeOrder.mockRejectedValueOnce(new HyperliquidOrderNotSubmittedError("Hyperliquid info deferred: rate-budget"));
    else h.mock.placeOrder.mockResolvedValueOnce({ orderId: "refused", clientId: "entry-a", status: "rejected", filledSize: 0 });
    expect(await h.executor.execute(entry())).toMatchObject({ placed: false, status: "rejected", placedNotional: 0, placedSize: 0 });
    expect(await h.executor.status()).toMatchObject({ halted: false, cycles: [{ status: "closed" }] });
    const stored = JSON.parse((await h.store.get(PERP_EXECUTION_KEY))!);
    expect(stored.submissions["entry-a"]).toMatchObject({ status: "terminal", ack: { status: "rejected" } });
    expect(h.alerts.send.mock.calls.some(([a]) => a.kind === "skipped-order")).toBe(true);
    expect(h.alerts.send.mock.calls.some(([a]) => a.kind === "entry")).toBe(false);
    const restarted = h.restart(); await restarted.reconcile();
    expect(await restarted.execute(entry())).toMatchObject({ placed: false });
    expect(h.mock.placeOrder).toHaveBeenCalledTimes(1);
    expect(await restarted.execute(entry({ clientId: "entry-b" }))).toMatchObject({ placed: true });
  });

  it("retries a rejected gold-style post-only exit with a bounded order while keeping native protection", async () => {
    const h = harness({ emergencyGapFraction: .01 }); await h.executor.resume(); await h.executor.execute(entry());
    h.fillEntry("entry-a", 3); await h.executor.reconcile();
    const stop = [...h.orders.values()].find(isProtectiveOrder)!;
    h.mock.placeOrder.mockRejectedValueOnce(new HyperliquidOrderRejectedError("Post only order would have immediately matched"));
    expect(await h.executor.execute({ kind: "exit", marketRef: "xyz:AAPL", fraction: 1, postOnly: true, reason: "median_crossed_entry" }))
      .toMatchObject({ placed: false, status: "rejected" });
    expect(await h.executor.status()).toMatchObject({ halted: false });
    expect(h.orders.has(stop.id)).toBe(true);
    h.advance(5_000); await h.executor.reconcile();
    const exits = h.mock.placeOrder.mock.calls.map(([, i]) => i).filter(i => i.purpose?.endsWith("exit"));
    expect(exits).toHaveLength(2);
    expect(exits[1]).toMatchObject({ reduceOnly: true, postOnly: false, tif: "IOC" });
    expect(exits[1]!.limitPrice).toBeGreaterThanOrEqual(99);
    expect(h.orders.has(stop.id)).toBe(true);
    expect(h.alerts.send.mock.calls.filter(([a]) => a.kind === "exit")).toHaveLength(1);
  });

  it("keeps an ambiguous exit reserved across restart, then submits a fresh reduce-only exit once the reservation lapses", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry());
    h.fillEntry("entry-a", 3); await h.executor.reconcile();
    h.mock.placeOrder.mockRejectedValueOnce(new Error("transport timed out after submission"));
    await expect(h.executor.execute({ kind: "exit", marketRef: "xyz:AAPL", fraction: 1, postOnly: true, reason: "median_crossed_entry" })).rejects.toThrow("timed out");
    h.advance(300_000); const restarted = h.restart(); await restarted.reconcile();
    expect(await restarted.status()).toMatchObject({ halted: false, reconcilingMarkets: ["xyz:AAPL"] });
    expect(h.mock.placeOrder.mock.calls.filter(([, i]) => i.purpose?.endsWith("exit"))).toHaveLength(1);
    expect([...h.orders.values()].some(isProtectiveOrder)).toBe(true);
    expect(await restarted.execute(entry({ clientId: "entry-b", marketRef: "xyz:MSFT", themes: ["independent"] }))).toMatchObject({ placed: true });
    h.advance(300_000); await restarted.reconcile();
    // The position is still open, so the exit is retried; reduce-only bounds it to the position.
    const exits = h.mock.placeOrder.mock.calls.filter(([, i]) => i.purpose?.endsWith("exit"));
    expect(exits).toHaveLength(2);
    expect(exits[1]![1]).toMatchObject({ reduceOnly: true, marketRef: "xyz:AAPL" });
    expect([...h.orders.values()].some(isProtectiveOrder)).toBe(true);
  });

  it("recovers a late acknowledged entry with a venue-hashed CLOID before ownership checks", async () => {
    const h = harness(); await h.executor.resume();
    h.mock.placeOrder.mockImplementationOnce(async (_account, intent) => { h.addOrder(intent); throw new Error("lost ack"); });
    await expect(h.executor.execute(entry())).rejects.toThrow("lost ack");
    h.fillEntry("entry-a", 1); h.advance(); await h.restart().reconcile();
    const status = await h.executor.status();
    expect(status.haltReason).not.toBe("unmanaged-exposure");
    expect(status.cycles[0]).toMatchObject({ filledSize: 1, status: "open" });
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
    expect(h.entries()).toHaveLength(1);
  });

  it("unitizes cash flows once and halts at the configured drawdown without double-counting notional", async () => {
    const h = harness(); await h.executor.resume();
    h.advance(); h.setEquity(1500); h.flows.push({ id: "deposit-1", ts: h.time(), amount: 500 });
    await h.executor.reconcile(); await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ highWaterEquity: 1500, drawdownPct: 0, halted: false });
    h.advance(); h.setEquity(1200); await h.executor.reconcile();
    expect((await h.executor.status()).drawdownPct).toBeCloseTo(20);
    h.advance(); h.setEquity(1000); h.flows.push({ id: "withdraw-1", ts: h.time(), amount: -200 }); await h.executor.reconcile();
    expect((await h.executor.status()).drawdownPct).toBeCloseTo(20);
    h.advance(); h.setEquity(900); await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ highWaterEquity: 1250, halted: true, haltReason: "drawdown" });
    await expect(h.executor.resume()).rejects.toThrow("loss-reset");
    await h.executor.resume(true);
    expect(await h.executor.status()).toMatchObject({ highWaterEquity: 900, halted: false, drawdownPct: 0 });
  });

  it("an incomplete cash-flow interval pauses additions while still protecting filled exposure", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry()); h.fillEntry("entry-a", 1);
    h.setComplete(false); await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: "cash-flow-incomplete", cashFlowsComplete: false });
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
    expect(await h.executor.execute(entry({ marketRef: "xyz:MSFT", clientId: "entry-b" }))).toEqual({ placed: false });
    h.setComplete(true); await h.executor.reconcile();
    expect(await h.executor.execute(entry({ marketRef: "xyz:MSFT", clientId: "entry-b", themes: ["independent"] }))).toMatchObject({ placed: true });
  });

  it("reserves pending gross exposure and sizes subsequent orders dynamically from NAV", async () => {
    const h = harness({ singleMarginPct: 100, totalMarginPct: 100, grossNotionalNav: .6 }); await h.executor.resume();
    await h.executor.execute(entry({ notional: 400 }));
    await h.executor.execute(entry({ marketRef: "xyz:MSFT", clientId: "entry-b", notional: 400, themes: ["independent"] }));
    const intents = h.mock.placeOrder.mock.calls.map(c => c[1]);
    expect(intents).toHaveLength(2);
    expect(intents[0]!.size * intents[0]!.limitPrice).toBeCloseTo(400);
    expect(intents[1]!.size * intents[1]!.limitPrice).toBeLessThanOrEqual(200);
    expect(intents[1]!.size * intents[1]!.limitPrice).toBeGreaterThan(199);
  });

  it("rejects selected leverage with insufficient liquidation distance and never configures it", async () => {
    const h = harness(); await h.executor.resume();
    expect(await h.executor.execute(entry({ leverage: 20 }))).toEqual({ placed: false });
    expect(h.mock.configurePerpLeverage).not.toHaveBeenCalled();
    expect(h.mock.placeOrder).not.toHaveBeenCalled();
  });

  it("only tightens stops and retains the original time anchor", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3); await h.executor.reconcile();
    await h.executor.execute({ kind: "protect", marketRef: "xyz:AAPL", stopPx: 96, reason: "trail" });
    await expect(h.executor.execute({ kind: "protect", marketRef: "xyz:AAPL", stopPx: 94, reason: "widen" })).rejects.toThrow("only tighten");
    expect((await h.executor.status()).cycles[0]).toMatchObject({ initialStopPx: 95, stopPx: 96, anchorAt: NOW + 3 * 86_400_000 });
  });

  it("pauses only the market with unmanaged exposure, without claiming ownership of it", async () => {
    const h = harness(); await h.executor.resume();
    h.positions.push({ marketRef: "xyz:OTHER", side: "LONG", size: 1, avgPrice: 100, currentPrice: 100, marginMode: "isolated", leverage: 5 });
    await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, unmanagedMarkets: ["xyz:OTHER"] });
    expect(h.mock.placePerpStop).not.toHaveBeenCalled();
    expect(await h.executor.execute(entry({ marketRef: "xyz:OTHER", clientId: "entry-o" }))).toEqual({ placed: false });
    expect(await h.executor.execute(entry())).toMatchObject({ placed: true });
  });

  it("refuses an entry into a market whose unmanaged exposure appeared after the previous reconciliation", async () => {
    const h = harness(); await h.executor.resume();
    h.positions.push({ marketRef: "xyz:OTHER", side: "LONG", size: 20, avgPrice: 100, currentPrice: 100, marginMode: "isolated", leverage: 5 });
    expect(await h.executor.execute(entry({ marketRef: "xyz:OTHER", clientId: "entry-o" }))).toEqual({ placed: false });
    expect(h.log.warn).toHaveBeenCalledWith("perp entry refused for xyz:OTHER: unmanaged venue exposure in this market");
    expect(h.mock.placeOrder).not.toHaveBeenCalled();
    expect(await h.executor.execute(entry())).toMatchObject({ placed: true });
  });

  it("blocks a drawdown that occurs between reconciliation and entry submission", async () => {
    const h = harness(); await h.executor.resume(); h.setEquity(700);
    expect(await h.executor.execute(entry())).toEqual({ placed: false });
    expect(h.mock.placeOrder).not.toHaveBeenCalled();
  });

  it("checks actual post-fill liquidation distance, not just whether the stop precedes liquidation", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    h.positions[0]!.liquidationPrice = 94.5; // Stop95 is before liquidation, but the actual buffer is insufficient.
    await h.executor.reconcile();
    expect((await h.executor.status()).cycles[0]).toMatchObject({ status: "exiting", exitReason: "liquidation-buffer" });
    expect(h.mock.placeOrder.mock.calls.some(c => c[1].reduceOnly === true)).toBe(true);
  });

  it("does not confirm an acknowledged protective order that covers the wrong quantity, and replaces it on the next pass", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    const place = h.mock.placePerpStop.getMockImplementation()!;
    h.mock.placePerpStop.mockImplementationOnce((account, request) => place(account, { ...request, size: request.size / 2 }));
    await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, reconcilingMarkets: ["xyz:AAPL"] });
    expect((await h.executor.status()).cycles[0]!.stopConfirmedAt).toBeUndefined();
    expect(h.mock.placeOrder.mock.calls.some(c => c[1].reduceOnly === true && c[1].purpose !== "target")).toBe(false);
    h.advance(); await h.executor.reconcile();
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(2);
    expect((await h.executor.status()).cycles[0]!.stopConfirmedAt).toBeDefined();
    expect([...h.orders.values()].filter(isProtectiveOrder)).toHaveLength(1);
    expect([...h.orders.values()].find(isProtectiveOrder)!.size).toBe(3);
    expect(await h.executor.status()).toMatchObject({ halted: false, reconcilingMarkets: undefined });
  });

  it("recovers a lost native-stop acknowledgement without labeling its hashed CLOID unmanaged", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    const place = h.mock.placePerpStop.getMockImplementation()!;
    h.mock.placePerpStop.mockImplementationOnce(async (account, request) => { await place(account, request); throw new Error("stop ack lost"); });
    await h.executor.reconcile(); h.advance(); await h.restart().reconcile();
    expect((await h.executor.status()).haltReason).not.toBe("unmanaged-exposure");
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
  });

  it("keeps an acknowledged stop pending through a deferred index read instead of dumping the position", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    const deferred = Object.assign(new Error("Hyperliquid info deferred: rate-budget; retry after 1s"), { retryable: true, retryAfterMs: 1_000 });
    h.mock.openOrders.mockRejectedValueOnce(deferred);
    await h.executor.reconcile();
    const first = await h.executor.status();
    expect(first.halted).toBe(false);
    expect(first.cycles[0]).toMatchObject({ status: "open", marketRef: "xyz:AAPL" });
    expect(first.cycles[0]!.stopConfirmedAt).toBeUndefined();
    expect(h.mock.placeOrder.mock.calls.some(c => c[1].reduceOnly === true && c[1].purpose !== "target")).toBe(false);
    h.advance(); await h.executor.reconcile();
    const second = await h.executor.status();
    expect(second.halted).toBe(false);
    expect(second.cycles[0]!.stopConfirmedAt).toBeDefined();
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
  });

  it("polls only the position index while waiting for a fill to appear", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(); await h.executor.resume();
      const positionsRead = h.mock.positions.getMockImplementation()!;
      let reads = 0;
      h.mock.positions.mockImplementation(async () => ++reads <= 4 ? [] : positionsRead());
      h.mock.placeOrder.mockImplementationOnce(async (_account, intent) => {
        const o = h.addOrder(intent); h.fillEntry(intent.clientId, intent.size);
        return { orderId: o.id, clientId: intent.clientId, status: "filled", filledSize: intent.size, avgFillPrice: 100 };
      });
      h.mock.perpAccountSnapshot.mockClear();
      const submitted = h.executor.execute(entry());
      await vi.runAllTimersAsync();
      expect(await submitted).toMatchObject({ placed: true, filledSize: 3 });
      expect(reads).toBe(5);
      // The account snapshot is read for the entry checks and the post-fill reconcile only, never per poll.
      expect(h.mock.perpAccountSnapshot.mock.calls.length).toBeLessThanOrEqual(3);
    } finally { vi.useRealTimers(); }
  });

  it("replaces a stop whose venue geometry does not match, and exits that cycle alone only when the deadline passes", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    const place = h.mock.placePerpStop.getMockImplementation()!;
    // Every acknowledged stop rests with the wrong trigger: protection never confirms.
    h.mock.placePerpStop.mockImplementation(async (account, request) => place(account, { ...request, stopPx: request.stopPx * 0.9 }));
    await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, reconcilingMarkets: ["xyz:AAPL"] });
    expect(h.mock.placeOrder.mock.calls.some(c => c[1].reduceOnly === true && c[1].purpose !== "target")).toBe(false);
    h.advance(120_000); await h.executor.reconcile();
    expect((await h.executor.status()).cycles[0]!.status).toBe("open");
    h.advance(60_000); await h.executor.reconcile();
    expect((await h.executor.status()).cycles[0]).toMatchObject({ status: "exiting", exitReason: "protection-failed" });
    const exit = [...h.orders.values()].find(o => o.reduceOnly && !o.isTrigger && o.marketRef === "xyz:AAPL" && o.status === "open");
    expect(exit).toBeDefined();
    h.fillOrder(exit!.id, exit!.size);
    h.advance(6 * 60_000); await h.executor.reconcile(); h.advance(6 * 60_000); await h.executor.reconcile();
    const closed = (await h.executor.status()).cycles.find(c => c.marketRef === "xyz:AAPL");
    expect(closed?.status).toBe("closed");
    expect(await h.executor.status()).toMatchObject({ halted: false, reconcilingMarkets: undefined });
    expect(await h.executor.execute(entry({ clientId: "entry-b" }))).toMatchObject({ placed: true });
  });

  it("accepts sizing and protection configuration changes with exposure; open cycles keep their recorded stop", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    await h.executor.reconcile();
    const sized = h.restart({ maxPositions: 9, singleMarginPct: 10, totalMarginPct: 90 }); await sized.reconcile();
    expect(await sized.status()).toMatchObject({ halted: false });
    expect((await sized.status()).cycles[0]).toMatchObject({ status: "open" });
    const tighter = h.restart({ maxPositions: 9, stopSigmaMultiple: 2 }); await tighter.reconcile();
    expect(await tighter.status()).toMatchObject({ halted: false });
    expect((await tighter.status()).cycles[0]).toMatchObject({ status: "open", stopPx: 95 });
    expect(h.log.info).toHaveBeenCalledWith("perp configuration changed; accepted", { exposed: true, protectionChanged: true });
    const s = JSON.parse((await h.store.get(PERP_EXECUTION_KEY))!);
    delete s.protectionHash; await h.store.set(PERP_EXECUTION_KEY, JSON.stringify(s));
    const untracked = h.restart({ maxHoldHours: 24 }); await untracked.reconcile();
    expect(await untracked.status()).toMatchObject({ halted: false });
    expect(JSON.parse((await h.store.get(PERP_EXECUTION_KEY))!).protectionHash).toBeDefined();
  });

  it("recognizes earlier protective tick rounding without replacing a correct stop every cycle", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry({ stopPx: 95.12345 })); h.fillEntry("entry-a", 3);
    const place = h.mock.placePerpStop.getMockImplementation()!;
    h.mock.placePerpStop.mockImplementationOnce(async (account, request) => {
      const ack = await place(account, request);
      h.orders.get(ack.orderId)!.triggerPrice = Number(formatBoundedHlPrice(request.stopPx, 3, "SELL"));
      return ack;
    });
    await h.executor.reconcile(); await h.executor.reconcile();
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
    expect(await h.executor.status()).toMatchObject({ halted: false });
  });

  it("retains and cleans predecessor stops after a replacement acknowledgement is lost", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry()); h.fillEntry("entry-a", 1); await h.executor.reconcile();
    const old = [...h.orders.values()].find(isProtectiveOrder)!;
    const place = h.mock.placePerpStop.getMockImplementation()!;
    h.mock.placePerpStop.mockImplementationOnce(async (account, request) => { await place(account, request); throw new Error("replacement ack lost"); });
    h.fillEntry("entry-a", 1); await h.executor.reconcile();
    expect(h.orders.has(old.id)).toBe(true);
    h.advance(); await h.restart().reconcile();
    expect(h.orders.has(old.id)).toBe(false);
    expect([...h.orders.values()].filter(isProtectiveOrder)).toHaveLength(1);
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(2);
    expect((await h.executor.status()).haltReason).not.toBe("unmanaged-exposure");
  });

  it("deducts pending collateral that the venue withdrawable figure has not reserved", async () => {
    const h = harness(); await h.executor.resume(); h.setAvailable(100);
    await h.executor.execute(entry({ notional: 400 }));
    await h.executor.execute(entry({ marketRef: "xyz:MSFT", clientId: "entry-b", notional: 400, themes: ["independent"] }));
    const next = h.mock.placeOrder.mock.calls[1]![1];
    expect(next.size * next.limitPrice).toBeLessThanOrEqual(100);
    expect(next.size * next.limitPrice).toBeGreaterThan(99);
  });

  it("allows cancellation of owned passive exits without canceling the native stop", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3); await h.executor.reconcile();
    const stop = [...h.orders.values()].find(isProtectiveOrder)!;
    const result = await h.executor.execute({ kind: "exit", marketRef: "xyz:AAPL", fraction: .5, urgent: false, postOnly: true, reason: "take-profit" });
    expect(result.placed).toBe(true);
    await h.executor.execute({ kind: "cancel", marketRef: "xyz:AAPL", orderId: result.orderId! });
    await h.executor.execute({ kind: "cancel", marketRef: "xyz:AAPL", orderId: stop.id });
    expect(h.orders.has(result.orderId!)).toBe(false);
    expect(h.orders.has(stop.id)).toBe(true);
  });

  it("continues native fill protection when the cash-flow or fill-history read fails, and only pauses entries", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry()); h.fillEntry("entry-a", 1);
    h.mock.perpCashFlows.mockRejectedValue(new Error("ledger unavailable"));
    h.mock.fills.mockRejectedValue(new Error("fills unavailable"));
    await h.executor.reconcile();
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: "fill-history-deferred", cashFlowsComplete: true });
    expect(h.log.warn).toHaveBeenCalledWith("perp cash-flow read failed; entries wait until it succeeds", expect.anything());
    expect(h.log.warn).toHaveBeenCalledWith("perp fills read failed; entries wait until it succeeds", expect.anything());
    expect(await h.executor.execute(entry({ clientId: "entry-b", marketRef: "xyz:NVDA" }))).toEqual({ placed: false });
  });

  it.each(["perpCashFlows", "fills"] as const)("recovers a deferred %s read while protecting fills and pausing new entries", async (method) => {
    const h = harness(); await h.executor.reconcile(); await h.executor.execute(entry()); h.fillEntry("entry-a", 1);
    const read = h.mock[method].getMockImplementation()!;
    h.mock[method].mockRejectedValue(new HyperliquidInfoDeferredError("queue-expired", 10_000));
    await h.executor.reconcile();
    const reason = method === "fills" ? "fill-history-deferred" : "cash-flow-deferred";
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: reason });
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
    expect([...h.orders.values()].filter(o => !o.reduceOnly)).toHaveLength(0);
    expect(await h.executor.execute(entry({ clientId: "entry-b", marketRef: "xyz:NVDA" }))).toEqual({ placed: false });
    h.mock[method].mockImplementation(read);
    h.advance(15_000); await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: undefined, cashFlowsComplete: true });
    expect(await h.executor.execute(entry({ clientId: "entry-b", marketRef: "xyz:NVDA" }))).toMatchObject({ placed: true });
  });

  it("restores entries after a deferred fill read without an operator resume", async () => {
    const h = harness(); await h.executor.reconcile(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    h.mock.fills.mockRejectedValueOnce(new HyperliquidInfoDeferredError("cooldown", 30_000));
    await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: "fill-history-deferred" });
    h.advance(30_000); await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: undefined });
    expect(await h.executor.execute(entry({ clientId: "entry-b", marketRef: "xyz:NVDA" }))).toMatchObject({ placed: true });
  });

  it("retries a first-pass read deferral without creating a startup halt", async () => {
    const h = harness();
    h.mock.perpCashFlows.mockRejectedValueOnce(new HyperliquidInfoDeferredError("queue-expired", 10_000));
    await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: "cash-flow-deferred" });
    expect(await h.executor.execute(entry())).toEqual({ placed: false });
    h.advance(15_000); await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: undefined });
    expect(await h.executor.execute(entry())).toMatchObject({ placed: true });
  });

  it("retries a deferred account snapshot after restart without latching anything", async () => {
    const h = harness(); await h.executor.reconcile();
    const restarted = h.restart();
    h.mock.perpAccountSnapshot.mockRejectedValueOnce(new HyperliquidInfoDeferredError("queue-expired", 10_000));
    await expect(restarted.reconcile()).rejects.toBeInstanceOf(HyperliquidInfoDeferredError);
    expect(await restarted.execute(entry())).toEqual({ placed: false });
    h.advance(15_000); await restarted.reconcile();
    expect(await restarted.execute(entry())).toMatchObject({ placed: true });
  });

  it.each(["operator", "drawdown"] as const)("preserves a %s halt when deferred reads recover across restart", async (reason) => {
    const h = harness(); await h.executor.reconcile();
    if (reason === "operator") await h.executor.halt(); else { h.setEquity(700); await h.executor.reconcile(); }
    h.mock.perpCashFlows.mockRejectedValueOnce(new HyperliquidInfoDeferredError("queue-expired", 10_000));
    await h.executor.reconcile();
    const restarted = h.restart(); h.advance(15_000); await restarted.reconcile();
    expect(await restarted.status()).toMatchObject({ halted: true, haltReason: reason });
    expect(await restarted.execute(entry())).toEqual({ placed: false });
  });

  it("does not treat a withdrawal during a deferred cash-flow read as drawdown", async () => {
    const h = harness(); await h.executor.reconcile(); h.advance();
    h.setEquity(500); h.flows.push({ id: "withdrawal", ts: h.time(), amount: -500 });
    h.mock.perpCashFlows.mockRejectedValueOnce(new HyperliquidInfoDeferredError("queue-expired", 10_000));
    await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: "cash-flow-deferred", highWaterEquity: 1000, drawdownPct: 0 });
    h.advance(15_000); await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, highWaterEquity: 500, drawdownPct: 0 });
    await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ highWaterEquity: 500, drawdownPct: 0 });
    expect(await h.executor.execute(entry({ notional: 100 }))).toMatchObject({ placed: true });
  });

  it("retains a flat cycle through deferred final fills and records its take-profit after recovery", async () => {
    const h = harness(); await h.executor.reconcile(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    await h.executor.reconcile(); h.advance(600_000);
    h.fillOrder(h.targets()[0]!.id, 3);
    const read = h.mock.fills.getMockImplementation()!;
    h.mock.fills.mockRejectedValue(new HyperliquidInfoDeferredError("queue-expired", 10_000));
    await h.executor.reconcile(); h.advance(15_000); await h.executor.reconcile();
    expect((await h.executor.status()).cycles[0]!.status).not.toBe("closed");
    h.mock.fills.mockImplementation(read);
    const restarted = h.restart(); await restarted.reconcile(); h.advance(15_000); await restarted.reconcile();
    expect(await restarted.status()).toMatchObject({ halted: false, cycles: [{ status: "closed", exitReason: "target", targetFilledSize: 3 }] });
    expect(h.alerts.send.mock.calls.map(c => c[0])).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "fill", data: expect.objectContaining({ reason: "target" }) })]));
    expect(await restarted.execute(entry({ clientId: "entry-b" }))).toMatchObject({ placed: true });
  });

  it("restores entries on its own once a failed fill-history read succeeds", async () => {
    const h = harness(); await h.executor.reconcile(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    const read = h.mock.fills.getMockImplementation()!;
    h.mock.fills.mockRejectedValue(new Error("fills unavailable"));
    await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: "fill-history-deferred" });
    expect(await h.executor.execute(entry({ clientId: "entry-b", marketRef: "xyz:NVDA" }))).toEqual({ placed: false });
    h.mock.fills.mockImplementation(read);
    await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: undefined });
    expect(h.log.info).toHaveBeenCalledWith("perp fills read recovered");
    expect(await h.executor.execute(entry({ clientId: "entry-b", marketRef: "xyz:NVDA" }))).toMatchObject({ placed: true });
  });

  it("includes adverse remaining funding when checking the actual liquidation buffer", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    h.mock.fundingRate.mockResolvedValue(.02); await h.executor.reconcile();
    expect((await h.executor.status()).cycles[0]).toMatchObject({ status: "exiting", exitReason: "liquidation-buffer" });
  });

  it("rejects empty books, invalid prices/funding, and anchors outside the 1–5 day mandate", async () => {
    for (const mutation of [
      (m: PerpMarketSnapshot) => { m.book.bids = []; },
      (m: PerpMarketSnapshot) => { m.quote.mid = NaN; },
      (m: PerpMarketSnapshot) => { m.fundingRateHourly = NaN; },
      (m: PerpMarketSnapshot) => { m.oraclePrice = 90; },
    ]) {
      const h = harness(); await h.executor.resume();
      h.mock.perpMarketSnapshot.mockImplementation(async (_account, ref) => { const m = h.market(ref); mutation(m); return m; });
      expect(await h.executor.execute(entry())).toEqual({ placed: false });
      expect(h.mock.placeOrder).not.toHaveBeenCalled();
    }
    for (const hours of [23, 121]) {
      const h = harness(); await h.executor.resume();
      expect(await h.executor.execute(entry({ anchorAt: NOW + hours * 3_600_000 }))).toEqual({ placed: false });
    }
  });

  it("waits briefly for an acknowledged fill to become an authoritative position before protecting it", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(); await h.executor.resume();
      const positionsRead = h.mock.positions.getMockImplementation()!;
      let reads = 0;
      h.mock.positions.mockImplementation(async () => ++reads <= 2 ? [] : positionsRead());
      h.mock.placeOrder.mockImplementationOnce(async (_account, intent) => {
        const o = h.addOrder(intent); h.fillEntry(intent.clientId, intent.size);
        return { orderId: o.id, clientId: intent.clientId, status: "filled", filledSize: intent.size, avgFillPrice: 100 };
      });
      const submitted = h.executor.execute(entry());
      await vi.runAllTimersAsync();
      expect(await submitted).toMatchObject({ placed: true, filledSize: 3 });
      expect(reads).toBe(3);
      expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
      expect(h.mock.placePerpStop.mock.calls[0]![1].size).toBe(3);
      expect(h.entries()).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("executor-owned take-profit", () => {
  it.each(["typed-rejection", "rejected-ack", "preflight-deferral"])("retries a definitely unplaced take-profit after backoff without losing the stop (%s)", async (source) => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    if (source === "typed-rejection") h.mock.placeOrder.mockRejectedValueOnce(new HyperliquidOrderRejectedError("Order price too far from oracle"));
    else if (source === "preflight-deferral") h.mock.placeOrder.mockRejectedValueOnce(new HyperliquidOrderNotSubmittedError("Hyperliquid info deferred: rate-budget"));
    else h.mock.placeOrder.mockResolvedValueOnce({ orderId: "refused-target", status: "rejected", filledSize: 0 });
    await h.executor.reconcile();
    expect([...h.orders.values()].some(isProtectiveOrder)).toBe(true);
    expect(h.targets()).toHaveLength(0);
    expect(JSON.parse((await h.store.get(PERP_EXECUTION_KEY))!).cycles[0]).not.toHaveProperty("pendingTargetClientId");
    h.advance(59_999); await h.executor.reconcile(); expect(h.targetPlacements()).toHaveLength(1);
    h.advance(1); await h.executor.reconcile();
    expect(h.targetPlacements()).toHaveLength(2); expect(h.targets()).toHaveLength(1);
    expect([...h.orders.values()].some(isProtectiveOrder)).toBe(true);
    expect(await h.executor.status()).toMatchObject({ halted: false });
  });
  async function opened(config: Record<string, unknown> = {}) {
    const h = harness(config); await h.executor.resume(); await h.executor.execute(entry());
    h.fillEntry("entry-a", 3); h.advance(); await h.executor.reconcile();
    return h;
  }

  it("rests a reduce-only GTC limit at the target for the whole position once the stop is confirmed", async () => {
    const h = await opened();
    const target = h.targets();
    expect(target).toHaveLength(1);
    expect(h.targetPlacements()[0]![1]).toMatchObject({ marketRef: "xyz:AAPL", side: "SELL", size: 3, limitPrice: 107,
      tif: "GTC", postOnly: false, reduceOnly: true, purpose: "target", clientId: "entry-a-tp-1" });
    const stop = [...h.orders.values()].find(isProtectiveOrder)!;
    expect(h.trace.indexOf(`stop:${stop.id}`)).toBeLessThan(h.trace.indexOf(`order:target:${target[0]!.id}`));
    expect((await h.executor.status()).cycles[0]).toMatchObject({ status: "open", targetPx: 107, targetOrderId: target[0]!.id, targetClientId: "entry-a-tp-1" });
    expect(await h.executor.status()).toMatchObject({ halted: false });
  });

  it("does not replace a correct take-profit on repeated reconciliation", async () => {
    const h = await opened();
    for (let pass = 0; pass < 3; pass++) { h.advance(15_000); await h.executor.reconcile(); }
    expect(h.targetPlacements()).toHaveLength(1);
    expect(h.targets()).toHaveLength(1);
  });

  it("moves the take-profit in both directions, placing the replacement before cancelling the old one", async () => {
    const h = await opened();
    const first = h.targets()[0]!;
    await h.executor.execute({ kind: "target", marketRef: "xyz:AAPL", targetPx: 110, reason: "revision" });
    const second = h.targets()[0]!;
    expect(second.id).not.toBe(first.id); expect(second.price).toBe(110); expect(h.targets()).toHaveLength(1);
    expect(h.trace.indexOf(`order:target:${second.id}`)).toBeLessThan(h.trace.indexOf(`cancel:${first.id}`));
    await h.executor.execute({ kind: "target", marketRef: "xyz:AAPL", targetPx: 104, reason: "revision" });
    expect(h.targets()).toHaveLength(1); expect(h.targets()[0]!.price).toBe(104);
    expect((await h.executor.status()).cycles[0]).toMatchObject({ targetPx: 104, stopPx: 95, targetClientId: "entry-a-tp-3" });
  });

  it("rejects a take-profit on the wrong side of entry and an entry without a favorable target", async () => {
    const h = await opened();
    await expect(h.executor.execute({ kind: "target", marketRef: "xyz:AAPL", targetPx: 99, reason: "bad" })).rejects.toThrow("favorable side");
    expect((await h.executor.status()).cycles[0]).toMatchObject({ targetPx: 107 });
    const fresh = harness(); await fresh.executor.resume();
    expect(await fresh.executor.execute(entry({ targetPx: undefined }))).toEqual({ placed: false });
    expect(await fresh.executor.execute(entry({ targetPx: 99 }))).toEqual({ placed: false });
    expect(await fresh.executor.execute(entry({ side: "SHORT", stopPx: 105, targetPx: 101 }))).toEqual({ placed: false });
    expect(fresh.mock.placeOrder).not.toHaveBeenCalled();
  });

  it("closes the cycle as a target exit when the take-profit fills and removes the stop", async () => {
    const h = await opened();
    const target = h.targets()[0]!; const stop = [...h.orders.values()].find(isProtectiveOrder)!;
    h.advance(6 * 60_000); h.fillOrder(target.id, 3); h.advance(); await h.executor.reconcile();
    h.advance(6_000); await h.executor.reconcile();
    expect((await h.executor.status()).cycles[0]).toMatchObject({ status: "closed", exitReason: "target", targetFilledSize: 3 });
    expect(h.orders.has(stop.id)).toBe(false);
    expect(await h.executor.status()).toMatchObject({ halted: false });
    expect(h.alerts.send.mock.calls.some(c => c[0].kind === "fill" && c[0].data?.reason === "target")).toBe(true);
  });

  it("accepts an immediately filled take-profit as a target exit", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    const place = h.mock.placeOrder.getMockImplementation()!;
    h.mock.placeOrder.mockImplementationOnce(async (account, intent) => {
      const ack = await place(account, intent); h.fillOrder(ack.orderId, intent.size);
      return { ...ack, status: "filled" as const, filledSize: intent.size, avgFillPrice: intent.limitPrice };
    });
    h.advance(6 * 60_000); await h.executor.reconcile();
    h.advance(6_000); await h.executor.reconcile(); h.advance(6_000); await h.executor.reconcile();
    expect((await h.executor.status()).cycles[0]).toMatchObject({ status: "closed", exitReason: "target" });
    expect(h.targets()).toHaveLength(0); expect(h.targetPlacements()).toHaveLength(1);
    expect(await h.executor.status()).toMatchObject({ halted: false });
  });

  it("cancels the take-profit once the position is flat after a stop fill", async () => {
    const h = await opened();
    const target = h.targets()[0]!; const stop = [...h.orders.values()].find(isProtectiveOrder)!;
    h.advance(6 * 60_000);
    h.orders.delete(stop.id); h.positions.splice(0, 1);
    h.advance(); await h.executor.reconcile(); h.advance(6_000); await h.executor.reconcile();
    expect(h.orders.has(target.id)).toBe(false);
    const cycle = (await h.executor.status()).cycles[0]!;
    expect(cycle.status).toBe("closed"); expect(cycle.exitReason).not.toBe("target");
  });

  it("resizes both the stop and the take-profit after a partial take-profit fill", async () => {
    const h = await opened();
    h.fillOrder(h.targets()[0]!.id, 1); h.advance(); await h.executor.reconcile();
    expect(h.positions[0]!.size).toBe(2);
    const stops = [...h.orders.values()].filter(isProtectiveOrder);
    expect(stops).toHaveLength(1); expect(stops[0]!.size).toBe(2);
    const rest = h.targets();
    expect(rest).toHaveLength(1); expect(rest[0]!.size - (rest[0]!.filledSize ?? 0)).toBe(2);
    expect(h.targetPlacements()).toHaveLength(1);
    expect((await h.executor.status()).cycles[0]).toMatchObject({ status: "open", filledSize: 2, targetFilledSize: 1 });
  });

  it("cancels the take-profit before submitting the exit of an exiting cycle", async () => {
    const h = await opened();
    const target = h.targets()[0]!;
    h.positions[0]!.liquidationPrice = 94.5;
    h.advance(); await h.executor.reconcile();
    const exitOrder = h.trace.find(t => t.startsWith("order:urgent-exit:"));
    expect(exitOrder).toBeDefined();
    expect(h.trace.indexOf(`cancel:${target.id}`)).toBeLessThan(h.trace.indexOf(exitOrder!));
    expect(h.targets()).toHaveLength(0);
    expect((await h.executor.status()).cycles[0]).toMatchObject({ status: "exiting", exitReason: "liquidation-buffer" });
  });

  it("removes the take-profit before a strategy exit and keeps the native stop", async () => {
    const h = await opened();
    const target = h.targets()[0]!; const stop = [...h.orders.values()].find(isProtectiveOrder)!;
    const result = await h.executor.execute({ kind: "exit", marketRef: "xyz:AAPL", urgent: false, postOnly: true, reason: "reversal" });
    expect(result.placed).toBe(true);
    expect(h.trace.indexOf(`cancel:${target.id}`)).toBeLessThan(h.trace.indexOf(`order:normal-exit:${result.orderId}`));
    expect(h.orders.has(stop.id)).toBe(true);
    expect(h.targets()).toHaveLength(0);
  });

  it("retains the take-profit through halt, entry cancellation, shutdown and restart", async () => {
    const h = await opened();
    const target = h.targets()[0]!;
    await h.executor.halt();
    expect(h.orders.has(target.id)).toBe(true);
    await h.executor.resume();
    await h.executor.cancelWorkingOrders();
    expect(h.orders.has(target.id)).toBe(true);
    expect([...h.orders.values()].filter(isProtectiveOrder)).toHaveLength(1);
    expect(await h.executor.status()).toMatchObject({ halted: false });
    const restarted = h.restart(); await restarted.reconcile();
    expect(await restarted.status()).toMatchObject({ halted: false });
    expect(h.targetPlacements()).toHaveLength(1);
  });

  it("recovers a lost take-profit acknowledgement by its client id without a duplicate or a halt", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    const place = h.mock.placeOrder.getMockImplementation()!;
    h.mock.placeOrder.mockImplementationOnce(async (account, intent) => { await place(account, intent); throw new Error("take-profit ack lost"); });
    h.advance(); await h.executor.reconcile();
    expect(await h.executor.status()).toMatchObject({ halted: false });
    expect((await h.executor.status()).cycles[0]).toMatchObject({ status: "open" });
    h.advance(); await h.restart().reconcile();
    expect(h.targets()).toHaveLength(1); expect(h.targetPlacements()).toHaveLength(1);
    expect((await h.executor.status()).cycles[0]).toMatchObject({ targetOrderId: h.targets()[0]!.id });
    expect((await h.executor.status()).haltReason).not.toBe("unmanaged-exposure");
  });

  it("never places a second take-profit while a lost acknowledgement is unresolved", async () => {
    const h = harness(); await h.executor.resume(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    h.mock.placeOrder.mockRejectedValueOnce(new Error("take-profit ack lost"));
    h.advance(); await h.executor.reconcile();
    h.advance(); await h.executor.reconcile();
    expect(h.targetPlacements()).toHaveLength(1); expect(h.targets()).toHaveLength(0);
    expect(await h.executor.status()).toMatchObject({ halted: false });
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
    h.mock.lookupPerpOrder.mockResolvedValueOnce({ found: false, definitive: true });
    h.advance(61_000); await h.executor.reconcile();
    expect(h.targets()).toHaveLength(1); expect(h.targetPlacements()).toHaveLength(2);
    expect(h.targetPlacements()[1]![1].clientId).toBe("entry-a-tp-2");
  });
});

describe("venue read outages", () => {
  const deferred = () => Object.assign(new Error("Hyperliquid info deferred: queue-expired; retry after 10s"),
    { name: "HyperliquidInfoDeferredError", retryable: true, retryAfterMs: 10_000 });
  const ledger = async (h: ReturnType<typeof harness>) => JSON.parse((await h.store.get(PERP_EXECUTION_KEY))!);
  const nvda = () => entry({ clientId: "entry-b", marketRef: "xyz:NVDA" });
  /** A ready executor holding one protected position, with the logger spies cleared. */
  async function exposed() {
    const h = harness(); await h.executor.reconcile(); await h.executor.execute(entry()); h.fillEntry("entry-a", 3);
    h.advance(); await h.executor.reconcile();
    expect((await h.executor.status()).cycles[0]).toMatchObject({ status: "open", fundingStressHourly: 0 });
    h.log.warn.mockClear(); h.log.info.mockClear();
    return h;
  }

  it("defers a transient fill read without a halt and warns once per outage", async () => {
    const h = await exposed();
    h.mock.fills.mockRejectedValue(deferred());
    h.advance(15_000); await h.executor.reconcile();
    const started = h.time();
    const first = await ledger(h);
    expect(first.halted).toBe(false);
    expect(first.readOutages.fills).toEqual({ since: started, lastAt: started, error: expect.stringContaining("queue-expired") });
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(h.log.warn).toHaveBeenCalledWith("perp fills read deferred; retrying next pass",
      { error: expect.stringContaining("queue-expired"), retryAfterMs: 10_000 });
    h.advance(15_000); await h.executor.reconcile();
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect((await ledger(h)).readOutages.fills).toMatchObject({ since: started, lastAt: h.time() });
    expect((await h.executor.status()).readOutages?.fills).toMatchObject({ since: started });
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
  });

  it("never turns a long transient fill outage into a halt; entries wait and resume when reads recover", async () => {
    const h = await exposed();
    const read = h.mock.fills.getMockImplementation()!;
    h.mock.fills.mockRejectedValue(deferred());
    for (let pass = 0; pass < 4; pass++) { h.advance(15_000); await h.executor.reconcile(); }
    expect(await ledger(h)).toMatchObject({ halted: false });
    h.advance(10 * 60_000); await h.executor.reconcile();
    expect(await ledger(h)).toMatchObject({ halted: false, deferredRead: "fill-history-deferred" });
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: "fill-history-deferred" });
    expect(await h.executor.execute(nvda())).toEqual({ placed: false });
    expect(h.mock.placePerpStop).toHaveBeenCalledTimes(1);
    h.mock.fills.mockImplementation(read);
    h.advance(15_000); await h.executor.reconcile();
    const recovered = await ledger(h);
    expect(recovered.halted).toBe(false);
    expect(recovered.haltReason).toBeUndefined();
    expect(recovered.readOutages).toBeUndefined();
    expect(h.log.info).toHaveBeenCalledWith("perp fills read recovered");
    expect(await h.executor.execute(nvda())).toMatchObject({ placed: true });
  });

  it("keeps an open cycle open through a deferred funding read", async () => {
    const h = await exposed();
    h.mock.fundingRate.mockRejectedValue(deferred());
    h.advance(15_000); await h.executor.reconcile();
    const s = await ledger(h);
    expect(s.cycles[0]).toMatchObject({ status: "open", fundingStressHourly: 0 });
    expect(s.cycles[0].exitReason).toBeUndefined();
    expect(s.halted).toBe(false);
    expect(s.readOutages.funding).toBeDefined();
    expect(h.mock.placeOrder.mock.calls.some(c => c[1].reduceOnly === true && c[1].purpose !== "target")).toBe(false);
    expect(await h.executor.status()).toMatchObject({ halted: false });
  });

  it("pauses entries on a fill read failure that is not transient and lifts the pause on its own when the read succeeds", async () => {
    const h = await exposed();
    const read = h.mock.fills.getMockImplementation()!;
    h.mock.fills.mockRejectedValue(new Error("schema mismatch"));
    h.advance(15_000); await h.executor.reconcile();
    expect(await ledger(h)).toMatchObject({ halted: false, deferredRead: "fill-history-deferred", readOutages: { fills: { error: "Error: schema mismatch" } } });
    expect(h.log.warn).toHaveBeenCalledWith("perp fills read failed; entries wait until it succeeds", expect.anything());
    expect(await h.executor.execute(nvda())).toEqual({ placed: false });
    h.mock.fills.mockImplementation(read);
    h.advance(15_000); await h.executor.reconcile();
    expect(await ledger(h)).toMatchObject({ halted: false });
    expect((await ledger(h)).readOutages).toBeUndefined();
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: undefined });
    expect(await h.executor.execute(nvda())).toMatchObject({ placed: true });
  });

  it("never clears an operator halt, with healthy reads or through a sustained outage", async () => {
    const h = await exposed();
    await h.executor.halt();
    for (let pass = 0; pass < 3; pass++) { h.advance(15_000); await h.executor.reconcile(); }
    expect(await ledger(h)).toMatchObject({ halted: true, haltReason: "operator" });
    const read = h.mock.fills.getMockImplementation()!;
    h.mock.fills.mockRejectedValue(deferred());
    h.advance(15_000); await h.executor.reconcile();
    h.advance(10 * 60_000); await h.executor.reconcile();
    expect(await ledger(h)).toMatchObject({ halted: true, haltReason: "operator" });
    h.mock.fills.mockImplementation(read);
    h.advance(15_000); await h.executor.reconcile();
    expect(await ledger(h)).toMatchObject({ halted: true, haltReason: "operator" });
    expect(await h.executor.execute(nvda())).toEqual({ placed: false });
  });

  it("keeps the previous cash-flow verdict through a deferred cash-flow read", async () => {
    const h = await exposed();
    h.mock.perpCashFlows.mockRejectedValue(deferred());
    h.advance(15_000); await h.executor.reconcile();
    const s = await ledger(h);
    expect(s).toMatchObject({ halted: false, cashFlowsComplete: true });
    expect(s.readOutages.cashFlows).toBeDefined();
    expect(h.log.warn).toHaveBeenCalledWith("perp cash-flow read deferred; retrying next pass", expect.objectContaining({ retryAfterMs: 10_000 }));
    // Entries stay paused while the ledger interval is unknown; the pause lifts on the next complete read.
    expect(await h.executor.status()).toMatchObject({ halted: false, entriesPaused: "cash-flow-deferred" });
    expect(await h.executor.execute(nvda())).toEqual({ placed: false });
  });

  it("restarts through an outage and trades again once reads recover, with no operator step", async () => {
    const h = await exposed();
    const read = h.mock.fills.getMockImplementation()!;
    h.mock.fills.mockRejectedValue(deferred());
    h.advance(15_000); await h.executor.reconcile();
    h.advance(10 * 60_000); await h.executor.reconcile();
    expect(await ledger(h)).toMatchObject({ halted: false, deferredRead: "fill-history-deferred" });
    const restarted = h.restart(); await restarted.reconcile();
    expect(await ledger(h)).toMatchObject({ halted: false, deferredRead: "fill-history-deferred" });
    expect(await restarted.execute(nvda())).toEqual({ placed: false });
    h.mock.fills.mockImplementation(read);
    h.advance(15_000); await restarted.reconcile();
    expect(await ledger(h)).toMatchObject({ halted: false });
    expect(await restarted.execute(nvda())).toMatchObject({ placed: true });
  });

  it("names the reason each time an entry is refused, once per market until it changes", async () => {
    const h = harness(); await h.executor.reconcile();
    expect(await h.executor.execute(entry({ leverage: 20 }))).toEqual({ placed: false });
    expect(h.log.warn).toHaveBeenCalledWith("perp entry refused for xyz:AAPL: liquidation buffer too thin for the stop");
    const before = h.log.warn.mock.calls.length;
    await h.executor.execute(entry({ leverage: 20 }));
    expect(h.log.warn).toHaveBeenCalledTimes(before);
    h.advance(5 * 60_000); await h.executor.reconcile(); await h.executor.execute(entry({ leverage: 20 }));
    expect(h.log.warn).toHaveBeenCalledTimes(before + 1);
    expect(await h.executor.execute(entry({ notional: 100 }))).toMatchObject({ placed: true });
  });
});

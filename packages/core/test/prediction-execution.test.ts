// packages/core/test/prediction-execution.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { PredictionExecutor, PREDICTION_EXECUTION_KEY, assertPredictionExecutionSettled } from "../src/engine/prediction-execution.js";
import { BotConfigSchema, PredictionExecutionConfigSchema } from "../src/config.js";
import { MemoryStateStore } from "../src/state.js";
import type { Action, Fill, Order, OrderIntent, OrderLifecycleHooks, Position, PredictionExecutionMarket, PredictionOrderState, Signal, VenueAccount, VenueAdapter } from "../src/types.js";

const NOW = Date.UTC(2026, 8, 4, 12);
const ACCOUNT = { venue: "polymarket", funder: "wallet" } as VenueAccount;
const enter = (overrides: Partial<Extract<Action, { kind: "enter" }>> = {}): Extract<Action, { kind: "enter" }> => ({ kind: "enter", marketRef: "yes", side: "YES", notional: 60,
  provenance: { qHeld: .76, signalId: "signal-1", signalTs: new Date(NOW).toISOString() }, ...overrides });

function harness(strategy: Record<string, unknown> = {}, execution?: Record<string, unknown>) {
  let now = NOW, sequence = 0, bid = .5, ask = .6, askDepth = 10000, cash = 10_000, volume = 100_000, stale = false, cancelRefused = false, missingStatus = false, lostAck = false, rejectOnce = false;
  const tokenHoldings = new Map<string, number>();
  const orders = new Map<string, Order>();
  const history = new Map<string, PredictionOrderState>();
  const fills: Fill[] = [];
  const confirmed = new Set<string>();
  const submissions: OrderIntent[] = [];
  const trace: string[] = [];
  const state = new MemoryStateStore();
  const config = BotConfigSchema.parse({ id: "limits", venue: "polymarket", strategy: { id: "signals", config: { allocationMode: "portfolio-kelly", ...strategy } }, ...(execution ? { execution } : {}) });
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const alerter = { send: vi.fn(async () => {}) };
  const signal = (side: "YES" | "NO" = "YES"): Signal => ({ id: "signal-1", marketRef: "yes", venue: "polymarket", side, prob: .76, refPrice: .55, ts: new Date(NOW).toISOString(), ttlSec: 10800 });
  const positions = (): Position[] => [...tokenHoldings].filter(([, qty]) => qty > 0).map(([token, qty]) => ({ marketRef: "yes", tokenId: token, conditionId: "condition", side: token === "no" ? "NO" : "YES", outcome: token === "no" ? "NO" : "YES", size: qty, avgPrice: .51, currentPrice: bid }));
  const market = (_ref: string, outcome: "YES" | "NO"): PredictionExecutionMarket => {
    const token = outcome === "YES" ? "yes" : "no";
    // The book contains our own live orders in addition to external liquidity.
    const bids = [{ price: bid, size: 10000 }], asks = [{ price: ask, size: askDepth }];
    for (const order of orders.values()) {
      if (order.tokenId !== token) continue;
      const levels = order.side === "BUY" ? bids : asks;
      const level = levels.find(l => Math.abs(l.price - order.price) < 1e-8);
      if (level) level.size += order.size - order.filledSize;
      else levels.push({ price: order.price, size: order.size - order.filledSize });
    }
    bids.sort((a, b) => b.price - a.price); asks.sort((a, b) => a.price - b.price);
    const ts = stale ? now - 11000 : now;
    return { marketRef: "yes", conditionId: "condition", tokenId: token, outcome, tickSize: .01, minOrderSize: 5, acceptingOrders: true, observedAt: ts,
      book: { marketRef: token, bids, asks, ts }, quote: { marketRef: token, bid, ask, mid: (bid + ask) / 2, volume24h: volume, spreadBps: 2000, ts } };
  };
  const adapter = {
    id: "polymarket", verifiedAgainst: "2026-09-04",
    executionMarket: vi.fn(async (ref: string, outcome: "YES" | "NO") => market(ref, outcome)),
    executionOrder: vi.fn(async (_account: VenueAccount, id: string) => missingStatus ? null : history.has(id) ? { ...history.get(id)!, observedAt: now } : null),
    balances: vi.fn(async () => [{ asset: "pUSD", total: cash, available: cash }]),
    positions: vi.fn(async () => positions()),
    tokenBalance: vi.fn(async (_account: VenueAccount, token: string) => tokenHoldings.get(token) ?? 0),
    eventRef: vi.fn(async (ref: string) => `event:${ref}`),
    openOrders: vi.fn(async () => structuredClone([...orders.values()])),
    tradeSettlements: vi.fn(async (_account: VenueAccount, _since: number) => structuredClone(fills)),
    normalizeOrderSize: (size: number) => Math.floor((size + 1e-8) * 100) / 100,
    cancelOrderChecked: vi.fn(async (_account: VenueAccount, id: string) => {
      trace.push(`cancel:${id}`);
      if (cancelRefused) return { status: "not-canceled" as const, reason: "still matching" };
      const previous = history.get(id);
      if (previous) previous.status = "canceled";
      orders.delete(id);
      return { status: "canceled" as const };
    }),
    cancelAll: vi.fn(async () => { for (const id of orders.keys()) { history.get(id)!.status = "canceled"; } orders.clear(); }),
    heartbeat: vi.fn(async () => {}),
    placeOrderWithLifecycle: vi.fn(async (_account: VenueAccount, intent: OrderIntent, hooks: OrderLifecycleHooks) => {
      const saved = JSON.parse((await state.get(PREDICTION_EXECUTION_KEY))!);
      expect(saved.children[intent.clientId].status).toBe("reserved");
      await hooks.onPrepared({ preparedHash: `digest-${sequence}`, tokenId: intent.tokenId!, conditionId: intent.conditionId });
      const signed = JSON.parse((await state.get(PREDICTION_EXECUTION_KEY))!);
      expect(signed.children[intent.clientId].status).toBe("signed");
      if (rejectOnce) { rejectOnce = false; throw Object.assign(new Error("post-only would cross"), { submissionRejected: true }); }
      const id = `order-${++sequence}`;
      submissions.push(structuredClone(intent)); trace.push(`place:${id}`);
      // A marketable limit takes the external ask depth immediately as a taker; any remainder rests.
      const take = intent.tif === "GTC" && !intent.postOnly && intent.side === "BUY" && intent.limitPrice + 1e-8 >= ask ? Math.min(intent.size, askDepth) : 0;
      history.set(id, { orderId: id, status: intent.tif === "FAK" ? "canceled" : take + 1e-8 >= intent.size ? "matched" : "open", size: intent.size, matchedSize: take, observedAt: now });
      if (intent.tif !== "FAK" && take + 1e-8 < intent.size) orders.set(id, { id, clientId: intent.clientId, marketRef: intent.marketRef, tokenId: intent.tokenId, conditionId: intent.conditionId, outcome: intent.outcome,
        side: intent.side, size: intent.size, filledSize: take, price: intent.limitPrice, status: take > 0 ? "partial" : "open", createdAt: now });
      if (take > 0) {
        fills.push({ id: `taker-${id}`, orderId: id, marketRef: intent.marketRef, tokenId: intent.tokenId, conditionId: intent.conditionId, outcome: intent.outcome,
          side: intent.side, size: take, matchedAmountDelta: take, price: ask, ts: now, fee: 0, settlementStatus: "CONFIRMED" });
        confirmed.add(`taker-${id}:${id}`);
        tokenHoldings.set(intent.tokenId!, (tokenHoldings.get(intent.tokenId!) ?? 0) + take);
        cash -= take * ask;
      }
      if (lostAck) throw new Error("POST timed out after venue accepted order");
      return { orderId: id, status: take + 1e-8 >= intent.size ? "filled" as const : take > 0 ? "partial" as const : "open" as const, clientId: intent.clientId, ...(take > 0 ? { filledSize: take } : {}) };
    }),
  };
  const deps = { botId: "limits", adapter: adapter as unknown as VenueAdapter, account: ACCOUNT, state, config, log, alerter, now: () => now };
  let executor = new PredictionExecutor(deps);
  async function ready(side: "YES" | "NO" = "YES") { await executor.supervise({ signals: [signal(side)], refreshedAt: now }); }
  function fill(orderId: string, quantity: number, status: NonNullable<Fill["settlementStatus"]> = "CONFIRMED", id = `trade-${fills.length}`, price?: number) {
    const order = orders.get(orderId);
    const submissionIndex = Number(orderId.split("-")[1]) - 1;
    const intent = submissions[submissionIndex]!;
    const fillPrice = price ?? intent.limitPrice;
    const previous = fills.find(f => f.id === id && f.orderId === orderId);
    if (previous) previous.settlementStatus = status;
    else {
      fills.push({ id, orderId, makerOrderId: intent.postOnly ? orderId : undefined, marketRef: intent.marketRef, tokenId: intent.tokenId,
        conditionId: intent.conditionId, outcome: intent.outcome, side: intent.side, size: quantity, matchedAmountDelta: quantity, price: fillPrice, ts: now, fee: 0, settlementStatus: status });
      history.get(orderId)!.matchedSize += quantity;
      if (order) order.filledSize += quantity;
    }
    if (status === "CONFIRMED" && !confirmed.has(`${id}:${orderId}`)) {
      confirmed.add(`${id}:${orderId}`);
      tokenHoldings.set(intent.tokenId!, (tokenHoldings.get(intent.tokenId!) ?? 0) + (intent.side === "BUY" ? quantity : -quantity));
      cash += (intent.side === "BUY" ? -1 : 1) * quantity * fillPrice;
    }
    if (history.get(orderId)!.matchedSize >= intent.size) { history.get(orderId)!.status = "matched"; orders.delete(orderId); }
  }
  return { adapter, state, submissions, orders, history, fills, trace, config, log, alerter, positions, ready, fill, market,
    get executor() { return executor; }, now: () => now, advance: (ms: number) => { now += ms; },
    restart: () => { executor = new PredictionExecutor(deps); return executor; },
    setBook: (nextBid: number, nextAsk: number, depth = 10000) => { bid = nextBid; ask = nextAsk; askDepth = depth; },
    setHeld: (qty: number, token = "yes") => { tokenHoldings.set(token, qty); },
    setCash: (value: number) => { cash = value; }, setVolume: (value: number) => { volume = value; },
    stale: () => { stale = true; }, refuseCancel: () => { cancelRefused = true; }, allowCancel: () => { cancelRefused = false; },
    hideStatus: () => { missingStatus = true; }, loseAck: () => { lostAck = true; }, rejectOnce: () => { rejectOnce = true; },
    async settleCancel() { now += 5000; await executor.supervise(); now += 5000; await executor.supervise(); },
  };
}

describe("adaptive prediction execution", () => {
  afterEach(() => { vi.useRealTimers(); });

  it.each([.60, .95])("executes published signals at Q=%s without a default 10–30pp band", async prob => {
    const h = harness();
    await h.executor.supervise({ signals: [{ id: "published", marketRef: "yes", venue: "polymarket", side: "YES", prob,
      refPrice: .55, ts: new Date(NOW).toISOString(), ttlSec: 10800 }], refreshedAt: h.now() });
    await h.executor.admit(enter({ provenance: { qHeld: prob } }), []);
    expect(h.submissions).toHaveLength(1);
    h.advance(5000); await h.restart().supervise();
    expect(h.orders.size).toBe(1);
  });

  it.each(["daily-budget", "fixed-notional"])("preserves the legacy entry filter in %s mode", async allocationMode => {
    const h = harness({ allocationMode });
    await h.executor.supervise({ signals: [{ id: "legacy", marketRef: "yes", venue: "polymarket", side: "YES", prob: .6,
      refPrice: .55, ts: new Date(NOW).toISOString(), ttlSec: 10800 }], refreshedAt: h.now() });
    await h.executor.admit(enter({ provenance: { qHeld: .6 } }), []);
    expect(h.submissions).toHaveLength(0);
  });

  it("permits more than 2.5% in one market while enforcing the 5% event cap", async () => {
    const h = harness(); h.setCash(1_000); await h.ready();
    await h.executor.admit(enter({ notional: 40 }), []);
    expect(h.submissions).toHaveLength(1);
    h.setHeld(50); // Another $25.50 of exposure puts the event over its cap.
    h.advance(5000); await h.executor.supervise();
    expect(h.orders.size).toBe(0);
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("canceling");
  });

  it("does not require $2,500 of exit depth by default", async () => {
    const h = harness(); h.setBook(.1, .2); await h.ready();
    await h.executor.admit(enter(), []);
    expect(h.submissions).toHaveLength(1);
  });

  it.each([.58, .95])("executes published sports at Q=%s without applying the local edge band", async prob => {
    const h = harness({ entrySpreadPp: 15, maxEntrySpreadPp: 30 });
    const signal: Signal = { id: "sports", marketRef: "yes", venue: "polymarket", side: "YES", sleeve: "sports", prob,
      refPrice: .6, ts: new Date(NOW).toISOString(), ttlSec: 10800 };
    await h.executor.supervise({ signals: [signal], refreshedAt: h.now() });
    await h.executor.admit(enter({ provenance: { qHeld: prob, signalId: signal.id, signalTs: signal.ts } }), []);
    expect(h.submissions).toHaveLength(1);
    expect(h.submissions[0]).toMatchObject({ limitPrice: .59, postOnly: true });
    h.restart(); h.advance(5000);
    await h.executor.supervise({ signals: [{ ...signal, prob: .57 }], refreshedAt: h.now() });
    expect([...h.orders.values()]).toHaveLength(1);
    h.advance(115_000);
    await h.executor.supervise({ signals: [{ ...signal, prob: .57 }], refreshedAt: h.now() });
    await h.settleCancel();
    expect(h.submissions).toContainEqual(expect.objectContaining({ postOnly: false, limitPrice: .6 }));
  });

  it("does not accept sports provenance as a substitute for a published sports signal", async () => {
    const h = harness({ entrySpreadPp: 15 });
    await h.executor.supervise({ signals: [{ id: "plain", marketRef: "yes", venue: "polymarket", side: "YES", prob: .58,
      refPrice: .6, ts: new Date(NOW).toISOString(), ttlSec: 10800 }], refreshedAt: h.now() });
    await h.executor.admit(enter({ provenance: { qHeld: .58, signalSleeve: "sports" } }), []);
    expect(h.submissions).toEqual([]);
  });

  it.each(["withdrawn", "stale", "side-flipped"])("cancels a working sports entry when its signal is %s", async reason => {
    const h = harness({ entrySpreadPp: 15 });
    const signal: Signal = { id: "sports", marketRef: "yes", venue: "polymarket", side: "YES", sleeve: "sports", prob: .58,
      refPrice: .6, ts: new Date(NOW).toISOString(), ttlSec: 10800 };
    await h.executor.supervise({ signals: [signal], refreshedAt: h.now() });
    await h.executor.admit(enter({ provenance: { qHeld: .58 } }), []);
    expect(h.submissions).toHaveLength(1);
    h.advance(5000);
    const changed: Signal = { ...signal, ...(reason === "stale" ? { ts: new Date(NOW - 10_800_001).toISOString() } : { side: "NO" }) };
    await h.executor.supervise({ signals: reason === "withdrawn" ? [] : [changed], refreshedAt: h.now() });
    expect(h.adapter.cancelOrderChecked).toHaveBeenCalled();
  });

  it("checks idle accounts every thirty seconds while preserving signal refreshes and explicit reads", async () => {
    const h = harness(); await h.ready();
    for (let i = 0; i < 5; i++) {
      h.advance(5000);
      await h.executor.supervise({ routine: true, refreshedAt: h.now() });
    }
    expect(h.adapter.tradeSettlements).toHaveBeenCalledTimes(1);
    expect(h.adapter.openOrders).toHaveBeenCalledTimes(1);
    expect(h.adapter.balances).toHaveBeenCalledTimes(1);
    expect(h.adapter.positions).toHaveBeenCalledTimes(1);
    expect((await h.executor.snapshot()).refreshedAt).toBe(h.now());
    h.advance(5000); await h.executor.supervise({ routine: true });
    expect(h.adapter.tradeSettlements).toHaveBeenCalledTimes(2);
    await h.executor.supervise();
    expect(h.adapter.tradeSettlements).toHaveBeenCalledTimes(3);
  });

  it("refreshes before a new admission and keeps working orders, fills and heartbeats on the fast cadence", async () => {
    const h = harness(); await h.ready();
    h.advance(5000); await h.executor.supervise({ routine: true });
    expect(h.adapter.tradeSettlements).toHaveBeenCalledTimes(1);
    await h.executor.admit(enter(), []);
    expect(h.adapter.tradeSettlements).toHaveBeenCalledTimes(2);
    h.advance(5000); await h.executor.supervise({ routine: true });
    expect(h.adapter.tradeSettlements).toHaveBeenCalledTimes(3);
    const heartbeats = h.adapter.heartbeat.mock.calls.length;
    expect(await h.executor.heartbeat()).toBe(true);
    expect(h.adapter.heartbeat).toHaveBeenCalledTimes(heartbeats + 1);
    h.fill("order-1", 100, "MATCHED", "pending");
    h.advance(5000); await h.executor.supervise({ routine: true });
    expect(h.adapter.tradeSettlements).toHaveBeenCalledTimes(4);
    expect((await h.executor.snapshot()).unsettledFillCount).toBe(1);
    h.fill("order-1", 100, "CONFIRMED", "pending");
    h.advance(5000); await h.executor.supervise({ routine: true });
    expect((await h.executor.snapshot()).unsettledFillCount).toBe(0);
    expect((await h.executor.snapshot()).parents[0]!.filledSize).toBe(100);
  });

  it("keeps fast checks through the late-fill overlap before returning to idle cadence", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.fill("order-1", 100);
    await h.executor.supervise(); h.advance(5000); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("completed");
    const before = h.adapter.tradeSettlements.mock.calls.length;
    h.advance(5000); await h.executor.supervise({ routine: true });
    expect(h.adapter.tradeSettlements).toHaveBeenCalledTimes(before + 1);
    h.advance(300_000); await h.executor.supervise({ routine: true });
    expect(h.adapter.tradeSettlements).toHaveBeenCalledTimes(before + 2);
    h.advance(5000); await h.executor.supervise({ routine: true });
    expect(h.adapter.tradeSettlements).toHaveBeenCalledTimes(before + 2);
  });

  it("keeps observing unowned orders at the fast cadence", async () => {
    const h = harness();
    h.orders.set("external", { id: "external", marketRef: "yes", tokenId: "yes", conditionId: "condition", outcome: "YES",
      side: "BUY", size: 10, filledSize: 0, price: .5, status: "open" });
    await h.ready();
    expect((await h.executor.snapshot()).unownedMarkets).toEqual(["yes"]);
    h.advance(5000); await h.executor.supervise({ routine: true });
    expect(h.adapter.openOrders).toHaveBeenCalledTimes(2);
  });

  it("does not defer restart recovery or hide a failed idle reconciliation", async () => {
    const h = harness(); await h.ready();
    h.advance(5000); await h.restart().recover();
    expect(h.adapter.tradeSettlements).toHaveBeenCalledTimes(2);
    const limited = Object.assign(new Error("rate limited"), { name: "RateLimitError", retryAfter: 2 });
    h.adapter.tradeSettlements.mockRejectedValueOnce(limited);
    h.advance(30_000); await expect(h.executor.supervise({ routine: true })).rejects.toBe(limited);
    expect((await h.executor.snapshot()).supervision).toBeDefined();
    h.advance(5000); await h.executor.supervise({ routine: true });
    expect(h.adapter.tradeSettlements).toHaveBeenCalledTimes(4);
    expect((await h.executor.snapshot()).supervision).toBeUndefined();
  });

  it("finishes fully settled orders after their detail disappears without canceling them", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.fill("order-1", 100); h.hideStatus();
    await h.executor.supervise(); h.advance(5000); await h.restart().recover();
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ status: "completed", filledSize: 100, reservedNotionalUsd: 0 });
    expect(h.adapter.cancelOrderChecked).not.toHaveBeenCalled();
    expect((await h.executor.snapshot()).blocked).toBe(false);
  });

  it("reconciles not-open responses using settlements, matching token inventory and repeated absence across restart", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.orders.clear(); h.hideStatus();
    h.adapter.cancelOrderChecked.mockResolvedValue({ status: "not-canceled", reason: "already canceled or matched", notOpen: true } as never);
    await h.executor.cancelMarket("yes", "entry deadline");
    await h.restart().recover(); h.advance(299_000); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]!.reservedNotionalUsd).toBe(60);
    h.advance(1001); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ status: "canceled", reservedNotionalUsd: 0 });
    expect(h.adapter.cancelOrderChecked).toHaveBeenCalledOnce();
    expect(h.adapter.tokenBalance).toHaveBeenCalled();
    expect((await h.executor.snapshot()).blocked).toBe(false);
  });

  it("does not release a not-open order with unseen inventory or unsettled fills", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.orders.clear(); h.hideStatus();
    h.adapter.cancelOrderChecked.mockResolvedValue({ status: "not-canceled", notOpen: true } as never);
    await h.executor.cancelMarket("yes", "entry deadline");
    await h.executor.supervise(); h.setHeld(5); h.advance(301_000); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]!.reservedNotionalUsd).toBe(60);
    h.setHeld(0); h.fill("order-1", 5, "MATCHED", "late");
    await h.executor.supervise(); h.advance(301_000); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]!.reservedNotionalUsd).toBe(60);
    h.fill("order-1", 5, "CONFIRMED", "late"); h.advance(5000); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ status: "canceled", filledSize: 5 });
  });

  it("keeps a failing order read and cancellation local while an unrelated position exits", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.refuseCancel();
    h.adapter.executionOrder.mockImplementation(async (_account, id) => {
      if (id === "order-1") throw new Error("temporary detail outage");
      return { ...h.history.get(id)!, observedAt: h.now() };
    });
    await h.executor.supervise(); h.advance(5000); await h.executor.supervise();
    h.advance(10_000); await h.executor.supervise();
    expect((await h.executor.snapshot()).blocked).toBe(false);
    expect((await h.executor.snapshot()).parents[0]!.reservedNotionalUsd).toBe(60);
    const original = h.adapter.executionMarket.getMockImplementation()!;
    h.adapter.executionMarket.mockImplementation(async (ref, side) => {
      const market = await original(ref, side);
      return ref === "other" ? { ...market, marketRef: ref, tokenId: "other", conditionId: "other-condition" } : market;
    });
    h.setHeld(10, "other");
    const position: Position = { marketRef: "other", tokenId: "other", conditionId: "other-condition", side: "YES", size: 10, avgPrice: .4 };
    await h.executor.admit({ kind: "exit", marketRef: "other", urgent: true }, [position]);
    expect(h.submissions.at(-1)).toMatchObject({ marketRef: "other", side: "SELL" });
    expect((await h.executor.snapshot()).blocked).toBe(false);
    expect(h.adapter.cancelAll).not.toHaveBeenCalled();
  });

  it("keeps resting orders and admits other markets through a heartbeat outage; only an operator pause blocks", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.adapter.heartbeat.mockRejectedValueOnce(new Error("temporary outage"));
    await expect(h.executor.heartbeat()).rejects.toThrow();
    expect(h.adapter.cancelAll).not.toHaveBeenCalled();
    expect(h.orders.size).toBe(1);
    expect(h.log.warn).toHaveBeenCalledWith("prediction heartbeat failed; resting orders expire on the venue if renewals keep failing", expect.anything());
    h.advance(5000); await h.executor.supervise();
    expect((await h.executor.snapshot()).blocked).toBe(false);
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("active");
    const original = h.adapter.executionMarket.getMockImplementation()!;
    h.adapter.executionMarket.mockImplementation(async (ref, side) => {
      const market = await original(ref, side);
      const book = { ...market.book, marketRef: ref, bids: [{ price: .5, size: 10000 }], asks: [{ price: .6, size: 10000 }] };
      return ref === "other" ? { ...market, marketRef: ref, tokenId: "other", conditionId: "other-condition", book } : market;
    });
    const both: Signal[] = ["yes", "other"].map(ref => ({ id: `signal-${ref}`, marketRef: ref, venue: "polymarket", side: "YES", prob: .76, refPrice: .55, ts: new Date(NOW).toISOString(), ttlSec: 10800 }));
    await h.executor.supervise({ signals: both, refreshedAt: h.now() });
    // Until a renewal succeeds, new entries wait; the next successful heartbeat releases them.
    expect(await h.executor.admit(enter({ marketRef: "other" }), [])).toEqual({ placed: false });
    expect(h.log.warn).toHaveBeenLastCalledWith("enter refused for other: venue heartbeat failing");
    expect(await h.executor.heartbeat()).toBe(true);
    expect(await h.executor.admit(enter({ marketRef: "other" }), [])).toHaveProperty("executionId");
    expect(h.submissions).toHaveLength(2);
    await h.executor.supervise({ paused: true }); await h.settleCancel();
    expect((await h.executor.snapshot()).blocked).toBe(true);
    expect((await h.executor.snapshot()).haltReason).toBe("operator pause");
    expect(await h.executor.admit(enter(), [])).toEqual({ placed: false });
    expect(h.log.warn).toHaveBeenCalledWith("enter refused for yes: execution paused");
  });

  it("reconciles a canceled order whose detail is missing only after the late-fill window, including restart", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    await h.executor.cancelMarket("yes", "resolution"); h.hideStatus();
    await h.restart().recover();
    h.advance(299_000); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("canceling");
    expect(h.adapter.cancelOrderChecked).toHaveBeenCalledOnce();
    h.advance(1_001); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("canceled");
    expect((await h.executor.snapshot()).parents[0]!.reservedNotionalUsd).toBe(0);
  });
  it("retains missing canceled orders while a late match has not settled", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    await h.executor.cancelMarket("yes", "resolution"); h.hideStatus();
    await h.executor.supervise(); h.fill("order-1", 2, "MATCHED", "late");
    h.advance(301_000); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("canceling");
    h.fill("order-1", 2, "CONFIRMED", "late"); h.advance(5_000); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("canceled");
    expect((await h.executor.snapshot()).parents[0]!.filledSize).toBe(2);
  });
  it("does not infer cancellation from a missing detail and an empty order list without an acknowledgement", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.refuseCancel(); await h.executor.cancelMarket("yes", "resolution"); h.orders.clear(); h.hideStatus();
    await h.executor.supervise(); h.advance(601_000); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]!.reservedNotionalUsd).toBeGreaterThan(0);
    expect((await h.executor.snapshot()).parents[0]!.status).not.toBe("canceled");
  });
  it("reserves before signing, preserves queue position, and replaces only after two terminal observations", async () => {
    const h = harness(); await h.ready();
    expect(await h.executor.admit(enter(), [])).toMatchObject({ placed: false, executionId: expect.any(String) });
    expect(h.submissions[0]).toMatchObject({ size: 100, limitPrice: .59, postOnly: true, tif: "GTC" });
    h.advance(10000); await h.executor.supervise();
    expect(h.submissions).toHaveLength(1);
    // The order rests one tick inside the ask; only a moved ask re-quotes it, and only after the minimum rest.
    h.setBook(.5, .61); h.advance(20000); await h.executor.supervise();
    expect(h.orders.size).toBe(0); expect(h.submissions).toHaveLength(1);
    h.advance(5000); await h.executor.supervise();
    expect(h.submissions).toHaveLength(1);
    h.advance(5000); await h.executor.supervise();
    expect(h.submissions[1]).toMatchObject({ limitPrice: .6, size: 100, postOnly: true });
    expect(h.trace).toEqual(["place:order-1", "cancel:order-1", "place:order-2"]);
  });

  it("keeps partial fills and unconfirmed matches reserved until cancellation settles", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.fill("order-1", 20, "MATCHED", "trade-a");
    h.setBook(.5, .61); h.advance(30000); await h.executor.supervise();
    await h.settleCancel();
    expect(h.submissions).toHaveLength(1);
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ filledSize: 0, reservedNotionalUsd: 60 });
    h.fill("order-1", 20, "CONFIRMED", "trade-a");
    h.advance(5000); await h.executor.supervise();
    expect(h.submissions[1]).toMatchObject({ size: 80, limitPrice: .6 });
    const p = (await h.executor.snapshot()).parents[0]!;
    expect(p.filledSize).toBe(20); expect(p.filledNotionalUsd).toBeCloseTo(11.8); expect(p.reservedNotionalUsd).toBeCloseTo(48);
    await h.executor.supervise();
    expect((await h.executor.snapshot()).dailySpentUsd["2026-09-04"]).toBeCloseTo(11.8);
  });

  it("cancels after 120 seconds without turning the entry into a taker when crossing is disabled", async () => {
    const h = harness({}, { entryCrossingSec: 0 }); await h.ready(); await h.executor.admit(enter(), []);
    h.fill("order-1", 15);
    h.advance(120000); await h.executor.supervise(); await h.settleCancel();
    expect(h.submissions).toHaveLength(1);
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ status: "canceled", filledSize: 15, reservedNotionalUsd: 0 });
    expect(await h.executor.admit(enter(), h.positions())).toEqual({ placed: false });
    h.advance(200000); await h.executor.supervise();
    expect(await h.executor.admit(enter(), h.positions())).toEqual({ placed: false });
    await h.ready(); expect(await h.executor.admit(enter(), h.positions())).toHaveProperty("executionId");
  });

  it("persists original deadline and signal refresh cooldown through restart", async () => {
    const h = harness({}, { entryCrossingSec: 0 }); await h.ready(); await h.executor.admit(enter(), []);
    const before = (await h.executor.snapshot()).parents[0]!;
    h.advance(125000); await h.restart().recover(); await h.settleCancel();
    const after = (await h.executor.snapshot()).parents[0]!;
    expect(after.deadlineAt).toBe(before.deadlineAt); expect(after.status).toBe("canceled");
    h.advance(200000); expect(await h.executor.admit(enter(), [])).toEqual({ placed: false });
  });

  it("never replaces a refused cancellation or an absent, unproven order", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.refuseCancel(); h.advance(30000); await h.executor.supervise(); h.advance(5000); await h.executor.supervise();
    expect(h.submissions).toHaveLength(1); expect(h.orders.size).toBe(1);
    h.allowCancel(); await h.executor.supervise(); h.hideStatus(); await h.settleCancel();
    expect(h.submissions).toHaveLength(1); expect((await h.executor.snapshot()).parents[0]!.reservedNotionalUsd).toBe(60);
  });

  it("adopts a lost POST acknowledgement from the venue's open orders across restart instead of repeating the order", async () => {
    const h = harness(); await h.ready(); h.loseAck(); await h.executor.admit(enter(), []);
    expect((await h.executor.snapshot()).blocked).toBe(false);
    expect((await h.executor.snapshot()).reconcilingMarkets).toEqual(["yes"]);
    expect(h.adapter.cancelAll).not.toHaveBeenCalled();
    h.advance(10000); await h.restart().recover(); await h.executor.supervise();
    expect(h.submissions).toHaveLength(1); expect((await h.executor.snapshot()).parents[0]!.reservedNotionalUsd).toBe(60);
    // The order rested on the venue the whole time; it is adopted by its signed terms and works normally afterwards.
    expect((await h.executor.snapshot()).parents[0]!.childOrderIds).toEqual(["order-1"]);
    expect((await h.executor.snapshot()).reconcilingMarkets).toBeUndefined();
    expect(h.log.info).toHaveBeenCalledWith("prediction submission adopted from the venue's open orders", expect.objectContaining({ orderId: "order-1" }));
    h.fill("order-1", 100); h.advance(5000); await h.executor.supervise(); h.advance(5000); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ status: "completed", filledSize: 100 });
  });

  it("resolves a lost POST that never landed as rejected after two passes, while another market trades", async () => {
    const h = harness(); await h.ready();
    const place = h.adapter.placeOrderWithLifecycle.getMockImplementation()!;
    h.adapter.placeOrderWithLifecycle.mockImplementationOnce(async (account, intent, hooks) => {
      await hooks.onPrepared({ preparedHash: "lost", tokenId: intent.tokenId!, conditionId: intent.conditionId });
      throw new Error("internal server error");
    });
    await h.executor.admit(enter(), []);
    expect(h.log.warn).toHaveBeenCalledWith("prediction submission failed", expect.objectContaining({ ambiguous: true, marketRef: "yes" }));
    expect((await h.executor.snapshot()).blocked).toBe(false);
    expect(await h.executor.admit(enter(), [])).toEqual({ placed: false, executionId: "prediction:limits:1" });
    const original = h.adapter.executionMarket.getMockImplementation()!;
    h.adapter.executionMarket.mockImplementation(async (ref, side) => {
      const market = await original(ref, side);
      return ref === "other" ? { ...market, marketRef: ref, tokenId: "other", conditionId: "other-condition" } : market;
    });
    h.adapter.placeOrderWithLifecycle.mockImplementation(place);
    await h.executor.supervise({ signals: [{ id: "signal-2", marketRef: "other", venue: "polymarket", side: "YES", prob: .76, refPrice: .55, ts: new Date(NOW).toISOString(), ttlSec: 10800 }], refreshedAt: h.now() });
    expect(await h.executor.admit(enter({ marketRef: "other" }), [])).toHaveProperty("executionId");
    expect(h.submissions).toHaveLength(1);
    const both: Signal[] = ["yes", "other"].map(ref => ({ id: `signal-${ref}`, marketRef: ref, venue: "polymarket", side: "YES", prob: .76, refPrice: .55, ts: new Date(NOW).toISOString(), ttlSec: 10800 }));
    h.advance(20_000); await h.executor.supervise({ signals: both, refreshedAt: h.now() });
    expect((await h.executor.snapshot()).reconcilingMarkets).toEqual(["yes"]);
    h.advance(15_000); await h.executor.supervise({ signals: both, refreshedAt: h.now() });
    expect(h.log.info).toHaveBeenCalledWith("prediction submission resolved as not placed", expect.objectContaining({ marketRef: "yes" }));
    const checkpoint = JSON.parse((await h.state.get(PREDICTION_EXECUTION_KEY))!);
    expect(checkpoint.children["prediction:limits:1:child:2"]).toMatchObject({ status: "rejected" });
    expect((await h.executor.snapshot()).reconcilingMarkets).toBeUndefined();
    // The parent is still inside its entry window and quotes again in its own market.
    expect(h.submissions.filter(s => s.marketRef === "yes")).toHaveLength(1);
    expect((await h.executor.snapshot()).parents.find(p => p.marketRef === "yes")!.status).toBe("active");
  });

  it("adopts a lost POST from a settlement when the order filled before it could be listed", async () => {
    const h = harness(); await h.ready();
    h.adapter.placeOrderWithLifecycle.mockImplementationOnce(async (account, intent, hooks) => {
      await hooks.onPrepared({ preparedHash: "lost", tokenId: intent.tokenId!, conditionId: intent.conditionId });
      h.submissions.push(structuredClone(intent));
      h.history.set("ghost", { orderId: "ghost", status: "matched", size: intent.size, matchedSize: intent.size, observedAt: h.now() });
      h.fills.push({ id: "ghost-fill", orderId: "ghost", makerOrderId: "ghost", marketRef: "yes", tokenId: "yes", conditionId: "condition", outcome: "YES", side: "BUY", size: intent.size, matchedAmountDelta: intent.size, price: intent.limitPrice, ts: h.now(), fee: 0, settlementStatus: "CONFIRMED" });
      h.setHeld(intent.size);
      throw new Error("socket hang up");
    });
    await h.executor.admit(enter(), []);
    h.advance(5000); await h.executor.supervise();
    expect(h.log.info).toHaveBeenCalledWith("prediction submission adopted from a settlement", expect.objectContaining({ orderId: "ghost" }));
    h.advance(5000); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ status: "completed", filledSize: 100, childOrderIds: ["ghost"] });
    expect(h.submissions).toHaveLength(1);
  });

  it("can retry a definitive post-only rejection without treating it as an ambiguous fill", async () => {
    const h = harness(); await h.ready(); h.rejectOnce(); await h.executor.admit(enter(), []);
    expect((await h.executor.snapshot()).blocked).toBe(false);
    h.advance(5000); await h.executor.supervise(); expect(h.submissions).toHaveLength(1);
  });

  it("uses the actual NO book and never exceeds its admission price and budget", async () => {
    const h = harness(); await h.ready("NO"); await h.executor.admit(enter({ side: "NO" }), []);
    expect(h.submissions[0]).toMatchObject({ tokenId: "no", outcome: "NO", limitPrice: .59 });
    h.setBook(.58, .65); h.advance(65000); await h.executor.supervise(); await h.settleCancel();
    expect(h.submissions[1]).toMatchObject({ limitPrice: .6, size: 100 });
    expect(h.submissions[1]!.size * h.submissions[1]!.limitPrice).toBeLessThanOrEqual(60);
  });

  it("cancels on stale books, changed Q eligibility, depleted exit depth, and reduced market headroom", async () => {
    for (const reason of ["stale", "signal", "depth", "cash"] as const) {
      const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
      if (reason === "stale") h.stale();
      if (reason === "depth") h.config.strategy.config.minExitDepth2cUsd = 100_000;
      if (reason === "cash") h.setCash(100);
      h.advance(5000); await h.executor.supervise(reason === "signal" ? { signals: [] } : {});
      expect(h.orders.size, reason).toBe(0);
      expect((await h.executor.snapshot()).parents[0]!.status, reason).toBe("canceling");
    }
  });

  it("moves a normal SELL through passive phases, waits for fresh evaluation, then makes one bounded FAK attempt", async () => {
    const h = harness(); h.setHeld(100); await h.ready();
    await h.executor.admit({ kind: "exit", marketRef: "yes", reason: "convergence" }, h.positions());
    expect(h.submissions[0]).toMatchObject({ side: "SELL", limitPrice: .59, postOnly: true });
    h.advance(20000); await h.executor.supervise(); await h.settleCancel();
    expect(h.submissions[1]).toMatchObject({ limitPrice: .55, postOnly: true });
    h.advance(35000); await h.executor.supervise(); await h.settleCancel();
    expect(h.submissions).toHaveLength(2);
    h.setBook(.4, .5);
    await h.executor.supervise({ exitDecisions: { yes: "normal" }, exitsEvaluatedAt: h.now() });
    expect(h.submissions[2]).toMatchObject({ side: "SELL", tif: "FAK", postOnly: false, limitPrice: .39 });
    await h.settleCancel();
    expect(await h.executor.admit({ kind: "exit", marketRef: "yes", urgent: true }, h.positions())).toEqual({ placed: false });
  });

  it("cancels a normal exit when the strategy confirms that convergence cleared", async () => {
    const h = harness(); h.setHeld(100); await h.ready();
    await h.executor.admit({ kind: "exit", marketRef: "yes" }, h.positions());
    h.advance(10000); await h.executor.supervise({ exitDecisions: { yes: "hold" }, exitsEvaluatedAt: h.now() }); await h.settleCancel();
    expect(h.submissions).toHaveLength(1); expect((await h.executor.snapshot()).parents[0]!.status).toBe("canceled");
  });

  it("latches an urgent exit and bypasses passive rest even after a price gap", async () => {
    const h = harness(); h.setHeld(100); await h.ready();
    await h.executor.admit({ kind: "exit", marketRef: "yes" }, h.positions());
    h.setBook(.3, .4); h.advance(1000);
    await h.executor.admit({ kind: "exit", marketRef: "yes", urgent: true }, h.positions()); await h.settleCancel();
    expect(h.submissions[1]).toMatchObject({ tif: "FAK", postOnly: false, limitPrice: .3 });
  });

  it("persists an urgent SELL behind a canceling partial BUY and advances it on the fast lane", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []); h.fill("order-1", 20);
    await h.executor.admit({ kind: "exit", marketRef: "yes", urgent: true }, h.positions());
    expect(h.submissions).toHaveLength(1);
    await h.settleCancel(); h.advance(5000); await h.executor.supervise();
    expect(h.submissions[1]).toMatchObject({ side: "SELL", size: 20, tif: "FAK" });
  });

  it("preserves both maker legs when trades share an id across owned child generations", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.fill("order-1", 10, "CONFIRMED", "same-trade"); h.setBook(.5, .61); h.advance(30000); await h.executor.supervise(); await h.settleCancel();
    h.fill("order-2", 10, "CONFIRMED", "same-trade"); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]!.filledSize).toBe(20);
  });

  it("pauses entries only in a market holding an unowned resting order, and never adopts it by matching terms", async () => {
    const h = harness(); h.orders.set("legacy", { id: "legacy", marketRef: "yes", side: "BUY", size: 100, filledSize: 0, price: .51, status: "open" });
    await h.ready(); expect((await h.executor.snapshot()).blocked).toBe(false);
    expect((await h.executor.snapshot()).unownedMarkets).toEqual(["yes"]);
    expect(h.log.warn).toHaveBeenCalledWith("unowned open order; entries in its market wait until it clears", expect.objectContaining({ orderId: "legacy", marketRef: "yes" }));
    expect(await h.executor.admit(enter(), [])).toEqual({ placed: false }); expect(h.submissions).toHaveLength(0);
    expect(h.log.warn).toHaveBeenCalledWith("enter refused for yes: an order this executor did not place rests in this market");
    const warnings = h.log.warn.mock.calls.length;
    await h.executor.admit(enter(), []); expect(h.log.warn).toHaveBeenCalledTimes(warnings);
    const original = h.adapter.executionMarket.getMockImplementation()!;
    h.adapter.executionMarket.mockImplementation(async (ref, side) => {
      const market = await original(ref, side);
      return ref === "other" ? { ...market, marketRef: ref, tokenId: "other", conditionId: "other-condition" } : market;
    });
    await h.executor.supervise({ signals: [{ id: "signal-2", marketRef: "other", venue: "polymarket", side: "YES", prob: .76, refPrice: .55, ts: new Date(NOW).toISOString(), ttlSec: 10800 }], refreshedAt: h.now() });
    expect(await h.executor.admit(enter({ marketRef: "other" }), [])).toHaveProperty("executionId");
    expect(h.submissions).toHaveLength(1);
    h.orders.delete("legacy"); h.advance(5000); await h.executor.supervise();
    expect((await h.executor.snapshot()).unownedMarkets).toBeUndefined();
    expect(h.log.info).toHaveBeenCalledWith("unowned open order cleared", { orderId: "legacy" });
  });

  it("keeps the shutdown latch permanent against delayed supervise calls and admissions", async () => {
    const h = harness(); await h.ready(); await h.executor.beginShutdown();
    await h.executor.supervise({ paused: false });
    expect(await h.executor.admit(enter(), [])).toEqual({ placed: false }); expect(h.submissions).toHaveLength(0);
  });

  it("heartbeat failure leaves resting orders to the venue's dead-man switch and places nothing new until renewals succeed", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.adapter.heartbeat.mockRejectedValue(new Error("heartbeat lost"));
    await expect(h.executor.heartbeat()).rejects.toThrow("heartbeat lost");
    h.advance(5000); await expect(h.executor.heartbeat()).rejects.toThrow("heartbeat lost");
    expect(h.adapter.cancelAll).not.toHaveBeenCalled();
    expect(h.log.warn.mock.calls.filter(([message]) => String(message).startsWith("prediction heartbeat failed"))).toHaveLength(1);
    expect((await h.executor.snapshot()).blocked).toBe(false);
    // The venue's timer fires: the order disappears; the parent stays open for its window but is not re-quoted while renewals fail.
    h.history.get("order-1")!.status = "canceled"; h.orders.delete("order-1");
    await h.executor.supervise(); h.advance(5000); await h.executor.supervise(); h.advance(5000); await h.executor.supervise();
    expect(h.submissions).toHaveLength(1);
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("active");
    expect(h.log.warn).toHaveBeenCalledWith("no new orders while the venue heartbeat is failing; resting orders expire on the venue");
    expect(await h.executor.admit(enter({ marketRef: "other" }), [])).toEqual({ placed: false });
    h.adapter.heartbeat.mockResolvedValue(undefined);
    h.advance(5000); await h.executor.heartbeat();
    await h.executor.supervise();
    expect(h.submissions).toHaveLength(2);
    expect(h.log.info).toHaveBeenCalledWith("venue heartbeat recovered; new orders resume");
  });

  it("cancels an old-side entry when a newer opposite signal appears, and honors signal TTL", async () => {
    for (const shorterTtl of [false, true]) {
      const h = harness(); await h.ready(); await h.executor.admit(enter(), []); h.advance(5000);
      const old: Signal = { id: "old", venue: "polymarket", marketRef: "yes", side: "YES", prob: .76, refPrice: .55, ts: new Date(NOW).toISOString(), ttlSec: shorterTtl ? 1 : 10800 };
      const newer: Signal = { ...old, id: "new", side: "NO", ts: new Date(NOW + 1000).toISOString() };
      await h.executor.supervise({ signals: shorterTtl ? [old] : [old, newer], refreshedAt: h.now() });
      expect((await h.executor.snapshot()).parents[0]!.status).toBe("canceling");
      expect(h.orders.size).toBe(0);
    }
  });

  it("uses the configured polling interval for retry admission and still requires a successful newer refresh", async () => {
    const h = harness({ signalPollIntervalMin: 1 }, { entryCrossingSec: 0 }); await h.ready(); await h.executor.admit(enter(), []);
    h.advance(120000); await h.executor.supervise(); await h.settleCancel();
    expect(await h.executor.admit(enter(), [])).toEqual({ placed: false });
    await h.ready(); expect(await h.executor.admit(enter(), [])).toHaveProperty("executionId");
  });

  it("advances the settlement scan window after terminal reconciliation but keeps an overlap", async () => {
    const h = harness({}, { entryCrossingSec: 0 }); await h.ready(); await h.executor.admit(enter(), []);
    h.advance(120000); await h.executor.supervise(); await h.settleCancel(); h.advance(600000);
    await h.executor.supervise(); h.advance(5000); await h.executor.supervise();
    const calls = h.adapter.tradeSettlements.mock.calls;
    expect(calls.at(-1)![1]).toBe(h.now() - 5000 - 300000);
  });

  it("does not replay a queued normal exit after a fresh holding decision", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []); h.fill("order-1", 20);
    await h.executor.admit({ kind: "exit", marketRef: "yes" }, h.positions());
    await h.settleCancel(); h.advance(5000);
    await h.executor.supervise({ exitDecisions: { yes: "hold" }, exitsEvaluatedAt: h.now() });
    expect(h.submissions).toHaveLength(1);
  });

  it("resume clears only the operator pause; an unknown POST keeps resolving in its own market", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    await h.executor.supervise({ paused: true }); await h.settleCancel();
    expect((await h.executor.snapshot()).blocked).toBe(true);
    await h.executor.resume(); await h.executor.supervise({ paused: false });
    expect((await h.executor.snapshot()).blocked).toBe(false);
    h.advance(300_000); await h.ready(); expect(await h.executor.admit(enter(), [])).toHaveProperty("executionId");
    const unknown = harness(); await unknown.ready(); unknown.loseAck(); await unknown.executor.admit(enter(), []);
    await unknown.executor.resume();
    expect((await unknown.executor.snapshot()).blocked).toBe(false);
    expect((await unknown.executor.snapshot()).parents[0]!.childOrderIds).toEqual(["order-1"]);
  });

  it("resume tolerates a slow or throttled reconciliation and does not block entries on it", async () => {
    vi.useFakeTimers();
    const h = harness(); await h.ready(); await h.executor.supervise({ paused: true });
    h.adapter.tradeSettlements.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { name: "RateLimitError", retryAfter: 1 }));
    await h.executor.resume();
    expect((await h.executor.snapshot()).blocked).toBe(false);
    expect((await h.executor.snapshot()).supervision).toMatchObject({ stage: "reconcile" });
    h.advance(2000); await vi.advanceTimersByTimeAsync(2000);
    await h.executor.supervise({ paused: false });
    expect(await h.executor.admit(enter(), [])).toHaveProperty("executionId");
    expect(h.submissions).toHaveLength(1);
  });

  it("does not invent inventory from failed settlement and safely retries only the remaining target", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.fill("order-1", 20, "MATCHED", "failed-trade"); h.setBook(.5, .61); h.advance(30000); await h.executor.supervise(); await h.settleCancel();
    expect(h.submissions).toHaveLength(1);
    h.fill("order-1", 20, "FAILED", "failed-trade"); h.advance(5000); await h.executor.supervise();
    expect(h.submissions[1]!.size).toBe(100); expect((await h.executor.snapshot()).parents[0]!.filledSize).toBe(0);
    expect((await h.executor.snapshot()).dailySpentUsd).toEqual({});
  });

  it("aborts before POST when shutdown starts during SDK preparation", async () => {
    const h = harness(); await h.ready();
    let start!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = h.adapter.placeOrderWithLifecycle.getMockImplementation()!;
    h.adapter.placeOrderWithLifecycle.mockImplementationOnce(async (...args) => { start(); await gate; return original(...args); });
    const admission = h.executor.admit(enter(), []);
    await started;
    const shutdown = h.executor.beginShutdown();
    release();
    await Promise.all([admission, shutdown]);
    expect(h.submissions).toHaveLength(0);
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("canceled");
  });

  it.each(["book", "order"] as const)("bounds a never-resolving %s read and keeps the resting order for a later pass", async resource => {
    vi.useFakeTimers();
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []); h.advance(5000);
    if (resource === "book") h.adapter.executionMarket.mockImplementationOnce(() => new Promise(() => {}));
    else h.adapter.executionOrder.mockImplementationOnce(() => new Promise(() => {}));
    const outcome = h.executor.supervise().then(() => undefined, error => error as Error);
    await vi.advanceTimersByTimeAsync(0); h.advance(4000); await vi.advanceTimersByTimeAsync(4000);
    const error = await outcome;
    expect(error).toBeUndefined();
    if (resource === "order") expect(h.log.warn).toHaveBeenCalledWith("prediction order reconciliation pending", expect.objectContaining({ error: expect.stringContaining("order state exceeded four seconds") }));
    else expect(h.log.warn).toHaveBeenCalledWith("prediction supervision deferred", expect.objectContaining({ stage: "work" }));
    expect(h.orders.size).toBe(1);
    expect(h.submissions).toHaveLength(1);
    expect(h.adapter.cancelOrderChecked).not.toHaveBeenCalled();
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ status: "active", filledSize: 0, reservedNotionalUsd: 60 });
    h.advance(5000); await h.executor.supervise();
    expect(h.orders.size).toBe(1); expect(h.submissions).toHaveLength(1);
    expect((await h.executor.snapshot()).supervision).toBeUndefined();
  });

  it.each(["book", "order"] as const)("stops a parent whose %s read has been failing for more than a minute, without an account halt", async resource => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    const limited = () => Promise.reject(Object.assign(new Error("Request was rate limited"), { name: "RateLimitError", retryAfter: 2 }));
    if (resource === "book") h.adapter.executionMarket.mockImplementation(limited);
    else h.adapter.executionOrder.mockImplementation(limited);
    for (let elapsed = 0; elapsed < 60_000; elapsed += 5000) { h.advance(5000); await h.executor.supervise(); }
    expect(h.orders.size).toBe(1);
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("active");
    // The order read first failed one pass after admission, so its clock runs five seconds behind the book's.
    h.advance(resource === "order" ? 10_000 : 5000); await h.executor.supervise();
    expect(h.orders.size).toBe(0);
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("canceling");
    expect((await h.executor.snapshot()).blocked).toBe(false);
    expect(h.adapter.cancelAll).not.toHaveBeenCalled();
  });

  it("cancels an expired entry on the heartbeat lane while order reconciliation is stalled", async () => {
    vi.useFakeTimers();
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []); h.advance(120000);
    h.adapter.executionOrder.mockImplementationOnce(() => new Promise(() => {}));
    const outcome = h.executor.supervise().catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(0);
    const heartbeatsBefore = h.adapter.heartbeat.mock.calls.length;
    expect(await h.executor.heartbeat()).toBe(false);
    expect(h.orders.size).toBe(0);
    expect(h.adapter.heartbeat).toHaveBeenCalledTimes(heartbeatsBefore);
    h.advance(4000); await vi.advanceTimersByTimeAsync(4000); await outcome;
    expect(h.submissions).toHaveLength(1);
  });

  it("keeps heartbeating through a short supervision gap, then stops resting orders per parent after a minute without halting the account", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    const heartbeatsBefore = h.adapter.heartbeat.mock.calls.length;
    h.advance(11000); expect(await h.executor.heartbeat()).toBe(true);
    h.advance(48000); expect(await h.executor.heartbeat()).toBe(true);
    expect(h.adapter.heartbeat).toHaveBeenCalledTimes(heartbeatsBefore + 2);
    expect(h.orders.size).toBe(1);
    h.advance(2000); expect(await h.executor.heartbeat()).toBe(false);
    expect(h.orders.size).toBe(0);
    expect(h.adapter.cancelOrderChecked).toHaveBeenCalledOnce();
    expect(h.adapter.cancelAll).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalledWith("prediction supervision stale; canceling resting orders without halting the account", expect.anything());
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ status: "canceling", cancelReason: "supervision stale for more than 60 seconds" });
    expect((await h.executor.snapshot()).blocked).toBe(false);
    await h.settleCancel();
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("canceled");
    h.advance(300_000); await h.ready(); expect(await h.executor.admit(enter(), [])).toHaveProperty("executionId");
    expect(h.submissions).toHaveLength(2);
  });

  it.each(["timeout", "watchdog"] as const)("rejects late SDK preparation after %s without sending a POST", async trigger => {
    vi.useFakeTimers();
    const h = harness(); await h.ready();
    let started!: () => void, release!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const post = vi.fn();
    let lateResult: Promise<unknown> | undefined;
    h.adapter.placeOrderWithLifecycle.mockImplementationOnce((_account, intent, hooks) => {
      started();
      const operation = (async () => {
        await gate;
        await hooks.onPrepared({ preparedHash: "late-digest", tokenId: intent.tokenId!, conditionId: intent.conditionId, size: intent.size, limitPrice: intent.limitPrice });
        post(); return { orderId: "late-order", status: "open" as const, clientId: intent.clientId };
      })();
      lateResult = operation.catch(error => error as Error);
      return operation;
    });
    const admission = h.executor.admit(enter(), []);
    await start;
    if (trigger === "timeout") { h.advance(4000); await vi.advanceTimersByTimeAsync(4000); await admission; }
    else {
      h.advance(61000);
      expect(await h.executor.heartbeat()).toBe(false);
    }
    release(); await vi.advanceTimersByTimeAsync(0); await admission;
    expect(await lateResult).toBeInstanceOf(Error);
    expect(post).not.toHaveBeenCalled();
    expect(h.submissions).toHaveLength(0);
  });

  it("allows an urgent SELL against executable bids with no ask liquidity", async () => {
    const h = harness(); h.setHeld(100); await h.ready();
    h.adapter.executionMarket.mockImplementation(async (ref, outcome) => {
      const market = h.market(ref, outcome);
      return { ...market, book: { ...market.book, asks: [] } };
    });
    await h.executor.admit({ kind: "exit", marketRef: "yes", urgent: true }, h.positions());
    expect(h.submissions).toHaveLength(1);
    expect(h.submissions[0]).toMatchObject({ side: "SELL", size: 100, tif: "FAK", postOnly: false, limitPrice: .49 });
  });

  it("persists the exact SDK-normalized terms before POST and reconciles against those terms", async () => {
    const h = harness(); await h.ready();
    let postedReceipt: { intent: OrderIntent; status: string } | undefined;
    h.adapter.placeOrderWithLifecycle.mockImplementationOnce(async (_account, intent, hooks) => {
      await hooks.onPrepared({ preparedHash: "normalized-digest", tokenId: intent.tokenId!, conditionId: intent.conditionId, size: 99.99, limitPrice: .5 });
      const checkpoint = JSON.parse((await h.state.get(PREDICTION_EXECUTION_KEY))!);
      postedReceipt = checkpoint.children[intent.clientId];
      const signed: OrderIntent = { ...intent, size: 99.99, limitPrice: .5 };
      h.submissions.push(signed);
      h.orders.set("normalized-order", { id: "normalized-order", clientId: intent.clientId, marketRef: "yes", tokenId: "yes", conditionId: "condition", outcome: "YES",
        side: "BUY", size: 99.99, price: .5, filledSize: 0, status: "open" });
      h.history.set("normalized-order", { orderId: "normalized-order", status: "open", size: 99.99, matchedSize: 0, observedAt: h.now() });
      return { orderId: "normalized-order", status: "open", clientId: intent.clientId };
    });
    await h.executor.admit(enter(), []);
    expect(postedReceipt).toMatchObject({ status: "signed", intent: { size: 99.99, limitPrice: .5 } });
    h.advance(5000); await h.executor.supervise();
    expect((await h.executor.snapshot()).blocked).toBe(false);
    expect(h.submissions).toHaveLength(1);
  });

  it.each(["larger-size", "higher-buy-price", "lower-sell-price"] as const)("rejects SDK normalization that widens authorized risk: %s", async risk => {
    const h = harness(); await h.ready();
    const sell = risk === "lower-sell-price";
    if (sell) h.setHeld(100);
    const post = vi.fn();
    h.adapter.placeOrderWithLifecycle.mockImplementationOnce(async (_account, intent, hooks) => {
      await hooks.onPrepared({ preparedHash: "invalid-digest", tokenId: intent.tokenId!, conditionId: intent.conditionId,
        size: risk === "larger-size" ? intent.size + .01 : intent.size,
        limitPrice: intent.limitPrice + (risk === "higher-buy-price" ? .01 : risk === "lower-sell-price" ? -.01 : 0) });
      post(); return { orderId: "invalid-order", status: "open", clientId: intent.clientId };
    });
    await h.executor.admit(sell ? { kind: "exit", marketRef: "yes" } : enter(), h.positions());
    expect(post).not.toHaveBeenCalled(); expect(h.submissions).toHaveLength(0);
    expect((await h.executor.snapshot()).blocked).toBe(false);
    const checkpoint = JSON.parse((await h.state.get(PREDICTION_EXECUTION_KEY))!);
    expect(Object.values(checkpoint.children)).toEqual([expect.objectContaining({ status: "rejected" })]);
  });

  it("emits entry notifications only for confirmed fills once across repeated and restarted scans", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    expect(h.alerter.send).not.toHaveBeenCalled();
    h.advance(5000); h.fill("order-1", 20, "MATCHED", "notified-fill"); await h.executor.supervise();
    expect(h.alerter.send).not.toHaveBeenCalled();
    h.fill("order-1", 20, "CONFIRMED", "notified-fill"); await h.executor.supervise();
    expect(h.alerter.send).toHaveBeenCalledTimes(1);
    expect(h.alerter.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "entry",
      market: { ref: "yes", tokenId: "yes", conditionId: "condition", outcome: "YES" },
      data: expect.objectContaining({ orderId: "order-1", maker: true }) }));
    await h.executor.supervise(); await h.restart().recover();
    expect(h.alerter.send).toHaveBeenCalledTimes(1);
    const metrics = (await h.executor.snapshot()).parents[0]!.metrics!;
    expect(metrics.makerShare).toBe(1); expect(metrics.fillRatio).toBe(.2); expect(metrics.priceImprovementUsd).toBeCloseTo(.2);
  });

  it.each(["YES", "NO"] as const)("reports identity and realized P&L after the whole %s position closes", async outcome => {
    const tokenId = outcome === "YES" ? "yes" : "no";
    const h = harness(); h.setHeld(100, tokenId); await h.ready();
    await h.executor.admit({ kind: "exit", marketRef: "yes", reason: "take-profit" }, h.positions());
    expect(h.submissions[0]).toMatchObject({ side: "SELL", limitPrice: .59 });
    h.fill("order-1", 100); await h.executor.supervise();
    expect(h.positions()).toHaveLength(0);
    expect(h.alerter.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "exit",
      market: { ref: "yes", tokenId, conditionId: "condition", outcome }, pnl: { usd: 8, pct: 15.69, basis: "realized" } }));
    expect(h.log.info).toHaveBeenCalledWith("prediction fill confirmed", expect.objectContaining({ side: "SELL", entryAvgPrice: .51, pnlUsd: 8, pnlPct: 15.69 }));
  });

  it("retains the NO entry identity when a confirmed fill is first observed after restart", async () => {
    const h = harness(); await h.ready("NO"); await h.executor.admit(enter({ side: "NO" }), []);
    expect(h.submissions[0]).toMatchObject({ tokenId: "no", outcome: "NO" });
    h.fill("order-1", 20);
    await h.restart().recover();
    expect(h.alerter.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "entry",
      market: { ref: "yes", tokenId: "no", conditionId: "condition", outcome: "NO" } }));
  });

  it("does not block execution on a failed fill notification", async () => {
    vi.useFakeTimers();
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.alerter.send.mockImplementationOnce(() => new Promise(() => {}));
    h.fill("order-1", 20); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]!.filledSize).toBe(20);
    h.advance(4000); await vi.advanceTimersByTimeAsync(4000);
    expect(h.log.warn).toHaveBeenCalledWith("prediction fill notification failed", expect.anything());
    expect((await h.executor.snapshot()).blocked).toBe(false);
  });

  it("permits a mode switch before admission and after confirmed cancellation, while refusing working obligations", async () => {
    const h = harness();
    await expect(assertPredictionExecutionSettled(h.state)).resolves.toBeUndefined();
    await h.ready(); await expect(assertPredictionExecutionSettled(h.state)).resolves.toBeUndefined();
    await h.executor.admit(enter(), []);
    await expect(assertPredictionExecutionSettled(h.state)).rejects.toThrow("unresolved adaptive prediction execution");
    await h.executor.cancelMarket("yes", "prepare mode switch");
    await expect(assertPredictionExecutionSettled(h.state)).rejects.toThrow("unresolved adaptive prediction execution");
    await h.settleCancel();
    await expect(assertPredictionExecutionSettled(h.state)).resolves.toBeUndefined();
  });

  it("refuses a mode switch while a canceled child's matched fill remains unsettled", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.fill("order-1", 20, "MATCHED", "mode-switch-fill");
    await h.executor.cancelMarket("yes", "prepare strategy switch"); await h.settleCancel();
    await expect(assertPredictionExecutionSettled(h.state)).rejects.toThrow("unresolved adaptive prediction execution");
    h.fill("order-1", 20, "CONFIRMED", "mode-switch-fill"); h.advance(5000); await h.executor.supervise();
    await expect(assertPredictionExecutionSettled(h.state)).resolves.toBeUndefined();
  });

  it("refuses a strategy switch while an unknown POST is unresolved, and permits it once the adopted order settles", async () => {
    const h = harness(); await h.ready(); h.loseAck(); await h.executor.admit(enter(), []);
    expect(h.orders.size).toBe(1);
    await expect(assertPredictionExecutionSettled(h.state)).rejects.toThrow("unresolved adaptive prediction execution");
    h.advance(10000); await h.restart().recover();
    await expect(assertPredictionExecutionSettled(h.state)).rejects.toThrow("unresolved adaptive prediction execution");
    await h.executor.cancelMarket("yes", "prepare strategy switch"); await h.settleCancel();
    await expect(assertPredictionExecutionSettled(h.state)).resolves.toBeUndefined();
  });

  it("refuses a mode switch between a settled BUY cancellation and its queued urgent SELL", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []); h.fill("order-1", 20);
    await h.executor.admit({ kind: "exit", marketRef: "yes", urgent: true }, h.positions());
    await h.settleCancel();
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("canceled");
    expect(h.submissions).toHaveLength(1);
    await expect(assertPredictionExecutionSettled(h.state)).rejects.toThrow("unresolved adaptive prediction execution");
  });

  it("requires a new normal-exit assessment at the exact passive deadline before the FAK transition", async () => {
    const h = harness(); h.setHeld(100); await h.ready();
    await h.executor.admit({ kind: "exit", marketRef: "yes", reason: "convergence" }, h.positions());
    h.advance(60000); await h.executor.supervise();
    expect(h.submissions).toHaveLength(1); expect(h.orders.size).toBe(0);
    await h.settleCancel();
    // This assessment is fresh in wall-clock terms, but predates the passive deadline.
    await h.executor.supervise({ exitDecisions: { yes: "normal" }, exitsEvaluatedAt: NOW + 59999 });
    expect(h.submissions).toHaveLength(1);
    await h.executor.supervise({ exitDecisions: { yes: "normal" }, exitsEvaluatedAt: h.now() });
    expect(h.submissions[1]).toMatchObject({ side: "SELL", tif: "FAK", postOnly: false });
  });


  it("crosses at the deadline with a marketable limit at the price bound and completes on the taker fill", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    expect((await h.executor.snapshot()).parents[0]!.crossingDeadlineAt).toBe(NOW + 180_000);
    h.advance(120000); await h.executor.supervise();
    expect(h.orders.size).toBe(0); expect(h.submissions).toHaveLength(1);
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("active");
    await h.settleCancel();
    expect(h.submissions[1]).toMatchObject({ side: "BUY", size: 100, limitPrice: .6, postOnly: false, tif: "GTC" });
    expect(h.log.info).toHaveBeenCalledWith("prediction entry crossing", expect.objectContaining({ ask: .6, cap: .6, price: .6, size: 100 }));
    expect(h.fills.at(-1)).toMatchObject({ orderId: "order-2", size: 100, price: .6, settlementStatus: "CONFIRMED" });
    h.advance(5000); await h.executor.supervise(); h.advance(5000); await h.executor.supervise();
    const parent = (await h.executor.snapshot()).parents[0]!;
    expect(parent).toMatchObject({ status: "completed", filledSize: 100, reservedNotionalUsd: 0 });
    expect(parent.metrics!.makerShare).toBe(0);
    expect(h.submissions).toHaveLength(2);
    expect(h.log.info).toHaveBeenCalledWith("prediction entry crossing finished", expect.objectContaining({ status: "completed", remaining: 0 }));
  });

  it("sweeps the offers inside the bound at their own prices when the ask sits below the cap", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.advance(120000); await h.executor.supervise();
    // The maker order is gone; the ask then improves below the bound before the crossing child is placed.
    h.setBook(.5, .58); await h.settleCancel();
    expect(h.submissions[1]).toMatchObject({ limitPrice: .6, size: 100, postOnly: false });
    expect(h.fills.at(-1)).toMatchObject({ orderId: "order-2", size: 100, price: .58 });
  });

  it("rests the crossing remainder at the bound without chasing and completes on a later maker fill", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.setBook(.5, .6, 40); h.advance(120000); await h.executor.supervise(); await h.settleCancel();
    expect(h.submissions[1]).toMatchObject({ size: 100, limitPrice: .6, postOnly: false });
    expect(h.orders.get("order-2")).toMatchObject({ filledSize: 40 });
    // The sweep consumed the offer; the remainder is now the best bid under a higher ask.
    h.setBook(.5, .61);
    h.advance(5000); await h.executor.supervise(); h.advance(5000); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ status: "active", filledSize: 40 });
    expect(h.submissions).toHaveLength(2); expect(h.orders.size).toBe(1);
    h.fill("order-2", 60, "CONFIRMED", "maker-rest", .6);
    h.advance(5000); await h.executor.supervise(); h.advance(5000); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ status: "completed", filledSize: 100, reservedNotionalUsd: 0 });
  });

  it("completes a crossed entry whose remainder is below the venue minimum once the window closes", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.setBook(.5, .6, 97); h.advance(120000); await h.executor.supervise(); await h.settleCancel();
    expect(h.orders.get("order-2")).toMatchObject({ filledSize: 97 });
    h.advance(60000); await h.executor.supervise(); await h.settleCancel();
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ status: "completed", filledSize: 97, reservedNotionalUsd: 0 });
    expect(h.orders.size).toBe(0);
  });

  it("cancels the crossing remainder when the window closes and ends the entry as a partial", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.setBook(.5, .6, 40); h.advance(120000); await h.executor.supervise(); await h.settleCancel();
    h.advance(60000); expect(await h.executor.heartbeat()).toBe(false);
    expect(h.orders.size).toBe(0);
    await h.settleCancel();
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ status: "canceled", filledSize: 40, reservedNotionalUsd: 0, cancelReason: "entry crossing window expired" });
    expect(h.submissions).toHaveLength(2);
  });

  it("stops at the deadline when the ask sits above the price bound and re-admits after the cooldown", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.setBook(.58, .63); h.advance(120000); await h.executor.supervise();
    expect(h.submissions).toHaveLength(1);
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ status: "canceling", cancelReason: "entry deadline reached with ask above price limit" });
    await h.settleCancel();
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("canceled");
    h.advance(300_000); await h.ready(); expect(await h.executor.admit(enter(), [])).toHaveProperty("executionId");
  });

  it("resumes a resting crossing remainder across a restart inside the window and stops it after the window", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.setBook(.5, .6, 40); h.advance(120000); await h.executor.supervise(); await h.settleCancel();
    h.setBook(.5, .61);
    h.advance(20000); await h.restart().recover(); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ status: "active", filledSize: 40 });
    expect(h.submissions).toHaveLength(2); expect(h.orders.size).toBe(1);
    h.fill("order-2", 60, "CONFIRMED", "after-restart", .6);
    h.advance(5000); await h.executor.supervise(); h.advance(5000); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("completed");
    const late = harness(); await late.ready(); await late.executor.admit(enter(), []);
    late.setBook(.5, .6, 40); late.advance(120000); await late.executor.supervise(); await late.settleCancel();
    late.advance(61000); await late.restart().recover(); await late.settleCancel();
    expect((await late.executor.snapshot()).parents[0]).toMatchObject({ status: "canceled", filledSize: 40, cancelReason: "entry crossing window elapsed during restart" });
  });

  it("lets the heartbeat lane cancel the expired maker order while the parent stays active for the crossing", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.advance(120000); expect(await h.executor.heartbeat()).toBe(false);
    expect(h.orders.size).toBe(0);
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("active");
    await h.settleCancel();
    expect(h.submissions[1]).toMatchObject({ limitPrice: .6, postOnly: false, tif: "GTC" });
  });

  it("defers on a rate-limited settlement read, keeps orders, warns once, and escalates only after a minute", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    const limited = Object.assign(new Error("Request to /trades was rate limited"), { name: "RateLimitError", retryAfter: 2 });
    h.adapter.tradeSettlements.mockRejectedValue(limited);
    h.advance(5000); await expect(h.executor.supervise()).rejects.toBe(limited);
    expect(h.orders.size).toBe(1);
    expect(h.adapter.cancelOrderChecked).not.toHaveBeenCalled(); expect(h.adapter.cancelAll).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(h.log.warn).toHaveBeenCalledWith("prediction supervision deferred", expect.objectContaining({ stage: "reconcile", retryAfterMs: 2000 }));
    expect((await h.executor.snapshot()).supervision).toMatchObject({ stage: "reconcile" });
    expect(await h.executor.admit(enter({ marketRef: "other" }), [])).toEqual({ placed: false });
    expect(h.log.warn).toHaveBeenLastCalledWith("enter refused for other: supervision deferred (reconcile)");
    expect(h.adapter.executionMarket).toHaveBeenCalledTimes(1);
    h.advance(5000); await expect(h.executor.supervise()).rejects.toBe(limited);
    expect(h.log.warn).toHaveBeenCalledTimes(2);
    h.advance(5000); expect(await h.executor.heartbeat()).toBe(true);
    for (let elapsed = 15_000; elapsed < 60_000; elapsed += 5000) { h.advance(5000); await expect(h.executor.supervise()).rejects.toBe(limited); }
    expect(h.orders.size).toBe(1);
    h.advance(5000); await expect(h.executor.supervise()).rejects.toBe(limited);
    // Past the stale window the read failure still only defers; the parent is stopped by the heartbeat lane's stale rule.
    expect(h.log.warn).toHaveBeenLastCalledWith("prediction supervision deferred", expect.objectContaining({ stage: "reconcile" }));
    expect(h.adapter.cancelAll).not.toHaveBeenCalled();
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("active");
    expect(await h.executor.heartbeat()).toBe(false);
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("canceling");
    expect((await h.executor.snapshot()).blocked).toBe(false);
    h.adapter.tradeSettlements.mockImplementation(async () => structuredClone(h.fills));
    await h.settleCancel();
    expect(h.log.info).toHaveBeenCalledWith("prediction supervision resumed", expect.anything());
    expect((await h.executor.snapshot()).supervision).toBeUndefined();
  });

  it("holds the resting order and places nothing new while the portfolio read is throttled", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.adapter.positions.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { name: "RateLimitError", retryAfter: 1 }));
    h.setBook(.5, .61); h.advance(30000); await h.executor.supervise();
    expect(h.orders.size).toBe(1); expect(h.submissions).toHaveLength(1);
    expect(h.log.warn).toHaveBeenCalledWith("prediction supervision deferred", expect.objectContaining({ stage: "snapshot" }));
    h.advance(5000); await h.executor.supervise();
    expect(h.orders.size).toBe(0);
    await h.settleCancel();
    expect(h.submissions[1]).toMatchObject({ limitPrice: .6 });
  });

  it("reads the account once per pass however many parents work, and forces a refresh only for exit sizing", async () => {
    // The shared fixture book shows every market the same levels, so the exit-depth floor is off here.
    const h = harness({ minExitDepth2cUsd: 0 });
    const original = h.adapter.executionMarket.getMockImplementation()!;
    h.adapter.executionMarket.mockImplementation(async (ref, outcome) => {
      const market = await original("yes", outcome);
      return ref === "yes" ? market : { ...market, marketRef: ref, tokenId: `${ref}-yes`, conditionId: `condition-${ref}` };
    });
    const signals: Signal[] = ["yes", "m2", "m3"].map(ref => ({ id: `signal-${ref}`, marketRef: ref, venue: "polymarket", side: "YES", prob: .76, refPrice: .55, ts: new Date(NOW).toISOString(), ttlSec: 10800 }));
    const held: Position[] = Array.from({ length: 8 }, (_, index) => ({ marketRef: `held-${index}`, tokenId: `held-${index}-yes`, conditionId: `condition-held-${index}`, outcome: "YES", side: "YES", size: 10, avgPrice: .4 }));
    h.adapter.positions.mockImplementation(async () => held);
    await h.executor.supervise({ signals, refreshedAt: h.now() });
    for (const ref of ["yes", "m2", "m3"]) await h.executor.admit(enter({ marketRef: ref }), []);
    expect(h.submissions).toHaveLength(3);
    h.adapter.positions.mockClear(); h.adapter.balances.mockClear(); h.adapter.tokenBalance.mockClear();
    h.advance(5000); await h.executor.supervise({ signals, refreshedAt: h.now() });
    expect(h.adapter.positions).toHaveBeenCalledTimes(1);
    expect(h.adapter.balances).toHaveBeenCalledTimes(1);
    expect(h.adapter.tokenBalance).toHaveBeenCalledTimes(3);
    expect(h.adapter.tokenBalance.mock.calls.every(call => call[2] === undefined)).toBe(true);
    h.setHeld(100, "yes"); h.adapter.tokenBalance.mockClear();
    await h.executor.admit({ kind: "exit", marketRef: "yes", urgent: true }, h.positions());
    await h.settleCancel(); h.advance(5000); await h.executor.supervise({ signals, refreshedAt: h.now() });
    expect(h.adapter.tokenBalance.mock.calls.some(call => call[1] === "yes" && (call[2] as { refresh?: boolean } | undefined)?.refresh === true)).toBe(true);
  });

  it("invalidates the venue token balance after a confirmed fill", async () => {
    const h = harness(); const invalidate = vi.fn(); Object.assign(h.adapter, { invalidateTokenBalance: invalidate });
    await h.ready(); await h.executor.admit(enter(), []);
    h.fill("order-1", 20); await h.executor.supervise();
    expect(invalidate).toHaveBeenCalledWith("yes");
  });

  it("defaults the crossing window to sixty seconds and allows disabling it", () => {
    expect(PredictionExecutionConfigSchema.parse({})).toMatchObject({ entryDeadlineSec: 120, entryCrossingSec: 60, exitPassiveSec: 60 });
    expect(PredictionExecutionConfigSchema.parse({ entryCrossingSec: 0 }).entryCrossingSec).toBe(0);
    expect(() => PredictionExecutionConfigSchema.parse({ entryCrossingSec: -1 })).toThrow();
  });

  it("ignores a legacy account halt and blocked parent persisted by an earlier runtime", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    const checkpoint = JSON.parse((await h.state.get(PREDICTION_EXECUTION_KEY))!);
    checkpoint.haltReason = "ambiguous submission prediction:limits:1:child:2; reconciliation required";
    checkpoint.parents["prediction:limits:1"].status = "blocked";
    await h.state.set(PREDICTION_EXECUTION_KEY, JSON.stringify(checkpoint));
    h.advance(5000); await h.restart().recover();
    expect(h.log.warn).toHaveBeenCalledWith("legacy prediction halt ignored; execution resolves per market", { reason: checkpoint.haltReason });
    expect((await h.executor.snapshot()).blocked).toBe(false);
    expect((await h.executor.snapshot()).haltReason).toBeUndefined();
    expect((await h.executor.snapshot()).parents[0]!.status).toBe("active");
    await h.executor.supervise();
    expect(h.orders.size).toBe(1);
  });

  it("pins a contradictory settlement to its own order and keeps other parents working", async () => {
    const h = harness({ minExitDepth2cUsd: 0 });
    const original = h.adapter.executionMarket.getMockImplementation()!;
    h.adapter.executionMarket.mockImplementation(async (ref, outcome) => {
      const market = await original("yes", outcome);
      return ref === "yes" ? market : { ...market, marketRef: ref, tokenId: `${ref}-yes`, conditionId: `condition-${ref}` };
    });
    const signals: Signal[] = ["yes", "m2"].map(ref => ({ id: `signal-${ref}`, marketRef: ref, venue: "polymarket", side: "YES", prob: .76, refPrice: .55, ts: new Date(NOW).toISOString(), ttlSec: 10800 }));
    await h.executor.supervise({ signals, refreshedAt: h.now() });
    for (const ref of ["yes", "m2"]) await h.executor.admit(enter({ marketRef: ref }), []);
    expect(h.submissions).toHaveLength(2);
    // A settlement on order-1 that names the wrong token cannot be applied; only that parent stops.
    h.fills.push({ id: "bad", orderId: "order-1", makerOrderId: "order-1", marketRef: "yes", tokenId: "no", conditionId: "condition", outcome: "YES", side: "BUY", size: 1, matchedAmountDelta: 1, price: .59, ts: h.now(), fee: 0, settlementStatus: "CONFIRMED" });
    h.advance(5000); await h.executor.supervise({ signals, refreshedAt: h.now() });
    expect(h.log.warn).toHaveBeenCalledWith("prediction settlement inconsistent with its order", expect.objectContaining({ orderId: "order-1" }));
    const parents = (await h.executor.snapshot()).parents;
    expect(parents.find(p => p.marketRef === "yes")!.status).toBe("canceling");
    expect(parents.find(p => p.marketRef === "m2")!.status).toBe("active");
    expect(h.orders.has("order-2")).toBe(true);
    expect((await h.executor.snapshot()).blocked).toBe(false);
  });

  it("names the reason each time an entry is refused, once per market until it changes", async () => {
    const h = harness();
    expect(await h.executor.admit(enter(), [])).toEqual({ placed: false });
    expect(h.log.warn).toHaveBeenCalledWith("enter refused for yes: no refreshed signals yet");
    await h.executor.admit(enter(), []);
    expect(h.log.warn.mock.calls.filter(([message]) => String(message).startsWith("enter refused for yes"))).toHaveLength(1);
    await h.ready(); h.setVolume(10);
    expect(await h.executor.admit(enter(), [])).toEqual({ placed: false });
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringMatching(/^enter refused for yes: capacity: 24h volume/));
    h.setVolume(100_000);
    await h.executor.admit(enter(), []);
    expect(h.submissions).toHaveLength(1);
    expect((await h.executor.snapshot()).blocked).toBe(false);
  });

  it("uses the top-level strategy tick cadence when checking exit-assessment freshness", async () => {
    const h = harness({ tickIntervalMin: 1 }); h.config.tickIntervalMin = .25; h.setHeld(100); await h.ready();
    await h.executor.admit({ kind: "exit", marketRef: "yes" }, h.positions());
    h.advance(60000); await h.executor.supervise(); await h.settleCancel(); h.advance(10000);
    await h.executor.supervise({ exitDecisions: { yes: "normal" }, exitsEvaluatedAt: NOW + 60000 });
    expect(h.submissions).toHaveLength(1);
    await h.executor.supervise({ exitDecisions: { yes: "normal" }, exitsEvaluatedAt: h.now() });
    expect(h.submissions[1]).toMatchObject({ tif: "FAK", postOnly: false });
  });
});

// packages/core/test/prediction-execution.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { PredictionExecutor, PREDICTION_EXECUTION_KEY, assertPredictionExecutionSettled } from "../src/engine/prediction-execution.js";
import { BotConfigSchema } from "../src/config.js";
import { MemoryStateStore } from "../src/state.js";
import type { Action, Fill, Order, OrderIntent, OrderLifecycleHooks, Position, PredictionExecutionMarket, PredictionOrderState, Signal, VenueAccount, VenueAdapter } from "../src/types.js";

const NOW = Date.UTC(2026, 8, 4, 12);
const ACCOUNT = { venue: "polymarket", funder: "wallet" } as VenueAccount;
const enter = (overrides: Partial<Extract<Action, { kind: "enter" }>> = {}): Extract<Action, { kind: "enter" }> => ({ kind: "enter", marketRef: "yes", side: "YES", notional: 60,
  provenance: { qHeld: .76, signalId: "signal-1", signalTs: new Date(NOW).toISOString() }, ...overrides });

function harness(strategy: Record<string, unknown> = {}) {
  let now = NOW, sequence = 0, bid = .5, ask = .6, cash = 10_000, volume = 100_000, stale = false, cancelRefused = false, missingStatus = false, lostAck = false, rejectOnce = false;
  const tokenHoldings = new Map<string, number>();
  const orders = new Map<string, Order>();
  const history = new Map<string, PredictionOrderState>();
  const fills: Fill[] = [];
  const confirmed = new Set<string>();
  const submissions: OrderIntent[] = [];
  const trace: string[] = [];
  const state = new MemoryStateStore();
  const config = BotConfigSchema.parse({ id: "limits", venue: "polymarket", strategy: { id: "signals", config: { allocationMode: "portfolio-kelly", ...strategy } } });
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const alerter = { send: vi.fn(async () => {}) };
  const signal = (side: "YES" | "NO" = "YES"): Signal => ({ id: "signal-1", marketRef: "yes", venue: "polymarket", side, prob: .76, refPrice: .55, ts: new Date(NOW).toISOString(), ttlSec: 10800 });
  const positions = (): Position[] => [...tokenHoldings].filter(([, qty]) => qty > 0).map(([token, qty]) => ({ marketRef: "yes", tokenId: token, conditionId: "condition", side: token === "no" ? "NO" : "YES", outcome: token === "no" ? "NO" : "YES", size: qty, avgPrice: .51, currentPrice: bid }));
  const market = (_ref: string, outcome: "YES" | "NO"): PredictionExecutionMarket => {
    const token = outcome === "YES" ? "yes" : "no";
    // The book contains our own live orders in addition to external liquidity.
    const bids = [{ price: bid, size: 10000 }], asks = [{ price: ask, size: 10000 }];
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
      history.set(id, { orderId: id, status: intent.tif === "FAK" ? "canceled" : "open", size: intent.size, matchedSize: 0, observedAt: now });
      if (intent.tif !== "FAK") orders.set(id, { id, clientId: intent.clientId, marketRef: intent.marketRef, tokenId: intent.tokenId, conditionId: intent.conditionId, outcome: intent.outcome,
        side: intent.side, size: intent.size, filledSize: 0, price: intent.limitPrice, status: "open", createdAt: now });
      if (lostAck) throw new Error("POST timed out after venue accepted order");
      return { orderId: id, status: "open" as const, clientId: intent.clientId };
    }),
  };
  const deps = { botId: "limits", adapter: adapter as unknown as VenueAdapter, account: ACCOUNT, state, config, log, alerter, now: () => now };
  let executor = new PredictionExecutor(deps);
  async function ready(side: "YES" | "NO" = "YES") { await executor.supervise({ signals: [signal(side)], refreshedAt: now }); }
  function fill(orderId: string, quantity: number, status: NonNullable<Fill["settlementStatus"]> = "CONFIRMED", id = `trade-${fills.length}`) {
    const order = orders.get(orderId);
    const submissionIndex = Number(orderId.split("-")[1]) - 1;
    const intent = submissions[submissionIndex]!;
    const previous = fills.find(f => f.id === id && f.orderId === orderId);
    if (previous) previous.settlementStatus = status;
    else {
      fills.push({ id, orderId, makerOrderId: intent.postOnly ? orderId : undefined, marketRef: intent.marketRef, tokenId: intent.tokenId,
        conditionId: intent.conditionId, outcome: intent.outcome, side: intent.side, size: quantity, matchedAmountDelta: quantity, price: intent.limitPrice, ts: now, fee: 0, settlementStatus: status });
      history.get(orderId)!.matchedSize += quantity;
      if (order) order.filledSize += quantity;
    }
    if (status === "CONFIRMED" && !confirmed.has(`${id}:${orderId}`)) {
      confirmed.add(`${id}:${orderId}`);
      tokenHoldings.set(intent.tokenId!, (tokenHoldings.get(intent.tokenId!) ?? 0) + (intent.side === "BUY" ? quantity : -quantity));
      cash += (intent.side === "BUY" ? -1 : 1) * quantity * intent.limitPrice;
    }
    if (history.get(orderId)!.matchedSize >= intent.size) { history.get(orderId)!.status = "matched"; orders.delete(orderId); }
  }
  return { adapter, state, submissions, orders, history, fills, trace, config, log, alerter, positions, ready, fill, market,
    get executor() { return executor; }, now: () => now, advance: (ms: number) => { now += ms; },
    restart: () => { executor = new PredictionExecutor(deps); return executor; },
    setBook: (nextBid: number, nextAsk: number) => { bid = nextBid; ask = nextAsk; },
    setHeld: (qty: number, token = "yes") => { tokenHoldings.set(token, qty); },
    setCash: (value: number) => { cash = value; }, setVolume: (value: number) => { volume = value; },
    stale: () => { stale = true; }, refuseCancel: () => { cancelRefused = true; }, allowCancel: () => { cancelRefused = false; },
    hideStatus: () => { missingStatus = true; }, loseAck: () => { lostAck = true; }, rejectOnce: () => { rejectOnce = true; },
    async settleCancel() { now += 5000; await executor.supervise(); now += 5000; await executor.supervise(); },
  };
}

describe("adaptive prediction execution", () => {
  afterEach(() => { vi.useRealTimers(); });
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
    expect(h.submissions[0]).toMatchObject({ size: 100, limitPrice: .51, postOnly: true, tif: "GTC" });
    h.advance(10000); await h.executor.supervise();
    expect(h.submissions).toHaveLength(1);
    h.advance(20000); await h.executor.supervise();
    expect(h.orders.size).toBe(0); expect(h.submissions).toHaveLength(1);
    h.advance(5000); await h.executor.supervise();
    expect(h.submissions).toHaveLength(1);
    h.advance(5000); await h.executor.supervise();
    expect(h.submissions[1]).toMatchObject({ limitPrice: .55, size: 100, postOnly: true });
    expect(h.trace).toEqual(["place:order-1", "cancel:order-1", "place:order-2"]);
  });

  it("keeps partial fills and unconfirmed matches reserved until cancellation settles", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.fill("order-1", 20, "MATCHED", "trade-a");
    h.advance(30000); await h.executor.supervise();
    await h.settleCancel();
    expect(h.submissions).toHaveLength(1);
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ filledSize: 0, reservedNotionalUsd: 60 });
    h.fill("order-1", 20, "CONFIRMED", "trade-a");
    h.advance(5000); await h.executor.supervise();
    expect(h.submissions[1]).toMatchObject({ size: 80, limitPrice: .55 });
    const p = (await h.executor.snapshot()).parents[0]!;
    expect(p.filledSize).toBe(20); expect(p.filledNotionalUsd).toBeCloseTo(10.2); expect(p.reservedNotionalUsd).toBeCloseTo(48);
    await h.executor.supervise();
    expect((await h.executor.snapshot()).dailySpentUsd["2026-09-04"]).toBeCloseTo(10.2);
  });

  it("cancels after 120 seconds without turning the entry into a taker", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
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
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
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

  it("quarantines a lost POST acknowledgement across restart instead of repeating the order", async () => {
    const h = harness(); await h.ready(); h.loseAck(); await h.executor.admit(enter(), []);
    expect((await h.executor.snapshot()).blocked).toBe(true);
    h.advance(10000); await h.restart().recover(); await h.executor.supervise();
    expect(h.submissions).toHaveLength(1); expect((await h.executor.snapshot()).parents[0]!.reservedNotionalUsd).toBe(60);
  });

  it("can retry a definitive post-only rejection without treating it as an ambiguous fill", async () => {
    const h = harness(); await h.ready(); h.rejectOnce(); await h.executor.admit(enter(), []);
    expect((await h.executor.snapshot()).blocked).toBe(false);
    h.advance(5000); await h.executor.supervise(); expect(h.submissions).toHaveLength(1);
  });

  it("uses the actual NO book and never exceeds its admission price and budget", async () => {
    const h = harness(); await h.ready("NO"); await h.executor.admit(enter({ side: "NO" }), []);
    expect(h.submissions[0]).toMatchObject({ tokenId: "no", outcome: "NO", limitPrice: .51 });
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
    h.fill("order-1", 10, "CONFIRMED", "same-trade"); h.advance(30000); await h.executor.supervise(); await h.settleCancel();
    h.fill("order-2", 10, "CONFIRMED", "same-trade"); await h.executor.supervise();
    expect((await h.executor.snapshot()).parents[0]!.filledSize).toBe(20);
  });

  it("fails closed on unowned resting orders and refuses startup adoption by matching terms", async () => {
    const h = harness(); h.orders.set("legacy", { id: "legacy", marketRef: "yes", side: "BUY", size: 100, filledSize: 0, price: .51, status: "open" });
    await h.ready(); expect((await h.executor.snapshot()).blocked).toBe(true);
    expect(await h.executor.admit(enter(), [])).toEqual({ placed: false }); expect(h.submissions).toHaveLength(0);
  });

  it("keeps the shutdown latch permanent against delayed supervise calls and admissions", async () => {
    const h = harness(); await h.ready(); await h.executor.beginShutdown();
    await h.executor.supervise({ paused: false });
    expect(await h.executor.admit(enter(), [])).toEqual({ placed: false }); expect(h.submissions).toHaveLength(0);
  });

  it("heartbeat failure cancels the venue without waiting for the serialized execution lane", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.adapter.heartbeat.mockRejectedValueOnce(new Error("heartbeat lost"));
    await expect(h.executor.heartbeat()).rejects.toThrow("heartbeat lost");
    expect(h.adapter.cancelAll).toHaveBeenCalledTimes(1);
    expect((await h.executor.snapshot()).blocked).toBe(true);
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
    const h = harness({ signalPollIntervalMin: 1 }); await h.ready(); await h.executor.admit(enter(), []);
    h.advance(120000); await h.executor.supervise(); await h.settleCancel();
    expect(await h.executor.admit(enter(), [])).toEqual({ placed: false });
    await h.ready(); expect(await h.executor.admit(enter(), [])).toHaveProperty("executionId");
  });

  it("advances the settlement scan window after terminal reconciliation but keeps an overlap", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
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

  it("permits explicit resume after a known heartbeat halt is canceled and settled, while unknown POST stays blocked", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.adapter.heartbeat.mockRejectedValueOnce(new Error("temporary outage")); await expect(h.executor.heartbeat()).rejects.toThrow();
    await h.settleCancel(); await h.executor.resume();
    expect((await h.executor.snapshot()).blocked).toBe(false);
    const unknown = harness(); await unknown.ready(); unknown.loseAck(); await unknown.executor.admit(enter(), []);
    await expect(unknown.executor.resume()).rejects.toThrow("unresolved");
  });

  it("allows a five-second cold positions snapshot during resume and rechecks open orders before admitting entries", async () => {
    vi.useFakeTimers();
    const h = harness(); await h.ready(); await h.executor.supervise({ paused: true });
    const orderReadTimes: number[] = [];
    h.adapter.openOrders.mockImplementation(async () => { orderReadTimes.push(h.now()); return []; });
    h.adapter.positions.mockImplementationOnce(() => new Promise(resolve => { setTimeout(() => resolve([]), 5000); }));
    let settled = false;
    const outcome = h.executor.resume().then(() => { settled = true; return undefined; }, error => { settled = true; return error as Error; });
    await vi.advanceTimersByTimeAsync(0);
    h.advance(4000); await vi.advanceTimersByTimeAsync(4000);
    expect(settled).toBe(false);
    expect(h.submissions).toHaveLength(0);
    h.advance(1000); await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBeUndefined();
    expect(orderReadTimes.at(-1)).toBe(h.now());
    expect(orderReadTimes.some(time => time < h.now())).toBe(true);
    expect(await h.executor.admit(enter(), [])).toHaveProperty("executionId");
    expect(h.submissions).toHaveLength(1);
    expect(h.submissions[0]).toMatchObject({ side: "BUY", postOnly: true });
  });

  it("times out a never-resolving resume positions snapshot at thirty seconds and leaves entries paused", async () => {
    vi.useFakeTimers();
    const h = harness(); await h.ready(); await h.executor.supervise({ paused: true });
    h.adapter.positions.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const outcome = h.executor.resume().then(() => { settled = true; return undefined; }, error => { settled = true; return error as Error; });
    await vi.advanceTimersByTimeAsync(0);
    h.advance(29999); await vi.advanceTimersByTimeAsync(29999);
    expect(settled).toBe(false);
    expect(h.submissions).toHaveLength(0);
    h.advance(1); await vi.advanceTimersByTimeAsync(1);
    expect((await outcome)?.message).toMatch(/resume account snapshot exceeded/);
    expect(await h.executor.admit(enter(), [])).toEqual({ placed: false });
    expect(h.adapter.placeOrderWithLifecycle).not.toHaveBeenCalled();
    expect(h.orders.size).toBe(0);
  });

  it("does not invent inventory from failed settlement and safely retries only the remaining target", async () => {
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.fill("order-1", 20, "MATCHED", "failed-trade"); h.advance(30000); await h.executor.supervise(); await h.settleCancel();
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

  it.each(["book", "order"] as const)("bounds a never-resolving %s read and cancels without replacing", async resource => {
    vi.useFakeTimers();
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []); h.advance(5000);
    if (resource === "book") h.adapter.executionMarket.mockImplementationOnce(() => new Promise(() => {}));
    else h.adapter.executionOrder.mockImplementationOnce(() => new Promise(() => {}));
    const outcome = h.executor.supervise().then(() => undefined, error => error as Error);
    await vi.advanceTimersByTimeAsync(0); h.advance(4000); await vi.advanceTimersByTimeAsync(4000);
    const error = await outcome;
    if (resource === "order") expect(error?.message).toMatch(/order state exceeded four seconds/);
    else expect(error).toBeUndefined();
    expect(h.orders.size).toBe(0);
    expect(h.submissions).toHaveLength(1);
    expect((await h.executor.snapshot()).parents[0]).toMatchObject({ status: "canceling", filledSize: 0, reservedNotionalUsd: 60 });
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

  it("suppresses subsequent heartbeats even when emergency cancellation never resolves", async () => {
    vi.useFakeTimers();
    const h = harness(); await h.ready(); await h.executor.admit(enter(), []);
    h.adapter.cancelAll.mockImplementation(() => new Promise(() => {}));
    h.advance(11000);
    const heartbeatsBefore = h.adapter.heartbeat.mock.calls.length;
    const outcome = h.executor.heartbeat().catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(0); h.advance(4000); await vi.advanceTimersByTimeAsync(4000);
    expect((await outcome as Error).message).toContain("ten-second freshness");
    expect(await h.executor.heartbeat()).toBe(false);
    h.advance(20000); expect(await h.executor.heartbeat()).toBe(false);
    expect(h.adapter.heartbeat).toHaveBeenCalledTimes(heartbeatsBefore);
    expect((await h.executor.snapshot()).blocked).toBe(true);
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
      h.advance(11000);
      await expect(h.executor.heartbeat()).rejects.toThrow("ten-second freshness");
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
    expect(h.alerter.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "entry", data: expect.objectContaining({ orderId: "order-1", maker: true }) }));
    await h.executor.supervise(); await h.restart().recover();
    expect(h.alerter.send).toHaveBeenCalledTimes(1);
    const metrics = (await h.executor.snapshot()).parents[0]!.metrics!;
    expect(metrics.makerShare).toBe(1); expect(metrics.fillRatio).toBe(.2); expect(metrics.priceImprovementUsd).toBeCloseTo(1.8);
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

  it("refuses a strategy switch after an unknown POST even when emergency cancellation removed every visible order", async () => {
    const h = harness(); await h.ready(); h.loseAck(); await h.executor.admit(enter(), []);
    expect(h.orders.size).toBe(0);
    await expect(assertPredictionExecutionSettled(h.state)).rejects.toThrow("unresolved adaptive prediction execution");
    h.advance(10000); await h.restart().recover();
    await expect(assertPredictionExecutionSettled(h.state)).rejects.toThrow("unresolved adaptive prediction execution");
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

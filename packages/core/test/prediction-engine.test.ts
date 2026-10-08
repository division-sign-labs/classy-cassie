// packages/core/test/prediction-engine.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  MemoryStateStore, StateKeys, parseBotConfig, silentLogger,
  type Fill, type Order, type OrderAck, type OrderBook, type OrderIntent, type OrderLifecycleHooks,
  type Position, type PredictionExecutionMarket, type PredictionOrderState, type Signal, type SignalSource,
  type VenueAccount, type VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import { Engine } from "../src/engine/engine.js";
import { FlipFlatStrategy } from "../../../strategies/flip-flat/dist/index.js";

const START = Date.parse("2026-09-04T12:00:00Z");
const ACCOUNT: VenueAccount = { venue: "polymarket", signerAddress: "0x01", funder: "0x02", signatureType: 3 };

/** Full account simulation: a match changes cash/inventory only when its CONFIRMED record is exposed. */
class PredictionVenue implements VenueAdapter {
  readonly id = "polymarket" as const;
  readonly verifiedAgainst = "2026-09-04";
  readonly placements: Array<{ orderId: string; intent: OrderIntent }> = [];
  readonly events: string[] = [];
  readonly marketsRead: string[] = [];
  readonly orders = new Map<string, { intent: OrderIntent; matched: number; status: "open" | "matched" | "canceled"; createdAt: number }>();
  readonly holdings = new Map<string, Position>();
  readonly settlements: Fill[] = [];
  cash = 1000;
  hidePositions = false;
  fakFillLimit = Infinity;
  readonly prices = { YES: { bid: 0.48, ask: 0.52 }, NO: { bid: 0.24, ask: 0.28 } };

  constructor(private readonly clock: { now: number }) {}
  async setup(): Promise<VenueAccount> { return ACCOUNT; }
  async fundingInstructions() { return { venue: this.id, addresses: [], summary: "fixture" }; }
  async awaitFunding() { return { asset: "pUSD", total: this.cash, available: this.cash }; }
  async balances() { return [{ asset: "pUSD", total: this.cash, available: this.cash }]; }
  async positions() { return this.hidePositions ? [] : [...this.holdings.values()].filter(position => position.size > 0).map(position => ({ ...position })); }
  async eventRef(marketRef: string) { return `event:${marketRef}`; }
  normalizeOrderSize(size: number) { return Math.floor((size + 1e-10) * 100) / 100; }
  async tokenBalance(_account: VenueAccount, tokenId: string) { return this.holdings.get(tokenId)?.size ?? 0; }
  async heartbeat() { this.events.push("heartbeat"); }

  async executionMarket(marketRef: string, outcome: "YES" | "NO"): Promise<PredictionExecutionMarket> {
    this.marketsRead.push(outcome);
    const tokenId = `${marketRef}:${outcome}`;
    const { bid, ask } = this.prices[outcome];
    const book: OrderBook = { marketRef, bids: [{ price: bid, size: 100000 }], asks: [{ price: ask, size: 100000 }], ts: this.clock.now };
    for (const order of this.orders.values()) {
      if (order.status !== "open" || order.intent.tokenId !== tokenId) continue;
      const levels = order.intent.side === "BUY" ? book.bids : book.asks;
      const level = levels.find(row => row.price === order.intent.limitPrice);
      if (level) level.size += order.intent.size - order.matched;
      else levels.push({ price: order.intent.limitPrice, size: order.intent.size - order.matched });
    }
    book.bids.sort((a, b) => b.price - a.price);
    book.asks.sort((a, b) => a.price - b.price);
    return { marketRef, tokenId, conditionId: `condition:${marketRef}`, outcome, tickSize: 0.01, minOrderSize: 1,
      acceptingOrders: true, observedAt: this.clock.now, book,
      quote: { marketRef, bid: book.bids[0]!.price, ask: book.asks[0]!.price, mid: (book.bids[0]!.price + book.asks[0]!.price) / 2,
        volume24h: 100000, spreadBps: (ask - bid) / ((bid + ask) / 2) * 10000, ts: this.clock.now } };
  }
  async book(marketRef: string) { return (await this.executionMarket(marketRef, "YES")).book; }
  async quote(marketRef: string) { return (await this.executionMarket(marketRef, "YES")).quote; }

  async placeOrderWithLifecycle(account: VenueAccount, intent: OrderIntent, hooks: OrderLifecycleHooks): Promise<OrderAck> {
    await hooks.onPrepared({ preparedHash: `prepared-${this.placements.length + 1}`, tokenId: intent.tokenId!, conditionId: intent.conditionId, outcome: intent.outcome });
    return this.placeOrder(account, intent);
  }
  async placeOrder(_account: VenueAccount, original: OrderIntent): Promise<OrderAck> {
    const outcome = original.outcome ?? "YES";
    const intent: OrderIntent = { ...original, tokenId: original.tokenId ?? `${original.marketRef}:${outcome}`, conditionId: `condition:${original.marketRef}`, outcome };
    const { bid, ask } = this.prices[outcome];
    const crossing = intent.side === "BUY" ? intent.limitPrice >= ask : intent.limitPrice <= bid;
    if (intent.postOnly && crossing) throw Object.assign(new Error("post-only crosses"), { submissionRejected: true, postOnlyRejected: true });
    const orderId = `order-${this.placements.length + 1}`;
    this.placements.push({ orderId, intent });
    this.events.push(`place:${orderId}:${intent.side}:${intent.tif}`);
    this.orders.set(orderId, { intent, matched: 0, status: "open", createdAt: this.clock.now });
    if (crossing) this.confirm(orderId, intent.tif === "FAK" ? Math.min(intent.size, this.fakFillLimit) : intent.size, intent.side === "BUY" ? ask : bid);
    else if (intent.tif === "FAK") this.orders.get(orderId)!.status = "canceled";
    const matched = this.orders.get(orderId)!.matched;
    if (intent.tif === "FAK" && matched < intent.size) this.orders.get(orderId)!.status = "canceled";
    return { orderId, clientId: intent.clientId, tokenId: intent.tokenId, status: matched === intent.size ? "filled" : "open",
      ...(matched > 0 ? { filledSize: matched, avgFillPrice: intent.side === "BUY" ? ask : bid } : {}) };
  }

  confirm(orderId: string, quantity: number, price?: number) {
    const order = this.orders.get(orderId)!;
    if (!(quantity > 0) || quantity > order.intent.size - order.matched + 1e-8) throw new Error("invalid fixture match quantity");
    const intent = order.intent;
    const fillPrice = price ?? intent.limitPrice;
    const current = this.holdings.get(intent.tokenId!);
    const oldSize = current?.size ?? 0;
    const nextSize = intent.side === "BUY" ? oldSize + quantity : oldSize - quantity;
    if (nextSize < -1e-8) throw new Error("fixture oversell");
    this.cash += (intent.side === "BUY" ? -1 : 1) * quantity * fillPrice;
    this.holdings.set(intent.tokenId!, {
      marketRef: intent.marketRef, tokenId: intent.tokenId, conditionId: intent.conditionId, outcome: intent.outcome,
      side: intent.outcome!, size: Math.max(0, nextSize), avgPrice: intent.side === "BUY" ? (oldSize * (current?.avgPrice ?? 0) + quantity * fillPrice) / nextSize : current!.avgPrice,
    });
    order.matched += quantity;
    if (order.matched + 1e-8 >= intent.size) order.status = "matched";
    this.settlements.push({ id: `fill-${this.settlements.length + 1}`, orderId, ...(intent.postOnly ? { makerOrderId: orderId } : {}),
      marketRef: intent.marketRef, tokenId: intent.tokenId, conditionId: intent.conditionId, outcome: intent.outcome, side: intent.side,
      size: quantity, matchedAmountDelta: quantity, price: fillPrice, ts: this.clock.now, settlementStatus: "CONFIRMED", fee: 0 });
  }
  async executionOrder(_account: VenueAccount, orderId: string): Promise<PredictionOrderState | null> {
    const order = this.orders.get(orderId);
    return order ? { orderId, status: order.status, size: order.intent.size, matchedSize: order.matched, observedAt: this.clock.now } : null;
  }
  async openOrders(): Promise<Order[]> {
    return [...this.orders].filter(([, order]) => order.status === "open").map(([id, order]) => ({
      id, marketRef: order.intent.marketRef, tokenId: order.intent.tokenId, conditionId: order.intent.conditionId, outcome: order.intent.outcome,
      side: order.intent.side, size: order.intent.size, filledSize: order.matched, price: order.intent.limitPrice,
      status: order.matched > 0 ? "partial" : "open", createdAt: order.createdAt,
    }));
  }
  async fills(_account: VenueAccount, sinceTs: number) { return this.settlements.filter(fill => fill.ts >= sinceTs); }
  async tradeSettlements(account: VenueAccount, sinceTs: number) { return this.fills(account, sinceTs); }
  async cancelOrderChecked(_account: VenueAccount, orderId: string): Promise<{ status: "canceled" | "not-canceled"; reason?: string }> {
    const order = this.orders.get(orderId);
    if (!order || order.status === "matched") return { status: "not-canceled", reason: "missing or matched" };
    order.status = "canceled";
    this.events.push(`cancel:${orderId}`);
    return { status: "canceled" };
  }
  async cancelOrder(account: VenueAccount, orderId: string) {
    if ((await this.cancelOrderChecked(account, orderId)).status !== "canceled") throw new Error("unconfirmed cancellation");
  }
  async cancelAll(account: VenueAccount) {
    for (const order of await this.openOrders()) await this.cancelOrder(account, order.id);
  }
}

function harness(options: { side?: "YES" | "NO"; legacy?: boolean; maxHoldDays?: number; entryCrossingSec?: number } = {}) {
  const clock = { now: START };
  const venue = new PredictionVenue(clock);
  const side = options.side ?? "YES";
  const mid = side === "YES" ? .5 : .26;
  const published: Signal[] = [{ id: "signal-a", ts: new Date(START).toISOString(), venue: "polymarket", marketRef: "a", side,
    prob: mid + .2, refPrice: mid, spreadPp: 20, ttlSec: 3600 }];
  let refreshedAt = START;
  const signals: SignalSource = { latest: async () => published, refreshedAt: () => refreshedAt };
  const state = new MemoryStateStore();
  const config = parseBotConfig({ id: "prediction-engine", venue: "polymarket",
    // These cases exercise the post-only phase, which is off by default.
    execution: { entryDeadlineSec: 120, ...(options.legacy ? { mode: "legacy" } : {}), ...(options.entryCrossingSec !== undefined ? { entryCrossingSec: options.entryCrossingSec } : {}) },
    strategy: { id: "flip-flat", config: { allocationMode: "portfolio-kelly", minExitDepth2cUsd: 0, maxHoldDays: options.maxHoldDays ?? null,
      signalPollIntervalMin: 1 } },
    risk: { slippagePct: 10, depthCapPct: 100, minViableNotional: 1, maxOrderNotional: 1000 },
  });
  const createEngine = () => new Engine({ botId: config.id, config, adapter: venue, account: ACCOUNT, strategy: new FlipFlatStrategy(), signals,
    state, alerter: { send: async () => undefined }, log: silentLogger, now: () => clock.now });
  return { clock, venue, published, state, engine: createEngine(), createEngine,
    refresh: () => { refreshedAt = clock.now; },
    advance: async (engine: Engine, milliseconds = 5000) => { clock.now += milliseconds; await engine.supervisePredictions(); },
  };
}

describe("Engine adaptive prediction wiring", () => {
  it("sizes from cash plus marked deployed equity even when unrealized P&L is omitted", async () => {
    const h = harness(); h.venue.cash = 400;
    h.venue.holdings.set("held:YES", { marketRef: "held", tokenId: "held:YES", conditionId: "condition:held",
      side: "YES", size: 1000, avgPrice: .9, currentPrice: .6 });
    const ctx = await h.engine.strategyContext();
    expect(ctx.equity).toBe(1000);
    await h.engine.tick(1);
    const parent = (await h.engine.predictionStatus())!.parents.find(p => p.side === "BUY")!;
    expect(parent.provenance).toMatchObject({ equityUsd: 1000, targetUsd: expect.closeTo(100), eventCapUsd: 50 });
    expect(parent.reservedNotionalUsd).toBeCloseTo(50, 1);
  });

  it("continues new entries while redemption confirmation is slow, and does not resubmit", async () => {
    const h = harness();
    let release!: (value: { transactionHash: string }) => void;
    const redeem = vi.fn(async (_a, _p, hooks) => {
      await hooks.beforeSubmit(); await hooks.submitted({ transactionId: "pending-redemption" });
      return await new Promise<{ transactionHash: string }>(resolve => { release = resolve; });
    });
    Object.assign(h.venue, { redeem });
    h.venue.holdings.set("settled:YES", { marketRef: "settled", tokenId: "settled:YES", conditionId: "settled-condition",
      side: "YES", size: 10, avgPrice: .7, currentPrice: 1, redeemable: true });
    expect((await h.engine.tick(1)).errors).toBe(0);
    expect(h.venue.placements).toHaveLength(1);
    expect(redeem).toHaveBeenCalledOnce();
    h.clock.now += 60_000; await h.engine.tick(2);
    expect(redeem).toHaveBeenCalledOnce();
    release({ transactionHash: "confirmed" });
    h.clock.now += 60_000; await h.engine.tick(3);
    expect(redeem).toHaveBeenCalledOnce();
  });

  it("drains a pending redemption before its state can be closed", async () => {
    const h = harness(); let release!: (value: { transactionHash: string }) => void;
    const redeem = vi.fn(async (_a, _p, hooks) => {
      await hooks.beforeSubmit(); await hooks.submitted({ transactionId: "pending-redemption" });
      return new Promise<{ transactionHash: string }>(resolve => { release = resolve; });
    });
    Object.assign(h.venue, { redeem });
    h.venue.holdings.set("settled:YES", { marketRef: "settled", tokenId: "settled:YES", conditionId: "settled-condition",
      side: "YES", size: 10, avgPrice: .7, currentPrice: 1, redeemable: true });
    await h.engine.tick(1);
    let drained = false;
    const draining = h.engine.drainRedemptions().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    release({ transactionHash: "confirmed" }); await draining;
    expect(JSON.parse((await h.state.get("engine:redemption:settled-condition"))!).status).toBe("confirmed");
    h.venue.holdings.set("another:YES", { marketRef: "another", tokenId: "another:YES", conditionId: "another-condition",
      side: "YES", size: 1, avgPrice: .7, currentPrice: 0, redeemable: true });
    h.clock.now += 60_000; await h.engine.tick(2);
    expect(redeem).toHaveBeenCalledOnce();
  });

  it("continues entries when one redemption fails", async () => {
    const h = harness();
    const redeem = vi.fn(async () => { throw new Error("relayer temporarily unavailable"); });
    Object.assign(h.venue, { redeem });
    h.venue.holdings.set("settled:YES", { marketRef: "settled", tokenId: "settled:YES", conditionId: "settled-condition",
      side: "YES", size: 10, avgPrice: .7, currentPrice: 0, redeemable: true });
    expect((await h.engine.tick(1)).errors).toBe(1);
    expect(h.venue.placements).toHaveLength(1);
    expect((await h.engine.predictionStatus())!.blocked).toBe(false);
  });

  it("redeems a resolved loser even when another market's order reconciliation fails", async () => {
    const h = harness(); await h.engine.tick(1);
    vi.spyOn(h.venue, "executionOrder").mockRejectedValue(new Error("order detail unavailable"));
    const redeem = vi.fn(async () => ({ transactionHash: "0xresolved" }));
    Object.assign(h.venue, { redeem });
    h.venue.holdings.set("settled:YES", { marketRef: "settled", tokenId: "settled:YES", conditionId: "settled-condition",
      side: "YES", size: 10, avgPrice: .7, currentPrice: 0, unrealizedPnl: -7, redeemable: true });
    h.clock.now += 60_000;
    const result = await h.engine.tick(2);
    expect(result.errors).toBe(0);
    expect((await h.engine.predictionStatus())!.blocked).toBe(false);
    expect(redeem).toHaveBeenCalledOnce();
    expect(h.venue.placements).toHaveLength(1);
  });
  it("defaults signals entries to a supervised maker parent and does not duplicate across ticks", async () => {
    const h = harness();
    expect(h.engine.adaptivePredictionExecution).toBe(true);
    expect((await h.engine.tick()).errors).toBe(0);
    expect(h.venue.placements).toHaveLength(1);
    expect(h.venue.placements[0]!.intent).toMatchObject({ side: "BUY", tif: "GTC", postOnly: true, limitPrice: .51 });
    await h.advance(h.engine);
    expect((await h.engine.tick()).errors).toBe(0);
    expect(h.venue.placements).toHaveLength(1);
    expect((await h.engine.predictionStatus())!.parents).toHaveLength(1);
    expect((await h.engine.strategyContext()).execution!.dailySpentUsd).toEqual({});
  });

  it("carries the actual NO token and its independent book through strategy, risk, and placement", async () => {
    const h = harness({ side: "NO" });
    expect((await h.engine.tick()).errors).toBe(0);
    expect(h.venue.placements).toHaveLength(1);
    expect(h.venue.placements[0]!.intent).toMatchObject({ tokenId: "a:NO", outcome: "NO", side: "BUY", limitPrice: .27, postOnly: true });
    expect(h.venue.marketsRead).not.toContain("YES");
  });

  it("cancels a partially filled entry before an urgent bounded exit sells confirmed inventory", async () => {
    const h = harness({ maxHoldDays: 2 / 86400 });
    await h.engine.tick();
    const entryId = h.venue.placements[0]!.orderId;
    h.clock.now += 5000;
    h.venue.confirm(entryId, 5);
    await h.engine.supervisePredictions();
    expect((await h.engine.tick()).errors).toBe(0);
    h.clock.now += 5000;
    expect((await h.engine.tick()).errors).toBe(0);
    for (let i = 0; i < 5 && h.venue.placements.every(order => order.intent.side !== "SELL"); i++) await h.advance(h.engine);
    const exit = h.venue.placements.find(order => order.intent.side === "SELL");
    expect(exit?.intent).toMatchObject({ side: "SELL", size: 5, tif: "FAK", postOnly: false, purpose: "urgent-exit" });
    expect(h.venue.events.indexOf(`cancel:${entryId}`)).toBeLessThan(h.venue.events.indexOf(`place:${exit!.orderId}:SELL:FAK`));
    expect(await h.venue.positions()).toEqual([]);
    expect(h.venue.placements.filter(order => order.intent.side === "BUY")).toHaveLength(1);
  });

  it("does not admit an expired signal even when the complete feed refresh succeeds", async () => {
    const h = harness();
    h.published[0]!.ts = new Date(START - 3601000).toISOString();
    expect((await h.engine.tick()).errors).toBe(0);
    expect(h.venue.placements).toEqual([]);
    expect((await h.engine.predictionStatus())!.parents).toEqual([]);
  });

  it("persists the signal-refresh restriction after the entry deadline and across restart", async () => {
    const h = harness({ entryCrossingSec: 0 });
    await h.engine.tick();
    await h.advance(h.engine, 120000);
    await h.advance(h.engine);
    await h.advance(h.engine);
    const restarted = h.createEngine();
    await restarted.recoverPredictions();
    h.clock.now = START + 301000;
    expect((await restarted.tick()).errors).toBe(0);
    expect(h.venue.placements).toHaveLength(1);
    h.refresh();
    expect((await restarted.tick()).errors).toBe(0);
    expect(h.venue.placements).toHaveLength(2);
  });

  it("retains crossing execution when legacy mode is explicit", async () => {
    const h = harness({ legacy: true });
    expect(h.engine.adaptivePredictionExecution).toBe(false);
    expect((await h.engine.tick()).errors).toBe(0);
    expect(h.venue.placements).toHaveLength(1);
    expect(h.venue.placements[0]!.intent.postOnly).not.toBe(true);
    expect(h.venue.placements[0]!.intent.limitPrice).toBeGreaterThanOrEqual(h.venue.prices.YES.ask);
    expect((await h.venue.positions())[0]!.size).toBeGreaterThan(0);
  });

  it("fires a NO stop on a falling held-token price and keeps the latch until settlement", async () => {
    const h = harness({ side: "NO" });
    h.venue.holdings.set("a:NO", { marketRef: "a", tokenId: "a:NO", conditionId: "condition:a", outcome: "NO", side: "NO", size: 10, avgPrice: .26 });
    await h.state.set(StateKeys.triggers, JSON.stringify([{ marketRef: "a", outcome: "NO", posSide: "NO", kind: "stop", level: .2, armedAt: START }]));
    await h.engine.checkTriggers();
    expect(h.venue.placements).toHaveLength(0);
    h.venue.prices.NO = { bid: .16, ask: .2 };
    await h.engine.checkTriggers();
    expect(h.venue.placements[0]?.intent).toMatchObject({ side: "SELL", outcome: "NO", tif: "FAK", size: 10 });
    expect(JSON.parse((await h.state.get(StateKeys.triggers))!)[0].firedAt).toBe(START);
    await h.engine.checkTriggers();
    expect(await h.engine.hasArmedTriggers()).toBe(true);
    await h.advance(h.engine);
    await h.advance(h.engine);
    await h.engine.checkTriggers();
    expect(await h.engine.hasArmedTriggers()).toBe(false);
  });

  it("retains a trigger before a resting entry fills, then exits authenticated inventory despite public lag", async () => {
    const h = harness();
    await h.engine.tick();
    // The fixture book shows our own resting maker order (one tick inside the ask) as the best bid.
    await h.state.set(StateKeys.triggers, JSON.stringify([{ marketRef: "a", outcome: "YES", posSide: "YES", kind: "stop", level: .51, armedAt: START }]));
    h.venue.hidePositions = true;
    await h.engine.checkTriggers();
    expect(await h.engine.hasArmedTriggers()).toBe(true);
    h.clock.now += 5000;
    h.venue.confirm(h.venue.placements[0]!.orderId, 5);
    await h.engine.supervisePredictions();
    h.venue.prices.YES = { bid: .46, ask: .5 };
    await h.engine.checkTriggers();
    expect(JSON.parse((await h.state.get(StateKeys.triggers))!)[0].firedAt).toBe(h.clock.now);
    for (let i = 0; i < 5 && h.venue.placements.length < 2; i++) await h.advance(h.engine);
    expect(h.venue.placements[1]?.intent).toMatchObject({ side: "SELL", size: 5, tif: "FAK" });
    expect(await h.venue.tokenBalance(ACCOUNT, "a:YES")).toBe(0);
  });

  it("retries a partially filled synthetic exit after the stop price rebounds and the process restarts", async () => {
    const h = harness();
    h.venue.holdings.set("a:YES", { marketRef: "a", tokenId: "a:YES", conditionId: "condition:a", outcome: "YES", side: "YES", size: 5, avgPrice: .5 });
    h.venue.prices.YES = { bid: .3, ask: .34 };
    h.venue.fakFillLimit = 2;
    await h.state.set(StateKeys.triggers, JSON.stringify([{ marketRef: "a", outcome: "YES", posSide: "YES", kind: "stop", level: .4, armedAt: START }]));
    await h.engine.checkTriggers();
    expect(await h.venue.tokenBalance(ACCOUNT, "a:YES")).toBe(3);
    await h.advance(h.engine);
    await h.advance(h.engine);
    h.venue.prices.YES = { bid: .6, ask: .64 };
    const restarted = h.createEngine();
    await restarted.recoverPredictions();
    await h.advance(restarted, 301000);
    h.venue.fakFillLimit = Infinity;
    await restarted.checkTriggers();
    expect(h.venue.placements[1]?.intent).toMatchObject({ side: "SELL", size: 3, tif: "FAK" });
    expect(await h.venue.tokenBalance(ACCOUNT, "a:YES")).toBe(0);
  });
});

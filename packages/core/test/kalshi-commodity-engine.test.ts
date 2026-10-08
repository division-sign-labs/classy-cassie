// packages/core/test/kalshi-commodity-engine.test.ts
import { describe, expect, it } from "vitest";
import { MemoryStateStore } from "../src/state.js";
import { BotConfigSchema } from "../src/config.js";
import { Engine } from "../src/engine/engine.js";
import { CommodityConfigSchema, KalshiCommoditiesStrategy, type CommodityResearchSource, type CommodityResearchSnapshot } from "../src/strategies/kalshi-commodities.js";
import type { Fill, Order, OrderAck, OrderBook, OrderIntent, OrderLifecycleHooks, Position, PredictionExecutionMarket, PredictionOrderState, Signal, VenueAccount, VenueAdapter } from "../src/types.js";
const START = Date.UTC(2026, 8, 5, 12);
const ACCOUNT: VenueAccount = { venue: "kalshi", keyId: "test" };
const log = { debug() {}, info() {}, warn() {}, error() {} };

/** Full account simulation: a match changes cash/inventory only when its CONFIRMED record is exposed. */
class CommodityVenue implements VenueAdapter {
  readonly id = "kalshi" as const;
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
  externalBidSize = 100000;
  externalAskSize = 100000;
  hideStatus = false;
  loseAck = false;
  readonly prices = { YES: { bid: 0.49, ask: 0.51 }, NO: { bid: 0.49, ask: 0.51 } };

  constructor(private readonly clock: { now: number }) {}
  async setup(): Promise<VenueAccount> { return ACCOUNT; }
  async fundingInstructions() { return { venue: this.id, addresses: [], summary: "fixture" }; }
  async awaitFunding() { return { asset: "USD", total: this.cash, available: this.cash }; }
  async balances() { return [{ asset: "USD", total: this.cash, available: this.cash }]; }
  async positions() { return this.hidePositions ? [] : [...this.holdings.values()].filter(position => position.size > 0).map(position => ({ ...position })); }
  async eventRef(marketRef: string) { return `event:${marketRef}`; }
  normalizeOrderSize(size: number) { return Math.floor((size + 1e-10) * 100) / 100; }
  async tokenBalance(_account: VenueAccount, tokenId: string) { return this.holdings.get(tokenId)?.size ?? 0; }

  async executionMarket(marketRef: string, outcome: "YES" | "NO"): Promise<PredictionExecutionMarket> {
    this.marketsRead.push(outcome);
    const tokenId = `${marketRef}:${outcome}`;
    const { bid, ask } = this.prices[outcome];
    const book: OrderBook = { marketRef, bids: [{ price: bid, size: this.externalBidSize }], asks: [{ price: ask, size: this.externalAskSize }], ts: this.clock.now };
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
    if (this.loseAck) throw new Error("accepted POST timed out");
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
    const fee = quantity * .07 * fillPrice * (1 - fillPrice);
    this.cash += (intent.side === "BUY" ? -1 : 1) * quantity * fillPrice - fee;
    this.holdings.set(intent.tokenId!, {
      marketRef: intent.marketRef, tokenId: intent.tokenId, conditionId: intent.conditionId, outcome: intent.outcome,
      side: intent.outcome!, size: Math.max(0, nextSize), avgPrice: intent.side === "BUY" ? (oldSize * (current?.avgPrice ?? 0) + quantity * fillPrice) / nextSize : current!.avgPrice,
    });
    order.matched += quantity;
    if (order.matched + 1e-8 >= intent.size) order.status = "matched";
    this.settlements.push({ id: `fill-${this.settlements.length + 1}`, orderId, ...(intent.postOnly ? { makerOrderId: orderId } : {}),
      marketRef: intent.marketRef, tokenId: intent.tokenId, conditionId: intent.conditionId, outcome: intent.outcome, side: intent.side,
      size: quantity, matchedAmountDelta: quantity, price: fillPrice, ts: this.clock.now, settlementStatus: "CONFIRMED", fee });
  }
  async executionOrder(_account: VenueAccount, orderId: string): Promise<PredictionOrderState | null> {
    if (this.hideStatus) return null;
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

function harness(options: { side?: "YES" | "NO"; style?: "marketable" | "adaptive" } = {}) {
  const clock = { now: START }, side = options.side ?? "YES", state = new MemoryStateStore();
  const venue = new CommodityVenue(clock);
  const research: CommodityResearchSnapshot = { receivedAt: START, excluded: [], contracts: [{ asset: "gold", marketRef: "gold-a", eventRef: "event:gold-a", series: "KXGOLD", verified: true,
    settlementBasis: "COMEX GC settlement", rulesHash: "hash-a", closeAt: START + 86_400_000, openAt: START - 86_400_000, forecastAt: START,
    forecastId: "q1", qYes: side === "YES" ? .73 : .27, strikeType: "greater", takerFeeRate: .07, makerFeeRate: .0175 }] };
  const signals: CommodityResearchSource = { snapshot: async () => research, refreshedAt: () => research.receivedAt,
    latest: async () => research.contracts.map(c => ({ id: c.forecastId, venue: "kalshi", marketRef: c.marketRef, side: c.qYes > .5 ? "YES" : "NO",
      prob: c.qYes > .5 ? c.qYes : 1 - c.qYes, refPrice: .5, ts: new Date(c.forecastAt).toISOString(), ttlSec: 21600,
      settlementBasis: c.settlementBasis, rulesHash: c.rulesHash, endsAt: c.closeAt } as Signal)) };
  const config = BotConfigSchema.parse({ id: "commodity-engine", venue: "kalshi", strategy: { id: "kalshi-commodities", config: CommodityConfigSchema.parse({ assets: ["gold"], entryStyle: options.style ?? "marketable" }) },
    execution: { entryDeadlineSec: 20, exitPassiveSec: 20 }, risk: { minViableNotional: 1, maxOrderNotional: 1000, depthCapPct: 2 } });
  const createEngine = () => new Engine({ botId: config.id, config, adapter: venue, account: ACCOUNT, strategy: new KalshiCommoditiesStrategy(), signals,
    state, alerter: { send: async () => {} }, log, now: () => clock.now });
  const advance = async (engine: Engine, ms = 5000) => { clock.now += ms; await engine.supervisePredictions(); };
  return { clock, state, venue, research, createEngine, engine: createEngine(), advance, config };
}

describe("Kalshi commodity strategy and durable Engine", () => {
  it.each(["YES", "NO"] as const)("uses bounded marketable %s limits without a heartbeat API and books confirmed fees once", async side => {
    const h = harness({ side });
    expect(h.engine.adaptivePredictionExecution).toBe(true);
    expect((await h.engine.tick()).errors).toBe(0);
    expect(h.venue.placements).toHaveLength(1);
    const { intent } = h.venue.placements[0]!;
    expect(intent).toMatchObject({ side: "BUY", outcome: side, tokenId: `gold-a:${side}`, tif: "FAK", postOnly: false, limitPrice: .51 });
    expect(intent.expiration).toBeUndefined();
    await h.advance(h.engine); await h.advance(h.engine);
    const snapshot = (await h.engine.predictionStatus())!, p = snapshot.parents[0]!;
    expect(p.status).toBe("completed");
    expect(p.feeUsd).toBeGreaterThan(0);
    expect(p.filledNotionalUsd + p.feeUsd).toBeLessThan(25);
    const spent = snapshot.dailySpentUsd["2026-09-05"]!;
    await h.advance(h.engine);
    expect((await h.engine.predictionStatus())!.dailySpentUsd["2026-09-05"]).toBe(spent);
    expect(h.venue.placements).toHaveLength(1);
  });

  it("places expiring post-only entries and cancels before one bounded IOC transition", async () => {
    const h = harness({ style: "adaptive" });
    expect((await h.engine.tick()).errors).toBe(0);
    expect(h.venue.placements[0]!.intent).toMatchObject({ tif: "GTC", postOnly: true, limitPrice: .5, expiration: (START + 20_000) / 1000 });
    await h.advance(h.engine, 20_000);
    expect(h.venue.placements).toHaveLength(1);
    expect(h.venue.events).toContain("cancel:order-1");
    await h.advance(h.engine); await h.advance(h.engine);
    expect(h.venue.placements).toHaveLength(2);
    expect(h.venue.placements[1]!.intent).toMatchObject({ tif: "FAK", postOnly: false, limitPrice: .51 });
    expect(h.venue.placements[1]!.intent.expiration).toBeUndefined();
    expect(h.venue.events.indexOf("cancel:order-1")).toBeLessThan(h.venue.events.findIndex(e => e === "place:order-2:BUY:FAK"));
  });

  it("retains an unresolved cancellation across restart and never overlaps replacements", async () => {
    const h = harness({ style: "adaptive" }); await h.engine.tick();
    h.venue.hideStatus = true;
    await h.advance(h.engine, 20_000); await h.advance(h.engine, 5000);
    const restarted = h.createEngine(); await restarted.recoverPredictions();
    await h.advance(restarted, 5000); await h.advance(restarted, 5000);
    expect(h.venue.placements).toHaveLength(1);
    expect((await restarted.predictionStatus())!.parents[0]!.reservedNotionalUsd).toBeGreaterThan(0);
  });

  it("keeps a partial IOC receipt reserved until two authoritative observations, then retains filled inventory", async () => {
    const h = harness(); h.venue.fakFillLimit = 5;
    await h.engine.tick();
    expect(h.venue.placements).toHaveLength(1);
    await h.advance(h.engine);
    expect((await h.engine.predictionStatus())!.parents[0]).toMatchObject({ filledSize: 5 });
    const restarted = h.createEngine(); await restarted.recoverPredictions();
    await h.advance(restarted); await h.advance(restarted);
    expect((await restarted.predictionStatus())!.parents[0]).toMatchObject({ status: "canceled", filledSize: 5, reservedNotionalUsd: 0 });
    expect(h.venue.placements).toHaveLength(1);
    expect(h.venue.holdings.get("gold-a:YES")!.size).toBe(5);
  });

  it("cancels when settlement rules change and does not cross on the stale evidence", async () => {
    const h = harness({ style: "adaptive" }); await h.engine.tick();
    h.research.contracts[0]!.rulesHash = "revised"; h.research.receivedAt = h.clock.now + 5000; h.clock.now += 5000;
    expect((await h.engine.tick()).errors).toBe(0);
    expect(h.venue.events).toContain("cancel:order-1");
    await h.advance(h.engine, 20_000); await h.advance(h.engine);
    expect(h.venue.placements).toHaveLength(1);
  });

  it("does not chase an ask above the original entry cap", async () => {
    const h = harness({ style: "adaptive" }); await h.engine.tick();
    h.venue.prices.YES.ask = .52;
    await h.advance(h.engine, 20_000); await h.advance(h.engine); await h.advance(h.engine);
    expect(h.venue.placements).toHaveLength(1);
    expect(h.venue.events).toContain("cancel:order-1");
  });

  it.each(["bid", "ask"])("cancels an admitted parent when %s depth shrinks below its participation cap", async side => {
    const h = harness({ style: "adaptive" }); await h.engine.tick();
    expect(h.venue.placements).toHaveLength(1);
    // $98 of exit depth remains above the $50 venue floor, but a 2% participation
    // cap permits less than $2, well below the already admitted parent commitment.
    if (side === "bid") h.venue.externalBidSize = 200;
    else h.venue.externalAskSize = 200;
    await h.advance(h.engine, 20_000); await h.advance(h.engine); await h.advance(h.engine);
    expect(h.venue.events).toContain("cancel:order-1");
    expect(h.venue.placements).toHaveLength(1);
  });

  it("adopts an ambiguous accepted submission from the venue and will not duplicate after restart", async () => {
    const h = harness({ style: "adaptive" }); h.venue.loseAck = true;
    await h.engine.tick();
    const status = (await h.engine.predictionStatus())!;
    expect(status.blocked).toBe(false);
    expect(status.reconcilingMarkets).toHaveLength(1);
    h.venue.loseAck = false;
    const restarted = h.createEngine(); await restarted.recoverPredictions();
    h.clock.now += 30_000; await restarted.tick();
    expect(h.venue.placements).toHaveLength(1);
    const after = (await restarted.predictionStatus())!;
    expect(after.blocked).toBe(false);
    expect(after.reconcilingMarkets).toBeUndefined();
    expect(after.parents[0]!.childOrderIds).toHaveLength(1);
  });
});

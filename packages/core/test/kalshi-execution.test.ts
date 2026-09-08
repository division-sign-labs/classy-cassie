// packages/core/test/kalshi-execution.test.ts
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { KalshiAdapter } from "../src/venues/kalshi.js";
import { VenueUrlsSchema } from "../src/config.js";
import type { OrderIntent, PreparedOrderMeta, RuntimeCreds } from "../src/types.js";

const privateKeyB64 = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const creds: RuntimeCreds = { venue: "kalshi", keyId: "test", privateKeyB64 };
const acct = { venue: "kalshi" as const, keyId: "test" };
const marketRef = "KXGOLD-26SEP04-T4000";
const token = (outcome: "YES" | "NO") => `kalshi:${marketRef}:${outcome}`;
const market = { ticker: marketRef, event_ticker: "KXGOLD-26SEP04", market_type: "binary", status: "active",
  close_time: "2099-09-04T18:00:00Z", fractional_trading_enabled: true,
  price_ranges: [{ start: "0", end: "1", step: "0.001" }], volume_24h_fp: "100.00" };
const orderbook = { orderbook_fp: { yes_dollars: [["0.410", "7.75"]], no_dollars: [["0.570", "12.25"]] } };
const intent = (changes: Partial<OrderIntent> = {}): OrderIntent => ({ marketRef, tokenId: token("NO"), conditionId: `kalshi:${marketRef}`,
  outcome: "NO", side: "BUY", size: 2.509, limitPrice: .5719, tif: "GTC", postOnly: true, clientId: "parent-1:child:2", ...changes });
type Call = { url: URL; method: string; body: Record<string, unknown> };
function harness(handler?: (call: Call) => unknown, marketChanges: Partial<typeof market> = {}) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: new URL(String(input)), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : {} };
    calls.push(call);
    if (call.url.pathname.endsWith("/orderbook")) return Response.json(orderbook);
    if (call.url.pathname.endsWith(`/markets/${marketRef}`)) return Response.json({ market: { ...market, ...marketChanges } });
    const value = handler?.(call);
    if (value instanceof Response) return value;
    if (value !== undefined) return Response.json(value);
    throw new Error(`unhandled mocked request ${call.method} ${call.url.pathname}`);
  }) as typeof fetch;
  const adapter = new KalshiAdapter({ urls: VenueUrlsSchema.parse({}), creds }, impl);
  return { adapter, calls };
}
const row = (changes: Record<string, unknown> = {}) => ({ order_id: "o1", ticker: marketRef,
  book_side: "ask", outcome_side: "no", initial_count_fp: "2.50", remaining_count_fp: "2.50", fill_count_fp: "0.00",
  yes_price_dollars: ".429", status: "resting", ...changes });

describe("Kalshi durable execution boundary", () => {
  it("returns exact NO outcome book, market identity, subcent grid and fractional minimum", async () => {
    const { adapter } = harness();
    const m = await adapter.executionMarket(marketRef, "NO");
    expect(m).toMatchObject({ tokenId: token("NO"), conditionId: `kalshi:${marketRef}`, minOrderSize: .01, tickSize: .001, acceptingOrders: true,
      book: { bids: [{ price: .57, size: 12.25 }], asks: [{ price: .59, size: 7.75 }] }, quote: { bid: .57, ask: .59 } });
    expect(await adapter.eventRef(marketRef)).toBe("kalshi:KXGOLD-26SEP04");
  });

  it.each([{ status: "paused" }, { status: "settled" }, { close_time: "2000-01-01T00:00:00Z" }])("does not accept inactive market terms %j", async changes => {
    const { adapter } = harness(undefined, changes);
    expect((await adapter.executionMarket(marketRef, "YES")).acceptingOrders).toBe(false);
  });

  it("fails closed on unknown grids and wrong market identities", async () => {
    await expect(harness(undefined, { price_ranges: [] }).adapter.executionMarket(marketRef, "YES")).rejects.toThrow("price grid");
    await expect(harness(undefined, { ticker: "WRONG" }).adapter.executionMarket(marketRef, "YES")).rejects.toThrow("identity");
  });

  it("journals rounded conservative terms before POST, sends post-only and native expiry, and encodes a UUID", async () => {
    let prepared: PreparedOrderMeta | undefined;
    const { adapter, calls } = harness(call => {
      if (call.method === "POST") { expect(prepared).toBeDefined(); return { order_id: "o1", fill_count: "0", remaining_count: "2.50" }; }
    });
    await adapter.executionMarket(marketRef, "NO");
    const expiration = Math.floor(Date.now() / 1000) + 120;
    await adapter.placeOrderWithLifecycle(acct, intent({ expiration }), { onPrepared: async meta => { prepared = meta; } });
    const body = calls.find(c => c.method === "POST")!.body;
    expect(body).toMatchObject({ count: "2.50", side: "ask", price: "0.429", post_only: true, expiration_time: expiration,
      time_in_force: "good_till_canceled", cancel_order_on_pause: true, subaccount: 0 });
    expect(body.client_order_id).toMatch(/^ca551e01-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(prepared).toMatchObject({ tokenId: token("NO"), limitPrice: .571, size: 2.5 });
  });

  it("never submits when the durability hook rejects", async () => {
    const { adapter, calls } = harness();
    await adapter.executionMarket(marketRef, "NO");
    await expect(adapter.placeOrderWithLifecycle(acct, intent(), { onPrepared: async () => { throw new Error("paused"); } })).rejects.toThrow("paused");
    expect(calls.filter(c => c.method === "POST")).toHaveLength(0);
  });

  it("maps FAK to IOC and preserves partial fills when the rest cancels", async () => {
    const { adapter, calls } = harness(() => ({ order_id: "o1", fill_count: "1.25", remaining_count: "0", average_fill_price: ".429" }));
    await adapter.executionMarket(marketRef, "NO");
    const ack = await adapter.placeOrderWithLifecycle(acct, intent({ tif: "FAK", postOnly: false }), { onPrepared: async () => {} });
    expect(ack).toMatchObject({ status: "canceled", filledSize: 1.25, avgFillPrice: .571, tokenId: token("NO") });
    expect(calls.find(c => c.method === "POST")!.body).toMatchObject({ time_in_force: "immediate_or_cancel", post_only: false });
    expect(calls.find(c => c.method === "POST")!.body).not.toHaveProperty("expiration_time");
  });

  it("rejects post-only IOC, expiring IOC and cross-outcome identity before submission", async () => {
    const { adapter, calls } = harness();
    await expect(adapter.placeOrder(acct, intent({ tif: "IOC" }))).rejects.toThrow("post-only");
    await expect(adapter.placeOrder(acct, intent({ tif: "IOC", postOnly: false, expiration: Math.floor(Date.now() / 1000) + 60 }))).rejects.toThrow("expiry");
    await expect(adapter.placeOrder(acct, intent({ tokenId: token("YES") }))).rejects.toThrow("identity");
    expect(calls).toHaveLength(0);
  });

  it("floors unsupported fractional sizes to whole contracts and rounds SELL NO inward", async () => {
    const { adapter, calls } = harness(() => ({ order_id: "o1", fill_count: "0", remaining_count: "2" }), { fractional_trading_enabled: false });
    await adapter.executionMarket(marketRef, "NO");
    await adapter.placeOrderWithLifecycle(acct, intent({ side: "SELL" }), { onPrepared: async meta => { expect(meta).toMatchObject({ limitPrice: .572, size: 2 }); } });
    expect(calls.find(c => c.method === "POST")!.body).toMatchObject({ side: "bid", price: "0.428", count: "2.00", reduce_only: true });
    expect(adapter.normalizeOrderSize(2.509)).toBe(2.5);
    expect(adapter.normalizeOrderSize(adapter.normalizeOrderSize(2.509))).toBe(2.5);
  });

  it.each(["BUY", "SELL"] as const)("recovers %s NO fills and fees from order UUID after restart", async side => {
    const before = harness(() => ({ order_id: "o1", fill_count: "0", remaining_count: "2.50" }));
    await before.adapter.executionMarket(marketRef, "NO");
    await before.adapter.placeOrderWithLifecycle(acct, intent({ side }), { onPrepared: async () => {} });
    const clientId = before.calls.find(c => c.method === "POST")!.body.client_order_id;
    const book_side = side === "BUY" ? "ask" : "bid", outcome_side = side === "BUY" ? "no" : "yes";
    const after = harness(call => {
      if (call.url.pathname.endsWith("/fills")) return { fills: [{ fill_id: "f1", order_id: "o1", ticker: marketRef, book_side, outcome_side,
        count_fp: "1.25", yes_price_dollars: ".429", fee_cost: ".015625", ts: Date.now() / 1000 }] };
      if (call.url.pathname.endsWith("/orders/o1")) return { order: row({ client_order_id: clientId, book_side, outcome_side }) };
      if (call.url.pathname.endsWith("/orders")) return { orders: [row({ client_order_id: clientId, book_side, outcome_side })] };
    });
    const [fill] = await after.adapter.tradeSettlements(acct, 0);
    expect(fill).toMatchObject({ tokenId: token("NO"), outcome: "NO", side, price: .571, size: 1.25, fee: .015625, settlementStatus: "CONFIRMED" });
    const [open] = await after.adapter.openOrders(acct);
    expect(open).toMatchObject({ tokenId: token("NO"), outcome: "NO", side, price: .571 });
    expect(after.calls.filter(c => c.url.pathname.endsWith("/orders/o1"))).toHaveLength(1);
  });

  it("never invents fills from canceled remaining quantities and leaves unknown states unresolved", async () => {
    const { adapter } = harness(() => ({ order: row({ remaining_count_fp: "0", fill_count_fp: ".75", status: "canceled" }) }));
    expect(await adapter.executionOrder(acct, "o1")).toMatchObject({ status: "canceled", size: 2.5, matchedSize: .75 });
    const unknown = harness(() => ({ order: row({ remaining_count_fp: "0", fill_count_fp: ".75", status: "future_state" }) }));
    expect(await unknown.adapter.executionOrder(acct, "o1")).toMatchObject({ status: "unknown", matchedSize: .75 });
    const invalid = harness(() => ({ order: row({ fill_count_fp: undefined }) }));
    await expect(invalid.adapter.executionOrder(acct, "o1")).rejects.toThrow("filled order count");
    expect(await harness(() => new Response("{}", { status: 404 })).adapter.executionOrder(acct, "gone")).toBeNull();
  });

  it("routes checked cancellation by market and requires matching response identity", async () => {
    const { adapter, calls } = harness(call => call.method === "GET" ? { order: row() } : { order_id: "o1", reduced_by: "2.50" });
    expect(await adapter.cancelOrderChecked(acct, "o1")).toEqual({ status: "canceled" });
    expect(calls.find(c => c.method === "DELETE")!.url.searchParams.get("market_ticker")).toBe(marketRef);
    const invalid = harness(call => call.method === "GET" ? { order: row() } : { order_id: "another", reduced_by: "2.50" });
    expect(await invalid.adapter.cancelOrderChecked(acct, "o1")).toMatchObject({ status: "not-canceled" });
  });

  it("maps signed positions to outcome balances", async () => {
    const { adapter } = harness(() => ({ market_positions: [{ ticker: marketRef, position_fp: "-3.25", market_exposure_dollars: "1.8525" }] }));
    expect(await adapter.tokenBalance(acct, token("NO"))).toBe(3.25);
    expect(await adapter.tokenBalance(acct, token("YES"))).toBe(0);
    expect((await adapter.positions(acct))[0]).toMatchObject({ tokenId: token("NO"), conditionId: `kalshi:${marketRef}`, outcome: "NO", side: "NO", avgPrice: .57 });
  });

  it("refuses settlement accounting with missing fees or contradictory directions", async () => {
    const { adapter } = harness(() => ({ fills: [{ fill_id: "f1", ticker: marketRef, book_side: "bid", count_fp: "1", yes_price_dollars: ".5", ts: Date.now() / 1000 }] }));
    await expect(adapter.tradeSettlements(acct, 0)).rejects.toThrow("fill fee missing");
    const conflict = harness(() => ({ orders: [row({ book_side: "bid", outcome_side: "no" })] }));
    await expect(conflict.adapter.openOrders(acct)).rejects.toThrow("conflicting");
  });

  it("distinguishes definitive post-only rejection from ambiguous network/server failures", async () => {
    const { adapter } = harness(() => new Response('{"code":"invalid_order","details":"post only cross"}', { status: 400 }));
    await adapter.executionMarket(marketRef, "NO");
    await expect(adapter.placeOrderWithLifecycle(acct, intent(), { onPrepared: async () => {} })).rejects.toMatchObject({ submissionRejected: true });
    const server = harness(() => new Response("{}", { status: 500 }));
    await server.adapter.executionMarket(marketRef, "NO");
    await expect(server.adapter.placeOrderWithLifecycle(acct, intent(), { onPrepared: async () => {} })).rejects.toMatchObject({ submissionRejected: false });
  });
});

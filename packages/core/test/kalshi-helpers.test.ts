// packages/core/test/kalshi-helpers.test.ts
// Unit-boundary tests for the Kalshi adapter against the post-fixed-point
// contract (verified live + against docs.kalshi.com on 2026-08-23): dollar-
// string prices, fractional fp contract counts, YES-book V2 order mapping,
// position sign mapping, and the request/response mapping via injected fetch.

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  KalshiAdapter,
  VenueUrlsSchema,
  countToFp,
  mapKalshiPosition,
  parseFp,
  priceToDollars,
  synthesizeKalshiBook,
  toBookOrder,
  type RuntimeCreds,
} from "@quotient-forecasting/cassie-core";

const urls = VenueUrlsSchema.parse({});
const b64Key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "der", type: "pkcs8" })
  .toString("base64");
const creds: RuntimeCreds = { venue: "kalshi", keyId: "test-key-id", privateKeyB64: b64Key };
const acct = { venue: "kalshi" as const, keyId: "test-key-id" };

type Captured = { url: URL; method: string; headers: Record<string, string>; body?: unknown };

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Captured[] = [];
  let i = 0;
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const res = responses[Math.min(i, responses.length - 1)];
    i++;
    calls.push({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Promise.resolve(
      new Response(JSON.stringify(res.body), { status: res.status ?? 200, headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch;
  return { impl, calls };
}

describe("unit conversions", () => {
  it("parses fixed-point strings and legacy numbers", () => {
    expect(parseFp("0.5600")).toBe(0.56);
    expect(parseFp("1556.58")).toBe(1556.58);
    expect(parseFp(0.42)).toBe(0.42);
    expect(parseFp(undefined)).toBe(0);
    expect(parseFp("garbage")).toBe(0);
  });

  it("priceToDollars clamps to the cent grid [0.01, 0.99] as a 2dp string", () => {
    expect(priceToDollars(0.005)).toBe("0.01");
    expect(priceToDollars(0.999)).toBe("0.99");
    expect(priceToDollars(0.374)).toBe("0.37");
    expect(priceToDollars(0.375)).toBe("0.38");
  });

  it("countToFp keeps fractional contracts at 0.01 granularity; below that is null", () => {
    expect(countToFp(12.4)).toBe("12.40");
    expect(countToFp(2.505)).toBe("2.51");
    expect(countToFp(0.01)).toBe("0.01");
    expect(countToFp(0.004)).toBeNull();
  });
});

describe("YES-book order mapping (V2)", () => {
  it("BUY YES → bid at the YES price; SELL YES → ask", () => {
    expect(toBookOrder("BUY", "YES", 0.42)).toEqual({ bookSide: "bid", yesPrice: 0.42 });
    expect(toBookOrder("SELL", "YES", 0.42)).toEqual({ bookSide: "ask", yesPrice: 0.42 });
  });

  it("BUY NO → ask at 1 − noPrice; SELL NO → bid", () => {
    expect(toBookOrder("BUY", "NO", 0.61)).toEqual({ bookSide: "ask", yesPrice: 0.39 });
    expect(toBookOrder("SELL", "NO", 0.61)).toEqual({ bookSide: "bid", yesPrice: 0.39 });
  });
});

describe("book synthesis", () => {
  it("bids from yes dollar levels best-first, asks mirrored from no at (1 − price)", () => {
    const book = synthesizeKalshiBook(
      "T-1",
      [["0.4000", "100.00"], ["0.4200", "50.00"]],
      [["0.5500", "80.00"], ["0.5000", "30.00"]],
      1_000,
    );
    expect(book.bids.map((l) => l.price)).toEqual([0.42, 0.4]);
    expect(book.bids.map((l) => l.size)).toEqual([50, 100]);
    // no 0.55 → ask 0.45; no 0.50 → ask 0.50; sorted best (lowest) first
    expect(book.asks.map((l) => l.price)).toEqual([0.45, 0.5]);
    expect(book.asks.map((l) => l.size)).toEqual([80, 30]);
  });

  it("tolerates null/absent sides", () => {
    const book = synthesizeKalshiBook("T-1", null, undefined, 0);
    expect(book.bids).toEqual([]);
    expect(book.asks).toEqual([]);
  });
});

describe("position mapping", () => {
  it("positive position_fp is YES with avgPrice from exposure dollars", () => {
    const p = mapKalshiPosition({ ticker: "T-1", position_fp: "40.00", market_exposure_dollars: "14.80" });
    expect(p).toMatchObject({ marketRef: "T-1", side: "YES", size: 40, avgPrice: 0.37 });
  });

  it("negative position_fp is NO in NO-space, with realized PnL in dollars", () => {
    const p = mapKalshiPosition({ ticker: "T-1", position_fp: "-25.00", market_exposure_dollars: "15.00", realized_pnl_dollars: "2.50" });
    expect(p).toMatchObject({ side: "NO", size: 25, avgPrice: 0.6, realizedPnl: 2.5 });
  });

  it("legacy cents fields still map as fallback", () => {
    const p = mapKalshiPosition({ ticker: "T-1", position: -25, market_exposure: 1_500, realized_pnl: 250 });
    expect(p).toMatchObject({ side: "NO", size: 25, avgPrice: 0.6, realizedPnl: 2.5 });
  });

  it("flat positions map to null", () => {
    expect(mapKalshiPosition({ ticker: "T-1", position_fp: "0.00" })).toBeNull();
  });
});

describe("adapter request mapping (injected fetch)", () => {
  it("BUY YES limit order posts to the V2 endpoint as a bid with fp strings", async () => {
    const { impl, calls } = fakeFetch([
      { body: { order_id: "o-1", client_order_id: "cid-1", fill_count: "0.00", remaining_count: "10.00", ts_ms: 1 } },
    ]);
    const adapter = new KalshiAdapter({ urls, creds }, impl);
    const ack = await adapter.placeOrder(acct, {
      marketRef: "KXTEST-26-Y",
      side: "BUY",
      outcome: "YES",
      size: 10,
      limitPrice: 0.42,
      tif: "GTC",
      clientId: "cid-1",
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/trade-api/v2/portfolio/events/orders");
    expect(calls[0].body).toMatchObject({
      ticker: "KXTEST-26-Y",
      side: "bid",
      count: "10.00",
      price: "0.42",
      time_in_force: "good_till_canceled",
      self_trade_prevention_type: "taker_at_cross",
      client_order_id: "cid-1",
    });
    expect(calls[0].headers["KALSHI-ACCESS-KEY"]).toBe("test-key-id");
    expect(calls[0].headers["KALSHI-ACCESS-SIGNATURE"]).toBeTruthy();
    expect(ack).toMatchObject({ orderId: "o-1", status: "open" });
  });

  it("BUY NO becomes an ask at 1 − noPrice, and the fill price converts back to NO-space", async () => {
    const { impl, calls } = fakeFetch([
      { body: { order_id: "o-2", fill_count: "5.00", remaining_count: "0.00", average_fill_price: "0.3900", ts_ms: 1 } },
    ]);
    const adapter = new KalshiAdapter({ urls, creds }, impl);
    const ack = await adapter.placeOrder(acct, {
      marketRef: "KXTEST-26-Y",
      side: "BUY",
      outcome: "NO",
      size: 5,
      limitPrice: 0.61,
      tif: "GTC",
      clientId: "cid-2",
    });
    expect(calls[0].body).toMatchObject({ side: "ask", price: "0.39", count: "5.00" });
    expect(ack).toMatchObject({ orderId: "o-2", status: "filled", filledSize: 5, avgFillPrice: 0.61 });
  });

  it("IOC maps to immediate_or_cancel; nothing crossed acks as canceled", async () => {
    const { impl, calls } = fakeFetch([
      { body: { order_id: "o-3", fill_count: "0.00", remaining_count: "0.00", ts_ms: 1 } },
    ]);
    const adapter = new KalshiAdapter({ urls, creds }, impl);
    const ack = await adapter.placeOrder(acct, {
      marketRef: "KXTEST-26-Y",
      side: "BUY",
      size: 3,
      limitPrice: 0.5,
      tif: "IOC",
      clientId: "cid-3",
    });
    expect(calls[0].body).toMatchObject({ time_in_force: "immediate_or_cancel" });
    expect(ack.status).toBe("canceled");
  });

  it("sub-0.01-contract sizes are rejected locally without hitting the venue", async () => {
    const { impl, calls } = fakeFetch([{ body: {} }]);
    const adapter = new KalshiAdapter({ urls, creds }, impl);
    const ack = await adapter.placeOrder(acct, {
      marketRef: "KXTEST-26-Y",
      side: "BUY",
      size: 0.004,
      limitPrice: 0.5,
      tif: "GTC",
      clientId: "cid-4",
    });
    expect(ack.status).toBe("rejected");
    expect(calls).toHaveLength(0);
  });

  it("cancel targets the V2 events path", async () => {
    const { impl, calls } = fakeFetch([{ body: { order_id: "o-1", reduced_by: "10.00" } }]);
    const adapter = new KalshiAdapter({ urls, creds }, impl);
    await adapter.cancelOrder(acct, "o-1");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url.pathname).toBe("/trade-api/v2/portfolio/events/orders/o-1");
  });

  it("fills convert min_ts to seconds and report YES-space dollar prices", async () => {
    const t = Date.parse("2026-08-23T10:00:00Z");
    const { impl, calls } = fakeFetch([
      {
        body: {
          fills: [
            { fill_id: "f-1", order_id: "o-1", ticker: "T-1", book_side: "bid", count_fp: "4.00", yes_price_dollars: "0.4000", created_time: new Date(t + 5_000).toISOString() },
            { fill_id: "f-2", order_id: "o-2", ticker: "T-1", book_side: "ask", count_fp: "2.50", yes_price_dollars: "0.4500", created_time: new Date(t + 9_000).toISOString() },
          ],
        },
      },
    ]);
    const adapter = new KalshiAdapter({ urls, creds }, impl);
    const fills = await adapter.fills(acct, t);
    expect(calls[0].url.searchParams.get("min_ts")).toBe(String(Math.floor(t / 1000)));
    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({ id: "f-1", side: "BUY", size: 4, price: 0.4 });
    expect(fills[1]).toMatchObject({ id: "f-2", side: "SELL", size: 2.5, price: 0.45 });
  });

  it("open orders map fp counts and YES-space dollar prices", async () => {
    const { impl } = fakeFetch([
      {
        body: {
          orders: [
            {
              order_id: "o-9",
              client_order_id: "cid-9",
              ticker: "T-1",
              book_side: "bid",
              yes_price_dollars: "0.4200",
              initial_count_fp: "10.00",
              remaining_count_fp: "7.50",
              fill_count_fp: "2.50",
              status: "resting",
              created_time: "2026-08-23T09:00:00Z",
            },
          ],
          cursor: "",
        },
      },
    ]);
    const adapter = new KalshiAdapter({ urls, creds }, impl);
    const [order] = await adapter.openOrders(acct);
    expect(order).toMatchObject({ id: "o-9", side: "BUY", size: 10, filledSize: 2.5, price: 0.42, status: "partial" });
  });

  it("balances prefer balance_dollars, falling back to legacy cents", async () => {
    const dollars = fakeFetch([{ body: { balance: 25_000, balance_dollars: "250.0000" } }]);
    const [b1] = await new KalshiAdapter({ urls, creds }, dollars.impl).balances(acct);
    expect(b1).toMatchObject({ asset: "USD", total: 250, available: 250 });

    const centsOnly = fakeFetch([{ body: { balance: 12_345 } }]);
    const [b2] = await new KalshiAdapter({ urls, creds }, centsOnly.impl).balances(acct);
    expect(b2).toMatchObject({ total: 123.45 });
  });

  it("quote reads dollar-string bid/ask and fp contract volume", async () => {
    const { impl } = fakeFetch([
      { body: { market: { yes_bid_dollars: "0.2800", yes_ask_dollars: "0.3000", volume_24h_fp: "3355.36" } } },
    ]);
    const adapter = new KalshiAdapter({ urls, creds }, impl);
    const q = await adapter.quote("T-1");
    expect(q.bid).toBe(0.28);
    expect(q.ask).toBe(0.3);
    expect(q.mid).toBeCloseTo(0.29, 9);
    expect(q.volume24h).toBeCloseTo(3355.36 * 0.29, 2);
  });

  it("book parses orderbook_fp dollar levels", async () => {
    const { impl } = fakeFetch([
      { body: { orderbook_fp: { yes_dollars: [["0.2800", "15.35"]], no_dollars: [["0.7000", "125.00"]] } } },
    ]);
    const adapter = new KalshiAdapter({ urls, creds }, impl);
    const book = await adapter.book("T-1");
    expect(book.bids).toEqual([{ price: 0.28, size: 15.35 }]);
    expect(book.asks).toEqual([{ price: 0.3, size: 125 }]);
  });

  it("signature path includes the /trade-api/v2 prefix and excludes the query", async () => {
    const { impl, calls } = fakeFetch([{ body: { market_positions: [], cursor: "" } }]);
    const adapter = new KalshiAdapter({ urls, creds }, impl);
    await adapter.positions(acct);
    expect(calls[0].url.pathname).toBe("/trade-api/v2/portfolio/positions");
    expect(calls[0].url.searchParams.get("limit")).toBe("200");
    expect(calls[0].headers["KALSHI-ACCESS-TIMESTAMP"]).toMatch(/^\d{13}$/);
  });

  it("demo flag swaps the base URL", async () => {
    const demoUrls = VenueUrlsSchema.parse({ kalshi: { demo: true } });
    const { impl, calls } = fakeFetch([{ body: { balance: 0 } }]);
    const adapter = new KalshiAdapter({ urls: demoUrls, creds }, impl);
    await adapter.balances(acct);
    expect(calls[0].url.origin).toBe("https://demo-api.kalshi.co");
  });
});

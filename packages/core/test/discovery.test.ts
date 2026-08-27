// packages/core/test/discovery.test.ts
// Market discovery: Gamma + Kalshi fixture JSON → normalized MarketRows, and
// the deterministic filter (end date, volume, category, cap).

import { describe, expect, it } from "vitest";
import {
  KalshiMarketLister,
  PolymarketMarketLister,
  applyMarketFilter,
  createMarketLister,
  VenueUrlsSchema,
  type MarketRow,
} from "@quotient-forecasting/cassie-core";

const DAY = 86_400_000;

function jsonFetch(body: unknown) {
  const calls: URL[] = [];
  const impl = ((input: RequestInfo | URL) => {
    calls.push(new URL(String(input)));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return { impl, calls };
}

describe("PolymarketMarketLister", () => {
  it("maps Gamma rows: YES token from JSON-encoded clobTokenIds, snake_case filters", async () => {
    const { impl, calls } = jsonFetch([
      {
        question: "Will oil close above $80?",
        conditionId: "0xC0ND",
        clobTokenIds: '["yes-token-1","no-token-1"]',
        endDate: new Date(Date.now() + 3 * DAY).toISOString(),
        volume24hr: 45_000,
        outcomePrices: '["0.62","0.38"]',
        category: "Commodities",
        closed: false,
      },
      { question: "closed one", conditionId: "0xC1", clobTokenIds: '["t"]', closed: true },
      { question: "no tokens", conditionId: "0xC2" },
    ]);
    const lister = new PolymarketMarketLister("https://gamma-api.polymarket.com", impl);
    const rows = await lister.list({ maxDaysToEnd: 7, minVolume24h: 10_000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      venue: "polymarket",
      marketRef: "yes-token-1",
      conditionId: "0xC0ND",
      question: "Will oil close above $80?",
      category: "Commodities",
      volume24h: 45_000,
      yesPrice: 0.62,
    });
    const url = calls[0]!;
    expect(url.searchParams.get("closed")).toBe("false");
    expect(url.searchParams.get("end_date_max")).toBeTruthy();
    expect(url.searchParams.get("volume_num_min")).toBe("10000");
  });
});

describe("KalshiMarketLister", () => {
  it("maps Kalshi rows: ticker as marketRef, fp contract volume → approx USD, provisional shards dropped", async () => {
    const { impl, calls } = jsonFetch({
      markets: [
        {
          ticker: "KXWTI-26AUG29-T80",
          title: "WTI above $80 on Aug 29?",
          close_time: new Date(Date.now() + 5 * DAY).toISOString(),
          volume_24h_fp: "100000.00",
          yes_bid_dollars: "0.4000",
          yes_ask_dollars: "0.4400",
          category: "Commodities",
          status: "open",
        },
        {
          ticker: "KXMVECROSSCATEGORY-SHARD1-X",
          title: "yes A,no B,yes C",
          close_time: new Date(Date.now() + 2 * DAY).toISOString(),
          volume_24h_fp: "9999.00",
          is_provisional: true,
          mve_collection_ticker: "KXMVECROSSCATEGORY-SHARD1-R",
        },
      ],
      cursor: "",
    });
    const lister = new KalshiMarketLister("https://api.elections.kalshi.com/trade-api/v2", impl);
    const rows = await lister.list({ maxDaysToEnd: 7 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ venue: "kalshi", marketRef: "KXWTI-26AUG29-T80" });
    expect(rows[0]!.yesPrice).toBeCloseTo(0.42, 9);
    expect(rows[0]!.volume24h).toBeCloseTo(42_000, 0);
    const url = calls[0]!;
    expect(url.pathname).toBe("/trade-api/v2/markets");
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.get("max_close_ts")).toBeTruthy();
  });
});

describe("applyMarketFilter", () => {
  const now = Date.now();
  const row = (over: Partial<MarketRow>): MarketRow => ({
    venue: "kalshi",
    marketRef: "T",
    question: "q",
    volume24h: 50_000,
    endDate: new Date(now + 2 * DAY).toISOString(),
    ...over,
  });

  it("filters by end window, volume floor, and category substring; caps output", () => {
    const rows = [
      row({ marketRef: "keep", category: "Commodities" }),
      row({ marketRef: "too-late", endDate: new Date(now + 30 * DAY).toISOString() }),
      row({ marketRef: "already-ended", endDate: new Date(now - DAY).toISOString() }),
      row({ marketRef: "thin", volume24h: 100 }),
      row({ marketRef: "wrong-topic", category: "Politics", question: "election stuff" }),
    ];
    const out = applyMarketFilter(rows, { maxDaysToEnd: 7, minVolume24h: 10_000, categories: ["commodit"] }, now);
    expect(out.map((r) => r.marketRef)).toEqual(["keep"]);
    expect(applyMarketFilter(rows, { limit: 2 }, now)).toHaveLength(2);
  });

  it("matches categories against the question text too", () => {
    const rows = [row({ category: undefined, question: "Will crude oil close above $80?" })];
    expect(applyMarketFilter(rows, { categories: ["oil"] }, now)).toHaveLength(1);
    expect(applyMarketFilter(rows, { categories: ["weather"] }, now)).toHaveLength(0);
  });
});

describe("createMarketLister", () => {
  const urls = VenueUrlsSchema.parse({});
  it("dispatches per venue and refuses perps venues", () => {
    expect(createMarketLister("polymarket", urls).venue).toBe("polymarket");
    expect(createMarketLister("kalshi", urls).venue).toBe("kalshi");
    expect(() => createMarketLister("hyperliquid", urls)).toThrow(/prediction venues/);
  });
});

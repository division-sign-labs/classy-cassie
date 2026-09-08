// packages/core/test/market-make-catalog.test.ts

import { describe, expect, it, vi } from "vitest";
import { PolymarketCatalogClient, normalizePolymarketCatalog } from "../src/polymarket/market-catalog.js";

const raw = {
  id: 123,
  conditionId: "0xcondition",
  question: "Will it happen?",
  outcomes: '["No", "Yes"]',
  clobTokenIds: '["no-token", "yes-token"]',
  active: true,
  closed: false,
  archived: false,
  acceptingOrders: true,
  enableOrderBook: true,
  endDate: "2026-09-10T00:00:00Z",
  volume24hr: "3000",
  orderPriceMinTickSize: "0.01",
  orderMinSize: "5",
  category: "Global Elections",
  negRiskMarketID: 44,
  events: [{ id: 77 }],
};

describe("Polymarket market-make catalog", () => {
  it("maps tokens by explicit outcome label even when NO is first", () => {
    const market = normalizePolymarketCatalog("polymarket:123", "123", "0xcondition", raw);
    expect(market.marketRef).toBe("yes-token");
    expect(market.yesTokenId).toBe("yes-token");
    expect(market.noTokenId).toBe("no-token");
    expect(market.eventId).toBe("polymarket:77");
    expect(market.manualCorrelationGroup).toBe("polymarket-neg-risk:44");
  });

  it("fails closed on a Quotient/Gamma identity mismatch", () => {
    expect(() => normalizePolymarketCatalog("polymarket:123", "123", "wrong", raw)).toThrow(
      /does not match Quotient/,
    );
    expect(() => normalizePolymarketCatalog("polymarket:999", "123", "0xcondition", raw)).toThrow(
      /marketKey/,
    );
  });

  it("queries the exact Gamma market by id through the list form", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify([raw]), { status: 200 });
    };
    const client = new PolymarketCatalogClient({ gammaBaseUrl: "https://gamma.example/", fetchImpl });
    await expect(client.market("polymarket:123", "123", "0xcondition")).resolves.toMatchObject({
      conditionId: "0xcondition",
      eventId: "polymarket:77",
    });
    // `/markets/{id}` omits `events`; only the list form carries parent event identity.
    expect(calls).toEqual(["https://gamma.example/markets?id=123"]);
  });

  it("bounds discovery, held-market refresh, status, and identity recovery with separate 10-second abort signals", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const signals: AbortSignal[] = [];
    const client = new PolymarketCatalogClient({
      gammaBaseUrl: "https://gamma.example",
      fetchImpl: async (input, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(init!.signal!.aborted).toBe(false);
        signals.push(init!.signal!);
        const body = new URL(String(input)).pathname === "/markets/123" ? raw : [raw];
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    try {
      await expect(client.activeMarkets()).resolves.toHaveLength(1);
      await expect(client.market("polymarket:123", "123", "0xcondition")).resolves.toMatchObject({ yesTokenId: "yes-token" });
      await expect(client.marketStatus("123", "0xcondition")).resolves.toMatchObject({ active: true });
      await expect(client.recover({ conditionId: "0xcondition" })).resolves.toMatchObject({ marketKey: "polymarket:123" });
      expect(timeout.mock.calls).toEqual([[10_000], [10_000], [10_000], [10_000]]);
      expect(new Set(signals).size).toBe(4);
    } finally {
      timeout.mockRestore();
    }
  });

  it("discovers active markets by descending daily volume without Quotient identities", async () => {
    const calls: URL[] = [];
    const client = new PolymarketCatalogClient({
      gammaBaseUrl: "https://gamma.example/",
      fetchImpl: async (input) => {
        calls.push(new URL(String(input)));
        return new Response(JSON.stringify([raw]), { status: 200 });
      },
    });

    await expect(client.activeMarkets()).resolves.toMatchObject([{
      marketKey: "polymarket:123",
      nativeMarketId: "123",
      conditionId: "0xcondition",
      yesTokenId: "yes-token",
      noTokenId: "no-token",
    }]);
    expect(calls[0]!.pathname).toBe("/markets");
    expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({
      active: "true", closed: "false", order: "volume24hr", ascending: "false", limit: "100", offset: "0",
    });
    await client.activeMarkets({ limit: 15, offset: 100 });
    expect(calls[1]!.searchParams.get("limit")).toBe("15");
    expect(calls[1]!.searchParams.get("offset")).toBe("100");
    await client.activeMarkets({ limit: 1000 });
    expect(calls[2]!.searchParams.get("limit")).toBe("100");
  });

  it("skips inactive, closed, archived, and otherwise untradable discovery rows", async () => {
    const rows = [
      { ...raw, id: 1, active: false },
      { ...raw, id: 2, closed: true },
      { ...raw, id: 3, archived: true },
      { ...raw, id: 4, acceptingOrders: false },
      { ...raw, id: 5, enableOrderBook: false },
      { ...raw, id: 6, active: null },
      { ...raw, id: 7, acceptingOrders: null },
      raw,
      raw,
    ];
    const client = new PolymarketCatalogClient({
      gammaBaseUrl: "https://gamma.example",
      fetchImpl: async () => new Response(JSON.stringify(rows), { status: 200 }),
    });

    expect((await client.activeMarkets()).map((market) => market.marketKey)).toEqual(["polymarket:123"]);
  });

  it("skips malformed and non-YES/NO rows without hiding valid discovery results", async () => {
    const rows = [
      null,
      {},
      { ...raw, id: 1, conditionId: null },
      { ...raw, id: 2, outcomes: '["Up", "Down"]' },
      { ...raw, id: 3, outcomes: '["Yes", "Yes"]' },
      { ...raw, id: 4, outcomes: '["Yes", "No", "Maybe"]', clobTokenIds: '["a", "b", "c"]' },
      { ...raw, id: 5, clobTokenIds: '["same", "same"]' },
      { ...raw, id: 6, clobTokenIds: 'invalid json' },
      { ...raw, id: 7, events: [] },
      { ...raw, id: 8, endDate: 'invalid date' },
      { ...raw, id: 9, orderPriceMinTickSize: 0 },
      raw,
    ];
    const client = new PolymarketCatalogClient({
      gammaBaseUrl: "https://gamma.example",
      fetchImpl: async () => new Response(JSON.stringify(rows), { status: 200 }),
    });

    const markets = await client.activeMarkets();
    expect(markets).toHaveLength(1);
    expect(markets[0]).toMatchObject({ marketKey: "polymarket:123", yesTokenId: "yes-token", noTokenId: "no-token" });
  });

  it("rejects invalid discovery responses and pagination rather than returning an empty universe", async () => {
    const client = (body: unknown, status = 200) => new PolymarketCatalogClient({
      gammaBaseUrl: "https://gamma.example",
      fetchImpl: async () => new Response(JSON.stringify(body), { status }),
    });
    await expect(client(raw).activeMarkets()).rejects.toThrow(/non-array response/);
    await expect(client({ error: 'rate limited' }, 429).activeMarkets()).rejects.toThrow(/429/);
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(client([]).activeMarkets({ limit })).rejects.toThrow(/limit must be a positive integer/);
    }
    for (const offset of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(client([]).activeMarkets({ offset })).rejects.toThrow(/offset must be a non-negative integer/);
    }
    await expect(client([]).activeMarkets()).resolves.toEqual([]);
  });

  it("fails closed when an exact id query does not resolve to one market", async () => {
    const client = (body: unknown) =>
      new PolymarketCatalogClient({
        gammaBaseUrl: "https://gamma.example/",
        fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
      });
    await expect(client(raw).market("polymarket:123", "123", "0xcondition")).rejects.toThrow(
      /non-array response/,
    );
    await expect(client([]).market("polymarket:123", "123", "0xcondition")).rejects.toThrow(
      /expected exactly one result, received 0/,
    );
  });

  it("reads terminal tradability from the path endpoint after a market leaves the list form", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        id: 123,
        conditionId: "0xcondition",
        active: true,
        closed: true,
        archived: false,
        acceptingOrders: false,
        enableOrderBook: true,
      }), { status: 200 });
    };
    const client = new PolymarketCatalogClient({ gammaBaseUrl: "https://gamma.example/", fetchImpl });

    await expect(client.marketStatus("123", "0xcondition")).resolves.toEqual({
      active: true,
      closed: true,
      archived: false,
      acceptingOrders: false,
      orderbookEnabled: true,
    });
    expect(calls).toEqual(["https://gamma.example/markets/123"]);
    await expect(client.marketStatus("123", "wrong")).rejects.toThrow(/does not match Quotient/);
  });

  it("recovers a canonical market by an exact condition id", async () => {
    const calls: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(new URL(String(input)));
      return new Response(JSON.stringify([raw]), { status: 200 });
    };
    const client = new PolymarketCatalogClient({ gammaBaseUrl: "https://gamma.example/", fetchImpl });

    await expect(client.recover({ conditionId: "0xcondition" })).resolves.toMatchObject({
      marketKey: "polymarket:123",
      nativeMarketId: "123",
      catalog: {
        marketKey: "polymarket:123",
        nativeMarketId: "123",
        conditionId: "0xcondition",
        yesTokenId: "yes-token",
        noTokenId: "no-token",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.pathname).toBe("/markets");
    expect(calls[0]!.searchParams.get("condition_ids")).toBe("0xcondition");
    expect(calls[0]!.searchParams.has("clob_token_ids")).toBe(false);
  });

  it("recovers by either exact outcome token", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify([raw]), { status: 200 });
    const client = new PolymarketCatalogClient({ gammaBaseUrl: "https://gamma.example", fetchImpl });

    await expect(client.recover({ clobTokenId: "no-token" })).resolves.toMatchObject({
      marketKey: "polymarket:123",
      catalog: { yesTokenId: "yes-token", noTokenId: "no-token" },
    });
    await expect(client.recover({ clobTokenId: "yes-token" })).resolves.toMatchObject({
      marketKey: "polymarket:123",
    });
  });

  it("queries both recovery identities independently and rejects a conflict", async () => {
    const calls: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      const result = url.searchParams.has("condition_ids")
        ? raw
        : {
            ...raw,
            id: 456,
            conditionId: "0xother",
            clobTokenIds: '["other-no", "yes-token"]',
          };
      return new Response(JSON.stringify([result]), { status: 200 });
    };
    const client = new PolymarketCatalogClient({ gammaBaseUrl: "https://gamma.example", fetchImpl });

    await expect(
      client.recover({ conditionId: "0xcondition", clobTokenId: "yes-token" }),
    ).rejects.toThrow(/identifiers conflict/);
    expect(calls).toHaveLength(2);
    expect(calls.some((url) => url.searchParams.get("condition_ids") === "0xcondition")).toBe(true);
    expect(calls.some((url) => url.searchParams.get("clob_token_ids") === "yes-token")).toBe(true);
  });

  it("fails closed for zero, multiple, non-array, and inexact recovery results", async () => {
    const clientFor = (body: unknown) => new PolymarketCatalogClient({
      gammaBaseUrl: "https://gamma.example",
      fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
    });

    await expect(clientFor([]).recover({ conditionId: "0xcondition" })).rejects.toThrow(
      /exactly one result, received 0/,
    );
    await expect(clientFor([raw, raw]).recover({ clobTokenId: "yes-token" })).rejects.toThrow(
      /exactly one result, received 2/,
    );
    await expect(clientFor(raw).recover({ conditionId: "0xcondition" })).rejects.toThrow(/non-array/);
    await expect(clientFor([raw]).recover({ conditionId: "0xwrong" })).rejects.toThrow(/expected exact condition/);
    await expect(clientFor([raw]).recover({ clobTokenId: "wrong-token" })).rejects.toThrow(/exact token/);
  });

  it("requires an identity and unambiguous explicit YES/NO labels", async () => {
    const client = new PolymarketCatalogClient({
      gammaBaseUrl: "https://gamma.example",
      fetchImpl: async () => new Response(JSON.stringify([raw]), { status: 200 }),
    });
    await expect(client.recover({})).rejects.toThrow(/requires a conditionId or clobTokenId/);
    expect(() => normalizePolymarketCatalog("polymarket:123", "123", "0xcondition", {
      ...raw,
      outcomes: '["Yes", "Yes"]',
    })).toThrow(/explicitly labeled YES and NO/);
  });
});

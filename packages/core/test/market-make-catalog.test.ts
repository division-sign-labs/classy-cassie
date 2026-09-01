// packages/core/test/market-make-catalog.test.ts

import { describe, expect, it } from "vitest";
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

  it("uses the exact Gamma market endpoint", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify(raw), { status: 200 });
    };
    const client = new PolymarketCatalogClient({ gammaBaseUrl: "https://gamma.example/", fetchImpl });
    await expect(client.market("polymarket:123", "123", "0xcondition")).resolves.toMatchObject({
      conditionId: "0xcondition",
    });
    expect(calls).toEqual(["https://gamma.example/markets/123"]);
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

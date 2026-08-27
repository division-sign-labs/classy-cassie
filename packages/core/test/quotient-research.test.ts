// packages/core/test/quotient-research.test.ts
// QuotientResearchClient: query serialization, lookup chunking at 10 refs per
// billed call, the credits header, and lenient row mapping.

import { describe, expect, it } from "vitest";
import { QuotientResearchClient, QUOTIENT_CALL_COST_USD } from "@quotient-forecasting/cassie-core";

function fakeGateway(rowsPerCall: unknown[][]) {
  const calls: Array<{ url: URL; method: string; headers: Record<string, string>; body?: unknown }> = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const rows = rowsPerCall[Math.min(calls.length, rowsPerCall.length - 1)] ?? [];
    calls.push({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ markets: rows }), {
        status: 200,
        headers: { "content-type": "application/json", "x-billing-credits-remaining": "412.5" },
      }),
    );
  }) as typeof fetch;
  return { impl, calls };
}

function makeClient(impl: typeof fetch) {
  return new QuotientResearchClient({ baseUrl: "https://gw.example", token: "tok-1", fetchImpl: impl });
}

describe("QuotientResearchClient", () => {
  it("search sends q + venue with the API key header, maps lenient rows, skips malformed ones", async () => {
    const { impl, calls } = fakeGateway([
      [
        { marketKey: "kalshi:KX-1", question: "Will X?", market_odds: 0.4, latest_q_probability: 0.55, thesis: "t" },
        { question: 42 }, // malformed: skipped
      ],
    ]);
    const client = makeClient(impl);
    const rows = await client.searchMarkets({ q: "commodities", venue: "kalshi", limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ marketKey: "kalshi:KX-1", marketOdds: 0.4, qProbability: 0.55, thesis: "t" });
    expect(calls[0]!.url.pathname).toBe("/api/v1/markets/search");
    expect(calls[0]!.url.searchParams.get("q")).toBe("commodities");
    expect(calls[0]!.url.searchParams.get("venue")).toBe("kalshi");
    expect(calls[0]!.headers["x-quotient-api-key"]).toBe("tok-1");
    expect(client.creditsRemaining).toBe(412.5);
  });

  it("lookup chunks market keys at 10 per billed call", async () => {
    const { impl, calls } = fakeGateway([[]]);
    const client = makeClient(impl);
    const keys = Array.from({ length: 23 }, (_, i) => `kalshi:KX-${i}`);
    await client.lookup({ marketKeys: keys, venue: "kalshi" });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url.searchParams.get("market_keys")!.split(",")).toHaveLength(10);
    expect(calls[2]!.url.searchParams.get("market_keys")!.split(",")).toHaveLength(3);
    expect(client.lookupCallCount(23)).toBe(3);
  });

  it("mispriced sends spread sorting; profileX POSTs the cleaned handle", async () => {
    const { impl, calls } = fakeGateway([[], []]);
    const client = makeClient(impl);
    await client.mispriced({ venue: "polymarket", minSpread: 5 });
    expect(calls[0]!.url.pathname).toBe("/api/v1/markets/mispriced");
    expect(calls[0]!.url.searchParams.get("sort")).toBe("spread_desc");

    await client.profileX({ handle: "@amphib0ly" });
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.url.pathname).toBe("/api/v1/x/profile");
    expect(calls[1]!.body).toMatchObject({ handle: "amphib0ly", lookback_days: 120, focus: "trading" });
  });

  it("publishes the price map the spend meter uses", () => {
    expect(QUOTIENT_CALL_COST_USD).toMatchObject({ search: 0.01, lookup: 0.005, mispriced: 0.02, profileX: 1 });
  });
});

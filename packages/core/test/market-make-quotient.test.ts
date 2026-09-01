// packages/core/test/market-make-quotient.test.ts
import { describe, expect, it } from "vitest";
import { MarketMakeQuotientClient } from "../src/quotient/market-make.js";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("MarketMakeQuotientClient", () => {
  it("preserves market identities and normalizes frozen/current probability units", async () => {
    const client = new MarketMakeQuotientClient({
      baseUrl: "https://q.test",
      token: "test",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("venue")).toBe("polymarket");
        expect(url.searchParams.get("status")).toBe("active");
        return response({ signals: [{
          id: "sig-1",
          side: "NO",
          entry_q: 30,
          entry_pm: 50,
          latest_q: 0.28,
          forecast_updated_at: "2026-08-31T00:00:00Z",
          published_at: "2026-08-30T23:00:00Z",
          is_active: true,
          suppression_reason: null,
          market: {
            venue: "polymarket",
            marketKey: "polymarket:1",
            nativeMarketId: 1,
            condition_id: "0xabc",
          },
        }] });
      },
    });
    expect(await client.activeSignals()).toMatchObject([{
      signalId: "sig-1",
      marketKey: "polymarket:1",
      nativeMarketId: "1",
      conditionId: "0xabc",
      entryQYes: 0.3,
      entryMarketYes: 0.5,
      qYes: 0.28,
    }]);
  });

  it("treats a 0–100 latest_q value as a fatal unit error", async () => {
    const client = new MarketMakeQuotientClient({
      baseUrl: "https://q.test",
      token: "test",
      fetchImpl: async () => response({ signals: [{
        id: "bad",
        side: "YES",
        entry_q: 70,
        entry_pm: 50,
        latest_q: 70,
        forecast_updated_at: "2026-08-31T00:00:00Z",
        published_at: "2026-08-31T00:00:00Z",
        is_active: true,
        market: { marketKey: "polymarket:1", nativeMarketId: "1", condition_id: "x" },
      }] }),
    });
    await expect(client.activeSignals()).rejects.toThrow(/0–1 probability units/);
  });

  it("enforces exact-forecast batches of ten", async () => {
    const client = new MarketMakeQuotientClient({
      baseUrl: "https://q.test",
      token: "test",
      fetchImpl: async () => response([]),
    });
    await expect(client.exactForecasts(Array.from({ length: 11 }, (_, i) => `polymarket:${i}`))).rejects.toThrow(
      /at most 10/,
    );
  });

  it("accepts compact status and nested exact-forecast rows", async () => {
    const client = new MarketMakeQuotientClient({
      baseUrl: "https://q.test",
      token: "test",
      fetchImpl: async () => response({ results: [{
        marketKey: "polymarket:7",
        forecast: { probability: 0.61, created_at: "2026-08-31T12:00:00Z" },
        forecast_status: "converging",
      }] }),
    });
    await expect(client.exactForecasts(["polymarket:7"])).resolves.toEqual([{
      marketKey: "polymarket:7",
      qYes: 0.61,
      forecastAt: "2026-08-31T12:00:00Z",
      forecastStatus: { state: "converging", drawdownRiskElevated: false },
    }]);
  });
});

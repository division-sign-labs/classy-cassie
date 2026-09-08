// packages/core/test/market-make-adaptive-quotient.test.ts
import { describe, expect, it, vi } from "vitest";
import { MarketMakeQuotientClient } from "../src/quotient/market-make.js";

const at = "2026-09-05T00:37:21.540Z";
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const valid = (marketKey = "polymarket:2243896") => ({
  marketKey, quotient_odds: 0.28136250044376676,
  forecast: { id: "forecast-ceasefire", probability: 0.28136250044376676, created_at: at },
  forecast_status: { state: "converged" },
});
function clientFor(body: unknown) {
  return new MarketMakeQuotientClient({ baseUrl: "https://q.test", token: "test", fetchImpl: async () => response(body) });
}

describe("adaptive market-maker exact Q inputs", () => {
  it("retains the actual forecast timestamp and id instead of newer generic metadata", async () => {
    const client = clientFor({ results: [{ ...valid(), last_updated: "2026-09-05T05:35:00Z" }] });
    await expect(client.exactForecasts(["polymarket:2243896"])).resolves.toEqual([{
      marketKey: "polymarket:2243896", qYes: 0.28136250044376676,
      forecastAt: at, forecastId: "forecast-ceasefire",
      forecastStatus: { state: "converged", drawdownRiskElevated: false },
    }]);
  });

  it("accepts an explicit forecast_at and top-level forecast id", async () => {
    const client = clientFor({ markets: [{ market_key: "polymarket:7", latest_q: 0.62, forecast_at: at, forecast_id: "q-version-7" }] });
    await expect(client.exactForecasts(["polymarket:7"])).resolves.toMatchObject([{
      marketKey: "polymarket:7", qYes: 0.62, forecastAt: at, forecastId: "q-version-7",
    }]);
  });

  it("does not treat last_updated alone as a forecast publication time", async () => {
    const client = clientFor([{ marketKey: "polymarket:7", latest_q: 0.62, last_updated: at }]);
    await expect(client.exactForecasts(["polymarket:7"])).resolves.toEqual([]);
  });

  it("isolates malformed rows while preserving every valid requested market", async () => {
    const client = clientFor({ results: [
      valid(), null, { ...valid("polymarket:2"), quotient_odds: 70 },
      { ...valid("polymarket:3"), quotient_odds: -0.1 },
      { ...valid("polymarket:4"), forecast: { created_at: "not-a-time" } },
      { ...valid("polymarket:5"), forecast_status: { state: "unknown-state" } },
      valid("polymarket:6"), valid("polymarket:unrequested"),
    ] });
    const rows = await client.exactForecasts(["polymarket:2243896", "polymarket:2", "polymarket:3", "polymarket:4", "polymarket:5", "polymarket:6"]);
    expect(rows.map((row) => row.marketKey)).toEqual(["polymarket:2243896", "polymarket:6"]);
  });

  it.each([
    { drawdown_risk_elevated: true },
    { drawdownRiskElevated: true },
    { forecast_status: { state: "warning", drawdown_risk_elevated: true }, drawdown_risk_elevated: false },
  ])("preserves an elevated flag from either supported location: %j", async (fields) => {
    const client = clientFor({ results: [{ ...valid(), ...fields }] });
    const [forecast] = await client.exactForecasts(["polymarket:2243896"]);
    expect(forecast?.forecastStatus.drawdownRiskElevated).toBe(true);
  });

  it.each([null, {}, { error: "temporary failure" }, { results: {} }, { data: "unavailable" }])(
    "rejects malformed envelopes instead of declaring no forecasts: %j", async (body) => {
      await expect(clientFor(body).exactForecasts(["polymarket:2243896"])).rejects.toThrow(/exact forecast response/);
    },
  );

  it.each([[], { results: [] }, { results: [], not_found: ["polymarket:2243896"] }])(
    "accepts explicit empty batches: %j", async (body) => {
      await expect(clientFor(body).exactForecasts(["polymarket:2243896"])).resolves.toEqual([]);
    },
  );

  it("passes a four-second abort signal and preserves authenticated batched GET terms", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let received: RequestInit | undefined;
    const client = new MarketMakeQuotientClient({
      baseUrl: "https://q.test", token: "test", fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/api/v1/markets/lookup");
        expect(url.searchParams.get("market_keys")).toBe("polymarket:2243896,polymarket:7");
        expect(url.searchParams.get("venue")).toBe("polymarket");
        received = init;
        return response({ results: [valid()] });
      },
    });
    try {
      await client.exactForecasts([" polymarket:2243896 ", "polymarket:7", "polymarket:7"]);
      expect(timeout).toHaveBeenCalledWith(4_000);
      expect(received?.signal).toBeInstanceOf(AbortSignal);
      expect(received?.headers).toMatchObject({ "x-quotient-api-key": "test" });
      expect(client.spentUsd).toBe(0.005);
    } finally { timeout.mockRestore(); }
  });

  it("keeps HTTP failures distinguishable from a successful empty batch", async () => {
    const client = new MarketMakeQuotientClient({ baseUrl: "https://q.test", token: "test", fetchImpl: async () => new Response("rate limited", { status: 429 }) });
    await expect(client.exactForecasts(["polymarket:2243896"])).rejects.toThrow(/429/);
    expect(client.spentUsd).toBe(0);
  });
});

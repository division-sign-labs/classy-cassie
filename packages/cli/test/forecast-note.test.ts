// packages/cli/test/forecast-note.test.ts

import { describe, expect, it, vi } from "vitest";
import { parseBotConfig } from "@quotient-forecasting/cassie-core";
import { latestForecastThesis } from "../src/forecast-note.js";

const TOKEN = "7132104519000000000000000000000000000000000000000000000000000001";
const CONDITION_ID = `0x${"ab".repeat(32)}`;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const config = parseBotConfig({
  id: "manual-caption",
  venue: "polymarket",
  signals: { baseUrl: "https://q.example" },
});

describe("latestForecastThesis", () => {
  it("maps the traded token through CLOB and returns the latest active published-signal thesis", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ condition_id: CONDITION_ID }))
      .mockResolvedValueOnce(
        jsonResponse({
          signals: [
            {
              id: "other-market",
              side: "YES",
              is_active: true,
              thesis: "Wrong market",
              forecast_updated_at: "2026-08-16T14:00:00Z",
              market: { venue: "polymarket", condition_id: `0x${"cd".repeat(32)}` },
            },
            {
              id: "older",
              side: "YES",
              is_active: true,
              thesis: "Older thesis",
              forecast_updated_at: "2026-08-16T12:00:00Z",
              market: { venue: "polymarket", condition_id: CONDITION_ID },
            },
            {
              id: "latest",
              side: "YES",
              is_active: true,
              thesis: "  The latest Q thesis.  ",
              forecast_updated_at: "2026-08-16T13:00:00Z",
              market: { venue: "polymarket", condition_id: CONDITION_ID },
            },
          ],
        }),
      );

    await expect(latestForecastThesis(config, TOKEN, "q-secret", fetchImpl)).resolves.toBe(
      "The latest Q thesis.",
    );

    const [clobInput, clobInit] = fetchImpl.mock.calls[0]!;
    expect(String(clobInput)).toBe(`https://clob.polymarket.com/markets-by-token/${TOKEN}`);
    expect(new Headers(clobInit?.headers).has("x-quotient-api-key")).toBe(false);

    const [signalsInput, signalsInit] = fetchImpl.mock.calls[1]!;
    const signalsUrl = new URL(String(signalsInput));
    expect(signalsUrl.href).toBe("https://q.example/api/v1/signals");
    expect([...signalsUrl.searchParams.keys()]).toEqual([]);
    expect(new Headers(signalsInit?.headers).get("x-quotient-api-key")).toBe("q-secret");
  });

  it("ignores inactive signal rows", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ conditionId: CONDITION_ID }))
      .mockResolvedValueOnce(
        jsonResponse({
          signals: [
            {
              id: "inactive",
              side: "YES",
              is_active: false,
              thesis: "Do not use",
              forecast_updated_at: "2026-08-16T14:00:00Z",
              market: { venue: "polymarket", condition_id: CONDITION_ID },
            },
            {
              id: "active",
              side: "YES",
              is_active: true,
              thesis: "Active thesis",
              forecast_updated_at: "2026-08-16T13:00:00Z",
              market: { venue: "polymarket", condition_id: CONDITION_ID },
            },
          ],
        }),
      );

    await expect(latestForecastThesis(config, TOKEN, "q-secret", fetchImpl)).resolves.toBe(
      "Active thesis",
    );
  });

  it("stops after the exact CLOB lookup when it returns no condition", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({}));

    await expect(latestForecastThesis(config, TOKEN, "q-secret", fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not substitute older lookup copy when the latest signal has no thesis", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ condition_id: CONDITION_ID }))
      .mockResolvedValueOnce(
        jsonResponse({
          signals: [
            {
              id: "older",
              side: "YES",
              is_active: true,
              thesis: "Older thesis",
              forecast_updated_at: "2026-08-16T12:00:00Z",
              market: { venue: "polymarket", condition_id: CONDITION_ID },
            },
            {
              id: "latest",
              side: "YES",
              is_active: true,
              thesis: null,
              forecast_updated_at: "2026-08-16T13:00:00Z",
              market: { venue: "polymarket", condition_id: CONDITION_ID },
            },
          ],
        }),
      );

    await expect(latestForecastThesis(config, TOKEN, "q-secret", fetchImpl)).resolves.toBeUndefined();
  });
});

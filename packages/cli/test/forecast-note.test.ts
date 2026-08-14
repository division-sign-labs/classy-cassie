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
  it("maps the traded token to a condition and returns the latest forecast thesis", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            conditionId: CONDITION_ID,
            clobTokenIds: JSON.stringify([TOKEN, "a-no-token"]),
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ forecast: { thesis: "  The latest Q thesis.  " }, bluf: "Short version" }] }),
      );

    await expect(latestForecastThesis(config, TOKEN, "q-secret", fetchImpl)).resolves.toBe(
      "The latest Q thesis.",
    );

    const [gammaInput] = fetchImpl.mock.calls[0]!;
    const gammaUrl = new URL(String(gammaInput));
    expect(gammaUrl.pathname).toBe("/markets");
    expect(gammaUrl.searchParams.get("clob_token_ids")).toBe(TOKEN);

    const [lookupInput, lookupInit] = fetchImpl.mock.calls[1]!;
    const lookupUrl = new URL(String(lookupInput));
    expect(lookupUrl.href).toBe(`https://q.example/api/v1/markets/lookup?condition_ids=${CONDITION_ID}`);
    expect(new Headers(lookupInit?.headers).get("x-quotient-api-key")).toBe("q-secret");
  });

  it("uses the lookup BLUF when the forecast has no thesis", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([{ condition_id: CONDITION_ID, clobTokenIds: [TOKEN] }]))
      .mockResolvedValueOnce(jsonResponse({ results: [{ forecast: { thesis: null }, bluf: "  Legacy BLUF  " }] }));

    await expect(latestForecastThesis(config, TOKEN, "q-secret", fetchImpl)).resolves.toBe("Legacy BLUF");
  });

  it("rejects an unfiltered Gamma row that does not contain the requested token", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([{ conditionId: CONDITION_ID, clobTokenIds: ["some-other-token"] }]));

    await expect(latestForecastThesis(config, TOKEN, "q-secret", fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

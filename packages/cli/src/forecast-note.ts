// packages/cli/src/forecast-note.ts
// Resolve the latest Quotient forecast thesis for a Polymarket YES-token id.
// This is feed copy only: failure never blocks or changes the order itself.

import { boundFetch, type BotConfig } from "@quotient-forecasting/cassie-core";

const CONDITION_ID_RE = /^0x[0-9a-fA-F]{64}$/;
const LOOKUP_TIMEOUT_MS = 15_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function clobTokenIds(value: unknown): string[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

async function conditionIdForToken(
  cfg: BotConfig,
  marketRef: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string | undefined> {
  const url = new URL("/markets", cfg.venueUrls.polymarket.gamma);
  // Gamma silently returns an unfiltered list for the camelCase spelling.
  url.searchParams.set("clob_token_ids", marketRef);
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`Polymarket market lookup failed (${response.status})`);
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) return undefined;

  for (const item of body) {
    const market = record(item);
    if (!market || !clobTokenIds(market.clobTokenIds).includes(marketRef)) continue;
    const conditionId = market.conditionId ?? market.condition_id;
    if (typeof conditionId === "string" && CONDITION_ID_RE.test(conditionId)) return conditionId;
  }
  return undefined;
}

/** Latest reviewable Q thesis, with BLUF as the API's legacy fallback. */
export async function latestForecastThesis(
  cfg: BotConfig,
  marketRef: string,
  apiToken: string,
  fetchImplementation?: typeof fetch,
): Promise<string | undefined> {
  if (cfg.venue !== "polymarket") return undefined;
  const fetchImpl = boundFetch(fetchImplementation);
  // Caption enrichment must not hold a confirmed live order indefinitely. One
  // deadline covers both remote reads, and the caller treats expiry as a skip.
  const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  const conditionId = await conditionIdForToken(cfg, marketRef, fetchImpl, signal);
  if (!conditionId) return undefined;

  const url = new URL("/api/v1/markets/lookup", cfg.signals.baseUrl);
  url.searchParams.set("condition_ids", conditionId);
  const response = await fetchImpl(url, {
    headers: { "x-quotient-api-key": apiToken, accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`Quotient forecast lookup failed (${response.status})`);
  const body = record(await response.json());
  const results = body?.results;
  const result = Array.isArray(results) ? record(results[0]) : null;
  const forecast = record(result?.forecast);
  const thesis = forecast?.thesis;
  if (typeof thesis === "string" && thesis.trim()) return thesis.trim();
  const bluf = result?.bluf;
  return typeof bluf === "string" && bluf.trim() ? bluf.trim() : undefined;
}

// packages/cli/src/forecast-note.ts
// Resolve the latest Quotient forecast thesis for a Polymarket YES-token id.
// This is feed copy only: failure never blocks or changes the order itself.

import {
  boundFetch,
  latestPublishedSignalThesis,
  type BotConfig,
} from "@quotient-forecasting/cassie-core";

const CONDITION_ID_RE = /^0x[0-9a-fA-F]{64}$/;
const LOOKUP_TIMEOUT_MS = 5_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function conditionIdForToken(
  cfg: BotConfig,
  marketRef: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string | undefined> {
  const url = new URL(
    `/markets-by-token/${encodeURIComponent(marketRef)}`,
    cfg.venueUrls.polymarket.clob,
  );
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`Polymarket market lookup failed (${response.status})`);
  const body = record(await response.json());
  const conditionId = body?.condition_id ?? body?.conditionId;
  return typeof conditionId === "string" && CONDITION_ID_RE.test(conditionId)
    ? conditionId
    : undefined;
}

/** Latest active thesis from Quotient's published-signals feed. */
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

  return latestPublishedSignalThesis(
    cfg.signals,
    conditionId,
    apiToken,
    fetchImpl,
    signal,
  );
}

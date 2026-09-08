// strategies/agent/src/cache.ts
// Per-market Quotient forecast cache. StrategyMemory is SQLite-backed, so a
// forecast is reused inside its TTL across wakes and process restarts.

import type { QuotientMarketRow, StrategyMemory } from "@quotient-forecasting/cassie-core";
import { AGENT_MEMORY_KEYS } from "./schema.js";

interface CachedForecast {
  row: QuotientMarketRow;
  fetchedAt: number;
}

export async function cachedForecast(
  memory: StrategyMemory,
  marketRef: string,
  ttlMs: number,
  now: number,
): Promise<QuotientMarketRow | undefined> {
  const hit = await memory.get<CachedForecast>(AGENT_MEMORY_KEYS.qCachePrefix + marketRef);
  if (hit && now - hit.fetchedAt <= ttlMs) return hit.row;
  return undefined;
}

export async function storeForecast(
  memory: StrategyMemory,
  marketRef: string,
  row: QuotientMarketRow,
  now: number,
): Promise<void> {
  await memory.set<CachedForecast>(AGENT_MEMORY_KEYS.qCachePrefix + marketRef, { row, fetchedAt: now });
}

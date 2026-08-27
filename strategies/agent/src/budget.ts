// strategies/agent/src/budget.ts
// Paid-call metering and the per-market Quotient forecast cache. Quotient
// calls cost cents each; the meter hard-stops enrichment at the configured
// per-wake ceiling and the cache (StrategyMemory, SQLite-backed) keeps a
// forecast from being re-bought inside its TTL.

import type { StrategyMemory } from "@quotient-forecasting/cassie-core";
import type { QuotientMarketRow } from "@quotient-forecasting/cassie-core";
import { AGENT_MEMORY_KEYS } from "./schema.js";

export class QuotientCallBudget {
  private spent = 0;
  constructor(private readonly capUsd: number) {}

  get spentUsd(): number {
    return this.spent;
  }

  canSpend(costUsd: number): boolean {
    return this.spent + costUsd <= this.capUsd + 1e-9;
  }

  spend(costUsd: number): void {
    this.spent += costUsd;
  }
}

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

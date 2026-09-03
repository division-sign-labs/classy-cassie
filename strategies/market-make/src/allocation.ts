// strategies/market-make/src/allocation.ts
// Stable two-pass category diversification and candidate priority.

import type { MarketMakeConfig } from "./schema.js";
import type { CategoryFamily, NormalizedCandidate } from "./types.js";

export function compareCandidatePriority(a: NormalizedCandidate, b: NormalizedCandidate): number {
  if (a.side !== b.side) return a.side === "NO" ? -1 : 1;
  if (a.drawdownRiskElevated !== b.drawdownRiskElevated) return a.drawdownRiskElevated ? 1 : -1;
  if (a.liveEdgePp !== b.liveEdgePp) return b.liveEdgePp - a.liveEdgePp;
  if (a.qAsOf !== b.qAsOf) return b.qAsOf - a.qAsOf;
  if (a.selectedSpreadPp !== b.selectedSpreadPp) return a.selectedSpreadPp - b.selectedSpreadPp;
  if (a.depthWithin2cUsd !== b.depthWithin2cUsd) return b.depthWithin2cUsd - a.depthWithin2cUsd;
  return a.marketKey.localeCompare(b.marketKey);
}

/**
 * Select at most one best candidate from each missing named family until the
 * target family count is reached, then fill all remaining slots by the exact
 * stable priority. "other" never earns diversity credit and no gate is relaxed.
 */
export function allocateCandidates(
  candidates: NormalizedCandidate[],
  representedFamilies: ReadonlySet<CategoryFamily>,
  availableSlots: number,
  config: MarketMakeConfig,
): NormalizedCandidate[] {
  if (availableSlots <= 0) return [];
  const ranked = [...candidates].sort(compareCandidatePriority);
  const selected: NormalizedCandidate[] = [];
  const selectedKeys = new Set<string>();
  const represented = new Set(representedFamilies);
  const target = config.diversification.target_distinct_families_when_available;
  const namedFamilyCount = (): number => [...represented].filter((family) => family !== "other").length;

  for (const candidate of ranked) {
    if (selected.length >= availableSlots || namedFamilyCount() >= target) break;
    if (candidate.categoryFamily === "other" || represented.has(candidate.categoryFamily)) continue;
    selected.push(candidate);
    selectedKeys.add(candidate.marketKey);
    represented.add(candidate.categoryFamily);
  }

  for (const candidate of ranked) {
    if (selected.length >= availableSlots) break;
    if (selectedKeys.has(candidate.marketKey)) continue;
    selected.push(candidate);
    selectedKeys.add(candidate.marketKey);
  }
  return selected;
}

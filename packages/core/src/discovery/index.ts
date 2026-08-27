// packages/core/src/discovery/index.ts
// Market discovery for the agent strategy. Until now markets only entered
// cassie as marketRefs inside Quotient signals; the agent needs to LIST open
// markets by end date / volume / category, so each prediction venue gets a
// lister over its public catalog API (Gamma for Polymarket, /markets for
// Kalshi). Read-only and unauthenticated; deliberately separate from
// SignalSource (which must never grow surface) and from VenueAdapter (whose
// contract is marketRef-driven).

import type { VenueId } from "../types.js";
import type { VenueUrls } from "../config.js";
import { PolymarketMarketLister } from "./polymarket.js";
import { KalshiMarketLister } from "./kalshi.js";

/** One discoverable market, normalized across venues. */
export interface MarketRow {
  venue: VenueId;
  /** Tradable ref: Polymarket YES CLOB token id; Kalshi ticker. */
  marketRef: string;
  /** Polymarket condition id (the Quotient lookup key for that venue). */
  conditionId?: string;
  question: string;
  category?: string;
  /** ISO close/end time. */
  endDate?: string;
  /** Approximate 24h USD volume. */
  volume24h: number;
  /** Current YES price 0–1 when the catalog provides one. */
  yesPrice?: number;
}

export interface MarketFilter {
  /** Only markets ending within this many days. */
  maxDaysToEnd?: number;
  /** Approximate 24h USD volume floor. */
  minVolume24h?: number;
  /** Case-insensitive substring match against category/question. */
  categories?: string[];
  /** Hard cap on returned rows (default 150). */
  limit?: number;
}

export interface MarketLister {
  venue: VenueId;
  list(filter: MarketFilter): Promise<MarketRow[]>;
}

export const DISCOVERY_DEFAULT_LIMIT = 150;

/** Deterministic post-filter shared by the listers (venue APIs pre-filter what they can). */
export function applyMarketFilter(rows: MarketRow[], filter: MarketFilter, nowMs: number): MarketRow[] {
  const maxEnd = filter.maxDaysToEnd !== undefined ? nowMs + filter.maxDaysToEnd * 86_400_000 : undefined;
  const categories = (filter.categories ?? []).map((c) => c.toLowerCase()).filter(Boolean);
  return rows
    .filter((row) => {
      if (filter.minVolume24h !== undefined && row.volume24h < filter.minVolume24h) return false;
      if (maxEnd !== undefined) {
        const end = row.endDate ? Date.parse(row.endDate) : NaN;
        if (!Number.isFinite(end) || end > maxEnd || end < nowMs) return false;
      }
      if (categories.length > 0) {
        const haystack = `${row.category ?? ""} ${row.question}`.toLowerCase();
        if (!categories.some((c) => haystack.includes(c))) return false;
      }
      return true;
    })
    .slice(0, filter.limit ?? DISCOVERY_DEFAULT_LIMIT);
}

export function createMarketLister(venue: VenueId, urls: VenueUrls, fetchImpl?: typeof fetch): MarketLister {
  if (venue === "polymarket") return new PolymarketMarketLister(urls.polymarket.gamma, fetchImpl);
  if (venue === "kalshi") return new KalshiMarketLister(urls.kalshi.demo ? urls.kalshi.demoApi : urls.kalshi.api, fetchImpl);
  throw new Error(`market discovery is not available for venue "${venue}" — the agent strategy runs on prediction venues`);
}

// packages/core/src/discovery/kalshi.ts
// Kalshi catalog listing via the public (unauthenticated) markets endpoint.
// Base URL comes from venueUrls.kalshi so demo bots discover demo markets.
// volume_24h is a contract count; USD volume is approximated as contracts ×
// mid, mirroring the adapter's quote() convention.

import { z } from "zod";
import { boundFetch } from "../http.js";
import {
  DISCOVERY_DEFAULT_LIMIT,
  applyMarketFilter,
  type MarketFilter,
  type MarketLister,
  type MarketRow,
} from "./index.js";

// Post fixed-point migration (2026-03): prices are *_dollars strings, counts
// are *_fp strings; the legacy integer-cent fields are tolerated as fallback.
const KalshiMarketSchema = z
  .object({
    ticker: z.string().nullish(),
    title: z.string().nullish(),
    close_time: z.string().nullish(),
    volume_24h_fp: z.union([z.string(), z.number()]).nullish(),
    yes_bid_dollars: z.union([z.string(), z.number()]).nullish(),
    yes_ask_dollars: z.union([z.string(), z.number()]).nullish(),
    volume_24h: z.number().nullish(),
    yes_bid: z.number().nullish(),
    yes_ask: z.number().nullish(),
    category: z.string().nullish(),
    status: z.string().nullish(),
    /** Multivariate combo shards flood the catalog with unusable rows. */
    is_provisional: z.boolean().nullish(),
    mve_collection_ticker: z.string().nullish(),
  })
  .loose();

function fp(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

const MAX_PAGES = 5;

export class KalshiMarketLister implements MarketLister {
  readonly venue = "kalshi" as const;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiBase: string, fetchImpl?: typeof fetch) {
    this.apiBase = apiBase.replace(/\/$/, "");
    this.fetchImpl = boundFetch(fetchImpl);
  }

  async list(filter: MarketFilter): Promise<MarketRow[]> {
    const rows: MarketRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${this.apiBase}/markets`);
      url.searchParams.set("status", "open");
      url.searchParams.set("limit", "200");
      if (filter.maxDaysToEnd !== undefined) {
        url.searchParams.set("max_close_ts", String(Math.floor((Date.now() + filter.maxDaysToEnd * 86_400_000) / 1000)));
      }
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await this.fetchImpl(url.toString(), { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`kalshi markets listing → ${res.status}`);
      const body = (await res.json()) as { markets?: unknown[]; cursor?: string };

      for (const raw of body.markets ?? []) {
        const parsed = KalshiMarketSchema.safeParse(raw);
        if (!parsed.success) continue;
        const m = parsed.data;
        if (!m.ticker || !m.title) continue;
        // Skip provisional multivariate combo shards — auto-generated parlay
        // legs with concatenated titles and no organic liquidity.
        if (m.is_provisional === true || m.mve_collection_ticker) continue;
        const bid = m.yes_bid_dollars !== undefined && m.yes_bid_dollars !== null ? fp(m.yes_bid_dollars) : (m.yes_bid ?? 0) / 100;
        const ask = m.yes_ask_dollars !== undefined && m.yes_ask_dollars !== null ? fp(m.yes_ask_dollars) : (m.yes_ask ?? 100) / 100;
        const mid = (bid + ask) / 2;
        const contracts = m.volume_24h_fp !== undefined && m.volume_24h_fp !== null ? fp(m.volume_24h_fp) : (m.volume_24h ?? 0);
        rows.push({
          venue: "kalshi",
          marketRef: m.ticker,
          question: m.title,
          category: m.category ?? undefined,
          endDate: m.close_time ?? undefined,
          volume24h: contracts * (mid > 0 ? mid : 0.5),
          yesPrice: mid,
        });
      }
      cursor = body.cursor || undefined;
      if (!cursor || rows.length >= (filter.limit ?? DISCOVERY_DEFAULT_LIMIT) * 3) break;
    }
    return applyMarketFilter(rows, filter, Date.now());
  }
}

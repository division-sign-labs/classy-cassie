// packages/core/src/discovery/polymarket.ts
// Polymarket catalog listing via the public Gamma API. Gamma's query params
// are snake_case (camelCase filter params are silently ignored and return an
// unfiltered list — the same trap the adapter's volume lookup documents), and
// several row fields (clobTokenIds, outcomePrices) arrive as JSON-encoded
// strings that need a second parse.

import { z } from "zod";
import { boundFetch } from "../http.js";
import {
  DISCOVERY_DEFAULT_LIMIT,
  applyMarketFilter,
  type MarketFilter,
  type MarketLister,
  type MarketRow,
} from "./index.js";

const GammaRowSchema = z
  .object({
    question: z.string().nullish(),
    conditionId: z.string().nullish(),
    /** JSON-encoded string array, YES token first by convention. */
    clobTokenIds: z.union([z.string(), z.array(z.string())]).nullish(),
    endDate: z.string().nullish(),
    volume24hr: z.union([z.number(), z.string()]).nullish(),
    outcomePrices: z.union([z.string(), z.array(z.union([z.string(), z.number()]))]).nullish(),
    category: z.string().nullish(),
    closed: z.boolean().nullish(),
    active: z.boolean().nullish(),
  })
  .loose();

function firstToken(clobTokenIds: z.output<typeof GammaRowSchema>["clobTokenIds"]): string | undefined {
  try {
    const list = typeof clobTokenIds === "string" ? (JSON.parse(clobTokenIds) as unknown[]) : clobTokenIds;
    const first = Array.isArray(list) ? list[0] : undefined;
    return typeof first === "string" && first ? first : undefined;
  } catch {
    return undefined;
  }
}

function yesPrice(outcomePrices: z.output<typeof GammaRowSchema>["outcomePrices"]): number | undefined {
  try {
    const list = typeof outcomePrices === "string" ? (JSON.parse(outcomePrices) as unknown[]) : outcomePrices;
    const first = Array.isArray(list) ? Number(list[0]) : NaN;
    return Number.isFinite(first) ? first : undefined;
  } catch {
    return undefined;
  }
}

export class PolymarketMarketLister implements MarketLister {
  readonly venue = "polymarket" as const;
  private readonly gammaBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(gammaBase: string, fetchImpl?: typeof fetch) {
    this.gammaBase = gammaBase.replace(/\/$/, "");
    this.fetchImpl = boundFetch(fetchImpl);
  }

  async list(filter: MarketFilter): Promise<MarketRow[]> {
    const url = new URL(`${this.gammaBase}/markets`);
    url.searchParams.set("closed", "false");
    url.searchParams.set("active", "true");
    url.searchParams.set("order", "volume24hr");
    url.searchParams.set("ascending", "false");
    url.searchParams.set("limit", String(Math.min(500, (filter.limit ?? DISCOVERY_DEFAULT_LIMIT) * 3)));
    if (filter.maxDaysToEnd !== undefined) {
      url.searchParams.set("end_date_max", new Date(Date.now() + filter.maxDaysToEnd * 86_400_000).toISOString());
    }
    if (filter.minVolume24h !== undefined) {
      url.searchParams.set("volume_num_min", String(filter.minVolume24h));
    }

    const res = await this.fetchImpl(url.toString(), { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`gamma markets listing → ${res.status}`);
    const body = (await res.json()) as unknown;
    const rawRows = Array.isArray(body) ? body : [];

    const rows: MarketRow[] = [];
    for (const raw of rawRows) {
      const parsed = GammaRowSchema.safeParse(raw);
      if (!parsed.success) continue;
      const r = parsed.data;
      const marketRef = firstToken(r.clobTokenIds);
      if (!marketRef || !r.question || r.closed === true) continue;
      rows.push({
        venue: "polymarket",
        marketRef,
        conditionId: r.conditionId ?? undefined,
        question: r.question,
        category: r.category ?? undefined,
        endDate: r.endDate ?? undefined,
        volume24h: Number(r.volume24hr ?? 0) || 0,
        yesPrice: yesPrice(r.outcomePrices),
      });
    }
    // Gamma pre-filters best-effort; the deterministic filter is authoritative.
    return applyMarketFilter(rows, filter, Date.now());
  }
}

// packages/core/src/quotient/research.ts
// Quotient gateway research client for the agent strategy: market search,
// batched forecast lookups, the mispriced feed, and X persona profiling.
// Same gateway + x-quotient-api-key header as signals/index.ts (endpoints
// verified against the gateway's live OpenAPI, v13.8.0, on 2026-08-22).
//
// Discipline shared with SignalSource (see the HARD RULE there): methods take
// market-scope parameters only. No account state — P&L, balances, sizes,
// budgets — ever flows toward the Quotient API.
//
// Every call is billed (cents; profiles $1), so callers meter usage: batch
// lookups (up to 10 refs per call), cache results, and reuse a stored persona
// instead of re-profiling.

import { z } from "zod";
import { boundFetch } from "../http.js";

/** Per-call prices, USD — used by the strategy's per-wake spend meter. */
export const QUOTIENT_CALL_COST_USD = {
  search: 0.01,
  lookup: 0.005,
  mispriced: 0.02,
  signals: 0.01,
  profileX: 1.0,
} as const;

export const QUOTIENT_LOOKUP_BATCH_LIMIT = 10;

/** Lenient row shape: unknown fields pass through, malformed rows are skipped. */
export const QuotientMarketRowSchema = z
  .object({
    marketKey: z.string().nullish(),
    market_key: z.string().nullish(),
    question: z.string().nullish(),
    title: z.string().nullish(),
    venue: z.string().nullish(),
    market_odds: z.number().nullish(),
    latest_q_probability: z.number().nullish(),
    thesis: z.string().nullish(),
    forecast_at: z.string().nullish(),
    has_forecast: z.boolean().nullish(),
    has_published_signal: z.boolean().nullish(),
    spread_pp: z.number().nullish(),
    end_date: z.string().nullish(),
    condition_id: z.string().nullish(),
    nativeMarketId: z.string().nullish(),
  })
  .loose();

export interface QuotientMarketRow {
  marketKey?: string;
  question?: string;
  venue?: string;
  marketOdds?: number;
  qProbability?: number;
  thesis?: string;
  forecastAt?: string;
  hasForecast?: boolean;
  spreadPp?: number;
  endDate?: string;
  conditionId?: string;
  nativeMarketId?: string;
}

function mapRow(raw: unknown): QuotientMarketRow | null {
  const parsed = QuotientMarketRowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  return {
    marketKey: r.marketKey ?? r.market_key ?? undefined,
    question: r.question ?? r.title ?? undefined,
    venue: r.venue ?? undefined,
    marketOdds: r.market_odds ?? undefined,
    qProbability: r.latest_q_probability ?? undefined,
    thesis: r.thesis ?? undefined,
    forecastAt: r.forecast_at ?? undefined,
    hasForecast: r.has_forecast ?? undefined,
    spreadPp: r.spread_pp ?? undefined,
    endDate: r.end_date ?? undefined,
    conditionId: r.condition_id ?? undefined,
    nativeMarketId: r.nativeMarketId ?? undefined,
  };
}

function extractRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    for (const key of ["markets", "results", "rows", "items", "data"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}

export interface QuotientResearchOpts {
  /** Gateway base, from config.signals.baseUrl. */
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class QuotientResearchClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  /** Credits remaining per the last response header, when the gateway sends one. */
  creditsRemaining?: number;

  constructor(opts: QuotientResearchOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.fetchImpl = boundFetch(opts.fetchImpl);
  }

  private async request(method: "GET" | "POST", path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const res = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        "x-quotient-api-key": this.token,
        accept: "application/json",
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const credits = Number(res.headers.get("x-billing-credits-remaining"));
    if (Number.isFinite(credits)) this.creditsRemaining = credits;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`quotient ${method} ${url.pathname} → ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }
    return res.json();
  }

  /** Full-text market search, venue-filterable ($0.01/call). */
  async searchMarkets(params: { q: string; venue?: string; limit?: number }): Promise<QuotientMarketRow[]> {
    const body = await this.request("GET", "/api/v1/markets/search", {
      query: { q: params.q, venue: params.venue, limit: params.limit },
    });
    return extractRows(body).map(mapRow).filter((r): r is QuotientMarketRow => r !== null);
  }

  /** Q-versus-venue mispricing feed ($0.02/call). */
  async mispriced(params: { venue?: string; minSpread?: number; limit?: number } = {}): Promise<QuotientMarketRow[]> {
    const body = await this.request("GET", "/api/v1/markets/mispriced", {
      query: { venue: params.venue, min_spread: params.minSpread, sort: "spread_desc", limit: params.limit },
    });
    return extractRows(body).map(mapRow).filter((r): r is QuotientMarketRow => r !== null);
  }

  /**
   * Batched forecast lookup ($0.005/call, up to 10 refs per call — the caller
   * gets automatic chunking; never loop one call per market).
   */
  async lookup(params: { marketKeys?: string[]; conditionIds?: string[]; venue?: string }): Promise<QuotientMarketRow[]> {
    const keys = params.marketKeys ?? [];
    const conditions = params.conditionIds ?? [];
    const out: QuotientMarketRow[] = [];
    const chunks: Array<{ market_keys?: string; condition_ids?: string }> = [];
    for (let i = 0; i < keys.length; i += QUOTIENT_LOOKUP_BATCH_LIMIT) {
      chunks.push({ market_keys: keys.slice(i, i + QUOTIENT_LOOKUP_BATCH_LIMIT).join(",") });
    }
    for (let i = 0; i < conditions.length; i += QUOTIENT_LOOKUP_BATCH_LIMIT) {
      chunks.push({ condition_ids: conditions.slice(i, i + QUOTIENT_LOOKUP_BATCH_LIMIT).join(",") });
    }
    for (const chunk of chunks) {
      const body = await this.request("GET", "/api/v1/markets/lookup", {
        query: { ...chunk, venue: params.venue },
      });
      out.push(...extractRows(body).map(mapRow).filter((r): r is QuotientMarketRow => r !== null));
    }
    return out;
  }

  /** Number of billed lookup calls a ref list will cost — for the spend meter. */
  lookupCallCount(refCount: number): number {
    return Math.ceil(refCount / QUOTIENT_LOOKUP_BATCH_LIMIT);
  }

  /**
   * Psychographic profile of one X account ($1.00/call). Callers persist the
   * result and reuse it; the CLI confirms the charge before every call.
   */
  async profileX(params: { handle: string; lookbackDays?: number; focus?: "general" | "trading" | "reasoning" }): Promise<unknown> {
    return this.request("POST", "/api/v1/x/profile", {
      body: {
        handle: params.handle.replace(/^@/, ""),
        lookback_days: params.lookbackDays ?? 120,
        focus: params.focus ?? "trading",
      },
    });
  }
}

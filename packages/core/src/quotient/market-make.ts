// packages/core/src/quotient/market-make.ts
// Typed, market-scoped Quotient reads for deterministic market making.

import { z } from "zod";
import { boundFetch } from "../http.js";
import { QUOTIENT_CALL_COST_USD, QUOTIENT_LOOKUP_BATCH_LIMIT } from "./research.js";

const ForecastStateSchema = z.enum([
  "converged",
  "converging",
  "sideways",
  "diverging",
  "caution",
  "warning",
]);

const ForecastStatusObjectSchema = z
  .object({
    state: ForecastStateSchema.nullish(),
    drawdown_risk_elevated: z.boolean().nullish(),
    drawdownRiskElevated: z.boolean().nullish(),
  })
  .loose();
const ForecastStatusSchema = z.union([ForecastStateSchema, ForecastStatusObjectSchema]).nullish();

const MarketSchema = z
  .object({
    marketKey: z.string().nullish(),
    market_key: z.string().nullish(),
    nativeMarketId: z.union([z.string(), z.number()]).nullish(),
    native_market_id: z.union([z.string(), z.number()]).nullish(),
    condition_id: z.string().nullish(),
    conditionId: z.string().nullish(),
    venue: z.string().nullish(),
    market_odds: z.number().nullish(),
  })
  .loose();

const MarketMakeSignalRowSchema = z
  .object({
    id: z.string(),
    side: z.enum(["YES", "NO"]),
    entry_q: z.number().nullish(),
    entry_pm: z.number().nullish(),
    latest_q: z.number().nullish(),
    forecast_updated_at: z.string().nullish(),
    published_at: z.string().nullish(),
    is_active: z.boolean().nullish(),
    status: z.string().nullish(),
    suppression_reason: z.string().nullish(),
    retired_reason: z.string().nullish(),
    q_side: z.string().nullish(),
    forecast_status: ForecastStatusSchema,
    venue_quote: z
      .object({
        selected_probability: z.number().nullish(),
        observed_at: z.string().nullish(),
      })
      .loose()
      .nullish(),
    market: MarketSchema,
  })
  .loose();

const LookupRowSchema = z
  .object({
    marketKey: z.string().nullish(),
    market_key: z.string().nullish(),
    latest_q: z.number().nullish(),
    latest_q_probability: z.number().nullish(),
    quotient_odds: z.number().nullish(),
    forecast_at: z.string().nullish(),
    last_updated: z.string().nullish(),
    retired_reason: z.string().nullish(),
    forecast_status: ForecastStatusSchema,
    forecast: z
      .object({
        probability: z.number().nullish(),
        created_at: z.string().nullish(),
      })
      .loose()
      .nullish(),
  })
  .loose();

export interface MarketMakeForecastStatus {
  state?: z.output<typeof ForecastStateSchema>;
  drawdownRiskElevated: boolean;
}

export interface MarketMakeSignalRow {
  signalId: string;
  marketKey: string;
  nativeMarketId: string;
  conditionId: string;
  publishedAt: string;
  forecastAt: string;
  entryQYes: number;
  entryMarketYes: number;
  qYes: number;
  publishedSide: "YES" | "NO";
  isActive: boolean;
  status?: string;
  suppressionReason?: string;
  retiredReason?: string;
  qSide?: "YES" | "NO";
  discoveryQuote?: number;
  discoveryQuoteAt?: string;
  forecastStatus: MarketMakeForecastStatus;
}

export interface MarketMakeExactForecast {
  marketKey: string;
  qYes: number;
  forecastAt: string;
  retiredReason?: string;
  forecastStatus: MarketMakeForecastStatus;
}

function rowsFrom(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body !== "object" || body === null) return [];
  const record = body as Record<string, unknown>;
  for (const key of ["signals", "markets", "results", "rows", "items", "data"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function probability01(label: string, value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must use 0–1 probability units`);
  }
  return value;
}

function probability100(label: string, value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} must use 0–100 percentage units`);
  }
  return value / 100;
}

function required(label: string, value: string | null | undefined): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function statusOf(value: z.output<typeof ForecastStatusSchema>): MarketMakeForecastStatus {
  if (typeof value === "string") return { state: value, drawdownRiskElevated: false };
  return {
    ...(value?.state ? { state: value.state } : {}),
    drawdownRiskElevated: value?.drawdown_risk_elevated ?? value?.drawdownRiskElevated ?? false,
  };
}

function mapSignal(raw: unknown): MarketMakeSignalRow | null {
  const parsed = MarketMakeSignalRowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;
  const venue = row.market.venue ?? "polymarket";
  if (!venue.startsWith("polymarket")) return null;
  const latestSide = row.q_side?.toUpperCase();
  return {
    signalId: row.id,
    marketKey: required("market.marketKey", row.market.marketKey ?? row.market.market_key),
    nativeMarketId: required(
      "market.nativeMarketId",
      row.market.nativeMarketId === null || row.market.nativeMarketId === undefined
        ? row.market.native_market_id === null || row.market.native_market_id === undefined
          ? undefined
          : String(row.market.native_market_id)
        : String(row.market.nativeMarketId),
    ),
    conditionId: required("market.condition_id", row.market.condition_id ?? row.market.conditionId),
    publishedAt: required("published_at", row.published_at),
    forecastAt: required("forecast_updated_at", row.forecast_updated_at),
    entryQYes: probability100("entry_q", row.entry_q),
    entryMarketYes: probability100("entry_pm", row.entry_pm),
    qYes: probability01("latest_q", row.latest_q),
    publishedSide: row.side,
    isActive: row.is_active === true,
    ...(row.status ? { status: row.status } : {}),
    ...(row.suppression_reason ? { suppressionReason: row.suppression_reason } : {}),
    ...(row.retired_reason ? { retiredReason: row.retired_reason } : {}),
    ...(latestSide === "YES" || latestSide === "NO" ? { qSide: latestSide } : {}),
    ...(row.venue_quote?.selected_probability === null || row.venue_quote?.selected_probability === undefined
      ? {}
      : { discoveryQuote: probability01("venue_quote.selected_probability", row.venue_quote.selected_probability) }),
    ...(row.venue_quote?.observed_at ? { discoveryQuoteAt: row.venue_quote.observed_at } : {}),
    forecastStatus: statusOf(row.forecast_status),
  };
}

export interface MarketMakeQuotientClientOptions {
  baseUrl: string;
  signalsPath?: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class MarketMakeQuotientClient {
  readonly #baseUrl: string;
  readonly #signalsPath: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  #spentUsd = 0;

  constructor(options: MarketMakeQuotientClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#signalsPath = options.signalsPath ?? "/api/v1/signals";
    this.#token = options.token;
    this.#fetch = boundFetch(options.fetchImpl);
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }

  async #get(path: string, query: Record<string, string | number>): Promise<unknown> {
    const url = new URL(this.#baseUrl + path);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const response = await this.#fetch(url, {
      headers: { "x-quotient-api-key": this.#token, accept: "application/json" },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`quotient GET ${url.pathname} → ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }
    return response.json();
  }

  async activeSignals(limit = 500): Promise<MarketMakeSignalRow[]> {
    const body = await this.#get(this.#signalsPath, { venue: "polymarket", status: "active", limit });
    this.#spentUsd += QUOTIENT_CALL_COST_USD.signals;
    const out: MarketMakeSignalRow[] = [];
    for (const raw of rowsFrom(body)) {
      const row = mapSignal(raw);
      if (row) out.push(row);
    }
    return out;
  }

  async exactForecasts(marketKeys: string[]): Promise<MarketMakeExactForecast[]> {
    const keys = [...new Set(marketKeys.map((key) => key.trim()).filter(Boolean))];
    if (keys.length > QUOTIENT_LOOKUP_BATCH_LIMIT) {
      throw new Error(`exact forecast lookup accepts at most ${QUOTIENT_LOOKUP_BATCH_LIMIT} market keys`);
    }
    if (keys.length === 0) return [];
    const body = await this.#get("/api/v1/markets/lookup", {
      market_keys: keys.join(","),
      venue: "polymarket",
    });
    this.#spentUsd += QUOTIENT_CALL_COST_USD.lookup;
    return rowsFrom(body).flatMap((raw) => {
      const parsed = LookupRowSchema.safeParse(raw);
      if (!parsed.success) return [];
      const row = parsed.data;
      const marketKey = row.marketKey ?? row.market_key;
      const q = row.latest_q_probability ?? row.quotient_odds ?? row.latest_q ?? row.forecast?.probability;
      const at = row.forecast_at ?? row.last_updated ?? row.forecast?.created_at;
      if (!marketKey || !at) return [];
      return [{
        marketKey,
        qYes: probability01("exact forecast probability", q),
        forecastAt: at,
        ...(row.retired_reason ? { retiredReason: row.retired_reason } : {}),
        forecastStatus: statusOf(row.forecast_status),
      }];
    });
  }
}

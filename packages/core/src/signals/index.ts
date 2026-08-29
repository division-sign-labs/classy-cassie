// packages/core/src/signals/index.ts
// Quotient signal client. Two sources behind SignalSource: live | fixture.
// HARD RULE enforced by this type surface: nothing here accepts account state.
// The live client sends only the API key header and market-scope query params.
//
// Live contract (verified against the running gateway on 2026-08-13):
//   GET {gateway}/api/v1/signals  with header  x-quotient-api-key: <token>
//   → { signals: [{ id, side, latest_q, current_cost_cents, entry_spread_pp,
//        forecast_updated_at, published_at, is_active, thesis,
//        market: { venue, condition_id, volume_24h, … }, … }] }
// The operator obtains a key at quotient.social; the quotient-api skill / CLI
// is a separate product surface — cassie only consumes this one read endpoint.

import { z } from "zod";
import type {
  ForecastQuery,
  MarketForecast,
  Signal,
  SignalQuery,
  SignalSource,
  VenueId,
} from "../types.js";
import { DEFAULT_SIGNAL_MAX_AGE_SEC, type SignalsConfig } from "../config.js";
import { boundFetch } from "../http.js";
import { QuotientResearchClient } from "../quotient/research.js";

export const SignalSchema = z.object({
  id: z.string(),
  ts: z.string(),
  venue: z.enum(["polymarket", "kalshi", "hyperliquid", "lighter", "fixture"]),
  marketRef: z.string(),
  side: z.enum(["YES", "NO", "LONG", "SHORT"]),
  prob: z.number().min(0).max(1).optional(),
  refPrice: z.number(),
  spreadPp: z.number().optional(),
  ttlSec: z.number().positive(),
});

export function isSignalFresh(sig: Signal, nowMs: number): boolean {
  const born = Date.parse(sig.ts);
  if (Number.isNaN(born)) return false;
  return nowMs - born <= sig.ttlSec * 1000;
}

/** Re-express a published signal as Q's YES forecast for held-position checks. */
export function marketForecastFromSignal(sig: Signal): MarketForecast | null {
  if (sig.prob === undefined) return null;
  const probYes = sig.side === "YES" ? sig.prob : sig.side === "NO" ? 1 - sig.prob : undefined;
  if (probYes === undefined) return null;
  return {
    id: sig.id,
    ts: sig.ts,
    venue: sig.venue,
    marketRef: sig.marketRef,
    probYes,
  };
}

// ---------------------------------------------------------------------------
// Live source — the Quotient gateway's published-signals feed
// ---------------------------------------------------------------------------

type LiveSignalConfig = Pick<SignalsConfig, "baseUrl" | "path"> &
  Partial<Pick<SignalsConfig, "maxAgeSec">>;

const GatewaySignalSchema = z.object({
  id: z.string(),
  side: z.enum(["YES", "NO"]),
  latest_q: z.number().min(0).max(1).nullish(),
  q_value_cents: z.number().nullish(),
  current_cost_cents: z.number().nullish(),
  entry_pm: z.number().nullish(),
  entry_spread_pp: z.number().nullish(),
  forecast_updated_at: z.string().nullish(),
  published_at: z.string().nullish(),
  is_active: z.boolean().nullish(),
  status: z.string().nullish(),
  thesis: z.string().nullish(),
  market: z
    .object({
      venue: z.string().nullish(),
      condition_id: z.string().nullish(),
      nativeMarketId: z.string().nullish(),
    })
    .nullish(),
});

const GatewayResponseSchema = z.object({ signals: z.array(z.unknown()) });

async function fetchGatewayRows(
  cfg: Pick<SignalsConfig, "baseUrl" | "path">,
  token: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const url = new URL(cfg.path, cfg.baseUrl);
  const res = await fetchImpl(url.toString(), {
    headers: { "x-quotient-api-key": token, accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    throw new Error(`signal API ${res.status} ${res.statusText} for ${url.pathname}`);
  }
  return GatewayResponseSchema.parse(await res.json()).signals;
}

/** Latest active published-signal thesis for one Polymarket condition. */
export async function latestPublishedSignalThesis(
  cfg: Pick<SignalsConfig, "baseUrl" | "path">,
  conditionId: string,
  token: string,
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const rows = await fetchGatewayRows(cfg, token, boundFetch(fetchImpl), signal);
  const matches = rows
    .map((row) => GatewaySignalSchema.safeParse(row))
    .filter((result) => result.success)
    .map((result) => result.data)
    .filter(
      (row) =>
        row.is_active !== false &&
        row.market?.venue?.startsWith("polymarket") === true &&
        row.market.condition_id?.toLowerCase() === conditionId.toLowerCase(),
    )
    .sort((a, b) => signalTimestamp(b) - signalTimestamp(a));

  const thesis = matches[0]?.thesis;
  return typeof thesis === "string" && thesis.trim() ? thesis.trim() : undefined;
}

function signalTimestamp(row: z.output<typeof GatewaySignalSchema>): number {
  const value = Date.parse(row.forecast_updated_at ?? row.published_at ?? "");
  return Number.isNaN(value) ? 0 : value;
}

/** Read-only credential preflight: authenticate and validate the feed envelope. */
export async function checkLiveSignalAccess(
  cfg: Pick<SignalsConfig, "baseUrl" | "path">,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<{ count: number }> {
  const rows = await fetchGatewayRows(cfg, token, boundFetch(fetchImpl));
  return { count: rows.length };
}

export class LiveSignalSource implements SignalSource {
  /** condition_id → YES-token CLOB id (marketRef per the signal contract). */
  readonly #tokenCache = new Map<string, string>();
  /** YES-token marketRef → Quotient's stable Polymarket marketKey. */
  readonly #marketKeyCache = new Map<string, string>();
  readonly #cfg: Pick<SignalsConfig, "baseUrl" | "path" | "maxAgeSec">;
  readonly #token: string;
  readonly #fetchImpl: typeof fetch;
  readonly #clobBase: string;
  readonly #gammaBase: string;
  readonly #research: QuotientResearchClient;

  constructor(
    cfg: LiveSignalConfig,
    token: string,
    fetchImpl?: typeof fetch,
    clobBase = "https://clob.polymarket.com",
    gammaBase = "https://gamma-api.polymarket.com",
  ) {
    this.#cfg = { ...cfg, maxAgeSec: cfg.maxAgeSec ?? DEFAULT_SIGNAL_MAX_AGE_SEC };
    this.#token = token;
    this.#fetchImpl = boundFetch(fetchImpl);
    this.#clobBase = clobBase;
    this.#gammaBase = gammaBase;
    this.#research = new QuotientResearchClient({
      baseUrl: cfg.baseUrl,
      token,
      fetchImpl: this.#fetchImpl,
    });
  }

  async latest(query: SignalQuery): Promise<Signal[]> {
    const rows = await fetchGatewayRows(this.#cfg, this.#token, this.#fetchImpl);
    const out: Signal[] = [];
    for (const raw of rows) {
      const parsed = GatewaySignalSchema.safeParse(raw);
      if (!parsed.success) continue;
      const sig = await mapGatewayRow(
        parsed.data,
        (conditionId) => resolveYesToken(conditionId, this.#tokenCache, this.#fetchImpl, this.#clobBase),
        this.#cfg.maxAgeSec,
      );
      if (!sig) continue;
      if (query.venue && sig.venue !== query.venue) continue;
      if (query.marketRef && sig.marketRef !== query.marketRef) continue;
      out.push(sig);
    }
    return out;
  }

  /**
   * Latest Q forecasts for held markets. This is deliberately independent of
   * the published-signal feed: signal publication gates entries, never exits.
   */
  async forecasts(query: ForecastQuery): Promise<MarketForecast[]> {
    const marketRefs = [...new Set(query.marketRefs.filter(Boolean))];
    if (marketRefs.length === 0) return [];

    if (query.venue === "polymarket") {
      const resolved = await Promise.all(
        marketRefs.map(async (marketRef) => ({
          marketRef,
          marketKey: await resolvePolymarketMarketKey(
            marketRef,
            this.#marketKeyCache,
            this.#fetchImpl,
            this.#gammaBase,
          ),
        })),
      );
      const byKey = new Map(
        resolved
          .filter((row): row is { marketRef: string; marketKey: string } => Boolean(row.marketKey))
          .map((row) => [row.marketKey.toLowerCase(), row.marketRef]),
      );
      if (byKey.size === 0) return [];
      const rows = await this.#research.lookup({
        marketKeys: [...byKey.keys()],
        venue: "polymarket",
      });
      return rows.flatMap((row) => {
        const marketKey = row.marketKey?.toLowerCase();
        const marketRef = marketKey ? byKey.get(marketKey) : undefined;
        if (!marketRef || row.qProbability === undefined) return [];
        return [{
          id: row.marketKey ?? "forecast:" + marketRef,
          ts: row.forecastAt ?? new Date(0).toISOString(),
          venue: "polymarket" as const,
          marketRef,
          probYes: row.qProbability,
        }];
      });
    }

    if (query.venue === "kalshi") {
      const wanted = new Set(marketRefs);
      const rows = await this.#research.lookup({
        marketKeys: marketRefs.map((marketRef) => "kalshi:" + marketRef),
        venue: "kalshi",
      });
      return rows.flatMap((row) => {
        const marketRef = row.nativeMarketId ?? row.marketKey?.replace(/^kalshi:/, "");
        if (!marketRef || !wanted.has(marketRef) || row.qProbability === undefined) return [];
        return [{
          id: row.marketKey ?? "forecast:" + marketRef,
          ts: row.forecastAt ?? new Date(0).toISOString(),
          venue: "kalshi" as const,
          marketRef,
          probYes: row.qProbability,
        }];
      });
    }

    return [];
  }
}

async function mapGatewayRow(
  g: z.output<typeof GatewaySignalSchema>,
  resolveToken: (conditionId: string) => Promise<string | null>,
  ttlSec: number,
): Promise<Signal | null> {
  if (g.is_active === false) return null;
  const venue = mapVenue(g.market?.venue);
  if (!venue) return null;

  let marketRef: string | null = null;
  if (venue === "polymarket") {
    marketRef = g.market?.condition_id ? await resolveToken(g.market.condition_id) : null;
  } else {
    marketRef = g.market?.nativeMarketId ?? null;
  }
  if (!marketRef) return null;

  // latest_q is Q's YES probability; express prob/refPrice for the signaled side.
  const qYes = g.latest_q ?? (g.q_value_cents != null ? g.q_value_cents / 100 : undefined);
  const prob = qYes === undefined ? undefined : g.side === "YES" ? qYes : 1 - qYes;
  const costCents = g.current_cost_cents ?? g.entry_pm;
  if (costCents == null) return null;
  const refPrice = costCents / 100;
  const spreadPp = prob !== undefined ? Math.abs(prob * 100 - costCents) : (g.entry_spread_pp ?? undefined);

  return {
    id: g.id,
    ts: g.forecast_updated_at ?? g.published_at ?? new Date(0).toISOString(),
    venue,
    marketRef,
    side: g.side,
    prob,
    refPrice,
    spreadPp,
    ttlSec,
  };
}

/** Resolve a Polymarket condition_id to its YES-token CLOB id (cached, public endpoint). */
async function resolveYesToken(
  conditionId: string,
  cache: Map<string, string>,
  fetchImpl: typeof fetch,
  clobBase: string,
): Promise<string | null> {
  const cached = cache.get(conditionId);
  if (cached) return cached;
  try {
    const res = await fetchImpl(`${clobBase}/markets/${conditionId}`);
    if (!res.ok) return null;
    const m = (await res.json()) as { tokens?: { token_id?: string; outcome?: string }[] };
    const yes = m.tokens?.find((t) => t.outcome?.toLowerCase() === "yes") ?? m.tokens?.[0];
    if (!yes?.token_id) return null;
    cache.set(conditionId, yes.token_id);
    return yes.token_id;
  } catch {
    return null;
  }
}

/** Resolve a YES-token marketRef to Quotient's Polymarket marketKey (cached). */
async function resolvePolymarketMarketKey(
  marketRef: string,
  cache: Map<string, string>,
  fetchImpl: typeof fetch,
  gammaBase: string,
): Promise<string | null> {
  const cached = cache.get(marketRef);
  if (cached) return cached;
  try {
    const url = new URL("/markets", gammaBase);
    url.searchParams.set("clob_token_ids", marketRef);
    const res = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.json();
    const first = Array.isArray(body) ? body[0] : undefined;
    const id =
      typeof first === "object" && first !== null
        ? (first as { id?: unknown }).id
        : undefined;
    if ((typeof id !== "string" && typeof id !== "number") || String(id).length === 0) return null;
    const marketKey = "polymarket:" + String(id);
    cache.set(marketRef, marketKey);
    return marketKey;
  } catch {
    return null;
  }
}

function mapVenue(v: string | null | undefined): VenueId | null {
  if (!v) return null;
  if (v.startsWith("polymarket")) return "polymarket";
  if (v.startsWith("kalshi")) return "kalshi";
  if (v === "hyperliquid") return "hyperliquid";
  if (v === "lighter") return "lighter";
  return null;
}

// ---------------------------------------------------------------------------
// Fixture source — offline e2e
// ---------------------------------------------------------------------------

/**
 * Fixture file shapes (fixtures/signals.json):
 *  - flat: Signal[]
 *  - sequenced: { ticks: { atTick: number; signals: Signal[] }[] }
 * Sequenced fixtures replay a different set per engine tick so the flip case
 * runs offline; the source picks the entry with the highest atTick <= cursor.
 */
const FixtureFileSchema = z.union([
  z.array(SignalSchema),
  z.object({ ticks: z.array(z.object({ atTick: z.number().int().nonnegative(), signals: z.array(SignalSchema) })) }),
]);

export class FixtureSignalSource implements SignalSource {
  private cursor = 0;
  private readonly data: z.output<typeof FixtureFileSchema>;

  constructor(fileContents: string) {
    this.data = FixtureFileSchema.parse(JSON.parse(fileContents));
  }

  /** The engine advances the cursor once per tick. */
  advance(): void {
    this.cursor += 1;
  }

  setCursor(tick: number): void {
    this.cursor = tick;
  }

  async latest(query: SignalQuery): Promise<Signal[]> {
    let signals: Signal[];
    if (Array.isArray(this.data)) {
      signals = this.data;
    } else {
      const eligible = this.data.ticks.filter((t) => t.atTick <= this.cursor);
      const current = eligible.length > 0 ? eligible[eligible.length - 1] : undefined;
      signals = current?.signals ?? [];
    }
    return signals
      .filter((s) => !query.venue || s.venue === query.venue)
      .filter((s) => !query.marketRef || s.marketRef === query.marketRef)
      // Fixture signals are always fresh relative to "now" so offline runs work:
      .map((s) => ({ ...s, ts: new Date().toISOString() }));
  }

  async forecasts(query: ForecastQuery): Promise<MarketForecast[]> {
    const wanted = new Set(query.marketRefs);
    const signals = await this.latest({ venue: query.venue });
    return signals
      .filter((signal) => wanted.has(signal.marketRef))
      .map(marketForecastFromSignal)
      .filter((forecast): forecast is MarketForecast => forecast !== null);
  }
}

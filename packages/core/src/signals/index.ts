// packages/core/src/signals/index.ts
// Quotient signal client. Two sources behind SignalSource: live | fixture.
// HARD RULE enforced by this type surface: nothing here accepts account state.
// The live client sends only the API key header and market-scope query params.
//
// Live contract (verified against the running gateway on 2026-10-06):
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
import { QuotientResearchClient, QuotientSportsSchema } from "../quotient/research.js";
import { QuotientApiError, withQuotientRetries, type RetryOptions } from "../quotient/retry.js";
import { outcomeTokensOf } from "../venues/polymarket.js";

export const SignalSchema = z.object({
  id: z.string(),
  ts: z.string(),
  venue: z.enum(["polymarket", "kalshi", "hyperliquid", "lighter", "fixture"]),
  marketRef: z.string(),
  side: z.enum(["YES", "NO", "LONG", "SHORT"]),
  sleeve: z.string().optional(),
  prob: z.number().min(0).max(1).optional(),
  refPrice: z.number(),
  spreadPp: z.number().optional(),
  endsAt: z.number().optional(),
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
    ...(sig.endsAt !== undefined ? { endsAt: sig.endsAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Live source — the Quotient gateway's published-signals feed
// ---------------------------------------------------------------------------

type LiveSignalConfig = Pick<SignalsConfig, "baseUrl" | "path"> &
  Partial<Pick<SignalsConfig, "maxAgeSec">> & {
    /** Retry policy override, for tests; production uses the bounded default. */
    retry?: RetryOptions;
  };

const GatewaySignalSchema = z.object({
  id: z.string(),
  side: z.enum(["YES", "NO"]),
  sleeve: z.string().nullish(),
  sleeve_group: z.string().nullish(),
  sports: QuotientSportsSchema.nullish(),
  pick_label: z.string().nullish(),
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
      end_date: z.string().nullish(),
    })
    .nullish(),
});

const GatewayResponseSchema = z.object({ signals: z.array(z.unknown()) });

interface OutcomeToken { tokenId: string; outcome: string }
interface MarketTokens { yes: OutcomeToken; no: OutcomeToken }
interface PolymarketIdentity { marketKey: string; conditionId?: string }

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
    throw new QuotientApiError(res.status, url.pathname, res.statusText);
  }
  return GatewayResponseSchema.parse(await res.json()).signals;
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
  /** condition_id → both outcomes in the adapter's canonical YES/NO orientation. */
  readonly #tokenCache = new Map<string, MarketTokens>();
  /** YES-token marketRef → Quotient's stable Polymarket marketKey. */
  readonly #marketKeyCache = new Map<string, PolymarketIdentity>();
  readonly #cfg: Pick<SignalsConfig, "baseUrl" | "path" | "maxAgeSec">;
  readonly #retry: RetryOptions | undefined;
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
    this.#cfg = { baseUrl: cfg.baseUrl, path: cfg.path, maxAgeSec: cfg.maxAgeSec ?? DEFAULT_SIGNAL_MAX_AGE_SEC };
    this.#retry = cfg.retry;
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

  /**
   * Gateway reads retry a bounded number of times on transient failure and
   * then reject. The engine treats that rejection as "no fresh Quotient data"
   * rather than abandoning the tick, so held positions still get evaluated.
   */
  async latest(query: SignalQuery): Promise<Signal[]> {
    const rows = await withQuotientRetries(() => fetchGatewayRows(this.#cfg, this.#token, this.#fetchImpl), this.#retry);
    const out: Signal[] = [];
    for (const raw of rows) {
      const parsed = GatewaySignalSchema.safeParse(raw);
      if (!parsed.success) continue;
      const sig = await mapGatewayRow(
        parsed.data,
        (conditionId) => resolveMarketTokens(conditionId, this.#tokenCache, this.#fetchImpl, this.#clobBase),
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
          identity: await resolvePolymarketMarketKey(
            marketRef,
            this.#marketKeyCache,
            this.#fetchImpl,
            this.#gammaBase,
          ),
        })),
      );
      const byKey = new Map(
        resolved
          .filter((row): row is { marketRef: string; identity: PolymarketIdentity } => Boolean(row.identity))
          .map((row) => [row.identity.marketKey.toLowerCase(), row]),
      );
      if (byKey.size === 0) return [];
      const rows = await withQuotientRetries(() => this.#research.lookup({
        marketKeys: [...byKey.keys()],
        venue: "polymarket",
      }), this.#retry);
      const forecasts = await Promise.all(rows.map(async (row): Promise<MarketForecast | null> => {
        const marketKey = row.marketKey?.toLowerCase();
        const resolved = marketKey ? byKey.get(marketKey) : undefined;
        if (!resolved || row.qProbability === undefined) return null;
        const { marketRef, identity } = resolved;
        let probYes = row.qProbability;
        if (row.sports) {
          const conditionId = row.conditionId ?? identity.conditionId;
          const tokens = conditionId ? await resolveMarketTokens(conditionId, this.#tokenCache, this.#fetchImpl, this.#clobBase) : null;
          if (!tokens || tokens.yes.tokenId !== marketRef) return null;
          const qYes = sportsYesOutcome(tokens, row.sports.yesSideName, row.sports.yesSideCanonicalName);
          if (!qYes) return null;
          if (qYes === "NO") probYes = 1 - probYes;
        }
        const endsAt = epochMs(row.endDate);
        return {
          id: row.marketKey ?? "forecast:" + marketRef,
          ts: row.forecastAt ?? new Date(0).toISOString(),
          venue: "polymarket" as const,
          marketRef,
          probYes,
          ...(endsAt !== undefined ? { endsAt } : {}),
        };
      }));
      return forecasts.filter((forecast): forecast is MarketForecast => forecast !== null);
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
        const endsAt = epochMs(row.endDate);
        return [{
          id: row.marketKey ?? "forecast:" + marketRef,
          ts: row.forecastAt ?? new Date(0).toISOString(),
          venue: "kalshi" as const,
          marketRef,
          probYes: row.qProbability,
          ...(endsAt !== undefined ? { endsAt } : {}),
        }];
      });
    }

    return [];
  }
}

async function mapGatewayRow(
  g: z.output<typeof GatewaySignalSchema>,
  resolveTokens: (conditionId: string) => Promise<MarketTokens | null>,
  ttlSec: number,
): Promise<Signal | null> {
  if (g.is_active === false) return null;
  const venue = mapVenue(g.market?.venue);
  if (!venue) return null;

  let marketRef: string | null = null;
  let side = g.side;
  const sports = g.sleeve === "sports" || g.sleeve_group === "sports" || Boolean(g.sports);
  if (venue === "polymarket") {
    const tokens = g.market?.condition_id ? await resolveTokens(g.market.condition_id) : null;
    if (!tokens) return null;
    marketRef = tokens.yes.tokenId;
    if (sports) {
      const qYes = sportsYesOutcome(tokens, g.sports?.yes_side?.name, g.sports?.yes_side?.canonical_name);
      if (!qYes) return null;
      if (qYes === "NO") side = g.side === "YES" ? "NO" : "YES";
      // Named picks must agree with the selected token. Do not guess through contradictory metadata.
      if (g.pick_label && !["yes", "no"].includes(outcomeLabel(g.pick_label)) &&
          outcomeLabel(g.pick_label) !== outcomeLabel((side === "YES" ? tokens.yes : tokens.no).outcome)) return null;
    }
  } else {
    marketRef = g.market?.nativeMarketId ?? null;
  }
  if (!marketRef) return null;

  // Keep the picked outcome's probability when remapping its YES/NO label.
  // latest_q refers to Q's YES side; q_value_cents is already expressed for the pick.
  const prob = g.latest_q != null ? (g.side === "YES" ? g.latest_q : 1 - g.latest_q)
    : g.q_value_cents != null ? g.q_value_cents / 100 : undefined;
  const costCents = g.current_cost_cents ?? g.entry_pm;
  if (costCents == null) return null;
  const refPrice = costCents / 100;
  const spreadPp = prob !== undefined ? Math.abs(prob * 100 - costCents) : (g.entry_spread_pp ?? undefined);

  const endsAt = epochMs(g.market?.end_date);

  return {
    id: g.id,
    ts: g.forecast_updated_at ?? g.published_at ?? new Date(0).toISOString(),
    venue,
    marketRef,
    side,
    ...(sports ? { sleeve: "sports" } : g.sleeve ? { sleeve: g.sleeve } : {}),
    prob,
    refPrice,
    spreadPp,
    ...(endsAt !== undefined ? { endsAt } : {}),
    ttlSec,
  };
}

/** Feed timestamp to epoch ms; unparseable or absent values stay undefined. */
function epochMs(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : undefined;
}

function outcomeLabel(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Map Q's named YES outcome into the adapter's orientation. Unknown names fail closed. */
function sportsYesOutcome(tokens: MarketTokens, name?: string | null, canonicalName?: string | null): "YES" | "NO" | null {
  if (outcomeLabel(tokens.yes.outcome) === "yes" && outcomeLabel(tokens.no.outcome) === "no") return "YES";
  const names = [name, canonicalName].filter((value): value is string => Boolean(value)).map(outcomeLabel);
  const yes = names.includes(outcomeLabel(tokens.yes.outcome));
  const no = names.includes(outcomeLabel(tokens.no.outcome));
  return yes === no ? null : yes ? "YES" : "NO";
}

/** Resolve both tokens from the public CLOB endpoint, retaining the adapter's canonical marketRef. */
async function resolveMarketTokens(
  conditionId: string,
  cache: Map<string, MarketTokens>,
  fetchImpl: typeof fetch,
  clobBase: string,
): Promise<MarketTokens | null> {
  const cached = cache.get(conditionId);
  if (cached) return cached;
  try {
    const res = await fetchImpl(`${clobBase}/markets/${conditionId}`);
    if (!res.ok) return null;
    const m = (await res.json()) as { tokens?: { token_id?: string; outcome?: string }[] };
    if (m.tokens?.length !== 2 || m.tokens.some(t => !t.token_id || !t.outcome)) return null;
    const tokens = m.tokens.map(t => ({ tokenId: t.token_id!, outcome: t.outcome! }));
    const ids = outcomeTokensOf(tokens);
    if (ids.yes === ids.no) return null;
    const outcomes = { yes: tokens.find(t => t.tokenId === ids.yes)!, no: tokens.find(t => t.tokenId === ids.no)! };
    cache.set(conditionId, outcomes);
    return outcomes;
  } catch {
    return null;
  }
}

/** Resolve a YES-token marketRef to Quotient's Polymarket marketKey (cached). */
async function resolvePolymarketMarketKey(
  marketRef: string,
  cache: Map<string, PolymarketIdentity>,
  fetchImpl: typeof fetch,
  gammaBase: string,
): Promise<PolymarketIdentity | null> {
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
    const conditionId = (first as { conditionId?: unknown }).conditionId;
    const identity = { marketKey: "polymarket:" + String(id), ...(typeof conditionId === "string" ? { conditionId } : {}) };
    cache.set(marketRef, identity);
    return identity;
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

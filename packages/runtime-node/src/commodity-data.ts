// packages/runtime-node/src/commodity-data.ts
// Exact asset links and current venue rules authorize Q; price outlooks are diagnostics.
import { createHash } from "node:crypto";
import type {
  CommodityAsset, CommodityConfig, CommodityContract, CommodityResearchSnapshot,
  CommodityResearchSource, ForecastQuery, MarketForecast, Signal, SignalQuery,
} from "@quotient-forecasting/cassie-core";

type Row = Record<string, unknown>;
const row = (v: unknown): Row | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : null;
const str = (v: unknown): string | null => typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const instant = (v: unknown): number | null => typeof v === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const decimal = (v: unknown): number | null => typeof v === "string" && /^\d+(?:\.\d+)?$/.test(v) && Number.isFinite(Number(v)) ? Number(v) : null;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const COMMODITY_ASSET_KEYS: Record<CommodityAsset, string> = {
  oil: "commodity:wti", gold: "commodity:gold", btc: "crypto:btc", copper: "commodity:copper", silver: "commodity:silver",
};
const SERIES: Record<CommodityAsset, readonly string[]> = {
  oil: ["KXWTI", "KXWTIW"], gold: ["KXGOLDD", "KXGOLDW", "KXGOLDMON"],
  btc: ["KXBTCD", "KXBTC"], copper: ["KXCOPPERD", "KXCOPPERW", "KXCOPPERMON"],
  silver: ["KXSILVERD", "KXSILVERW", "KXSILVERMON"],
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const etParts = (ts: number): Record<string, string> => Object.fromEntries(new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
}).formatToParts(new Date(ts)).map(p => [p.type, p.value]));

interface LinkedForecast {
  asset: CommodityAsset; marketRef: string; eventRef: string; series: string;
  qYes: number; forecastAt: number; endAt: number; odds: number; forecastStatus: string | null;
}
export interface CommodityDataOptions {
  config: CommodityConfig;
  /** Quotient gateway base. Only its origin receives the token. */
  baseUrl: string;
  token: string;
  /** Kalshi public API root, including /trade-api/v2. */
  apiBase?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onUsage?: (usage: { operation: "assets-search" | "price-outlooks"; usd: number; at: number }) => void;
}

/** A quote-like value cannot stand in for a forecast; causal links cannot authorize assets. */
export function normalizeCommodityLinks(value: unknown, assets: readonly CommodityAsset[]): {
  links: LinkedForecast[]; excluded: CommodityResearchSnapshot["excluded"];
} {
  const root = row(value);
  if (!root || !Array.isArray(root.assets)) throw new Error("Quotient commodity asset response is malformed");
  const links: LinkedForecast[] = [], excluded: CommodityResearchSnapshot["excluded"] = [];
  const keys = new Map(assets.map(asset => [COMMODITY_ASSET_KEYS[asset], asset]));
  for (const rawAsset of root.assets) {
    const a = row(rawAsset), asset = keys.get(String(a?.assetKey));
    if (!a || !asset || !Array.isArray(a.linked_markets)) continue;
    for (const raw of a.linked_markets) {
      const m = row(raw);
      if (!m || m.venue !== "kalshi") continue;
      const ref = str(m.nativeMarketId), series = str(m.seriesTicker), event = str(m.nativeEventId);
      const reject = (reason: string): void => { excluded.push({ ...(ref ? { marketRef: ref } : {}), reason }); };
      if (!ref || !/^[A-Z0-9][A-Z0-9.-]{1,150}$/.test(ref) || m.marketKey !== `kalshi:${ref}`
        || !series || !SERIES[asset].includes(series) || !event || !ref.startsWith(`${event}-`)
        || !event.startsWith(`${series}-`)) { reject("unsupported or conflicting Kalshi identity"); continue; }
      const rel = row(m.relationships)?.assets;
      if (!Array.isArray(rel) || !rel.some(r => { const x = row(r); return x?.relationship === "HAS_MARKET"
        && x.via === "direct" && x.direction === "incoming" && x.assetKey === COMMODITY_ASSET_KEYS[asset]; })) {
        reject("exact direct asset relationship missing"); continue;
      }
      const q = num(m.latest_q_probability), at = instant(m.forecast_at), end = instant(m.end_date), odds = num(m.market_odds);
      if (m.has_forecast !== true || q === null || q < 0 || q > 1 || at === null || end === null
        || odds === null || odds <= 0 || odds >= 1 || m.inDispute === true) { reject("forecast, horizon or quote unavailable"); continue; }
      const state = str(row(m.forecast_status)?.state);
      if (state === "warning" || state === "caution") { reject(`forecast ${state}`); continue; }
      if (state !== null && !["converged", "converging", "sideways", "diverging"].includes(state)) { reject("forecast status unrecognized"); continue; }
      links.push({ asset, marketRef: ref, eventRef: event, series, qYes: q, forecastAt: at, endAt: end, odds, forecastStatus: state });
    }
  }
  const duplicate = new Set(links.filter((l, i) => links.findIndex(x => x.marketRef === l.marketRef) !== i).map(l => l.marketRef));
  for (const marketRef of duplicate) excluded.push({ marketRef, reason: "duplicate or ambiguous asset linkage" });
  for (const asset of assets) if (!root.assets.some(a => row(a)?.assetKey === COMMODITY_ASSET_KEYS[asset])) excluded.push({ reason: `${asset} exact asset coverage unavailable` });
  return { links: links.filter(l => !duplicate.has(l.marketRef)), excluded };
}

function sourceIdentity(asset: CommodityAsset, s: Row): string | null {
  if (!Array.isArray(s.settlement_sources) || s.settlement_sources.length !== 1) return null;
  const source = row(s.settlement_sources[0]);
  let url: URL;
  try { url = new URL(String(source?.url)); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const path = decodeURIComponent(url.pathname);
  if (asset === "oil") return source?.name === "ICE" && ["www.theice.com", "www.ice.com"].includes(url.hostname)
    && path === "/products/213/WTI-Crude-Futures" ? "ice:WBS" : null;
  if (asset === "btc") return source?.name === "CF Benchmarks" && url.hostname === "www.cfbenchmarks.com"
    && path === "/data/indices/BRTI" ? "cfbenchmarks:BRTI:mean60s" : null;
  const symbol = asset === "gold" ? "Metal.Index.GOLD/USD" : asset === "silver" ? "Metal.Index.SILVER/USD" : "Commodities.Index.CU/USD";
  const name = asset[0]!.toUpperCase() + asset.slice(1);
  return source?.name === `Pyth - ${name}` && url.hostname === "app.pyth.com" && path === `/explore/${symbol}`
    ? `pyth:${symbol}:${asset === "gold" ? 3153 : asset === "silver" ? 3154 : 3525}` : null;
}

function allowedTerms(asset: CommodityAsset, value: unknown): boolean {
  try {
    const u = new URL(String(value));
    return u.protocol === "https:" && !u.username && !u.password
      && ["assets.kalshi.com", "kalshi-public-docs.s3.amazonaws.com"].includes(u.hostname)
      && u.pathname === `/contract_terms/${asset === "oil" ? "COMMODITYSETTLE" : asset === "btc" ? "BTC" : "COMMODITIES"}.pdf`;
  } catch { return false; }
}

function rulesFixingMatches(primary: string, closeAt: number, asset: CommodityAsset): boolean {
  const date = primary.match(/\bon ([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (!date) return false;
  const et = etParts(closeAt), month = MONTHS.indexOf(date[1]!.slice(0, 3).toLowerCase()) + 1;
  if (month !== Number(et.month) || Number(date[2]) !== Number(et.day) || Number(date[3]) !== Number(et.year)) return false;
  if (asset === "oil") return true; // authoritative custom_strike supplies the oil fixing clock.
  const time = primary.match(/\b(?:before|at)\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s+(EDT|EST|ET)\b/i);
  if (!time) return false;
  const hour = Number(time[1]) % 12 + (time[3]!.toUpperCase() === "PM" ? 12 : 0);
  return hour === Number(et.hour) && Number(time[2] ?? 0) === Number(et.minute)
    && (time[4]!.toUpperCase() === "ET" || time[4]!.toUpperCase() === et.timeZoneName);
}

/** Source/date/geometry validation is intentionally separate from Q edge ranking. */
export function normalizeCommodityContract(link: LinkedForecast, marketValue: unknown, seriesValue: unknown, now: number): CommodityContract | string {
  const m = row(row(marketValue)?.market), s = row(row(seriesValue)?.series);
  if (!m || !s || m.ticker !== link.marketRef || m.event_ticker !== link.eventRef || s.ticker !== link.series
    || m.market_type !== "binary" || decimal(m.notional_value_dollars) !== 1) return "venue identity mismatch";
  const closeAt = instant(m.close_time), openAt = instant(m.open_time), custom = row(m.custom_strike);
  if (closeAt === null || openAt === null || openAt >= closeAt) return "venue dates unavailable";
  if (m.status !== "active" || openAt > now || closeAt <= now) return "venue market not open";
  if (custom?.strike_date !== undefined && instant(custom.strike_date) !== closeAt) return "fixing and close disagree";
  const expected = instant(m.expected_expiration_time);
  if (link.endAt !== closeAt && !(link.asset === "btc" && expected === closeAt + 300_000 && link.endAt === expected)) return "catalog and venue fixing disagree";
  const source = sourceIdentity(link.asset, s);
  if (!source || !allowedTerms(link.asset, s.contract_terms_url)) return "settlement source or terms changed";
  const primary = str(m.rules_primary), secondary = typeof m.rules_secondary === "string" ? m.rules_secondary : null;
  if (!primary || secondary === null || !rulesFixingMatches(primary, closeAt, link.asset)) return "settlement rules or fixing clock unrecognized";
  const joined = `${primary}\n${secondary}\n${String(m.early_close_condition ?? "")}`;
  if (/\b(?:ever|touch|maximum|minimum|trimmed|cumulative)\b|after issuance|throughout the market|criterion is met/i.test(joined)) return "path-dependent market excluded";
  const shape = m.strike_type;
  if (shape !== "greater" && shape !== "less" && shape !== "between") return "unsupported strike type";
  const floor = num(m.floor_strike), cap = num(m.cap_strike);
  if (shape === "greater" && (floor === null || cap !== null) || shape === "less" && (cap === null || floor !== null)
    || shape === "between" && (floor === null || cap === null || cap <= floor)) return "invalid strike bounds";
  const comparison = primary.match(/\bis\s+(above|below|between)\s+\$?\s*([\d,]+(?:\.\d+)?)(?:\s*(?:and|to|-)\s*\$?\s*([\d,]+(?:\.\d+)?))?/i);
  const first = comparison ? Number(comparison[2]!.replaceAll(",", "")) : NaN;
  const last = comparison?.[3] ? Number(comparison[3].replaceAll(",", "")) : null;
  if (!comparison || comparison[1]!.toLowerCase() !== (shape === "greater" ? "above" : shape === "less" ? "below" : "between")
    || first !== (shape === "less" ? cap : floor) || shape === "between" && last !== cap) return "strike rules disagree with numeric bounds";
  let instrument = source;
  if (link.asset === "oil") {
    const contract = str(custom?.front_month_contract), named = primary.match(/WTI crude oil\s*\(([A-Za-z]+) (\d{4}) contract\)/i);
    const code = contract?.match(/^WBS (\d{2})([FGHJKMNQUVXZ])-ICE$/);
    if (!/daily settlement price/i.test(primary) || !code || !named || !custom?.strike_date
      || Number(named[2]) % 100 !== Number(code[1])
      || MONTHS.indexOf(named[1]!.slice(0, 3).toLowerCase()) !== "FGHJKMNQUVXZ".indexOf(code[2]!)) return "oil contract month unverified";
    instrument += `:${contract}`;
  } else if (link.asset === "btc") {
    if (!/simple average of the sixty seconds of CF Benchmarks' Bitcoin Real-Time Index \(BRTI\)/i.test(primary)) return "BTC averaging rule unrecognized";
  } else {
    if (!new RegExp(`close price of the 1-minute candlestick for ${link.asset}\\b`, "i").test(primary)
      || custom?.front_month_contract !== "N/A" || !/rounded to the nearest 2 decimal places/i.test(secondary)
      || !/immediately preceding one-minute interval/i.test(secondary)) return "metal index candle rule unrecognized";
  }
  if (link.asset !== "btc" && !/rounded to the nearest 2 decimal places/i.test(secondary)) return "commodity rounding rule unrecognized";
  if (link.asset !== "btc" && !new RegExp(`\\bUSD/${link.asset === "oil" ? "Bbl" : link.asset === "copper" ? "Lbs" : "t\\.oz"}\\b`, "i").test(primary)) return "settlement currency or unit unrecognized";
  const changedAt = instant(s.last_updated_ts);
  if (changedAt !== null && link.forecastAt < changedAt) return "forecast predates current series metadata";
  const multiplier = num(s.fee_multiplier);
  if (multiplier === null || multiplier < 0 || multiplier > 5 || !["quadratic", "quadratic_with_maker_fees"].includes(String(s.fee_type))) return "fee schedule unrecognized";
  if (m.price_level_structure !== "linear_cent" || !Array.isArray(m.price_ranges) || m.price_ranges.length !== 1
    || decimal(row(m.price_ranges[0])?.step) !== .01) return "unsupported venue price grid";
  const basis = { source: instrument, fixing: closeAt, timezone: "America/New_York", field: link.asset === "oil" ? "daily-settlement"
    : link.asset === "btc" ? "preceding-60s-mean" : "preceding-1m-close", decimals: link.asset === "btc" ? null : 2 };
  return { asset: link.asset, marketRef: link.marketRef, eventRef: link.eventRef, series: link.series, closeAt, openAt,
    settlementBasis: `kalshi:${sha(basis)}`, rulesHash: sha({ primary, secondary, basis, floor, cap, shape, terms: s.contract_terms_url,
      important: row(row(s.product_metadata)?.important_info)?.markdown ?? null }), verified: true,
    strikeType: shape, ...(floor !== null ? { floor } : {}), ...(cap !== null ? { cap } : {}), qYes: link.qYes,
    forecastAt: link.forecastAt, forecastId: `q:${link.marketRef}:${link.forecastAt}:${link.qYes}`,
    takerFeeRate: .07 * multiplier, makerFeeRate: s.fee_type === "quadratic_with_maker_fees" ? .0175 * multiplier : 0 };
}

/** Read-only market research; no balances, wallet identifiers or order quantities are accepted. */
export class CommodityDataSource implements CommodityResearchSource {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly base: URL;
  private readonly api: URL;
  private cache?: CommodityResearchSnapshot;
  private pending?: Promise<CommodityResearchSnapshot>;
  private prices = new Map<string, number>();
  private signatures = new Map<string, string>();
  private watched = new Map<string, number>();
  private retryAfter = new Map<string, number>();
  private linkCache?: { receivedAt: number; parsed: ReturnType<typeof normalizeCommodityLinks> };
  private outlookCache?: { receivedAt: number; series: unknown[]; asOf: unknown };
  private outlookAttemptAt = -Infinity;
  private paidUsage = { successfulReads: 0, estimatedListUsd: 0 };
  constructor(private readonly opts: CommodityDataOptions) {
    this.base = new URL(opts.baseUrl); this.api = new URL((opts.apiBase ?? "https://api.elections.kalshi.com/trade-api/v2").replace(/\/$/, "") + "/");
    for (const u of [this.base, this.api]) if ((u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
      || u.username || u.password || u.search || u.hash) throw new Error("Commodity research requires an HTTPS base URL");
    if (!opts.token) throw new Error("Commodity research requires a Quotient token");
    this.fetchImpl = opts.fetchImpl ?? fetch; this.now = opts.now ?? Date.now;
  }
  refreshedAt(): number | undefined { return this.cache?.receivedAt; }
  async snapshot(): Promise<CommodityResearchSnapshot> {
    const now = this.now();
    if (this.cache && now >= this.cache.receivedAt && now - this.cache.receivedAt < this.opts.config.signalPollIntervalMin * 60_000) return structuredClone(this.cache);
    this.pending ??= this.refresh().then(value => { this.cache = value; return value; }).finally(() => { this.pending = undefined; });
    return structuredClone(await this.pending);
  }
  async latest(query: SignalQuery): Promise<Signal[]> {
    if (query.venue && query.venue !== "kalshi") return [];
    if (query.marketRef) this.watched.set(query.marketRef, this.now());
    const s = await this.snapshot();
    const now = this.now();
    return s.contracts.filter(c => c.verified && c.openAt <= now && c.closeAt > now
      && c.forecastAt <= now && now - c.forecastAt <= this.opts.config.maxForecastAgeHours * HOUR
      && (!query.marketRef || c.marketRef === query.marketRef)).flatMap(c => {
      const refPrice = this.prices.get(c.marketRef);
      return refPrice === undefined ? [] : [{ id: c.forecastId, ts: new Date(c.forecastAt).toISOString(), venue: "kalshi" as const,
        marketRef: c.marketRef, side: c.qYes >= refPrice ? "YES" as const : "NO" as const, prob: c.qYes, refPrice,
        spreadPp: Math.abs(c.qYes - refPrice) * 100, endsAt: c.closeAt, ttlSec: this.opts.config.maxForecastAgeHours * 3600,
        settlementBasis: c.settlementBasis, rulesHash: c.rulesHash }];
    });
  }
  async forecasts(query: ForecastQuery): Promise<MarketForecast[]> {
    if (query.venue && query.venue !== "kalshi") return [];
    query.marketRefs.forEach(ref => this.watched.set(ref, this.now()));
    const s = await this.snapshot(), wanted = new Set(query.marketRefs);
    return s.contracts.filter(c => wanted.has(c.marketRef)).map(c => ({ id: c.forecastId, ts: new Date(c.forecastAt).toISOString(),
      venue: "kalshi", marketRef: c.marketRef, probYes: c.qYes, endsAt: c.closeAt }));
  }
  private async request(url: URL, paid?: "assets-search" | "price-outlooks"): Promise<unknown> {
    const key = paid ? "quotient" : "kalshi";
    if (this.now() < (this.retryAfter.get(key) ?? 0)) throw new Error(`${key} Retry-After is active`);
    let response: Response;
    try { response = await this.fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { accept: "application/json", ...(paid ? { "x-quotient-api-key": this.opts.token } : {}) } }); }
    catch { this.retryAfter.set(key, Math.max(this.retryAfter.get(key) ?? 0, this.now() + 60_000)); throw new Error(`${key} research request unavailable`); }
    if (!response.ok) {
      const retry = response.headers.get("retry-after");
      if (retry) { const end = /^\d+$/.test(retry) ? this.now() + Number(retry) * 1000 : Date.parse(retry);
        if (Number.isFinite(end)) this.retryAfter.set(key, Math.max(this.retryAfter.get(key) ?? 0, end)); }
      else this.retryAfter.set(key, Math.max(this.retryAfter.get(key) ?? 0, this.now() + 60_000));
      throw new Error(`${key} research HTTP ${response.status}`);
    }
    if (paid) { this.paidUsage.successfulReads++; this.paidUsage.estimatedListUsd += .01; this.opts.onUsage?.({ operation: paid, usd: .01, at: this.now() }); }
    try { const body = await response.text(); if (body.length > 8 * 1024 * 1024) throw new Error(); return JSON.parse(body) as unknown; }
    catch { this.retryAfter.set(key, Math.max(this.retryAfter.get(key) ?? 0, this.now() + 60_000)); throw new Error(`${key} research response malformed`); }
  }
  private async refresh(): Promise<CommodityResearchSnapshot> {
    const start = this.now(), config = this.opts.config, query = new URL("/api/v1/assets/search", this.base);
    config.assets.forEach(asset => query.searchParams.append("reference", COMMODITY_ASSET_KEYS[asset]));
    if (!this.linkCache || start < this.linkCache.receivedAt || start - this.linkCache.receivedAt >= config.forecastPollIntervalMin * 60_000) {
      // A due essential refresh must succeed. Its previous response cannot authorize new additions.
      const parsed = normalizeCommodityLinks(await this.request(query, "assets-search"), config.assets);
      this.linkCache = { receivedAt: this.now(), parsed };
    }
    const parsed = this.linkCache.parsed, excluded = [...parsed.excluded];
    const eligible = parsed.links.filter(l => {
      const reason = l.forecastAt > start || start - l.forecastAt > config.maxForecastAgeHours * HOUR ? "forecast stale or future"
        : l.endAt - start < config.minHoursToClose * HOUR || l.endAt - start > config.maxDaysToClose * DAY + 300_000 ? "outside entry horizon" : null;
      if (reason) excluded.push({ marketRef: l.marketRef, reason });
      return reason === null;
    });
    // Central quote first within the nearest event; Q probabilities never rank the research universe.
    const selected: LinkedForecast[] = [];
    for (const asset of config.assets) {
      const candidates = eligible.filter(l => l.asset === asset).sort((a, b) => a.endAt - b.endAt || Math.abs(a.odds - .5) - Math.abs(b.odds - .5) || a.marketRef.localeCompare(b.marketRef));
      selected.push(...candidates.slice(0, 6));
      candidates.slice(6).forEach(l => excluded.push({ marketRef: l.marketRef, reason: "balanced research candidate limit" }));
    }
    // Retain previously admitted market metadata for exits even after it leaves current coverage.
    const prior = new Map((this.cache?.contracts ?? []).map(c => [c.marketRef, c]));
    for (const [ref, at] of this.watched) if (start - at > 7 * DAY) this.watched.delete(ref);
    for (const l of parsed.links) if (prior.has(l.marketRef) && this.watched.has(l.marketRef)
      && !selected.some(s => s.marketRef === l.marketRef) && selected.length < 60) selected.push(l);
    const series = new Map<string, unknown>();
    for (const s of [...new Set(selected.map(l => l.series))]) {
      try { series.set(s, await this.request(new URL(`series/${encodeURIComponent(s)}`, this.api))); }
      catch { excluded.push({ reason: `series ${s} unavailable` }); }
    }
    const contracts: CommodityContract[] = [], prices = new Map<string, number>();
    for (let offset = 0; offset < selected.length; offset += 4) {
      const batch = selected.slice(offset, offset + 4);
      const results = await Promise.allSettled(batch.map(l => this.request(new URL(`markets/${encodeURIComponent(l.marketRef)}`, this.api))));
      results.forEach((result, i) => {
        const l = batch[i]!;
        const normalized = result.status === "fulfilled" ? normalizeCommodityContract(l, result.value, series.get(l.series), this.now()) : "market metadata unavailable";
        if (result.status === "fulfilled" && series.has(l.series)) {
          const m = row(row(result.value)?.market), s = row(row(series.get(l.series))?.series);
          if (m && s) {
            const signature = sha({ primary: m.rules_primary, secondary: m.rules_secondary, custom: m.custom_strike,
              close: m.close_time, floor: m.floor_strike, cap: m.cap_strike, shape: m.strike_type,
              source: s.settlement_sources, terms: s.contract_terms_url, important: row(row(s.product_metadata)?.important_info)?.markdown });
            const previousSignature = this.signatures.get(l.marketRef), previous = prior.get(l.marketRef);
            if (typeof normalized === "string" && previous && previousSignature && signature !== previousSignature) {
              prior.set(l.marketRef, { ...previous, rulesHash: `unverified:${signature}`, verified: false, rejectionReason: normalized });
            }
            const closedAt = instant(m.close_time), retained = prior.get(l.marketRef);
            if (typeof normalized === "string" && retained && m.ticker === l.marketRef && m.event_ticker === l.eventRef
              && closedAt !== null && closedAt <= this.now() && ["closed", "determined", "finalized", "settled"].includes(String(m.status))) {
              prior.set(l.marketRef, { ...retained, closeAt: closedAt, verified: false, rejectionReason: "venue contract closed" });
            }
            this.signatures.set(l.marketRef, signature);
          }
        }
        if (typeof normalized === "string") { excluded.push({ marketRef: l.marketRef, reason: normalized }); return; }
        const m = row(row(result.status === "fulfilled" ? result.value : null)?.market), bid = decimal(m?.yes_bid_dollars), ask = decimal(m?.yes_ask_dollars);
        if (bid !== null && ask !== null && bid >= 0 && ask <= 1 && bid < ask) prices.set(l.marketRef, (bid + ask) / 2);
        contracts.push(normalized); prior.delete(l.marketRef);
      });
    }
    const retained = [...prior.values()].filter(c => start - c.closeAt <= 7 * DAY)
      .sort((a, b) => Number(this.watched.has(b.marketRef)) - Number(this.watched.has(a.marketRef)) || b.closeAt - a.closeAt).slice(0, 150);
    for (const c of retained) contracts.push({ ...c, verified: false, rejectionReason: c.rejectionReason ?? "retained metadata; current verification unavailable" });
    const retainedRefs = new Set(contracts.map(c => c.marketRef));
    for (const ref of this.signatures.keys()) if (!retainedRefs.has(ref)) this.signatures.delete(ref);
    const diagnosticsDue = !this.outlookCache || start < this.outlookCache.receivedAt
      || start - this.outlookCache.receivedAt >= config.outlookPollIntervalMin * 60_000;
    let diagnosticsFailed = false;
    if (diagnosticsDue && start - this.outlookAttemptAt >= config.signalPollIntervalMin * 60_000) {
      this.outlookAttemptAt = start;
      try {
        const raw = row(await this.request(new URL("/api/v1/price-outlooks", this.base), "price-outlooks"));
        if (!raw || !Array.isArray(raw.series)) throw new Error();
        this.outlookCache = { receivedAt: this.now(), asOf: raw.as_of ?? null,
          series: raw.series.filter(s => config.assets.some(a => row(s)?.asset_key === COMMODITY_ASSET_KEYS[a])) };
      } catch { excluded.push({ reason: "price outlook diagnostics unavailable" }); diagnosticsFailed = true; }
    }
    const outlookDiagnostics = { diagnosticOnly: true, receivedAt: this.outlookCache?.receivedAt ?? null,
      asOf: this.outlookCache?.asOf ?? null, series: this.outlookCache?.series ?? [], stale: diagnosticsFailed || !this.outlookCache
        || this.now() - this.outlookCache.receivedAt >= config.outlookPollIntervalMin * 60_000,
      forecastReceivedAt: this.linkCache.receivedAt, paidUsage: { ...this.paidUsage, accounting: "nominal-list-price-not-account-debit" } };
    this.prices = prices;
    return { receivedAt: this.now(), contracts, excluded, outlookDiagnostics };
  }
}

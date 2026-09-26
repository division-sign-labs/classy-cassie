// packages/runtime-node/src/swing-data.ts
// Market-scoped reads only: this boundary never accepts balances, wallets, or orders.
import type { SwingOutlook } from "@quotient-forecasting/strategy-quotient-swing";

const HOUR = 3_600_000;
type Row = Record<string, unknown>;
const row = (v: unknown): Row | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : null;
const str = (v: unknown): string | null => typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const instant = (v: unknown): number | null => typeof v === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(v)
  && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const clone = <T>(v: T): T => structuredClone(v);

export interface SwingCoveredAsset {
  assetKey: string;
  marketRef: string;
  assetClass: "equity" | "commodity" | "crypto";
  name: string;
}
export interface SwingExcludedOutlook { assetKey: string; outlookId: string | null; reason: string }
export interface SwingQuotientSnapshot {
  receivedAt: number;
  assets: SwingCoveredAsset[];
  outlooks: SwingOutlook[];
  /** Entire original API wire, including rejected groups. */
  rawResponse: unknown;
  excluded: SwingExcludedOutlook[];
}
export interface SwingQuotientUsage {
  operation: "assets" | "price-outlooks";
  /** Nominal public list price, not an account debit; free/unlimited allowances may pay zero. */
  usd: number;
  at: number;
}
export interface SwingQuotientDataOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onUsage?: (usage: SwingQuotientUsage) => void;
}

/** Directory identifiers, not tickers/name similarity, authorize instrument mapping. */
export function normalizeSwingAssets(value: unknown): SwingCoveredAsset[] {
  const root = row(value);
  if (!root || !Array.isArray(root.assets)) throw new Error("Quotient assets response is malformed");
  const candidates: SwingCoveredAsset[] = [];
  for (const raw of root.assets) {
    const a = row(raw), key = str(a?.assetKey), name = str(a?.name);
    if (!a || !key || !name || !Array.isArray(a.identifiers)) continue;
    const assetClass = key.startsWith("commodity:") && a.asset_type === "commodity" ? "commodity"
      : key.startsWith("company:") && ["company", "equity"].includes(String(a.asset_type)) ? "equity"
      : ["crypto:btc", "crypto:eth"].includes(key) && a.asset_type === "crypto" ? "crypto" : null;
    if (!assetClass) continue;
    const coins = [...new Set(a.identifiers.flatMap((rawId: unknown) => {
      const id = row(rawId);
      return id?.platform === "hyperliquid" && id.kind === "coin" && typeof id.value === "string"
        && (assetClass === "crypto" ? id.value === key.slice(7).toUpperCase() : /^xyz:[A-Za-z0-9._-]+$/.test(id.value)) ? [id.value] : [];
    }))];
    // Ambiguous mappings remain unavailable; no arbitrary first-symbol selection.
    if (coins.length === 1) candidates.push({ assetKey: key, name, assetClass, marketRef: coins[0]! });
  }
  return candidates.filter(a => candidates.filter(b => b.marketRef === a.marketRef || b.assetKey === a.assetKey).length === 1)
    .sort((a, b) => a.assetKey.localeCompare(b.assetKey));
}

function referenceProblems(value: unknown, asset: SwingCoveredAsset, basisId: string, now: number): string[] {
  const ref = row(value);
  if (!ref) return ["object"];
  const expected = { provider: "hyperliquid", instrument_id: asset.marketRef, symbol: asset.marketRef, basis_id: basisId,
    mapping_status: "verified", unit: "quote-per-unit", currency: "USD", price_field: "mid", session: "continuous",
    window: "point", timezone: "UTC", value_kind: "observed", freshness: "verified",
    contract_month: null, roll_rule: null, candle_interval: null, rounding: null };
  const problems = Object.entries(expected).filter(([key, expectedValue]) => ref[key] !== expectedValue).map(([key]) => key);
  const observedAt = instant(ref.observed_at), price = num(ref.value);
  if (observedAt === null || observedAt > now) problems.push("observed_at");
  if (price === null || price <= 0) problems.push("value");
  return problems;
}

/** Preserve every original horizon >=6h. The strategy chooses its 24–120h entry anchor. */
export function normalizeSwingOutlooks(value: unknown, assets: SwingCoveredAsset[], now: number):
  Pick<SwingQuotientSnapshot, "outlooks" | "excluded"> {
  const root = row(value);
  if (!root || root.contract !== "asset-price/1" || !Array.isArray(root.series)) {
    throw new Error("Quotient price-outlooks response is malformed");
  }
  const outlooks: SwingOutlook[] = [], excluded: SwingExcludedOutlook[] = [];
  const byKey = new Map(assets.map(a => [a.assetKey, a]));
  for (const rawSeries of root.series) {
    const series = row(rawSeries), assetKey = str(series?.asset_key);
    const asset = assetKey ? byKey.get(assetKey) : undefined;
    if (!series || !asset) continue;
    const reject = (id: string | null, reason: string) => excluded.push({ assetKey: asset.assetKey, outlookId: id, reason });
    if (!Array.isArray(series.basis_groups)) { reject(null, "missing-basis-groups"); continue; }
    const mode = str(series.mode);
    // An authoritative empty array never falls back to deprecated singular outlook fields.
    for (const rawGroup of series.basis_groups) {
      const group = row(rawGroup), o = row(group?.outlook), take = row(o?.directional_take);
      const id = str(o?.outlook_id), basisId = str(group?.basis_id), family = str(group?.target_family_key);
      if (!group || !o || !take || !id || !basisId || !family) { reject(id, "missing-outlook-identity"); continue; }
      const basisProblems = [
        ...(group.basis_status !== "verified" ? ["basis_status"] : []),
        ...(group.grounding_status !== "actionable" ? ["grounding_status"] : []),
        ...referenceProblems(group.resolution_reference, asset, basisId, now).map(field => `resolution_reference.${field}`),
        ...referenceProblems(group.execution_reference, asset, basisId, now).map(field => `execution_reference.${field}`),
      ];
      if (basisProblems.length) {
        reject(id, `unverified-execution-basis: ${basisProblems.join(", ")}`); continue;
      }
      const anchorAt = instant(o.anchor_at), publishedAt = instant(o.published_at), observedAt = instant(o.observed_at);
      if (anchorAt === null || publishedAt === null || observedAt === null || publishedAt > now || observedAt > now) {
        const fields = [
          ...(anchorAt === null ? ["outlook.anchor_at"] : []),
          ...(publishedAt === null || publishedAt > now ? ["outlook.published_at"] : []),
          ...(observedAt === null || observedAt > now ? ["outlook.observed_at"] : []),
        ];
        reject(id, `missing-or-future-original-time: ${fields.join(", ")}`); continue;
      }
      if (anchorAt < now + 6 * HOUR) { reject(id, "anchor-less-than-six-hours"); continue; }
      const spot = num(o.spot_at_obs), expectedPrice = num(take.expected_price), expectedLogReturn = num(take.expected_log_return);
      const median = num(o.median_price), p10 = num(o.p10), p25 = num(o.p25), p75 = num(o.p75), p90 = num(o.p90), sigma = num(o.sigma_total);
      const spotGapSigma = num(o.spot_gap_sigma);
      const curveProblems = [
        ...(take.method !== "full_quantile_curve" ? ["directional_take.method"] : []),
        ...(!["complete", "clamped", "unknown"].includes(String(take.range_status)) ? ["directional_take.range_status"] : []),
        ...(!["bullish", "bearish", "neutral"].includes(String(take.side)) ? ["directional_take.side"] : []),
        ...(take.is_price_signal !== false ? ["directional_take.is_price_signal"] : []),
        ...Object.entries({ spot_at_obs: spot, "directional_take.expected_price": expectedPrice,
          median_price: median, p10, p25, p75, p90, sigma_total: sigma }).filter(([, n]) => n === null || n <= 0).map(([field]) => field),
        ...(expectedLogReturn === null ? ["directional_take.expected_log_return"] : []),
        ...(spotGapSigma === null ? ["spot_gap_sigma"] : []),
        ...(!str(o.status) ? ["status"] : []), ...(!str(o.freshness_state) ? ["freshness_state"] : []),
      ];
      if (curveProblems.length) {
        reject(id, `missing-full-curve-values: ${curveProblems.map(field => `outlook.${field}`).join(", ")}`); continue;
      }
      const probability = num(take.probability_above_spot);
      const ref = row(group.resolution_reference)!;
      outlooks.push({
        id, assetKey: asset.assetKey, marketRef: asset.marketRef, basisId, targetFamilyKey: family,
        anchorAt, publishedAt, observedAt, status: String(o.status), freshnessState: String(o.freshness_state),
        freshnessReason: str(o.freshness_reason), mode,
        basisVerified: true, provider: "hyperliquid", priceField: String(ref.price_field), window: String(ref.window),
        candleInterval: null, groundingStatus: String(group.grounding_status),
        rangeStatus: take.range_status as SwingOutlook["rangeStatus"], method: "full_quantile_curve",
        spotAtObservation: spot!, expectedPrice: expectedPrice!, expectedLogReturn: expectedLogReturn!,
        directionalSide: take.side as SwingOutlook["directionalSide"], medianPrice: median!,
        p10: p10!, p25: p25!, p75: p75!, p90: p90!, sigmaTotal: sigma!,
        spotGapSigma: spotGapSigma!, scoreSigma: num(take.score_sigma),
        probabilityAboveSpot: probability !== null && probability >= 0 && probability <= 1 ? probability : null,
      });
    }
  }
  // Conflicting duplicate identities do not become a first-wins trade authorization.
  const duplicateIds = new Set(outlooks.filter((o, i) => outlooks.findIndex(v => v.id === o.id) !== i).map(o => o.id));
  for (const o of outlooks.filter(o => duplicateIds.has(o.id))) excluded.push({ assetKey: o.assetKey, outlookId: o.id, reason: "duplicate-outlook-id" });
  return { outlooks: outlooks.filter(o => !duplicateIds.has(o.id)).sort((a, b) => a.assetKey.localeCompare(b.assetKey) || a.anchorAt - b.anchorAt || a.id.localeCompare(b.id)), excluded };
}

export class SwingQuotientDataClient {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private directory: { at: number; assets: SwingCoveredAsset[] } | null = null;
  private snapshot: SwingQuotientSnapshot | null = null;
  private refreshPending?: Promise<SwingQuotientSnapshot>;
  private directoryPending?: Promise<SwingCoveredAsset[]>;
  private queue: Promise<unknown> = Promise.resolve();
  private retryAfter = 0;
  private throttleFailures = 0;
  private transportFailures = 0;
  constructor(private readonly opts: SwingQuotientDataOptions) {
    this.base = new URL(opts.baseUrl);
    if ((this.base.protocol !== "https:" && !(this.base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(this.base.hostname)))
      || this.base.username || this.base.password || this.base.search || this.base.hash || !opts.token) {
      throw new Error("Quotient needs an HTTPS base URL and a nonempty API token");
    }
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private requestFailure(error: unknown, signal: AbortSignal, operation: SwingQuotientUsage["operation"], timeoutMs: number): Error {
    this.transportFailures++;
    this.retryAfter = Math.max(this.retryAfter, this.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(5, this.transportFailures - 1)));
    const timedOut = signal.aborted || (error instanceof Error && error.name === "TimeoutError");
    if (timedOut) return new Error(`Quotient ${operation} request timed out after ${timeoutMs / 1000}s`);
    // Node's fetch cause codes are useful diagnostics; never echo arbitrary
    // transport messages, URLs, response bodies, or credential-bearing headers.
    const cause = row(row(error)?.cause), code = cause?.code ?? row(error)?.code;
    const safeCode = typeof code === "string" && ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"].includes(code) ? ` (${code})` : "";
    return new Error(`Quotient ${operation} request unavailable${safeCode}`);
  }

  private request(path: string, query: URLSearchParams, operation: SwingQuotientUsage["operation"], usd: number): Promise<unknown> {
    const work = this.queue.then(async () => {
      if (this.now() < this.retryAfter) throw new Error(`Quotient Retry-After active until ${new Date(this.retryAfter).toISOString()}`);
      const url = new URL(path, this.base); url.search = query.toString();
      const timeoutMs = operation === "price-outlooks" ? 45_000 : 20_000;
      const signal = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method: "GET", redirect: "error", signal,
          headers: { "x-quotient-api-key": this.opts.token, accept: "application/json" } });
      } catch (error) { throw this.requestFailure(error, signal, operation, timeoutMs); }
      if (!response.ok) {
        if (response.status === 429 || response.status === 503) {
          this.throttleFailures++;
          this.retryAfter = Math.max(this.retryAfter, this.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(5, this.throttleFailures - 1)));
        }
        const retry = response.headers.get("retry-after");
        if (retry) {
          const seconds = /^\d+$/.test(retry) ? Number(retry) : null;
          const until = seconds === null ? Date.parse(retry) : this.now() + seconds * 1000;
          if (Number.isFinite(until)) this.retryAfter = Math.max(this.retryAfter, until);
        }
        throw new Error(`Quotient ${operation} HTTP ${response.status}`);
      }
      this.throttleFailures = 0;
      // Successful paid reads remain charged even if their payload is unusable.
      this.opts.onUsage?.({ operation, usd, at: this.now() });
      let body: string;
      try { body = await response.text(); }
      catch (error) { throw this.requestFailure(error, signal, operation, timeoutMs); }
      this.transportFailures = 0;
      try {
        if (body.length > 8 * 1024 * 1024) throw new Error("oversize");
        return JSON.parse(body) as unknown;
      } catch { throw new Error(`Quotient ${operation} response is malformed`); }
    });
    // One serial queue across discovery and outlooks; do not retry paid calls.
    this.queue = work.catch(() => undefined);
    return work;
  }

  async discover(): Promise<SwingCoveredAsset[]> {
    if (this.directory && this.now() >= this.directory.at && this.now() - this.directory.at < 24 * HOUR) return clone(this.directory.assets);
    this.directoryPending ??= this.request("/api/v1/assets", new URLSearchParams({ platform: "hyperliquid" }), "assets", 0.005)
      .then(value => {
        const assets = normalizeSwingAssets(value); this.directory = { at: this.now(), assets }; return assets;
      }).finally(() => { this.directoryPending = undefined; });
    return clone(await this.directoryPending);
  }

  async refresh(): Promise<SwingQuotientSnapshot> {
    this.refreshPending ??= (async () => {
      const assets = await this.discover();
      const rawResponse = await this.request("/api/v1/price-outlooks", new URLSearchParams(), "price-outlooks", 0.01);
      const receivedAt = this.now();
      const normalized = normalizeSwingOutlooks(rawResponse, assets, receivedAt);
      this.snapshot = { receivedAt, assets, rawResponse, ...normalized };
      return this.snapshot;
    })().finally(() => { this.refreshPending = undefined; });
    return clone(await this.refreshPending);
  }

  cached(): SwingQuotientSnapshot | null { return clone(this.snapshot); }
}

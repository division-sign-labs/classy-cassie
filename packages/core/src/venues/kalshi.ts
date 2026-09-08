// packages/core/src/venues/kalshi.ts
// Kalshi venue adapter (US-regulated prediction market, trade-api/v2).
//
// Kalshi has no official TypeScript SDK, so request signing is implemented
// here with node:crypto per the venue's documented scheme (see AGENTS.md
// carve-out): base64(RSA-PSS-SHA256(timestampMs + METHOD + path)) with salt
// length = digest length, over the path INCLUDING the /trade-api/v2 prefix and
// EXCLUDING the query string, sent as KALSHI-ACCESS-KEY / -TIMESTAMP /
// -SIGNATURE headers. The signed-string format is pinned by known-vector tests
// in packages/core/test/kalshi-signing.test.ts.
//
// Unit boundary (fixed-point contract, verified against docs.kalshi.com on
// 2026-08-23): Kalshi completed its fixed-point migration in March 2026.
// Prices are dollar strings ("0.5600", *_dollars fields), contract counts are
// fixed-point strings with 0.01 granularity (*_fp fields — fractional
// contracts are real), and the legacy integer-cent fields are gone from
// market-data responses (balance still carries integer cents alongside
// balance_dollars). Cassie speaks USD decimals with prices 0–1; one Kalshi
// contract maps 1:1 to a Polymarket outcome share. Conversion happens in the
// exported helpers.
//
// Order placement uses the V2 endpoint POST /portfolio/events/orders, which
// quotes everything from the YES book: side "bid" buys YES exposure, "ask"
// sells it. Cassie's (BUY/SELL, outcome YES/NO, outcome-space price) collapses
// onto that book: BUY NO ≡ ask at 1 − noPrice, SELL NO ≡ bid at 1 − noPrice.
// The legacy /portfolio/orders write path is deprecated (sunset no earlier
// than 2026-05-06) and not used here.
//
// No crypto wallet: auth is an API key id (UUID, non-secret) plus an RSA
// private key stored in the keystore as single-line base64 PKCS#8 DER — never
// a multi-line PEM, which the deploy env-file path rejects.
//
// Kalshi settles cash automatically at resolution (no redeem flow) and has no
// dead man's switch (no heartbeat) — the engine's TTL cancels are the only
// order safety net.

import { constants as cryptoConstants, createHash, createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import type {
  AwaitFundingOpts,
  Balance,
  BookLevel,
  Fill,
  FundingInstructions,
  Order,
  OrderAck,
  OrderBook,
  OrderIntent,
  OrderLifecycleHooks,
  PredictionCancellationResult,
  PredictionExecutionMarket,
  PredictionOrderState,
  OrderStatus,
  Position,
  Quote,
  SetupContext,
  VenueAccount,
  VenueAdapter,
} from "../types.js";
import { registerAdapter, type AdapterOpts } from "./registry.js";
import { KeyRoles } from "../wallet/keystore.js";
import { boundFetch } from "../http.js";

type KalshiAccount = Extract<VenueAccount, { venue: "kalshi" }>;

/** Client-side minimum gap between write actions (basic-tier limits). */
const MIN_ACTION_GAP_MS = 250;
const MAX_RETRIES_429 = 2;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Parse a fixed-point dollars/count string (or legacy number) defensively. */
export function parseFp(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Format a 0–1 price as a Kalshi dollars string, clamped to the cent grid [0.01, 0.99]. */
export function priceToDollars(price: number): string {
  const cents = Math.min(99, Math.max(1, Math.round(price * 100)));
  return (cents / 100).toFixed(2);
}

/**
 * Format a contract count as a fixed-point string (0.01 granularity).
 * Returns null for sizes that round to zero — the caller skips those.
 */
export function countToFp(size: number): string | null {
  const rounded = Math.round(size * 100) / 100;
  if (!(rounded >= 0.01)) return null;
  return rounded.toFixed(2);
}

/** The exact string Kalshi signs: timestampMs + METHOD + path (with /trade-api/v2, no query). */
export function kalshiSigningPayload(timestampMs: string, method: string, path: string): string {
  return `${timestampMs}${method.toUpperCase()}${path}`;
}

export function signKalshiRequest(privateKey: KeyObject, timestampMs: string, method: string, path: string): string {
  const payload = kalshiSigningPayload(timestampMs, method, path);
  return cryptoSign("sha256", Buffer.from(payload, "utf8"), {
    key: privateKey,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64");
}

/**
 * Normalize an RSA private key — multi-line PEM (PKCS#8 or PKCS#1) or an
 * already-normalized base64 line — to single-line base64 PKCS#8 DER, the only
 * form stored in the keystore and RuntimeCreds.
 */
export function normalizeKalshiPrivateKey(input: string): string {
  const trimmed = input.trim();
  let key: KeyObject;
  try {
    if (trimmed.includes("-----BEGIN")) {
      key = createPrivateKey(trimmed);
    } else {
      key = createPrivateKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "pkcs8" });
    }
  } catch (err) {
    const message = (err as NodeJS.ErrnoException).code === "ERR_MISSING_PASSPHRASE"
      ? "the key is passphrase-encrypted — export an unencrypted key from Kalshi and retry"
      : `not a valid RSA private key (${(err as Error).message})`;
    throw new Error(`kalshi private key: ${message}`);
  }
  return key.export({ format: "der", type: "pkcs8" }).toString("base64");
}

export function decodeKalshiPrivateKey(b64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
}

type FpLevel = [string | number, string | number];

/**
 * Build the YES-perspective book from Kalshi's resting-bids-only shape
 * (orderbook_fp.yes_dollars / no_dollars — dollar-price × fp-count pairs):
 * bids = yes levels (best = highest first); asks = mirrored no levels at
 * (1 − noPrice) (best = lowest first). The engine mirrors again for NO
 * orders, consistent with the fixture/Polymarket contract.
 */
export function synthesizeKalshiBook(
  marketRef: string,
  yes: FpLevel[] | null | undefined,
  no: FpLevel[] | null | undefined,
  ts: number,
): OrderBook {
  const bids: BookLevel[] = (yes ?? [])
    .map(([price, count]) => ({ price: parseFp(price), size: parseFp(count) }))
    .filter((l) => l.size > 0)
    .sort((a, b) => b.price - a.price);
  const asks: BookLevel[] = (no ?? [])
    .map(([price, count]) => ({ price: Number((1 - parseFp(price)).toFixed(6)), size: parseFp(count) }))
    .filter((l) => l.size > 0)
    .sort((a, b) => a.price - b.price);
  return { marketRef, bids, asks, ts };
}

interface KalshiMarketPosition {
  ticker: string;
  position_fp?: string | number;
  market_exposure_dollars?: string | number;
  realized_pnl_dollars?: string | number;
  /** Legacy pre-migration fields, tolerated as fallback. */
  position?: number;
  market_exposure?: number;
  realized_pnl?: number;
}

/** Positive contract count = YES exposure; negative = NO. avgPrice in the held side's own space. */
export function mapKalshiPosition(row: KalshiMarketPosition): Position | null {
  const signed = row.position_fp !== undefined ? parseFp(row.position_fp) : (row.position ?? 0);
  if (!signed) return null;
  const size = Math.abs(signed);
  const side = signed > 0 ? ("YES" as const) : ("NO" as const);
  const exposureUsd =
    row.market_exposure_dollars !== undefined
      ? parseFp(row.market_exposure_dollars)
      : (row.market_exposure ?? 0) / 100;
  const realizedUsd =
    row.realized_pnl_dollars !== undefined
      ? parseFp(row.realized_pnl_dollars)
      : row.realized_pnl !== undefined
        ? row.realized_pnl / 100
        : undefined;
  return {
    marketRef: row.ticker,
    ...outcomeIdentity(row.ticker, side),
    side,
    size,
    avgPrice: size > 0 && exposureUsd > 0 ? Number((exposureUsd / size).toFixed(6)) : 0,
    realizedPnl: realizedUsd,
    label: row.ticker,
  };
}

/**
 * Map cassie's (side, outcome) onto the V2 YES-book order: bid buys YES
 * exposure, ask sells it; NO prices mirror to 1 − p. The engine already
 * mirrors NO prices before placeOrder, so intent.limitPrice for outcome NO is
 * NO-space here.
 */
export function toBookOrder(
  side: "BUY" | "SELL",
  outcome: "YES" | "NO",
  outcomeSpacePrice: number,
): { bookSide: "bid" | "ask"; yesPrice: number } {
  const buysYesExposure = (side === "BUY") === (outcome === "YES");
  const yesPrice = outcome === "NO" ? 1 - outcomeSpacePrice : outcomeSpacePrice;
  return { bookSide: buysYesExposure ? "bid" : "ask", yesPrice };
}

type Direction = { side: "BUY" | "SELL"; outcome: "YES" | "NO" };
type KalshiOrderRow = {
  order_id: string; client_order_id?: string; ticker: string;
  book_side?: string; outcome_side?: string; action?: string; side?: string;
  yes_price_dollars?: string | number; yes_price?: number;
  initial_count_fp?: string | number; initial_count?: number;
  remaining_count_fp?: string | number; remaining_count?: number;
  fill_count_fp?: string | number; fill_count?: number;
  status?: string; created_time?: string; expiration_time?: string;
};
type KalshiMarket = {
  ticker?: string; event_ticker?: string; status?: string; close_time?: string; open_time?: string;
  market_type?: string; fractional_trading_enabled?: boolean; volume_24h_fp?: string | number;
  price_level_structure?: string;
  price_ranges?: Array<{ start: string; end: string; step: string }>;
};

function outcomeIdentity(marketRef: string, outcome: "YES" | "NO") {
  return { conditionId: `kalshi:${marketRef}`, tokenId: `kalshi:${marketRef}:${outcome}`, outcome };
}

/** A UUID preserves direction through V2's collapse of BUY NO and SELL YES.
 * The remaining 90 hash bits keep client-order ids deterministic and distinct.
 * No key material is involved: this is an idempotency tag, not a signature. */
function executionClientId(intent: OrderIntent): string {
  const code = (intent.side === "SELL" ? 2 : 0) + (intent.outcome === "NO" ? 1 : 0);
  const h = createHash("sha256").update(JSON.stringify([intent.marketRef, intent.clientId, code])).digest("hex");
  return `ca551e0${code}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function taggedDirection(clientId?: string): Direction | undefined {
  const match = /^ca551e0([0-3])-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/i.exec(clientId ?? "");
  if (!match) return undefined;
  const code = Number(match[1]);
  return { side: code >= 2 ? "SELL" : "BUY", outcome: code % 2 ? "NO" : "YES" };
}

function direction(row: { book_side?: string; outcome_side?: string; action?: string; side?: string; client_order_id?: string }, saved?: Direction): Direction {
  const selected = saved ?? taggedDirection(row.client_order_id)
    ?? ((row.action === "buy" || row.action === "sell") && (row.side === "yes" || row.side === "no")
      ? { side: row.action === "buy" ? "BUY" as const : "SELL" as const, outcome: row.side === "yes" ? "YES" as const : "NO" as const } : undefined);
  const bookSide = row.book_side ?? (row.outcome_side === "yes" ? "bid" : row.outcome_side === "no" ? "ask" : undefined);
  if (bookSide !== undefined && bookSide !== "bid" && bookSide !== "ask") throw new Error("unknown Kalshi book direction");
  if (row.outcome_side !== undefined && row.outcome_side !== "yes" && row.outcome_side !== "no") throw new Error("unknown Kalshi outcome direction");
  if (row.book_side && row.outcome_side && (row.book_side === "bid") !== (row.outcome_side === "yes")) throw new Error("conflicting Kalshi direction fields");
  if (selected) {
    if (bookSide && toBookOrder(selected.side, selected.outcome, .5).bookSide !== bookSide) throw new Error("Kalshi direction disagrees with submitted outcome");
    return selected;
  }
  // Unmanaged canonical-only activity retains the legacy YES-book representation.
  if (bookSide) return { side: bookSide === "bid" ? "BUY" : "SELL", outcome: "YES" };
  throw new Error("Kalshi order has no recoverable direction");
}

function requiredNumber(value: unknown, label: string): number {
  if (value === null || value === undefined || value === "" || (typeof value !== "number" && typeof value !== "string")) throw new Error(`missing Kalshi ${label}`);
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`invalid Kalshi ${label}`);
  return n;
}

function orderCounts(row: KalshiOrderRow) {
  const size = requiredNumber(row.initial_count_fp ?? row.initial_count, "initial order count");
  const remaining = requiredNumber(row.remaining_count_fp ?? row.remaining_count, "remaining order count");
  // initial-minus-remaining includes canceled contracts; never infer matches from it.
  const matched = requiredNumber(row.fill_count_fp ?? row.fill_count, "filled order count");
  if (size <= 0 || remaining < 0 || matched < 0 || remaining + matched > size + 1e-8) throw new Error("inconsistent Kalshi order counts");
  return { size, remaining, matched };
}

function mapOrderStatus(status: string | undefined, remaining: number, initial: number): OrderStatus {
  if (status === "canceled" || status === "expired") return "canceled";
  if (status === "executed") return "filled";
  if (status !== "resting") throw new Error(`unknown Kalshi order status: ${status}`);
  return remaining < initial ? "partial" : "open";
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class KalshiAdapter implements VenueAdapter {
  readonly id = "kalshi" as const;
  readonly verifiedAgainst = "2026-09-04";
  readonly supportsNativeTriggers = false;

  private readonly opts: AdapterOpts;
  private readonly fetchImpl: typeof fetch;
  private keyCache?: KeyObject;
  private actionChain: Promise<unknown> = Promise.resolve();
  private lastActionAt = 0;
  private readonly eventRefCache = new Map<string, string>();
  private readonly orderDirections = new Map<string, Direction & { marketRef: string }>();
  private readonly marketTerms = new Map<string, { tickSize: number; minOrderSize: number; observedAt: number }>();

  constructor(opts: AdapterOpts, fetchImpl?: typeof fetch) {
    this.opts = opts;
    this.fetchImpl = boundFetch(fetchImpl);
  }

  private get baseUrl(): string {
    const urls = this.opts.urls.kalshi;
    return (urls.demo ? urls.demoApi : urls.api).replace(/\/$/, "");
  }

  private privateKey(): KeyObject {
    if (this.keyCache) return this.keyCache;
    const creds = this.opts.creds;
    if (!creds || creds.venue !== "kalshi") {
      throw new Error("kalshi adapter needs runtime creds ({ keyId, privateKeyB64 }) for account calls");
    }
    this.keyCache = decodeKalshiPrivateKey(creds.privateKeyB64);
    return this.keyCache;
  }

  private keyId(): string {
    const creds = this.opts.creds;
    if (!creds || creds.venue !== "kalshi") throw new Error("kalshi adapter is missing runtime creds");
    return creds.keyId;
  }

  /** Serialize write actions with a minimum gap (client-side throttle). */
  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.actionChain.then(async () => {
      const wait = this.lastActionAt + MIN_ACTION_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        this.lastActionAt = Date.now();
      }
    });
    this.actionChain = run.catch(() => {});
    return run;
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.auth) {
      const ts = String(Date.now());
      headers["KALSHI-ACCESS-KEY"] = this.keyId();
      headers["KALSHI-ACCESS-TIMESTAMP"] = ts;
      headers["KALSHI-ACCESS-SIGNATURE"] = signKalshiRequest(this.privateKey(), ts, method, url.pathname);
    }

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      if (res.status === 429 && attempt < MAX_RETRIES_429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 750 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw Object.assign(new Error(`kalshi ${method} ${url.pathname} → ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`), { status: res.status,
          submissionRejected: method === "POST" && res.status >= 400 && res.status < 500 && ![408, 409, 429].includes(res.status) });
      }
      return (await res.json()) as T;
    }
  }

  // -------------------------------------------------------------------------
  // Setup and funding
  // -------------------------------------------------------------------------

  async setup(ctx: SetupContext): Promise<VenueAccount> {
    const demo = this.opts.urls.kalshi.demo;
    const site = demo ? "https://demo.kalshi.co" : "https://kalshi.com";
    ctx.print(`Kalshi: ${demo ? "demo" : "production"}`);
    ctx.print("Create an API key and download its private key");
    ctx.print(`${site}/account/api-keys`);
    ctx.openUrl?.(`${site}/account/api-keys`);

    const keyId = (await ctx.ask("Kalshi API key ID")).trim();
    if (!keyId) throw new Error("a Kalshi API key id is required");

    const keyInput = await ctx.ask(
      "Private key file path or base64 key",
      { secret: true },
    );
    const material = existsSync(keyInput.trim()) ? readFileSync(keyInput.trim(), "utf8") : keyInput;
    const b64 = normalizeKalshiPrivateKey(material);
    await ctx.putSecret(KeyRoles.kalshiApi, b64, { runtimeEligible: true });

    // Verify live before returning: a signed balance read exercises the whole
    // auth path. The two classic 401 causes are worth naming.
    const probe = new KalshiAdapter(
      { ...this.opts, creds: { venue: "kalshi", keyId, privateKeyB64: b64 } },
      this.fetchImpl,
    );
    try {
      await probe.request("GET", "/portfolio/balance", { auth: true });
    } catch (err) {
      throw new Error(
        `Kalshi rejected the credentials (${(err as Error).message}). ` +
          `Check that the key belongs to this environment (${demo ? "demo" : "production"} keys only work there) and that this machine's clock is accurate.`,
      );
    }
    ctx.print("Kalshi API key verified.");
    return { venue: "kalshi", keyId };
  }

  async fundingInstructions(_acct: VenueAccount): Promise<FundingInstructions> {
    const demo = this.opts.urls.kalshi.demo;
    return {
      venue: "kalshi",
      addresses: [
        {
          chain: "kalshi.com",
          address: demo ? "https://demo.kalshi.co" : "https://kalshi.com",
          asset: "USD",
          minimum: 0,
          note: "USD only. No crypto deposits.",
        },
      ],
      summary: demo
        ? "Demo balance is pre-funded."
        : "Deposit USD under Account → Deposit.",
    };
  }

  async awaitFunding(_acct: VenueAccount, opts?: AwaitFundingOpts): Promise<Balance> {
    const interval = opts?.intervalMs ?? 15_000;
    const timeout = opts?.timeoutMs ?? 60 * 60_000;
    const start = Date.now();
    for (;;) {
      const [balance] = await this.balances(_acct);
      if (balance && balance.available > 0) return balance;
      if (Date.now() - start > timeout) throw new Error("timed out waiting for a Kalshi balance");
      opts?.onPoll?.("Waiting for USD…");
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  // -------------------------------------------------------------------------
  // Read methods
  // -------------------------------------------------------------------------

  /** Cash only: position value is layered on by computePortfolio, so total = available = free cash. */
  async balances(_acct: VenueAccount): Promise<Balance[]> {
    const res = await this.request<{ balance?: number; balance_dollars?: string | number }>(
      "GET",
      "/portfolio/balance",
      { auth: true },
    );
    const cash = res.balance_dollars !== undefined ? parseFp(res.balance_dollars) : (res.balance ?? 0) / 100;
    return [{ asset: "USD", total: cash, available: cash }];
  }

  async positions(_acct: VenueAccount): Promise<Position[]> {
    const out: Position[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request<{ market_positions?: KalshiMarketPosition[]; cursor?: string }>(
        "GET",
        "/portfolio/positions",
        { auth: true, query: { limit: 200, cursor, count_filter: "position", subaccount: 0 } },
      );
      for (const row of res.market_positions ?? []) {
        const p = mapKalshiPosition(row);
        if (p) out.push(p);
      }
      cursor = res.cursor || undefined;
    } while (cursor);
    return out;
  }

  async book(marketRef: string): Promise<OrderBook> {
    const res = await this.request<{
      orderbook_fp?: { yes_dollars?: FpLevel[] | null; no_dollars?: FpLevel[] | null };
      orderbook?: { yes?: Array<[number, number]> | null; no?: Array<[number, number]> | null };
    }>("GET", `/markets/${encodeURIComponent(marketRef)}/orderbook`, {});
    if (res.orderbook_fp) {
      return synthesizeKalshiBook(marketRef, res.orderbook_fp.yes_dollars, res.orderbook_fp.no_dollars, Date.now());
    }
    // Legacy cents shape, kept as fallback: [[cents, count]] → dollars.
    const centsToFp = (levels: Array<[number, number]> | null | undefined): FpLevel[] =>
      (levels ?? []).map(([cents, count]) => [cents / 100, count]);
    return synthesizeKalshiBook(marketRef, centsToFp(res.orderbook?.yes), centsToFp(res.orderbook?.no), Date.now());
  }

  async quote(marketRef: string): Promise<Quote> {
    const res = await this.request<{
      market?: {
        yes_bid_dollars?: string | number;
        yes_ask_dollars?: string | number;
        volume_24h_fp?: string | number;
        /** Legacy cents fields, pre-migration fallback. */
        yes_bid?: number;
        yes_ask?: number;
        volume_24h?: number;
      };
    }>("GET", `/markets/${encodeURIComponent(marketRef)}`, {});
    const m = res.market;
    if (!m) throw new Error(`kalshi has no market "${marketRef}"`);
    const bid = m.yes_bid_dollars !== undefined ? parseFp(m.yes_bid_dollars) : (m.yes_bid ?? 0) / 100;
    const ask = m.yes_ask_dollars !== undefined ? parseFp(m.yes_ask_dollars) : (m.yes_ask ?? 100) / 100;
    const mid = (bid + ask) / 2;
    // Volume is a contract count; approximate USD notional as contracts × mid
    // (each contract's traded premium is somewhere in (0, 1)).
    const contracts = m.volume_24h_fp !== undefined ? parseFp(m.volume_24h_fp) : (m.volume_24h ?? 0);
    const volume24h = contracts * (mid > 0 ? mid : 0.5);
    return {
      marketRef,
      bid,
      ask,
      mid,
      volume24h,
      spreadBps: mid > 0 ? ((ask - bid) / mid) * 10_000 : 0,
      ts: Date.now(),
    };
  }

  /** Resolve the canonical Kalshi event ticker; never infer it from market ticker syntax. */
  async eventRef(marketRef: string): Promise<string | undefined> {
    const cached = this.eventRefCache.get(marketRef);
    if (cached) return cached;
    try {
      const res = await this.request<{ market?: { event_ticker?: unknown } }>(
        "GET",
        `/markets/${encodeURIComponent(marketRef)}`,
      );
      const rawTicker = res.market?.event_ticker;
      if (typeof rawTicker !== "string") return undefined;
      const ticker = rawTicker.trim();
      if (!ticker) return undefined;
      const ref = `kalshi:${ticker}`;
      this.eventRefCache.set(marketRef, ref);
      return ref;
    } catch {
      return undefined;
    }
  }

  /** The durable executor consumes a selected-outcome book, including NO prices. */
  async executionMarket(marketRef: string, outcome: "YES" | "NO"): Promise<PredictionExecutionMarket> {
    const [res, yesBook] = await Promise.all([
      this.request<{ market?: KalshiMarket }>("GET", `/markets/${encodeURIComponent(marketRef)}`), this.book(marketRef),
    ]);
    const m = res.market;
    if (!m || m.ticker !== marketRef || m.market_type !== "binary") throw new Error("invalid Kalshi execution market identity");
    const ranges = m.price_ranges;
    // A single conservative grid must be valid in every price band. Unknown grids
    // fail closed instead of silently changing a submitted price.
    const steps = ranges?.map(r => requiredNumber(r.step, "price step"));
    const tickSize = steps?.length ? Math.max(...steps) : m.price_level_structure === "linear_cent" ? .01 : NaN;
    if (!(tickSize > 0 && tickSize < 1) || (ranges && ranges.some((r, i) => {
      const start = requiredNumber(r.start, "price range start"), end = requiredNumber(r.end, "price range end"), step = steps![i]!;
      return step <= 0 || start < 0 || end > 1 || end <= start || Math.abs(tickSize / step - Math.round(tickSize / step)) > 1e-6 || Math.abs(start / step - Math.round(start / step)) > 1e-6;
    }))) throw new Error("unsupported Kalshi price grid");
    const observedAt = Date.now(), minOrderSize = m.fractional_trading_enabled === true ? .01 : 1;
    this.marketTerms.set(marketRef, { tickSize, minOrderSize, observedAt });
    if (m.event_ticker) this.eventRefCache.set(marketRef, `kalshi:${m.event_ticker}`);
    const mirror = (levels: BookLevel[]) => levels.map(l => ({ price: Number((1 - l.price).toFixed(6)), size: l.size }));
    const book = outcome === "YES" ? yesBook : { marketRef, ts: yesBook.ts,
      bids: mirror(yesBook.asks).sort((a, b) => b.price - a.price), asks: mirror(yesBook.bids).sort((a, b) => a.price - b.price) };
    const bid = book.bids[0]?.price ?? 0, ask = book.asks[0]?.price ?? 1, mid = (bid + ask) / 2;
    const closeAt = Date.parse(m.close_time ?? ""), openAt = Date.parse(m.open_time ?? "");
    return { marketRef, ...outcomeIdentity(marketRef, outcome), tickSize, minOrderSize,
      acceptingOrders: m.status === "active" && Number.isFinite(closeAt) && closeAt > observedAt && (!m.open_time || (Number.isFinite(openAt) && openAt <= observedAt)), observedAt, book,
      quote: { marketRef, bid, ask, mid, ts: book.ts, spreadBps: mid > 0 ? (ask - bid) / mid * 10_000 : 0, volume24h: parseFp(m.volume_24h_fp) * mid } };
  }

  normalizeOrderSize(size: number): number {
    return Number.isFinite(size) && size > 0 ? Math.floor(size * 100 + 1e-9) / 100 : 0;
  }

  async tokenBalance(acct: VenueAccount, tokenId: string): Promise<number> {
    const match = /^kalshi:(.+):(YES|NO)$/.exec(tokenId);
    if (!match) throw new Error("invalid Kalshi outcome token identity");
    const positions = await this.positions(acct);
    return positions.filter(p => p.tokenId === tokenId).reduce((sum, p) => sum + p.size, 0);
  }

  private rememberOrder(row: KalshiOrderRow): Direction {
    const d = direction(row, this.orderDirections.get(row.order_id));
    this.orderDirections.set(row.order_id, { ...d, marketRef: row.ticker });
    return d;
  }

  private async readOrder(id: string): Promise<KalshiOrderRow | null> {
    try {
      const res = await this.request<{ order?: KalshiOrderRow }>("GET", `/portfolio/orders/${encodeURIComponent(id)}`, { auth: true, query: { subaccount: 0 } });
      if (!res.order || res.order.order_id !== id || !res.order.ticker) throw new Error("invalid Kalshi order lookup identity");
      this.rememberOrder(res.order);
      return res.order;
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }

  async executionOrder(_acct: VenueAccount, orderId: string): Promise<PredictionOrderState | null> {
    const row = await this.readOrder(orderId);
    if (!row) return null;
    const { size, remaining, matched } = orderCounts(row);
    const status: PredictionOrderState["status"] = row.status === "resting" && remaining > 0 ? "open"
      : row.status === "executed" && remaining === 0 && Math.abs(matched - size) < 1e-8 ? "matched"
      : row.status === "canceled" && remaining === 0 ? "canceled"
      : row.status === "expired" && remaining === 0 ? "expired" : "unknown";
    return { orderId, status, size, matchedSize: matched, observedAt: Date.now() };
  }

  async openOrders(_acct: VenueAccount): Promise<Order[]> {
    const out: Order[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request<{ orders?: KalshiOrderRow[]; cursor?: string }>("GET", "/portfolio/orders", {
        auth: true, query: { status: "resting", limit: 200, cursor, subaccount: 0 },
      });
      for (const row of res.orders ?? []) {
        const d = this.rememberOrder(row), { size, remaining, matched } = orderCounts(row);
        const yesPrice = row.yes_price_dollars !== undefined ? requiredNumber(row.yes_price_dollars, "order price") : requiredNumber(row.yes_price, "order price") / 100;
        out.push({ id: row.order_id, clientId: row.client_order_id, marketRef: row.ticker,
          ...outcomeIdentity(row.ticker, d.outcome), side: d.side, size, filledSize: matched,
          price: d.outcome === "NO" ? Number((1 - yesPrice).toFixed(6)) : yesPrice,
          tif: "GTC", status: mapOrderStatus(row.status, remaining, size), createdAt: row.created_time ? Date.parse(row.created_time) : undefined });
      }
      cursor = res.cursor || undefined;
    } while (cursor);
    return out;
  }

  async fills(_acct: VenueAccount, sinceTs: number): Promise<Fill[]> {
    const out: Fill[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request<{ fills?: Array<{
        fill_id?: string; trade_id?: string; order_id?: string; client_order_id?: string;
        ticker?: string; market_ticker?: string; book_side?: string; outcome_side?: string; action?: string; side?: string;
        count_fp?: string | number; count?: number; yes_price_dollars?: string | number; yes_price?: number;
        fee_cost?: string | number; created_time?: string; ts?: number;
      }>; cursor?: string }>("GET", "/portfolio/fills", { auth: true,
        query: { min_ts: Math.max(0, Math.floor(sinceTs / 1000)), limit: 200, cursor, subaccount: 0 } });
      for (const f of res.fills ?? []) {
        const ts = f.created_time ? Date.parse(f.created_time) : f.ts !== undefined ? f.ts * 1000 : NaN;
        if (!Number.isFinite(ts)) throw new Error("invalid Kalshi fill timestamp");
        if (ts < sinceTs) continue;
        const marketRef = f.ticker ?? f.market_ticker, id = f.fill_id ?? f.trade_id;
        if (!marketRef || !id) throw new Error("missing Kalshi fill identity");
        // The Fill API need not return client_order_id. Fetch the original order
        // to recover our UUID-tagged outcome after process restart.
        let saved = f.order_id ? this.orderDirections.get(f.order_id) : undefined;
        if (!saved && f.order_id && f.fee_cost !== undefined && !taggedDirection(f.client_order_id)) {
          const row = await this.readOrder(f.order_id);
          if (!row) throw new Error(`Kalshi fill order ${f.order_id} is unavailable for reconciliation`);
          saved = this.orderDirections.get(f.order_id);
        }
        if (saved && saved.marketRef !== marketRef) throw new Error("Kalshi fill market differs from its order");
        const d = direction(f, saved);
        const yesPrice = f.yes_price_dollars !== undefined ? requiredNumber(f.yes_price_dollars, "fill price") : requiredNumber(f.yes_price, "fill price") / 100;
        const size = requiredNumber(f.count_fp ?? f.count, "fill count"), fee = f.fee_cost === undefined ? undefined : requiredNumber(f.fee_cost, "fill fee");
        if (!(yesPrice > 0 && yesPrice < 1 && size > 0) || (fee !== undefined && fee < 0)) throw new Error("invalid Kalshi fill terms");
        out.push({ id, orderId: f.order_id, marketRef, ...outcomeIdentity(marketRef, d.outcome), side: d.side, size,
          price: d.outcome === "NO" ? Number((1 - yesPrice).toFixed(6)) : yesPrice, ts, fee, settlementStatus: "CONFIRMED" });
      }
      cursor = res.cursor || undefined;
    } while (cursor);
    return out.sort((a, b) => a.ts - b.ts);
  }

  /** Kalshi matches update cash/inventory immediately; there is no chain settlement. */
  async tradeSettlements(acct: VenueAccount, sinceTs: number): Promise<Fill[]> {
    const fills = await this.fills(acct, sinceTs);
    if (fills.some(f => f.fee === undefined)) throw new Error("Kalshi fill fee missing; execution accounting cannot reconcile");
    return fills;
  }

  // -------------------------------------------------------------------------
  // Trading
  // -------------------------------------------------------------------------

  async placeOrder(acct: VenueAccount, intent: OrderIntent): Promise<OrderAck> {
    return this.submitOrder(acct, intent);
  }

  async placeOrderWithLifecycle(acct: VenueAccount, intent: OrderIntent, hooks: OrderLifecycleHooks): Promise<OrderAck> {
    return this.submitOrder(acct, intent, hooks);
  }

  private async submitOrder(_acct: VenueAccount, intent: OrderIntent, hooks?: OrderLifecycleHooks): Promise<OrderAck> {
    const outcome = intent.outcome ?? "YES", identity = outcomeIdentity(intent.marketRef, outcome);
    if ((intent.tokenId && intent.tokenId !== identity.tokenId) || (intent.conditionId && intent.conditionId !== identity.conditionId)) throw new Error("Kalshi order outcome identity mismatch");
    if (!Number.isFinite(intent.limitPrice) || !(intent.limitPrice > 0 && intent.limitPrice < 1)) throw new Error("invalid Kalshi limit price");
    if (intent.postOnly && intent.tif !== "GTC") throw new Error("Kalshi post-only requires GTC");
    if (intent.expiration !== undefined && (intent.tif !== "GTC" || !Number.isInteger(intent.expiration) || intent.expiration <= Date.now() / 1000)) throw new Error("Kalshi expiry requires GTC and a future Unix timestamp in seconds");
    const terms = this.marketTerms.get(intent.marketRef);
    if (hooks && (!terms || Date.now() - terms.observedAt > 10_000)) throw new Error("Kalshi execution terms require a fresh executionMarket read");
    const size = terms?.minOrderSize === 1 ? Math.floor(intent.size) : this.normalizeOrderSize(intent.size);
    const count = Number.isFinite(size) && size >= (terms?.minOrderSize ?? .01) ? size.toFixed(2) : null;
    if (count === null) return { orderId: "", clientId: intent.clientId, status: "rejected" };
    const tick = terms?.tickSize ?? .01;
    // Round toward the authorized limit in outcome space, never through it.
    const ticks = intent.limitPrice / tick;
    const price = Number(((intent.side === "BUY" ? Math.floor(ticks + 1e-9) : Math.ceil(ticks - 1e-9)) * tick).toFixed(6));
    if (!(price > 0 && price < 1)) throw new Error("Kalshi price rounds outside the executable grid");
    const { bookSide, yesPrice } = toBookOrder(intent.side, outcome, price);
    const timeInForce = intent.tif === "IOC" || intent.tif === "FAK" ? "immediate_or_cancel"
      : intent.tif === "FOK" ? "fill_or_kill" : intent.tif === "GTC" ? "good_till_canceled" : undefined;
    if (!timeInForce) throw new Error("unsupported Kalshi time in force");
    const body: Record<string, unknown> = {
      ticker: intent.marketRef,
      // Legacy callers retain their client id; durable execution always uses a
      // UUID carrying side/outcome so authenticated reads can reconstruct it.
      client_order_id: hooks ? executionClientId({ ...intent, outcome }) : intent.clientId,
      side: bookSide, count, price: Number(yesPrice.toFixed(6)).toFixed(Math.max(2, (Number(yesPrice.toFixed(6)).toString().split(".")[1] ?? "").length)),
      time_in_force: timeInForce, self_trade_prevention_type: "taker_at_cross", subaccount: 0,
      ...(intent.postOnly !== undefined ? { post_only: intent.postOnly } : {}),
      ...(intent.expiration !== undefined ? { expiration_time: intent.expiration } : {}),
      ...(hooks ? { cancel_order_on_pause: true } : {}),
      ...(intent.reduceOnly || (hooks && intent.side === "SELL") ? { reduce_only: true } : {}),
    };
    const preparedHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const res = await this.throttled(async () => {
      // This hook is inside the write throttle, immediately before request signing
      // and POST. If it fails, nothing has been submitted to the venue.
      await hooks?.onPrepared({ preparedHash, ...identity, limitPrice: price, size });
      return this.request<{ order_id: string; client_order_id?: string; fill_count?: string | number;
        remaining_count?: string | number; average_fill_price?: string | number }>("POST", "/portfolio/events/orders", { auth: true, body });
    });
    if (!res.order_id) throw new Error("kalshi order returned no order_id");
    this.orderDirections.set(res.order_id, { side: intent.side, outcome, marketRef: intent.marketRef });
    const filled = requiredNumber(res.fill_count, "acknowledged fill count"), remaining = requiredNumber(res.remaining_count, "acknowledged remaining count");
    if (filled < 0 || remaining < 0 || filled + remaining > size + 1e-8) throw new Error("inconsistent Kalshi order acknowledgement counts");
    // An IOC can partially fill and cancel the remainder; zero remaining is
    // not evidence that the original requested quantity completely filled.
    const status: OrderStatus = filled + 1e-8 >= size ? "filled" : remaining === 0 ? "canceled" : filled > 0 ? "partial" : "open";
    const avgYes = res.average_fill_price !== undefined ? requiredNumber(res.average_fill_price, "average fill price") : undefined;
    if (filled > 0 && (avgYes === undefined || avgYes <= 0 || avgYes >= 1)) throw new Error("Kalshi fill acknowledgement has no valid average price");
    return { orderId: res.order_id, clientId: intent.clientId, status, filledSize: filled > 0 ? filled : undefined,
      avgFillPrice: filled > 0 && avgYes !== undefined ? (outcome === "NO" ? Number((1 - avgYes).toFixed(6)) : avgYes) : undefined,
      tokenId: identity.tokenId, ...(hooks ? { preparedHash } : {}) };
  }

  async cancelOrderChecked(_acct: VenueAccount, id: string): Promise<PredictionCancellationResult> {
    const cached = this.orderDirections.get(id);
    const marketRef = cached?.marketRef ?? (await this.readOrder(id))?.ticker;
    if (!marketRef) return { status: "not-canceled", reason: "order unavailable for authoritative cancellation" };
    try {
      const res = await this.throttled(() => this.request<{ order_id?: string; reduced_by?: string | number }>("DELETE", `/portfolio/events/orders/${encodeURIComponent(id)}`, {
        auth: true, query: { market_ticker: marketRef, subaccount: 0 },
      }));
      const reduced = Number(res.reduced_by);
      return res.order_id === id && res.reduced_by !== undefined && Number.isFinite(reduced) && reduced >= 0
        ? { status: "canceled" } : { status: "not-canceled", reason: "venue returned no matching cancellation acknowledgement" };
    } catch (error) {
      if ((error as { status?: number }).status === 404) return { status: "not-canceled", reason: "venue reports order not found; reconcile order state" };
      throw error;
    }
  }

  async cancelOrder(acct: VenueAccount, id: string): Promise<void> {
    if (this.orderDirections.has(id)) {
      const result = await this.cancelOrderChecked(acct, id);
      if (result.status !== "canceled") throw new Error(`Kalshi cancellation unconfirmed: ${result.reason}`);
      return;
    }
    // Legacy callers address the default exchange shard directly. The durable
    // executor uses cancelOrderChecked, which resolves the market for routing.
    const res = await this.throttled(() => this.request<{ order_id?: string; reduced_by?: string | number }>("DELETE", `/portfolio/events/orders/${encodeURIComponent(id)}`, { auth: true }));
    if (res.order_id !== id || res.reduced_by === undefined || !Number.isFinite(Number(res.reduced_by)) || Number(res.reduced_by) < 0) throw new Error("Kalshi cancellation unconfirmed");
  }

  /** Attempt every cancellation, then report failures so stop cannot claim success. */
  async cancelAll(acct: VenueAccount): Promise<void> {
    const open = await this.openOrders(acct), errors: unknown[] = [];
    for (const o of open) {
      try { await this.cancelOrder(acct, o.id); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Kalshi account cancellation incomplete");
  }
}

registerAdapter("kalshi", (opts) => new KalshiAdapter(opts));

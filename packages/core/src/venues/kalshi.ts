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

import { constants as cryptoConstants, createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
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

function mapOrderStatus(status: string | undefined, remaining: number, initial: number): OrderStatus {
  if (status === "canceled") return "canceled";
  if (status === "executed") return "filled";
  if (remaining <= 0 && initial > 0) return "filled";
  if (remaining < initial) return "partial";
  return "open";
}

/** BUY/SELL on the YES book from the new canonical fields, legacy action as fallback. */
function bookSideToOrderSide(row: { book_side?: string; outcome_side?: string; action?: string; side?: string }): "BUY" | "SELL" {
  if (row.book_side) return row.book_side === "bid" ? "BUY" : "SELL";
  if (row.outcome_side) return row.outcome_side === "yes" ? "BUY" : "SELL";
  if (row.action === "sell") return "SELL";
  return "BUY";
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class KalshiAdapter implements VenueAdapter {
  readonly id = "kalshi" as const;
  readonly verifiedAgainst = "2026-08-23";
  readonly supportsNativeTriggers = false;

  private readonly opts: AdapterOpts;
  private readonly fetchImpl: typeof fetch;
  private keyCache?: KeyObject;
  private actionChain: Promise<unknown> = Promise.resolve();
  private lastActionAt = 0;
  private readonly eventRefCache = new Map<string, string>();

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
        throw new Error(`kalshi ${method} ${url.pathname} → ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
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
    ctx.print(`Kalshi environment: ${demo ? "demo (paper funds, separate keys)" : "production"}.`);
    ctx.print(`Create an API key under Account → API Keys on ${site}; download the RSA private key when prompted — Kalshi shows it once.`);
    ctx.openUrl?.(`${site}/account/api-keys`);

    const keyId = (await ctx.ask("Kalshi API key id (UUID from the API Keys page)")).trim();
    if (!keyId) throw new Error("a Kalshi API key id is required");

    const keyInput = await ctx.ask(
      "Path to the downloaded private key file (or paste a single-line base64 key)",
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
          address: demo ? "demo.kalshi.co (pre-funded)" : "kalshi.com → Account → Deposit",
          asset: "USD",
          minimum: 0,
          note: "Kalshi is funded by ACH, debit, or wire on the website — there is no crypto deposit address.",
        },
      ],
      summary: demo
        ? "Demo accounts come pre-funded with paper money; nothing to send."
        : "Deposit USD on kalshi.com (Account → Deposit: ACH, debit, or wire). Cassie polls your API balance until it arrives.",
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
      opts?.onPoll?.("no Kalshi balance yet — deposits land on kalshi.com, not on-chain");
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
        { auth: true, query: { limit: 200, cursor, count_filter: "position" } },
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

  async openOrders(_acct: VenueAccount): Promise<Order[]> {
    const out: Order[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request<{
        orders?: Array<{
          order_id: string;
          client_order_id?: string;
          ticker: string;
          book_side?: string;
          outcome_side?: string;
          action?: string;
          side?: string;
          yes_price_dollars?: string | number;
          initial_count_fp?: string | number;
          remaining_count_fp?: string | number;
          fill_count_fp?: string | number;
          status?: string;
          created_time?: string;
        }>;
        cursor?: string;
      }>("GET", "/portfolio/orders", { auth: true, query: { status: "resting", limit: 200, cursor } });
      for (const o of res.orders ?? []) {
        const initial = parseFp(o.initial_count_fp);
        const remaining = o.remaining_count_fp !== undefined ? parseFp(o.remaining_count_fp) : initial;
        // Prices are reported in YES space — the same space placeOrder converts
        // into, so what the engine reads back matches what it sent.
        out.push({
          id: o.order_id,
          clientId: o.client_order_id,
          marketRef: o.ticker,
          side: bookSideToOrderSide(o),
          size: initial,
          filledSize: o.fill_count_fp !== undefined ? parseFp(o.fill_count_fp) : Math.max(0, initial - remaining),
          price: parseFp(o.yes_price_dollars),
          tif: "GTC",
          status: mapOrderStatus(o.status, remaining, initial),
          createdAt: o.created_time ? Date.parse(o.created_time) : undefined,
        });
      }
      cursor = res.cursor || undefined;
    } while (cursor);
    return out;
  }

  async fills(_acct: VenueAccount, sinceTs: number): Promise<Fill[]> {
    const out: Fill[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request<{
        fills?: Array<{
          fill_id?: string;
          trade_id?: string;
          order_id?: string;
          ticker?: string;
          market_ticker?: string;
          book_side?: string;
          outcome_side?: string;
          action?: string;
          side?: string;
          count_fp?: string | number;
          count?: number;
          yes_price_dollars?: string | number;
          yes_price?: number;
          created_time?: string;
          ts?: number;
        }>;
        cursor?: string;
      }>("GET", "/portfolio/fills", {
        auth: true,
        // Kalshi's min_ts is in seconds.
        query: { min_ts: Math.max(0, Math.floor(sinceTs / 1000)), limit: 200, cursor },
      });
      for (const f of res.fills ?? []) {
        const ts = f.created_time ? Date.parse(f.created_time) : f.ts !== undefined ? f.ts * 1000 : 0;
        if (ts < sinceTs) continue;
        const marketRef = f.ticker ?? f.market_ticker;
        const id = f.fill_id ?? f.trade_id;
        if (!marketRef || !id) continue;
        out.push({
          id,
          orderId: f.order_id,
          marketRef,
          side: bookSideToOrderSide(f),
          size: f.count_fp !== undefined ? parseFp(f.count_fp) : (f.count ?? 0),
          // YES-space fill price, matching the YES-space orders above.
          price: f.yes_price_dollars !== undefined ? parseFp(f.yes_price_dollars) : (f.yes_price ?? 0) / 100,
          ts,
        });
      }
      cursor = res.cursor || undefined;
    } while (cursor);
    return out.sort((a, b) => a.ts - b.ts);
  }

  // -------------------------------------------------------------------------
  // Trading
  // -------------------------------------------------------------------------

  async placeOrder(_acct: VenueAccount, intent: OrderIntent): Promise<OrderAck> {
    const outcome = intent.outcome ?? "YES";
    const count = countToFp(intent.size);
    if (count === null) {
      return { orderId: "", clientId: intent.clientId, status: "rejected" };
    }
    const { bookSide, yesPrice } = toBookOrder(intent.side, outcome, intent.limitPrice);
    const timeInForce =
      intent.tif === "IOC" ? "immediate_or_cancel" : intent.tif === "FOK" ? "fill_or_kill" : "good_till_canceled";
    const body: Record<string, unknown> = {
      ticker: intent.marketRef,
      client_order_id: intent.clientId,
      side: bookSide,
      count,
      price: priceToDollars(yesPrice),
      time_in_force: timeInForce,
      self_trade_prevention_type: "taker_at_cross",
      ...(intent.reduceOnly ? { reduce_only: true } : {}),
    };

    const res = await this.throttled(() =>
      this.request<{
        order_id: string;
        client_order_id?: string;
        fill_count?: string | number;
        remaining_count?: string | number;
        average_fill_price?: string | number;
      }>("POST", "/portfolio/events/orders", { auth: true, body }),
    );
    if (!res.order_id) throw new Error("kalshi order returned no order_id");
    const filled = parseFp(res.fill_count);
    const remaining = parseFp(res.remaining_count);
    const status: OrderStatus =
      remaining <= 0 && filled > 0
        ? "filled"
        : filled > 0
          ? "partial"
          : remaining > 0
            ? "open"
            : "canceled"; // IOC/FOK with nothing crossed
    const avgYes = res.average_fill_price !== undefined ? parseFp(res.average_fill_price) : undefined;
    return {
      orderId: res.order_id,
      clientId: intent.clientId,
      status,
      filledSize: filled > 0 ? filled : undefined,
      // Report the fill in the outcome space the engine ordered in.
      avgFillPrice:
        filled > 0 && avgYes !== undefined ? (outcome === "NO" ? Number((1 - avgYes).toFixed(6)) : avgYes) : undefined,
    };
  }

  async cancelOrder(_acct: VenueAccount, id: string): Promise<void> {
    await this.throttled(() =>
      this.request("DELETE", `/portfolio/events/orders/${encodeURIComponent(id)}`, { auth: true }),
    );
  }

  /** Per-order cancels: the batch endpoint is advanced-tier only; this works on every tier. */
  async cancelAll(acct: VenueAccount): Promise<void> {
    const open = await this.openOrders(acct);
    for (const o of open) {
      await this.cancelOrder(acct, o.id).catch(() => {});
    }
  }
}

registerAdapter("kalshi", (opts) => new KalshiAdapter(opts));

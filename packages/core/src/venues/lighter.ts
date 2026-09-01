// packages/core/src/venues/lighter.ts
// Lighter (zkLighter) venue adapter (§5.3). Perps on a zk-rollup settling to
// Ethereum. Built against the pinned community SDK `lighter-ts-sdk@1.0.13`
// (WASM signer; official SDKs are Python/Go — §5.3, §15.6).
//
// §15.1 VERDICT (verified 2026-08-13 against the installed SDK):
//   The SDK's signer resolves `wasm/lighter-signer.wasm` + `wasm_exec.js` from
//   the package directory on the FILESYSTEM (dist/esm/signer/wasm-signer.js:
//   runtime `import('node:fs'/'node:path')` shims, `resolveWasmPath` →
//   `fs.readFileSync`, then `WebAssembly.instantiate(bytes, go.importObject)`).
//   A droplet has a filesystem, so this loads there the same way it loads on a
//   laptop. What is missing is a verified run: `cassie deploy` still refuses
//   lighter until one happens. Constructing this adapter outside Node throws.
//
// marketRef convention: the market SYMBOL (e.g. "ETH"), resolved to the
// integer market_id via GET /api/v1/orderBooks (cached). A purely numeric
// marketRef is accepted as a raw market_id.
//
// Latency note (§5.3): latency-sensitive Lighter users colocate in AWS Tokyo
// ap-northeast-1a. Irrelevant at cassie's poll cadence.

import type {
  AwaitFundingOpts,
  Balance,
  Candle,
  CandleInterval,
  Fill,
  FundingInstructions,
  Order,
  OrderAck,
  OrderBook,
  OrderIntent,
  Position,
  Quote,
  RuntimeCreds,
  SetupContext,
  VenueAccount,
  VenueAdapter,
} from "../types.js";
import { registerAdapter, type AdapterOpts } from "./registry.js";

// Type-only imports are erased at runtime; the SDK itself loads lazily so that
// importing core does not pull the WASM loader in eagerly.
import type {
  Account as SdkAccount,
  AccountApi,
  AccountPosition as SdkPosition,
  ApiClient,
  BridgeApi,
  CandlestickApi,
  FundingApi,
  FundingRate as SdkFundingRate,
  Order as SdkOrder,
  OrderApi,
  SignerClient,
} from "lighter-ts-sdk";

type LighterAccount = Extract<VenueAccount, { venue: "lighter" }>;
type LighterCreds = Extract<RuntimeCreds, { venue: "lighter" }>;

const SOURCE_CHAINS: Record<string, { chainId: number; label: string }> = {
  arbitrum: { chainId: 42161, label: "Arbitrum One" },
  base: { chainId: 8453, label: "Base" },
  avalanche: { chainId: 43114, label: "Avalanche C-Chain" },
};

const MIN_DEPOSIT_USDC = 5;
const API_KEY_INDEX_DEFAULT = 2; // 0 and 1 are reserved for web/mobile (§5.3)
const AUTH_TOKEN_LIFETIME_S = 8 * 60 * 60; // 8h validity (§5.3)
const AUTH_TOKEN_REFRESH_MS = 7 * 60 * 60 * 1000; // refresh at 7h
// Dead man's switch: scheduled cancel-all this far in the future, refreshed
// every tick while orders rest. Epoch-seconds assumed (matches auth-token
// expiry units in the SDK); if the venue rejects it the engine logs and
// continues — heartbeat is best-effort.
const DEADMAN_WINDOW_S = 15 * 60;

// SDK constants (mirrors LIGHTER_CONSTANTS; kept literal to avoid loading the
// module at import time).
const ORDER_TYPE_LIMIT = 0;
const ORDER_TYPE_STOP_LOSS_LIMIT = 3;
const ORDER_TYPE_TAKE_PROFIT_LIMIT = 5;
const TIF_IOC = 0;
const TIF_GTT = 1;
const TIF_FOK = 2;
const CANCEL_ALL_TIF_IMMEDIATE = 0;
const CANCEL_ALL_TIF_SCHEDULED = 1;

interface MarketMeta {
  marketId: number;
  symbol: string;
  sizeDecimals: number;
  priceDecimals: number;
  minBaseAmount: number;
  minQuoteAmount: number;
  volume24h: number;
  lastTradePrice: number;
}

function assertNode(): void {
  if (typeof process === "undefined" || !process.versions?.node) {
    throw new Error("lighter: the WASM signer requires a Node runtime with filesystem access");
  }
}

export class LighterAdapter implements VenueAdapter {
  readonly id = "lighter" as const;
  readonly verifiedAgainst = "2026-08-13";
  readonly supportsNativeTriggers = true;

  private readonly baseUrl: string;
  private readonly creds?: LighterCreds;

  private sdkPromise?: Promise<typeof import("lighter-ts-sdk")>;
  private apiClient?: ApiClient;
  private accountApi?: AccountApi;
  private orderApi?: OrderApi;
  private candleApi?: CandlestickApi;
  private fundingApi?: FundingApi;
  private bridgeApi?: BridgeApi;
  private signer?: SignerClient;
  private auth?: { token: string; ts: number };
  private marketCache?: { at: number; bySymbol: Map<string, MarketMeta>; byId: Map<number, MarketMeta> };

  constructor(opts: AdapterOpts) {
    assertNode();
    this.baseUrl = opts.urls.lighter.api;
    if (opts.creds && opts.creds.venue === "lighter") this.creds = opts.creds;
  }

  // ---- SDK bootstrap -------------------------------------------------------

  private sdk(): Promise<typeof import("lighter-ts-sdk")> {
    if (!this.sdkPromise) this.sdkPromise = import("lighter-ts-sdk");
    return this.sdkPromise;
  }

  private async apis() {
    const sdk = await this.sdk();
    if (!this.apiClient) {
      this.apiClient = new sdk.ApiClient({ host: this.baseUrl });
      this.accountApi = new sdk.AccountApi(this.apiClient);
      this.orderApi = new sdk.OrderApi(this.apiClient);
      this.candleApi = new sdk.CandlestickApi(this.apiClient);
      this.fundingApi = new sdk.FundingApi(this.apiClient);
      this.bridgeApi = new sdk.BridgeApi(this.apiClient);
    }
    return {
      sdk,
      accountApi: this.accountApi!,
      orderApi: this.orderApi!,
      candleApi: this.candleApi!,
      fundingApi: this.fundingApi!,
      bridgeApi: this.bridgeApi!,
    };
  }

  private async getSigner(): Promise<SignerClient> {
    if (this.signer) return this.signer;
    if (!this.creds) {
      throw new Error("lighter: runtime creds (apiPrivateKey/accountIndex/apiKeyIndex) required for signing");
    }
    const sdk = await this.sdk();
    const signer = new sdk.SignerClient({
      url: this.baseUrl,
      privateKey: this.creds.apiPrivateKey,
      accountIndex: this.creds.accountIndex,
      apiKeyIndex: this.creds.apiKeyIndex,
    });
    await signer.initialize();
    await signer.ensureWasmClient();
    this.signer = signer;
    return signer;
  }

  private async authToken(): Promise<string | undefined> {
    if (!this.creds) return undefined;
    if (this.auth && Date.now() - this.auth.ts < AUTH_TOKEN_REFRESH_MS) return this.auth.token;
    const signer = await this.getSigner();
    const token = await signer.createAuthTokenWithExpiry(AUTH_TOKEN_LIFETIME_S);
    this.auth = { token, ts: Date.now() };
    return token;
  }

  // ---- Market metadata -----------------------------------------------------

  private async markets(): Promise<NonNullable<typeof this.marketCache>> {
    if (this.marketCache && Date.now() - this.marketCache.at < 10 * 60_000) return this.marketCache;
    const { orderApi } = await this.apis();
    const raw = await orderApi.getOrderBookDetailsRaw(255);
    const bySymbol = new Map<string, MarketMeta>();
    const byId = new Map<number, MarketMeta>();
    for (const d of raw.order_book_details ?? []) {
      const meta: MarketMeta = {
        marketId: d.market_id,
        symbol: d.symbol.toUpperCase(),
        sizeDecimals: d.size_decimals,
        priceDecimals: d.price_decimals,
        minBaseAmount: Number(d.min_base_amount ?? "0"),
        minQuoteAmount: Number(d.min_quote_amount ?? "0"),
        volume24h: Number(d.daily_quote_token_volume ?? 0),
        lastTradePrice: Number(d.last_trade_price ?? 0),
      };
      bySymbol.set(meta.symbol, meta);
      byId.set(meta.marketId, meta);
    }
    this.marketCache = { at: Date.now(), bySymbol, byId };
    return this.marketCache;
  }

  private async resolveMarket(marketRef: string): Promise<MarketMeta> {
    const { bySymbol, byId } = await this.markets();
    if (/^\d+$/.test(marketRef)) {
      const meta = byId.get(Number(marketRef));
      if (meta) return meta;
    }
    const meta = bySymbol.get(marketRef.toUpperCase()) ?? bySymbol.get(`${marketRef.toUpperCase()}-USDC`);
    if (!meta) throw new Error(`lighter: unknown market "${marketRef}" (use the symbol, e.g. "ETH", or a numeric market_id)`);
    return meta;
  }

  private async resolveAccountIndex(acct: VenueAccount): Promise<number> {
    const a = acct as LighterAccount;
    if (a.accountIndex !== undefined) return a.accountIndex;
    if (this.creds) return this.creds.accountIndex;
    const { accountApi } = await this.apis();
    const accounts = await accountApi.getAccountsByL1Address(a.l1Address);
    if (!accounts || accounts.length === 0) {
      throw new Error(`lighter: no account found for L1 address ${a.l1Address} — fund it first (deposits create the account)`);
    }
    return Math.min(...accounts.map((x: SdkAccount) => Number(x.index ?? x.account_index)));
  }

  // ---- Setup and funding (§6) ---------------------------------------------

  async setup(ctx: SetupContext): Promise<VenueAccount> {
    const masterPk = await ctx.getSecret("master");
    if (!masterPk) throw new Error("lighter: no master (L1) key in the keystore — run `cassie wallet create` first");
    const { privateKeyToAccount } = await import("viem/accounts");
    const l1Address = privateKeyToAccount(masterPk as `0x${string}`).address;
    ctx.print(`Lighter L1 identity: ${l1Address} (key stays in the local keystore; only the API key is runtime-eligible)`);
    return { venue: "lighter", l1Address };
  }

  async fundingInstructions(acct: VenueAccount): Promise<FundingInstructions> {
    const a = acct as LighterAccount;
    const addresses = Object.entries(a.intentAddresses ?? {}).map(([chain, address]) => ({
      chain,
      address,
      asset: "USDC",
      minimum: MIN_DEPOSIT_USDC,
      note: "CCTP intent address — send USDC from the from_addr it was created for",
    }));
    return {
      venue: "lighter",
      addresses,
      summary:
        `Lighter accepts USDC via CCTP intent addresses from Arbitrum, Base, or Avalanche C-Chain (min ${MIN_DEPOSIT_USDC} USDC), ` +
        `or direct Ethereum-mainnet contract deposits. The first deposit for ${a.l1Address} creates the account. ` +
        `Run \`cassie fund <botId>\` for the guided flow.`,
    };
  }

  async awaitFunding(acct: VenueAccount, opts?: AwaitFundingOpts): Promise<Balance> {
    const a = acct as LighterAccount;
    const { accountApi } = await this.apis();
    const interval = opts?.intervalMs ?? 15_000;
    const timeout = opts?.timeoutMs ?? 60 * 60_000;
    const start = Date.now();
    for (;;) {
      try {
        const accounts = await accountApi.getAccountsByL1Address(a.l1Address);
        if (accounts && accounts.length > 0) {
          const master = accounts.reduce((min: SdkAccount, x: SdkAccount) =>
            Number(x.index ?? x.account_index) < Number(min.index ?? min.account_index) ? x : min,
          );
          const total = Number(master.total_asset_value ?? master.collateral ?? "0");
          if (total > 0) {
            return { asset: "USDC", total, available: Number(master.available_balance ?? total) };
          }
        }
      } catch {
        // "account not found" until the first deposit lands — keep polling.
      }
      if (Date.now() - start > timeout) throw new Error("lighter: timed out waiting for deposit to credit");
      opts?.onPoll?.(`waiting for Lighter deposit to credit ${a.l1Address}…`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  async runFundingFlow(ctx: SetupContext, acct: VenueAccount): Promise<VenueAccount> {
    const a = { ...(acct as LighterAccount) };
    ctx.print(`Funding Lighter account for L1 identity ${a.l1Address}.`);
    ctx.print(`Sources: ${Object.entries(SOURCE_CHAINS).map(([k, v]) => `${k} (${v.label})`).join(", ")} — USDC, min ${MIN_DEPOSIT_USDC}.`);
    const chainAns = (await ctx.ask("Source chain [arbitrum/base/avalanche]", { default: "arbitrum" })).toLowerCase().trim();
    const chain = SOURCE_CHAINS[chainAns];
    if (!chain) throw new Error(`unsupported source chain "${chainAns}"`);
    const fromAddr = (
      await ctx.ask(
        `Sending address on ${chain.label} (the address the USDC will come FROM; intent addresses are bound to it)`,
        { default: a.l1Address },
      )
    ).trim();

    const intentAddress = await this.createIntentAddress(chain.chainId, fromAddr, a);
    a.intentAddresses = { ...(a.intentAddresses ?? {}), [chainAns]: intentAddress };
    ctx.print(``);
    ctx.print(`Send at least ${MIN_DEPOSIT_USDC} USDC on ${chain.label}`);
    ctx.print(`  from: ${fromAddr}`);
    ctx.print(`  to:   ${intentAddress}`);
    ctx.print(`cassie never initiates this transfer — you send it and I watch for arrival.`);

    const bal = await ctx.poll("waiting for the deposit to credit on Lighter", async () => {
      try {
        const b = await this.awaitFunding(a, { intervalMs: 15_000, timeoutMs: 20_000 });
        return b;
      } catch {
        return null;
      }
    });
    ctx.print(`Credited: ${bal.total} USDC.`);

    a.accountIndex = await this.resolveAccountIndex(a);
    ctx.print(`Resolved account_index ${a.accountIndex} for ${a.l1Address}.`);

    await this.provisionApiKey(ctx, a);
    return a;
  }

  /**
   * POST /api/v1/createIntentAddress. For a fresh L1 address this works
   * unauthenticated (verified against SDK examples/onboarding.ts); once an
   * account + API key exist the authenticated variant is used.
   */
  private async createIntentAddress(chainId: number, fromAddr: string, a: LighterAccount): Promise<string> {
    const form = new URLSearchParams({
      chain_id: String(chainId),
      from_addr: fromAddr,
      amount: "0",
      is_external_deposit: "true",
    });
    if (a.accountIndex !== undefined) form.set("account_index", String(a.accountIndex));
    const attempt = async (auth?: string) => {
      const res = await fetch(`${this.baseUrl}/api/v1/createIntentAddress`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          ...(auth ? { authorization: auth, auth } : {}),
        },
        body: form.toString(),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(`createIntentAddress ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
      const addr = body["intent_address"];
      if (typeof addr !== "string" || !addr) throw new Error(`createIntentAddress: no intent_address in response`);
      return addr;
    };
    try {
      return await attempt();
    } catch (err) {
      const token = await this.authToken().catch(() => undefined);
      if (!token) throw err;
      return attempt(token);
    }
  }

  /**
   * Provision the trading API key at index 2 via ChangePubKey (§5.3). The
   * ChangePubKey itself is authorized by the L1 signature; the SDK submits it
   * through a SignerClient. First try self-registration with the new key; if
   * the venue requires an already-registered key for submission, fall back to
   * asking the operator for one (created during web onboarding).
   */
  private async provisionApiKey(ctx: SetupContext, a: LighterAccount): Promise<void> {
    const ethPk = await ctx.getSecret("master");
    if (!ethPk) throw new Error("lighter: master (L1) key missing from keystore");
    const sdk = await this.sdk();
    if (a.accountIndex === undefined) throw new Error("lighter: accountIndex unresolved");

    const wasm = await sdk.createWasmSignerClient({ wasmPath: "wasm/lighter-signer.wasm" });
    await wasm.initialize();
    const pair = await wasm.generateAPIKey(`cassie-${a.l1Address}-${API_KEY_INDEX_DEFAULT}-${Date.now()}`);

    const register = async (authPk: string, authIdx: number) => {
      const signer = new sdk.SignerClient({
        url: this.baseUrl,
        privateKey: authPk,
        accountIndex: a.accountIndex!,
        apiKeyIndex: authIdx,
      });
      await signer.initialize();
      await signer.ensureWasmClient();
      try {
        const [, , err] = await signer.changeApiKey({
          ethPrivateKey: ethPk,
          newPubkey: pair.publicKey,
          newPrivateKey: pair.privateKey,
          newApiKeyIndex: API_KEY_INDEX_DEFAULT,
        });
        if (err && !/already/i.test(err)) throw new Error(err);
      } finally {
        await signer.close?.();
      }
    };

    try {
      // Self-registration: ChangePubKey signed by the L1 key, submitted with the new key.
      await register(pair.privateKey, API_KEY_INDEX_DEFAULT);
    } catch (err) {
      ctx.print(`Self-registration failed (${(err as Error).message.slice(0, 120)}).`);
      ctx.print(`If this account was never onboarded, open app.lighter.xyz once with the bot's L1 wallet, then paste an existing API private key.`);
      const existingPk = await ctx.ask("Existing API private key (from web onboarding)", { secret: true });
      const existingIdx = Number(await ctx.ask("Its api_key_index", { default: "0" }));
      await register(existingPk.trim(), existingIdx);
    }

    await ctx.putSecret("lighter-api", pair.privateKey, { runtimeEligible: true });
    a.apiKeyIndex = API_KEY_INDEX_DEFAULT;
    ctx.print(`API key registered at index ${API_KEY_INDEX_DEFAULT} and stored (runtime-eligible). L1 key stays local-only.`);
  }

  // ---- Reads ---------------------------------------------------------------

  async balances(acct: VenueAccount): Promise<Balance[]> {
    const { accountApi } = await this.apis();
    const idx = await this.resolveAccountIndex(acct);
    const auth = await this.authToken().catch(() => undefined);
    const account = await accountApi.getAccount({ by: "index", value: String(idx) }, auth);
    return [
      {
        asset: "USDC",
        total: Number(account.total_asset_value ?? account.collateral ?? "0"),
        available: Number(account.available_balance ?? "0"),
      },
    ];
  }

  async positions(acct: VenueAccount): Promise<Position[]> {
    const { accountApi } = await this.apis();
    const idx = await this.resolveAccountIndex(acct);
    const auth = await this.authToken().catch(() => undefined);
    const account = await accountApi.getAccount({ by: "index", value: String(idx) }, auth);
    return (account.positions ?? [])
      .filter((p: SdkPosition) => Math.abs(Number(p.position)) > 0)
      .map((p: SdkPosition) => ({
        marketRef: p.symbol?.toUpperCase() ?? String(p.market_id),
        side: Number(p.sign) >= 0 ? ("LONG" as const) : ("SHORT" as const),
        size: Math.abs(Number(p.position)),
        avgPrice: Number(p.avg_entry_price),
        unrealizedPnl: Number(p.unrealized_pnl ?? 0),
        realizedPnl: Number(p.realized_pnl ?? 0),
        label: p.symbol,
      }));
  }

  async book(marketRef: string): Promise<OrderBook> {
    const meta = await this.resolveMarket(marketRef);
    const { orderApi } = await this.apis();
    // Live response shape (verified 2026-08-13): top-level `bids`/`asks` arrays
    // of { price, remaining_base_amount, ... } — not the SDK's typed `orders`.
    const res = (await orderApi.getOrderBookOrders({ market_id: meta.marketId, limit: 50 })) as unknown as Record<
      string,
      unknown
    >;
    const parseSide = (raw: unknown): { price: number; size: number }[] => {
      if (!Array.isArray(raw)) return [];
      return (raw as Array<Record<string, unknown>>)
        .map((o) => ({
          price: Number(o["price"] ?? 0),
          size: Number(o["remaining_base_amount"] ?? o["remaining_size"] ?? o["size"] ?? 0),
        }))
        .filter((l) => l.price > 0 && l.size > 0);
    };
    let bids = parseSide(res["bids"]);
    let asks = parseSide(res["asks"]);
    if (bids.length === 0 && asks.length === 0 && Array.isArray(res["orders"])) {
      // Fallback for the SDK-documented shape.
      for (const o of res["orders"] as Array<Record<string, unknown>>) {
        const price = Number(o["price"] ?? 0);
        const size = Number(o["remaining_base_amount"] ?? o["size"] ?? 0);
        if (!(price > 0) || !(size > 0)) continue;
        (o["is_ask"] ? asks : bids).push({ price, size });
      }
    }
    // Aggregate duplicate price levels and sort best-first.
    const agg = (levels: { price: number; size: number }[], desc: boolean) => {
      const m = new Map<number, number>();
      for (const l of levels) m.set(l.price, (m.get(l.price) ?? 0) + l.size);
      return [...m.entries()]
        .map(([price, size]) => ({ price, size }))
        .sort((x, y) => (desc ? y.price - x.price : x.price - y.price));
    };
    return { marketRef, bids: agg(bids, true), asks: agg(asks, false), ts: Date.now() };
  }

  async quote(marketRef: string): Promise<Quote> {
    const meta = await this.resolveMarket(marketRef);
    const b = await this.book(marketRef);
    const bid = b.bids[0]?.price ?? 0;
    const ask = b.asks[0]?.price ?? 0;
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : meta.lastTradePrice;
    return {
      marketRef,
      bid,
      ask,
      mid,
      volume24h: meta.volume24h,
      spreadBps: mid > 0 && bid > 0 && ask > 0 ? ((ask - bid) / mid) * 10_000 : 0,
      ts: Date.now(),
    };
  }

  async candles(marketRef: string, interval: CandleInterval, lookback: number): Promise<Candle[]> {
    const meta = await this.resolveMarket(marketRef);
    const secPer: Record<CandleInterval, number> = { "1h": 3600, "4h": 4 * 3600, "1d": 24 * 3600 };
    const count = lookback + 10;
    const end = Math.floor(Date.now() / 1000);
    const query = {
      market_id: meta.marketId,
      resolution: interval,
      start_timestamp: end - count * secPer[interval],
      end_timestamp: end,
      count_back: count,
    };
    // The public candlesticks endpoint 403s unauthenticated (observed live
    // 2026-08-13); attach an auth token when creds exist, else try public.
    let res: { candlesticks?: Array<{ timestamp: number; open: number; high: number; low: number; close: number }> };
    try {
      const { candleApi } = await this.apis();
      res = await candleApi.getCandlesticks(query);
    } catch (err) {
      const token = await this.authToken().catch(() => undefined);
      if (!token) {
        throw new Error(
          `lighter: candlesticks unavailable (${(err as Error).message.slice(0, 80)}) — the endpoint requires an authenticated account; fund and provision the API key first`,
        );
      }
      const qs = new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]));
      const r = await fetch(`${this.baseUrl}/api/v1/candlesticks?${qs}`, {
        headers: { authorization: token, auth: token },
      });
      if (!r.ok) throw new Error(`lighter: candlesticks ${r.status}`);
      res = (await r.json()) as typeof res;
    }
    return (res.candlesticks ?? []).map((c) => ({
      // Schema documents epoch seconds; guard against ms just in case.
      ts: c.timestamp > 1e12 ? c.timestamp : c.timestamp * 1000,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
  }

  async fundingRate(marketRef: string): Promise<number> {
    try {
      const meta = await this.resolveMarket(marketRef);
      const { fundingApi } = await this.apis();
      const res = await fundingApi.getFundingRates();
      const row = (res.funding_rates ?? []).find(
        (r: SdkFundingRate) => r.exchange === "lighter" && r.market_id === meta.marketId,
      );
      // NOTE: treated as the per-8h rate for thesis funding estimates; if Lighter
      // reports a different cadence this is the one constant to adjust.
      return row?.rate ?? 0;
    } catch {
      // Funding is advisory (ticket warning only) — degrade to 0 rather than
      // failing the ticket flow when the endpoint is unavailable.
      return 0;
    }
  }

  // ---- Orders --------------------------------------------------------------

  async placeOrder(acct: VenueAccount, intent: OrderIntent): Promise<OrderAck> {
    const meta = await this.resolveMarket(intent.marketRef);
    const signer = await this.getSigner();
    const priceUnits = Math.round(intent.limitPrice * 10 ** meta.priceDecimals);
    const sizeUnits = Math.round(intent.size * 10 ** meta.sizeDecimals);
    if (sizeUnits <= 0) throw new Error("lighter: size rounds to zero at market precision");
    const tifMap = { GTC: TIF_GTT, GTD: TIF_GTT, IOC: TIF_IOC, FAK: TIF_IOC, FOK: TIF_FOK } as const;
    const isAsk = intent.side === "SELL";
    const clientOrderIndex = Date.now() * 1000 + Math.floor(Math.random() * 1000);

    const [, txHash, err] = await signer.createOrder({
      marketIndex: meta.marketId,
      clientOrderIndex,
      baseAmount: sizeUnits,
      price: priceUnits,
      isAsk,
      orderType: ORDER_TYPE_LIMIT,
      timeInForce: tifMap[intent.tif],
      reduceOnly: intent.reduceOnly ?? false,
    });
    if (err) throw new Error(`lighter: order rejected: ${err}`);

    // Attach native SL/TP as reduce-only trigger orders (§5.3, §10).
    if (intent.triggers?.stopPx !== undefined) {
      await this.placeTrigger(meta, intent, intent.triggers.stopPx, ORDER_TYPE_STOP_LOSS_LIMIT, sizeUnits);
    }
    if (intent.triggers?.tpPx !== undefined) {
      await this.placeTrigger(meta, intent, intent.triggers.tpPx, ORDER_TYPE_TAKE_PROFIT_LIMIT, sizeUnits);
    }

    // Resolve the venue order_index for cancellation; fall back to the client id.
    const orderId = await this.findOrderId(acct, meta, clientOrderIndex).catch(() => undefined);
    return {
      orderId: orderId ?? `coi:${meta.marketId}:${clientOrderIndex}`,
      clientId: intent.clientId,
      status: "open",
    };
  }

  private async placeTrigger(
    meta: MarketMeta,
    intent: OrderIntent,
    triggerPx: number,
    orderType: number,
    sizeUnits: number,
  ): Promise<void> {
    const signer = await this.getSigner();
    const exitIsAsk = intent.side === "BUY"; // exits flip the entry side
    // Limit bound 1% through the trigger so the exit crosses.
    const bound = exitIsAsk ? triggerPx * 0.99 : triggerPx * 1.01;
    const [, , err] = await signer.createOrder({
      marketIndex: meta.marketId,
      clientOrderIndex: Date.now() * 1000 + Math.floor(Math.random() * 1000),
      baseAmount: sizeUnits,
      price: Math.round(bound * 10 ** meta.priceDecimals),
      isAsk: exitIsAsk,
      orderType,
      timeInForce: TIF_GTT,
      reduceOnly: true,
      triggerPrice: Math.round(triggerPx * 10 ** meta.priceDecimals),
    });
    if (err) throw new Error(`lighter: trigger order rejected: ${err}`);
  }

  private async findOrderId(acct: VenueAccount, meta: MarketMeta, clientOrderIndex: number): Promise<string | undefined> {
    const { orderApi } = await this.apis();
    const idx = await this.resolveAccountIndex(acct);
    const auth = await this.authToken().catch(() => undefined);
    for (let i = 0; i < 3; i++) {
      const orders = await orderApi.getAccountActiveOrders(idx, meta.marketId, auth);
      const mine = (orders ?? []).find((o: SdkOrder) => Number(o.client_order_index) === clientOrderIndex);
      if (mine?.order_index !== undefined) return `${meta.marketId}:${mine.order_index}`;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return undefined;
  }

  async cancelOrder(acct: VenueAccount, id: string): Promise<void> {
    const signer = await this.getSigner();
    if (id.startsWith("coi:")) {
      const [, marketIdStr, coiStr] = id.split(":");
      const meta = (await this.markets()).byId.get(Number(marketIdStr));
      if (!meta) throw new Error(`lighter: unknown market id in order ref ${id}`);
      const resolved = await this.findOrderId(acct, meta, Number(coiStr));
      if (!resolved) throw new Error(`lighter: order ${id} not found among active orders`);
      id = resolved;
    }
    const [marketIdStr, orderIndexStr] = id.split(":");
    const [, , err] = await signer.cancelOrder({ marketIndex: Number(marketIdStr), orderIndex: Number(orderIndexStr) });
    if (err) throw new Error(`lighter: cancel rejected: ${err}`);
  }

  async cancelAll(_acct: VenueAccount): Promise<void> {
    const signer = await this.getSigner();
    const [, , err] = await signer.cancelAllOrders(CANCEL_ALL_TIF_IMMEDIATE, 0);
    if (err) throw new Error(`lighter: cancel-all rejected: ${err}`);
  }

  /** Dead man's switch: scheduled cancel-all, refreshed each tick (§10). */
  async heartbeat(_acct: VenueAccount): Promise<void> {
    const signer = await this.getSigner();
    const at = Math.floor(Date.now() / 1000) + DEADMAN_WINDOW_S;
    const [, , err] = await signer.cancelAllOrders(CANCEL_ALL_TIF_SCHEDULED, at);
    if (err) throw new Error(`lighter: scheduled cancel-all rejected: ${err}`);
  }

  async openOrders(acct: VenueAccount): Promise<Order[]> {
    const { orderApi } = await this.apis();
    const idx = await this.resolveAccountIndex(acct);
    const auth = await this.authToken().catch(() => undefined);
    const { byId } = await this.markets();
    // market_id 255 = all markets (sentinel used across the Lighter API).
    const orders = await orderApi.getAccountActiveOrders(idx, 255, auth);
    return (orders ?? []).map((o: SdkOrder) => {
      const marketId = Number(o.market_id ?? o.market_index ?? 0);
      const meta = byId.get(marketId);
      return {
        id: `${marketId}:${o.order_index ?? o.order_id ?? o.id}`,
        clientId: o.client_order_index !== undefined ? String(o.client_order_index) : undefined,
        marketRef: meta?.symbol ?? String(marketId),
        side: (o.is_ask ?? o.side === "sell") ? ("SELL" as const) : ("BUY" as const),
        size: Number(o.initial_base_amount ?? o.size ?? 0),
        filledSize: Number(o.filled_base_amount ?? o.filled_size ?? 0),
        price: Number(o.price ?? 0),
        status: "open" as const,
        createdAt: o.created_at !== undefined ? Number(o.created_at) * 1000 : o.timestamp !== undefined ? Number(o.timestamp) * 1000 : undefined,
      };
    });
  }

  async fills(acct: VenueAccount, sinceTs: number): Promise<Fill[]> {
    const { orderApi } = await this.apis();
    const idx = await this.resolveAccountIndex(acct);
    const auth = await this.authToken().catch(() => undefined);
    const { byId } = await this.markets();
    const res = await orderApi.getTrades({
      market_id: 255,
      account_index: idx,
      sort_by: "timestamp",
      sort_dir: "desc",
      from: -1,
      ...(auth ? { auth } : {}),
    } as Parameters<OrderApi["getTrades"]>[0]);
    const trades = (res as { trades?: Array<Record<string, unknown>> }).trades ?? [];
    return trades
      .map((t) => {
        const rawTs = t["timestamp"];
        const tsNum = typeof rawTs === "string" ? Date.parse(rawTs) || Number(rawTs) * 1000 : Number(rawTs) * 1000;
        const marketId = Number(t["market_id"] ?? 0);
        return {
          id: String(t["trade_id"] ?? t["id"] ?? `${marketId}-${tsNum}`),
          orderId: t["order_id"] !== undefined ? String(t["order_id"]) : undefined,
          marketRef: byId.get(marketId)?.symbol ?? String(marketId),
          side: (t["side"] === "sell" ? "SELL" : "BUY") as Fill["side"],
          size: Number(t["size"] ?? 0),
          price: Number(t["price"] ?? 0),
          ts: tsNum,
          fee: t["fee"] !== undefined ? Number(t["fee"]) : undefined,
        };
      })
      .filter((f) => Number.isFinite(f.ts) && f.ts >= sinceTs);
  }
}

registerAdapter("lighter", (opts) => new LighterAdapter(opts));

// packages/core/src/venues/hyperliquid.ts
// Hyperliquid venue adapter (§5.2). Built against @nktkas/hyperliquid 0.33.3.
//
// Key structure (the security spine): the master EOA owns the account and
// funds; a named agent (API wallet) signs L1 actions (orders/cancels) only.
// The agent key is runtime-eligible; the master key never leaves the local
// keystore and is touched here only inside setup()/runFundingFlow() via the
// SetupContext keystore accessors.
//
// Query pitfall (§5.2): ALL info queries (clearinghouseState, userFillsByTime,
// frontendOpenOrders, ...) are keyed by the MASTER address. Querying by the
// agent address returns empty data.
//
// Facts verified against hyperliquid.gitbook.io on 2026-08-13:
// - Bridge (USDC on Arbitrum): mainnet 0x2df1c51e09aecf9cacb7bc98cb1742757f163df7,
//   testnet 0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89. Minimum 5 USDC —
//   amounts below the minimum are NOT credited and are lost.
// - scheduleCancel (dead man's switch): time must be ≥5s in the future; max 10
//   actual triggers per UTC day (refreshes don't count, only fires do).
// - Order price rules: max 5 significant figures and max (6 − szDecimals)
//   decimals for perps; integer prices always allowed.

import {
  ExchangeClient,
  HttpTransport,
  InfoClient,
} from "@nktkas/hyperliquid";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http } from "viem";
import { arbitrum } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
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
  SetupContext,
  VenueAccount,
  VenueAdapter,
} from "../types.js";
import { registerAdapter, type AdapterOpts } from "./registry.js";
import { KeyRoles } from "../wallet/keystore.js";

const BRIDGE_MAINNET = "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7" as const;
const BRIDGE_TESTNET = "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89" as const;
/** Native USDC on Arbitrum One. */
const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const MIN_DEPOSIT_USDC = 5;
/** Dead man's switch horizon; refreshed on every heartbeat call. */
const SCHEDULE_CANCEL_AHEAD_MS = 10 * 60_000;
/** Client-side throttle between exchange actions (§5.2 rate limits). */
const MIN_ACTION_GAP_MS = 110;

type HlAccount = Extract<VenueAccount, { venue: "hyperliquid" }>;

interface AssetMeta {
  assetId: number;
  szDecimals: number;
  maxLeverage: number;
}

export function classifyHyperliquidAgent(
  agents: Array<{ address: string; name: string }>,
  address: string,
  name: string,
): "approved" | "available" | "name-conflict" {
  const normalized = address.toLowerCase();
  if (agents.some((agent) => agent.address.toLowerCase() === normalized)) return "approved";
  if (agents.some((agent) => agent.name === name)) return "name-conflict";
  return "available";
}

export class HyperliquidAdapter implements VenueAdapter {
  readonly id = "hyperliquid" as const;
  readonly verifiedAgainst = "2026-08-13";
  readonly supportsNativeTriggers = true;

  private readonly opts: AdapterOpts;
  private readonly transport: HttpTransport;
  private readonly info: InfoClient;
  private exchange?: ExchangeClient;
  private assetMetaCache?: Map<string, AssetMeta>;
  private ctxCache?: { ts: number; byCoin: Map<string, { dayNtlVlm: number; funding: number; midPx: number | null }> };
  private actionChain: Promise<unknown> = Promise.resolve();
  private lastActionAt = 0;

  constructor(opts: AdapterOpts) {
    this.opts = opts;
    const urls = opts.urls.hyperliquid;
    const isTestnet = urls.testnet;
    const defaultUrl = isTestnet ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz";
    this.transport = new HttpTransport({
      isTestnet,
      ...(urls.api !== "https://api.hyperliquid.xyz" && urls.api !== defaultUrl ? { apiUrl: urls.api } : {}),
    });
    this.info = new InfoClient({ transport: this.transport });
  }

  // -------------------------------------------------------------------------
  // Signing clients
  // -------------------------------------------------------------------------

  private agentExchange(): ExchangeClient {
    if (this.exchange) return this.exchange;
    const creds = this.opts.creds;
    if (!creds || creds.venue !== "hyperliquid") {
      throw new Error("hyperliquid adapter needs runtime creds ({ agentPk, masterAddress }) for trading");
    }
    const wallet = privateKeyToAccount(creds.agentPk as `0x${string}`);
    this.exchange = new ExchangeClient({ transport: this.transport, wallet });
    return this.exchange;
  }

  private masterAddress(acct: VenueAccount): `0x${string}` {
    const a = acct as HlAccount;
    if (!a.masterAddress) throw new Error("hyperliquid account is missing masterAddress");
    return a.masterAddress as `0x${string}`;
  }

  /** Serialize exchange actions with a minimum gap (client-side throttle). */
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

  // -------------------------------------------------------------------------
  // Asset metadata
  // -------------------------------------------------------------------------

  private async assetMeta(coin: string): Promise<AssetMeta> {
    if (!this.assetMetaCache) {
      const meta = await this.info.meta();
      this.assetMetaCache = new Map(
        meta.universe.map((u, i) => [u.name, { assetId: i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage }]),
      );
    }
    const m = this.assetMetaCache.get(coin);
    if (!m) throw new Error(`unknown Hyperliquid asset "${coin}"`);
    return m;
  }

  private async assetCtx(coin: string): Promise<{ dayNtlVlm: number; funding: number; midPx: number | null }> {
    const FRESH_MS = 30_000;
    if (!this.ctxCache || Date.now() - this.ctxCache.ts > FRESH_MS) {
      const [meta, ctxs] = await this.info.metaAndAssetCtxs();
      const byCoin = new Map<string, { dayNtlVlm: number; funding: number; midPx: number | null }>();
      meta.universe.forEach((u, i) => {
        const ctx = ctxs[i];
        if (ctx) {
          byCoin.set(u.name, {
            dayNtlVlm: Number(ctx.dayNtlVlm),
            funding: Number(ctx.funding),
            midPx: ctx.midPx === null ? null : Number(ctx.midPx),
          });
        }
      });
      this.ctxCache = { ts: Date.now(), byCoin };
    }
    const ctx = this.ctxCache.byCoin.get(coin);
    if (!ctx) throw new Error(`no asset context for Hyperliquid asset "${coin}"`);
    return ctx;
  }

  // -------------------------------------------------------------------------
  // Setup and funding (§6)
  // -------------------------------------------------------------------------

  async setup(ctx: SetupContext): Promise<VenueAccount> {
    const masterPk = await ctx.getSecret(KeyRoles.master);
    if (!masterPk) throw new Error("no master key in keystore — run `cassie wallet create <botId>` first");
    const master = privateKeyToAccount(masterPk as `0x${string}`);
    ctx.print(`Hyperliquid master EOA: ${master.address}`);
    ctx.print(`This address owns the account and funds. Its key stays in the local keystore only.`);
    return { venue: "hyperliquid", masterAddress: master.address };
  }

  async fundingInstructions(acct: VenueAccount): Promise<FundingInstructions> {
    const master = this.masterAddress(acct);
    return {
      venue: "hyperliquid",
      addresses: [
        {
          chain: "arbitrum",
          address: master,
          asset: "USDC",
          minimum: MIN_DEPOSIT_USDC,
          note: "Send USDC (≥5, plus a small buffer) AND ~$2 of ETH for gas to the master EOA on Arbitrum. The CLI then bridges from there. Deposits under 5 USDC are lost.",
        },
      ],
      summary: `Send USDC (≥${MIN_DEPOSIT_USDC}) and ~$2 ETH on Arbitrum to ${master}; cassie submits the bridge deposit from that EOA.`,
    };
  }

  async runFundingFlow(ctx: SetupContext, acct: VenueAccount): Promise<VenueAccount> {
    const a = acct as HlAccount;
    const urls = this.opts.urls.hyperliquid;
    const master = this.masterAddress(acct);

    if (urls.testnet) {
      ctx.print(`Testnet mode: fund ${master} via the Hyperliquid testnet faucet (app.hyperliquid-testnet.xyz), then continue.`);
      await ctx.poll("waiting for testnet balance on Hyperliquid…", async () => {
        const st = await this.info.clearinghouseState({ user: master });
        return Number(st.marginSummary.accountValue) > 0 ? st : null;
      });
      return this.provisionAgent(ctx, a);
    }

    // Init can crash after the bridge credits but before the agent/account
    // checkpoint. Resume from venue state instead of asking for a duplicate
    // Arbitrum deposit. Explicit top-ups retain agentAddress and still follow
    // the ordinary deposit path below.
    if (!a.agentAddress) {
      const existing = await this.info.clearinghouseState({ user: master }).catch(() => null);
      if (existing && Number(existing.marginSummary.accountValue) > 0) {
        ctx.print("Existing Hyperliquid collateral detected; resuming agent provisioning without another deposit.");
        return this.provisionAgent(ctx, a);
      }
    }

    const pub = createPublicClient({ chain: arbitrum, transport: http(urls.arbitrumRpc) });
    const instructions = await this.fundingInstructions(acct);
    ctx.print(instructions.summary);
    ctx.print(`USDC (Arbitrum native): ${USDC_ARBITRUM}`);

    const arrival = await ctx.poll(
      "waiting for USDC + ETH to arrive on Arbitrum…",
      async () => {
        const [usdcRaw, ethRaw] = await Promise.all([
          pub.readContract({ address: USDC_ARBITRUM, abi: erc20Abi, functionName: "balanceOf", args: [master] }),
          pub.getBalance({ address: master }),
        ]);
        const usdc = Number(formatUnits(usdcRaw, 6));
        const eth = Number(formatUnits(ethRaw, 18));
        if (usdc >= MIN_DEPOSIT_USDC && eth >= 0.0001) return { usdcRaw, usdc, eth };
        return null;
      },
      { intervalMs: 10_000 },
    );
    ctx.print(`Arrived: ${arrival.usdc} USDC, ${arrival.eth.toFixed(5)} ETH.`);

    const ok = await ctx.confirm(
      `Bridge ${arrival.usdc} USDC from ${master} to the Hyperliquid bridge (${BRIDGE_MAINNET})?`,
      true,
    );
    if (!ok) throw new Error("operator declined the bridge deposit");

    const masterPk = await ctx.getSecret(KeyRoles.master);
    if (!masterPk) throw new Error("master key missing from keystore");
    const masterAccount = privateKeyToAccount(masterPk as `0x${string}`);
    const wallet = createWalletClient({ account: masterAccount, chain: arbitrum, transport: http(urls.arbitrumRpc) });
    const txHash = await wallet.writeContract({
      address: USDC_ARBITRUM,
      abi: erc20Abi,
      functionName: "transfer",
      args: [BRIDGE_MAINNET, arrival.usdcRaw],
    });
    ctx.print(`Bridge deposit submitted: ${txHash}`);
    await pub.waitForTransactionReceipt({ hash: txHash });

    await ctx.poll("waiting for Hyperliquid to credit the deposit…", async () => {
      const st = await this.info.clearinghouseState({ user: master });
      return Number(st.marginSummary.accountValue) > 0 ? st : null;
    });
    ctx.print("Deposit credited on Hyperliquid.");

    return this.provisionAgent(ctx, a);
  }

  /** Generate an agent keypair and have the master sign approveAgent (§5.2). */
  private async provisionAgent(ctx: SetupContext, acct: HlAccount): Promise<VenueAccount> {
    const masterPk = await ctx.getSecret(KeyRoles.master);
    if (!masterPk) throw new Error("master key missing from keystore");
    const masterAccount = privateKeyToAccount(masterPk as `0x${string}`);
    // Persist the candidate before the external approval. If the process dies
    // after Hyperliquid commits, init resumes with the exact same key instead
    // of burning another one of the limited named-agent slots.
    const storedAgentPk = await ctx.getSecret(KeyRoles.agent);
    const agentPk = (storedAgentPk ?? generatePrivateKey()) as `0x${string}`;
    const agent = privateKeyToAccount(agentPk);
    // Agent names are capped at 16 chars; HL allows 1 unnamed + up to 3 named agents.
    const agentName = `cassie-${ctx.botId}`.slice(0, 16);

    if (!storedAgentPk) {
      await ctx.putSecret(KeyRoles.agent, agentPk, { address: agent.address, runtimeEligible: true });
    }
    const registered = await this.info.extraAgents({ user: masterAccount.address });
    const status = classifyHyperliquidAgent(registered, agent.address, agentName);
    if (status === "name-conflict") {
      throw new Error(
        `Hyperliquid already has a different agent named "${agentName}". Remove or rename it in Hyperliquid, then retry; Cassie kept its pending key locally.`,
      );
    }
    if (status === "available") {
      const masterExchange = new ExchangeClient({ transport: this.transport, wallet: masterAccount });
      await masterExchange.approveAgent({ agentAddress: agent.address, agentName });
    }
    ctx.print(`Approved named agent "${agentName}" (${agent.address}). Agent key is runtime-eligible; master key stays local.`);
    return { ...acct, agentAddress: agent.address, agentName };
  }

  /**
   * Withdraw USDC to an address on Arbitrum. This is a user-signed action, so
   * it signs with the master key from the local keystore. Hyperliquid charges
   * a $1 withdrawal fee; arrival takes a few minutes.
   */
  async withdraw(ctx: SetupContext, acct: VenueAccount, params: { to: string; amount: number | "all" }): Promise<string> {
    const masterPk = await ctx.getSecret(KeyRoles.master);
    if (!masterPk) throw new Error("master key missing from keystore — withdrawals sign with it");
    const masterAccount = privateKeyToAccount(masterPk as `0x${string}`);

    const st = await this.info.clearinghouseState({ user: this.masterAddress(acct) });
    const withdrawable = Number(st.withdrawable);
    const amount = params.amount === "all" ? withdrawable : params.amount;
    if (!(amount > 0)) throw new Error("nothing to withdraw");
    if (amount > withdrawable) throw new Error(`insufficient withdrawable balance: ${withdrawable} USDC`);

    const masterExchange = new ExchangeClient({ transport: this.transport, wallet: masterAccount });
    await masterExchange.withdraw3({ destination: params.to as `0x${string}`, amount: String(amount) });
    return `withdrawal of ${amount} USDC to ${params.to} on Arbitrum submitted ($1 fee, arrives in minutes)`;
  }

  async awaitFunding(acct: VenueAccount, opts?: AwaitFundingOpts): Promise<Balance> {
    const master = this.masterAddress(acct);
    const interval = opts?.intervalMs ?? 10_000;
    const timeout = opts?.timeoutMs ?? 30 * 60_000;
    const start = Date.now();
    for (;;) {
      const st = await this.info.clearinghouseState({ user: master });
      const total = Number(st.marginSummary.accountValue);
      if (total > 0) return { asset: "USDC", total, available: Number(st.withdrawable) };
      if (Date.now() - start > timeout) throw new Error("timed out waiting for Hyperliquid deposit");
      opts?.onPoll?.(`no Hyperliquid balance yet for ${master}`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  // -------------------------------------------------------------------------
  // Read methods
  // -------------------------------------------------------------------------

  async balances(acct: VenueAccount): Promise<Balance[]> {
    const st = await this.info.clearinghouseState({ user: this.masterAddress(acct) });
    return [{ asset: "USDC", total: Number(st.marginSummary.accountValue), available: Number(st.withdrawable) }];
  }

  async positions(acct: VenueAccount): Promise<Position[]> {
    const st = await this.info.clearinghouseState({ user: this.masterAddress(acct) });
    return st.assetPositions
      .filter((ap) => Number(ap.position.szi) !== 0)
      .map((ap) => {
        const szi = Number(ap.position.szi);
        return {
          marketRef: ap.position.coin,
          side: szi > 0 ? ("LONG" as const) : ("SHORT" as const),
          size: Math.abs(szi),
          avgPrice: Number(ap.position.entryPx),
          unrealizedPnl: Number(ap.position.unrealizedPnl),
          label: `${ap.position.coin}-PERP`,
        };
      });
  }

  async book(marketRef: string): Promise<OrderBook> {
    const b = await this.info.l2Book({ coin: marketRef });
    if (!b) throw new Error(`no Hyperliquid book for "${marketRef}"`);
    const [bids, asks] = b.levels;
    return {
      marketRef,
      bids: bids.map((l) => ({ price: Number(l.px), size: Number(l.sz) })),
      asks: asks.map((l) => ({ price: Number(l.px), size: Number(l.sz) })),
      ts: b.time,
    };
  }

  async quote(marketRef: string): Promise<Quote> {
    const [book, ctx] = await Promise.all([this.book(marketRef), this.assetCtx(marketRef)]);
    const bid = book.bids[0]?.price ?? 0;
    const ask = book.asks[0]?.price ?? 0;
    const mid = ctx.midPx ?? (bid + ask) / 2;
    return {
      marketRef,
      bid,
      ask,
      mid,
      volume24h: ctx.dayNtlVlm,
      spreadBps: mid > 0 ? ((ask - bid) / mid) * 10_000 : 0,
      ts: book.ts,
    };
  }

  async candles(marketRef: string, interval: CandleInterval, lookback: number): Promise<Candle[]> {
    const intervalMs: Record<CandleInterval, number> = { "1h": 3_600_000, "4h": 4 * 3_600_000, "1d": 24 * 3_600_000 };
    const startTime = Date.now() - (lookback + 10) * intervalMs[interval];
    const rows = await this.info.candleSnapshot({ coin: marketRef, interval, startTime });
    return rows.map((c) => ({
      ts: c.t,
      open: Number(c.o),
      high: Number(c.h),
      low: Number(c.l),
      close: Number(c.c),
      volume: Number(c.v),
    }));
  }

  /** Funding rate as decimal per 8h. HL publishes an hourly rate; ×8 here. */
  async fundingRate(marketRef: string): Promise<number> {
    const ctx = await this.assetCtx(marketRef);
    return ctx.funding * 8;
  }

  async openOrders(acct: VenueAccount): Promise<Order[]> {
    const rows = await this.info.frontendOpenOrders({ user: this.masterAddress(acct) });
    return rows.map((o) => ({
      id: String(o.oid),
      clientId: o.cloid ?? undefined,
      marketRef: o.coin,
      side: o.side === "B" ? ("BUY" as const) : ("SELL" as const),
      size: Number(o.origSz),
      filledSize: Number(o.origSz) - Number(o.sz),
      price: o.isTrigger ? Number(o.triggerPx) : Number(o.limitPx),
      status: Number(o.origSz) > Number(o.sz) ? ("partial" as const) : ("open" as const),
      createdAt: o.timestamp,
    }));
  }

  async fills(acct: VenueAccount, sinceTs: number): Promise<Fill[]> {
    const rows = await this.info.userFillsByTime({
      user: this.masterAddress(acct),
      startTime: Math.max(0, sinceTs),
    });
    return rows.map((f) => ({
      id: String(f.tid),
      orderId: String(f.oid),
      marketRef: f.coin,
      side: f.side === "B" ? ("BUY" as const) : ("SELL" as const),
      size: Number(f.sz),
      price: Number(f.px),
      ts: f.time,
      fee: Number(f.fee),
    }));
  }

  // -------------------------------------------------------------------------
  // Trading
  // -------------------------------------------------------------------------

  async placeOrder(_acct: VenueAccount, intent: OrderIntent): Promise<OrderAck> {
    const meta = await this.assetMeta(intent.marketRef);
    const ex = this.agentExchange();
    const isBuy = intent.side === "BUY";
    const size = formatSize(intent.size, meta.szDecimals);
    const price = formatHlPrice(intent.limitPrice, meta.szDecimals);
    // HL has no FOK; Ioc (fill what crosses, cancel the rest) is the closest. GTD maps to Gtc.
    const tif = intent.tif === "IOC" || intent.tif === "FOK" ? "Ioc" : "Gtc";

    const res = await this.throttled(() =>
      ex.order({
        orders: [
          {
            a: meta.assetId,
            b: isBuy,
            p: price,
            s: size,
            r: intent.reduceOnly ?? false,
            t: { limit: { tif } },
            c: toCloid(intent.clientId),
          },
        ],
        grouping: "na",
      }),
    );

    const status = res.response.data.statuses[0];
    if (!status) throw new Error("hyperliquid order returned no status");
    let ack: OrderAck;
    if (typeof status === "string") {
      // "waitingForFill" / "waitingForTrigger" — accepted but not yet resting.
      ack = { orderId: toCloid(intent.clientId), clientId: intent.clientId, status: "open" };
    } else if ("resting" in status) {
      ack = { orderId: String(status.resting.oid), clientId: intent.clientId, status: "open" };
    } else if ("filled" in status) {
      ack = {
        orderId: String(status.filled.oid),
        clientId: intent.clientId,
        status: "filled",
        filledSize: Number(status.filled.totalSz),
        avgFillPrice: Number(status.filled.avgPx),
      };
    } else {
      throw new Error(`hyperliquid order rejected: ${JSON.stringify(status)}`);
    }

    // Native triggers (§10): position TP/SL as reduce-only trigger-market orders.
    if (intent.triggers?.stopPx !== undefined || intent.triggers?.tpPx !== undefined) {
      const triggerOrders: Parameters<ExchangeClient["order"]>[0]["orders"] = [];
      if (intent.triggers.stopPx !== undefined) {
        const trig = formatHlPrice(intent.triggers.stopPx, meta.szDecimals);
        triggerOrders.push({
          a: meta.assetId,
          b: !isBuy,
          // For isMarket triggers, p bounds slippage; allow 5% through the trigger.
          p: formatHlPrice(intent.triggers.stopPx * (isBuy ? 0.95 : 1.05), meta.szDecimals),
          s: size,
          r: true,
          t: { trigger: { isMarket: true, triggerPx: trig, tpsl: "sl" as const } },
        });
      }
      if (intent.triggers.tpPx !== undefined) {
        const trig = formatHlPrice(intent.triggers.tpPx, meta.szDecimals);
        triggerOrders.push({
          a: meta.assetId,
          b: !isBuy,
          p: formatHlPrice(intent.triggers.tpPx * (isBuy ? 0.95 : 1.05), meta.szDecimals),
          s: size,
          r: true,
          t: { trigger: { isMarket: true, triggerPx: trig, tpsl: "tp" as const } },
        });
      }
      await this.throttled(() => ex.order({ orders: triggerOrders, grouping: "positionTpsl" }));
    }

    return ack;
  }

  async cancelOrder(_acct: VenueAccount, id: string): Promise<void> {
    // Cancel needs the asset id; look the order up first.
    const acctRows = await this.openOrders(_acct);
    const order = acctRows.find((o) => o.id === id);
    if (!order) return;
    const meta = await this.assetMeta(order.marketRef);
    const ex = this.agentExchange();
    await this.throttled(() => ex.cancel({ cancels: [{ a: meta.assetId, o: Number(id) }] }));
  }

  async cancelAll(acct: VenueAccount): Promise<void> {
    const open = await this.openOrders(acct);
    if (open.length === 0) return;
    const ex = this.agentExchange();
    const cancels = await Promise.all(
      open.map(async (o) => ({ a: (await this.assetMeta(o.marketRef)).assetId, o: Number(o.id) })),
    );
    await this.throttled(() => ex.cancel({ cancels }));
  }

  /**
   * Dead man's switch: scheduleCancel refreshed on each call, 10 minutes out.
   * If the runtime dies, HL cancels all open orders venue-side at the deadline.
   * Constraints (verified 2026-08-13): time ≥5s in future, max 10 fires/UTC day.
   */
  async heartbeat(_acct: VenueAccount): Promise<void> {
    const ex = this.agentExchange();
    try {
      await this.throttled(() => ex.scheduleCancel({ time: Date.now() + SCHEDULE_CANCEL_AHEAD_MS }));
    } catch (err) {
      // Non-fatal: e.g. daily trigger budget exhausted. The engine's own TTL
      // cancels remain in force; log and continue.
      console.warn(`hyperliquid scheduleCancel failed: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers (HL rejects unrounded prices/sizes)
// ---------------------------------------------------------------------------

/** Max 5 significant figures AND max (6 − szDecimals) decimals; integers allowed. */
export function formatHlPrice(px: number, szDecimals: number): string {
  if (px <= 0) throw new Error("price must be positive");
  const maxDecimals = 6 - szDecimals;
  if (Number.isInteger(px) && px < 1e15) return String(px);
  let p = Number(px.toPrecision(5));
  p = Number(p.toFixed(Math.max(0, maxDecimals)));
  return trimZeros(p.toFixed(Math.max(0, maxDecimals)));
}

export function formatSize(sz: number, szDecimals: number): string {
  // Round down so we never exceed the intended size after rounding.
  const f = 10 ** szDecimals;
  return trimZeros((Math.floor(sz * f) / f).toFixed(szDecimals));
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** HL cloid = 0x + 32 hex chars. Deterministic from the engine clientId. */
export function toCloid(clientId: string): `0x${string}` {
  // FNV-1a over the string, expanded to 128 bits by chaining four rounds.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0xdeadbeef;
  let h4 = 0xcafebabe;
  for (let i = 0; i < clientId.length; i++) {
    const c = clientId.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    h3 = Math.imul(h3 ^ c, 0xc2b2ae35) >>> 0;
    h4 = Math.imul(h4 ^ c, 0x27d4eb2f) >>> 0;
  }
  const hex = [h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, "0")).join("");
  return `0x${hex}` as `0x${string}`;
}

registerAdapter("hyperliquid", (opts) => new HyperliquidAdapter(opts));

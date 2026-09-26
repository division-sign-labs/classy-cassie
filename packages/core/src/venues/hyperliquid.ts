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
// Contracts verified against Hyperliquid/XYZ docs and public metadata on 2026-09-04:
// - Bridge (USDC on Arbitrum): mainnet 0x2df1c51e09aecf9cacb7bc98cb1742757f163df7,
//   testnet 0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89. Minimum 5 USDC —
//   amounts below the minimum are NOT credited and are lost.
// - scheduleCancel (dead man's switch): time must be ≥5s in the future; max 10
//   actual triggers per UTC day (refreshes don't count, only fires do).
// - Order price rules: max 5 significant figures and max (6 − szDecimals)
//   decimals for perps; integer prices always allowed.
// - HIP-3 asset IDs: 100000 + perpDexs index * 10000 + index in DEX metadata.
// - Standard DEX balances are independent; unified USDC is read once from spot
//   accounting (account-abstraction-modes and info-endpoint/spot, 2026-09-26).
// - scheduleCancel cancels protective orders too. Swing disables it explicitly.
// - Single-order rejection receipts verified 2026-09-08 against:
//   https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses

import {
  ExchangeClient,
  HttpTransport,
  InfoClient,
} from "@nktkas/hyperliquid";
import { ApiRequestError } from "@nktkas/hyperliquid/api/exchange";
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
import { prepareHyperliquidPerpFunding } from "./hyperliquid-funding.js";
import { HyperliquidInfoDeferredError, wrapHyperliquidInfoClient } from "./hyperliquid-info-scheduler.js";
import type {
  PerpAccountSnapshot,
  PerpCashFlowResult,
  PerpInstrument,
  PerpLeverageRequest,
  PerpMarketSnapshot,
  PerpOrderLookup,
  PerpStopRequest,
} from "../perps.js";
import {
  finiteNumber,
  formatBoundedHlPrice,
  hyperliquidAssetId,
  hyperliquidDex,
  hyperliquidDexCashFlow,
  hyperliquidUnifiedCashFlow,
  hyperliquidFeeRates,
  nonnegativeNumber,
  positiveNumber,
} from "./hyperliquid-perps.js";

/** The adapter proves that no exchange order was submitted. */
export class HyperliquidOrderNotSubmittedError extends Error {
  override name = "HyperliquidOrderNotSubmittedError";
}

/** A definite single-order refusal also proves that no order was placed. */
export class HyperliquidOrderRejectedError extends HyperliquidOrderNotSubmittedError {
  override name = "HyperliquidOrderRejectedError";
}

function singleOrderRejection(value: unknown): string | undefined {
  const r = value as { status?: unknown; response?: { type?: unknown; data?: { statuses?: unknown } } } | null;
  const statuses = r?.response?.data?.statuses;
  if (r?.status !== "ok" || r.response?.type !== "order" || !Array.isArray(statuses) || statuses.length !== 1) return undefined;
  const status: unknown = statuses[0];
  if (!status || typeof status !== "object" || Object.keys(status).length !== 1 || !("error" in status)
    || typeof status.error !== "string" || !status.error.trim()) return undefined;
  return status.error;
}

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
type HlMeta = Awaited<ReturnType<InfoClient["meta"]>>;
type HlAssetCtx = Awaited<ReturnType<InfoClient["metaAndAssetCtxs"]>>[1][number];
type HlOpenOrder = Awaited<ReturnType<InfoClient["frontendOpenOrders"]>>[number];

interface AssetMeta {
  assetId: number;
  dex: string;
  dexIndex: number;
  szDecimals: number;
  maxLeverage: number;
  collateralToken: number;
  marginTableId: number;
  marginTables: HlMeta["marginTables"];
  marginMode?: "strictIsolated" | "noCross";
  isDelisted: boolean;
  growthMode: boolean;
  deployerFeeScale: number;
}

/** Test seams inject SDK clients; production signing still uses ExchangeClient. */
export interface HyperliquidAdapterDependencies {
  info?: InfoClient;
  exchange?: ExchangeClient;
  now?: () => number;
  actionGapMs?: number;
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
  readonly verifiedAgainst = "2026-09-26";
  readonly supportsNativeTriggers = true;

  private readonly opts: AdapterOpts;
  private readonly transport: HttpTransport;
  private readonly info: InfoClient;
  private exchange?: ExchangeClient;
  private readonly now: () => number;
  private readonly actionGapMs: number;
  private readonly dexCache = new Map<string, { ts: number; meta: Map<string, AssetMeta>; ctx: Map<string, HlAssetCtx> }>();
  private readonly dexLoads = new Map<string, Promise<void>>();
  private dexList?: { ts: number; rows: Awaited<ReturnType<InfoClient["perpDexs"]>> };
  private readonly candleCache = new Map<string, { boundary: number; expiresAt: number; lookback: number; rows: Candle[] }>();
  private readonly candleLoads = new Map<string, Promise<void>>();
  private feeCache?: { ts: number; user: string; value: Awaited<ReturnType<InfoClient["userFees"]>> };
  private modeCache?: { ts: number; user: string; value: string };
  private actionChain: Promise<unknown> = Promise.resolve();
  private lastActionAt = 0;
  private scheduledCancelDisarmed = false;

  constructor(opts: AdapterOpts, deps: HyperliquidAdapterDependencies = {}) {
    this.opts = opts;
    const urls = opts.urls.hyperliquid;
    const isTestnet = urls.testnet;
    const defaultUrl = isTestnet ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz";
    this.transport = new HttpTransport({
      isTestnet,
      timeout: 10_000,
      ...(urls.api !== "https://api.hyperliquid.xyz" && urls.api !== defaultUrl ? { apiUrl: urls.api } : {}),
    });
    this.info = deps.info ?? wrapHyperliquidInfoClient(new InfoClient({ transport: this.transport }));
    this.exchange = deps.exchange;
    this.now = deps.now ?? (() => Date.now());
    this.actionGapMs = deps.actionGapMs ?? MIN_ACTION_GAP_MS;
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
      const wait = this.lastActionAt + this.actionGapMs - this.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        this.lastActionAt = this.now();
      }
    });
    this.actionChain = run.catch(() => {});
    return run;
  }

  // -------------------------------------------------------------------------
  // Asset metadata
  // -------------------------------------------------------------------------

  private async assetMeta(coin: string): Promise<AssetMeta> {
    const dex = hyperliquidDex(coin);
    await this.loadDex(dex);
    const m = this.dexCache.get(dex)?.meta.get(coin);
    if (!m) throw new Error(`unknown Hyperliquid asset "${coin}"`);
    return m;
  }

  private async assetCtx(coin: string): Promise<{ dayNtlVlm: number; funding: number; midPx: number | null }> {
    const dex = hyperliquidDex(coin);
    await this.loadDex(dex);
    const ctx = this.dexCache.get(dex)?.ctx.get(coin);
    if (!ctx) throw new Error(`no asset context for Hyperliquid asset "${coin}"`);
    return {
      dayNtlVlm: nonnegativeNumber(ctx.dayNtlVlm, "volume"),
      funding: finiteNumber(ctx.funding, "funding"),
      midPx: ctx.midPx === null ? null : positiveNumber(ctx.midPx, "mid price"),
    };
  }

  private async loadDex(dex: string): Promise<void> {
    const cached = this.dexCache.get(dex);
    if (cached && this.now() - cached.ts < 30_000) return;
    const inFlight = this.dexLoads.get(dex);
    if (inFlight) return inFlight;
    const load = async () => {
      let dexIndex = 0;
      let dexFeeScale: number | undefined;
      if (dex) {
        if (!this.dexList || this.now() - this.dexList.ts >= 300_000) {
          this.dexList = { ts: this.now(), rows: await this.info.perpDexs() };
        }
        dexIndex = this.dexList.rows.findIndex((d) => d?.name === dex);
        if (dexIndex <= 0) throw new Error(`unknown Hyperliquid DEX "${dex}"`);
        const declaredFee = this.dexList.rows[dexIndex]?.deployerFeeScale;
        if (declaredFee !== undefined) dexFeeScale = nonnegativeNumber(declaredFee, "deployer fee scale");
      }
      const [meta, ctxs] = await this.info.metaAndAssetCtxs(dex ? { dex } : {});
      if (meta.universe.length !== ctxs.length) throw new Error("Hyperliquid metadata/context length mismatch");
      const byCoin = new Map<string, AssetMeta>();
      const contexts = new Map<string, HlAssetCtx>();
      meta.universe.forEach((u, i) => {
        if (hyperliquidDex(u.name) !== dex || byCoin.has(u.name)) throw new Error("Hyperliquid metadata identity mismatch");
        if (!Number.isInteger(u.szDecimals) || u.szDecimals < 0 || u.szDecimals > 6 || !Number.isInteger(u.maxLeverage) || u.maxLeverage < 1) {
          throw new Error("invalid Hyperliquid instrument constraints");
        }
        // The current unversioned API moved fee scale onto each asset; 0.33.3
        // declares only the earlier DEX-level field. Normalize that addition.
        const live = u as typeof u & { deployerFeeScale?: unknown };
        const feeScale = dexIndex === 0 ? 0 : live.deployerFeeScale === undefined ? dexFeeScale : nonnegativeNumber(live.deployerFeeScale, "deployer fee scale");
        byCoin.set(u.name, {
          assetId: hyperliquidAssetId(dexIndex, i), dex, dexIndex,
          szDecimals: u.szDecimals, maxLeverage: u.maxLeverage,
          collateralToken: meta.collateralToken, marginTableId: u.marginTableId,
          marginTables: meta.marginTables, marginMode: u.marginMode ?? (u.onlyIsolated ? "noCross" : undefined),
          isDelisted: u.isDelisted === true, growthMode: u.growthMode === "enabled",
          // Unknown fees must fail at the cost-sensitive strategy snapshot,
          // while ordinary adapter quote/exit paths remain available.
          deployerFeeScale: feeScale ?? Number.NaN,
        });
        contexts.set(u.name, ctxs[i]!);
      });
      this.dexCache.set(dex, { ts: this.now(), meta: byCoin, ctx: contexts });
    };
    const pending = load();
    this.dexLoads.set(dex, pending);
    try { await pending; } finally { this.dexLoads.delete(dex); }
  }

  // -------------------------------------------------------------------------
  // Setup and funding (§6)
  // -------------------------------------------------------------------------

  async setup(ctx: SetupContext): Promise<VenueAccount> {
    const masterPk = await ctx.getSecret(KeyRoles.master);
    if (!masterPk) throw new Error("no master key in keystore — run `cassie wallet create <botId>` first");
    const master = privateKeyToAccount(masterPk as `0x${string}`);
    ctx.print("Hyperliquid wallet");
    ctx.print(master.address);
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
          note: "Deposits under 5 USDC are lost.",
        },
      ],
      summary: `Send at least ${MIN_DEPOSIT_USDC} USDC on Arbitrum.`,
    };
  }

  async runFundingFlow(ctx: SetupContext, acct: VenueAccount): Promise<VenueAccount> {
    const a = acct as HlAccount;
    const urls = this.opts.urls.hyperliquid;
    const master = this.masterAddress(acct);

    if (urls.testnet) {
      ctx.print("Fund the testnet wallet");
      ctx.print(master);
      ctx.print("https://app.hyperliquid-testnet.xyz");
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
    const existing = await this.info.clearinghouseState({ user: master });
    if (Number(existing.marginSummary.accountValue) > 0 && (!a.agentAddress || (this.opts.perpDex && Number(existing.withdrawable) > 0))) {
      const provisioned = await this.provisionAgent(ctx, a);
      await this.preparePerpFunding(ctx, provisioned);
      return provisioned;
    }

    const pub = createPublicClient({ chain: arbitrum, transport: http(urls.arbitrumRpc) });
    const readUsdc = async () => {
      const usdcRaw = await pub.readContract({ address: USDC_ARBITRUM, abi: erc20Abi, functionName: "balanceOf", args: [master] });
      return { usdcRaw, usdc: Number(formatUnits(usdcRaw, 6)) };
    };
    let arrival = await readUsdc();
    if (arrival.usdc < MIN_DEPOSIT_USDC) {
      ctx.print((await this.fundingInstructions(acct)).summary);
      ctx.print("");
      ctx.print(master);
      ctx.print("");
      arrival = await ctx.poll("Waiting for USDC…", async () => {
        const balance = await readUsdc();
        return balance.usdc >= MIN_DEPOSIT_USDC ? balance : null;
      }, { intervalMs: 10_000 });
    }

    // Estimate this transfer instead of imposing a fixed ETH top-up on every
    // deposit. Arbitrum's estimate includes its parent-chain data component.
    const transfer = { address: USDC_ARBITRUM, abi: erc20Abi, functionName: "transfer", args: [BRIDGE_MAINNET, arrival.usdcRaw] } as const;
    const [estimatedGas, quotedGasPrice, ethBalance] = await Promise.all([
      // Estimate-only zero fee avoids rejecting an unfunded gas wallet before
      // we can quote its ETH shortfall. The real transaction uses gasPrice below.
      pub.estimateContractGas({ ...transfer, account: master, gasPrice: 0n }),
      pub.getGasPrice(),
      pub.getBalance({ address: master }),
    ]);
    if (estimatedGas <= 0n || quotedGasPrice <= 0n) throw new Error("Could not estimate the deposit fee.");
    const gas = (estimatedGas * 120n + 99n) / 100n;
    const gasPrice = (quotedGasPrice * 120n + 99n) / 100n;
    const requiredEth = gas * gasPrice;
    if (ethBalance < requiredEth) {
      // Round the shortfall up to six decimal places for a copyable top-up.
      const topUp = ((requiredEth - ethBalance + 999_999_999_999n) / 1_000_000_000_000n) * 1_000_000_000_000n;
      ctx.print(`Add ${formatUnits(topUp, 18)} ETH on Arbitrum for gas.`);
      ctx.print("");
      ctx.print(master);
      ctx.print("");
      await ctx.poll("Waiting for ETH…", async () => {
        const balance = await pub.getBalance({ address: master });
        return balance >= requiredEth ? balance : null;
      }, { intervalMs: 10_000 });
    }
    ctx.print(`Gas budget: ${formatUnits(requiredEth, 18)} ETH`);

    const ok = await ctx.confirm(`Deposit ${arrival.usdc} USDC into Hyperliquid?`, true);
    if (!ok) throw new Error("operator declined the bridge deposit");

    const masterPk = await ctx.getSecret(KeyRoles.master);
    if (!masterPk) throw new Error("master key missing from keystore");
    const masterAccount = privateKeyToAccount(masterPk as `0x${string}`);
    if (masterAccount.address.toLowerCase() !== master.toLowerCase()) throw new Error("Funding wallet does not match the bot account.");
    const wallet = createWalletClient({ account: masterAccount, chain: arbitrum, transport: http(urls.arbitrumRpc) });
    const txHash = await wallet.writeContract({
      ...transfer,
      gas,
      gasPrice,
    });
    ctx.print("Deposit transaction");
    ctx.print(txHash);
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error("Deposit transaction reverted.");

    await ctx.poll("waiting for Hyperliquid to credit the deposit…", async () => {
      const st = await this.info.clearinghouseState({ user: master });
      return Number(st.marginSummary.accountValue) >= Number(existing.marginSummary.accountValue) + arrival.usdc - 0.000001 ? st : null;
    });
    ctx.print("Deposit credited.");

    const provisioned = await this.provisionAgent(ctx, a);
    await this.preparePerpFunding(ctx, provisioned);
    return provisioned;
  }

  private async preparePerpFunding(ctx: SetupContext, acct: VenueAccount): Promise<void> {
    if (!this.opts.perpDex) return;
    if (this.opts.allowUnifiedPerps && await this.info.userAbstraction({ user: this.masterAddress(acct) }) === "unifiedAccount") {
      const balance = await this.perpAccountSnapshot(acct);
      ctx.print(`Shared trading balance: ${balance.equity} USDC`);
      return;
    }
    const masterPk = await ctx.getSecret(KeyRoles.master);
    if (!masterPk) throw new Error("Master key missing from keystore.");
    const wallet = privateKeyToAccount(masterPk as `0x${string}`);
    if (wallet.address.toLowerCase() !== this.masterAddress(acct).toLowerCase()) throw new Error("Funding wallet does not match the bot account.");
    const result = await prepareHyperliquidPerpFunding({
      info: this.info, exchange: new ExchangeClient({ transport: this.transport, wallet }),
      context: ctx, masterAddress: wallet.address, destinationDex: this.opts.perpDex, now: this.now,
    });
    if (result.status === "canceled") throw new Error("Trading balance setup canceled.");
    if (result.movedUsdc !== "0") ctx.print(`Trading balance: ${result.destinationUsdc} USDC`);
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
    // Reports may read the venue's unselected/default balances. Only trading
    // authorization requires an explicitly selected Standard account mode.
    if (this.opts.perpDex !== undefined) {
      const mode = await this.info.userAbstraction({ user: this.masterAddress(acct) });
      if (mode === "unifiedAccount" && this.opts.allowUnifiedPerps) {
        const a = await this.perpAccountSnapshot(acct);
        return [{ asset: "USDC", total: a.equity, available: a.availableCollateral }];
      }
      if (mode !== "default" && mode !== "disabled") throw new Error(`Cannot value separate DEX balances in ${mode} mode.`);
    }
    const states = await this.accountStates(acct);
    return [{ asset: "USDC", total: states.reduce((sum, { state }) => sum + finiteNumber(state.marginSummary.accountValue, "account equity"), 0),
      available: states.reduce((sum, { state }) => sum + nonnegativeNumber(state.withdrawable, "available collateral"), 0) }];
  }

  async portfolioScope(acct: VenueAccount) {
    const user = this.masterAddress(acct);
    const [accountMode, funding] = await Promise.all([
      this.info.userAbstraction({ user }), this.info.clearinghouseState({ user }),
    ]);
    return {
      dex: this.selectedDexs().length > 1 ? "multi" : this.selectedDexs()[0]!, accountMode,
      ...(this.selectedDexs().length > 1 ? { dexes: this.selectedDexs() } : {}),
      fundingBalance: accountMode !== "unifiedAccount" && !this.selectedDexs().includes("") ? finiteNumber(funding.marginSummary.accountValue, "funding balance") : 0,
      fundingAvailable: accountMode !== "unifiedAccount" && !this.selectedDexs().includes("") ? nonnegativeNumber(funding.withdrawable, "funding available") : 0,
    };
  }

  async positions(acct: VenueAccount): Promise<Position[]> {
    return (await this.accountStates(acct)).flatMap(({ dex, state }) => this.mapPositions(state, dex));
  }

  private selectedDexs(): string[] {
    return [...new Set([this.opts.perpDex ?? "", ...(this.opts.additionalPerpDexs ?? [])])];
  }

  private async accountStates(acct: VenueAccount) {
    return Promise.all(this.selectedDexs().map(async dex => ({ dex,
      state: await this.info.clearinghouseState({ user: this.masterAddress(acct), ...(dex || this.opts.perpDex !== undefined ? { dex } : {}) }),
    })));
  }

  private mapPositions(st: Awaited<ReturnType<InfoClient["clearinghouseState"]>>, dex: string): Position[] {
    return st.assetPositions
      .filter((ap) => finiteNumber(ap.position.szi, "position size") !== 0)
      .map((ap) => {
        const p = ap.position;
        const szi = finiteNumber(p.szi, "position size");
        this.assertScope(p.coin);
        if (hyperliquidDex(p.coin) !== dex) throw new Error("Hyperliquid account position belongs to another DEX");
        return {
          marketRef: p.coin,
          side: szi > 0 ? ("LONG" as const) : ("SHORT" as const),
          size: Math.abs(szi),
          avgPrice: positiveNumber(p.entryPx, "entry price"),
          currentPrice: positiveNumber(p.positionValue, "position value") / Math.abs(szi),
          unrealizedPnl: finiteNumber(p.unrealizedPnl, "unrealized P&L"),
          label: `${p.coin}-PERP`,
          leverage: positiveNumber(p.leverage.value, "position leverage"),
          marginMode: p.leverage.type,
          marginUsed: nonnegativeNumber(p.marginUsed, "position margin"),
          ...(p.liquidationPx !== null ? { liquidationPrice: nonnegativeNumber(p.liquidationPx, "liquidation price") } : {}),
        };
      });
  }

  private assertScope(coin: string): void {
    if (this.opts.perpDex !== undefined && !this.selectedDexs().includes(hyperliquidDex(coin))) {
      throw new Error(`Hyperliquid instrument is outside configured DEX "${this.opts.perpDex}"`);
    }
  }

  private async assertStandard(acct: VenueAccount, cachedRead = false): Promise<string> {
    const user = this.masterAddress(acct);
    const cached = this.modeCache;
    const abstraction = cachedRead && cached?.user === user && this.now() - cached.ts < 15_000
      ? cached.value : await this.info.userAbstraction({ user });
    if (!cachedRead || abstraction !== cached?.value || cached?.user !== user || this.now() - cached.ts >= 15_000) {
      this.modeCache = { ts: this.now(), user, value: abstraction };
    }
    // "default" is not an explicit Standard-mode guarantee. The venue's
    // default can change; require a positively identified disabled mode.
    if (abstraction === "unifiedAccount" && this.opts.allowUnifiedPerps) return "unified";
    if (abstraction !== "disabled") throw new Error(`Hyperliquid perp strategy requires explicit Standard account mode${this.opts.allowUnifiedPerps ? " or Unified account mode" : ""}; found ${abstraction}`);
    return "standard";
  }

  private instrument(coin: string, meta: AssetMeta): PerpInstrument {
    // Built-in ids 1..50 are flat tiers and can be omitted from marginTables.
    // The official HIP-3 API example uses ids 10/20 but returns only table 50.
    // Custom tables must be supplied explicitly; never guess their risk.
    // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
    const table = meta.marginTables.find(([id]) => id === meta.marginTableId)?.[1]
      ?? (Number.isInteger(meta.marginTableId) && meta.marginTableId >= 1 && meta.marginTableId <= 50 && meta.marginTableId === meta.maxLeverage
        ? { marginTiers: [{ lowerBound: "0", maxLeverage: meta.maxLeverage }] }
        : undefined);
    if (!table || table.marginTiers.length === 0) throw new Error(`missing Hyperliquid margin table for ${coin}`);
    const marginTiers = table.marginTiers.map((t) => ({
      lowerBound: nonnegativeNumber(t.lowerBound, "margin tier lower bound"),
      maxLeverage: positiveNumber(t.maxLeverage, "margin tier leverage"),
      maintenanceMarginRate: 1 / (2 * positiveNumber(t.maxLeverage, "margin tier leverage")),
    }));
    if (marginTiers[0]!.lowerBound !== 0 || marginTiers.some((t, i) => !Number.isInteger(t.maxLeverage) || (i > 0 && (t.lowerBound <= marginTiers[i - 1]!.lowerBound || t.maxLeverage > marginTiers[i - 1]!.maxLeverage)))) {
      throw new Error(`invalid Hyperliquid margin tiers for ${coin}`);
    }
    return {
      marketRef: coin, assetId: meta.assetId, dex: meta.dex, collateralToken: meta.collateralToken,
      szDecimals: meta.szDecimals, maxLeverage: meta.maxLeverage,
      onlyIsolated: meta.marginMode !== undefined, strictIsolated: meta.marginMode === "strictIsolated",
      minNotional: 10, maintenanceMarginRate: marginTiers[0]!.maintenanceMarginRate, marginTiers,
      deployerFeeScale: nonnegativeNumber(meta.deployerFeeScale, "deployer fee scale"),
      growthMode: meta.growthMode, active: !meta.isDelisted,
    };
  }

  async perpInstruments(): Promise<PerpInstrument[]> {
    const dexes = this.selectedDexs();
    await Promise.all(dexes.map(dex => this.loadDex(dex)));
    return dexes.flatMap(dex => [...this.dexCache.get(dex)!.meta].map(([coin, meta]) => this.instrument(coin, meta)));
  }

  async perpAccountSnapshot(acct: VenueAccount): Promise<PerpAccountSnapshot> {
    const abstraction = await this.assertStandard(acct, true);
    const dexes = this.selectedDexs();
    await Promise.all(dexes.map(dex => this.loadDex(dex)));
    const metadata = dexes.flatMap(dex => [...this.dexCache.get(dex)!.meta.values()]);
    if (metadata.length === 0 || metadata.some((m) => m.collateralToken !== 0)) {
      throw new Error("Hyperliquid perp strategy requires a USDC collateral DEX");
    }
    const [states, openOrders] = await Promise.all([this.accountStates(acct), this.openOrders(acct)]);
    if (abstraction === "unified") {
      // DEX marginSummary balances overlap in unified mode. The venue documents
      // spotClearinghouseState as the balance/hold source of truth, including perps.
      const spot = await this.info.spotClearinghouseState({ user: this.masterAddress(acct) });
      const usdc = spot.balances.filter(b => "token" in b && b.token === 0);
      if (usdc.length > 1 || (usdc[0] && usdc[0].coin !== "USDC")) throw new Error("invalid unified USDC balance identity");
      const equity = usdc[0] ? nonnegativeNumber(usdc[0].total, "unified USDC total") : 0;
      const hold = usdc[0] ? nonnegativeNumber(usdc[0].hold, "unified USDC hold") : 0;
      const available = spot.tokenToAvailableAfterMaintenance?.filter(([token]) => token === 0);
      if (!available || available.length !== 1 || hold > equity) throw new Error("unified USDC available collateral is unconfirmed");
      const availableCollateral = Math.max(0, Math.min(equity - hold, nonnegativeNumber(available[0]![1], "unified available collateral")));
      for (const { state } of states) {
        const time = nonnegativeNumber(state.time, "account timestamp");
        if (this.now() - time > 60_000 || time > this.now() + 5_000) throw new Error("Hyperliquid account state is stale");
      }
      const positions = states.flatMap(({ dex, state }) => this.mapPositions(state, dex));
      return { equity, availableCollateral, marginUsed: positions.reduce((sum, p) => sum + (p.marginUsed ?? 0), 0),
        grossNotional: positions.reduce((sum, p) => sum + p.size * p.currentPrice!, 0),
        abstraction, collateral: "USDC", dex: dexes.length > 1 ? "multi" : dexes[0]!, dexes,
        sharedCollateral: true, positions, openOrders, ts: this.now() };
    }
    const dexBalances = states.map(({ dex, state: st }) => {
      const venueTime = nonnegativeNumber(st.time, "account timestamp");
      if (this.now() - venueTime > 60_000 || venueTime > this.now() + 5_000) throw new Error("Hyperliquid account state is stale");
      return { dex, equity: nonnegativeNumber(st.marginSummary.accountValue, "account equity"),
        availableCollateral: nonnegativeNumber(st.withdrawable, "available collateral"),
        marginUsed: nonnegativeNumber(st.marginSummary.totalMarginUsed, "account margin"),
        grossNotional: nonnegativeNumber(st.marginSummary.totalNtlPos, "gross notional") };
    });
    return {
      equity: dexBalances.reduce((sum, b) => sum + b.equity, 0),
      availableCollateral: dexBalances.reduce((sum, b) => sum + b.availableCollateral, 0),
      marginUsed: dexBalances.reduce((sum, b) => sum + b.marginUsed, 0),
      grossNotional: dexBalances.reduce((sum, b) => sum + b.grossNotional, 0),
      abstraction, collateral: "USDC", dex: dexes.length > 1 ? "multi" : dexes[0]!, dexBalances,
      positions: states.flatMap(({ dex, state }) => this.mapPositions(state, dex)), openOrders, ts: this.now(),
    };
  }

  async perpMarketSnapshot(acct: VenueAccount, marketRef: string): Promise<PerpMarketSnapshot> {
    this.assertScope(marketRef);
    const meta = await this.assetMeta(marketRef);
    if (meta.collateralToken !== 0) throw new Error("Hyperliquid perp strategy requires USDC collateral");
    const instrument = this.instrument(marketRef, meta);
    const user = this.masterAddress(acct);
    const now = this.now();
    const fees = async () => {
      if (!this.feeCache || this.feeCache.user !== user || now - this.feeCache.ts >= 300_000) {
        this.feeCache = { ts: now, user, value: await this.info.userFees({ user }) };
      }
      return this.feeCache.value;
    };
    // One book read per asset plus shared, cached asset contexts and fees: cold snapshots stay cheap.
    const [book, userFees] = await Promise.all([this.book(marketRef), fees()]);
    const ctx = this.dexCache.get(meta.dex)!.ctx.get(marketRef)!;
    const rates = hyperliquidFeeRates({
      maker: finiteNumber(userFees.userAddRate, "maker fee"), taker: nonnegativeNumber(userFees.userCrossRate, "taker fee"),
      referralDiscount: nonnegativeNumber(userFees.activeReferralDiscount, "referral discount"),
      dexIndex: meta.dexIndex, deployerFeeScale: meta.deployerFeeScale, growthMode: meta.growthMode,
    });
    const bid = book.bids[0]?.price ?? 0;
    const ask = book.asks[0]?.price ?? 0;
    if (!(bid > 0 && ask > bid)) throw new Error("Hyperliquid market snapshot needs an uncrossed two-sided book");
    if (book.venueTs === undefined || now - book.venueTs > 30_000 || book.venueTs > this.now() + 5_000) throw new Error("Hyperliquid market snapshot has a stale venue book");
    const mid = (bid + ask) / 2;
    return {
      instrument, book,
      quote: { marketRef, bid, ask, mid, volume24h: nonnegativeNumber(ctx.dayNtlVlm, "volume"), spreadBps: (ask - bid) / mid * 10_000, ts: book.ts },
      markPrice: positiveNumber(ctx.markPx, "mark price"), oraclePrice: positiveNumber(ctx.oraclePx, "oracle price"),
      fundingRateHourly: finiteNumber(ctx.funding, "funding"),
      makerFeeRate: rates.maker, takerFeeRate: rates.taker, ts: this.now(),
    };
  }

  async perpCashFlows(acct: VenueAccount, sinceTs: number): Promise<PerpCashFlowResult> {
    const user = this.masterAddress(acct);
    const dexes = this.selectedDexs();
    const unified = await this.assertStandard(acct, true) === "unified";
    const endTime = this.now();
    let startTime = Math.max(0, Math.floor(nonnegativeNumber(sinceTs, "cash-flow cursor")));
    let understood = true;
    const flows = new Map<string, PerpCashFlowResult["flows"][number]>();
    for (let page = 0; page < 100; page++) {
      const rows = await this.info.userNonFundingLedgerUpdates({ user, startTime, endTime });
      for (const row of rows) {
        const ts = nonnegativeNumber(row.time, "cash-flow timestamp");
        if (ts < startTime || ts > endTime) throw new Error("Hyperliquid cash-flow response is outside requested range");
        let byDex: Record<string, number> = {};
        let amount: number;
        try {
          const delta = row.delta as unknown as Record<string, unknown>;
          if (unified) amount = hyperliquidUnifiedCashFlow(delta, user) ?? 0;
          else {
            byDex = Object.fromEntries(dexes.map(dex => [dex, hyperliquidDexCashFlow(delta, user, dex) ?? 0]));
            amount = Object.values(byDex).reduce((sum, value) => sum + value, 0);
          }
        }
        catch { understood = false; continue; }
        if (amount !== 0 || Object.values(byDex).some(value => value !== 0)) {
          const id = `${row.hash}:${ts}:${JSON.stringify(row.delta)}`;
          flows.set(id, { id, ts, amount, ...(!unified && dexes.length > 1 ? { byDex } : {}) });
        }
      }
      // Time-range endpoints may truncate at 500 records. Repeat the boundary
      // millisecond and deduplicate, so concurrent transfers cannot be skipped.
      if (rows.length < 500) return { flows: [...flows.values()].sort((a, b) => a.ts - b.ts), complete: understood };
      const last = Math.max(...rows.map((r) => r.time));
      if (last <= startTime) break;
      startTime = last;
    }
    return { flows: [...flows.values()].sort((a, b) => a.ts - b.ts), complete: false };
  }

  async book(marketRef: string): Promise<OrderBook> {
    this.assertScope(marketRef);
    const b = await this.info.l2Book({ coin: marketRef });
    if (!b) throw new Error(`no Hyperliquid book for "${marketRef}"`);
    if (b.coin !== marketRef) throw new Error("Hyperliquid book identity mismatch");
    const [bids, asks] = b.levels;
    return {
      marketRef,
      bids: bids.map((l) => ({ price: positiveNumber(l.px, "bid price"), size: nonnegativeNumber(l.sz, "bid size") })).sort((a, b) => b.price - a.price),
      asks: asks.map((l) => ({ price: positiveNumber(l.px, "ask price"), size: nonnegativeNumber(l.sz, "ask size") })).sort((a, b) => a.price - b.price),
      ts: this.now(),
      venueTs: nonnegativeNumber(b.time, "book timestamp"),
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
    this.assertScope(marketRef);
    if (!Number.isInteger(lookback) || lookback <= 0 || lookback > 5_000) throw new Error("invalid Hyperliquid candle lookback");
    const intervalMs: Record<CandleInterval, number> = { "1h": 3_600_000, "4h": 4 * 3_600_000, "1d": 24 * 3_600_000 };
    const step = intervalMs[interval];
    if (!step) throw new Error("invalid Hyperliquid candle interval");
    const now = this.now();
    const endTime = Math.floor(now / step) * step;
    const key = JSON.stringify([marketRef, interval]);
    const cached = this.candleCache.get(key);
    if (cached?.boundary === endTime && cached.expiresAt > now && cached.lookback >= lookback) {
      return cached.rows.slice(-lookback).map(c => ({ ...c }));
    }
    const inFlight = this.candleLoads.get(key);
    if (inFlight) {
      await inFlight;
      return this.candles(marketRef, interval, lookback);
    }
    const requested = Math.max(lookback, cached?.lookback ?? 0);
    const load = async () => {
      // Query only through the current bar's opening boundary. Even if the
      // inclusive endpoint returns that live bar, it never enters the cache.
      const startTime = Math.max(0, endTime - (requested + 10) * step);
      const rows = await this.info.candleSnapshot({ coin: marketRef, interval, startTime, endTime });
      const candles = new Map<number, Candle>();
      for (const c of rows) {
        if (c.s !== marketRef || c.i !== interval) throw new Error("Hyperliquid candle identity mismatch");
        const ts = nonnegativeNumber(c.t, "candle timestamp");
        if (ts + step > endTime) continue;
        const candle = {
          ts, open: positiveNumber(c.o, "candle open"), high: positiveNumber(c.h, "candle high"),
          low: positiveNumber(c.l, "candle low"), close: positiveNumber(c.c, "candle close"),
          volume: nonnegativeNumber(c.v, "candle volume"),
        };
        if (candle.low > Math.min(candle.open, candle.close) || candle.high < Math.max(candle.open, candle.close)) throw new Error("invalid Hyperliquid OHLC candle");
        candles.set(candle.ts, candle);
      }
      const completed = [...candles.values()].sort((a, b) => a.ts - b.ts).slice(-requested);
      // If publication lags the new boundary, retry on the next market refresh
      // instead of freezing a missing newly closed bar for the whole interval.
      const expiresAt = completed.at(-1)?.ts === endTime - step ? endTime + step : Math.min(endTime + step, this.now() + 15_000);
      this.candleCache.set(key, { boundary: endTime, expiresAt, lookback: requested, rows: completed });
    };
    const pending = load();
    this.candleLoads.set(key, pending);
    try { await pending; }
    catch (error) { this.candleCache.delete(key); throw error; }
    finally { this.candleLoads.delete(key); }
    return this.candles(marketRef, interval, lookback);
  }

  /** Funding rate as decimal per 8h. HL publishes an hourly rate; ×8 here. */
  async fundingRate(marketRef: string): Promise<number> {
    const ctx = await this.assetCtx(marketRef);
    return ctx.funding * 8;
  }

  async openOrders(acct: VenueAccount): Promise<Order[]> {
    const groups = await Promise.all(this.selectedDexs().map(async dex => {
      const rows = await this.info.frontendOpenOrders({ user: this.masterAddress(acct), ...(dex || this.opts.perpDex !== undefined ? { dex } : {}) });
      if (rows.some(o => hyperliquidDex(o.coin) !== dex)) throw new Error("Hyperliquid open order belongs to another DEX");
      return rows.map(o => this.mapOrder(o));
    }));
    return groups.flat();
  }

  private mapOrder(o: HlOpenOrder): Order {
    this.assertScope(o.coin);
    if (!Number.isSafeInteger(o.oid) || o.oid <= 0 || (o.side !== "A" && o.side !== "B")) throw new Error("invalid Hyperliquid order identity");
    const original = nonnegativeNumber(o.origSz, "order size");
    const remaining = nonnegativeNumber(o.sz, "remaining order size");
    if (remaining > original) throw new Error("invalid Hyperliquid remaining order size");
    return {
      id: String(o.oid),
      clientId: o.cloid ?? undefined,
      marketRef: o.coin,
      side: o.side === "B" ? ("BUY" as const) : ("SELL" as const),
      size: original,
      filledSize: Math.max(0, original - remaining),
      price: positiveNumber(o.limitPx, "order price"),
      status: original > remaining ? ("partial" as const) : ("open" as const),
      createdAt: nonnegativeNumber(o.timestamp, "order timestamp"),
      reduceOnly: o.reduceOnly, isTrigger: o.isTrigger, isPositionTpsl: o.isPositionTpsl,
      ...(o.isTrigger ? { triggerPrice: positiveNumber(o.triggerPx, "trigger price"), triggerKind: o.orderType.startsWith("Take Profit") ? "tp" as const : "sl" as const } : {}),
    };
  }

  async fills(acct: VenueAccount, sinceTs: number): Promise<Fill[]> {
    const rows = await this.info.userFillsByTime({
      user: this.masterAddress(acct),
      startTime: Math.max(0, sinceTs),
    });
    return rows.filter((f) => this.opts.perpDex === undefined || this.selectedDexs().includes(hyperliquidDex(f.coin))).map((f) => ({
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

  async configurePerpLeverage(acct: VenueAccount, request: PerpLeverageRequest): Promise<void> {
    this.assertScope(request.marketRef);
    await this.assertStandard(acct);
    const meta = await this.assetMeta(request.marketRef);
    if (meta.isDelisted || meta.collateralToken !== 0) throw new Error("Hyperliquid leverage configuration requires an active USDC instrument");
    if (request.marginMode !== "isolated" || !Number.isInteger(request.leverage) || request.leverage < 1 || request.leverage > Math.min(20, meta.maxLeverage)) {
      throw new Error("Hyperliquid strategy leverage must be isolated, integral, and within the 20x/venue ceiling");
    }
    const user = this.masterAddress(acct);
    const [current, positions] = await Promise.all([
      this.info.activeAssetData({ user, coin: request.marketRef }), this.positions(acct),
    ]);
    if (current.coin !== request.marketRef || current.user.toLowerCase() !== user.toLowerCase()) throw new Error("Hyperliquid leverage response identity mismatch");
    if (current.leverage.type === "isolated" && current.leverage.value === request.leverage) return;
    if (positions.some((p) => p.marketRef === request.marketRef && p.size > 0)) {
      throw new Error("refusing to change Hyperliquid leverage or collateral on an existing strategy position");
    }
    await this.throttled(() => this.agentExchange().updateLeverage({ asset: meta.assetId, isCross: false, leverage: request.leverage }));
    const verified = await this.info.activeAssetData({ user, coin: request.marketRef });
    if (verified.coin !== request.marketRef || verified.user.toLowerCase() !== user.toLowerCase() || verified.leverage.type !== "isolated" || verified.leverage.value !== request.leverage) {
      throw new Error("Hyperliquid did not confirm the requested isolated leverage");
    }
  }

  async placePerpStop(acct: VenueAccount, request: PerpStopRequest): Promise<OrderAck> {
    this.assertScope(request.marketRef);
    const meta = await this.assetMeta(request.marketRef);
    if (request.positionSide !== "LONG" && request.positionSide !== "SHORT") throw new Error("invalid Hyperliquid stop position side");
    positiveNumber(request.size, "stop size");
    positiveNumber(request.stopPx, "stop price");
    if (!Number.isFinite(request.slippagePct) || request.slippagePct <= 0 || request.slippagePct >= 100) throw new Error("invalid Hyperliquid stop slippage");
    const position = (await this.positions(acct)).find((p) => p.marketRef === request.marketRef);
    if (!position || position.side !== request.positionSide) throw new Error("Hyperliquid stop has no matching live position");
    const size = formatSize(Math.min(request.size, position.size), meta.szDecimals);
    if (!(Number(size) > 0)) throw new Error("Hyperliquid stop size rounds to zero");
    const side = request.positionSide === "LONG" ? "SELL" : "BUY";
    // Stops round toward earlier protection; execution limits round inward so
    // the adapter never grants a wider slippage bound than requested.
    const triggerPx = formatBoundedHlPrice(request.stopPx, meta.szDecimals, side);
    const mark = position.currentPrice!;
    if (request.positionSide === "LONG" ? Number(triggerPx) >= mark : Number(triggerPx) <= mark) {
      throw new Error("Hyperliquid stop is already crossed; a reduce-only exit is required");
    }
    const bound = Number(triggerPx) * (side === "SELL" ? 1 - request.slippagePct / 100 : 1 + request.slippagePct / 100);
    const res = await this.throttled(() => this.agentExchange().order({
      orders: [{
        a: meta.assetId, b: side === "BUY", p: formatBoundedHlPrice(bound, meta.szDecimals, side),
        s: size, r: true, c: toCloid(request.clientId),
        t: { trigger: { isMarket: true, triggerPx, tpsl: "sl" } },
      }],
      grouping: "positionTpsl",
    }));
    if (res.response.data.statuses.length !== 1) throw new Error("Hyperliquid stop returned an unexpected status count");
    const status = res.response.data.statuses[0];
    if (typeof status === "string") {
      // Trigger orders are acknowledged as "waitingForTrigger" before the order
      // index carries them. Poll the light status read briefly for the venue id;
      // otherwise the acknowledgement stands under its client id and the executor
      // confirms the resting stop by client id on its next pass.
      const user = this.masterAddress(acct), cloid = toCloid(request.clientId);
      for (let attempt = 0; attempt < 6; attempt++) {
        const found = await this.info.orderStatus({ user, oid: cloid }).catch(() => undefined);
        if (found && found.status !== "unknownOid") {
          if (found.order.order.cloid && found.order.order.cloid.toLowerCase() !== cloid) throw new Error("Hyperliquid order status CLOID mismatch");
          if (["rejected", "canceled"].some(s => found.order.status === s || found.order.status.endsWith(s.charAt(0).toUpperCase() + s.slice(1)))) {
            return { orderId: String(found.order.order.oid), clientId: request.clientId, status: "rejected" };
          }
          return { orderId: String(found.order.order.oid), clientId: request.clientId, status: "open" };
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      return this.orderAck(status, request.clientId);
    }
    return this.orderAck(status, request.clientId);
  }

  async lookupPerpOrder(acct: VenueAccount, clientId: string): Promise<PerpOrderLookup> {
    const result = await this.info.orderStatus({ user: this.masterAddress(acct), oid: toCloid(clientId) });
    // A missing order does not establish that a timed-out request cannot
    // arrive later. The executor must keep its reservation and reconcile.
    if (result.status === "unknownOid") return { found: false, definitive: false };
    if (result.order.order.cloid && result.order.order.cloid.toLowerCase() !== toCloid(clientId)) throw new Error("Hyperliquid order status CLOID mismatch");
    const order = this.mapOrder(result.order.order);
    const status = result.order.status;
    order.status = status === "filled" ? "filled"
      : status === "open" || status === "triggered" ? order.status
      : status === "rejected" || status.endsWith("Rejected") ? "rejected"
      : status === "canceled" || status.endsWith("Canceled") ? "canceled" : (() => { throw new Error("unknown Hyperliquid order status"); })();
    // A terminal IOC can be only partly filled. Venue origSz is the request,
    // not proof of execution; resolve executed quantity from actual fills.
    const rows = await this.info.userFillsByTime({ user: this.masterAddress(acct), startTime: Math.max(0, (order.createdAt ?? this.now()) - 1_000), endTime: this.now() });
    // An exhausted history page or delayed fill index cannot certify execution.
    if (rows.length >= 2_000) return { found: false, definitive: false };
    const fills = rows.filter((fill) => String(fill.oid) === order.id && fill.coin === order.marketRef);
    const byId = new Map(fills.map((fill) => [String(fill.tid), fill]));
    const filledSize = [...byId.values()].reduce((sum, fill) => sum + nonnegativeNumber(fill.sz, "fill size"), 0);
    const filledNotional = [...byId.values()].reduce((sum, fill) => sum + nonnegativeNumber(fill.sz, "fill size") * positiveNumber(fill.px, "fill price"), 0);
    if (status === "filled" && filledSize === 0) return { found: false, definitive: false };
    order.filledSize = filledSize;
    return {
      found: true, order,
      ack: { orderId: order.id, clientId, status: order.status, filledSize, ...(filledSize > 0 ? { avgFillPrice: filledNotional / filledSize } : {}) },
    };
  }

  async disarmScheduledCancel(acct: VenueAccount): Promise<void> {
    // This adapter never rearms after disarming. Repeating a signed no-op on
    // every supervision pass needlessly consumes the wallet's action allowance.
    if (this.scheduledCancelDisarmed) return;
    try {
      await this.throttled(() => this.agentExchange().scheduleCancel());
    } catch (error) {
      // The venue also applies its cumulative-volume eligibility check when
      // removing a timer. An ineligible account cannot have armed this feature.
      // Accept only the exact definitive SDK rejection plus an independent
      // cumulative-volume read; unknown acknowledgements remain failures.
      const response = error instanceof ApiRequestError ? error.response as { status?: unknown; response?: unknown } : undefined;
      const match = response?.status === "err" && typeof response.response === "string"
        ? /^Cannot set scheduled cancel time until enough volume traded\. Required: \$(\d+(?:\.\d+)?)\. Traded: \$(\d+(?:\.\d+)?)\.$/.exec(response.response)
        : null;
      if (!match) throw error;
      const required = Number(match[1]), rejectedVolume = Number(match[2]);
      if (!Number.isFinite(required) || required <= 0 || !Number.isFinite(rejectedVolume) || rejectedVolume >= required) throw error;
      const limits = await this.info.userRateLimit({ user: this.masterAddress(acct) });
      const volume = typeof limits.cumVlm === "string" && /^\d+(?:\.\d+)?$/.test(limits.cumVlm) ? Number(limits.cumVlm) : NaN;
      if (!Number.isFinite(volume) || volume < rejectedVolume || volume >= required) throw error;
    }
    this.scheduledCancelDisarmed = true;
  }

  private orderAck(status: Awaited<ReturnType<ExchangeClient["order"]>>["response"]["data"]["statuses"][number] | { error: string } | undefined, clientId: string): OrderAck {
    if (!status) throw new Error("hyperliquid order returned no status");
    if (typeof status === "string") return { orderId: toCloid(clientId), clientId, status: "open" };
    if ("resting" in status) return { orderId: String(status.resting.oid), clientId, status: "open" };
    if ("filled" in status) return {
      orderId: String(status.filled.oid), clientId, status: "filled",
      filledSize: nonnegativeNumber(status.filled.totalSz, "filled size"), avgFillPrice: positiveNumber(status.filled.avgPx, "average fill price"),
    };
    throw new Error(`hyperliquid order rejected: ${status.error}`);
  }

  async placeOrder(_acct: VenueAccount, intent: OrderIntent): Promise<OrderAck> {
    this.assertScope(intent.marketRef);
    const meta = await (async () => {
      if (this.opts.perpDex !== undefined && !intent.reduceOnly) await this.assertStandard(_acct);
      return this.assetMeta(intent.marketRef);
    })().catch((error: unknown) => {
      // These reads precede signing and exchange submission. A local budget
      // deferral may be retried on a later tick without reserving a phantom order.
      if (error instanceof HyperliquidInfoDeferredError) throw new HyperliquidOrderNotSubmittedError(error.message, { cause: error });
      throw error;
    });
    if (!intent.reduceOnly && meta.isDelisted) throw new Error("cannot add exposure to a delisted Hyperliquid instrument");
    const ex = this.agentExchange();
    const isBuy = intent.side === "BUY";
    const size = formatSize(intent.size, meta.szDecimals);
    const price = formatBoundedHlPrice(intent.limitPrice, meta.szDecimals, intent.side);
    if (!(Number(size) > 0)) throw new Error("Hyperliquid order size rounds to zero");
    if (!intent.reduceOnly && Number(size) * Number(price) < 10) throw new Error("Hyperliquid entry is below the $10 venue minimum after rounding");
    if (intent.postOnly && (intent.tif === "IOC" || intent.tif === "FAK" || intent.tif === "FOK")) throw new Error("Hyperliquid post-only cannot be combined with immediate execution");
    // HL has no FOK; Ioc (fill what crosses, cancel the rest) is the closest. GTD maps to Gtc.
    const tif = intent.postOnly ? "Alo" : intent.tif === "IOC" || intent.tif === "FAK" || intent.tif === "FOK" ? "Ioc" : "Gtc";

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
    ).catch((error: unknown) => {
      // The pinned SDK throws even for a definite per-order rejection. Only
      // this single-order exchange call can certify that nothing was placed;
      // errors from later trigger placement must keep the accepted entry live.
      const rejection = error instanceof ApiRequestError ? singleOrderRejection(error.response) : undefined;
      if (rejection !== undefined) throw new HyperliquidOrderRejectedError(rejection, { cause: error });
      throw error;
    });

    const rejection = singleOrderRejection(res);
    if (rejection !== undefined) throw new HyperliquidOrderRejectedError(rejection);
    if (res.response.data.statuses.length !== 1) throw new Error("Hyperliquid order status count mismatch");

    const ack = this.orderAck(res.response.data.statuses[0], intent.clientId);

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
      const triggers = await this.throttled(() => ex.order({ orders: triggerOrders, grouping: "positionTpsl" }));
      if (triggers.response.data.statuses.length !== triggerOrders.length) throw new Error("Hyperliquid trigger status count mismatch after accepted entry");
      triggers.response.data.statuses.forEach((status, i) => this.orderAck(status, `${intent.clientId}-trigger-${i}`));
    }

    return ack;
  }

  async cancelOrder(_acct: VenueAccount, id: string): Promise<void> {
    // Cancel needs the asset id; look the order up first.
    const acctRows = await this.openOrders(_acct);
    const order = acctRows.find((o) => o.id === id || o.clientId === toCloid(id));
    if (!order) return;
    const meta = await this.assetMeta(order.marketRef);
    const ex = this.agentExchange();
    await this.throttled(() => ex.cancel({ cancels: [{ a: meta.assetId, o: Number(order.id) }] }));
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
    // A scoped swing account must retain native protection if its process
    // disappears. Never silently rearm a globally destructive timer.
    if (this.scheduledCancelDisarmed || this.opts.perpDex !== undefined) return;
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
  if (!Number.isFinite(px) || px <= 0) throw new Error("price must be positive and finite");
  if (!Number.isInteger(szDecimals) || szDecimals < 0 || szDecimals > 6) throw new Error("invalid Hyperliquid size decimals");
  const maxDecimals = 6 - szDecimals;
  if (Number.isInteger(px) && px < 1e15) return String(px);
  let p = Number(px.toPrecision(5));
  p = Number(p.toFixed(Math.max(0, maxDecimals)));
  return trimZeros(p.toFixed(Math.max(0, maxDecimals)));
}

export function formatSize(sz: number, szDecimals: number): string {
  if (!Number.isFinite(sz) || sz < 0 || !Number.isInteger(szDecimals) || szDecimals < 0 || szDecimals > 6) throw new Error("invalid Hyperliquid size");
  // Truncate the decimal representation exactly. Binary multiplication can
  // turn a valid 1.005 position into 1.004 and leave a one-tick stop shortfall.
  const [mantissa, exponent = "0"] = String(sz).split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const shift = Number(exponent) - fraction.length + szDecimals;
  const digits = BigInt(`${whole}${fraction}`);
  const units = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  if (szDecimals === 0) return String(units);
  const padded = String(units).padStart(szDecimals + 1, "0");
  return trimZeros(`${padded.slice(0, -szDecimals)}.${padded.slice(-szDecimals)}`);
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** HL cloid = 0x + 32 hex chars. Deterministic from the engine clientId. */
export function toCloid(clientId: string): `0x${string}` {
  if (/^0x[0-9a-fA-F]{32}$/.test(clientId)) return clientId.toLowerCase() as `0x${string}`;
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

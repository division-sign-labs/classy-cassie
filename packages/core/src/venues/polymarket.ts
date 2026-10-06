// packages/core/src/venues/polymarket.ts
// Polymarket venue adapter (§5.1), built on the official unified SDK
// @polymarket/client 0.6.0 (pinned). Verified against the installed SDK's type
// surface and docs.polymarket.com on 2026-09-06.
//
// Conventions:
//  - marketRef is the CLOB token ID of the YES token (§7). NO-side orders carry
//    intent.outcome = "NO"; this adapter resolves the sibling token via
//    resolveConditionByToken + fetchMarketInfo (cached).
//  - Signer vs funder: orders are signed by the bot's EOA signer; `funder` is
//    the Deposit Wallet address. Confusing the two is the classic 401.
//  - Dead man's switch: CLOB V2 `POST /v1/heartbeats` — a chained heartbeat_id,
//    ~10s lapse window (+5s check cadence). heartbeat() sends ONE beat and
//    recovers from 400 (expired id). Runtimes call it every ~5s while orders
//    rest; a lapse cancels all resting orders venue-side.

import {
  buildHmacSignature,
  createPublicClient as createPmPublicClient,
  createSecureClient,
  forkEnvironmentConfig,
  production,
  relayerApiKey,
  OrderSide as PmOrderSide,
  OrderType as PmOrderType,
  UnexpectedResponseError,
  type ApiKeyAuthorization,
  type AssetType,
  type EnvironmentContracts,
  type MarketInfo,
} from "@polymarket/client";
import { createHash } from "node:crypto";
import { RequestBudget } from "./request-budget.js";
import { installPolymarketUserAgent } from "./polymarket-user-agent.js";

/**
 * Which token is the YES side of a binary market. Polymarket labels most markets
 * "Yes"/"No"; a matchup such as "Sabalenka vs Rybakina" labels its two tokens with
 * the names instead, and the first listed outcome is the one the question, Quotient's
 * forecast, and every published signal call YES.
 */
export function outcomeTokensOf(tokens: ReadonlyArray<{ tokenId: string | number | bigint; outcome: string }>): { yes: string; no: string } {
  const label = (token: { outcome: string }): string => token.outcome.trim().toLowerCase();
  const yes = tokens.find((token) => label(token) === "yes");
  const no = tokens.find((token) => label(token) === "no");
  if (yes && no) return { yes: String(yes.tokenId), no: String(no.tokenId) };
  if (tokens.length === 2 && !yes && !no) return { yes: String(tokens[0]!.tokenId), no: String(tokens[1]!.tokenId) };
  throw new Error(`market outcomes ${tokens.map((token) => JSON.stringify(token.outcome)).join(", ")} do not form a YES/NO pair`);
}

// AssetType is exported as a type but not as a runtime value from the SDK's
// ESM entry (verified 2026-08-13); use the literal values.
const COLLATERAL = "COLLATERAL" as AssetType;
const CONDITIONAL = "CONDITIONAL" as AssetType;
/** pUSD on Polygon — fallback when the client doesn't expose its environment. */
const PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
/**
 * Venue limit: 50 balance-allowance updates per 10 s (docs.polymarket.com rate limits,
 * verified 2026-09-09). Keep headroom for a second bot on the same address, and hold
 * back a reserve so exit sizing is never starved by opportunistic refreshes.
 */
const BALANCE_REFRESH_WINDOW = { capacity: 40, windowMs: 10_000, reserve: 10 } as const;
/** A token's CLOB balance is re-synced from chain at most this often unless a caller insists. */
const TOKEN_BALANCE_REFRESH_MS = 30_000;
/** Duplicate account reads inside one supervision pass share a single request. */
const ACCOUNT_READ_MEMO_MS = 3_000;
interface AccountReadMemo<T> { at: number; value?: T; pending?: Promise<T> }
function accountRequestBudget(): RequestBudget {
  const budget = new RequestBudget();
  budget.window("balance-allowance:update", BALANCE_REFRESH_WINDOW);
  return budget;
}

/**
 * Quotient's Polymarket builder code. Every order cassie signs carries it, so
 * the exchange collects Quotient's builder fee alongside its own and pays it
 * to the builder profile wallet on Polygon. The code is part of the signed V2
 * order struct; the rates themselves live on the builder profile at
 * polymarket.com → Settings → Builders and must match the constants below.
 *
 * `CASSIE_POLYMARKET_BUILDER_CODE` overrides it; `off` disables attribution
 * (tests, staging).
 */
export const QUOTIENT_POLYMARKET_BUILDER_CODE: `0x${string}` | undefined =
  "0xcac5e27895aaa1962bee7a0d3103a18ea2ac8714ae8b9ae916855bcca9fabc82";

/** Builder fee in basis points of notional, per fill side. Polymarket caps maker at 50 and taker at 100. */
export const QUOTIENT_POLYMARKET_BUILDER_FEE_BPS = { maker: 50, taker: 50 } as const;
export type PolymarketFeeMode = keyof typeof QUOTIENT_POLYMARKET_BUILDER_FEE_BPS;

/** The fill side a bot's execution mode produces: adaptive posts maker orders, legacy crosses as a taker. */
export function polymarketFeeMode(executionMode: "adaptive" | "legacy" | undefined): PolymarketFeeMode {
  return executionMode === "legacy" ? "taker" : "maker";
}

export function describePolymarketBuilderFee(mode: PolymarketFeeMode): string {
  const pct = (bps: number) => `${bps / 100}%`;
  const other: PolymarketFeeMode = mode === "maker" ? "taker" : "maker";
  return `${pct(QUOTIENT_POLYMARKET_BUILDER_FEE_BPS[mode])} of notional per ${mode} fill, ` +
    `${pct(QUOTIENT_POLYMARKET_BUILDER_FEE_BPS[other])} per ${other} fill; collected by Polymarket as a builder fee`;
}

export const QUOTIENT_POLYMARKET_FEE_DISCLOSURE =
  `Quotient charges ${QUOTIENT_POLYMARKET_BUILDER_FEE_BPS.maker / 100}% of notional on each Polymarket fill, collected by Polymarket as a builder fee.`;

const BUILDER_CODE_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** The builder code in force: the environment override, else the compiled constant; `off` means none. */
export function polymarketBuilderCode(env: NodeJS.ProcessEnv = process.env): `0x${string}` | undefined {
  const override = env.CASSIE_POLYMARKET_BUILDER_CODE?.trim();
  if (override) {
    if (override.toLowerCase() === "off") return undefined;
    if (!BUILDER_CODE_PATTERN.test(override)) throw new Error("CASSIE_POLYMARKET_BUILDER_CODE must be a 32-byte 0x-prefixed hex string, or off");
    return override as `0x${string}`;
  }
  return QUOTIENT_POLYMARKET_BUILDER_CODE;
}

// Public Polygon RPCs for read-only approval verification. Ordered fallback:
// a dead endpoint moves to the next, and a total outage degrades to "cannot
// verify" (treated as unapproved so the flow errs on the side of retrying).
const PUBLIC_POLYGON_RPCS = ["https://polygon-rpc.com", "https://1rpc.io/matic", "https://polygon-bor-rpc.publicnode.com"];

/** ERC-1155 isApprovedForAll(owner, operator), read from the chain itself. */
async function isApprovedForAllOnChain(
  token: string,
  owner: string,
  operator: string,
  rpc?: string,
): Promise<boolean> {
  const pad = (addr: string) => addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const data = "0xe985e9c5" + pad(owner) + pad(operator); // isApprovedForAll(address,address)
  // A configured RPC goes first: the public ones are rate-limited, and some
  // networks cannot complete a TLS handshake with them at all.
  for (const endpoint of rpc ? [rpc, ...PUBLIC_POLYGON_RPCS] : PUBLIC_POLYGON_RPCS) {
    try {
      const res = (await (
        await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, "latest"] }),
        })
      ).json()) as { result?: string };
      if (typeof res.result === "string") return BigInt(res.result) === 1n;
    } catch {
      // fall through to the next RPC
    }
  }
  return false;
}

async function pollUntil(check: () => Promise<boolean>, opts: { attempts: number; delayMs: number }): Promise<boolean> {
  for (let i = 0; i < opts.attempts; i++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
  }
  return check();
}

import {
  fetchBalanceAllowance,
  fetchMarketInfo,
  fetchTransaction,
  resolveConditionByToken,
  updateBalanceAllowance,
} from "@polymarket/client/actions";
import { builderApiKey } from "@polymarket/client/node";
import { privateKey } from "@polymarket/client/viem";
import type {
  AwaitFundingOpts,
  Balance,
  Fill,
  FundingInstructions,
  Order,
  OrderAck,
  OrderBook,
  OrderIntent,
  OrderLifecycleHooks,
  PredictionExecutionMarket,
  PredictionOrderState,
  Position,
  Quote,
  RedemptionReceipt,
  RedemptionHooks,
  RealtimeSubscription,
  RuntimeCreds,
  SetupContext,
  VenueAccount,
  VenueAdapter,
  TokenBalanceOptions,
} from "../types.js";
import { registerAdapter, type AdapterOpts } from "./registry.js";
import { parsePolymarketGaslessAuth, QUOTIENT_POLYMARKET_GASLESS_AUTH, type PolymarketGaslessAuth } from "../polymarket/gasless-auth.js";

type PmSecureClient = Awaited<ReturnType<typeof createSecureClient>>;
type PmPublicClient = ReturnType<typeof createPmPublicClient>;
type PmSignedOrder = Awaited<ReturnType<PmSecureClient["createLimitOrder"]>>;
type PmCreds = Extract<RuntimeCreds, { venue: "polymarket" }>;
type PmAccount = Extract<VenueAccount, { venue: "polymarket" }>;

/** Keystore role for gasless service auth; directional deploys also receive it via private stdin. */
export const GASLESS_AUTH_ROLE = "polymarket-gasless";

/** Only explicit venue rejection proves that a prepared order was not accepted. */
export class PolymarketOrderRejectedError extends Error {
  readonly submissionRejected = true;
  readonly postOnlyRejected: boolean;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PolymarketOrderRejectedError";
    this.postOnlyRejected = /post.?only|invalid_post_only_order/i.test(message);
  }
}

type GaslessAuthDesc = PolymarketGaslessAuth;

function apiKeyFromDesc(desc: GaslessAuthDesc): ApiKeyAuthorization {
  return desc.kind === "relayer"
    ? relayerApiKey({ key: desc.key, address: desc.address })
    : builderApiKey({ key: desc.key, secret: desc.secret, passphrase: desc.passphrase });
}

function asPmAccount(acct: VenueAccount): PmAccount {
  if (acct.venue !== "polymarket") throw new Error(`polymarket adapter got account for venue ${acct.venue}`);
  return acct;
}

export class PolymarketAdapter implements VenueAdapter {
  readonly id = "polymarket" as const;
  readonly verifiedAgainst = "2026-09-08";
  readonly supportsNativeTriggers = false;

  private creds?: PmCreds;
  private secureClient?: PmSecureClient;
  private publicClient?: PmPublicClient;
  /** heartbeat_id chain for the CLOB dead man's switch. */
  private heartbeatId = "";
  private readonly tokenToCondition = new Map<string, string>();
  private readonly conditionInfo = new Map<string, MarketInfo>();
  private readonly conditionalAllowanceSynced = new Set<string>();
  private volumeCache = new Map<string, { v: number; at: number }>();
  private readonly eventRefCache = new Map<string, string>();
  /** Attached to every signed order; undefined only when attribution is off. */
  readonly builderCode: `0x${string}` | undefined;
  private builderCodeWarned = false;
  /** Local request budget: family cooldowns after an explicit 429, plus the balance-refresh window. */
  private readonly budget = accountRequestBudget();
  private readonly tokenRefreshAt = new Map<string, number>();
  private readonly positionsMemo: AccountReadMemo<Position[]> = { at: 0 };
  private readonly collateralMemo: AccountReadMemo<number> = { at: 0 };

  constructor(private readonly opts: AdapterOpts) {
    installPolymarketUserAgent();
    if (opts.creds && opts.creds.venue === "polymarket") this.creds = opts.creds;
    this.builderCode = polymarketBuilderCode();
  }

  /** Quotient's builder fee on one fill, in USD; zero when attribution is off. */
  builderFeeFor(mode: PolymarketFeeMode, size: number, price: number): number {
    if (!this.builderCode) return 0;
    return size * price * (QUOTIENT_POLYMARKET_BUILDER_FEE_BPS[mode] / 10_000);
  }

  private get urls() {
    return this.opts.urls.polymarket;
  }

  /**
   * The SDK talks to its own hardcoded Polygon RPC unless handed an environment.
   * Forking production onto a configured RPC keeps every chain read and
   * transaction wait on an endpoint the operator controls.
   */
  private get environment(): { environment: ReturnType<typeof forkEnvironmentConfig> } | Record<string, never> {
    const rpc = this.urls.rpc;
    if (!rpc) return {};
    this.forkedEnvironment ??= forkEnvironmentConfig({ name: "production", rpc });
    return { environment: this.forkedEnvironment };
  }

  private forkedEnvironment?: ReturnType<typeof forkEnvironmentConfig>;

  private pub(): PmPublicClient {
    this.publicClient ??= createPmPublicClient({ ...this.environment });
    return this.publicClient;
  }

  private async secure(): Promise<PmSecureClient> {
    if (this.secureClient) return this.secureClient;
    if (!this.creds) {
      throw new Error("polymarket: no runtime credentials — run `cassie init`/`cassie fund` first");
    }
    this.secureClient = await createSecureClient({
      ...this.environment,
      signer: privateKey(this.creds.signerPk),
      wallet: this.creds.funder,
      apiKey: apiKeyFromDesc(this.opts.polymarketGaslessAuth ?? QUOTIENT_POLYMARKET_GASLESS_AUTH),
      credentials: {
        key: this.creds.l2.apiKey,
        secret: this.creds.l2.secret,
        passphrase: this.creds.l2.passphrase,
      } as never,
    });
    return this.secureClient;
  }

  // -------------------------------------------------------------------------
  // Setup (§5.1 provisioning paths) and funding (§6)
  // -------------------------------------------------------------------------

  async setup(ctx: SetupContext): Promise<VenueAccount> {
    const pk = await ctx.getSecret("master");
    if (!pk) throw new Error("no master key in keystore — run `cassie wallet create <botId>` first");

    const path = ctx.select
      ? await ctx.select("Polymarket account", [
        { value: "create", title: "Create account" },
        { value: "connect", title: "Connect existing account" },
      ])
      : (await ctx.ask("Account (create/connect)", { default: "create" })).trim().toLowerCase();

    let wallet: string | undefined;
    const savedAuth = (await ctx.getOperatorDefault?.("polymarket-builder")) ?? await ctx.getSecret(GASLESS_AUTH_ROLE);
    const gaslessAuth = savedAuth ? parsePolymarketGaslessAuth(savedAuth) : QUOTIENT_POLYMARKET_GASLESS_AUTH;
    if (path === "connect") {
      wallet = (await ctx.ask("Wallet address (polymarket.com profile)")).trim();
    }
    const apiKey = apiKeyFromDesc(gaslessAuth);
    // Retain the selected service auth for subsequent funding and withdrawals.
    await ctx.putSecret(GASLESS_AUTH_ROLE, JSON.stringify(gaslessAuth), { runtimeEligible: false });

    ctx.print("Connecting Polymarket…");
    const client = await createSecureClient({
      ...this.environment,
      signer: privateKey(pk),
      ...(wallet ? { wallet } : {}),
      apiKey,
    });
    this.secureClient = client;

    const account = client.account;
    ctx.print("Trading wallet");
    ctx.print(account.wallet);

    // L2 creds (HMAC key/secret/passphrase) — runtime-eligible.
    const l2 = client.credentials;
    const credsJson: PmCreds = {
      venue: "polymarket",
      signerPk: pk,
      funder: account.wallet,
      signatureType: 3,
      l2: { apiKey: String(l2.key), secret: l2.secret, passphrase: l2.passphrase },
    };
    this.creds = credsJson;
    await ctx.putSecret("polymarket-l2", JSON.stringify(credsJson.l2), { runtimeEligible: true });

    // The wallet is not ready to trade until every current Polymarket spender
    // is approved. Do this during account setup, even when the operator elects
    // to fund later.
    ctx.print("Approving trading…");
    await this.ensureTradingApprovals(ctx, client);

    // Geoblock: surface the answer during setup, nothing more (§5.1).
    // The check lives on polymarket.com, not the API servers (verified 2026-08-13).
    try {
      const res = await fetch("https://polymarket.com/api/geoblock");
      const g = (await res.json()) as { blocked?: boolean; country?: string; region?: string };
      ctx.print(
        g.blocked
          ? `Trading blocked in ${g.country}${g.region ? "/" + g.region : ""}.`
          : `Trading permitted in ${g.country ?? "unknown location"}.`,
      );
    } catch (err) {
      ctx.print(`geoblock check skipped (${(err as Error).message})`);
    }

    return {
      venue: "polymarket",
      signerAddress: account.signer,
      funder: account.wallet,
      signatureType: 3,
    };
  }

  async fundingInstructions(acct: VenueAccount): Promise<FundingInstructions> {
    const a = asPmAccount(acct);
    const bridged = await this.requestBridgeAddresses(a.funder);
    const minimum = await this.bridgeMinimum();
    return {
      venue: "polymarket",
      addresses: Object.entries(bridged).map(([chain, address]) => ({
        chain,
        address,
        asset: "USDC",
        minimum,
        note: chain === "evm" ? "Use a supported EVM network." : undefined,
      })),
      summary: `Send at least ${minimum} USDC on a supported network.\nOver $50,000: use a third-party bridge to Polygon USDC.`,
    };
  }

  private async requestBridgeAddresses(funder: string): Promise<Record<string, string>> {
    const res = await fetch(`${this.urls.bridge}/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: funder }),
    });
    if (!res.ok) throw new Error(`bridge /deposit ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as Record<string, unknown>;
    const container = (data.addresses ?? data.address ?? data) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const chain of ["evm", "svm", "btc", "tron"]) {
      const v = container[chain];
      if (typeof v === "string") out[chain] = v;
      else if (v && typeof v === "object" && typeof (v as { address?: string }).address === "string") {
        out[chain] = (v as { address: string }).address;
      }
    }
    if (Object.keys(out).length === 0) {
      throw new Error(`bridge /deposit returned no recognizable addresses: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return out;
  }

  private async bridgeMinimum(): Promise<number> {
    try {
      const res = await fetch(`${this.urls.bridge}/supported-assets`);
      if (!res.ok) return 2;
      const data = (await res.json()) as unknown;
      const list = Array.isArray(data) ? data : ((data as { assets?: unknown[] }).assets ?? []);
      const usdc = (list as { symbol?: string; minimum?: number | string; minDeposit?: number | string }[]).find(
        (a) => a.symbol?.toUpperCase().includes("USDC"),
      );
      const min = Number(usdc?.minimum ?? usdc?.minDeposit);
      return Number.isFinite(min) && min > 0 ? min : 2;
    } catch {
      return 2;
    }
  }

  async awaitFunding(acct: VenueAccount, opts: AwaitFundingOpts = {}): Promise<Balance> {
    const a = asPmAccount(acct);
    const startBal = await this.collateralBalance().catch(() => 0);
    const interval = opts.intervalMs ?? 15_000;
    const deadline = Date.now() + (opts.timeoutMs ?? 45 * 60_000);
    for (;;) {
      const bal = await this.collateralBalance().catch(() => 0);
      if (bal > startBal + 0.01) return { asset: "pUSD", total: bal, available: bal };
      // Best-effort progress from the bridge status endpoint.
      if (opts.onPoll) {
        const status = await this.bridgeStatus(a).catch(() => null);
        opts.onPoll(status ?? `balance ${bal.toFixed(2)} pUSD — waiting for deposit…`);
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for Polymarket deposit");
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  private async bridgeStatus(a: PmAccount): Promise<string | null> {
    const addr = a.bridgeAddresses?.evm;
    if (!addr) return null;
    const res = await fetch(`${this.urls.bridge}/status/${addr}`);
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as unknown;
    return body ? JSON.stringify(body).slice(0, 200) : null;
  }

  async runFundingFlow(ctx: SetupContext, acct: VenueAccount): Promise<VenueAccount> {
    let a = asPmAccount(acct);
    await this.ensureCredsFromKeystore(ctx, a);
    // Capture before showing the deposit address so a top-up cannot be
    // mistaken for the bot's already-existing collateral.
    const before = await this.collateralBalance().catch(() => 0);

    const bridged = await this.requestBridgeAddresses(a.funder);
    a = { ...a, bridgeAddresses: bridged };
    const minimum = await this.bridgeMinimum();
    ctx.print("");
    ctx.print(`Send at least ${minimum} USDC on a supported EVM network.`);
    ctx.print("Over $50,000: use a third-party bridge to Polygon USDC.");
    ctx.print("");
    ctx.print(bridged.evm!);
    ctx.print("");

    const checkForCredit = async (): Promise<number | null> => {
      const bal = await this.collateralBalance().catch(() => 0);
      return bal > before + 0.01 ? bal : null;
    };
    // Interactive hosts expose a Skip action while polling. Keep the existing
    // poll as a compatibility fallback for headless/test SetupContext hosts.
    const after = ctx.pollSkippable
      ? await ctx.pollSkippable("waiting for bridge credit", checkForCredit)
      : await ctx.poll("waiting for bridge credit", checkForCredit);
    if (after === null) {
      const current = await this.collateralBalance().catch(() => before);
      ctx.print("Deposit polling skipped.");
      ctx.print(`Balance: ${current.toFixed(2)} pUSD.`);
    } else {
      ctx.print(`Deposit credited: ${(after - before).toFixed(2)} pUSD.`);
      ctx.print(`Balance: ${after.toFixed(2)} pUSD.`);
    }

    const client = await this.gaslessClient(ctx, a);
    ctx.print("Approving trading…");
    await this.ensureTradingApprovals(ctx, client);
    ctx.print("Funding complete.");
    return a;
  }

  /**
   * Apply and verify the complete production approval set.
   *
   * @polymarket/client 0.6.0's setupTradingApprovals currently omits the
   * Neg Risk Adapter from its ERC-20 approvals even though the CLOB can route
   * BUY collateral through it. Keep the SDK-owned approval set, then repair
   * and verify that omission explicitly until the pinned SDK is upgraded and
   * re-verified.
   */
  private async ensureTradingApprovals(ctx: SetupContext, client: PmSecureClient): Promise<void> {
    await client.setupTradingApprovals();

    // The SDK's public EnvironmentConfig type currently hides `contracts`,
    // although the production value carries the typed contract registry.
    const { collateralToken, negRiskAdapter, conditionalTokens } = (
      production as unknown as { contracts: EnvironmentContracts & { conditionalTokens: string } }
    ).contracts;
    let allowance = await this.syncCollateralAllowance(client, negRiskAdapter);
    if (allowance === 0n) {
      ctx.print("Approving collateral…");
      const handle = await client.approveErc20({
        amount: "max",
        spenderAddress: negRiskAdapter,
        tokenAddress: collateralToken,
      });
      await handle.wait();
      allowance = await this.syncCollateralAllowance(client, negRiskAdapter);
    }

    if (allowance === 0n) {
      throw new Error(`polymarket: Neg Risk Adapter approval was not applied for wallet ${client.account.wallet}`);
    }

    // SELLs hand position tokens to the exchange, which needs an ERC-1155
    // setApprovalForAll on the CTF. setupTradingApprovals has been observed
    // (2026-08-17) returning success without landing it on-chain, which lets
    // a bot buy for days and then fail its first exit. Submit it explicitly
    // and verify against the chain itself — not a venue-side cache — before
    // declaring the flow complete.
    const wallet = client.account.wallet;
    if (!(await isApprovedForAllOnChain(conditionalTokens, wallet, negRiskAdapter, this.urls.rpc))) {
      ctx.print("Approving sells…");
      const handle = await client.approveErc1155ForAll({
        operatorAddress: negRiskAdapter,
        tokenAddress: conditionalTokens,
        approved: true,
      });
      await handle.wait();
      // The relayer has been observed acking transactions that never mine;
      // poll the chain until the approval is real.
      const confirmed = await pollUntil(
        () => isApprovedForAllOnChain(conditionalTokens, wallet, negRiskAdapter, this.urls.rpc),
        { attempts: 12, delayMs: 10_000 },
      );
      if (!confirmed) {
        throw new Error(
          `polymarket: CTF operator approval for ${negRiskAdapter} did not confirm on-chain for wallet ${wallet}. ` +
            "Sells will be rejected with allowance errors until it lands — re-run `cassie fund <botId>` to retry.",
        );
      }
    }
    ctx.print("Trading approvals verified.");
  }

  /** Refresh the CLOB cache and return one spender's collateral allowance. */
  private async syncCollateralAllowance(client: PmSecureClient, spender: string): Promise<bigint> {
    const result = await updateBalanceAllowance(client, { assetType: COLLATERAL });
    const match = Object.entries(result.allowances).find(([address]) => address.toLowerCase() === spender.toLowerCase());
    return BigInt(match?.[1] ?? "0");
  }

  /** Secure client carrying the operator's relayer/builder key for gasless ops. */
  private async gaslessClient(ctx: SetupContext, a: PmAccount): Promise<PmSecureClient> {
    await this.ensureCredsFromKeystore(ctx, a);
    const gaslessRaw = (await ctx.getOperatorDefault?.("polymarket-builder")) ?? await ctx.getSecret(GASLESS_AUTH_ROLE);
    if (!gaslessRaw) return this.secure();
    return createSecureClient({
      ...this.environment,
      signer: privateKey(this.creds!.signerPk),
      wallet: a.funder,
      apiKey: apiKeyFromDesc(parsePolymarketGaslessAuth(gaslessRaw)),
      credentials: {
        key: this.creds!.l2.apiKey,
        secret: this.creds!.l2.secret,
        passphrase: this.creds!.l2.passphrase,
      } as never,
    });
  }

  /**
   * Withdraw pUSD from the Deposit Wallet to an external address — a gasless
   * relayer op, so it needs the operator's Builder/Relayer key from setup.
   */
  async withdraw(ctx: SetupContext, acct: VenueAccount, params: { to: string; amount: number | "all" }): Promise<string> {
    const a = asPmAccount(acct);
    const client = await this.gaslessClient(ctx, a);
    const res = await fetchBalanceAllowance(client, { assetType: COLLATERAL });
    const balanceUnits = BigInt(res.balance);
    const amountUnits = params.amount === "all" ? balanceUnits : BigInt(Math.round(params.amount * 1e6));
    if (amountUnits <= 0n) throw new Error("nothing to withdraw");
    if (amountUnits > balanceUnits) {
      throw new Error(`insufficient balance: ${Number(balanceUnits) / 1e6} pUSD available`);
    }
    const tokenAddress =
      (client as { environment?: { contracts?: { collateralToken?: string } } }).environment?.contracts
        ?.collateralToken ?? PUSD_ADDRESS;
    const handle = await client.transferErc20({
      amount: amountUnits,
      recipientAddress: params.to,
      tokenAddress,
    } as never);
    const outcome = await handle.wait();
    return `sent ${Number(amountUnits) / 1e6} pUSD to ${params.to} — tx ${outcome.transactionHash}`;
  }

  /** During wizard flows the runtime creds may not exist yet; build them from the keystore. */
  private async ensureCredsFromKeystore(ctx: SetupContext, a: PmAccount): Promise<void> {
    if (this.creds) return;
    const pk = await ctx.getSecret("master");
    if (!pk) throw new Error("no master key in keystore");
    const l2raw = await ctx.getSecret("polymarket-l2");
    if (l2raw) {
      this.creds = { venue: "polymarket", signerPk: pk, funder: a.funder, signatureType: a.signatureType, l2: JSON.parse(l2raw) };
      return;
    }
    const client = await createSecureClient({ ...this.environment, signer: privateKey(pk), wallet: a.funder });
    this.secureClient = client;
    const l2 = client.credentials;
    this.creds = {
      venue: "polymarket",
      signerPk: pk,
      funder: a.funder,
      signatureType: a.signatureType,
      l2: { apiKey: String(l2.key), secret: l2.secret, passphrase: l2.passphrase },
    };
    await ctx.putSecret("polymarket-l2", JSON.stringify(this.creds.l2), { runtimeEligible: true });
  }

  // -------------------------------------------------------------------------
  // Read methods
  // -------------------------------------------------------------------------

  /** Share one in-flight account read and reuse it briefly; the executor never sizes a SELL from these. */
  private memoized<T>(memo: AccountReadMemo<T>, read: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (memo.pending) return memo.pending;
    if (memo.value !== undefined && now - memo.at <= ACCOUNT_READ_MEMO_MS) return Promise.resolve(memo.value);
    const pending = read().then(
      (value) => { memo.at = now; memo.value = value; memo.pending = undefined; return value; },
      (error: unknown) => { memo.pending = undefined; throw error; },
    );
    memo.pending = pending;
    return pending;
  }

  private collateralBalance(): Promise<number> {
    return this.memoized(this.collateralMemo, async () => {
      const client = await this.secure();
      const res = await this.budget.run("balance-allowance", () => fetchBalanceAllowance(client, { assetType: COLLATERAL }));
      return Number(res.balance) / 1e6; // pUSD, 6 decimals
    });
  }

  async balances(_acct: VenueAccount): Promise<Balance[]> {
    const bal = await this.collateralBalance();
    return [{ asset: "pUSD", total: bal, available: bal }];
  }

  /** Authoritative CLOB token balance; resting SELL reservations are not deducted. */
  async tokenBalance(acct: VenueAccount, tokenId: string, opts: TokenBalanceOptions = {}): Promise<number> {
    asPmAccount(acct);
    if (!tokenId.trim()) throw new Error("polymarket token balance requires a token id");
    const client = await this.secure();
    const request = { assetType: CONDITIONAL, tokenId };
    // The CLOB caches chain balances. Re-sync before the first read of a token, when the
    // last sync is old, or when the caller needs authoritative capacity (exit sizing).
    // Opportunistic refreshes never enter the priority reserve of the venue's update limit.
    const now = Date.now();
    const last = this.tokenRefreshAt.get(tokenId);
    let refresh = false;
    if (opts.refresh) { this.budget.acquire("balance-allowance:update", { priority: true }); refresh = true; }
    else if (last === undefined) refresh = this.budget.tryAcquire("balance-allowance:update", { priority: true });
    else if (now - last >= TOKEN_BALANCE_REFRESH_MS) refresh = this.budget.tryAcquire("balance-allowance:update");
    if (refresh) {
      // Failure cannot fall back to a potentially stale token balance.
      await this.budget.run("balance-allowance", () => updateBalanceAllowance(client, request));
      this.tokenRefreshAt.set(tokenId, now);
    }
    const result = await this.budget.run("balance-allowance", () => fetchBalanceAllowance(client, request));
    const balance = Number(result.balance) / 1e6;
    if (!Number.isFinite(balance) || balance < 0) throw new Error(`invalid Polymarket balance for token ${tokenId}`);
    return balance;
  }

  /** A confirmed fill changed this token's inventory; the next read re-syncs the CLOB balance. */
  invalidateTokenBalance(tokenId: string): void {
    this.tokenRefreshAt.delete(tokenId);
  }

  private async marketInfoForToken(tokenId: string): Promise<{ conditionId: string; info: MarketInfo }> {
    let conditionId = this.tokenToCondition.get(tokenId);
    if (!conditionId) {
      // resolveConditionByToken returns the ConditionId string directly.
      conditionId = String(await resolveConditionByToken(this.pub(), { tokenId }));
      this.tokenToCondition.set(tokenId, conditionId);
    }
    const cached = this.conditionInfo.get(conditionId);
    if (cached) return { conditionId, info: cached };
    const info = await fetchMarketInfo(this.pub(), { conditionId });
    this.conditionInfo.set(conditionId, info);
    for (const t of info.tokens) this.tokenToCondition.set(String(t.tokenId), conditionId);
    return { conditionId, info };
  }

  private yesTokenOf(info: MarketInfo): string { return outcomeTokensOf(info.tokens).yes; }

  /** Resolve the tradable token for (marketRef = YES token, outcome). */
  private async tokenFor(marketRef: string, outcome: "YES" | "NO" | undefined): Promise<string> {
    if (outcome !== "NO") return marketRef;
    const { info } = await this.marketInfoForToken(marketRef);
    return outcomeTokensOf(info.tokens).no;
  }

  /** Validate an explicit token against the market's condition and outcome. */
  private async tokenForIntent(intent: OrderIntent): Promise<{ tokenId: string; conditionId: string; info: MarketInfo }> {
    const tokenId = intent.tokenId ?? (await this.tokenFor(intent.marketRef, intent.outcome));
    const { conditionId, info } = await this.marketInfoForToken(tokenId);
    const yesRef = this.yesTokenOf(info);
    if (yesRef !== intent.marketRef) {
      throw new Error(`token ${tokenId} does not belong to YES marketRef ${intent.marketRef}`);
    }
    if (intent.conditionId && intent.conditionId.toLowerCase() !== conditionId.toLowerCase()) {
      throw new Error(`token ${tokenId} condition ${conditionId} does not match ${intent.conditionId}`);
    }
    if (intent.outcome) {
      const sides = outcomeTokensOf(info.tokens);
      if (tokenId !== (intent.outcome === "YES" ? sides.yes : sides.no)) {
        throw new Error(`token ${tokenId} is not the ${intent.outcome} side of its market`);
      }
    }
    return { tokenId, conditionId, info };
  }

  /** Map any outcome token back to its market's YES-token marketRef. */
  private async yesRefOf(tokenId: string): Promise<{ marketRef: string; isYes: boolean }> {
    const { info } = await this.marketInfoForToken(tokenId);
    const yesRef = this.yesTokenOf(info);
    return { marketRef: yesRef, isYes: yesRef === tokenId };
  }

  positions(_acct: VenueAccount): Promise<Position[]> {
    return this.memoized(this.positionsMemo, () => this.readPositions());
  }

  private async readPositions(): Promise<Position[]> {
    const client = await this.secure();
    const out: Position[] = [];
    // One request covers the account (schema maximum 500 rows); the data API allows 150 per 10 s.
    const rows = await this.budget.run("positions", async () => {
      const items: Awaited<ReturnType<ReturnType<PmSecureClient["listPositions"]>["firstPage"]>>["items"] = [];
      for await (const page of client.listPositions({ sizeThreshold: 0, pageSize: 500 })) items.push(...page.items);
      return items;
    });
    {
      for (const p of rows) {
        const size = Number(p.size ?? 0);
        if (!p.tokenId || size <= 0) continue;
        const tokenId = String(p.tokenId);
        // The SDK position record carries the condition, explicit outcome and
        // sibling token. Closed books must not make the whole account unreadable.
        let conditionId = String(p.conditionId ?? "");
        let explicit = p.outcome?.trim().toUpperCase();
        let marketRef = explicit === "YES" ? tokenId :
          explicit === "NO" && p.oppositeOutcome?.trim().toUpperCase() === "YES" && p.oppositeTokenId ? String(p.oppositeTokenId) : undefined;
        if (!conditionId || !marketRef) {
          const resolved = await this.marketInfoForToken(tokenId);
          conditionId = resolved.conditionId;
          explicit = resolved.info.tokens.find((token) => String(token.tokenId) === tokenId)?.outcome.trim().toUpperCase();
          marketRef = this.yesTokenOf(resolved.info);
        }
        if (explicit !== "YES" && explicit !== "NO") continue;
        const outcome = explicit;
        for (const ref of [tokenId, marketRef]) {
          const known = this.tokenToCondition.get(ref);
          if (known && known !== conditionId) throw new Error("Polymarket position condition changed for a known token");
          this.tokenToCondition.set(ref, conditionId);
        }
        const reportedCurrentPrice = p.curPrice == null ? undefined : Number(p.curPrice);
        const currentPrice = reportedCurrentPrice !== undefined && Number.isFinite(reportedCurrentPrice)
          ? reportedCurrentPrice
          : undefined;
        out.push({
          marketRef,
          tokenId,
          conditionId,
          outcome,
          side: outcome,
          size,
          avgPrice: Number(p.avgPrice ?? 0),
          currentPrice,
          unrealizedPnl: currentPrice === undefined ? undefined : (currentPrice - Number(p.avgPrice ?? 0)) * size,
          redeemable: p.redeemable ?? undefined,
          label: (p as { title?: string | null }).title ?? undefined,
        });
      }
    }
    return out;
  }

  async book(marketRef: string): Promise<OrderBook> {
    const ob = await this.budget.run("book", () => this.pub().fetchOrderBook({ tokenId: marketRef }));
    const toNum = (l: { price: string; size: string }) => ({ price: Number(l.price), size: Number(l.size) });
    return {
      marketRef,
      // SDK returns bids ascending / asks descending; normalize to best-first.
      bids: ob.bids.map(toNum).sort((x, y) => y.price - x.price),
      asks: ob.asks.map(toNum).sort((x, y) => x.price - y.price),
      // The CLOB timestamp is the book’s last change, not the read: a quiet
      // market can carry a minutes-old value while the venue’s clock can also
      // run slightly ahead of ours. Freshness gates need the observation time.
      ts: Date.now(),
      ...(ob.timestamp === undefined || ob.timestamp === null ? {} : { venueTs: Number(ob.timestamp) }),
    };
  }

  async tokenBook(tokenId: string): Promise<OrderBook> {
    return this.book(tokenId);
  }

  /** Read the selected outcome and current constraints together; never mirror the sibling book. */
  async executionMarket(marketRef: string, outcome: "YES" | "NO"): Promise<PredictionExecutionMarket> {
    const tokenId = await this.tokenFor(marketRef, outcome);
    const { conditionId, info } = await this.marketInfoForToken(tokenId);
    const sides = outcomeTokensOf(info.tokens);
    if (sides.yes !== marketRef || tokenId !== (outcome === "YES" ? sides.yes : sides.no)) {
      throw new Error("Polymarket execution token does not match the requested market and outcome");
    }
    const url = new URL("/markets", this.urls.gamma);
    url.searchParams.set("clob_token_ids", marketRef);
    const [{ raw, bookObservedAt }, { markets, metadataObservedAt }] = await Promise.all([
      this.budget.run("book", async () => { const raw = await this.pub().fetchOrderBook({ tokenId }); return { raw, bookObservedAt: Date.now() }; }),
      this.budget.run("gamma", async () => {
        const response = await fetch(url, { headers: { accept: "application/json" } });
        if (!response.ok) {
          throw Object.assign(new Error(`Polymarket execution market metadata unavailable (${response.status})`), { status: response.status });
        }
        const markets = await response.json() as Array<{ acceptingOrders?: boolean; volume24hr?: string | number }>;
        return { markets, metadataObservedAt: Date.now() };
      }),
    ]);
    if (!Array.isArray(markets) || markets.length !== 1) throw new Error("Polymarket execution market metadata is ambiguous");
    if (String(raw.tokenId) !== tokenId || String(raw.conditionId).toLowerCase() !== conditionId.toLowerCase()) {
      throw new Error("Polymarket execution book identity does not match the selected token");
    }
    const tickSize = Number(raw.tickSize);
    const minOrderSize = Number(raw.minOrderSize);
    if (!(tickSize > 0 && tickSize < 1) || !Number.isFinite(minOrderSize) || minOrderSize <= 0) {
      throw new Error("Polymarket execution book has invalid trading constraints");
    }
    // A slow metadata request cannot refresh the age of an already-returned book.
    const observedAt = Math.min(bookObservedAt, metadataObservedAt);
    const level = (row: { price: string; size: string }) => ({ price: Number(row.price), size: Number(row.size) });
    const book: OrderBook = {
      marketRef, bids: raw.bids.map(level).sort((a, b) => b.price - a.price),
      asks: raw.asks.map(level).sort((a, b) => a.price - b.price), ts: bookObservedAt,
      ...(raw.timestamp == null ? {} : { venueTs: Number(raw.timestamp) }),
    };
    if ([...book.bids, ...book.asks].some((row) => !(row.price > 0 && row.price < 1) || !Number.isFinite(row.size) || row.size < 0)) {
      throw new Error("Polymarket execution book contains invalid levels");
    }
    const bid = book.bids[0]?.price ?? 0;
    const ask = book.asks[0]?.price ?? 1;
    const mid = (bid + ask) / 2;
    const volume24h = Number(markets[0]!.volume24hr ?? 0);
    return {
      marketRef, conditionId, tokenId, outcome, tickSize, minOrderSize,
      acceptingOrders: markets[0]!.acceptingOrders === true, observedAt, book,
      quote: { marketRef, bid, ask, mid, volume24h: Number.isFinite(volume24h) ? volume24h : 0,
        spreadBps: mid > 0 ? (ask - bid) / mid * 10_000 : 0, ts: bookObservedAt },
    };
  }

  async subscribeMarketData(tokenIds: string[]): Promise<RealtimeSubscription> {
    if (tokenIds.length === 0) throw new Error("market subscription requires at least one token id");
    return this.pub().subscribe([{ topic: "market", tokenIds: [...new Set(tokenIds)] }]);
  }

  async subscribeUserData(): Promise<RealtimeSubscription> {
    return (await this.secure()).subscribe([{ topic: "user" }]);
  }

  async quote(marketRef: string): Promise<Quote> {
    const [book, midStr, volume24h] = await Promise.all([
      this.book(marketRef),
      this.pub().fetchMidpoint({ tokenId: marketRef }),
      this.volume24h(marketRef),
    ]);
    const bid = book.bids[0]?.price ?? 0;
    const ask = book.asks[0]?.price ?? 1;
    const mid = Number(midStr) || (bid + ask) / 2;
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

  private async volume24h(marketRef: string): Promise<number> {
    const cached = this.volumeCache.get(marketRef);
    if (cached && Date.now() - cached.at < 60_000) return cached.v;
    let v = 0;
    try {
      // Direct gamma REST: the filter param is snake_case `clob_token_ids`
      // (camelCase silently returns an UNFILTERED list — verified 2026-08-13).
      const res = await fetch(`${this.urls.gamma}/markets?clob_token_ids=${marketRef}`);
      const list = (await res.json()) as { volume24hr?: string | number | null }[];
      v = Number(list[0]?.volume24hr ?? 0) || 0;
    } catch {
      v = 0;
    }
    this.volumeCache.set(marketRef, { v, at: Date.now() });
    return v;
  }

  /** Resolve the direct Gamma parent event for portfolio-level exposure caps. */
  async eventRef(marketRef: string): Promise<string | undefined> {
    const cached = this.eventRefCache.get(marketRef);
    if (cached) return cached;
    try {
      const url = new URL("/markets", this.urls.gamma);
      url.searchParams.set("clob_token_ids", marketRef);
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) return undefined;
      const body = (await res.json()) as unknown;
      const first = Array.isArray(body) ? body[0] : undefined;
      if (!first || typeof first !== "object") return undefined;
      const events = (first as { events?: unknown }).events;
      const event = Array.isArray(events) ? events[0] : undefined;
      if (!event || typeof event !== "object") return undefined;
      const rawId = (event as { id?: unknown }).id;
      if (typeof rawId !== "string" && typeof rawId !== "number") return undefined;
      const id = String(rawId).trim();
      if (!id) return undefined;
      const ref = `polymarket:${id}`;
      this.eventRefCache.set(marketRef, ref);
      return ref;
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Trading
  // -------------------------------------------------------------------------

  normalizeOrderSize(size: number): number {
    return normalizePolymarketOrderSize(size);
  }

  async placeOrder(_acct: VenueAccount, intent: OrderIntent): Promise<OrderAck> {
    return this.placePrepared(intent);
  }

  async placeOrderWithLifecycle(
    _acct: VenueAccount,
    intent: OrderIntent,
    hooks: OrderLifecycleHooks,
  ): Promise<OrderAck> {
    return this.placePrepared(intent, hooks);
  }

  private async placePrepared(intent: OrderIntent, hooks?: OrderLifecycleHooks): Promise<OrderAck> {
    const client = await this.secure();
    const { tokenId, conditionId } = await this.tokenForIntent(intent);
    // Cached condition data is for identity only. Tick size can change while
    // an execution is working, so revalidate against the current token book.
    const currentBook = await this.pub().fetchOrderBook({ tokenId });
    if (String(currentBook.tokenId) !== tokenId || String(currentBook.conditionId).toLowerCase() !== conditionId.toLowerCase()) {
      throw new Error("Polymarket order book identity changed before signing");
    }
    const tick = Number(currentBook.tickSize);
    const price = clampTick(intent.limitPrice, tick, intent.side);
    const size = this.normalizeOrderSize(intent.size);
    if (size <= 0) throw new Error("order size rounds to zero");
    const minimumSize = Number(currentBook.minOrderSize);
    if (!Number.isFinite(minimumSize) || minimumSize <= 0 || size + 1e-9 < minimumSize) {
      throw new Error("order size is below the current Polymarket minimum");
    }

    // Before the first sell of a token, sync the CONDITIONAL allowance cache (§5.1).
    if (intent.side === "SELL" && !this.conditionalAllowanceSynced.has(tokenId)) {
      await updateBalanceAllowance(client, { assetType: CONDITIONAL, tokenId }).catch(() => {});
      this.conditionalAllowanceSynced.add(tokenId);
    }

    const side = intent.side === "BUY" ? PmOrderSide.BUY : PmOrderSide.SELL;
    // Builder attribution is serialized into the signed order, so the fee is
    // exchange-enforced and needs no second transaction.
    const attribution = this.builderCode ? { builderCode: this.builderCode } : {};
    if (!this.builderCode && !this.builderCodeWarned) {
      this.builderCodeWarned = true;
      console.warn("[polymarket] builder attribution is off; orders carry no Quotient builder code");
    }
    let signed: PmSignedOrder;
    try {
      if (intent.tif === "FOK" || intent.tif === "IOC" || intent.tif === "FAK") {
        if (intent.postOnly) throw new Error(`${intent.tif} orders cannot be post-only`);
        const orderType = intent.tif === "FOK" ? PmOrderType.FOK : PmOrderType.FAK;
        signed =
          intent.side === "BUY"
            ? await client.createMarketOrder({ tokenId, side: PmOrderSide.BUY, amount: Math.floor(size * price * 100) / 100, maxPrice: price, orderType, ...attribution })
            : await client.createMarketOrder({ tokenId, side: PmOrderSide.SELL, shares: size, minPrice: price, orderType, ...attribution });
      } else {
        signed = await client.createLimitOrder({
          tokenId,
          price,
          size,
          side,
          postOnly: intent.postOnly ?? false,
          ...(intent.expiration ? { expiration: intent.expiration } : {}),
          ...attribution,
        });
      }
    } catch (err) {
      // A SELL bouncing on allowance means the CTF operator approval is
      // missing on-chain — a funding-flow defect, not a balance problem, and
      // retrying the identical order cannot fix it. Say what actually repairs
      // it instead of letting the raw venue error loop in the logs.
      const message = err instanceof Error ? err.message : String(err);
      if (intent.side === "SELL" && /allowance/i.test(message)) {
        throw new Error(
          `${message} — the venue is refusing to move this position's conditional tokens because the CTF operator ` +
            "approval is missing on-chain. Run `cassie fund <botId>` to set and verify trading approvals, then retry.",
        );
      }
      throw err;
    }

    // Hash the SDK-created payload in memory. Only this digest crosses the
    // adapter boundary; the signature itself is never persisted or logged.
    const preparedHash = createHash("sha256").update(JSON.stringify(signed)).digest("hex");
    await hooks?.onPrepared({ preparedHash, tokenId, conditionId, outcome: intent.outcome, limitPrice: price, size });
    let res: Awaited<ReturnType<PmSecureClient["postOrder"]>>;
    try {
      res = await client.postOrder(signed);
    } catch (error) {
      // An SDK HTTP rejection carrying an explicit 4xx response is definitive.
      // Timeout, proxy/server failure and malformed accepted responses are not.
      const rejection = error as { name?: string; status?: number; code?: string; message?: string };
      if (rejection.name === "RequestRejectedError" && rejection.status !== undefined &&
        rejection.status >= 400 && rejection.status < 500 && rejection.status !== 408) {
        throw new PolymarketOrderRejectedError(`${rejection.code ?? ""} ${rejection.message ?? "order rejected"}`.trim(), { cause: error });
      }
      throw error;
    }

    const r = res as {
      ok?: boolean;
      orderId?: string;
      status?: string;
      makingAmount?: string;
      takingAmount?: string;
      error?: unknown;
      code?: string;
      message?: string;
    };
    if (r.ok === false) throw new PolymarketOrderRejectedError(`order rejected: ${r.code ?? ""} ${r.message ?? String(r.error ?? "venue declined the order")}`);
    if (!r.orderId) throw new Error("Polymarket order submission returned no order identity; acceptance is unknown");
    const making = Number(r.makingAmount ?? 0);
    const taking = Number(r.takingAmount ?? 0);
    const filledSize = intent.side === "BUY" ? taking : making;
    const avgFillPrice = filledSize > 0 ? (intent.side === "BUY" ? making / taking : taking / making) : undefined;
    const matched = r.status === "matched";
    return {
      orderId: r.orderId,
      clientId: intent.clientId,
      status: matched && filledSize >= size - 0.01 ? "filled" : filledSize > 0 ? "partial" : "open",
      filledSize: filledSize > 0 ? filledSize : undefined,
      avgFillPrice,
      // Exact traded token and position-holding wallet for reconciliation.
      tokenId,
      conditionId,
      funder: this.creds?.funder,
      preparedHash,
    };
  }

  async cancelOrderChecked(_acct: VenueAccount, id: string): Promise<{ status: "canceled" | "not-canceled"; reason?: string }> {
    const client = await this.secure();
    const result = await client.cancelOrder({ orderId: id });
    const reason = (result.notCanceled as Record<string, string> | undefined)?.[id];
    if (reason !== undefined) {
      // Documented not-found/already-canceled responses and the live CLOB wording
      // observed 2026-09-08. This is not a cancellation or a fill acknowledgment.
      const notOpen = /^(?:order can't be found - already canceled or matched|order not found or already canceled|order already (?:matched|canceled|cancelled))\.?$/i.test(reason.trim());
      return { status: "not-canceled", reason, ...(notOpen ? { notOpen: true } : {}) };
    }
    return result.canceled?.some((canceledId) => String(canceledId) === id)
      ? { status: "canceled" }
      : { status: "not-canceled", reason: "venue returned no cancellation acknowledgment for this order" };
  }

  async cancelOrder(acct: VenueAccount, id: string): Promise<void> {
    const result = await this.cancelOrderChecked(acct, id);
    if (result.status !== "canceled") throw new Error(`Polymarket cancellation unconfirmed for ${id}: ${result.reason}`);
  }

  async cancelAll(_acct: VenueAccount): Promise<void> {
    const client = await this.secure();
    const result = await client.cancelAll();
    if (!result || Object.keys(result.notCanceled ?? {}).length > 0) {
      throw new Error("Polymarket could not confirm cancellation of every order; reconcile authenticated order state");
    }
  }

  async executionOrder(_acct: VenueAccount, id: string): Promise<PredictionOrderState | null> {
    const client = await this.secure();
    let order: Awaited<ReturnType<PmSecureClient["fetchOrder"]>>;
    try {
      order = await this.budget.run("orders", () => client.fetchOrder({ orderId: id }));
    } catch (error) {
      const response = error as { name?: string; status?: number };
      if (response.name === "RequestRejectedError" && response.status === 404) return null;
      // Observed live 2026-09-06: a canceled order may return HTTP 200/null.
      // The pinned SDK rejects it before returning; preserve it as missing data,
      // never as evidence of a fill or cancellation. Other schema failures propagate.
      if (error instanceof UnexpectedResponseError) {
        const issues = (error.cause as { issues?: { code?: string; expected?: string; path?: unknown[]; message?: string }[] } | undefined)?.issues;
        const issue = issues?.length === 1 ? issues[0] : undefined;
        if (issue?.code === "invalid_type" && issue.expected === "object" && issue.path?.length === 0 &&
          issue.message?.endsWith("received null")) return null;
      }
      throw error;
    }
    if (!order) return null;
    if (order.id !== id) throw new Error("Polymarket order lookup returned a different order identity");
    const size = Number(order.originalSize);
    const matchedSize = Number(order.sizeMatched);
    if (!Number.isFinite(size) || size < 0 || !Number.isFinite(matchedSize) || matchedSize < 0 || matchedSize > size + 1e-6) {
      throw new Error("Polymarket order lookup returned invalid cumulative quantities");
    }
    const rawStatus = order.status.toUpperCase().replace(/^ORDER_STATUS_/, "");
    const status: PredictionOrderState["status"] =
      ["LIVE", "OPEN", "DELAYED", "UNMATCHED"].includes(rawStatus) ? "open" :
        rawStatus === "MATCHED" ? "matched" :
          ["CANCELED", "CANCELLED", "CANCELED_MARKET_RESOLVED"].includes(rawStatus) ? "canceled" : rawStatus === "EXPIRED" ? "expired" : "unknown";
    return { orderId: id, status, size, matchedSize, observedAt: Date.now() };
  }

  async openOrders(_acct: VenueAccount): Promise<Order[]> {
    const client = await this.secure();
    const out: Order[] = [];
    const rows = await this.budget.run("orders", async () => {
      const items: Awaited<ReturnType<ReturnType<PmSecureClient["listOpenOrders"]>["firstPage"]>>["items"] = [];
      for await (const page of client.listOpenOrders({})) items.push(...page.items);
      return items;
    });
    {
      for (const o of rows) {
        const tokenId = String(o.tokenId);
        const { marketRef, isYes } = await this.yesRefOf(tokenId);
        const { conditionId } = await this.marketInfoForToken(tokenId);
        const size = Number(o.originalSize);
        const filled = Number(o.sizeMatched);
        out.push({
          id: o.id,
          marketRef,
          tokenId,
          conditionId,
          outcome: isYes ? "YES" : "NO",
          side: o.side.toUpperCase() === "SELL" ? "SELL" : "BUY",
          size,
          filledSize: filled,
          price: Number(o.price),
          status: filled > 0 ? "partial" : "open",
          createdAt: Date.parse(o.createdAt) || undefined,
        });
      }
    }
    return out;
  }

  async fills(acct: VenueAccount, sinceTs: number): Promise<Fill[]> {
    // Generic fill consumers must never book inventory from an unconfirmed or
    // failed settlement. Status-aware controllers use tradeSettlements below.
    return (await this.tradeSettlements(acct, sinceTs)).filter((fill) => fill.settlementStatus === "CONFIRMED");
  }

  async tradeSettlements(acct: VenueAccount, sinceTs: number): Promise<Fill[]> {
    const account = asPmAccount(acct);
    if (!Number.isFinite(sinceTs) || sinceTs < 0) throw new Error("Polymarket fill cursor must be non-negative and finite");
    const client = await this.secure();
    const out = new Map<string, Fill>();
    const seenTrades = new Map<string, { updatedAt: number; rank: number }>();
    // The API filters whole Unix seconds; keep an extra second at the boundary
    // and retain the exact millisecond filter below for deterministic replay.
    const request = sinceTs > 0 ? { after: String(Math.max(0, Math.floor(sinceTs / 1_000) - 1)) } : {};
    const rows = await this.budget.run("orders", async () => {
      const items: Awaited<ReturnType<ReturnType<PmSecureClient["listAccountTrades"]>["firstPage"]>>["items"] = [];
      for await (const page of client.listAccountTrades(request)) items.push(...page.items);
      return items;
    });
    {
      for (const t of rows) {
        const ts = Date.parse(t.matchedAt);
        if (!Number.isFinite(ts)) throw new Error(`Polymarket trade ${t.id} has an invalid match timestamp`);
        if (ts < sinceTs) continue;
        // A status-aware controller journals MATCHED/MINED/RETRYING as pending,
        // applies only CONFIRMED, and releases FAILED reservations without
        // inventing inventory or a reversal of a trade that never settled.
        // Contract verified 2026-09-04: docs.polymarket.com/concepts/order-lifecycle
        const status = t.status.toUpperCase().replace(/^TRADE_STATUS_/, "");
        if (!["MATCHED", "MINED", "CONFIRMED", "RETRYING", "FAILED"].includes(status)) {
          throw new Error(`Polymarket trade ${t.id} has unsupported settlement status ${t.status}`);
        }
        const rank = { MATCHED: 1, MINED: 2, RETRYING: 3, FAILED: 4, CONFIRMED: 5 }[status]!;
        const parsedUpdate = Date.parse(t.updatedAt);
        const updatedAt = Number.isFinite(parsedUpdate) ? parsedUpdate : ts;
        const previous = seenTrades.get(t.id);
        if (previous && (previous.updatedAt > updatedAt || (previous.updatedAt === updatedAt && previous.rank >= rank))) continue;
        seenTrades.set(t.id, { updatedAt, rank });

        const makerTrade = t.traderSide === "MAKER";
        if (!makerTrade && t.traderSide !== "TAKER") throw new Error(`Polymarket trade ${t.id} has an unknown account side`);
        const ownedMakers = makerTrade
          ? t.makerOrders.filter((maker) => maker.makerAddress.toLowerCase() === account.funder.toLowerCase())
          : [];
        if (makerTrade && ownedMakers.length === 0) {
          throw new Error(`Polymarket maker trade ${t.id} has no maker leg owned by the account funder`);
        }
        const legs = makerTrade ? ownedMakers.map((maker) => ({
          orderId: maker.orderId, tokenId: String(maker.tokenId), size: Number(maker.matchedAmount),
          price: Number(maker.price), side: maker.side, feeRateBps: 0,
        })) : [{
          orderId: t.takerOrderId, tokenId: String(t.tokenId), size: Number(t.size),
          price: Number(t.price), side: t.side, feeRateBps: Number(t.feeRateBps),
        }];
        const fills = new Map<string, Fill>();
        for (const leg of legs) {
          const side = leg.side.toUpperCase();
          if (!leg.orderId || !(leg.size > 0) || !Number.isFinite(leg.size) || !(leg.price > 0 && leg.price < 1) ||
            !Number.isFinite(leg.feeRateBps) || leg.feeRateBps < 0 || (side !== "BUY" && side !== "SELL")) {
            throw new Error(`Polymarket trade ${t.id} has invalid account fill terms`);
          }
          const { marketRef, isYes } = await this.yesRefOf(leg.tokenId);
          const { conditionId } = await this.marketInfoForToken(leg.tokenId);
          if (conditionId.toLowerCase() !== String(t.conditionId).toLowerCase()) {
            throw new Error(`Polymarket trade ${t.id} maker token belongs to a different condition`);
          }
          const id = makerTrade ? `${t.id}:${leg.orderId}` : t.id;
          // Makers pay zero protocol fee. Takers pay C × rate × p × (1-p);
          // never charge the taker's fee to an owned maker leg. Quotient's
          // builder fee is charged on notional on both sides of the trade,
          // at the maker or taker rate the profile carries. Rounded to 5
          // decimals. Contract verified 2026-09-04: docs.polymarket.com/trading/fees
          const protocolFee = leg.size * (leg.feeRateBps / 10_000) * leg.price * (1 - leg.price);
          const builderFee = this.builderFeeFor(makerTrade ? "maker" : "taker", leg.size, leg.price);
          const fee = Number((protocolFee + builderFee).toFixed(5));
          const existing = fills.get(id);
          if (existing) {
            if (existing.tokenId !== leg.tokenId || existing.side !== side) {
              throw new Error(`Polymarket trade ${t.id} reuses a maker order across conflicting tokens or sides`);
            }
            existing.price = (existing.price * existing.size + leg.price * leg.size) / (existing.size + leg.size);
            existing.size += leg.size;
            existing.matchedAmountDelta = existing.size;
            existing.fee = (existing.fee ?? 0) + fee;
          } else {
            fills.set(id, {
              id, orderId: leg.orderId, ...(makerTrade ? { makerOrderId: leg.orderId } : {}),
              marketRef, tokenId: leg.tokenId, conditionId, outcome: isYes ? "YES" : "NO", side,
              size: leg.size, matchedAmountDelta: leg.size, price: leg.price, ts, fee,
              settlementStatus: status as NonNullable<Fill["settlementStatus"]>,
            });
          }
        }
        for (const fill of fills.values()) out.set(fill.id, fill);
      }
    }
    return [...out.values()].sort((a, b) => a.ts - b.ts);
  }

  // -------------------------------------------------------------------------
  // Dead man's switch: POST /v1/heartbeats with chained heartbeat_id
  // -------------------------------------------------------------------------

  async heartbeat(acct: VenueAccount): Promise<void> {
    const a = asPmAccount(acct);
    const send = async (id: string): Promise<Response> => {
      const body = JSON.stringify({ heartbeat_id: id });
      const path = "/v1/heartbeats";
      const ts = Math.floor(Date.now() / 1000); // unix SECONDS (§5.1)
      if (!this.creds) throw new Error("polymarket: heartbeat requires L2 credentials");
      const sig = await buildHmacSignature(this.creds.l2.secret, ts, "POST", path, body);
      return fetch(`${this.urls.clob}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          POLY_ADDRESS: a.signerAddress,
          POLY_SIGNATURE: sig,
          POLY_TIMESTAMP: String(ts),
          POLY_API_KEY: this.creds.l2.apiKey,
          POLY_PASSPHRASE: this.creds.l2.passphrase,
        },
        body,
      });
    };
    let res = await send(this.heartbeatId);
    if (res.status === 400) {
      // Expired/invalid chain id: the response carries the expected id — recover once.
      const data = (await res.json().catch(() => ({}))) as { heartbeat_id?: string };
      if (data.heartbeat_id !== undefined) res = await send(data.heartbeat_id);
    }
    if (!res.ok) throw new Error(`heartbeat failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { heartbeat_id?: string };
    this.heartbeatId = data.heartbeat_id ?? "";
  }

  // -------------------------------------------------------------------------
  // Resolution redemption (gasless via SDK position lifecycle)
  // -------------------------------------------------------------------------

  /**
   * SDK 0.6.0 redeemPositions({ conditionId }) already selects the market-type
   * collateral adapter and redeems BOTH outcome balances for the condition.
   * There is no amount parameter. Submit once per condition, not once per token.
   * Verified 2026-09-06: docs.polymarket.com/trading/positions/manage
   * Gasless wallets require relayer/builder authorization on the secure client;
   * CLOB L2 credentials alone do not grant that capability. Deploy supplies the
   * operator's saved default as a separate service credential for directional bots.
   * Never retry here: submission/wait failures may follow an accepted transaction.
   */
  async redeem(acct: VenueAccount, position: Position, hooks?: RedemptionHooks): Promise<RedemptionReceipt> {
    asPmAccount(acct);
    // positions() already validated this identity through the SDK's account
    // snapshot. Redemption must not depend on a resolved market's order book.
    const known = this.tokenToCondition.get(position.marketRef);
    const conditionId = position.conditionId && known === position.conditionId ? known :
      (await this.marketInfoForToken(position.marketRef)).conditionId;
    if (position.conditionId && position.conditionId.toLowerCase() !== conditionId.toLowerCase()) {
      throw new Error("Polymarket redemption position condition does not match its market token");
    }
    const client = await this.secure();
    await hooks?.beforeSubmit();
    const handle = await client.redeemPositions({ conditionId });
    await hooks?.submitted({
      ...(handle.transactionHash ? { transactionHash: String(handle.transactionHash) } : {}),
      ...(handle.transactionId ? { transactionId: String(handle.transactionId) } : {}),
    });
    const outcome = await handle.wait();
    return {
      transactionHash: String(outcome.transactionHash),
      ...(outcome.transactionId === null ? {} : { transactionId: String(outcome.transactionId) }),
    };
  }

  async redemptionStatus(acct: VenueAccount, receipt: RedemptionReceipt): Promise<"pending" | "confirmed" | "failed"> {
    asPmAccount(acct);
    if (!receipt.transactionId) return "pending";
    const transaction = await fetchTransaction(await this.secure(), { transactionId: receipt.transactionId });
    if (transaction.state === "STATE_CONFIRMED") return "confirmed";
    if (transaction.state === "STATE_FAILED" || transaction.state === "STATE_INVALID") return "failed";
    return "pending";
  }
}

/** CLOB limit shares use two decimals. Decimal shifting avoids flooring 1.15 twice to 1.14. */
export function normalizePolymarketOrderSize(size: number): number {
  if (!Number.isFinite(size) || size < 0 || size > Number.MAX_SAFE_INTEGER / 100) {
    throw new Error("invalid Polymarket order size");
  }
  const [coefficient, exponent = "0"] = size.toString().split("e");
  return Math.floor(Number(`${coefficient}e${Number(exponent) + 2}`)) / 100;
}

function clampTick(price: number, tick: number, side: "BUY" | "SELL"): number {
  if (!Number.isFinite(tick) || tick <= 0 || tick >= 1 || !Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error("invalid Polymarket order price or tick size");
  }
  const scaled = price / tick;
  const snapped = Number(((side === "BUY" ? Math.floor(scaled + 1e-10) : Math.ceil(scaled - 1e-10)) * tick).toFixed(8));
  if (snapped < tick - 1e-10 || snapped > 1 - tick + 1e-10) throw new Error("Polymarket price bound has no valid tick");
  return snapped;
}

registerAdapter("polymarket", (opts) => new PolymarketAdapter(opts));

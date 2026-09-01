// packages/core/src/venues/polymarket.ts
// Polymarket venue adapter (§5.1), built on the official unified SDK
// @polymarket/client 0.6.0 (pinned). Verified against the installed SDK's type
// surface and docs.polymarket.com on 2026-08-13.
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
  type ApiKeyAuthorization,
  type AssetType,
  type EnvironmentContracts,
  type MarketInfo,
} from "@polymarket/client";
import { createHash } from "node:crypto";

// AssetType is exported as a type but not as a runtime value from the SDK's
// ESM entry (verified 2026-08-13); use the literal values.
const COLLATERAL = "COLLATERAL" as AssetType;
const CONDITIONAL = "CONDITIONAL" as AssetType;
/** pUSD on Polygon — fallback when the client doesn't expose its environment. */
const PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";

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

/** Last 4 chars of a stored credential, so a menu can identify it without revealing it. */
function maskSecret(savedJson: string): string {
  try {
    const key = (JSON.parse(savedJson) as { key?: string }).key ?? "";
    return key.length >= 4 ? `••••${key.slice(-4)}` : "••••";
  } catch {
    return "••••";
  }
}
import {
  fetchBalanceAllowance,
  fetchMarketInfo,
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
  Position,
  Quote,
  RedemptionReceipt,
  RealtimeSubscription,
  RuntimeCreds,
  SetupContext,
  VenueAccount,
  VenueAdapter,
} from "../types.js";
import { registerAdapter, type AdapterOpts } from "./registry.js";

type PmSecureClient = Awaited<ReturnType<typeof createSecureClient>>;
type PmPublicClient = ReturnType<typeof createPmPublicClient>;
type PmSignedOrder = Awaited<ReturnType<PmSecureClient["createLimitOrder"]>>;
type PmCreds = Extract<RuntimeCreds, { venue: "polymarket" }>;
type PmAccount = Extract<VenueAccount, { venue: "polymarket" }>;

/** Local-only keystore role holding the operator's relayer/builder key (§11). */
export const GASLESS_AUTH_ROLE = "polymarket-gasless";

type GaslessAuthDesc =
  | { kind: "relayer"; key: string; address: string }
  | { kind: "builder"; key: string; secret: string; passphrase: string };

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
  readonly verifiedAgainst = "2026-08-13";
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

  constructor(private readonly opts: AdapterOpts) {
    if (opts.creds && opts.creds.venue === "polymarket") this.creds = opts.creds;
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

    ctx.print("Paths: create = new Polymarket account (needs a Builder or Relayer key)");
    ctx.print("       connect = existing Polymarket account (profile wallet + Relayer key)");
    const path = (await ctx.ask("Path (create/connect)", { default: "create" })).trim().toLowerCase();

    let apiKey: ApiKeyAuthorization | undefined;
    let wallet: string | undefined;
    let gaslessAuth: GaslessAuthDesc | undefined;
    if (path === "connect") {
      wallet = (await ctx.ask("Wallet address (polymarket.com profile)")).trim();
      const relayerKey = (await ctx.ask("Relayer API key", { secret: true })).trim();
      // The Relayer key is bound to the SIGNER that created it, not the wallet
      // (the relayer rejects "from X does not match auth Y" otherwise).
      const { privateKeyToAccount } = await import("viem/accounts");
      const signerAddr = privateKeyToAccount(pk as `0x${string}`).address;
      const relayerAddr = (await ctx.ask("Relayer key's signer address", { default: signerAddr })).trim();
      gaslessAuth = { kind: "relayer", key: relayerKey, address: relayerAddr };
    } else {
      // Deposit Wallet deployment and all gasless ops (approvals, redeem,
      // withdrawals) require a Relayer or Builder API key in the client
      // configuration (verified live 2026-08-13). Either works here.
      gaslessAuth = await this.elicitBuilderAuth(ctx);
    }
    if (gaslessAuth) {
      apiKey = apiKeyFromDesc(gaslessAuth);
      // Builder/relayer keys stay local to the operator's machine.
      await ctx.putSecret(GASLESS_AUTH_ROLE, JSON.stringify(gaslessAuth), { runtimeEligible: false });
    }

    ctx.print("Creating/deriving Polymarket account and CLOB credentials (gasless)…");
    const client = await createSecureClient({
      ...this.environment,
      signer: privateKey(pk),
      ...(wallet ? { wallet } : {}),
      ...(apiKey ? { apiKey } : {}),
    });
    this.secureClient = client;

    const account = client.account;
    ctx.print(`signer (EOA):     ${account.signer}`);
    ctx.print(`trading address:  ${account.wallet} [${String(account.walletType)}]`);
    ctx.print("Polygon pUSD only.");

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
    ctx.print("Setting up trading approvals (one-time, gasless via relayer)…");
    await this.ensureTradingApprovals(ctx, client);

    // Geoblock: surface the answer during setup, nothing more (§5.1).
    // The check lives on polymarket.com, not the API servers (verified 2026-08-13).
    try {
      const res = await fetch("https://polymarket.com/api/geoblock");
      const g = (await res.json()) as { blocked?: boolean; country?: string; region?: string };
      ctx.print(
        g.blocked
          ? `geoblock: ORDER PLACEMENT BLOCKED from your location (${g.country}${g.region ? "/" + g.region : ""}). Reads and funding still work; orders will be rejected.`
          : `geoblock: order placement permitted from your location (${g.country ?? "unknown"}).`,
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
        note: chain === "evm" ? "any supported EVM chain; auto-converted to pUSD" : undefined,
      })),
      summary:
        `Send USDC to the bridge deposit address shown below. ` +
        `Auto-wrapped to pUSD. Deposits over $50k: use a third-party bridge (DeBridge/Across/Portal) ` +
        `direct to the Polygon USDC address instead to limit slippage.`,
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
    ctx.print(`Bridge deposit address (EVM, any supported chain): ${bridged.evm}`);
    ctx.print(`Minimum: ~${minimum} USDC. Incoming USDC is auto-wrapped to pUSD.`);
    ctx.print(`(Small amounts can also go as USDC directly on Polygon to the same address.)`);
    ctx.print(`Deposits over $50k: use a third-party bridge direct to Polygon USDC instead.`);

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
      ctx.print(`Deposit polling skipped. Balance: ${current.toFixed(2)} pUSD; continuing to trading approvals.`);
    } else {
      ctx.print(`Deposit credited: ${(after - before).toFixed(2)} pUSD.`);
      ctx.print(`Balance: ${after.toFixed(2)} pUSD.`);
    }

    const client = await this.gaslessClient(ctx, a);
    ctx.print("Setting up trading approvals (one-time, gasless via relayer)…");
    await this.ensureTradingApprovals(ctx, client);
    ctx.print("Funding flow complete. L2 credentials derived and stored.");
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
      ctx.print("Approving Polymarket Neg Risk Adapter (SDK 0.6.0 compatibility)…");
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
      ctx.print("Approving the exchange as CTF operator (required for sells)…");
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
    ctx.print("CTF operator approval verified on-chain — sells enabled.");
  }

  /** Refresh the CLOB cache and return one spender's collateral allowance. */
  private async syncCollateralAllowance(client: PmSecureClient, spender: string): Promise<bigint> {
    const result = await updateBalanceAllowance(client, { assetType: COLLATERAL });
    const match = Object.entries(result.allowances).find(([address]) => address.toLowerCase() === spender.toLowerCase());
    return BigInt(match?.[1] ?? "0");
  }

  /**
   * Elicit the gasless credential (Builder or Relayer key) that Deposit Wallet
   * deployment needs. A menu rather than one overloaded text field: the old
   * prompt made blank-vs-'open'-vs-a-key four different outcomes typed into a
   * masked box, where the operator could not see what they had typed.
   */
  private async elicitBuilderAuth(ctx: SetupContext): Promise<GaslessAuthDesc | undefined> {
    const defaultAuth = (await ctx.getOperatorDefault?.("polymarket-builder")) ?? null;
    ctx.print("");
    ctx.print("Polymarket needs a Builder or Relayer API key to create your account.");
    ctx.print("Free, from your own Polymarket account.");

    for (;;) {
      const choice = await this.askAuthChoice(ctx, defaultAuth);
      if (choice === "open") {
        const url = "https://polymarket.com/settings";
        if (ctx.openUrl) ctx.openUrl(url);
        else ctx.print(`→ ${url} (Builders tab)`);
        ctx.print("Create a Builder key there, then pick 'Paste a Builder key'.");
        continue;
      }
      if (choice === "default" && defaultAuth) return JSON.parse(defaultAuth) as GaslessAuthDesc;
      if (choice === "builder") {
        const key = (await ctx.ask("Builder key", { secret: true })).trim();
        if (!key) {
          ctx.print("no key entered — pick again.");
          continue;
        }
        const secret = (await ctx.ask("Builder secret", { secret: true })).trim();
        const passphrase = (await ctx.ask("Builder passphrase", { secret: true })).trim();
        const desc: GaslessAuthDesc = { kind: "builder", key, secret, passphrase };
        if (ctx.setOperatorDefault && (await ctx.confirm("Make this the default Builder key for future bots?", true))) {
          await ctx.setOperatorDefault("polymarket-builder", JSON.stringify(desc));
        }
        return desc;
      }
      if (choice === "relayer") {
        const rKey = (await ctx.ask("Relayer API key", { secret: true })).trim();
        if (!rKey) {
          ctx.print("no key entered — pick again.");
          continue;
        }
        const rAddr = (await ctx.ask("Relayer key's signer address")).trim();
        return { kind: "relayer", key: rKey, address: rAddr };
      }
      return undefined;
    }
  }

  /** The menu, with a text fallback for hosts that implement no `select`. */
  private async askAuthChoice(ctx: SetupContext, defaultAuth: string | null): Promise<string> {
    const choices = [
      ...(defaultAuth ? [{ value: "default", title: `Use default Builder key (${maskSecret(defaultAuth)})` }] : []),
      { value: "builder", title: defaultAuth ? "Paste a different Builder key" : "Paste a Builder key" },
      { value: "open", title: "Open polymarket.com to create one" },
      { value: "relayer", title: "Use a Relayer key instead" },
      { value: "skip", title: "Skip (cannot create a Polymarket account without one)" },
    ];
    if (ctx.select) return ctx.select("Authenticate with", choices);
    const menu = choices.map((c, i) => `  ${i + 1}) ${c.title}`).join("\n");
    ctx.print(menu);
    const raw = (await ctx.ask("Choose", { default: "1" })).trim();
    const idx = Number(raw) - 1;
    return choices[idx]?.value ?? "builder";
  }

  /** Secure client carrying the operator's relayer/builder key for gasless ops. */
  private async gaslessClient(ctx: SetupContext, a: PmAccount): Promise<PmSecureClient> {
    await this.ensureCredsFromKeystore(ctx, a);
    const gaslessRaw = await ctx.getSecret(GASLESS_AUTH_ROLE);
    if (!gaslessRaw) return this.secure();
    return createSecureClient({
      ...this.environment,
      signer: privateKey(this.creds!.signerPk),
      wallet: a.funder,
      apiKey: apiKeyFromDesc(JSON.parse(gaslessRaw) as GaslessAuthDesc),
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

  private async collateralBalance(): Promise<number> {
    const client = await this.secure();
    const res = await fetchBalanceAllowance(client, { assetType: COLLATERAL });
    return Number(res.balance) / 1e6; // pUSD, 6 decimals
  }

  async balances(_acct: VenueAccount): Promise<Balance[]> {
    const bal = await this.collateralBalance();
    return [{ asset: "pUSD", total: bal, available: bal }];
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

  private yesTokenOf(info: MarketInfo): string {
    const yes = info.tokens.find((t) => t.outcome.trim().toLowerCase() === "yes");
    if (!yes) throw new Error("market has no explicitly labeled YES token");
    return String(yes.tokenId);
  }

  /** Resolve the tradable token for (marketRef = YES token, outcome). */
  private async tokenFor(marketRef: string, outcome: "YES" | "NO" | undefined): Promise<string> {
    if (outcome !== "NO") return marketRef;
    const { info } = await this.marketInfoForToken(marketRef);
    const no = info.tokens.find((t) => t.outcome.trim().toLowerCase() === "no");
    if (!no) throw new Error(`cannot resolve explicitly labeled NO token for ${marketRef}`);
    return String(no.tokenId);
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
      const token = info.tokens.find((candidate) => String(candidate.tokenId) === tokenId);
      if (token?.outcome.trim().toUpperCase() !== intent.outcome) {
        throw new Error(`token ${tokenId} is not labeled ${intent.outcome}`);
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

  async positions(_acct: VenueAccount): Promise<Position[]> {
    const client = await this.secure();
    const out: Position[] = [];
    for await (const page of client.listPositions({})) {
      for (const p of page.items) {
        const size = Number(p.size ?? 0);
        if (!p.tokenId || size <= 0) continue;
        const tokenId = String(p.tokenId);
        const { conditionId, info } = await this.marketInfoForToken(tokenId);
        const explicit = info.tokens.find((token) => String(token.tokenId) === tokenId)?.outcome.trim().toUpperCase();
        if (explicit !== "YES" && explicit !== "NO") continue;
        const outcome = explicit;
        const marketRef = this.yesTokenOf(info);
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
    const ob = await this.pub().fetchOrderBook({ tokenId: marketRef });
    const toNum = (l: { price: string; size: string }) => ({ price: Number(l.price), size: Number(l.size) });
    return {
      marketRef,
      // SDK returns bids ascending / asks descending; normalize to best-first.
      bids: ob.bids.map(toNum).sort((x, y) => y.price - x.price),
      asks: ob.asks.map(toNum).sort((x, y) => x.price - y.price),
      ts: Number(ob.timestamp ?? Date.now()),
    };
  }

  async tokenBook(tokenId: string): Promise<OrderBook> {
    return this.book(tokenId);
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
    const { tokenId, conditionId, info } = await this.tokenForIntent(intent);
    const tick = Number(info.tickSize);
    const price = clampTick(intent.limitPrice, tick);
    const size = Math.floor(intent.size * 100) / 100; // CLOB sizes: 2dp shares
    if (size <= 0) throw new Error("order size rounds to zero");

    // Before the first sell of a token, sync the CONDITIONAL allowance cache (§5.1).
    if (intent.side === "SELL" && !this.conditionalAllowanceSynced.has(tokenId)) {
      await updateBalanceAllowance(client, { assetType: CONDITIONAL, tokenId }).catch(() => {});
      this.conditionalAllowanceSynced.add(tokenId);
    }

    // Builder attribution (§ Ares). SDK 0.6.0 takes `builderCode` per order
    // request — no separate client and no header override, unlike the older
    // @polymarket/clob-client where it was a construction-time builderConfig.
    // Note this makes the fill subject to the builder taker fee.
    const builderCode = this.opts.builderCode;
    const attribution = builderCode ? { builderCode: builderCode as `0x${string}` } : {};

    const side = intent.side === "BUY" ? PmOrderSide.BUY : PmOrderSide.SELL;
    let signed: PmSignedOrder;
    try {
      if (intent.tif === "FOK" || intent.tif === "IOC" || intent.tif === "FAK") {
        if (intent.postOnly) throw new Error(`${intent.tif} orders cannot be post-only`);
        const orderType = intent.tif === "FOK" ? PmOrderType.FOK : PmOrderType.FAK;
        signed =
          intent.side === "BUY"
            ? await client.createMarketOrder({ tokenId, side: PmOrderSide.BUY, amount: round2(size * price), maxPrice: price, orderType, ...attribution })
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
    await hooks?.onPrepared({ preparedHash, tokenId, conditionId, outcome: intent.outcome });
    const res = await client.postOrder(signed);

    const r = res as {
      ok?: boolean;
      orderId?: string;
      status?: string;
      makingAmount?: string;
      takingAmount?: string;
      error?: unknown;
    };
    if (r.ok === false || !r.orderId) {
      throw new Error(`order rejected: ${JSON.stringify(r).slice(0, 300)}`);
    }
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
      // The traded token (NO orders trade a token the caller never named) and
      // the funder — the position card is built from these, not marketRef.
      tokenId,
      funder: this.creds?.funder,
      builderCode,
      preparedHash,
    };
  }

  async cancelOrder(_acct: VenueAccount, id: string): Promise<void> {
    const client = await this.secure();
    await client.cancelOrder({ orderId: id });
  }

  async cancelAll(_acct: VenueAccount): Promise<void> {
    const client = await this.secure();
    await client.cancelAll();
  }

  async openOrders(_acct: VenueAccount): Promise<Order[]> {
    const client = await this.secure();
    const out: Order[] = [];
    for await (const page of client.listOpenOrders({})) {
      for (const o of page.items) {
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

  async fills(_acct: VenueAccount, sinceTs: number): Promise<Fill[]> {
    const client = await this.secure();
    const out: Fill[] = [];
    for await (const page of client.listAccountTrades({})) {
      for (const t of page.items) {
        const ts = Date.parse(t.matchedAt);
        if (!Number.isFinite(ts) || ts < sinceTs) continue;
        const tokenId = String(t.tokenId);
        const { marketRef, isYes } = await this.yesRefOf(tokenId);
        const conditionId = String(t.conditionId);
        const accountMaker = t.traderSide === "MAKER" ? t.makerOrders.find((maker) => String(maker.tokenId) === tokenId) : undefined;
        const size = Number(accountMaker?.matchedAmount ?? t.size);
        const price = Number(accountMaker?.price ?? t.price);
        const feeRateBps = Number(accountMaker?.feeRateBps ?? t.feeRateBps);
        out.push({
          id: t.id,
          orderId: accountMaker?.orderId ?? t.takerOrderId,
          makerOrderId: accountMaker?.orderId,
          marketRef,
          tokenId,
          conditionId,
          outcome: isYes ? "YES" : "NO",
          side: String(accountMaker?.side ?? t.side).toUpperCase() === "SELL" ? "SELL" : "BUY",
          size,
          matchedAmountDelta: size,
          price,
          ts,
          fee: feeRateBps ? (feeRateBps / 10_000) * size * price : undefined,
        });
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
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

  async redeem(_acct: VenueAccount, position: Position): Promise<RedemptionReceipt> {
    const client = await this.secure();
    const { conditionId } = await this.marketInfoForToken(position.marketRef);
    const handle = await client.redeemPositions({ conditionId });
    const outcome = await handle.wait();
    return {
      transactionHash: String(outcome.transactionHash),
      ...(outcome.transactionId === null ? {} : { transactionId: String(outcome.transactionId) }),
    };
  }
}

function clampTick(price: number, tick: number): number {
  if (!Number.isFinite(tick) || tick <= 0) return price;
  const dp = Math.max(0, Math.ceil(-Math.log10(tick)));
  const snapped = Math.round(price / tick) * tick;
  const bounded = Math.min(1 - tick, Math.max(tick, snapped));
  return Number(bounded.toFixed(dp));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

registerAdapter("polymarket", (opts) => new PolymarketAdapter(opts));

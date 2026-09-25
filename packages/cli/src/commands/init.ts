// packages/cli/src/commands/init.ts
// The wizard (§6, acceptance 1): bot created end-to-end without leaving the
// terminal except to copy-paste dashboard values.

import pc from "picocolors";
import { existsSync } from "node:fs";
import {
  addressFromPk,
  KeyRoles,
  CommodityConfigSchema,
  QUOTIENT_POLYMARKET_FEE_DISCLOSURE,
  TelegramAlerter,
  createAdapter,
  generateEoa,
  isPredictionVenue,
  parseBotConfig,
  type BotConfig,
} from "@quotient-forecasting/cassie-core";
import { ask, confirm, getPassphrase, keystore, makeSetupContext, select, withOperatorRpc } from "../context.js";
import { clearInitState, loadInitState, saveInitState, type InitState } from "../init-state.js";
import { botConfigPath, loadBotConfig, saveBotConfig } from "../paths.js";
import { createSplitsTreasury } from "../splits-init.js";
import { discoverQuotientToken } from "../quotient-token.js";
import { describeTelegramFailure, localTelegramSettings } from "../telegram-settings.js";
import {
  HOLD_STRATEGY,
  HOLD_SUMMARY,
  elicitRecommendedStrategyConfig,
  elicitStrategyConfig,
  recommendedStrategySummary,
} from "./strategy.js";
import { AGENT_STRATEGY_SUMMARY, elicitAgentConfig, fetchAndStorePersona } from "./agent.js";
import { discoverSurplusApiKey, verifySurplusApiKey } from "../surplus-config.js";
import { runDeploy } from "./deploy.js";
import { runFund } from "./fund.js";
import { QuotientSwingConfigSchema } from "@quotient-forecasting/strategy-quotient-swing";
import {
  MARKET_MAKE_PRESET,
  MarketMakeConfigSchema,
} from "@quotient-forecasting/strategy-market-make";

/**
 * An in-place switch would orphan the market-maker's durable reservations and
 * can also remove the CLI surface needed to halt its still-running runtime.
 * V1 therefore requires a separate bot id for a different strategy.
 */
export function requireSafeStrategyTransition(existingStrategyId: string | undefined, nextStrategyId: string): void {
  if (existingStrategyId && existingStrategyId !== nextStrategyId && [existingStrategyId, nextStrategyId].includes("kalshi-commodities")) {
    throw new Error("kalshi-commodities requires a separate bot id for its durable exposure and execution state");
  }
  if (existingStrategyId && existingStrategyId !== nextStrategyId && (existingStrategyId === "quotient-swing" || nextStrategyId === "quotient-swing")) {
    throw new Error("quotient-swing requires a separate bot id so existing exposure and protection cannot be orphaned");
  }
  if (existingStrategyId === "market-make" && nextStrategyId !== "market-make") {
    throw new Error(
      "cannot switch an existing market-make bot to another strategy in place; keep this bot id for halt/status/reconciliation and create a separate bot id",
    );
  }
}

export interface InitDeploymentDependencies {
  confirm: (message: string, defaultYes?: boolean) => Promise<boolean>;
  deploy: (botId: string) => Promise<void>;
  print: (message: string) => void;
}

export interface InitCommitDependencies {
  save: (config: BotConfig) => void;
  clearCheckpoint: (botId: string) => void;
}

/**
 * Make the complete venue identity durable before removing the setup journal.
 * Funding instructions and deployment must only run after this returns.
 */
export function commitInitConfig(
  config: BotConfig,
  dependencies: InitCommitDependencies = {
    save: saveBotConfig,
    clearCheckpoint: clearInitState,
  },
): void {
  dependencies.save(config);
  dependencies.clearCheckpoint(config.id);
}

/** Offer the remote runtime only after setup and funding choices are complete. */
export async function offerInitDeployment(
  botId: string,
  hasExistingDeployment: boolean,
  dependencies: InitDeploymentDependencies = {
    confirm,
    deploy: (id) => runDeploy(id),
    print: (message) => console.log(message),
  },
): Promise<void> {
  dependencies.print(pc.bold("\nRuntime"));
  const prompt = hasExistingDeployment
    ? "Apply this configuration to the existing DigitalOcean droplet now?"
    : "Deploy this bot to a DigitalOcean droplet now?";
  if (await dependencies.confirm(prompt, true)) {
    await dependencies.deploy(botId);
    return;
  }

  if (hasExistingDeployment) {
    dependencies.print(`cassie deploy ${botId}`);
    return;
  }
  dependencies.print(`cassie run ${botId}`);
  dependencies.print(`cassie deploy ${botId}`);
}

export interface InitTelegramDependencies {
  ask: typeof ask;
  confirm: typeof confirm;
  select: typeof select;
  print: (message: string) => void;
  send: (token: string, chatId: string) => Promise<void>;
  saveToken: (token: string) => void;
  /** Values already present in the nearest .local.env or the environment; never echoed. */
  local?: { token?: string; chatId?: string; tokenOrigin?: string; chatIdOrigin?: string };
}

const TELEGRAM_LOCAL_ENV_HINT = "Alerts read TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from the nearest .local.env at run, deploy and `cassie alerts test`.";

/** Keep failed test credentials out of the saved configuration. */
export async function configureInitTelegram(
  existing: { chatId: string } | undefined,
  d: InitTelegramDependencies,
): Promise<{ chatId: string } | undefined> {
  const local = d.local ?? {};
  const hasLocal = Boolean(local.token && local.chatId);
  const choice = await d.select("Telegram alerts", [
    ...(hasLocal ? [{ value: "local", title: "Use TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from .local.env" }] : []),
    { value: "enter", title: "Enter a bot token and chat ID now" },
    ...(hasLocal ? [] : [{ value: "later", title: "Skip: I'll set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .local.env later" }]),
    { value: "none", title: existing ? "Keep the saved alert settings" : "No alerts" },
  ]);
  if (choice === "none") return existing;
  if (choice === "later") { d.print(TELEGRAM_LOCAL_ENV_HINT); return existing; }
  if (choice === "local") {
    d.print(`Telegram: token from ${local.tokenOrigin}; chat id from ${local.chatIdOrigin}`);
    if (await d.confirm("Send a test message?", true)) {
      try {
        await d.send(local.token!, local.chatId!);
        d.print("Telegram test sent.");
      } catch (error) {
        d.print(`${describeTelegramFailure(error)} Fix the values in .local.env, then run \`cassie alerts test\`.`);
      }
    }
    // The saved configuration stays as it is; the values live in .local.env by choice.
    return existing;
  }
  d.print("Bot token: @BotFather");
  d.print("Personal chat ID: @userinfobot");
  d.print("Open your alert bot in Telegram and press Start.");
  for (;;) {
    const token = (await d.ask("Telegram bot token", { secret: true })).trim();
    const chatId = (await d.ask("Telegram chat ID")).trim();
    if (!token || !chatId) {
      d.print("Token and chat ID are required.");
      if (await d.confirm("Skip Telegram alerts?", false)) return undefined;
      continue;
    }
    if (!(await d.confirm("Send a test message?", true))) {
      d.saveToken(token);
      d.print("Telegram saved without a test.");
      return { chatId };
    }
    for (;;) {
      try {
        await d.send(token, chatId);
      } catch (error) {
        // Do not echo provider payloads: they may contain credentials or URLs.
        d.print(describeTelegramFailure(error));
        const next = await d.select("Telegram", [
          { value: "edit", title: "Correct settings" },
          { value: "retry", title: "Retry test" },
          { value: "skip", title: "Skip alerts" },
        ]);
        if (next === "skip") { d.print("Telegram alerts skipped."); return undefined; }
        if (next === "edit") break;
        continue;
      }
      d.saveToken(token);
      d.print("Telegram test sent.");
      return { chatId };
    }
  }
}

/**
 * Describe an already-provisioned venue account in the operator's terms, so the
 * reuse prompt shows what is at stake (the address that holds the collateral).
 */
function describeAccount(account: NonNullable<BotConfig["account"]>): string[] {
  switch (account.venue) {
    case "polymarket":
      return [
        "Trading address — Polygon pUSD only",
        account.funder,
        "Signer address",
        account.signerAddress,
      ];
    case "hyperliquid":
      return ["Master address", account.masterAddress];
    case "lighter":
      return ["L1 address", account.l1Address, ...(account.accountIndex === undefined ? [] : [`Account index: ${account.accountIndex}`])];
    case "kalshi":
      return [
        "API key ID",
        account.keyId,
      ];
    default:
      return [];
  }
}

/**
 * The EVM address a venue account is bound to, or undefined for venues with no
 * wallet identity (Kalshi authenticates with an API key; its account carries
 * no address, and the bot's master EOA stays local-only identity).
 */
function accountWalletAddress(account: NonNullable<BotConfig["account"]>): string | undefined {
  switch (account.venue) {
    case "polymarket":
      return account.signerAddress;
    case "hyperliquid":
      return account.masterAddress;
    case "lighter":
      return account.l1Address;
    case "kalshi":
      return undefined;
  }
}

function sameVenueAccountIdentity(
  left: NonNullable<BotConfig["account"]>,
  right: NonNullable<BotConfig["account"]>,
): boolean {
  if (left.venue !== right.venue) return false;
  if (left.venue === "polymarket" && right.venue === "polymarket") {
    return (
      left.signerAddress.toLowerCase() === right.signerAddress.toLowerCase() &&
      left.funder.toLowerCase() === right.funder.toLowerCase() &&
      left.signatureType === right.signatureType
    );
  }
  if (left.venue === "hyperliquid" && right.venue === "hyperliquid") {
    return (
      left.masterAddress.toLowerCase() === right.masterAddress.toLowerCase() &&
      (left.agentAddress ?? "").toLowerCase() === (right.agentAddress ?? "").toLowerCase()
    );
  }
  if (left.venue === "kalshi" && right.venue === "kalshi") {
    return left.keyId === right.keyId;
  }
  return (
    left.venue === "lighter" &&
    right.venue === "lighter" &&
    left.l1Address.toLowerCase() === right.l1Address.toLowerCase() &&
    left.accountIndex === right.accountIndex &&
    left.apiKeyIndex === right.apiKeyIndex
  );
}

/**
 * Returns the existing account when the operator wants to keep it, or undefined
 * to fall through to the adapter's provisioning flow.
 */
async function reuseExistingAccount(
  existing: BotConfig | undefined,
  venue: string,
  walletAddress: string,
): Promise<BotConfig["account"] | undefined> {
  const account = existing?.account;
  if (!account || account.venue !== venue) return undefined;
  const boundAddress = accountWalletAddress(account);
  if (boundAddress && boundAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    console.log(pc.yellow("the existing venue account belongs to a different wallet and cannot be reused"));
    return undefined;
  }

  console.log(`Existing ${venue} account`);
  for (const line of describeAccount(account)) console.log(line);
  if (await confirm("Keep it?", true)) {
    console.log("Existing account retained.");
    return account;
  }
  if (existing?.deployment) {
    throw new Error(
      "this account has a deployed runtime. Cassie will not repoint the same bot id while that deployment exists; keep the account or use a new bot id",
    );
  }
  console.log("Existing funds remain on the old account.");
  return undefined;
}

export async function runInit(): Promise<void> {
  console.log("Cassie setup");
  console.log("Experimental software. You can lose your entire balance.");
  console.log("Verify funding destinations before sending money.");
  console.log("Quotient forecasts are not trading advice.");

  const botId = (await ask("Bot id (lowercase, dashes ok)", { default: "bot-1" })).trim();
  const configPath = botConfigPath(botId);
  // Missing is a new bot; malformed/unreadable existing configs are surfaced
  // instead of being silently overwritten by a reconfiguration run.
  const existing: BotConfig | undefined = existsSync(configPath) ? loadBotConfig(botId) : undefined;
  const resumedState = loadInitState(botId);
  let state: InitState;
  let venue: BotConfig["venue"];
  if (resumedState) {
    state = resumedState;
    console.log(pc.yellow(`resuming incomplete setup for "${botId}" (${state.venue})`));
    if (!(await confirm("Resume from the last safe checkpoint?", true))) return;
    venue = state.venue;
  } else {
    if (existing && !(await confirm(`bot "${botId}" exists — reconfigure it?`, false))) return;
    const requestedVenue = (await ask("Venue (polymarket / kalshi / hyperliquid)", { default: existing?.venue ?? "polymarket" }))
      .trim()
      .toLowerCase();
    // Lighter has an adapter but is not a supported venue; the wizard does not
    // offer it, and an existing lighter config still loads.
    if (!["polymarket", "kalshi", "hyperliquid"].includes(requestedVenue)) {
      throw new Error(`unknown venue "${requestedVenue}"`);
    }
    venue = requestedVenue as BotConfig["venue"];
    state = {
      version: 1,
      botId,
      venue,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
  }
  if (existing?.deployment && venue !== existing.venue) {
    throw new Error(
      `bot "${botId}" still points at a deployed ${existing.venue} runtime. Cassie will not change its venue to ${venue}; use a new bot id or remove the existing deployment first`,
    );
  }
  if (!resumedState) saveInitState(state);
  const checkpoint = (next: InitState): void => {
    saveInitState(next);
    state = next;
  };

  // Wallet: acquire one EOA in the encrypted local keystore before any Splits
  // or venue mutation occurs.
  const ks = keystore();
  const savedIdentityAddress =
    existing?.wallet.address ?? (existing?.account ? accountWalletAddress(existing.account) : undefined);
  if (
    !state.wallet?.address &&
    !ks.entryMeta(botId, KeyRoles.master) &&
    savedIdentityAddress
  ) {
    throw new Error(
      `Local master key missing for the saved wallet:\n${savedIdentityAddress}\n` +
        "Restore the matching key or use a new bot ID.\n" +
        `cassie wallet import ${botId}`,
    );
  }
  let wallet: BotConfig["wallet"];
  if (state.wallet?.address) {
    const passphrase = await getPassphrase(botId);
    const stored = ks.getEntry(botId, KeyRoles.master, passphrase);
    if (!stored || addressFromPk(stored).toLowerCase() !== state.wallet.address.toLowerCase()) {
      throw new Error("the init checkpoint's wallet does not match the encrypted local master key");
    }
    wallet = state.wallet;
    console.log("Local wallet verified.");
    console.log(wallet.address);
  } else if (ks.entryMeta(botId, KeyRoles.master)) {
    const passphrase = await getPassphrase(botId);
    const stored = ks.getEntry(botId, KeyRoles.master, passphrase);
    if (!stored) throw new Error(`master key metadata exists for ${botId}, but the key could not be loaded`);
    const storedAddress = addressFromPk(stored);
    if (savedIdentityAddress && storedAddress.toLowerCase() !== savedIdentityAddress.toLowerCase()) {
      throw new Error(
        `Master key wallet:\n${storedAddress}\nSaved wallet:\n${savedIdentityAddress}\n` +
          "Wallets do not match. Restore the matching keystore/config pair or use a new bot ID.",
      );
    }
    wallet = { origin: "local", address: storedAddress };
    checkpoint({ ...state, wallet });
    console.log("Existing wallet retained.");
    console.log(wallet.address);
  } else {
    const passphrase = await getPassphrase(botId, !ks.exists(botId));
    if (ks.exists(botId)) ks.verifyPassphrase(botId, passphrase);
    const eoa = generateEoa();
    ks.putEntry(botId, KeyRoles.master, eoa.privateKey, passphrase, {
      address: eoa.address,
      runtimeEligible: false,
    });
    wallet = { origin: "local", address: eoa.address };
    checkpoint({ ...state, wallet });
    console.log("Local wallet created.");
    console.log(eoa.address);
  }
  if (savedIdentityAddress && wallet.address!.toLowerCase() !== savedIdentityAddress.toLowerCase()) {
    throw new Error(
      `Verified wallet:\n${wallet.address}\nSaved wallet:\n${savedIdentityAddress}\nWallets do not match; setup stopped.`,
    );
  }
  if (
    state.account &&
    existing?.deployment &&
    existing.account &&
    !sameVenueAccountIdentity(state.account, existing.account)
  ) {
    throw new Error(
      "the setup checkpoint contains a different venue account while an older deployed runtime is still attached to this bot id; use a new bot id or restore the matching checkpoint/config",
    );
  }
  const pass = await getPassphrase(botId);

  const existingAccount = existing?.account?.venue === venue ? existing.account : undefined;
  const existingAccountAddress = existingAccount ? accountWalletAddress(existingAccount) : undefined;
  if (
    existingAccount &&
    existingAccountAddress &&
    existingAccountAddress.toLowerCase() !== wallet.address!.toLowerCase()
  ) {
    console.log(pc.yellow("The saved venue account is controlled by a different wallet."));
    for (const line of describeAccount(existingAccount)) console.log(line);
    console.log("Current wallet");
    console.log(wallet.address);
    console.log("Existing funds remain on the old account.");
    if (!(await confirm("Create a new venue account?", false))) {
      return;
    }
  }

  // Optional organization-owned treasury. The safest default is passkey-only;
  // an advanced local-master signer is scoped to this new account alone.
  // Kalshi is funded by bank rails on kalshi.com, so a crypto treasury has no
  // role there and the wizard does not offer one.
  let treasury = state.treasury;
  if (
    venue !== "kalshi" &&
    !treasury &&
    !state.pendingTreasury &&
    existing?.treasury &&
    (await confirm("Keep the existing Splits treasury association?", true))
  ) {
    treasury = existing.treasury;
    checkpoint({ ...state, treasury });
  }
  if (venue !== "kalshi" && !treasury && (state.pendingTreasury || (await confirm("Create a dedicated Splits organization subaccount for this bot?", false)))) {
    treasury = await createSplitsTreasury({
      botId,
      venue,
      walletAddress: wallet.address!,
      pending: state.pendingTreasury,
      ui: {
        confirm,
        select,
        print: (message) => console.log(message),
      },
      checkpointPending(pendingTreasury) {
        checkpoint({ ...state, pendingTreasury });
      },
    });
    const { pendingTreasury: _completedPlan, ...completedState } = state;
    checkpoint({ ...completedState, treasury });
    console.log(`Splits subaccount linked: ${treasury.accountName}`);
    console.log(treasury.accountAddress);
  }

  // Venue account provisioning (wizard-driven, adapter-owned).
  // Kalshi keys are environment-scoped, so the env choice must precede setup;
  // it lives in venueUrls (like hyperliquid.testnet) and rides into the saved
  // config below.
  let venueUrlsOverride = existing?.venueUrls;
  if (venue === "kalshi") {
    console.log("Kalshi demo uses simulated funds and separate keys.");
    const useDemo = await confirm(
      "Use Kalshi demo?",
      existing?.venueUrls.kalshi.demo ?? false,
    );
    venueUrlsOverride = {
      ...(venueUrlsOverride ?? parseBotConfig({ id: botId, venue }).venueUrls),
      kalshi: { ...(venueUrlsOverride?.kalshi ?? parseBotConfig({ id: botId, venue }).venueUrls.kalshi), demo: useDemo },
    };
  }
  const setupCtx = makeSetupContext(botId);
  const adapter = createAdapter(venue, {
    urls: withOperatorRpc(parseBotConfig({ id: botId, venue, venueUrls: venueUrlsOverride })),
  });
  // An account already provisioned for this bot is reused by default: re-running
  // the wizard to change a strategy setting should never re-provision a Polymarket
  // account the operator already has (and may already have funded).
  let account = state.account;
  if (!account) {
    const provisioned = (await reuseExistingAccount(existing, venue, wallet.address!)) ?? (await adapter.setup(setupCtx));
    if (provisioned?.venue === "fixture") throw new Error("fixture accounts cannot be saved by cassie init");
    account = provisioned as NonNullable<BotConfig["account"]>;
    if (existing?.deployment && existing.account && !sameVenueAccountIdentity(account, existing.account)) {
      throw new Error(
        "venue setup resolved a different account while an older deployed runtime is still attached to this bot id; use a new bot id or keep the deployed account",
      );
    }
    checkpoint({ ...state, account });
  } else {
    console.log(pc.dim(`reusing checkpointed ${venue} account`));
  }
  if (!account) throw new Error("venue setup returned no account");

  // Quotient key first: both strategies need it (signals feed; the agent's
  // research and persona calls). A key may already be exported, in .local.env,
  // or owned by the Quotient CLI. Say exactly which source won without
  // displaying any key material.
  const discovered = discoverQuotientToken();
  if (discovered) console.log(`Quotient credential: ${discovered.origin}`);
  const token = discovered && (await confirm("Use this Quotient key?", true))
    ? discovered.token
    : (await ask("Quotient API key", { secret: true })).trim();
  if (token) ks.putEntry(botId, KeyRoles.quotientToken, token, pass, { runtimeEligible: true });

  // Strategy choice. Market making is intentionally Polymarket-only because
  // its identity, outcome-token, and passive-order contracts are venue-specific.
  const existingStrategy = (existing?.strategy.config ?? {}) as Record<string, unknown>;
  const strategyChoices = [
    {
      value: "signals",
      title: existing?.strategy.id === "signals" || existing?.strategy.id === "flip-flat" ? "signals (current)" : "signals",
      description: "follow Quotient signals, hold until the forecast converges with the price",
    },
    ...(isPredictionVenue(venue)
      ? [{
          value: "signals-hold",
          title: "signals-hold",
          description: "buy each new Quotient signal with a fixed stake, sell only if Q flips, otherwise hold to resolution",
        }]
      : []),
    {
      value: "agent",
      title: existing?.strategy.id === "agent" ? "agent (current)" : "agent",
      description: AGENT_STRATEGY_SUMMARY,
    },
    ...(venue === "polymarket"
      ? [{
          value: "market-make",
          title: existing?.strategy.id === "market-make" ? "market-make (current)" : "market-make",
          description: "Q-directed passive inventory: maker entry, convergence/risk/time exits",
        }]
      : []),
  ];
  if (venue === "kalshi") strategyChoices.unshift({ value: "kalshi-commodities", title: "kalshi-commodities", description: "oil, gold, BTC, copper and silver; diversified exact-contract Q with bounded limits" });
  if (venue === "hyperliquid") strategyChoices.splice(0, strategyChoices.length,
    { value: "quotient-swing", title: "quotient-swing", description: "1–5 day equity/commodity perps, NAV sizing, native stops" },
    { value: "signals", title: "signals", description: "legacy Quotient signal follower" });
  if (existing?.strategy.id === "quotient-swing") {
    const swing = strategyChoices.find(choice => choice.value === "quotient-swing");
    if (!swing) throw new Error("an existing quotient-swing bot must remain on Hyperliquid");
    strategyChoices.splice(0, strategyChoices.length, swing);
  }
  if (existing?.strategy.id === "market-make") {
    const marketMake = strategyChoices.find((choice) => choice.value === "market-make");
    if (!marketMake) throw new Error("an existing market-make bot must remain on Polymarket");
    strategyChoices.splice(0, strategyChoices.length, marketMake);
    console.log("Changing strategies requires a new bot ID.");
  }
  const currentStrategy = strategyChoices.findIndex((choice) =>
    choice.value === (existing?.strategy.id === "flip-flat" ? "signals" : existing?.strategy.id),
  );
  if (currentStrategy > 0) {
    const [current] = strategyChoices.splice(currentStrategy, 1);
    strategyChoices.unshift(current!);
  }
  const strategyChoice = isPredictionVenue(venue) || venue === "hyperliquid" ? await select("Strategy", strategyChoices) : "signals";
  // The hold preset is the signals strategy with its knobs set; the bot keeps the `signals` id.
  const holdPreset = strategyChoice === "signals-hold";
  const strategyId = holdPreset ? "signals" : strategyChoice;
  requireSafeStrategyTransition(existing?.strategy.id, strategyId);

  let strategyConfig: Record<string, unknown>;
  let tickIntervalMin: number;
  if (strategyId === "kalshi-commodities") {
    strategyConfig = CommodityConfigSchema.parse(existing?.strategy.id === strategyId ? existingStrategy : {});
    tickIntervalMin = 1;
    console.log("Commodity entries: bounded limits, one position per asset.");
    console.log("Gross premium limit: 10% of capital.");
    console.log("Trading starts paused.");
  } else if (strategyId === "quotient-swing") {
    strategyConfig = QuotientSwingConfigSchema.parse(existing?.strategy.id === "quotient-swing" ? existingStrategy : {});
    tickIntervalMin = Number(strategyConfig.tickIntervalMin);
    console.log("Running or deploying starts live trading.");
    console.log("Collateral: Standard account mode, xyz USDC balance.");
    console.log("Planned stop risk: 5–10% of NAV per trade.");
    console.log("Gross exposure limit: 4× NAV.");
    console.log("Gaps and liquidation can exceed planned losses.");
    const found = discoverSurplusApiKey();
    const surplusKey = found?.value ?? (await ask("Surplus Intelligence API key", { secret: true })).trim();
    if (!surplusKey) throw new Error("quotient-swing requires a Surplus Intelligence API key");
    await verifySurplusApiKey(surplusKey);
    ks.putEntry(botId, KeyRoles.surplusApiKey, surplusKey, pass, { runtimeEligible: true });
  } else if (strategyId === "agent") {
    console.log("Agent strategy: model-selected entries, quarter-Kelly sizing.");
    strategyConfig = await elicitAgentConfig(existing?.strategy.id === "agent" ? existingStrategy : {});

    // SURPLUS_API_KEY is a hard prerequisite for this strategy: discover it,
    // store it runtime-eligible, and verify it live before saving the config.
    const discoveredSurplus = discoverSurplusApiKey();
    if (discoveredSurplus) console.log(`Surplus credential: ${discoveredSurplus.origin}`);
    const surplusKey = discoveredSurplus
      ? discoveredSurplus.value
      : (await ask("Surplus Intelligence API key", { secret: true })).trim();
    if (!surplusKey) throw new Error("the agent strategy requires a Surplus Intelligence API key");
    ks.putEntry(botId, KeyRoles.surplusApiKey, surplusKey, pass, { runtimeEligible: true });
    await verifySurplusApiKey(surplusKey);
    console.log("Surplus key verified.");

    console.log("Persona lookup costs $1.");
    const personaHandle = (await ask('Persona X handle (or "none")', {
      default: (strategyConfig.persona as { handle?: string } | undefined)?.handle ?? "none",
    })).trim();
    if (personaHandle && personaHandle.toLowerCase() !== "none") {
      const probe = parseBotConfig({ id: botId, venue, venueUrls: venueUrlsOverride });
      const persona = await fetchAndStorePersona(botId, probe, personaHandle);
      if (persona) strategyConfig = { ...strategyConfig, persona };
    }
    // Engine ticks stay cheap housekeeping between paid wakes.
    tickIntervalMin = 15;
  } else if (strategyId === "market-make") {
    console.log("Market-make strategy: Q-directed passive inventory.");
    console.log("Sizing follows funded capital.");
    strategyConfig = structuredClone(
      existing?.strategy.id === "market-make"
        ? MarketMakeConfigSchema.parse(existingStrategy)
        : MARKET_MAKE_PRESET,
    ) as unknown as Record<string, unknown>;
    tickIntervalMin = MarketMakeConfigSchema.parse(strategyConfig).reconciliation.rest_reconcile_seconds / 60;
  } else if (holdPreset) {
    console.log("Signals strategy, hold preset: each new Quotient signal held to resolution unless Q flips.");
    for (const rule of HOLD_SUMMARY.split(", ")) console.log(rule);
    if (venue === "polymarket") console.log(QUOTIENT_POLYMARKET_FEE_DISCLOSURE);
    const lotRaw = await ask("Stake per signal ($)", {
      default: String(existingStrategy.lotNotionalUsd ?? HOLD_STRATEGY.lotNotionalUsd),
    });
    const lotNotionalUsd = Number(lotRaw);
    if (!Number.isFinite(lotNotionalUsd) || lotNotionalUsd <= 0) throw new Error("stake per signal must be greater than zero");
    strategyConfig = { ...HOLD_STRATEGY, lotNotionalUsd };
    tickIntervalMin = HOLD_STRATEGY.tickIntervalMin;
  } else {
    console.log("Signals strategy: published Quotient signals.");
    for (const rule of recommendedStrategySummary(venue).split(", ")) console.log(rule);
    if (venue === "polymarket") console.log(QUOTIENT_POLYMARKET_FEE_DISCLOSURE);
    strategyConfig = (await confirm("Use recommended allocation rules?", true))
      ? await elicitRecommendedStrategyConfig(existingStrategy, venue)
      : await elicitStrategyConfig(existingStrategy, venue);
    tickIntervalMin = Number(strategyConfig.tickIntervalMin ?? 1);
  }

  // Alerts: Telegram only in MVP.
  const localTelegram = localTelegramSettings();
  const telegram = await configureInitTelegram(existing?.alerts.telegram, {
    ask, confirm, select,
    local: { token: localTelegram.token?.value, chatId: localTelegram.chatId?.value, tokenOrigin: localTelegram.token?.origin, chatIdOrigin: localTelegram.chatId?.origin },
    print: message => console.log(message),
    send: (token, chatId) => new TelegramAlerter(token, chatId).send({ kind: "test", botId, message: "Cassie alert test" }),
    saveToken: token => ks.putEntry(botId, KeyRoles.telegramToken, token, pass, { runtimeEligible: true }),
  });

  const cfg = parseBotConfig({
    id: botId,
    venue,
    account,
    wallet,
    treasury,
    strategy: {
      id: strategyId,
      config: strategyConfig,
    },
    risk: strategyId === "kalshi-commodities" ? { ...existing?.risk, minDailyVolume: 0, depthCapPct: 2, minViableNotional: 1, maxOrderNotional: 100, slippagePct: 3 } : existing?.risk,
    signals: strategyId === "kalshi-commodities" ? { ...existing?.signals, maxAgeSec: Number(strategyConfig.maxForecastAgeHours) * 3600 } : existing?.signals ?? {},
    execution: strategyId === "kalshi-commodities" ? { mode: "adaptive", entryDeadlineSec: strategyConfig.entryDeadlineSec, exitPassiveSec: strategyConfig.exitPassiveSec } : existing?.execution,
    alerts: { ...existing?.alerts, telegram },
    venueUrls: venueUrlsOverride,
    tickIntervalMin,
    deployment: existing?.deployment,
    createdAt: state.createdAt,
  });
  // Recovery boundary: the complete bot and venue identity are durable before
  // any deposit address is shown or any deployment work begins.
  commitInitConfig(cfg);
  console.log("Configuration saved.");
  console.log(botConfigPath(botId));
  if (existing?.deployment) {
    console.log("Droplet configuration unchanged until deployment.");
    console.log(`cassie deploy ${botId}`);
  }

  if (venue === "polymarket") {
    // Show the bridge-issued destination inside init itself. The trading
    // address printed during account setup is not a general deposit address.
    const instructions = await adapter.fundingInstructions(account);
    const bridge = instructions.addresses.find((address) => address.chain === "evm");
    if (!bridge) throw new Error("Polymarket bridge returned no EVM deposit address");
    console.log(pc.bold("\nFunding"));
    console.log(`Bridge deposit: ${bridge.asset}, supported EVM chains only.`);
    console.log(bridge.address);
    if (treasury) {
      console.log("Splits funding proposal unavailable: bridge route not verified.");
      console.log("Verify the source chain and token before transferring.");
    }
    if (await confirm("Continue funding?", true)) {
      await runFund(botId, {});
    } else {
      console.log(`cassie fund ${botId}`);
    }
  } else if (await confirm("Run the funding flow now?", true)) {
    if (venue === "hyperliquid" && treasury && !cfg.venueUrls.hyperliquid.testnet) {
      const source = await select("Fund the Hyperliquid master from", [
        {
          value: "splits",
          title: `Splits · ${treasury.accountName}`,
          description: "Approve an Arbitrum USDC transfer with your passkey.",
        },
        {
          value: "external",
          title: "Another wallet or exchange",
          description: "Send USDC and gas ETH.",
        },
      ]);
      await runFund(botId, source === "splits" ? { from: "splits" } : {});
    } else {
      if (venue === "lighter" && treasury) {
        console.log("Lighter sending address");
        console.log(treasury.accountAddress);
        console.log("Use this sender and the same chain for the Splits transfer.");
      }
      await runFund(botId, {});
    }
  } else {
    console.log(`cassie fund ${botId}`);
  }
  await offerInitDeployment(botId, Boolean(existing?.deployment));
}

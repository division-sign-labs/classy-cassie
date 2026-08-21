// packages/cli/src/commands/init.ts
// The wizard (§6, acceptance 1): bot created end-to-end without leaving the
// terminal except to copy-paste dashboard values.

import pc from "picocolors";
import { existsSync } from "node:fs";
import {
  addressFromPk,
  KeyRoles,
  TelegramAlerter,
  createAdapter,
  generateEoa,
  parseBotConfig,
  type BotConfig,
} from "@quotient-forecasting/cassie-core";
import { ask, confirm, getPassphrase, keystore, makeSetupContext, select } from "../context.js";
import { clearInitState, loadInitState, saveInitState, type InitState } from "../init-state.js";
import { botConfigPath, loadBotConfig, saveBotConfig } from "../paths.js";
import { createSplitsTreasury } from "../splits-init.js";
import { discoverQuotientToken } from "../quotient-token.js";
import { discoverAresApiKey, discoverAresBuilderCode, verifyAresApiKey } from "../ares-config.js";
import { RECOMMENDED_SUMMARY, elicitRecommendedStrategyConfig, elicitStrategyConfig } from "./strategy.js";
import { runFund } from "./fund.js";

/**
 * Describe an already-provisioned venue account in the operator's terms, so the
 * reuse prompt shows what is at stake (the address that holds the collateral).
 */
function describeAccount(account: NonNullable<BotConfig["account"]>): string[] {
  switch (account.venue) {
    case "polymarket":
      return [
        `trading address:       ${account.funder}`,
        "Polygon pUSD only.",
        `signer (signs orders): ${account.signerAddress}`,
      ];
    case "hyperliquid":
      return [`master address: ${account.masterAddress}`];
    case "lighter":
      return [`L1 address: ${account.l1Address}`, ...(account.accountIndex === undefined ? [] : [`account index: ${account.accountIndex}`])];
    default:
      return [];
  }
}

function accountWalletAddress(account: NonNullable<BotConfig["account"]>): string {
  switch (account.venue) {
    case "polymarket":
      return account.signerAddress;
    case "hyperliquid":
      return account.masterAddress;
    case "lighter":
      return account.l1Address;
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
  if (accountWalletAddress(account).toLowerCase() !== walletAddress.toLowerCase()) {
    console.log(pc.yellow("the existing venue account belongs to a different wallet and cannot be reused"));
    return undefined;
  }

  console.log(pc.bold(`\nThis bot already has a ${venue} account:`));
  for (const line of describeAccount(account)) console.log(`  ${line}`);
  if (await confirm("Keep it?", true)) {
    console.log(pc.dim("keeping the existing account — no new wallet is created."));
    return account;
  }
  if (existing?.deployment) {
    throw new Error(
      "this account has a deployed runtime. Cassie will not repoint the same bot id while that deployment exists; keep the account or use a new bot id",
    );
  }
  console.log(pc.yellow("provisioning a new account; funds on the old one stay where they are."));
  return undefined;
}

export async function runInit(): Promise<void> {
  console.log(pc.bold(pc.cyan("\nC A S S I E\n")));
  console.log("Cassie is experimental, open-source software.");
  console.log("Check every funding destination carefully: something may go wrong, and you may lose funds.");
  console.log("Quotient is a publisher; its signals are informational and are not trading advice.\n");
  console.log(pc.bold("Set up a trading bot: wallet, venue, strategy, alerts, funding.\n"));

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
    const requestedVenue = (await ask("Venue (polymarket / hyperliquid / lighter)", { default: existing?.venue ?? "polymarket" }))
      .trim()
      .toLowerCase();
    if (!["polymarket", "hyperliquid", "lighter"].includes(requestedVenue)) {
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
      `the saved bot identifies wallet ${savedIdentityAddress}, but its local master key is missing. ` +
        `Cassie will not replace a potentially funded identity. Restore it with \`cassie wallet import ${botId}\`, ` +
        "or use a new bot id for a new wallet.",
    );
  }
  let wallet: BotConfig["wallet"];
  if (state.wallet?.address) {
    const passphrase = await getPassphrase();
    const stored = ks.getEntry(botId, KeyRoles.master, passphrase);
    if (!stored || addressFromPk(stored).toLowerCase() !== state.wallet.address.toLowerCase()) {
      throw new Error("the init checkpoint's wallet does not match the encrypted local master key");
    }
    wallet = state.wallet;
    console.log(pc.dim(`reusing verified local wallet ${wallet.address}`));
  } else if (ks.entryMeta(botId, KeyRoles.master)) {
    const passphrase = await getPassphrase();
    const stored = ks.getEntry(botId, KeyRoles.master, passphrase);
    if (!stored) throw new Error(`master key metadata exists for ${botId}, but the key could not be loaded`);
    const storedAddress = addressFromPk(stored);
    if (savedIdentityAddress && storedAddress.toLowerCase() !== savedIdentityAddress.toLowerCase()) {
      throw new Error(
        `the encrypted master key derives ${storedAddress}, but the saved bot identifies ${savedIdentityAddress}. ` +
          "Restore the matching keystore/config pair or use a new bot id; Cassie will not replace either identity.",
      );
    }
    wallet = { origin: "local", address: storedAddress };
    checkpoint({ ...state, wallet });
    console.log(pc.dim(`reusing existing master key for ${botId} (${wallet.address})`));
  } else {
    const passphrase = await getPassphrase(!ks.exists(botId));
    if (ks.exists(botId)) ks.verifyPassphrase(botId, passphrase);
    const eoa = generateEoa();
    ks.putEntry(botId, KeyRoles.master, eoa.privateKey, passphrase, {
      address: eoa.address,
      runtimeEligible: false,
    });
    wallet = { origin: "local", address: eoa.address };
    checkpoint({ ...state, wallet });
    console.log(`generated local wallet: ${pc.green(eoa.address)}`);
  }
  if (savedIdentityAddress && wallet.address!.toLowerCase() !== savedIdentityAddress.toLowerCase()) {
    throw new Error(
      `the verified wallet ${wallet.address} does not match saved bot identity ${savedIdentityAddress}; refusing external setup`,
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
  const pass = await getPassphrase();

  const existingAccount = existing?.account?.venue === venue ? existing.account : undefined;
  if (
    existingAccount &&
    accountWalletAddress(existingAccount).toLowerCase() !== wallet.address!.toLowerCase()
  ) {
    console.log(pc.yellow("The saved venue account is controlled by a different wallet."));
    for (const line of describeAccount(existingAccount)) console.log(`  ${line}`);
    console.log(pc.dim(`current verified wallet: ${wallet.address}`));
    if (!(await confirm("Continue by provisioning a new venue account? Existing funds stay on the old account.", false))) {
      return;
    }
  }

  // Optional organization-owned treasury. The safest default is passkey-only;
  // an advanced local-master signer is scoped to this new account alone.
  let treasury = state.treasury;
  if (
    !treasury &&
    !state.pendingTreasury &&
    existing?.treasury &&
    (await confirm("Keep the existing Splits treasury association?", true))
  ) {
    treasury = existing.treasury;
    checkpoint({ ...state, treasury });
  }
  if (!treasury && (state.pendingTreasury || (await confirm("Create a dedicated Splits organization subaccount for this bot?", false)))) {
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
    console.log(pc.green(`Splits subaccount created and linked: ${treasury.accountName} (${treasury.accountAddress})`));
  }

  // Venue account provisioning (wizard-driven, adapter-owned).
  const setupCtx = makeSetupContext(botId);
  const adapter = createAdapter(venue, {
    urls: parseBotConfig({ id: botId, venue, venueUrls: existing?.venueUrls }).venueUrls,
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

  // Strategy: one strategy (signals); recommended settings in one keystroke.
  console.log(pc.bold("\nStrategy: signals — follow Quotient signals, hold until the forecast converges with the price."));
  console.log(pc.dim(`Recommended: ${RECOMMENDED_SUMMARY}.`));
  const existingStrategy = (existing?.strategy.config ?? {}) as Record<string, unknown>;
  const strategyConfig: Record<string, unknown> = (await confirm("Use recommended allocation rules?", true))
    ? await elicitRecommendedStrategyConfig(existingStrategy)
    : await elicitStrategyConfig(existingStrategy);
  const tickIntervalMin = Number(strategyConfig.tickIntervalMin ?? 5);

  // A key may already be exported, in .local.env, or owned by the Quotient
  // CLI. Say exactly which source won without displaying any key material.
  const discovered = discoverQuotientToken();
  if (discovered) console.log(pc.dim(`found a Quotient API key from ${discovered.origin}`));
  const token = discovered && (await confirm("Use that key for live signals?", true))
    ? discovered.token
    : (await ask("Quotient API key", { secret: true })).trim();
  if (token) ks.putEntry(botId, KeyRoles.quotientToken, token, pass, { runtimeEligible: true });

  // Alerts: Telegram only in MVP.
  let telegram: { chatId: string } | undefined = existing?.alerts.telegram;
  if (await confirm("Wire Telegram alerts now?", true)) {
    console.log(pc.dim("Token from @BotFather, chat id from @userinfobot."));
    const tgToken = (await ask("Telegram bot token", { secret: true })).trim();
    const chatId = (await ask("Telegram chat id")).trim();
    if (tgToken && chatId) {
      ks.putEntry(botId, KeyRoles.telegramToken, tgToken, pass, { runtimeEligible: true });
      telegram = { chatId };
      if (await confirm("Send a test ping now?", true)) {
        try {
          await new TelegramAlerter(tgToken, chatId).send({ kind: "test", botId, message: "cassie is wired up 🎉" });
          console.log(pc.green("telegram ping sent"));
        } catch (err) {
          console.log(pc.yellow(`telegram test failed: ${(err as Error).message} — continuing`));
        }
      }
    }
  }

  // Ares is explicitly per bot. Finding credentials never enables it by
  // itself; the operator opts this Polymarket bot into attribution + posts.
  let reporting: BotConfig["reporting"];
  if (venue === "polymarket" && (await confirm("Publish this bot's verified position cards to Ares?", Boolean(existing?.reporting)))) {
    const discoveredBuilder = discoverAresBuilderCode();
    const builderCode =
      discoveredBuilder?.value ??
      existing?.reporting?.builderCode ??
      (await ask("Ares builder code (0x + 64 hex)")).trim();
    if (discoveredBuilder) console.log(pc.dim(`found the Ares builder code in ${discoveredBuilder.origin}`));

    const discoveredKey = discoverAresApiKey();
    let apiKey = discoveredKey?.value;
    if (discoveredKey) console.log(pc.dim(`found an Ares API key in ${discoveredKey.origin}`));
    if (!apiKey) {
      apiKey = (await ask("Ares API key", { secret: true })).trim();
      if (apiKey) ks.putEntry(botId, KeyRoles.aresApiKey, apiKey, pass, { runtimeEligible: true });
    }
    if (!apiKey) throw new Error("Ares posting was enabled without an API key");
    const username = await verifyAresApiKey(apiKey, existing?.reporting?.baseUrl);
    console.log(pc.green(`Ares key verified for @${username}`));
    reporting = {
      provider: "ares",
      builderCode,
      post: true,
      postOn: existing?.reporting?.postOn ?? ["entry", "exit"],
      baseUrl: existing?.reporting?.baseUrl ?? "https://api.ares.pro",
    };
  }

  const cfg = parseBotConfig({
    id: botId,
    venue,
    account,
    wallet,
    treasury,
    strategy: {
      id: "signals",
      config: strategyConfig,
    },
    risk: existing?.risk,
    signals: existing?.signals ?? {},
    alerts: { ...existing?.alerts, telegram },
    reporting,
    venueUrls: existing?.venueUrls,
    tickIntervalMin,
    deployment: existing?.deployment,
    createdAt: state.createdAt,
  });
  saveBotConfig(cfg);
  clearInitState(botId);
  console.log(pc.green(`\nsaved ${botConfigPath(botId)}`));
  if (existing?.deployment) {
    console.log(pc.yellow(`The droplet still runs the old configuration. Apply this one with cassie deploy ${botId}.`));
  }

  if (venue === "polymarket") {
    // Show the bridge-issued destination inside init itself. The trading
    // address printed during account setup is not a general deposit address.
    const instructions = await adapter.fundingInstructions(account);
    const bridge = instructions.addresses.find((address) => address.chain === "evm");
    if (!bridge) throw new Error("Polymarket bridge returned no EVM deposit address");
    console.log(pc.bold("\nFunding"));
    console.log(`Bridge deposit address (${bridge.asset} on a supported EVM chain): ${pc.green(bridge.address)}`);
    if (treasury) {
      console.log(
        pc.yellow(
          "Splits is linked, but Cassie will not construct this proposal until it can validate the bridge's live source-chain/token route. Use the shown address with a currently supported route in Splits, then continue here to wait for credit.",
        ),
      );
    }
    if (await confirm("Continue the funding flow and wait for credit now?", true)) {
      await runFund(botId, {});
    } else {
      console.log(pc.dim(`fund later with: cassie fund ${botId}`));
    }
  } else if (await confirm("Run the funding flow now?", true)) {
    if (venue === "hyperliquid" && treasury && !cfg.venueUrls.hyperliquid.testnet) {
      const source = await select("Fund the Hyperliquid master from", [
        {
          value: "splits",
          title: `Splits · ${treasury.accountName}`,
          description: "Create an Arbitrum native-USDC proposal, approve it with your passkey, then bridge.",
        },
        {
          value: "external",
          title: "Another wallet or exchange",
          description: "Use the ordinary USDC + ETH funding instructions.",
        },
      ]);
      await runFund(botId, source === "splits" ? { from: "splits" } : {});
    } else {
      if (venue === "lighter" && treasury) {
        console.log(
          pc.yellow(
            `When Lighter asks for the sending address, enter the Splits account ${treasury.accountAddress}; its intent is sender-bound. Then propose the same-chain transfer in Splits.`,
          ),
        );
      }
      await runFund(botId, {});
    }
  } else {
    console.log(pc.dim(`fund later with: cassie fund ${botId}`));
  }
  console.log(pc.bold(`\nbot "${botId}" ready. Try: cassie run ${botId}`));
}

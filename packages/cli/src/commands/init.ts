// packages/cli/src/commands/init.ts
// The wizard (§6, acceptance 1): bot created end-to-end without leaving the
// terminal except to copy-paste dashboard values.

import pc from "picocolors";
import {
  KeyRoles,
  TelegramAlerter,
  createAdapter,
  generateEoa,
  parseBotConfig,
  type BotConfig,
} from "@quotient-forecasting/cassie-core";
import { ask, confirm, getPassphrase, keystore, makeSetupContext } from "../context.js";
import { botConfigPath, loadBotConfig, saveBotConfig } from "../paths.js";
import { discoverQuotientToken } from "../quotient-token.js";
import { discoverAresApiKey, discoverAresBuilderCode, verifyAresApiKey } from "../ares-config.js";
import { RECOMMENDED_STRATEGY, RECOMMENDED_SUMMARY, elicitStrategyConfig } from "./strategy.js";
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

/**
 * Returns the existing account when the operator wants to keep it, or undefined
 * to fall through to the adapter's provisioning flow.
 */
async function reuseExistingAccount(
  existing: BotConfig | undefined,
  venue: string,
): Promise<BotConfig["account"] | undefined> {
  const account = existing?.account;
  if (!account || account.venue !== venue) return undefined;

  console.log(pc.bold(`\nThis bot already has a ${venue} account:`));
  for (const line of describeAccount(account)) console.log(`  ${line}`);
  if (await confirm("Keep it?", true)) {
    console.log(pc.dim("keeping the existing account — no new wallet is created."));
    return account;
  }
  console.log(pc.yellow("provisioning a new account; funds on the old one stay where they are."));
  return undefined;
}

export async function runInit(): Promise<void> {
  console.log(pc.bold("cassie init — set up a trading bot: wallet, venue, strategy, alerts, funding.\n"));

  const botId = (await ask("Bot id (lowercase, dashes ok)", { default: "bot-1" })).trim();
  let existing: BotConfig | undefined;
  try {
    existing = loadBotConfig(botId);
  } catch {
    /* new bot */
  }
  if (existing && !(await confirm(`bot "${botId}" exists — reconfigure it?`, false))) return;

  const venue = (await ask("Venue (polymarket / hyperliquid / lighter)", { default: "polymarket" }))
    .trim()
    .toLowerCase();
  if (!["polymarket", "hyperliquid", "lighter"].includes(venue)) {
    throw new Error(`unknown venue "${venue}"`);
  }

  // Wallet: per-bot EOA in the encrypted keystore.
  const ks = keystore();
  const pass = await getPassphrase(!ks.exists(botId));
  if (!ks.entryMeta(botId, KeyRoles.master)) {
    const eoa = generateEoa();
    ks.putEntry(botId, KeyRoles.master, eoa.privateKey, pass, { address: eoa.address, runtimeEligible: false });
    console.log(`generated bot signer: ${pc.green(eoa.address)}`);
    console.log(pc.dim("  This signs orders. It holds no collateral — the funding step gives you a deposit address."));
  } else {
    console.log(pc.dim(`reusing existing master key for ${botId}`));
  }

  // Venue account provisioning (wizard-driven, adapter-owned).
  const setupCtx = makeSetupContext(botId);
  const adapter = createAdapter(venue as BotConfig["venue"], {
    urls: parseBotConfig({ id: botId, venue }).venueUrls,
  });
  // An account already provisioned for this bot is reused by default: re-running
  // the wizard to change a strategy setting should never re-prompt for a Deposit
  // Wallet the operator already has (and may already have funded).
  const account = (await reuseExistingAccount(existing, venue)) ?? (await adapter.setup(setupCtx));

  // Strategy: one strategy (signals); recommended settings in one keystroke.
  console.log(pc.bold("\nStrategy: signals — follow Quotient signals, hold until the side flips."));
  console.log(pc.dim(`Recommended: ${RECOMMENDED_SUMMARY}.`));
  const strategyConfig: Record<string, unknown> = (await confirm("Use recommended settings?", true))
    ? { ...RECOMMENDED_STRATEGY }
    : await elicitStrategyConfig();
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
  let telegram: { chatId: string } | undefined;
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
    strategy: {
      id: "signals",
      config: strategyConfig,
    },
    signals: {},
    alerts: { telegram },
    reporting,
    tickIntervalMin,
    createdAt: new Date().toISOString(),
  });
  saveBotConfig(cfg);
  console.log(pc.green(`\nsaved ${botConfigPath(botId)}`));

  if (venue === "polymarket") {
    // Show the bridge-issued destination inside init itself. The trading
    // address printed during account setup is not a general deposit address.
    const instructions = await adapter.fundingInstructions(account);
    const bridge = instructions.addresses.find((address) => address.chain === "evm");
    if (!bridge) throw new Error("Polymarket bridge returned no EVM deposit address");
    console.log(pc.bold("\nFunding"));
    console.log(`Bridge deposit address (${bridge.asset} on a supported EVM chain): ${pc.green(bridge.address)}`);
    if (await confirm("Continue the funding flow and wait for credit now?", true)) {
      await runFund(botId, {});
    } else {
      console.log(pc.dim(`fund later with: cassie fund ${botId}`));
    }
  } else if (await confirm("Run the funding flow now?", true)) {
    await runFund(botId, {});
  } else {
    console.log(pc.dim(`fund later with: cassie fund ${botId}`));
  }
  console.log(pc.bold(`\nbot "${botId}" ready. Try: cassie run ${botId}`));
}

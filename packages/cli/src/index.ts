#!/usr/bin/env node
// packages/cli/src/index.ts
// The `cassie` binary.

import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { runInit } from "./commands/init.js";
import { walletCreate, walletExport, walletImport, walletList } from "./commands/wallet.js";
import { registerSplitsSigner, runFund } from "./commands/fund.js";
import { runWithdraw } from "./commands/withdraw.js";
import { runStrategy } from "./commands/strategy.js";
import { runBot } from "./commands/run.js";
import { alertsTest, showOrders, showPortfolio, venueStatus } from "./commands/ops.js";
import { runSsh, showLogs, showStatus } from "./commands/monitor.js";
import { runTrade } from "./commands/trade.js";
import { runDeploy } from "./commands/deploy.js";
import { runDestroy } from "./commands/destroy.js";
import { agentDryRun, agentPersona, agentPrompt, agentStatus } from "./commands/agent.js";
import { configureSignalsKey } from "./commands/signals-key.js";
import { configureStrategyKey } from "./commands/strategy-key.js";
import { installSkill } from "./commands/skill.js";
import { changePassphrase, forgetPassphrase, passphraseStatus, rememberPassphrase } from "./commands/passphrase.js";
import { cliVersion } from "./version.js";
import { configureSwing, swingStatus, swingDryRun, swingHalt, swingResume, swingReplay } from "./commands/swing.js";
import { configureCommodities, scanCommodities, commodityStatus, commodityDryRun, commodityHalt, commodityResume, commodityHistory } from "./commands/commodities.js";

export const program = new Command();

program
  .name("cassie")
  .description("self-hosted trading bots")
  .version(cliVersion());

program.command("init").description("create or finish setting up a bot").action(wrap(runInit));

const commodities = program.command("commodities").description("Kalshi oil, gold, BTC, copper and silver strategy");
commodities.command("scan").option("--equity <usd>", "hypothetical flat portfolio equity", "1000").option("--config <file>", "strategy JSON")
  .option("--output <file>", "save full research and decision JSON").description("preview public markets; no exchange credentials or orders").action(wrap(scanCommodities));
commodities.command("configure <botId>").option("--config <file>", "strategy JSON").option("--execution <style>", "marketable or adaptive")
  .description("configure a stopped commodity bot").action(wrap(configureCommodities));
commodities.command("status <botId>").description("risk, decisions and managed orders").action(wrap(commodityStatus));
commodities.command("dry-run <botId>").option("--output <file>", "save decision JSON").description("preview against current account without orders").action(wrap(commodityDryRun));
commodities.command("halt <botId>").description("pause trading and cancel working orders").action(wrap(commodityHalt));
commodities.command("history <botId>").option("--from <iso>", "inclusive start").option("--until <iso>", "inclusive end")
  .option("--limit <count>", "maximum frames, 1–10000", "100").option("--output <file>", "save observations JSON")
  .description("export recorded inputs and decisions for forward evaluation").action(wrap(commodityHistory));
commodities.command("resume <botId>").option("--acknowledge-loss-reset", "reset reviewed loss limits while flat")
  .description("explicitly activate automated trading").action(wrap(commodityResume));

const swing = program.command("swing").description("Quotient equity and commodity perps");
swing.command("configure <botId>").option("--config <file>", "strategy JSON")
  .action(wrap(configureSwing));
swing.command("status <botId>").description("NAV, risk, research, and protection").action(wrap(swingStatus));
swing.command("dry-run <botId>").description("refresh research and preview decisions without orders").action(wrap(swingDryRun));
swing.command("halt <botId>").description("halt additions; keep native stops and exit supervision").action(wrap(swingHalt));
swing.command("resume <botId>").option("--acknowledge-loss-reset", "request a separately confirmed drawdown reset").description("resume after an operator or execution halt").action(wrap(swingResume));
swing.command("replay <botId>").option("--from <iso>", "inclusive recording start").option("--until <iso>", "inclusive recording end")
  .option("--costs <multiplier>", "fee/slippage stress multiplier, minimum 1", "1").option("--fill-model <model>", "cross or touch", "cross")
  .description("replay recorded market data").action(wrap(swingReplay));

const wallet = program.command("wallet").description("encrypted bot wallets");
wallet.command("create <botId>").description("create a bot wallet").action(wrap(walletCreate));
wallet.command("import <botId>").description("import a private key via stdin").action(wrap(walletImport));
wallet
  .command("export <botId>")
  .description("print the raw private key (requires --yes-print-my-key)")
  .option("--yes-print-my-key", "explicitly allow printing the key")
  .action(wrap(walletExport));
wallet.command("list").description("list bots and key roles").action(wrap(walletList));
wallet
  .command("register-splits <botId>")
  .description("print the Splits signer registration command")
  .action(wrap(registerSplitsSigner));

const passphrase = program.command("passphrase").description("local keystore passphrase management");
passphrase
  .command("change <botId>")
  .description("re-encrypt every local keystore entry under a new passphrase")
  .action(wrap(changePassphrase));
passphrase
  .command("remember <botId>")
  .description("save a verified passphrase in the system credential store")
  .action(wrap(rememberPassphrase));
passphrase
  .command("forget <botId>")
  .description("remove a passphrase from the system credential store")
  .action(wrap(forgetPassphrase));
passphrase.command("status <botId>").description("show whether a passphrase is saved").action(wrap(passphraseStatus));

program
  .command("fund <botId>")
  .description("fund a bot")
  .option("--from <source>", "treasury source: splits")
  .action(wrap(runFund));

program
  .command("withdraw <botId> <amount>")
  .description("withdraw collateral to an external address (amount in USD, or 'all')")
  .option("--to <address>", "destination address")
  .option("-y, --yes", "skip confirmation")
  .action(wrap(runWithdraw));

program
  .command("run <botId>")
  .description("run the bot locally (Ctrl-C cancels resting orders)")
  .option("--debug", "debug logging")
  .action(wrap(runBot));

program
  .command("deploy <botId>")
  .option("--from-workspace", "deploy this checkout")
  .description("deploy to DigitalOcean")
  .option("--region <slug>", "droplet region (default: blr1)")
  .option("--size <slug>", "droplet size (default: s-1vcpu-1gb)")
  .option("-y, --yes", "skip confirmation")
  .action(wrap(runDeploy));

program
  .command("destroy <botId>")
  .description("cancel resting orders and delete the bot's droplet")
  .option("-y, --yes", "skip confirmation")
  .option("--force", "delete without stopping the bot first")
  .action(wrap(runDestroy));

program
  .command("status <botId>")
  .description("show bot status")
  .action(wrap(showStatus));

program
  .command("ssh <botId>")
  .description("open a shell on the bot's droplet")
  .action(wrap(runSsh));

program
  .command("signals-key <botId> [key]")
  .description("pin this bot's Quotient signals key to its own keystore")
  .option("--auto", "unpin: resolve the key from .local.env, the environment, then the keystore")
  .action(wrap(configureSignalsKey));

program
  .command("strategy-key <botId> [key]")
  .description("store the strategy-scoped Quotient key (qsk_…) the signals strategy runs on")
  .option("--status", "show which source the next run or deployment would use")
  .action(wrap(configureStrategyKey));

program.command("portfolio [botId]").description("balances, positions, orders, PnL (per bot and aggregate)").action(wrap(showPortfolio));

program
  .command("orders <botId>")
  .description("list/cancel open orders")
  .option("--cancel <id>", "cancel one order")
  .option("--cancel-all", "cancel all orders")
  .action(wrap(showOrders));

program
  .command("trade <botId> [side] [marketRef]")
  .description("place a trade")
  .option("--size <n>", "size in base units (shares/contracts)")
  .option("--limit <px>", "limit price (default: crossing limit within slippage band)")
  .option("--tif <tif>", "gtc|ioc|fok", "gtc")
  .option("--stop <px>", "stop trigger (native on Hyperliquid, synthetic on Polymarket)")
  .option("--trail <bps>", "trailing stop distance in bps (engine-managed)")
  .option("--tp <px>", "take-profit trigger")
  .option("--outcome <yes|no>", "prediction venues: which outcome token")
  .option("--note <text>", "operator rationale included in the order alert")
  .option("--slippage <pct>", "max book walk from the best price, as a percentage (default: bot risk config)")
  .option("--thesis", "build a trade from a thesis")
  .option("--save <file>", "with --thesis: also save the thesis JSON for reuse")
  .option("--from-thesis <file>", "place from a saved thesis JSON")
  .option("--mappings <file>", "alternative thesis mappings file")
  .option("-y, --yes", "skip confirmation")
  .action(wrap(runTrade));

program
  .command("logs <botId>")
  .description("recent log lines from the droplet's journal")
  .option("--tail <n>", "last N lines", "200")
  .option("-f, --follow", "stream new lines until Ctrl-C")
  .option("--since <when>", "start from a time journalctl understands, e.g. '1 hour ago'")
  .option("--errors", "read the engine's recorded errors instead of the journal")
  .option("--level <level>", "with --errors: error|warn|info")
  .action(wrap(showLogs));

const alerts = program.command("alerts").description("alerting");
alerts.command("test <botId>").description("send a Telegram test ping").action(wrap(alertsTest));

program
  .command("strategy <botId>")
  .description("view or change strategy settings")
  .option("--execution <adaptive|legacy>", "Polymarket signals: managed post-only limits or legacy crossing limits")
  .option("--entry-deadline-seconds <seconds>", "Polymarket signals: deadline for an adaptive entry (default 120)")
  .option("--exit-passive-seconds <seconds>", "Polymarket signals: passive exit phase before bounded immediate execution (default 60; 0 skips)")
  .option("--top <n|unlimited>", "optional signal-position cap; widest eligible edges enter first")
  .option("--allocation-mode <mode>", "portfolio-kelly or daily-budget")
  .option("--kelly-fraction <fraction>", "fraction of full Kelly, from 0 to 1 (0.25 = quarter Kelly)")
  .option("--market-cap-pct <pct>", "maximum portfolio equity allocated to one prediction market")
  .option("--event-cap-pct <pct>", "maximum portfolio equity allocated across one parent event")
  .option("--min-exit-depth-2c-usd <usd>", "minimum held-side bid depth within 2¢ for an entry; 0 disables")
  .option("--daily-budget <usd>", "legacy mode: maximum entry notional placed per UTC day")
  .option("--position-budget-pct <pct>", "legacy mode: percentage of the daily budget requested per entry")
  .option("--min-entry-notional <usd>", "entry-only floor after sizing and capacity caps")
  .option("--position-check-seconds <seconds>", "reconcile and evaluate held positions on this cadence")
  .option("--signal-check-minutes <minutes>", "refresh the Quotient signal snapshot on this cadence")
  .option("--signal-max-age-hours <hours>", "maximum age of a live signal")
  .option("--slippage <pct>", "max book walk from the best executable price, as a percentage")
  .option("--max-order-notional <usd>", "hard per-order notional cap in the risk module")
  .action(wrap(runStrategy));

const agent = program.command("agent").description("monitoring-agent strategy: mandate, persona, status, dry runs");
agent
  .command("prompt <botId>")
  .description("view or update the agent's plain-language mandate")
  .option("--set <text>", "replace the mandate")
  .action(wrap(agentPrompt));
agent
  .command("persona <botId>")
  .description("view, set, or refresh the persona judgment layer (Quotient X profile, $1 per fetch)")
  .option("--handle <handle>", "X handle to profile and store")
  .option("--refresh", "re-profile the stored handle")
  .action(wrap(agentPersona));
agent.command("status <botId>").description("agent configuration and the last wake's run report").action(wrap(agentStatus));
agent
  .command("dry-run <botId>")
  .description("preview decisions without placing orders")
  .action(wrap(agentDryRun));

const venue = program.command("venue").description("venue adapters");
venue.command("status").description("adapters and when they were last verified against venue docs").action(wrap(venueStatus));

const skill = program.command("skill").description("agent operator skill");
skill.command("install").description("install or refresh the Cassie skill for Codex and Claude Code").action(wrap(installSkill));

if (import.meta.main) program.parseAsync().catch(fail);

function wrap<A extends unknown[]>(fn: (...args: A) => unknown | Promise<unknown>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      fail(err);
    }
  };
}

function fail(err: unknown): never {
  console.error(pc.red(`error: ${err instanceof Error ? err.message : String(err)}`));
  if (process.env.CASSIE_DEBUG && err instanceof Error) console.error(err.stack);
  process.exit(1);
}

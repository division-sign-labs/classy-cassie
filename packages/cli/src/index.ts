#!/usr/bin/env node
// packages/cli/src/index.ts
// The `cassie` binary.

import { Command } from "commander";
import pc from "picocolors";
import { runInit } from "./commands/init.js";
import { walletCreate, walletExport, walletImport, walletList } from "./commands/wallet.js";
import { registerSplitsSigner, runFund } from "./commands/fund.js";
import { runWithdraw } from "./commands/withdraw.js";
import { runStrategy } from "./commands/strategy.js";
import { runBot } from "./commands/run.js";
import { alertsTest, showLogs, showOrders, showPortfolio, venueStatus } from "./commands/ops.js";
import { runTrade } from "./commands/trade.js";
import { runDeploy } from "./commands/deploy.js";
import { configureReporting } from "./commands/reporting.js";
import { installSkill } from "./commands/skill.js";

const program = new Command();

program
  .name("cassie")
  .description("open-source, self-hosted, non-custodial trading bot for prediction markets and perps venues")
  .version("0.1.1");

program.command("init").description("wizard: create a bot (wallet, venue, strategy, alerts, funding)").action(wrap(runInit));

const wallet = program.command("wallet").description("per-bot key management (encrypted local keystore)");
wallet.command("create <botId>").description("generate a fresh EOA for a bot").action(wrap(walletCreate));
wallet.command("import <botId>").description("import a private key via stdin").action(wrap(walletImport));
wallet
  .command("export <botId>")
  .description("print the raw private key (requires --yes-print-my-key)")
  .option("--yes-print-my-key", "explicitly allow printing the key")
  .action(wrap(walletExport));
wallet.command("list").description("list bots and key roles").action(wrap(walletList));
wallet
  .command("register-splits <botId>")
  .description("print splits-cli commands to attach the bot EOA to a Splits subaccount")
  .action(wrap(registerSplitsSigner));

program
  .command("fund <botId>")
  .description("run/re-run the venue funding flow")
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
  .description("deploy the bot to an EEUR Cloudflare Container")
  .option("--rotate-token", "issue a new control token instead of reusing the stored one")
  .action(wrap(runDeploy));

program
  .command("reporting <botId>")
  .description("configure per-bot Ares builder attribution and verified position posts")
  .option("--off", "disable Ares attribution and posting for this bot")
  .option("--no-post", "keep builder attribution but do not publish posts")
  .action(wrap(configureReporting));

program.command("portfolio [botId]").description("balances, positions, orders, PnL (per bot and aggregate)").action(wrap(showPortfolio));

program
  .command("orders <botId>")
  .description("list/cancel open orders")
  .option("--cancel <id>", "cancel one order")
  .option("--cancel-all", "cancel all orders")
  .action(wrap(showOrders));

program
  .command("trade <botId> [side] [marketRef]")
  .description("place a trade: buy|sell <marketRef> --size … | --thesis (develop a trade from a thesis)")
  .option("--size <n>", "size in base units (shares/contracts)")
  .option("--limit <px>", "limit price (default: crossing limit within slippage band)")
  .option("--tif <tif>", "gtc|ioc|fok", "gtc")
  .option("--stop <px>", "stop trigger (native on HL/Lighter, synthetic on Polymarket)")
  .option("--trail <bps>", "trailing stop distance in bps (engine-managed)")
  .option("--tp <px>", "take-profit trigger")
  .option("--outcome <yes|no>", "prediction venues: which outcome token")
  .option("--note <text>", "rationale for the trade; becomes the caption if the bot publishes to a feed")
  .option("--thesis", "six questions → sized, guardrailed trade → approve → place (numbers computed in code)")
  .option("--save <file>", "with --thesis: also save the thesis JSON for reuse")
  .option("--from-thesis <file>", "place from a saved thesis JSON")
  .option("--mappings <file>", "alternative thesis mappings file")
  .option("-y, --yes", "skip confirmation")
  .action(wrap(runTrade));

program
  .command("logs <botId>")
  .description("structured error/log table (local sqlite or control API)")
  .option("--level <level>", "filter: error|warn|info")
  .option("--tail <n>", "last N entries", "50")
  .action(wrap(showLogs));

const alerts = program.command("alerts").description("alerting");
alerts.command("test <botId>").description("send a Telegram test ping").action(wrap(alertsTest));

program
  .command("strategy <botId>")
  .description("view/tune the bot's strategy settings and signal guardrails")
  .option("--min-entry-notional <usd>", "entry-only floor after sizing and capacity caps")
  .option("--signal-max-age-hours <hours>", "maximum age of a live signal")
  .action(wrap(runStrategy));

const venue = program.command("venue").description("venue adapters");
venue.command("status").description("adapters and when they were last verified against venue docs").action(wrap(venueStatus));

const skill = program.command("skill").description("agent operator skill");
skill.command("install").description("install or refresh the Cassie skill for Codex and Claude Code").action(wrap(installSkill));

program.parseAsync().catch(fail);

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

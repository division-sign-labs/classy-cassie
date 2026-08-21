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
import { alertsTest, showOrders, showPortfolio, venueStatus } from "./commands/ops.js";
import { runSsh, showLogs, showStatus } from "./commands/monitor.js";
import { runTrade } from "./commands/trade.js";
import { runDeploy } from "./commands/deploy.js";
import { runDestroy } from "./commands/destroy.js";
import { configureReporting } from "./commands/reporting.js";
import { installSkill } from "./commands/skill.js";
import { cliVersion } from "./version.js";

const program = new Command();

program
  .name("cassie")
  .description("self-hosted, non-custodial trading bots for prediction markets and perps venues")
  .version(cliVersion());

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
  .description("print the safe Splits EOA registration command (does not attach account authority)")
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
  .description("run the bot on a DigitalOcean droplet in your own account")
  .option("--region <slug>", "droplet region (default: sgp1)")
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
  .description("droplet, service, and engine on one screen")
  .action(wrap(showStatus));

program
  .command("ssh <botId>")
  .description("open a shell on the bot's droplet")
  .action(wrap(runSsh));

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
  .option("--stop <px>", "stop trigger (native on Hyperliquid, synthetic on Polymarket)")
  .option("--trail <bps>", "trailing stop distance in bps (engine-managed)")
  .option("--tp <px>", "take-profit trigger")
  .option("--outcome <yes|no>", "prediction venues: which outcome token")
  .option("--note <text>", "rationale for the trade; becomes the caption if the bot publishes to a feed")
  .option("--slippage <cents>", "max book walk from the best price for this order, in cents (default: bot risk config)")
  .option("--thesis", "six questions → sized, guardrailed trade → approve → place (numbers computed in code)")
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
  .description("view/tune ranked positions, daily entry budget, allocation, and signal guardrails")
  .option("--top <n>", "hold at most N signal positions; widest eligible edges enter first")
  .option("--daily-budget <usd>", "maximum entry notional placed per UTC day")
  .option("--position-budget-pct <pct>", "percentage of the daily budget requested per entry")
  .option("--min-entry-notional <usd>", "entry-only floor after sizing and capacity caps")
  .option("--signal-max-age-hours <hours>", "maximum age of a live signal")
  .option("--slippage <cents>", "max book walk from the best executable price, in cents")
  .option("--max-order-notional <usd>", "hard per-order notional cap in the risk module")
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

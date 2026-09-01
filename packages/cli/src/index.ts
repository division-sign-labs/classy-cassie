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
import { configureReporting } from "./commands/reporting.js";
import { installSkill } from "./commands/skill.js";
import { changePassphrase, forgetPassphrase, passphraseStatus, rememberPassphrase } from "./commands/passphrase.js";
import {
  configureMarketMake,
  marketMakeDryRun,
  marketMakeHalt,
  marketMakeReconcile,
  marketMakeReplay,
  marketMakeResume,
  marketMakeStatus,
} from "./commands/market-make.js";
import { cliVersion } from "./version.js";

export const program = new Command();

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
  .option("--slippage <pct>", "max book walk from the best price, as a percentage (default: bot risk config)")
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
  .description("view/tune ranked positions, portfolio or daily-budget allocation, and signal guardrails")
  .option("--top <n|unlimited>", "optional signal-position cap; widest eligible edges enter first")
  .option("--allocation-mode <mode>", "portfolio-kelly or daily-budget")
  .option("--kelly-fraction <fraction>", "fraction of full Kelly, from 0 to 1 (0.25 = quarter Kelly)")
  .option("--market-cap-pct <pct>", "maximum portfolio equity allocated to one prediction market")
  .option("--event-cap-pct <pct>", "maximum portfolio equity allocated across one parent event")
  .option("--min-exit-depth-2c-usd <usd>", "minimum held-side bid depth within 2¢ for an entry; 0 disables")
  .option("--daily-budget <usd>", "legacy mode: maximum entry notional placed per UTC day")
  .option("--position-budget-pct <pct>", "legacy mode: percentage of the daily budget requested per entry")
  .option("--max-entry-edge <pp|unlimited>", "maximum forecast entry edge; unlimited removes the guardrail")
  .option("--min-entry-notional <usd>", "entry-only floor after sizing and capacity caps")
  .option("--min-convergence-profit-pct <pct>", "minimum executable gain for an early convergence exit")
  .option("--max-hold-days <days|unlimited>", "unconditional maximum holding period")
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
  .description("one full scan+decide cycle — candidates, model reasoning, sizing arithmetic — placing nothing")
  .action(wrap(agentDryRun));

const marketMake = program
  .command("market-make")
  .description("Q-directed Polymarket passive-inventory strategy");
export function addMarketMakeConfigureOptions(command: Command): Command {
  return command
    .option("--config <file>", "replace with a complete strategy JSON document")
    .option("--bankroll-usd <usd>", "legacy fixed sizing bankroll (disables automatic live sizing)")
    .option("--bankroll-ceiling-usd <usd|unlimited>", "cap automatic live-funded sizing (default: unlimited)")
    .option("--live-bankroll", "size automatically from funded strategy capital with no ceiling")
    .option("--max-deployed-usd <usd>", "inventory plus pending-entry cost ceiling")
    .option("--max-markets <n>", "maximum active markets")
    .option("--base-order-usd <usd>", "base passive ticket")
    .option("--max-order-usd <usd>", "hard order notional cap")
    .option("--target-no-usd <usd>", "NO inventory target per market")
    .option("--yes-target-usd <usd>", "YES inventory target per market")
    .option("--min-no-edge-pp <pp>", "minimum live Q edge for NO")
    .option("--yes-min-edge-pp <pp>", "minimum live Q edge for YES")
    .option(
      "--max-edge-pp <pp>",
      "Q-market edge ceiling (cannot exceed the hard 30pp sanity bound)",
      parseMaxEdgePp,
    )
    .option("--max-book-spread-pp <pp>", "operational selected-token spread ceiling")
    .option("--convergence-edge-pp <pp>", "remaining edge that triggers an exit")
    .option("--gap-capture-pct <pct>", "percentage of the first-fill gap captured at exit (75 = 75%)")
    .option("--review-hours <hours>", "review-only age")
    .option("--max-hold-hours <hours>", "normal hold ceiling")
    .option("--absolute-max-hold-hours <hours>", "one-renewal absolute ceiling")
    .option("--renewal-no-edge-pp <pp>", "minimum NO edge for the one renewal")
    .option("--yes-renewal-edge-pp <pp>", "minimum YES edge for the one renewal")
    .option("--min-depth-1c-usd <usd>", "minimum exit-side bid depth within 1¢")
    .option("--min-depth-2c-usd <usd>", "minimum exit-side bid depth within 2¢")
    .option("--max-order-depth-1c-pct <pct>", "maximum single-order share of exit-bid depth within 1¢")
    .option("--max-order-depth-2c-pct <pct>", "maximum single-order share of exit-bid depth within 2¢")
    .option("--max-market-depth-1c-pct <pct>", "maximum per-market inventory share of exit-bid depth within 1¢")
    .option("--max-market-depth-2c-pct <pct>", "maximum per-market inventory share of exit-bid depth within 2¢");
}

addMarketMakeConfigureOptions(
  marketMake
    .command("configure <botId>")
    .description("view or change market-make parameters"),
)
  .action(wrap(configureMarketMake));
marketMake
  .command("status <botId>")
  .description("configuration identity, lifecycle, inventory, orders, and loss stops")
  .option("--json", "machine-readable output")
  .action(wrap(marketMakeStatus));
marketMake
  .command("dry-run <botId>")
  .description("read live Q/Gamma/CLOB and propose actions without placing orders; API spend is still metered")
  .action(wrap(marketMakeDryRun));
marketMake
  .command("halt <botId>")
  .description("cancel adds; continue mandatory exits")
  .option("--liquidate", "also start bounded urgent exits for all inventory")
  .action(wrap(marketMakeHalt));
marketMake
  .command("resume <botId>")
  .description("resume only the reconciled current configuration/deployment")
  .option("--acknowledge-loss-reset", "reset reviewed loss state (also required after an intentional withdrawal)")
  .action(wrap(marketMakeResume));
marketMake
  .command("reconcile <botId>")
  .description("compare durable state with venue balances, orders, and fills")
  .option("--apply", "apply the report after confirmation")
  .action(wrap(marketMakeReconcile));
marketMake
  .command("replay")
  .description("chronologically replay a normalized event bundle")
  .requiredOption("--input <bundle.json>", "normalized replay bundle")
  .option("--config <strategy.json>", "strategy config; defaults to the bundled v1 preset")
  .option("--fill-model <model>", "queue|trade-through|touch|all", "all")
  .option("--output <path>", "JSON report file or directory")
  .action(wrap(marketMakeReplay));

const venue = program.command("venue").description("venue adapters");
venue.command("status").description("adapters and when they were last verified against venue docs").action(wrap(venueStatus));

const skill = program.command("skill").description("agent operator skill");
skill.command("install").description("install or refresh the Cassie skill for Codex and Claude Code").action(wrap(installSkill));

if (import.meta.main) program.parseAsync().catch(fail);

function parseMaxEdgePp(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new InvalidArgumentError("must be a positive number of percentage points");
  }
  if (value > 30) {
    throw new InvalidArgumentError("cannot exceed the hard 30pp sanity bound");
  }
  return raw;
}

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

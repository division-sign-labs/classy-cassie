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
import { alertsTest, alertsWebhook, showOrders, showPortfolio, venueStatus } from "./commands/ops.js";
import { runSsh, showLogs, showStatus } from "./commands/monitor.js";
import { runTrade } from "./commands/trade.js";
import { runDeploy } from "./commands/deploy.js";
import { runDashboard, setDashboardPassword } from "./commands/dashboard.js";
import { runDestroy } from "./commands/destroy.js";
import { agentDryRun, agentPersona, agentPrompt, agentStatus } from "./commands/agent.js";
import { configureSignalsKey } from "./commands/signals-key.js";
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

const swing = program.command("swing").description("Quotient equity, commodity, BTC and ETH perps");
swing.command("configure <botId>").option("--config <file>", "strategy JSON")
  .action(wrap(configureSwing));
swing.command("status <botId>").description("NAV, risk, research, and protection").action(wrap(swingStatus));
swing.command("dry-run <botId>").description("refresh research and preview decisions without orders").action(wrap(swingDryRun));
swing.command("halt <botId>").description("halt additions; keep native stops and exit supervision").action(wrap(swingHalt));
swing.command("resume <botId>").option("--acknowledge-loss-reset", "request a separately confirmed drawdown reset").description("resume after an operator halt or the drawdown stop").action(wrap(swingResume));
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
  .option("--dashboard", "serve the password-protected dashboard on the droplet (default)")
  .option("--no-dashboard", "leave the firewall at SSH only")
  .option("--dashboard-port <n>", "dashboard port (default: 8443)", parsePort)
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

const dashboard = program
  .command("dashboard [botId...]")
  .description("open a local dashboard: positions, P&L history, API metrics")
  .option("--port <n>", "local port", parsePort, 4747)
  .option("--no-open", "print the URL without opening a browser")
  .option("--refresh <seconds>", "refresh interval", parseSeconds, 30)
  .action(wrap(runDashboard));
dashboard
  .command("password <botId>")
  .description("set or rotate the deployed dashboard password")
  .action(wrap(setDashboardPassword));

program
  .command("ssh <botId>")
  .description("open a shell on the bot's droplet")
  .action(wrap(runSsh));

program
  .command("signals-key <botId> [key]")
  .description("pin this bot's Quotient signals key to its own keystore")
  .option("--auto", "unpin: resolve the key from .local.env, the environment, then the keystore")
  .action(wrap(configureSignalsKey));

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
alerts.command("test <botId>").description("send a test alert to every configured sink").action(wrap(alertsTest));
alerts
  .command("webhook <botId>")
  .description("post this bot's alerts to a webhook URL (prompts for the URL and an optional signing secret)")
  .option("--format <format>", "json (default), slack, or discord")
  .option("--kinds <kinds>", "comma-separated alert kinds to deliver, default all")
  .option("--show", "print the current webhook settings")
  .option("--off", "turn webhook alerts off and remove the stored URL and secret")
  .action(wrap(alertsWebhook));

program
  .command("strategy <botId>")
  .description("view or change strategy settings")
  .option("--preset <recommended|hold>", "replace the settings with a named preset: recommended (quarter-Kelly, 90¢ take-profit, 7-day hold) or hold (fixed lot per market, 15pp+ edge, sell only on a confirmed Q flip, otherwise hold to resolution)")
  .option("--execution <adaptive|legacy>", "Polymarket signals: maker-first managed limits or legacy crossing limits")
  .option("--entry-deadline-seconds <seconds>", "Polymarket signals: maker phase of an adaptive entry (default 120)")
  .option("--entry-crossing-seconds <seconds>", "Polymarket signals: after the deadline, take the offer inside the price bound for this long (default 60; 0 keeps entries maker-only)")
  .option("--exit-passive-seconds <seconds>", "Polymarket signals: passive exit phase before bounded immediate execution (default 60; 0 skips)")
  .option("--top <n|unlimited>", "optional signal-position cap; widest eligible edges enter first")
  .option("--allocation-mode <mode>", "portfolio-kelly, daily-budget or fixed-notional")
  .option("--kelly-fraction <fraction>", "fraction of full Kelly, from 0 to 1 (0.25 = quarter Kelly)")
  .option("--market-cap-pct <pct>", "maximum portfolio equity allocated to one prediction market")
  .option("--event-cap-pct <pct>", "maximum portfolio equity allocated across one parent event")
  .option("--near-resolution-days <days|off>", "size entries down when the market resolves within this many days; off disables")
  .option("--near-resolution-size-cut-pct <pct>", "percentage removed from an entry's size inside the near-resolution window")
  .option("--min-exit-depth-2c-usd <usd>", "minimum held-side bid depth within 2¢ for an entry; 0 disables")
  .option("--daily-budget <usd>", "legacy mode: maximum entry notional placed per UTC day")
  .option("--position-budget-pct <pct>", "legacy mode: percentage of the daily budget requested per entry")
  .option("--lot-notional <usd>", "fixed-notional mode: dollars placed on every entry, one lot per market")
  .option("--max-entry-edge <pp|unlimited>", "maximum forecast entry edge; unlimited removes the guardrail")
  .option("--max-window-days <days|off>", "skip signals whose market resolves more than this many days out; off disables")
  .option("--min-entry-notional <usd>", "entry-only floor after sizing and capacity caps")
  .option("--take-profit-price <price|off>", "sell a prediction position once the held-side bid reaches this price (0–1); off disables")
  .option("--max-hold-days <days|unlimited>", "unconditional maximum holding period")
  .option("--position-check-seconds <seconds>", "reconcile and evaluate held positions on this cadence")
  .option("--signal-check-minutes <minutes>", "refresh the Quotient signal snapshot on this cadence")
  .option("--signal-max-age-hours <hours>", "maximum age of a live signal")
  .option("--slippage <pct>", "max book walk from the best executable price, as a percentage")
  .option("--max-order-notional <usd>", "hard per-order notional cap in the risk module")
  .option("--scenario-exit <on|off>", "run the seven-day signal-exit state machine around the take-profit and hold deadline")
  .option("--adverse-cross-edge-pp <pp>", "adverse cross: remaining edge at or below this counts as non-positive")
  .option("--adverse-cross-max-pnl-pct <pct>", "adverse cross: executable P&L at or below this")
  .option("--adverse-cross-confirmations <n|off>", "adverse cross: distinct committed forecasts required; off disables the exit")
  .option("--q-collapse-pp <pp|off>", "Q collapse: immediate exit once held-side Q retreated this far from entry; off disables the exit")
  .option("--q-collapse-max-remaining-edge-pp <pp>", "Q collapse: only when remaining edge is at or below this")
  .option("--flip-confirmations <n>", "Q flip: consecutive distinct forecasts below 50% required")
  .option("--flip-exit-max-remaining-edge-pp <pp|off>", "Q flip: exit once remaining edge is at or below this; off exits on confirmation at any edge")
  .option("--exit-fee-bps <bps>", "fee deducted from executable sell proceeds in the P&L gates")
  .option("--exit-retry-seconds <seconds>", "how long a submitted exit stays pending before a still-held position may resubmit")
  .option("--pending-entry-reservation-seconds <seconds>", "how long an accepted entry stays reserved against caps while the venue shows neither position nor order")
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

const marketMake = program
  .command("market-make")
  .description("Polymarket two-sided market making and legacy forecast inventory");
export function addMarketMakeConfigureOptions(command: Command): Command {
  return command
    .option("--config <file>", "replace with a complete strategy JSON document")
    .option("--bankroll-usd <usd>", "legacy fixed sizing bankroll (disables automatic live sizing)")
    .option("--bankroll-ceiling-usd <usd|unlimited>", "cap automatic live-funded sizing (default: unlimited)")
    .option("--live-bankroll", "size automatically from funded strategy capital with no ceiling")
    .option("--max-deployed-usd <usd>", "inventory plus pending-entry cost ceiling")
    .option("--max-markets <n>", "maximum active markets")
    .option("--base-order-usd <usd>", "base passive ticket")
    .option("--two-sided", "select inventory-aware two-sided spread quoting")
    .option("--adaptive", "select experimental Q-adaptive liquidity (requires Quotient)")
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
    .option("--max-forecast-age-hours <hours>", "maximum forecast age for a new entry or add")
    .option("--stale-forecast-exit-hours <hours>", "forecast age that triggers a mandatory exit")
    .option("--min-volume-usd <usd>", "minimum trailing 24-hour market volume")
    .option("--source-min-depth-2c-usd <usd>", "minimum signal-source depth within 2¢")
    .option("--entry-stability-seconds <seconds>", "required stable-price window before entry")
    .option("--max-move-away-from-q-pp <pp>", "maximum move away from Q during the stability window")
    .option("--allow-dead-volatility", "allow new entries in dead volatility at 0.5x size")
    .option("--allow-extreme-volatility", "allow new entries in extreme volatility at 0.25x size")
    .option("--allow-current-q-after-shock", "remove the newer-Q requirement after an adverse shock")
    .option("--correlated-shocks-for-global-pause <n>", "distinct shocked markets required for a global pause")
    .option("--market-data-stale-seconds <seconds>", "maximum order-book age during evaluation")
    .option("--venue-quote-max-age-seconds <seconds>", "maximum venue-quote age during evaluation")
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

function parsePort(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new InvalidArgumentError("must be a port from 1 to 65535");
  return value;
}

function parseSeconds(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 5) throw new InvalidArgumentError("must be a whole number of seconds, at least 5");
  return value;
}

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

// packages/cli/src/commands/market-make.ts
// Configure and operate the deterministic, Polymarket-only market-making
// strategy. Live state changes always go through the running control API.

import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { extname, join, resolve } from "node:path";
import pc from "picocolors";
import { parseBotConfig, type BotConfig } from "@quotient-forecasting/cassie-core";
import {
  MARKET_MAKE_PRESET,
  MarketMakeConfigSchema,
  MarketMakeReplayBundleSchema,
  marketMakeConfigHash,
  replayMarketMake,
  type MarketMakeConfig,
  type MarketMakeReplayReport,
  type MarketMakeRunStatus,
  type ReplayFillModel,
} from "@quotient-forecasting/strategy-market-make";
import { confirm, controlFetch, isDeployed } from "../context.js";
import {
  atomicWritePrivateFile,
  dirs,
  loadBotConfig,
  saveBotConfig,
} from "../paths.js";

export interface MarketMakeConfigureOptions {
  /** A complete q-directed-polymarket-mm/1 JSON document. */
  config?: string;
  /** Legacy fixed-bankroll sizing. Prefer the live-funded default. */
  bankrollUsd?: string;
  /** Optional ceiling for the default live-funded sizing mode. */
  bankrollCeilingUsd?: string;
  /** Select live-funded sizing and remove any configured ceiling. */
  liveBankroll?: boolean;
  maxDeployedUsd?: string;
  maxMarkets?: string;
  baseOrderUsd?: string;
  maxOrderUsd?: string;
  targetNoUsd?: string;
  yesTargetUsd?: string;
  minNoEdgePp?: string;
  yesMinEdgePp?: string;
  maxEdgePp?: string;
  maxBookSpreadPp?: string;
  convergenceEdgePp?: string;
  gapCapturePct?: string;
  reviewHours?: string;
  maxHoldHours?: string;
  absoluteMaxHoldHours?: string;
  renewalNoEdgePp?: string;
  yesRenewalEdgePp?: string;
  minDepth1cUsd?: string;
  minDepth2cUsd?: string;
  maxOrderDepth1cPct?: string;
  maxOrderDepth2cPct?: string;
  maxMarketDepth1cPct?: string;
  maxMarketDepth2cPct?: string;
}

export interface MarketMakeStatusOptions {
  json?: boolean;
}

export interface MarketMakeHaltOptions {
  liquidate?: boolean;
}

export interface MarketMakeResumeOptions {
  acknowledgeLossReset?: boolean;
}

export interface MarketMakeReconcileOptions {
  apply?: boolean;
}

export interface MarketMakeReplayOptions {
  input?: string;
  config?: string;
  output?: string;
  fillModel?: string;
}

type ControlInit = { method?: "GET" | "POST"; body?: string };
type RuntimeStatus = MarketMakeRunStatus & Record<string, unknown>;

export interface MarketMakeCommandDependencies {
  loadConfig(botId: string): BotConfig;
  saveConfig(config: BotConfig): void;
  confirm(message: string, defaultYes?: boolean): Promise<boolean>;
  control(config: BotConfig, path: string, init?: ControlInit): Promise<unknown>;
  localRuntimeAvailable(botId: string): boolean;
  log(message: string): void;
}

export interface MarketMakeCommandHandlers {
  configure(botId: string, opts?: MarketMakeConfigureOptions): Promise<void>;
  status(botId: string, opts?: MarketMakeStatusOptions): Promise<void>;
  dryRun(botId: string): Promise<void>;
  halt(botId: string, opts?: MarketMakeHaltOptions): Promise<void>;
  resume(botId: string, opts?: MarketMakeResumeOptions): Promise<void>;
  reconcile(botId: string, opts?: MarketMakeReconcileOptions): Promise<void>;
  replay(opts: MarketMakeReplayOptions): Promise<void>;
}

type JsonObject = Record<string, unknown>;

const CONFIG_OPTION_NAMES: ReadonlyArray<keyof MarketMakeConfigureOptions> = [
  "config",
  "bankrollUsd",
  "bankrollCeilingUsd",
  "liveBankroll",
  "maxDeployedUsd",
  "maxMarkets",
  "baseOrderUsd",
  "maxOrderUsd",
  "targetNoUsd",
  "yesTargetUsd",
  "minNoEdgePp",
  "yesMinEdgePp",
  "maxEdgePp",
  "maxBookSpreadPp",
  "convergenceEdgePp",
  "gapCapturePct",
  "reviewHours",
  "maxHoldHours",
  "absoluteMaxHoldHours",
  "renewalNoEdgePp",
  "yesRenewalEdgePp",
  "minDepth1cUsd",
  "minDepth2cUsd",
  "maxOrderDepth1cPct",
  "maxOrderDepth2cPct",
  "maxMarketDepth1cPct",
  "maxMarketDepth2cPct",
];

const DEFAULT_DEPS: MarketMakeCommandDependencies = {
  loadConfig: loadBotConfig,
  saveConfig: saveBotConfig,
  confirm,
  control: marketMakeControl,
  localRuntimeAvailable: (botId) => existsSync(localControlSocketPath(botId)),
  log: (message) => console.log(message),
};

/** Reject a strategy/venue mismatch before reading state or contacting a runtime. */
export function requireMarketMakeBot(config: BotConfig): void {
  if (config.venue !== "polymarket") {
    throw new Error(
      `bot "${config.id}" uses ${config.venue}; the market-make strategy is supported only on Polymarket`,
    );
  }
  if (config.strategy.id !== "market-make") {
    throw new Error(
      `bot "${config.id}" runs the "${config.strategy.id}" strategy — use a bot initialized with the market-make strategy`,
    );
  }
}

/**
 * Resolve configuration with an intentionally simple precedence rule:
 * current config (or bundled preset), then a complete --config replacement,
 * then individual CLI overrides.
 */
export function resolveMarketMakeConfig(
  current: unknown,
  opts: MarketMakeConfigureOptions = {},
): MarketMakeConfig {
  const source = opts.config
    ? readJsonFile(opts.config, "market-make config")
    : current && isObject(current) && Object.keys(current).length > 0
      ? current
      : MARKET_MAKE_PRESET;
  const parsed = MarketMakeConfigSchema.parse(source);
  const next = structuredClone(parsed) as unknown as JsonObject;

  if (opts.bankrollUsd !== undefined && (opts.bankrollCeilingUsd !== undefined || opts.liveBankroll === true)) {
    throw new Error("--bankroll-usd selects legacy fixed sizing and cannot be combined with live-bankroll options");
  }
  if (opts.bankrollCeilingUsd !== undefined && opts.liveBankroll === true) {
    throw new Error("--bankroll-ceiling-usd cannot be combined with --live-bankroll");
  }
  if (opts.bankrollUsd !== undefined) {
    const value = positiveNumber("--bankroll-usd", opts.bankrollUsd);
    scaleCapitalDollarLimits(next, value);
    setNested(next, ["cassie_overrides", "bankroll", "mode"], "fixed");
    setNested(next, ["cassie_overrides", "bankroll", "maximum_sizing_bankroll_usd"], null);
  } else if (opts.bankrollCeilingUsd !== undefined) {
    setNested(next, ["cassie_overrides", "bankroll", "mode"], "live");
    setNested(
      next,
      ["cassie_overrides", "bankroll", "maximum_sizing_bankroll_usd"],
      bankrollCeiling("--bankroll-ceiling-usd", opts.bankrollCeilingUsd),
    );
  } else if (opts.liveBankroll === true) {
    setNested(next, ["cassie_overrides", "bankroll", "mode"], "live");
    setNested(next, ["cassie_overrides", "bankroll", "maximum_sizing_bankroll_usd"], null);
  }
  setPositiveUsd(next, ["capital", "max_total_inventory_and_pending_entry_cost_usd"], "--max-deployed-usd", opts.maxDeployedUsd);
  if (opts.maxMarkets !== undefined) {
    setNested(next, ["capital", "max_active_markets"], positiveInteger("--max-markets", opts.maxMarkets));
  }
  setPositiveUsd(next, ["capital", "base_order_notional_usd"], "--base-order-usd", opts.baseOrderUsd);
  setPositiveUsd(next, ["capital", "max_order_notional_usd"], "--max-order-usd", opts.maxOrderUsd);
  setPositiveUsd(next, ["direction_policy", "NO", "target_market_cost_usd"], "--target-no-usd", opts.targetNoUsd);
  setPositiveUsd(next, ["direction_policy", "YES", "target_market_cost_usd"], "--yes-target-usd", opts.yesTargetUsd);

  if (opts.minNoEdgePp !== undefined) {
    setNested(next, ["direction_policy", "NO", "minimum_edge_pp"], percentagePoints("--min-no-edge-pp", opts.minNoEdgePp));
  }
  if (opts.yesMinEdgePp !== undefined) {
    setNested(next, ["direction_policy", "YES", "minimum_edge_pp"], percentagePoints("--yes-min-edge-pp", opts.yesMinEdgePp));
  }
  if (opts.minNoEdgePp !== undefined || opts.yesMinEdgePp !== undefined) {
    const noMinimum = nestedNumber(next, ["direction_policy", "NO", "minimum_edge_pp"]);
    const yesMinimum = nestedNumber(next, ["direction_policy", "YES", "minimum_edge_pp"]);
    setNested(next, ["eligibility", "q_market_edge_min_pp"], Math.min(noMinimum, yesMinimum));
  }
  if (opts.maxEdgePp !== undefined) {
    const value = percentagePoints("--max-edge-pp", opts.maxEdgePp);
    setNested(next, ["eligibility", "q_market_edge_max_pp"], value);
    setNested(next, ["direction_policy", "NO", "maximum_edge_pp"], value);
    setNested(next, ["direction_policy", "YES", "maximum_edge_pp"], value);
  }
  if (opts.maxBookSpreadPp !== undefined) {
    setNested(
      next,
      ["eligibility", "max_selected_token_book_spread_pp"],
      percentagePoints("--max-book-spread-pp", opts.maxBookSpreadPp),
    );
  }
  if (opts.convergenceEdgePp !== undefined) {
    setNested(
      next,
      ["exit_policy", "remaining_live_q_edge_exit_pp"],
      percentagePoints("--convergence-edge-pp", opts.convergenceEdgePp),
    );
  }
  if (opts.gapCapturePct !== undefined) {
    setNested(
      next,
      ["exit_policy", "captured_initial_gap_fraction_exit"],
      percentage("--gap-capture-pct", opts.gapCapturePct) / 100,
    );
  }
  if (opts.reviewHours !== undefined) {
    setNested(next, ["exit_policy", "soft_review_after_seconds"], hoursToSeconds("--review-hours", opts.reviewHours));
  }
  if (opts.maxHoldHours !== undefined) {
    setNested(next, ["exit_policy", "default_hard_hold_seconds"], hoursToSeconds("--max-hold-hours", opts.maxHoldHours));
  }
  if (opts.absoluteMaxHoldHours !== undefined) {
    setNested(
      next,
      ["exit_policy", "absolute_max_hold_seconds"],
      hoursToSeconds("--absolute-max-hold-hours", opts.absoluteMaxHoldHours),
    );
  }
  if (opts.maxHoldHours !== undefined || opts.absoluteMaxHoldHours !== undefined) {
    const normal = nestedNumber(next, ["exit_policy", "default_hard_hold_seconds"]);
    const absolute = nestedNumber(next, ["exit_policy", "absolute_max_hold_seconds"]);
    if (absolute <= normal) throw new Error("--absolute-max-hold-hours must be greater than --max-hold-hours");
    setNested(next, ["exit_policy", "maximum_extension_seconds"], absolute - normal);
  }

  if (opts.renewalNoEdgePp !== undefined) {
    setNested(
      next,
      ["cassie_overrides", "renewal_min_edge_pp", "NO"],
      percentagePoints("--renewal-no-edge-pp", opts.renewalNoEdgePp),
    );
  }
  if (opts.yesRenewalEdgePp !== undefined) {
    setNested(
      next,
      ["cassie_overrides", "renewal_min_edge_pp", "YES"],
      percentagePoints("--yes-renewal-edge-pp", opts.yesRenewalEdgePp),
    );
  }
  setPositiveUsd(
    next,
    ["cassie_overrides", "liquidity", "minimum_exit_bid_depth_1c_usd"],
    "--min-depth-1c-usd",
    opts.minDepth1cUsd,
  );
  setPositiveUsd(
    next,
    ["cassie_overrides", "liquidity", "minimum_exit_bid_depth_2c_usd"],
    "--min-depth-2c-usd",
    opts.minDepth2cUsd,
  );
  setParticipationFraction(
    next,
    ["cassie_overrides", "liquidity", "max_order_fraction_of_exit_bid_depth_1c"],
    "--max-order-depth-1c-pct",
    opts.maxOrderDepth1cPct,
  );
  setParticipationFraction(
    next,
    ["cassie_overrides", "liquidity", "max_order_fraction_of_exit_bid_depth_2c"],
    "--max-order-depth-2c-pct",
    opts.maxOrderDepth2cPct,
  );
  setParticipationFraction(
    next,
    ["cassie_overrides", "liquidity", "max_market_fraction_of_exit_bid_depth_1c"],
    "--max-market-depth-1c-pct",
    opts.maxMarketDepth1cPct,
  );
  setParticipationFraction(
    next,
    ["cassie_overrides", "liquidity", "max_market_fraction_of_exit_bid_depth_2c"],
    "--max-market-depth-2c-pct",
    opts.maxMarketDepth2cPct,
  );

  // Re-parse after all overrides so cross-field invariants fail before any
  // bot file is replaced.
  return MarketMakeConfigSchema.parse(next);
}

export function createMarketMakeCommandHandlers(
  overrides: Partial<MarketMakeCommandDependencies> = {},
): MarketMakeCommandHandlers {
  const deps: MarketMakeCommandDependencies = { ...DEFAULT_DEPS, ...overrides };

  return {
    async configure(botId, opts = {}) {
      const bot = deps.loadConfig(botId);
      requireMarketMakeBot(bot);
      const changing = CONFIG_OPTION_NAMES.some((name) => opts[name] !== undefined);
      const resolved = resolveMarketMakeConfig(bot.strategy.config, opts);
      if (!changing) {
        printConfig(deps.log, resolved);
        return;
      }

      const saved = parseBotConfig({
        ...bot,
        tickIntervalMin: resolved.reconciliation.rest_reconcile_seconds / 60,
        strategy: {
          id: "market-make",
          config: resolved as unknown as Record<string, unknown>,
        },
      });
      deps.saveConfig(saved);
      deps.log(pc.green(`saved market-make configuration for ${botId} (${marketMakeConfigHash(resolved)})`));
      printConfig(deps.log, resolved);
      if (bot.deployment) {
        deps.log(
          pc.yellow(
            `the deployed runtime still has its prior config — run \`cassie deploy ${botId}\`; the new deployment will remain halted until reconcile and resume`,
          ),
        );
      } else if (deps.localRuntimeAvailable(botId)) {
        deps.log(
          pc.yellow(
            `the running local runtime still has its prior config — stop and restart \`cassie run ${botId}\`; it will remain halted until reconcile and resume`,
          ),
        );
      }
    },

    async status(botId, opts = {}) {
      const bot = deps.loadConfig(botId);
      requireMarketMakeBot(bot);
      const config = MarketMakeConfigSchema.parse(bot.strategy.config);
      const localConfigHash = marketMakeConfigHash(config);
      let runtime: RuntimeStatus | Record<string, unknown>;
      if (!isDeployed(bot) && !deps.localRuntimeAvailable(botId)) {
        runtime = {
          strategyId: "market-make",
          lifecycle: "OFFLINE",
          message: `no local runtime control socket; start one with cassie run ${botId}`,
        };
      } else {
        runtime = asObject(await deps.control(bot, "/market-make/status")) as RuntimeStatus;
      }
      const runtimeHash = configuredRuntimeHash(runtime);
      const bankrollPolicy = configuredBankrollPolicy(config);
      const report = {
        botId,
        venue: bot.venue,
        deployed: isDeployed(bot),
        localConfigHash,
        runtimeConfigHash: runtimeHash,
        configDrift: runtimeHash === undefined ? undefined : runtimeHash !== localConfigHash,
        bankrollPolicy,
        runtime,
      };
      if (opts.json) deps.log(JSON.stringify(report, null, 2));
      else printStatus(deps.log, report);
    },

    async dryRun(botId) {
      const bot = deps.loadConfig(botId);
      requireMarketMakeBot(bot);
      requireReachableRuntime(bot, deps);
      deps.log(pc.dim("dry run: reads live Q/Gamma/CLOB state and proposes actions; it places no orders and changes no trading state (metered API spend is recorded)."));
      const report = await deps.control(bot, "/market-make/dry-run", { method: "POST" });
      deps.log(JSON.stringify(report, null, 2));
    },

    async halt(botId, opts = {}) {
      const bot = deps.loadConfig(botId);
      requireMarketMakeBot(bot);
      requireReachableRuntime(bot, deps);
      const config = MarketMakeConfigSchema.parse(bot.strategy.config);
      const status = asObject(await deps.control(bot, "/market-make/status"));
      const liquidate = opts.liquidate === true;
      if (liquidate) {
        const localHash = marketMakeConfigHash(config);
        const runtimeHash = configuredRuntimeHash(status);
        if (runtimeHash !== localHash) {
          throw new Error(
            `refusing liquidation with configuration drift: local ${localHash}, runtime ${runtimeHash ?? "unknown"}; ` +
              `${isDeployed(bot) ? `run \`cassie deploy ${botId}\`` : "restart the local runtime"}, reconcile, and review the active bounds first`,
          );
        }
      }
      const action = liquidate
        ? `Halt additions, cancel resting orders, and start urgent bounded exits for all inventory (${config.exit_policy.urgent_exit_max_attempts} FAK attempts, at most ${config.exit_policy.urgent_exit_max_concession_pp}pp concession)?`
        : "Halt additions and cancel all resting orders while continuing mandatory exits?";
      if (!(await deps.confirm(`${action} ${exposureSummary(status)}. ${limitSummary(config, status)}`, false))) {
        deps.log("halt canceled");
        return;
      }
      const result = await deps.control(bot, "/market-make/halt", {
        method: "POST",
        body: JSON.stringify({ liquidate }),
      });
      deps.log(pc.green(liquidate ? "market-make halted; bounded liquidation requested" : "market-make halted; mandatory exits remain active"));
      printControlResult(deps.log, result);
    },

    async resume(botId, opts = {}) {
      const bot = deps.loadConfig(botId);
      requireMarketMakeBot(bot);
      requireReachableRuntime(bot, deps);
      const config = MarketMakeConfigSchema.parse(bot.strategy.config);
      const localHash = marketMakeConfigHash(config);
      const status = asObject(await deps.control(bot, "/market-make/status"));
      const runtimeHash = configuredRuntimeHash(status);
      if (runtimeHash !== undefined && runtimeHash !== localHash) {
        throw new Error(
          `configuration drift: local ${localHash}, runtime ${runtimeHash}; ${isDeployed(bot) ? `run \`cassie deploy ${botId}\`` : "restart the local runtime"} before resuming`,
        );
      }
      const lossLatched = status.lossLatched === true || nestedBoolean(status, ["loss", "latched"]);
      if (lossLatched && !opts.acknowledgeLossReset) {
        throw new Error(
          "loss limits are latched; inspect status and reconcile, then pass --acknowledge-loss-reset to make that reset explicit",
        );
      }
      const lossText = opts.acknowledgeLossReset
        ? " This also rebases the reviewed loss state, including an intentional flat-account withdrawal."
        : "";
      if (!(await deps.confirm(`Resume live market-making? ${exposureSummary(status)}. ${limitSummary(config, status)}${lossText}`, false))) {
        deps.log("resume canceled");
        return;
      }
      const result = await deps.control(bot, "/market-make/resume", {
        method: "POST",
        body: JSON.stringify({ acknowledgeLossReset: opts.acknowledgeLossReset === true }),
      });
      deps.log(pc.green("market-make resume requested"));
      printControlResult(deps.log, result);
    },

    async reconcile(botId, opts = {}) {
      const bot = deps.loadConfig(botId);
      requireMarketMakeBot(bot);
      requireReachableRuntime(bot, deps);
      const status = asObject(await deps.control(bot, "/market-make/status"));
      const apply = opts.apply === true;
      const preview = asObject(await deps.control(bot, "/market-make/reconcile", {
        method: "POST",
        body: JSON.stringify({ apply: false }),
      }));
      deps.log(JSON.stringify(preview, null, 2));
      if (!apply) {
        deps.log(pc.dim("report only; rerun with --apply to review and commit this exact proposal"));
        return;
      }
      const proposalHash = preview.proposalHash;
      if (typeof proposalHash !== "string" || !/^[0-9a-f]{64}$/.test(proposalHash)) {
        throw new Error("runtime reconciliation preview did not return a valid SHA-256 proposal hash; refusing to apply");
      }
      if (!(await deps.confirm(
        `Apply the reconciliation proposal shown above (hash ${proposalHash})? This may cancel the listed unknown orders and authorize repeated observation of the listed residual mismatches; inventory changes still require the configured repeated-snapshot and late-fill gates. ${exposureSummary(status)}`,
        false,
      ))) {
        deps.log("reconciliation apply canceled");
        return;
      }
      const result = await deps.control(bot, "/market-make/reconcile", {
        method: "POST",
        body: JSON.stringify({ apply: true, expectedProposalHash: proposalHash }),
      });
      deps.log(JSON.stringify(result, null, 2));
    },

    async replay(opts) {
      if (!opts.input) throw new Error("market-make replay requires --input <bundle.json>");
      const bundle = MarketMakeReplayBundleSchema.parse(readJsonFile(opts.input, "replay bundle"));
      const config = MarketMakeConfigSchema.parse(
        opts.config ? readJsonFile(opts.config, "market-make config") : MARKET_MAKE_PRESET,
      );
      const models = replayModels(opts.fillModel);
      const reports: MarketMakeReplayReport[] = models.map((fillModel) =>
        replayMarketMake(bundle, config, { fillModel }),
      );
      const result: MarketMakeReplayReport | { schemaVersion: string; reports: MarketMakeReplayReport[] } =
        reports.length === 1
          ? reports[0]!
          : { schemaVersion: "cassie-market-make-replay-report-set/1", reports };
      const rendered = JSON.stringify(result, null, 2) + "\n";
      if (opts.output) {
        const outputPath = replayOutputPath(opts.output);
        atomicWritePrivateFile(outputPath, rendered);
        deps.log(pc.green(`replay report written to ${outputPath}`));
      } else {
        deps.log(rendered.trimEnd());
      }
    },
  };
}

const defaultHandlers = createMarketMakeCommandHandlers();

export const configureMarketMake = defaultHandlers.configure;
export const marketMakeStatus = defaultHandlers.status;
export const marketMakeDryRun = defaultHandlers.dryRun;
export const marketMakeHalt = defaultHandlers.halt;
export const marketMakeResume = defaultHandlers.resume;
export const marketMakeReconcile = defaultHandlers.reconcile;
export const marketMakeReplay = defaultHandlers.replay;

function readJsonFile(path: string, label: string): unknown {
  const absolute = resolve(path);
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${label} ${absolute} is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new Error("market-make runtime returned a non-object response");
  return value;
}

function setNested(root: JsonObject, path: string[], value: unknown): void {
  let target = root;
  for (const part of path.slice(0, -1)) {
    const child = target[part];
    if (!isObject(child)) throw new Error(`market-make config is missing ${path.slice(0, path.indexOf(part) + 1).join(".")}`);
    target = child;
  }
  const leaf = path.at(-1);
  if (!leaf) throw new Error("empty market-make config path");
  target[leaf] = value;
}

function nestedValue(root: JsonObject, path: string[]): unknown {
  let value: unknown = root;
  for (const part of path) {
    if (!isObject(value)) return undefined;
    value = value[part];
  }
  return value;
}

function nestedNumber(root: JsonObject, path: string[]): number {
  const value = nestedValue(root, path);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`market-make config is missing numeric ${path.join(".")}`);
  }
  return value;
}

function nestedBoolean(root: JsonObject, path: string[]): boolean {
  return nestedValue(root, path) === true;
}

function setPositiveUsd(root: JsonObject, path: string[], flag: string, raw: string | undefined): void {
  if (raw !== undefined) setNested(root, path, positiveNumber(flag, raw));
}

function setParticipationFraction(root: JsonObject, path: string[], flag: string, raw: string | undefined): void {
  if (raw !== undefined) setNested(root, path, percentage(flag, raw) / 100);
}

/**
 * Resize the v1 dollar risk budget as one coherent portfolio. Absolute book
 * depth floors deliberately do not scale: participation fractions are what
 * make a larger bankroll demand proportionally deeper exit liquidity.
 */
function scaleCapitalDollarLimits(root: JsonObject, bankrollUsd: number): void {
  const current = nestedNumber(root, ["capital", "sizing_bankroll_usd"]);
  const ratio = bankrollUsd / current;
  const scalablePaths = [
    ["capital", "max_total_inventory_and_pending_entry_cost_usd"],
    ["capital", "minimum_free_collateral_usd"],
    ["capital", "operational_reserve_usd"],
    ["capital", "base_order_notional_usd"],
    ["capital", "max_order_notional_usd"],
    ["capital", "hard_market_cost_usd"],
    ["direction_policy", "NO", "target_market_cost_usd"],
    ["direction_policy", "YES", "target_market_cost_usd"],
    ["portfolio_risk", "max_event_cost_usd"],
    ["portfolio_risk", "max_category_family_cost_usd"],
    ["portfolio_risk", "max_manual_correlation_group_cost_usd"],
    ["loss_limits", "max_marked_loss_per_market_usd"],
    ["loss_limits", "max_rolling_24h_loss_usd"],
    ["loss_limits", "max_strategy_drawdown_usd"],
  ];
  for (const path of scalablePaths) setNested(root, path, nestedNumber(root, path) * ratio);
  setNested(root, ["capital", "initial_bankroll_usd"], bankrollUsd);
  setNested(root, ["capital", "sizing_bankroll_usd"], bankrollUsd);
}

function positiveNumber(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be a positive number`);
  return value;
}

function positiveInteger(flag: string, raw: string): number {
  const value = positiveNumber(flag, raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${flag} must be a positive whole number`);
  return value;
}

function bankrollCeiling(flag: string, raw: string): number | null {
  if (raw.trim().toLowerCase() === "unlimited") return null;
  return positiveNumber(flag, raw);
}

function percentage(flag: string, raw: string): number {
  const value = positiveNumber(flag, raw);
  if (value > 100) throw new Error(`${flag} must be at most 100 percent`);
  return value;
}

function percentagePoints(flag: string, raw: string): number {
  const value = positiveNumber(flag, raw);
  if (value > 100) throw new Error(`${flag} must be at most 100 percentage points`);
  return value;
}

function hoursToSeconds(flag: string, raw: string): number {
  const hours = positiveNumber(flag, raw);
  const seconds = hours * 60 * 60;
  if (!Number.isSafeInteger(seconds)) throw new Error(`${flag} must resolve to a whole number of seconds`);
  return seconds;
}

function replayModels(raw = "all"): ReplayFillModel[] {
  if (raw === "all") return ["queue", "trade-through", "touch"];
  if (raw === "queue" || raw === "trade-through" || raw === "touch") return [raw];
  throw new Error("--fill-model must be all, queue, trade-through, or touch");
}

function replayOutputPath(raw: string): string {
  const absolute = resolve(raw);
  return extname(absolute).toLowerCase() === ".json"
    ? absolute
    : join(absolute, "market-make-replay-report.json");
}

function printConfig(log: (message: string) => void, config: MarketMakeConfig): void {
  const value = config as unknown as JsonObject;
  const bankrollMode = String(nestedValue(value, ["cassie_overrides", "bankroll", "mode"]));
  const bankrollCeilingUsd = nestedValue(value, [
    "cassie_overrides",
    "bankroll",
    "maximum_sizing_bankroll_usd",
  ]);
  log(pc.bold(`market-make configuration (${marketMakeConfigHash(config)}):`));
  log(
    `  bankroll mode:        ${bankrollMode === "live" ? "live funded capital (automatic)" : "fixed"}` +
      (bankrollMode === "live"
        ? `; ceiling ${typeof bankrollCeilingUsd === "number" ? `$${bankrollCeilingUsd.toFixed(2)}` : "none"}`
        : ""),
  );
  log(`  reference bankroll:   $${nestedNumber(value, ["capital", "sizing_bankroll_usd"]).toFixed(2)}`);
  log(`  reference deployed:   $${nestedNumber(value, ["capital", "max_total_inventory_and_pending_entry_cost_usd"]).toFixed(2)}`);
  log(`  free / reserve:       $${nestedNumber(value, ["capital", "minimum_free_collateral_usd"]).toFixed(2)} / $${nestedNumber(value, ["capital", "operational_reserve_usd"]).toFixed(2)}`);
  log(`  active / live orders: ${nestedNumber(value, ["capital", "max_active_markets"])} / ${nestedNumber(value, ["capital", "max_live_orders"])}`);
  log(`  base / max order:     $${nestedNumber(value, ["capital", "base_order_notional_usd"]).toFixed(2)} / $${nestedNumber(value, ["capital", "max_order_notional_usd"]).toFixed(2)}`);
  log(`  NO / YES size mult:   ${nestedNumber(value, ["direction_policy", "NO", "size_multiplier"])}x / ${nestedNumber(value, ["direction_policy", "YES", "size_multiplier"])}x (before volatility)`);
  log(`  normal / high vol:    ${nestedNumber(value, ["volatility", "regimes", "normal", "size_multiplier"])}x / ${nestedNumber(value, ["volatility", "regimes", "high", "size_multiplier"])}x`);
  log(`  hard market cap:      $${nestedNumber(value, ["capital", "hard_market_cost_usd"]).toFixed(2)}`);
  log(`  NO edge / target:     ${nestedNumber(value, ["direction_policy", "NO", "minimum_edge_pp"])}–${nestedNumber(value, ["direction_policy", "NO", "maximum_edge_pp"])}pp / $${nestedNumber(value, ["direction_policy", "NO", "target_market_cost_usd"]).toFixed(2)}`);
  log(`  YES edge / target:    ${nestedNumber(value, ["direction_policy", "YES", "minimum_edge_pp"])}–${nestedNumber(value, ["direction_policy", "YES", "maximum_edge_pp"])}pp / $${nestedNumber(value, ["direction_policy", "YES", "target_market_cost_usd"]).toFixed(2)}`);
  log(`  event / family / corr:$${nestedNumber(value, ["portfolio_risk", "max_event_cost_usd"]).toFixed(2)} / $${nestedNumber(value, ["portfolio_risk", "max_category_family_cost_usd"]).toFixed(2)} / $${nestedNumber(value, ["portfolio_risk", "max_manual_correlation_group_cost_usd"]).toFixed(2)}`);
  log(`  markets per event:    ${nestedNumber(value, ["portfolio_risk", "max_open_markets_per_event"])}`);
  log(`  loss market/24h/max:  $${nestedNumber(value, ["loss_limits", "max_marked_loss_per_market_usd"]).toFixed(2)} / $${nestedNumber(value, ["loss_limits", "max_rolling_24h_loss_usd"]).toFixed(2)} / $${nestedNumber(value, ["loss_limits", "max_strategy_drawdown_usd"]).toFixed(2)}`);
  log(`  convergence:          ${nestedNumber(value, ["exit_policy", "remaining_live_q_edge_exit_pp"])}pp or ${(nestedNumber(value, ["exit_policy", "captured_initial_gap_fraction_exit"]) * 100).toFixed(0)}% captured`);
  log(`  review / hold / max:  ${secondsAsHours(nestedNumber(value, ["exit_policy", "soft_review_after_seconds"]))}h / ${secondsAsHours(nestedNumber(value, ["exit_policy", "default_hard_hold_seconds"]))}h / ${secondsAsHours(nestedNumber(value, ["exit_policy", "absolute_max_hold_seconds"]))}h`);
  log(`  exit depth 1c / 2c:   $${nestedNumber(value, ["cassie_overrides", "liquidity", "minimum_exit_bid_depth_1c_usd"]).toFixed(2)} / $${nestedNumber(value, ["cassie_overrides", "liquidity", "minimum_exit_bid_depth_2c_usd"]).toFixed(2)}`);
  log(
    `  order depth caps:      ${(nestedNumber(value, ["cassie_overrides", "liquidity", "max_order_fraction_of_exit_bid_depth_1c"]) * 100).toFixed(2)}% at 1c / ` +
      `${(nestedNumber(value, ["cassie_overrides", "liquidity", "max_order_fraction_of_exit_bid_depth_2c"]) * 100).toFixed(2)}% at 2c`,
  );
  log(
    `  market depth caps:     ${(nestedNumber(value, ["cassie_overrides", "liquidity", "max_market_fraction_of_exit_bid_depth_1c"]) * 100).toFixed(2)}% at 1c / ` +
      `${(nestedNumber(value, ["cassie_overrides", "liquidity", "max_market_fraction_of_exit_bid_depth_2c"]) * 100).toFixed(2)}% at 2c`,
  );
}

function secondsAsHours(seconds: number): string {
  return String(Number((seconds / 3600).toFixed(4)));
}

function limitSummary(config: MarketMakeConfig, status?: JsonObject): string {
  const scale = status === undefined
    ? 1
    : numericStatus(status, [["bankrollScale"]]) ?? 1;
  const effective = configuredBankrollPolicy(config).mode === "live" && status !== undefined
    ? "Effective limits"
    : "Limits";
  return `${effective}: $${(config.capital.max_total_inventory_and_pending_entry_cost_usd * scale).toFixed(2)} deployed, $${(config.capital.max_order_notional_usd * scale).toFixed(2)} per order, ${config.capital.max_active_markets} active markets.`;
}

function configuredBankrollPolicy(config: MarketMakeConfig): {
  mode: "live" | "fixed";
  referenceUsd: number;
  ceilingUsd: number | null;
} {
  const value = config as unknown as JsonObject;
  const rawMode = nestedValue(value, ["cassie_overrides", "bankroll", "mode"]);
  const rawCeiling = nestedValue(value, [
    "cassie_overrides",
    "bankroll",
    "maximum_sizing_bankroll_usd",
  ]);
  return {
    mode: rawMode === "fixed" ? "fixed" : "live",
    referenceUsd: config.capital.sizing_bankroll_usd,
    ceilingUsd: typeof rawCeiling === "number" && Number.isFinite(rawCeiling) ? rawCeiling : null,
  };
}

function configuredRuntimeHash(status: JsonObject): string | undefined {
  for (const key of ["deploymentConfigHash", "configuredHash", "configHash"]) {
    const value = status[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function printStatus(
  log: (message: string) => void,
  report: {
    botId: string;
    venue: string;
    deployed: boolean;
    localConfigHash: string;
    runtimeConfigHash?: string;
    configDrift?: boolean;
    bankrollPolicy: {
      mode: "live" | "fixed";
      referenceUsd: number;
      ceilingUsd: number | null;
    };
    runtime: JsonObject;
  },
): void {
  const runtime = report.runtime;
  log(pc.bold(`${report.botId}  market-make  ${String(runtime.lifecycle ?? (runtime.halted ? "HALTED" : "ACTIVE"))}`));
  log(`  runtime:              ${report.deployed ? "deployed" : "local"}`);
  log(`  config:               ${report.localConfigHash}${report.runtimeConfigHash ? ` (runtime ${report.runtimeConfigHash})` : ""}`);
  if (report.configDrift) log(pc.yellow("  configuration drift:  yes — deploy/restart before resume"));
  if (runtime.activationCurrent === false) {
    log(pc.yellow("  activation:           stale — reconcile and explicitly resume the current deployment"));
  }
  if (runtime.haltReason) log(`  halt reason:           ${String(runtime.haltReason)}`);
  if (runtime.lossLatched === true || nestedBoolean(runtime, ["loss", "latched"])) {
    log(pc.red("  loss limits:           latched"));
  }
  const runtimeMode = runtime.bankrollMode === "live" || runtime.bankrollMode === "fixed"
    ? runtime.bankrollMode
    : report.bankrollPolicy.mode;
  const observed = runtime.bankrollObserved === true;
  const entryReady = runtime.bankrollEntryReady === true;
  const refreshPending = runtime.bankrollRefreshPending === true;
  const strategyCapitalUsd = numericStatus(runtime, [["strategyCapitalUsd"]]);
  const effectiveBankrollUsd = numericStatus(runtime, [["effectiveBankrollUsd"]]);
  const bankrollScale = numericStatus(runtime, [["bankrollScale"]]);
  const ceilingUsd = numericStatus(runtime, [["bankrollCeilingUsd"]]) ?? report.bankrollPolicy.ceilingUsd ?? undefined;
  if (runtimeMode === "live") {
    const capital = observed && strategyCapitalUsd !== undefined
      ? `$${strategyCapitalUsd.toFixed(2)} funded`
      : "awaiting authoritative balance";
    const effective = observed && effectiveBankrollUsd !== undefined
      ? `, $${effectiveBankrollUsd.toFixed(2)} effective${bankrollScale === undefined ? "" : ` (${bankrollScale.toFixed(3)}x reference)`}`
      : "";
    const authorization = observed
      ? refreshPending
        ? "entries paused for bankroll refresh"
        : entryReady ? "entries authorized" : "entries awaiting repeated clean snapshots"
      : "entries awaiting first snapshot";
    log(`  bankroll:             automatic — ${capital}${effective}; ceiling ${ceilingUsd === undefined ? "none" : `$${ceilingUsd.toFixed(2)}`}; ${authorization}`);
  } else {
    log(`  bankroll:             fixed at $${report.bankrollPolicy.referenceUsd.toFixed(2)}`);
  }
  log(`  exposure:             ${exposureSummary(runtime)}`);
  if (runtime.message) log(pc.dim(`  ${String(runtime.message)}`));
}

function exposureSummary(status: JsonObject): string {
  const activeMarkets = numericStatus(status, [
    ["activeMarkets"],
    ["counts", "activeInventoryCycles"],
    ["counts", "markets"],
    ["marketCount"],
  ]);
  const liveOrders = numericStatus(status, [
    ["liveOrders"],
    ["counts", "activeOrders"],
    ["orderCount"],
  ]);
  const deployedUsd = numericStatus(status, [
    ["deployedUsd"],
    ["inventoryCostUsd"],
    ["committedUsd"],
  ]);
  const reservedUsd = numericStatus(status, [["availability", "collateralReservedUsd"]]);
  const freeCollateral = numericStatus(status, [
    ["freeCollateralUsd"],
    ["freeCashUsd"],
    ["availability", "collateralFreeUsd"],
  ]);
  return [
    `${activeMarkets ?? "?"} active markets`,
    `${liveOrders ?? "?"} live orders`,
    deployedUsd === undefined
      ? reservedUsd === undefined
        ? "deployed $unknown"
        : `cash reserved $${reservedUsd.toFixed(2)}`
      : `deployed $${deployedUsd.toFixed(2)}`,
    freeCollateral === undefined ? "free collateral $unknown" : `free collateral $${freeCollateral.toFixed(2)}`,
  ].join(", ");
}

function numericStatus(status: JsonObject, paths: string[][]): number | undefined {
  for (const path of paths) {
    const value = nestedValue(status, path);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function printControlResult(log: (message: string) => void, result: unknown): void {
  if (isObject(result) && Object.keys(result).length > 0) log(pc.dim(JSON.stringify(result)));
}

function requireReachableRuntime(bot: BotConfig, deps: MarketMakeCommandDependencies): void {
  if (!isDeployed(bot) && !deps.localRuntimeAvailable(bot.id)) {
    throw new Error(
      `no running local runtime for "${bot.id}" — start \`cassie run ${bot.id}\`, or deploy it before using this command`,
    );
  }
}

function localControlSocketPath(botId: string): string {
  return join(dirs.run(), `${botId}.sock`);
}

async function marketMakeControl(bot: BotConfig, path: string, init: ControlInit = {}): Promise<unknown> {
  if (isDeployed(bot)) return controlFetch(bot, path, init);
  return localControlCall(localControlSocketPath(bot.id), path, init);
}

function localControlCall(socketPath: string, path: string, init: ControlInit): Promise<unknown> {
  if (!existsSync(socketPath)) {
    throw new Error(`local runtime control socket is not available at ${socketPath}`);
  }
  const method = init.method ?? "GET";
  const body = init.body;
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        socketPath,
        path: path.startsWith("/") ? path : `/${path}`,
        method,
        headers:
          body === undefined
            ? undefined
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size <= 4 * 1024 * 1024) chunks.push(buffer);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8").trim();
          let result: unknown = text;
          try {
            result = text ? JSON.parse(text) : {};
          } catch {
            // Preserve plain-text diagnostics from a failed local runtime.
          }
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            reject(new Error(`local control API ${response.statusCode ?? 500}: ${text.slice(0, 400)}`));
            return;
          }
          resolvePromise(result);
        });
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error("local control API timed out")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

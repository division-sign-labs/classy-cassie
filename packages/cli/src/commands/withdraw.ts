// packages/cli/src/commands/withdraw.ts
// `cassie withdraw <botId> <amount|all> --to <address>` — send collateral back
// out of a venue. Signs with the master/L1 key from the local keystore, so it
// runs on the machine that holds it; deployed bots cannot withdraw remotely.

import { existsSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import pc from "picocolors";
import type { BotConfig } from "@quotient-forecasting/cassie-core";
import {
  MarketMakeConfigSchema,
  marketMakeConfigHash,
} from "@quotient-forecasting/strategy-market-make";
import {
  adapterFor,
  confirm,
  controlFetch,
  isDeployed,
  makeSetupContext,
  requireAccount,
} from "../context.js";
import { dirs, loadBotConfig } from "../paths.js";

type JsonObject = Record<string, unknown>;

export interface WithdrawDependencies {
  loadConfig: typeof loadBotConfig;
  requireAccount: typeof requireAccount;
  adapterFor: typeof adapterFor;
  makeSetupContext: typeof makeSetupContext;
  confirm: typeof confirm;
  marketMakeStatus(config: BotConfig): Promise<unknown>;
  now(): number;
  log(message: string): void;
}

export interface WithdrawOptions {
  to?: string;
  yes?: boolean;
}

const ZERO_EPSILON = 1e-9;
const MAX_FUTURE_CLOCK_SKEW_MS = 30_000;

const DEFAULT_DEPS: WithdrawDependencies = {
  loadConfig: loadBotConfig,
  requireAccount,
  adapterFor,
  makeSetupContext,
  confirm,
  marketMakeStatus: fetchMarketMakeStatus,
  now: () => Date.now(),
  log: (message) => console.log(message),
};

export function createWithdrawHandler(
  overrides: Partial<WithdrawDependencies> = {},
): (botId: string, amountArg: string, opts: WithdrawOptions) => Promise<void> {
  const deps: WithdrawDependencies = { ...DEFAULT_DEPS, ...overrides };
  return async (botId, amountArg, opts) => {
    const cfg = deps.loadConfig(botId);
    const account = deps.requireAccount(cfg);
    // Before the EVM --to validation: a Kalshi withdrawal has no on-chain
    // destination at all, so the right error names the venue, not the flag.
    if (cfg.venue === "kalshi") {
      throw new Error("Kalshi withdrawals run on kalshi.com (Account → Withdraw, bank transfer); the API does not support them.");
    }
    if (!opts.to || !/^0x[0-9a-fA-F]{40}$/.test(opts.to)) {
      throw new Error("--to <address> required (0x… EVM address)");
    }
    const amount = amountArg.toLowerCase() === "all" ? ("all" as const) : Number(amountArg);
    if (amount !== "all" && !(amount > 0)) throw new Error("amount must be a positive number or 'all'");

    if (cfg.strategy.id === "market-make") {
      await requireFlatHaltedMarketMaker(cfg, deps);
    }

    // A market-maker withdrawal must unlock its signing credentials before the
    // final flat/HALTED status check. That keeps an interactive passphrase wait
    // from opening a stale-authorization window between the check and signing.
    const adapter = await deps.adapterFor(cfg, {
      needCreds: cfg.strategy.id === "market-make",
    });
    if (!adapter.withdraw) {
      throw new Error(
        cfg.venue === "lighter"
          ? "lighter withdrawals are not wired in the MVP — use the Lighter app with your L1 wallet"
          : `withdraw is not supported on the ${cfg.venue} venue`,
      );
    }

    const destChain = cfg.venue === "hyperliquid" ? "Arbitrum" : cfg.venue === "polymarket" ? "Polygon (pUSD)" : cfg.venue;
    deps.log(pc.bold("withdrawal:"));
    deps.log(`  bot:     ${botId} (${cfg.venue})`);
    deps.log(`  amount:  ${amount === "all" ? "entire balance" : amount}`);
    deps.log(`  to:      ${opts.to} on ${destChain}`);
    if (!opts.yes && !(await deps.confirm("send it?", false))) return;

    // Re-read authoritative status immediately before execution in both
    // interactive and --yes flows. An earlier prompt, adapter setup, or remote
    // status call must never authorize a later changed market-maker state.
    if (cfg.strategy.id === "market-make") {
      await requireFlatHaltedMarketMaker(cfg, deps);
    }

    const receipt = await adapter.withdraw(deps.makeSetupContext(botId), account, { to: opts.to, amount });
    deps.log(pc.green(receipt));
  };
}

const defaultWithdrawHandler = createWithdrawHandler();

export async function runWithdraw(botId: string, amountArg: string, opts: WithdrawOptions): Promise<void> {
  return defaultWithdrawHandler(botId, amountArg, opts);
}

async function requireFlatHaltedMarketMaker(
  cfg: BotConfig,
  deps: WithdrawDependencies,
): Promise<void> {
  let rawStatus: unknown;
  try {
    rawStatus = await deps.marketMakeStatus(cfg);
  } catch (error) {
    throw withdrawalRefusal(
      cfg.id,
      `runtime status is unreachable (${errorMessage(error)})`,
    );
  }
  assertFlatHaltedMarketMakeStatus(cfg, rawStatus, deps.now());
}

/**
 * Validate one live status response without trusting missing, duplicated, or
 * contradictory summary fields. HALTED intentionally makes activationCurrent
 * false, so reconciliation currency is proven from the exact config/deployment
 * identity and an applied reconciliation newer than that identity instead.
 */
export function assertFlatHaltedMarketMakeStatus(
  cfg: BotConfig,
  rawStatus: unknown,
  now: number,
): void {
  if (cfg.strategy.id !== "market-make") return;
  const refuse = (reason: string): never => {
    throw withdrawalRefusal(cfg.id, reason);
  };
  if (!isObject(rawStatus)) throw withdrawalRefusal(cfg.id, "runtime returned an ambiguous status payload");
  const status: JsonObject = rawStatus;
  const persistence = requiredObject(status, "persistence", refuse);
  const config = MarketMakeConfigSchema.safeParse(cfg.strategy.config);
  if (!config.success) throw withdrawalRefusal(cfg.id, "local market-make configuration is invalid");
  const policyConfig = config.data;
  const localConfigHash = marketMakeConfigHash(policyConfig);

  if (status.strategyId !== "market-make" || status.schemaVersion !== "q-directed-polymarket-mm/1") {
    refuse("runtime did not identify itself as the expected market-make controller");
  }
  if (status.started !== true) refuse("market-make controller is not started");
  if (status.lifecycle !== "HALTED" || persistence.lifecycle !== "HALTED") {
    refuse(`lifecycle must be HALTED (runtime ${renderValue(status.lifecycle)}, persisted ${renderValue(persistence.lifecycle)})`);
  }

  const runtimeConfigHash = requiredString(status, "configHash", refuse);
  const persistedConfigHash = requiredString(persistence, "deploymentConfigHash", refuse);
  if (runtimeConfigHash !== localConfigHash || persistedConfigHash !== localConfigHash) {
    refuse("configuration identity is stale or does not match this bot config");
  }
  const runtimeDeploymentId = requiredString(status, "deploymentId", refuse);
  const persistedDeploymentId = requiredString(persistence, "deploymentId", refuse);
  if (runtimeDeploymentId !== persistedDeploymentId) {
    refuse("runtime and persisted deployment identities do not match");
  }

  const reconciliation = requiredObject(status, "lastReconciliation", refuse);
  const persistedReconciliation = requiredObject(persistence, "lastReconciliation", refuse);
  const reconciliationId = requiredString(reconciliation, "id", refuse);
  const reconciliationTs = requiredFinite(reconciliation, "ts", refuse);
  const persistedReconciliationId = requiredString(persistedReconciliation, "id", refuse);
  const persistedReconciliationTs = requiredFinite(persistedReconciliation, "ts", refuse);
  if (
    reconciliation.ok !== true ||
    persistedReconciliation.ok !== true ||
    reconciliationId !== persistedReconciliationId ||
    reconciliationTs !== persistedReconciliationTs
  ) {
    refuse("last reconciliation is failed or ambiguous");
  }
  const deploymentUpdatedAt = requiredFinite(persistence, "deploymentUpdatedAt", refuse);
  const statusUpdatedAt = requiredFinite(persistence, "updatedAt", refuse);
  if (reconciliationTs < deploymentUpdatedAt) {
    refuse("last successful reconciliation predates the current configuration/deployment");
  }
  if (status.settlementQuiescent !== true) {
    refuse("settlement is not quiescent; recent orders, fills, redemptions, or reconciliation uncertainty remain");
  }
  const settlementQuiescentAt = requiredFinite(status, "settlementQuiescentAt", refuse);
  if (settlementQuiescentAt !== reconciliationTs) {
    refuse("settlement proof does not belong to the last successful applied reconciliation");
  }
  const freshnessMs = Math.max(60_000, policyConfig.reconciliation.rest_reconcile_seconds * 3_000);
  assertFreshTimestamp("runtime status", statusUpdatedAt, now, freshnessMs, refuse);
  assertFreshTimestamp("last reconciliation", reconciliationTs, now, freshnessMs, refuse);

  const counts = requiredObject(persistence, "counts", refuse);
  requireZero(status, "activeMarkets", "active market/inventory", refuse);
  requireZero(status, "liveOrders", "working/live order", refuse);
  requireZero(status, "deployedUsd", "deployed inventory", refuse);
  requireZero(counts, "activeInventoryCycles", "active inventory cycle", refuse);
  requireZero(counts, "activeOrders", "active order", refuse);
  requireZero(counts, "unknownOrders", "unknown order", refuse);
  requireZero(counts, "cancelPendingOrders", "cancel-pending order", refuse);

  const availability = requiredObject(persistence, "availability", refuse);
  requireZero(availability, "collateralReservedUsd", "reserved entry collateral", refuse);
  const tokenRows = availability.tokens;
  if (!Array.isArray(tokenRows)) {
    throw withdrawalRefusal(cfg.id, "persisted token-balance status is missing or ambiguous");
  }
  const tokens: unknown[] = tokenRows;
  for (const [index, token] of tokens.entries()) {
    if (!isObject(token)) throw withdrawalRefusal(cfg.id, `token-balance row ${index} is ambiguous`);
    const tokenRow: JsonObject = token;
    requireZero(tokenRow, "totalQuantity", `token inventory in row ${index}`, refuse);
    requireZero(tokenRow, "reservedQuantity", `reserved token inventory in row ${index}`, refuse);
    requireZero(tokenRow, "freeQuantity", `free token inventory in row ${index}`, refuse);
  }
}

function withdrawalRefusal(botId: string, reason: string): Error {
  return new Error(
    `refusing market-make withdrawal for "${botId}": ${reason}. ` +
      `Run \`cassie market-make halt ${botId}\`, then reconcile and check status until the current runtime is HALTED, completely flat, and past its late-fill settlement window`,
  );
}

function assertFreshTimestamp(
  label: string,
  timestamp: number,
  now: number,
  maximumAgeMs: number,
  refuse: (reason: string) => never,
): void {
  if (!Number.isFinite(now) || now < 0) refuse("local clock is invalid");
  if (timestamp > now + MAX_FUTURE_CLOCK_SKEW_MS) refuse(`${label} timestamp is implausibly in the future`);
  if (now - timestamp > maximumAgeMs) refuse(`${label} is stale`);
}

function requireZero(
  object: JsonObject,
  key: string,
  label: string,
  refuse: (reason: string) => never,
): void {
  const value = requiredFinite(object, key, refuse);
  if (Math.abs(value) > ZERO_EPSILON) refuse(`${label} is not zero (${value})`);
}

function requiredObject(
  object: JsonObject,
  key: string,
  refuse: (reason: string) => never,
): JsonObject {
  const value = object[key];
  if (!isObject(value)) refuse(`${key} is missing or ambiguous`);
  return value;
}

function requiredString(
  object: JsonObject,
  key: string,
  refuse: (reason: string) => never,
): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) refuse(`${key} is missing or ambiguous`);
  return value;
}

function requiredFinite(
  object: JsonObject,
  key: string,
  refuse: (reason: string) => never,
): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value)) refuse(`${key} is missing or ambiguous`);
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderValue(value: unknown): string {
  return typeof value === "string" ? value : "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180);
}

async function fetchMarketMakeStatus(cfg: BotConfig): Promise<unknown> {
  if (isDeployed(cfg)) return controlFetch(cfg, "/market-make/status");
  const socketPath = join(dirs.run(), `${cfg.id}.sock`);
  if (!existsSync(socketPath)) throw new Error(`local runtime control socket is not available at ${socketPath}`);
  return localStatusCall(socketPath);
}

function localStatusCall(socketPath: string): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const req = request({ socketPath, path: "/market-make/status", method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size <= 4 * 1024 * 1024) chunks.push(buffer);
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        if (size > 4 * 1024 * 1024) {
          reject(new Error("local runtime status response exceeded 4 MiB"));
          return;
        }
        let result: unknown;
        try {
          result = text ? JSON.parse(text) : {};
        } catch {
          reject(new Error(`local runtime returned invalid JSON (${text.slice(0, 180)})`));
          return;
        }
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          reject(new Error(`local control API ${response.statusCode ?? 500}: ${text.slice(0, 180)}`));
          return;
        }
        resolvePromise(result);
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error("local control API timed out")));
    req.on("error", reject);
    req.end();
  });
}

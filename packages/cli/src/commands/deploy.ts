// packages/cli/src/commands/deploy.ts
// `cassie deploy <botId>`: provision a DigitalOcean droplet in the operator's
// own account and run the bot on it under systemd. Credentials travel over SSH
// on stdin — never in argv, never in droplet user-data.

import { createHash } from "node:crypto";
import { join } from "node:path";
import pc from "picocolors";
import { MarketMakeConfigSchema } from "@quotient-forecasting/strategy-market-make";
import { QuotientSwingConfigSchema } from "@quotient-forecasting/strategy-quotient-swing";
import { type BotConfig } from "@quotient-forecasting/cassie-core";
import { adapterFor, buildRuntimeCreds, confirm, requireAccount } from "../context.js";
import { describeTelegramSettings, resolveTelegramSettings } from "../telegram-settings.js";
import { describeWebhookSettings, resolveWebhookSettings } from "../webhook-settings.js";
import { atomicWritePrivateFile, dirs, loadBotConfig, saveBotConfig } from "../paths.js";
import { resolveQuotientToken } from "../quotient-token.js";
import { resolveSurplusApiKey, verifySurplusApiKey } from "../surplus-config.js";
import {
  DEFAULT_REGION,
  DEFAULT_SIZE,
  DROPLET_IMAGE,
  READY_MARKER,
  UNIT_PATH,
  installRuntimeCommand,
  renderCloudInit,
  renderUnit,
  renderWorkspaceOverride,
} from "../cloud-init.js";
import { DigitalOcean, ensureDigitalOceanReady, publicIpv4, type Droplet } from "../digitalocean.js";
import { cliVersion } from "../version.js";
import { remoteWriteCommand } from "../remote-write.js";
import { resolvePolymarketGaslessAuth } from "../polymarket-gasless.js";
import { activateWorkspaceRuntime, buildWorkspaceRuntime, stageWorkspaceRuntime } from "../workspace-runtime.js";
import {
  controlCall,
  ControlApiError,
  ensureKeypair,
  forgetHostKey,
  pinHostKey,
  sshExec,
  sshExecOrThrow,
  type Target,
} from "../ssh.js";
import {
  DEFAULT_DASHBOARD_PORT,
  authFilePath,
  certFingerprintCommand,
  dashboardAuthFile,
  dashboardDisableCommands,
  dashboardEnvLines,
  dashboardOn,
  dashboardProvisionCommands,
  dashboardUrl,
  parseFingerprint,
  resolveDashboardConfig,
  verifyDashboardCommand,
} from "../dashboard/provision.js";

export interface DeployOpts {
  region?: string;
  size?: string;
  yes?: boolean;
  fromWorkspace?: boolean;
  /** undefined keeps the saved choice; false is --no-dashboard. */
  dashboard?: boolean;
  dashboardPort?: number;
}

type Deployment = NonNullable<BotConfig["deployment"]>;

/**
 * Stable identity for one exact saved deployment. A redeploy updates
 * `deployedAt`, so even reuse of the same droplet receives a new identity and
 * must pass the market-maker activation gates again.
 */
export function deploymentIdFor(deployment: Deployment): string {
  const canonical = JSON.stringify({
    provider: deployment.provider,
    dropletId: deployment.dropletId,
    host: deployment.host,
    region: deployment.region,
    size: deployment.size,
    user: deployment.user,
    deployedAt: deployment.deployedAt ?? null,
  });
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  return `do-${deployment.dropletId}-${digest}`;
}

export interface RuntimeStartResult {
  started: Record<string, unknown>;
  marketMakeStatus?: Record<string, unknown>;
  swingStatus?: Record<string, unknown>;
  executionStatus?: Record<string, unknown>;
}

export function isAdaptivePredictionDeployment(cfg: BotConfig): boolean {
  return isPredictionDeployment(cfg) && cfg.execution?.mode !== "legacy";
}

function isPredictionDeployment(cfg: BotConfig): boolean {
  return (cfg.venue === "polymarket" && ["signals", "flip-flat"].includes(cfg.strategy.id)) || (cfg.venue === "kalshi" && cfg.strategy.id === "kalshi-commodities");
}

export function runtimeAutostartBeforePreflights(cfg: BotConfig): "0" | "1" {
  return isPredictionDeployment(cfg) || ["market-make", "quotient-swing"].includes(cfg.strategy.id) ? "0" : "1";
}

interface ReconciliationWaitDeps { sleep: (milliseconds: number) => Promise<void> }
const reconciliationWait: ReconciliationWaitDeps = { sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) };

async function waitForPredictionReceipts(
  cfg: BotConfig,
  read: () => unknown,
  deps: ReconciliationWaitDeps,
  requireNoDeferredWork = false,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const execution = predictionExecutionStatus(read());
    const unresolved = (execution.parents as Record<string, unknown>[]).some(parent =>
      ["active", "canceling", "blocked"].includes(String(parent.status)),
    );
    const deferred = requireNoDeferredWork &&
      (Number(execution.queuedExitCount ?? 0) > 0 || Number(execution.unsettledFillCount ?? 0) > 0);
    if (!unresolved && !deferred) return execution;
    if (attempt === 9) {
      throw new Error(
        `adaptive execution remains paused with unresolved orders, queued exits or settlements${execution.haltReason ? `: ${String(execution.haltReason)}` : ""}. ` +
        `Review before retrying after reconciliation.\ncassie status ${cfg.id}\ncassie logs ${cfg.id}`,
      );
    }
    await deps.sleep(5_000);
  }
  throw new Error("prediction reconciliation did not complete");
}

/** A saved legacy setting cannot abandon receipts owned by the old adaptive process. */
export async function preparePredictionModeChange(
  cfg: BotConfig,
  deps: ReconciliationWaitDeps & { control: typeof controlCall } = { ...reconciliationWait, control: controlCall },
): Promise<void> {
  if (!isPredictionDeployment(cfg) || cfg.execution?.mode !== "legacy" || !cfg.deployment) return;
  const target: Target = { host: cfg.deployment.host, user: cfg.deployment.user };
  let previous: unknown;
  try {
    previous = deps.control(target, cfg.id, "GET", "/execution/status");
  } catch (error) {
    // Older legacy runtimes expose no execution route. Accept only the exact
    // route-not-found response emitted by their 404 handler; shutdown and an
    // authoritative empty /orders check are still mandatory afterward.
    if (error instanceof ControlApiError && (error.body as { error?: unknown } | undefined)?.error === "unknown route GET /execution/status") return;
    throw error;
  }
  if (previous && typeof previous === "object" && !Array.isArray(previous) &&
    (previous as Record<string, unknown>).enabled === false) return;
  predictionExecutionStatus(previous);
  deps.control(target, cfg.id, "POST", "/pause");
  await waitForPredictionReceipts(cfg, () => deps.control(target, cfg.id, "GET", "/execution/status"), deps, true);
}

/**
 * Complete activation only after the caller has run every live preflight.
 * Market making deliberately has no automatic resume or reconciliation apply:
 * its controller restores durable state and starts HALTED. The operator later
 * reviews an exact preview and applies that hash through the dedicated CLI.
 */
export async function startRuntimeAfterPreflights(
  cfg: BotConfig,
  call: (method: "GET" | "POST", path: string, body?: string) => unknown,
  deps: ReconciliationWaitDeps = reconciliationWait,
): Promise<RuntimeStartResult> {
  if (cfg.strategy.id === "kalshi-commodities") {
    call("POST", "/pause");
    return { started: asRecord(call("POST", "/init"), "/init") };
  }
  if (cfg.strategy.id === "quotient-swing") {
    // Startup reconciles the account and enables entries unless a durable halt remains.
    const started = asRecord(call("POST", "/init"), "/init");
    const status = asRecord(call("GET", "/swing/status"), "/swing/status");
    if (typeof status.halted !== "boolean") throw new Error("swing runtime returned an invalid execution status; inspect status and logs before retrying");
    return { started, swingStatus: status };
  }
  if (isAdaptivePredictionDeployment(cfg)) {
    // Keep entries paused while startup reconciles the restored parent ledger.
    call("POST", "/pause");
    const started = asRecord(call("POST", "/init"), "/init");
    let execution = await waitForPredictionReceipts(cfg, () => call("GET", "/execution/status"), deps);
    // Resume rechecks orders and inventory, and cannot clear an unknown POST.
    try {
      call("POST", "/resume");
      execution = predictionExecutionStatus(call("GET", "/execution/status"));
      if (execution.blocked !== false) {
        throw new Error(`adaptive execution remains blocked: ${String(execution.haltReason ?? "reconciliation required")}`);
      }
    } catch (error) {
      try { call("POST", "/pause"); }
      catch (pauseError) {
        throw new AggregateError([error, pauseError], "adaptive deployment failed and the runtime did not confirm it was paused; inspect its execution status before retrying");
      }
      throw error;
    }
    return { started, executionStatus: execution };
  }
  if (cfg.strategy.id !== "market-make") {
    call("POST", "/resume");
    return { started: asRecord(call("POST", "/init"), "/init") };
  }

  const started = asRecord(call("POST", "/init"), "/init");
  const status = asRecord(call("GET", "/market-make/status"), "/market-make/status");
  if (status.lifecycle !== "HALTED") {
    throw new Error(
      `refusing market-make deployment: expected HALTED after startup, got ${String(status.lifecycle ?? "unknown")}`,
    );
  }
  return { started, marketMakeStatus: status };
}

function predictionExecutionStatus(value: unknown): Record<string, unknown> {
  const status = asRecord(value, "/execution/status");
  if (typeof status.blocked !== "boolean" || !Array.isArray(status.parents) ||
    [status.queuedExitCount, status.unsettledFillCount].some(count => count !== undefined &&
      (typeof count !== "number" || !Number.isInteger(count) || count < 0)) ||
    status.parents.some(parent => !parent || typeof parent !== "object" || Array.isArray(parent) ||
      !["active", "canceling", "blocked", "completed", "canceled"].includes(String(parent.status)))) {
    throw new Error("adaptive runtime returned an invalid execution checkpoint; deployment remains paused");
  }
  return status;
}

function asRecord(value: unknown, route: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`runtime ${route} returned a non-object response`);
  }
  return value as Record<string, unknown>;
}

export function dropletName(botId: string): string {
  return `cassie-${botId}`;
}

export function firewallName(botId: string): string {
  return `cassie-${botId}`;
}

/**
 * Kalshi accepts API access from US IPs only — the inverse of Polymarket's
 * geoblock, which refuses them. Static allowlist of DigitalOcean's US region
 * slugs (verified against the DO region list on 2026-08-22).
 */
export const US_REGION_SLUGS = ["nyc1", "nyc2", "nyc3", "sfo1", "sfo2", "sfo3", "atl1"] as const;
export const KALSHI_DEFAULT_REGION = "nyc3";

export function assertRegionForVenue(venue: BotConfig["venue"], region: string): void {
  if (venue === "kalshi" && !(US_REGION_SLUGS as readonly string[]).includes(region)) {
    throw new Error(
      `Kalshi requires a US droplet; region "${region}" is not one. Use --region with one of: ${US_REGION_SLUGS.join(", ")}`,
    );
  }
}

/** Dot-progress for the two waits that take minutes: provisioning, then first boot. */
async function waitFor<T>(
  label: string,
  intervalMs: number,
  attempts: number,
  check: () => Promise<T | null>,
): Promise<T> {
  process.stdout.write(pc.dim(label));
  try {
    for (let i = 0; i < attempts; i++) {
      const result = await check();
      if (result !== null) {
        console.log(pc.dim(" done"));
        return result;
      }
      process.stdout.write(pc.dim("."));
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  } catch (error) {
    console.log("");
    throw error;
  }
  console.log("");
  throw new Error(`timed out ${label}`);
}

async function waitForActive(client: DigitalOcean, id: number): Promise<Droplet> {
  return waitFor("provisioning the droplet", 5_000, 120, async () => {
    const droplet = await client.droplet(id);
    return droplet.status === "active" && publicIpv4(droplet) ? droplet : null;
  });
}

async function waitForSsh(target: Target): Promise<true> {
  return waitFor("waiting for ssh", 5_000, 60, async () => (sshExec(target, "true").ok ? true : null));
}

async function waitForProvisioning(target: Target, fromWorkspace = false): Promise<true> {
  return waitFor("running first-boot setup", 10_000, 90, async () => {
    const result = sshExec(target, `test -f ${READY_MARKER} && command -v ${fromWorkspace ? "node" : "cassie"} >/dev/null`);
    return result.ok ? true : null;
  });
}

interface QuiesceDeps {
  exec: typeof sshExec;
  control: typeof controlCall;
  /** The venue's open orders for this bot's account, read from this machine. */
  venueOrders?: (cfg: BotConfig) => Promise<unknown>;
}

/** The same authoritative list the runtime's GET /orders returns, without the runtime. */
async function localVenueOrders(cfg: BotConfig): Promise<unknown> {
  const adapter = await adapterFor(cfg, { needCreds: true });
  return adapter.openOrders(requireAccount(cfg));
}

/** Stop the running bot and cancel its resting orders before replacing it. */
export async function quiesce(
  cfg: BotConfig,
  strict = false,
  deps: QuiesceDeps = { exec: sshExec, control: controlCall },
): Promise<void> {
  if (!cfg.deployment) return;
  const prediction = isPredictionDeployment(cfg);
  const swing = cfg.strategy.id === "quotient-swing";
  strict ||= prediction || swing;
  const kind = swing ? "swing" : prediction ? "prediction" : "market-make";
  const target: Target = { host: cfg.deployment.host, user: cfg.deployment.user };
  if (!deps.exec(target, "true").ok) {
    if (strict) {
      throw new Error(
        `refusing to replace the ${kind} droplet: the existing host is unreachable, so its durable state cannot be preserved`,
      );
    }
    console.log(pc.yellow("the existing droplet is unreachable; continuing without a clean stop"));
    return;
  }
  try {
    const shutdown = asRecord(deps.control(target, cfg.id, "POST", "/shutdown"), "/shutdown");
    if (shutdown.stopped !== true || shutdown.restingOrdersCanceled !== true) {
      throw new Error("runtime did not confirm a stopped process with resting orders canceled");
    }
    if (swing) {
      // Only the protected executor can prove a safe swing shutdown: it
      // reconciles cancellation-racing fills, resolves submissions, verifies
      // each owned SL's quantity/side/trigger geometry, and disarms deadman.
      // A generic cancel-all or a reduceOnly flag is not equivalent evidence.
      const cancellation = asRecord(shutdown.cancellation, "/shutdown cancellation");
      if (cancellation.method !== "engine" || cancellation.requested !== true ||
        cancellation.completed !== true || cancellation.protectiveOrdersRetained !== true) {
        throw new Error("runtime did not confirm native-stop-aware engine shutdown");
      }
    } else if (strict) {
      // Also defend upgrades from an older runtime whose /shutdown response did
      // not yet include authoritative venue verification.
      const remaining = deps.control(target, cfg.id, "GET", "/orders");
      if (!Array.isArray(remaining)) {
        throw new Error("authoritative /orders check returned a non-array response");
      }
      if (remaining.length > 0) {
        throw new Error(`authoritative /orders check found ${remaining.length} resting order(s)`);
      }
    }
    console.log(pc.green(swing ? "Swing runtime stopped; native stops retained." : "running bot stopped, resting orders canceled"));
  } catch (error) {
    if (strict) {
      if (swing) {
        throw new Error(
          `refusing to replace the swing runtime: protected shutdown was not verified (${(error as Error).message.slice(0, 220)}). ` +
          "Keep the existing runtime and restore reconciliation before redeploying",
        );
      }
      if (prediction) {
        const reason = (error as Error).message.slice(0, 220);
        if (deps.exec(target, `systemctl is-active --quiet cassie@${cfg.id}`).ok) {
          throw new Error(
            `refusing to replace the prediction runtime: shutdown cancellation was not verified (${reason}). ` +
            "Keep the existing droplet and restore its control API so cancellation and the authoritative order check can complete",
          );
        }
        // An interrupted redeploy can stop the service after a verified shutdown,
        // and then the control API is gone. Inactivity alone says nothing about
        // an order accepted before a crash, so ask the venue directly.
        await verifyStoppedPredictionRuntime(cfg, target, deps, reason);
        console.log(pc.green("running bot already stopped; the venue shows no resting orders"));
        return;
      }
      // A previous interrupted redeploy may already have completed the
      // shutdown and left the service inactive. In that case the control API
      // is expected to be unavailable, and there is nothing left to cancel.
      const active = deps.exec(target, `systemctl is-active --quiet cassie@${cfg.id}`).ok;
      if (!active) {
        console.log(pc.green("running bot already stopped; resting orders were canceled previously"));
      } else {
      throw new Error(
        `refusing to replace the market-make runtime: shutdown cancellation was not verified (${(error as Error).message.slice(0, 220)})`,
      );
      }
    } else {
      console.log(pc.yellow(`could not reach the running bot (${(error as Error).message.slice(0, 120)})`));
    }
  }
  const stopped = deps.exec(target, `systemctl stop cassie@${cfg.id}`);
  if (strict && !stopped.ok) {
    throw new Error(
      `refusing to replace the ${kind} droplet: could not stop its runtime cleanly (${(stopped.stderr || stopped.stdout).trim().slice(0, 160)})`,
    );
  }
}

async function verifyStoppedPredictionRuntime(
  cfg: BotConfig,
  target: Target,
  deps: QuiesceDeps,
  reason: string,
): Promise<void> {
  const refuse = (detail: string) => new Error(`refusing to replace the prediction runtime: ${detail}`);
  // Hold the unit stopped first so a systemd auto-restart cannot place an order behind the check.
  const held = deps.exec(target, `systemctl stop cassie@${cfg.id}`);
  if (!held.ok) {
    throw refuse(
      `its control API is down (${reason}) and the stopped service could not be held stopped ` +
      `(${(held.stderr || held.stdout).trim().slice(0, 160)})`,
    );
  }
  let orders: unknown;
  try {
    orders = await (deps.venueOrders ?? localVenueOrders)(cfg);
  } catch (error) {
    throw refuse(
      `the runtime is stopped and the ${cfg.venue} order check failed (${(error as Error).message.slice(0, 220)}). ` +
      "Redeploy again when the venue answers",
    );
  }
  if (!Array.isArray(orders)) throw refuse(`the ${cfg.venue} order check returned a non-array response`);
  if (orders.length > 0) {
    throw refuse(
      `the stopped runtime left ${orders.length} resting order(s) on ${cfg.venue}. ` +
      "Cancel them on the venue, or start the existing runtime so it can cancel them, then redeploy",
    );
  }
}

export interface PreservedRuntimeState {
  /** Local mode-0600 recovery artifact retained even after a successful move. */
  path: string;
  /** gzip-compressed SQLite main/WAL archive encoded for stdin-safe transport. */
  payload: string;
}

/**
 * Capture the closed SQLite database before replacing a durable runtime.
 * WAL/SHM are included defensively even though a clean close normally removes
 * them, so a recoverable inventory event cannot be stranded in a sidecar.
 */
export function preserveRuntimeState(
  cfg: BotConfig,
  deps: { exec: typeof sshExec; write: typeof atomicWritePrivateFile } = { exec: sshExec, write: atomicWritePrivateFile },
): PreservedRuntimeState | null {
  if (!cfg.deployment) return null;
  const target: Target = { host: cfg.deployment.host, user: cfg.deployment.user };
  const remotePath = `/var/lib/cassie/${cfg.id}.sqlite`;
  const missing = "__CASSIE_NO_RUNTIME_STATE__";
  const sidecars = [`${cfg.id}.sqlite-wal`, `${cfg.id}.sqlite-shm`];
  if (cfg.strategy.id === "quotient-swing") {
    sidecars.push(`${cfg.id}.sqlite.swing.sqlite`, `${cfg.id}.sqlite.swing.sqlite-wal`, `${cfg.id}.sqlite.swing.sqlite-shm`);
  }
  const captured = deps.exec(
    target,
    `set -o pipefail && if test -f '${remotePath}'; then files=('${cfg.id}.sqlite'); for sidecar in ${sidecars.map(name => `'${name}'`).join(" ")}; do test -e "/var/lib/cassie/$sidecar" && files+=("$sidecar"); done; tar -C /var/lib/cassie -czf - "\${files[@]}" | base64 -w0; else printf '${missing}'; fi`,
    // A long-running bot accumulates a large event log; the archive
    // must not be cut off by the default output cap.
    undefined,
    { maxBufferBytes: 1024 * 1024 * 1024 },
  );
  if (!captured.ok) {
    throw new Error(
      `refusing to replace the droplet: could not snapshot ${remotePath} (${(captured.stderr || captured.stdout).trim().slice(0, 160)})`,
    );
  }
  const payload = captured.stdout.trim();
  if (payload === missing) {
    if (isPredictionDeployment(cfg) || cfg.strategy.id === "quotient-swing") {
      const kind = cfg.strategy.id === "quotient-swing" ? "swing" : "prediction";
      throw new Error(`refusing to replace the ${kind} droplet: ${remotePath} is missing; its execution checkpoint cannot be preserved`);
    }
    console.log(pc.dim("existing droplet has no SQLite state to preserve"));
    return null;
  }
  if (!payload) {
    throw new Error(`refusing to replace the droplet: ${remotePath} produced an empty snapshot`);
  }
  const path = join(
    dirs.state(),
    "deployment-snapshots",
    `${cfg.id}-${deploymentIdFor(cfg.deployment)}.sqlite.tar.gz.b64`,
  );
  deps.write(path, `${payload}\n`);
  console.log("Runtime state preserved.");
  console.log(path);
  return { path, payload };
}

/** Restore a preserved DB before systemd is allowed to start the new runtime. */
export function restoreRuntimeState(
  target: Target,
  botId: string,
  snapshot: PreservedRuntimeState,
  deps: { exec: typeof sshExecOrThrow } = { exec: sshExecOrThrow },
): void {
  const remotePath = `/var/lib/cassie/${botId}.sqlite`;
  try {
    deps.exec(
      target,
      `umask 077 && base64 --decode | tar -xzf - -C /var/lib/cassie && test -f '${remotePath}' && chown cassie:cassie /var/lib/cassie/${botId}.sqlite* && chmod 0600 /var/lib/cassie/${botId}.sqlite*`,
      snapshot.payload,
    );
  } catch (error) {
    throw new Error(
      `could not restore runtime state on the new droplet; the recoverable snapshot remains at ${snapshot.path}: ${(error as Error).message}`,
    );
  }
  console.log("Runtime state restored.");
  console.log("Local recovery snapshot retained.");
}

/** Build an in-memory reachability record for a same-name orphaned droplet. */
function configAtDroplet(cfg: BotConfig, droplet: Droplet): BotConfig {
  const host = publicIpv4(droplet);
  if (!host) throw new Error(`refusing to replace droplet ${droplet.id}: it has no public IPv4`);
  return {
    ...cfg,
    deployment: {
      provider: "digitalocean",
      dropletId: droplet.id,
      host,
      region: droplet.region.slug,
      size: droplet.size_slug,
      user: "root",
      deployedAt: droplet.created_at,
    },
  };
}

/**
 * Market makers, swing and prediction bots preserve their closed database, including
 * execution-mode changes and same-droplet replacements. Keep the exported name.
 */
export function marketMakeStateSource(
  cfg: BotConfig,
  reuse: boolean,
  namedExisting: Droplet | null,
): BotConfig | null {
  if (!["market-make", "quotient-swing"].includes(cfg.strategy.id) && !isPredictionDeployment(cfg)) return null;
  if (reuse) return cfg.deployment ? cfg : null;
  if (cfg.deployment) return cfg;
  return namedExisting ? configAtDroplet(cfg, namedExisting) : null;
}

/**
 * Write a file on the droplet from stdin. The content never reaches argv, so it
 * stays out of the process list and the shell history. Written to a temporary
 * path first so a dropped connection cannot leave a half-written env file.
 */
function writeFile(target: Target, path: string, content: string, mode: string, owner: string): void {
  sshExecOrThrow(target, remoteWriteCommand(path, mode, owner), content);
}

export async function runDeploy(botId: string, opts: DeployOpts = {}): Promise<void> {
  const loadedCfg = loadBotConfig(botId);
  let cfg = loadedCfg;
  if (cfg.strategy.id === "quotient-swing") QuotientSwingConfigSchema.parse(cfg.strategy.config);
  if (cfg.venue === "lighter") {
    throw new Error("Lighter deployment is unsupported.");
  }
  if (!cfg.account) throw new Error("bot has no venue account — finish `cassie init` first");

  // Local compilation must succeed before any remote account or droplet mutation.
  const workspaceArtifact = opts.fromWorkspace ? buildWorkspaceRuntime() : undefined;

  // DigitalOcean setup runs first so the account questions land before the
  // passphrase prompt — nobody should unlock a keystore only to hit a login wall.
  const { client } = await ensureDigitalOceanReady();
  const version = workspaceArtifact?.version ?? cliVersion();

  const region =
    opts.region ?? cfg.deployment?.region ?? (cfg.venue === "kalshi" ? KALSHI_DEFAULT_REGION : DEFAULT_REGION);
  assertRegionForVenue(cfg.venue, region);
  const size = opts.size ?? cfg.deployment?.size ?? DEFAULT_SIZE;
  const regions = await client.regions();
  const chosen = regions.find((r) => r.slug === region);
  if (!chosen) {
    throw new Error(
      `region "${region}" is not available on this account. Available: ${regions.map((r) => r.slug).join(", ")}`,
    );
  }
  if (!chosen.sizes.includes(size)) {
    throw new Error(`size "${size}" is not offered in ${region}. Available: ${chosen.sizes.slice(0, 12).join(", ")}`);
  }

  const creds = await buildRuntimeCreds(cfg);
  const polymarketGaslessAuth = await resolvePolymarketGaslessAuth(cfg);
  const twoSidedMaker = cfg.strategy.id === "market-make" && Boolean(cfg.strategy.config.two_sided) && !MarketMakeConfigSchema.parse(cfg.strategy.config).two_sided?.adaptive;
  const resolvedQuotient = twoSidedMaker ? undefined : await resolveQuotientToken(botId);
  if (!twoSidedMaker && !resolvedQuotient) {
    throw new Error(
      "no Quotient signals key found — set QUOTIENT_API_TOKEN/QUOTIENT_API_KEY in the environment or nearest .local.env, " +
        "store quotient-token in this bot's keystore, or log in with the quotient CLI. Deployment stopped so the droplet " +
        "cannot keep running on an older key by accident.",
    );
  }
  const quotientToken = resolvedQuotient?.token ?? null;
  // Name the winning source. Never print any part of the key itself.
  if (resolvedQuotient) console.log(pc.dim(`signals credential: ${resolvedQuotient.origin}`));
  // The agent strategy cannot run without its LLM credential; verify locally
  // before any droplet work so a bad key fails in seconds, not mid-deploy.
  let surplusApiKey: string | null = null;
  if (cfg.strategy.id === "agent") {
    const resolvedSurplus = await resolveSurplusApiKey(botId);
    if (!resolvedSurplus) {
      throw new Error(
        `the ${cfg.strategy.id} strategy needs SURPLUS_API_KEY in the environment, nearest .local.env, or bot keystore. ` +
          "Deployment stopped so the droplet cannot come up with a strategy it cannot run.",
      );
    }
    console.log(pc.dim(`Surplus credential: ${resolvedSurplus.origin}`));
    await verifySurplusApiKey(resolvedSurplus.value);
    console.log(pc.green("Surplus API key verified locally"));
    surplusApiKey = resolvedSurplus.value;
  }
  const telegram = await resolveTelegramSettings(botId, cfg.alerts.telegram);
  console.log(pc.dim(describeTelegramSettings(telegram)));
  const webhook = await resolveWebhookSettings(botId);
  console.log(pc.dim(describeWebhookSettings(webhook)));

  const dashboard = await resolveDashboardConfig(cfg, opts);
  if (dashboard.passwordOrigin) console.log(pc.dim(`dashboard password: ${dashboard.passwordOrigin}`));
  if (dashboard.skipped) console.log(pc.yellow(`Dashboard skipped: ${dashboard.skipped}`));
  const dashboardChanged =
    dashboard.config.passwordHash !== cfg.dashboard?.passwordHash ||
    ((opts.dashboard !== undefined || opts.dashboardPort !== undefined) && JSON.stringify(dashboard.config) !== JSON.stringify(cfg.dashboard));
  if (dashboardChanged) {
    // Saved now so an interrupted deploy keeps the hash the operator just typed.
    cfg = { ...cfg, dashboard: dashboard.config };
    saveBotConfig(cfg);
  }
  const previousDashboardPort = loadedCfg.dashboard?.port;
  const serveDashboard = dashboardOn(cfg);

  const name = dropletName(botId);
  const existing = cfg.deployment ? await client.droplet(cfg.deployment.dropletId).catch(() => null) : null;
  const reuse = existing !== null && existing.region.slug === region && existing.size_slug === size;
  const namedExisting = reuse ? null : await client.dropletByName(name);

  console.log("");
  if (workspaceArtifact) {
    console.log("Workspace build");
    console.log(workspaceArtifact.id);
  }
  if (reuse) {
    console.log(`Redeploy: ${botId}`);
    console.log(`Region: ${chosen.name}`);
    console.log(`Size: ${existing!.size_slug}`);
    console.log(publicIpv4(existing!));
  } else {
    console.log(`New droplet: ${name}`);
    console.log(`Region: ${chosen.name}`);
    console.log(`Size: ${size}`);
    const replacement = existing ?? namedExisting;
    if (replacement) console.log(pc.yellow(`the current droplet in ${replacement.region.slug} will be replaced`));
  }
  if (!opts.yes && !(await confirm("Deploy?", true))) return;

  const { publicKey } = ensureKeypair();
  const sshKeyId = await client.upsertSshKey("cassie", publicKey);

  const replacementStateSource = marketMakeStateSource(cfg, reuse, namedExisting);
  if ((isPredictionDeployment(cfg) || cfg.strategy.id === "quotient-swing") && replacementStateSource?.deployment && namedExisting &&
    replacementStateSource.deployment.dropletId !== namedExisting.id) {
    const kind = cfg.strategy.id === "quotient-swing" ? "swing" : "adaptive";
    throw new Error(`refusing ${kind} replacement: the saved deployment and same-name droplet differ; reconcile both hosts before replacing either execution checkpoint`);
  }
  let stagedWorkspace: ReturnType<typeof stageWorkspaceRuntime> | undefined;
  if (workspaceArtifact && reuse) {
    const stagingHost = publicIpv4(existing!);
    if (!stagingHost) throw new Error("the existing droplet has no public IPv4 address");
    // Upload and smoke-test while the previous executable is still running.
    stagedWorkspace = stageWorkspaceRuntime({ host: stagingHost, user: "root" }, botId, workspaceArtifact);
  }
  if (replacementStateSource) await preparePredictionModeChange(replacementStateSource);
  await quiesce(replacementStateSource ?? cfg, replacementStateSource !== null);
  const preservedState = replacementStateSource ? preserveRuntimeState(replacementStateSource) : null;

  let droplet: Droplet;
  if (reuse) {
    droplet = existing!;
  } else {
    // Replace rather than run two of the same bot. The old one was already
    // quiesced above, so its resting orders are gone before this point.
    const stale = [existing, namedExisting].filter(
      (d): d is Droplet => d !== null && d !== undefined,
    );
    for (const old of new Map(stale.map((d) => [d.id, d])).values()) {
      await client.deleteDroplet(old.id).catch(() => undefined);
      const oldHost = publicIpv4(old);
      if (oldHost) forgetHostKey(oldHost);
    }
    const created = await client.createDroplet({
      name,
      region,
      size,
      image: DROPLET_IMAGE,
      sshKeyIds: [sshKeyId],
      userData: renderCloudInit({ runtimeVersion: version, ...(workspaceArtifact ? { tarball: true } : {}) }),
      tags: ["cassie", `cassie-bot-${botId}`],
    });
    droplet = await waitForActive(client, created.id);
  }
  await client
    .upsertFirewall(firewallName(botId), droplet.id, { inboundTcpPorts: serveDashboard ? [22, cfg.dashboard!.port] : [22] })
    .catch((error) => {
      console.log(pc.yellow(`firewall not applied: ${(error as Error).message.slice(0, 160)}${serveDashboard ? "; the dashboard stays unreachable from outside" : ""}`));
    });

  const host = publicIpv4(droplet);
  if (!host) throw new Error("the droplet came up without a public IPv4 address");
  const target: Target = { host, user: "root" };

  if (!reuse) {
    await waitFor("waiting for sshd", 1, 1, async () => {
      await pinHostKey(host);
      return true;
    });
    await waitForSsh(target);
    await waitForProvisioning(target, Boolean(workspaceArtifact));
  } else {
    await waitForSsh(target);
    // A redeploy from a newer CLI has to move the droplet's runtime with it, or
    // the box keeps running whatever the first deploy installed.
    const installed = workspaceArtifact ? undefined : sshExec(target, "cassie runtime --version 2>/dev/null || true").stdout.trim();
    if (!workspaceArtifact && installed !== version) {
      process.stdout.write(pc.dim(`updating the runtime to ${version}… `));
      sshExecOrThrow(target, installRuntimeCommand(version));
      writeFile(target, UNIT_PATH, renderUnit(version), "0644", "root:root");
      sshExecOrThrow(target, "systemctl daemon-reload");
      console.log(pc.green("ok"));
    }
  }
  console.log(`Droplet ready: ${name}`);
  console.log(host);

  if (preservedState && !reuse) {
    restoreRuntimeState(target, botId, preservedState);
  } else if (preservedState) {
    console.log("Runtime state retained on the droplet.");
    console.log("Local recovery snapshot retained.");
  }

  if (serveDashboard) {
    process.stdout.write(pc.dim("installing the dashboard… "));
    for (const command of dashboardProvisionCommands(botId, host, cfg.dashboard!.port, { previousPort: previousDashboardPort })) {
      sshExecOrThrow(target, command);
    }
    writeFile(target, authFilePath(botId), dashboardAuthFile(cfg.dashboard!.passwordHash!), "0600", "cassie:cassie");
    console.log(pc.green("ok"));
  } else if (reuse && dashboardOn(loadedCfg)) {
    // This droplet served the dashboard before; close the port and drop the hash.
    for (const command of dashboardDisableCommands(botId, previousDashboardPort ?? DEFAULT_DASHBOARD_PORT)) sshExec(target, command);
  }

  const overrideDir = `/etc/systemd/system/cassie@${botId}.service.d`;
  const overridePath = `${overrideDir}/workspace-runtime.conf`;
  if (workspaceArtifact) {
    stagedWorkspace ??= stageWorkspaceRuntime(target, botId, workspaceArtifact);
    activateWorkspaceRuntime(target, botId, stagedWorkspace);
    sshExecOrThrow(target, `install -d -m 0755 '${overrideDir}'`);
    writeFile(target, overridePath, renderWorkspaceOverride(botId), "0644", "root:root");
  } else {
    // Returning to npm removes only this bot's executable override, retaining releases.
    sshExecOrThrow(target, `rm -f '${overridePath}'`);
  }

  // Record the deployment before verifying. A failure below then leaves a
  // droplet cassie still knows how to reach rather than an orphan visible only
  // in the DigitalOcean dashboard.
  const deployedCfg: BotConfig = {
    ...cfg,
    deployment: {
      provider: "digitalocean",
      dropletId: droplet.id,
      host,
      region: droplet.region.slug,
      size: droplet.size_slug,
      user: "root",
      deployedAt: new Date().toISOString(),
    },
  };
  saveBotConfig(deployedCfg);
  const deploymentId = deploymentIdFor(deployedCfg.deployment!);

  const env: [string, string | null][] = [
    ["CASSIE_BOT_ID", botId],
    // Compact, not pretty-printed: systemd's EnvironmentFile unescapes \" inside
    // a quoted value but leaves \n as a literal backslash-n, which lands in the
    // middle of the JSON and fails to parse. One line has no newlines to escape.
    ["CASSIE_BOT_CONFIG", JSON.stringify(deployedCfg)],
    ["CASSIE_BOT_CREDS", creds ? JSON.stringify(creds) : null],
    ["CASSIE_POLYMARKET_GASLESS_AUTH", polymarketGaslessAuth ? JSON.stringify(polymarketGaslessAuth) : null],
    ["CASSIE_DEPLOYMENT_ID", deploymentId],
    // Durable controllers wait for live checks and restored-state reconciliation.
    ["CASSIE_AUTOSTART", workspaceArtifact ? "0" : runtimeAutostartBeforePreflights(deployedCfg)],
    ["CASSIE_REQUIRED_REGION", droplet.region.slug],
    ["QUOTIENT_API_TOKEN", quotientToken],
    ["TELEGRAM_BOT_TOKEN", telegram.token ?? null],
    ["TELEGRAM_CHAT_ID", telegram.chatId ?? null],
    ["CASSIE_WEBHOOK_URL", webhook.url ?? null],
    ["CASSIE_WEBHOOK_SECRET", webhook.secret ?? null],
    ["SURPLUS_API_KEY", surplusApiKey],
    ...dashboardEnvLines(deployedCfg),
  ];
  const lines: string[] = [];
  for (const [key, value] of env) {
    if (!value) {
      // Silence here reads as "set" — say which capability is off instead.
      console.log(pc.dim(`${key}: not set locally, skipping`));
      continue;
    }
    if (/[\r\n]/.test(value)) {
      throw new Error(`${key} contains a newline; systemd would deliver it escaped and the runtime would fail to parse it`);
    }
    lines.push(`${key}=${JSON.stringify(value)}`);
  }
  process.stdout.write(pc.dim("installing credentials… "));
  writeFile(target, `/etc/cassie/${botId}.env`, `${lines.join("\n")}\n`, "0600", "cassie:cassie");
  console.log(pc.green("ok"));

  // Autostart is held off until the checks below pass, so a droplet that comes
  // back in the wrong place cannot start trading on its own.
  sshExecOrThrow(target, `systemctl daemon-reload && systemctl enable --now cassie@${botId}`);
  await waitFor("starting the runtime", 2_000, 45, async () => {
    const probe = sshExec(target, `curl -s --unix-socket /run/cassie/${botId}.sock http://localhost/health`);
    return probe.ok && probe.stdout.includes('"ok"') ? true : null;
  });

  const runtime = controlCall(target, botId, "GET", "/runtime") as {
    runtime?: string;
    region?: string;
    requiredRegion?: string;
    version?: string;
    buildId?: string;
  };
  if (runtime.runtime !== "droplet" || runtime.region !== droplet.region.slug || runtime.requiredRegion !== droplet.region.slug) {
    throw new Error(`refusing to resume: expected a droplet in ${droplet.region.slug}, got ${JSON.stringify(runtime)}`);
  }
  if (workspaceArtifact && runtime.buildId !== workspaceArtifact.id) {
    throw new Error(`refusing to resume: expected workspace build ${workspaceArtifact.id}, got ${String(runtime.buildId ?? "no build identity")}; the runtime remains idle`);
  }
  console.log(`Runtime region verified: ${runtime.region}`);

  let fingerprint: string | null = null;
  if (serveDashboard) {
    const port = cfg.dashboard!.port;
    const answered = await waitFor("checking the dashboard", 1_000, 10, async () => {
      const probe = sshExec(target, verifyDashboardCommand(port));
      return probe.ok && probe.stdout.trim() === "401" ? true : null;
    }).catch(() => null);
    if (!answered) console.log(pc.yellow(`dashboard not answering on ${dashboardUrl(host, port)}; the bot is unaffected. cassie logs ${botId}`));
    fingerprint = parseFingerprint(sshExec(target, certFingerprintCommand()).stdout);
  }

  if (deployedCfg.venue === "polymarket") {
    const geoblock = controlCall(target, botId, "GET", "/geoblock/check") as {
      blocked?: boolean;
      country?: string;
      region?: string;
    };
    if (geoblock.blocked) {
      const where = [geoblock.country, geoblock.region].filter(Boolean).join("/") || "unknown";
      throw new Error(
        `refusing to resume: Polymarket does not accept orders from ${chosen.name} (${where}). ` +
          `Trading remains idle.\ncassie deploy ${botId} --region <slug>`,
      );
    }
    console.log(pc.green(`Polymarket order placement permitted from ${geoblock.country ?? chosen.name}`));
  }

  if (deployedCfg.venue === "kalshi") {
    const access = controlCall(target, botId, "GET", "/venue/check") as { blocked?: boolean; detail?: string };
    if (access.blocked) {
      throw new Error(
        `refusing to resume: Kalshi rejected API access from ${chosen.name}${access.detail ? ` (${access.detail})` : ""}. ` +
          `Trading remains idle.\ncassie deploy ${botId} --region ${KALSHI_DEFAULT_REGION}`,
      );
    }
    console.log(pc.green(`Kalshi API access verified from ${chosen.name}`));
  }

  const signals = controlCall(target, botId, "GET", "/signals/check") as { count?: number; required?: boolean };
  console.log(signals.required === false
    ? "Quotient credential not required."
    : `Quotient verified: ${signals.count ?? 0} published rows.`);

  if (deployedCfg.strategy.id === "agent") {
    const agent = controlCall(target, botId, "GET", "/agent/check") as {
      enabled?: boolean;
      promptSet?: boolean;
      model?: string;
    };
    if (!agent.enabled || !agent.promptSet) {
      throw new Error("refusing to resume: the droplet's agent check found no usable mandate/credential");
    }
    console.log(pc.green(`agent strategy verified by the droplet (model ${agent.model ?? "unknown"})`));
  }

  const startup = await startRuntimeAfterPreflights(
    deployedCfg,
    (method, path, body) => controlCall(target, botId, method, path, body),
  );
  if (deployedCfg.strategy.id === "market-make") {
    console.log("Market-make running; entries halted.");
  }
  if (workspaceArtifact || runtimeAutostartBeforePreflights(deployedCfg) === "0") {
    // First boot waits for preflights and reconciliation. Later process restarts
    // can start their loops; durable pause/activation state still governs trading.
    const restartLines = lines.map((line) =>
      line.startsWith("CASSIE_AUTOSTART=") ? `CASSIE_AUTOSTART=${JSON.stringify("1")}` : line,
    );
    writeFile(
      target,
      `/etc/cassie/${botId}.env`,
      `${restartLines.join("\n")}\n`,
      "0600",
      "cassie:cassie",
    );
  }
  if (!["market-make", "quotient-swing"].includes(deployedCfg.strategy.id)) {
    const tickIntervalMin =
      typeof startup.started.tickIntervalMin === "number"
        ? startup.started.tickIntervalMin
        : deployedCfg.tickIntervalMin;
    const positionCheckSeconds = Number((tickIntervalMin * 60).toFixed(4));
    const signalCheckMinutes = Number(
      Number(
        (deployedCfg.strategy.config as Record<string, unknown>).signalPollIntervalMin ?? 5,
      ).toFixed(4),
    );
    console.log(`Position checks: ${positionCheckSeconds}s`);
    console.log(`Signal refresh: ${signalCheckMinutes}m`);
  }

  console.log("");
  if (serveDashboard) {
    console.log(`Dashboard: ${dashboardUrl(host, cfg.dashboard!.port)}`);
    if (fingerprint) console.log(`Certificate fingerprint (self-signed): ${fingerprint}`);
    console.log("The browser warns once about the self-signed certificate; compare the fingerprint, then continue.");
    console.log("");
  }
  if (deployedCfg.strategy.id === "kalshi-commodities") {
    console.log(`${botId} installed; trading paused.`);
    console.log(`cassie commodities dry-run ${botId}`);
    console.log(`cassie commodities resume ${botId}`);
    return;
  }
  if (deployedCfg.strategy.id === "quotient-swing") {
    const execution = startup.swingStatus?.execution as Record<string, unknown> | undefined;
    if (startup.swingStatus?.halted) {
      console.log(`${botId} running; entries halted.`);
      console.log(`Reason: ${String(execution?.haltReason ?? "operator or drawdown halt")}`);
      console.log(`cassie swing resume ${botId}`);
      console.log("Position protection remains active.");
    } else if (execution?.entriesPaused) {
      console.log(`${botId} running on ${name}; entries wait: ${String(execution.entriesPaused)} (clears on its own).`);
    } else {
      console.log(`${botId} live on ${name}.`);
    }
    console.log(`cassie swing status ${botId}`);
    console.log(`cassie logs ${botId}`);
    return;
  }
  if (deployedCfg.strategy.id === "market-make") {
    console.log(`${botId} installed; trading halted.`);
    console.log(`cassie market-make reconcile ${botId}`);
    console.log(`cassie market-make reconcile ${botId} --apply`);
    console.log(`cassie market-make dry-run ${botId}`);
    console.log(`cassie market-make status ${botId}`);
    console.log(`cassie market-make resume ${botId}`);
  } else {
    console.log(`${botId} live on ${name}.`);
    console.log(`cassie status ${botId}`);
  }
  console.log(`cassie logs ${botId}`);
  console.log(`cassie destroy ${botId}`);
}

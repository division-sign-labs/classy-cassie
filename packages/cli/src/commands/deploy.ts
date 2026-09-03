// packages/cli/src/commands/deploy.ts
// `cassie deploy <botId>`: provision a DigitalOcean droplet in the operator's
// own account and run the bot on it under systemd. Credentials travel over SSH
// on stdin — never in argv, never in droplet user-data.

import { createHash } from "node:crypto";
import { join } from "node:path";
import pc from "picocolors";
import { KeyRoles, type BotConfig } from "@quotient-forecasting/cassie-core";
import { buildRuntimeCreds, confirm, getKeystoreSecret } from "../context.js";
import { atomicWritePrivateFile, dirs, loadBotConfig, saveBotConfig } from "../paths.js";
import { resolveQuotientToken } from "../quotient-token.js";
import { discoverAresBuilderCode, resolveAresApiKey, verifyAresApiKey } from "../ares-config.js";
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
} from "../cloud-init.js";
import { DigitalOcean, ensureDigitalOceanReady, publicIpv4, type Droplet } from "../digitalocean.js";
import { cliVersion } from "../version.js";
import {
  controlCall,
  ensureKeypair,
  forgetHostKey,
  pinHostKey,
  sshExec,
  sshExecOrThrow,
  type Target,
} from "../ssh.js";

export interface DeployOpts {
  region?: string;
  size?: string;
  yes?: boolean;
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
}

/**
 * Complete activation only after the caller has run every live preflight.
 * Market making deliberately has no automatic resume or reconciliation apply:
 * its controller restores durable state and starts HALTED. The operator later
 * reviews an exact preview and applies that hash through the dedicated CLI.
 */
export function startRuntimeAfterPreflights(
  cfg: BotConfig,
  call: (method: "GET" | "POST", path: string, body?: string) => unknown,
): RuntimeStartResult {
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

async function waitForProvisioning(target: Target): Promise<true> {
  return waitFor("running first-boot setup", 10_000, 90, async () => {
    const result = sshExec(target, `test -f ${READY_MARKER} && command -v cassie-runtime >/dev/null`);
    return result.ok ? true : null;
  });
}

interface QuiesceDeps {
  exec: typeof sshExec;
  control: typeof controlCall;
}

/** Stop the running bot and cancel its resting orders before replacing it. */
export function quiesce(
  cfg: BotConfig,
  strict = false,
  deps: QuiesceDeps = { exec: sshExec, control: controlCall },
): void {
  if (!cfg.deployment) return;
  const target: Target = { host: cfg.deployment.host, user: cfg.deployment.user };
  if (!deps.exec(target, "true").ok) {
    if (strict) {
      throw new Error(
        "refusing to replace the market-make droplet: the existing host is unreachable, so its durable state cannot be preserved",
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
    if (strict) {
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
    console.log(pc.green("running bot stopped, resting orders canceled"));
  } catch (error) {
    if (strict) {
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
      `refusing to replace the market-make droplet: could not stop its runtime cleanly (${(stopped.stderr || stopped.stdout).trim().slice(0, 160)})`,
    );
  }
}

interface PreservedMarketMakeState {
  /** Local mode-0600 recovery artifact retained even after a successful move. */
  path: string;
  /** gzip-compressed SQLite main/WAL archive encoded for stdin-safe transport. */
  payload: string;
}

/**
 * Capture the closed SQLite database before deleting a market-maker droplet.
 * WAL/SHM are included defensively even though a clean close normally removes
 * them, so a recoverable inventory event cannot be stranded in a sidecar.
 */
function preserveMarketMakeState(cfg: BotConfig): PreservedMarketMakeState | null {
  if (!cfg.deployment) return null;
  const target: Target = { host: cfg.deployment.host, user: cfg.deployment.user };
  const remotePath = `/var/lib/cassie/${cfg.id}.sqlite`;
  const missing = "__CASSIE_NO_MARKET_MAKE_STATE__";
  const captured = sshExec(
    target,
    `set -o pipefail && if test -f '${remotePath}'; then files=('${cfg.id}.sqlite'); for sidecar in '${cfg.id}.sqlite-wal' '${cfg.id}.sqlite-shm'; do test -e "/var/lib/cassie/$sidecar" && files+=("$sidecar"); done; tar -C /var/lib/cassie -czf - "\${files[@]}" | base64 -w0; else printf '${missing}'; fi`,
    // A long-running market maker accumulates a large event log; the archive
    // must not be cut off by the default output cap.
    undefined,
    { maxBufferBytes: 1024 * 1024 * 1024 },
  );
  if (!captured.ok) {
    throw new Error(
      `refusing to replace the market-make droplet: could not snapshot ${remotePath} (${(captured.stderr || captured.stdout).trim().slice(0, 160)})`,
    );
  }
  const payload = captured.stdout.trim();
  if (payload === missing) {
    console.log(pc.dim("existing droplet has no market-make SQLite state to preserve"));
    return null;
  }
  if (!payload) {
    throw new Error(`refusing to replace the market-make droplet: ${remotePath} produced an empty snapshot`);
  }
  const path = join(
    dirs.state(),
    "deployment-snapshots",
    `${cfg.id}-${deploymentIdFor(cfg.deployment)}.sqlite.tar.gz.b64`,
  );
  atomicWritePrivateFile(path, `${payload}\n`);
  console.log(pc.green(`market-make state preserved at ${path}`));
  return { path, payload };
}

/** Restore a preserved DB before systemd is allowed to start the new runtime. */
function restoreMarketMakeState(target: Target, botId: string, snapshot: PreservedMarketMakeState): void {
  const remotePath = `/var/lib/cassie/${botId}.sqlite`;
  try {
    sshExecOrThrow(
      target,
      `umask 077 && base64 --decode | tar -xzf - -C /var/lib/cassie && test -f '${remotePath}' && chown cassie:cassie /var/lib/cassie/${botId}.sqlite* && chmod 0600 /var/lib/cassie/${botId}.sqlite*`,
      snapshot.payload,
    );
  } catch (error) {
    throw new Error(
      `could not restore market-make state on the new droplet; the recoverable snapshot remains at ${snapshot.path}: ${(error as Error).message}`,
    );
  }
  console.log(pc.green("market-make state restored on the new droplet (local recovery snapshot retained)"));
}

/** Build an in-memory reachability record for a same-name orphaned droplet. */
function configAtDroplet(cfg: BotConfig, droplet: Droplet): BotConfig {
  const host = publicIpv4(droplet);
  if (!host) throw new Error(`refusing to replace market-make droplet ${droplet.id}: it has no public IPv4`);
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
 * A market-maker always snapshots a closed database before redeploying,
 * including a same-droplet runtime replacement. Non-MM deployments retain the
 * existing best-effort behavior.
 */
export function marketMakeStateSource(
  cfg: BotConfig,
  reuse: boolean,
  namedExisting: Droplet | null,
): BotConfig | null {
  if (cfg.strategy.id !== "market-make") return null;
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
  const tmp = `${path}.tmp`;
  sshExecOrThrow(
    target,
    `umask 077 && cat > '${tmp}' && chown ${owner} '${tmp}' && chmod ${mode} '${tmp}' && mv '${tmp}' '${path}'`,
    content,
  );
}

export async function runDeploy(botId: string, opts: DeployOpts = {}): Promise<void> {
  const cfg = loadBotConfig(botId);
  if (cfg.venue === "lighter") {
    throw new Error("lighter is not a supported venue — use `cassie run`");
  }
  if (!cfg.account) throw new Error("bot has no venue account — finish `cassie init` first");

  // DigitalOcean setup runs first so the account questions land before the
  // passphrase prompt — nobody should unlock a keystore only to hit a login wall.
  const { client } = await ensureDigitalOceanReady();
  const version = cliVersion();

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
  const resolvedQuotient = await resolveQuotientToken(botId);
  if (!resolvedQuotient) {
    throw new Error(
      "no Quotient signals key found — set QUOTIENT_API_TOKEN/QUOTIENT_API_KEY in the environment or nearest .local.env, " +
        "store quotient-token in this bot's keystore, or log in with the quotient CLI. Deployment stopped so the droplet " +
        "cannot keep running on an older key by accident.",
    );
  }
  const quotientToken = resolvedQuotient.token;
  // Name the winning source. Never print any part of the key itself.
  console.log(pc.dim(`signals credential: ${resolvedQuotient.origin}`));
  // The agent strategy cannot run without its LLM credential; verify locally
  // before any droplet work so a bad key fails in seconds, not mid-deploy.
  let surplusApiKey: string | null = null;
  if (cfg.strategy.id === "agent") {
    const resolvedSurplus = await resolveSurplusApiKey(botId);
    if (!resolvedSurplus) {
      throw new Error(
        "this bot runs the agent strategy but no SURPLUS_API_KEY was found in the environment, nearest .local.env, or bot keystore. " +
          "Deployment stopped so the droplet cannot come up with a strategy it cannot run.",
      );
    }
    console.log(pc.dim(`Surplus credential: ${resolvedSurplus.origin}`));
    await verifySurplusApiKey(resolvedSurplus.value);
    console.log(pc.green("Surplus API key verified locally"));
    surplusApiKey = resolvedSurplus.value;
  }
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? (await getKeystoreSecret(botId, KeyRoles.telegramToken));
  const discoveredBuilder = discoverAresBuilderCode();
  if (
    cfg.reporting &&
    discoveredBuilder &&
    discoveredBuilder.value.toLowerCase() !== cfg.reporting.builderCode.toLowerCase()
  ) {
    throw new Error(
      `reporting.builderCode differs from ${discoveredBuilder.origin}; run \`cassie reporting ${botId}\` to choose explicitly`,
    );
  }
  const resolvedAres = cfg.reporting ? await resolveAresApiKey(botId) : null;
  if (cfg.reporting?.post && !resolvedAres) {
    throw new Error(
      "Ares posting is enabled for this bot but no ARES_API_KEY was found in the nearest .local.env, environment, or bot keystore",
    );
  }
  let aresUsername: string | undefined;
  if (resolvedAres) {
    console.log(pc.dim(`Ares authoring key: ${resolvedAres.origin}`));
    aresUsername = await verifyAresApiKey(resolvedAres.value, cfg.reporting?.baseUrl);
    console.log(pc.green(`Ares key verified locally for @${aresUsername}`));
  }

  const name = dropletName(botId);
  const existing = cfg.deployment ? await client.droplet(cfg.deployment.dropletId).catch(() => null) : null;
  const reuse = existing !== null && existing.region.slug === region && existing.size_slug === size;
  const namedExisting = reuse ? null : await client.dropletByName(name);

  console.log("");
  if (reuse) {
    console.log(pc.bold(`redeploying ${botId} to ${name} in ${chosen.name}`));
    console.log(pc.dim(`${existing!.size_slug}  ${publicIpv4(existing!)}`));
  } else {
    console.log(pc.bold(`deploying ${botId} to a new droplet in ${chosen.name}`));
    console.log(pc.dim(`${name}  ${size}  ${DROPLET_IMAGE}`));
    const replacement = existing ?? namedExisting;
    if (replacement) console.log(pc.yellow(`the current droplet in ${replacement.region.slug} will be replaced`));
  }
  if (!opts.yes && !(await confirm("Deploy?", true))) return;

  const { publicKey } = ensureKeypair();
  const sshKeyId = await client.upsertSshKey("cassie", publicKey);

  const replacementStateSource = marketMakeStateSource(cfg, reuse, namedExisting);
  quiesce(replacementStateSource ?? cfg, replacementStateSource !== null);
  const preservedMarketMakeState = replacementStateSource ? preserveMarketMakeState(replacementStateSource) : null;

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
      userData: renderCloudInit({ runtimeVersion: version }),
      tags: ["cassie", `cassie-bot-${botId}`],
    });
    droplet = await waitForActive(client, created.id);
    await client.upsertFirewall(firewallName(botId), droplet.id).catch((error) => {
      console.log(pc.yellow(`firewall not applied: ${(error as Error).message.slice(0, 160)}`));
    });
  }

  const host = publicIpv4(droplet);
  if (!host) throw new Error("the droplet came up without a public IPv4 address");
  const target: Target = { host, user: "root" };

  if (!reuse) {
    await waitFor("waiting for sshd", 1, 1, async () => {
      await pinHostKey(host);
      return true;
    });
    await waitForSsh(target);
    await waitForProvisioning(target);
  } else {
    await waitForSsh(target);
    // A redeploy from a newer CLI has to move the droplet's runtime with it, or
    // the box keeps running whatever the first deploy installed.
    const installed = sshExec(target, "cassie-runtime --version 2>/dev/null || true").stdout.trim();
    if (installed !== version) {
      process.stdout.write(pc.dim(`updating the runtime to ${version}… `));
      sshExecOrThrow(target, installRuntimeCommand(version));
      writeFile(target, UNIT_PATH, renderUnit(version), "0644", "root:root");
      sshExecOrThrow(target, "systemctl daemon-reload");
      console.log(pc.green("ok"));
    }
  }
  console.log(pc.green(`droplet ${name} ready at ${host} (${droplet.region.slug})`));

  if (preservedMarketMakeState && !reuse) {
    restoreMarketMakeState(target, botId, preservedMarketMakeState);
  } else if (preservedMarketMakeState) {
    console.log(pc.green("market-make state remains in place on the stopped droplet (local recovery snapshot retained)"));
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
    ["CASSIE_BOT_CREDS", JSON.stringify(creds)],
    ["CASSIE_DEPLOYMENT_ID", deploymentId],
    // A market-maker's controller starts only after live checks. Reconciliation
    // remains review-only until the operator applies the exact preview hash.
    ["CASSIE_AUTOSTART", deployedCfg.strategy.id === "market-make" ? "0" : "1"],
    ["CASSIE_REQUIRED_REGION", droplet.region.slug],
    ["QUOTIENT_API_TOKEN", quotientToken],
    ["TELEGRAM_BOT_TOKEN", telegramToken],
    ["ARES_API_KEY", resolvedAres?.value ?? null],
    ["SURPLUS_API_KEY", surplusApiKey],
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
  };
  if (runtime.runtime !== "droplet" || runtime.region !== droplet.region.slug || runtime.requiredRegion !== droplet.region.slug) {
    throw new Error(`refusing to resume: expected a droplet in ${droplet.region.slug}, got ${JSON.stringify(runtime)}`);
  }
  console.log(pc.green(`runtime verified: droplet in ${runtime.region} (${chosen.name})`));

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
          `The bot is installed and idle. Redeploy elsewhere with: cassie deploy ${botId} --region <slug>`,
      );
    }
    console.log(pc.green(`Polymarket order placement permitted from ${geoblock.country ?? chosen.name}`));
  }

  if (deployedCfg.venue === "kalshi") {
    const access = controlCall(target, botId, "GET", "/venue/check") as { blocked?: boolean; detail?: string };
    if (access.blocked) {
      throw new Error(
        `refusing to resume: Kalshi rejected API access from ${chosen.name}${access.detail ? ` (${access.detail})` : ""}. ` +
          `The bot is installed and idle. Redeploy to a US region with: cassie deploy ${botId} --region ${KALSHI_DEFAULT_REGION}`,
      );
    }
    console.log(pc.green(`Kalshi API access verified from ${chosen.name}`));
  }

  const signals = controlCall(target, botId, "GET", "/signals/check") as { count?: number };
  console.log(pc.green(`signals credential verified by the droplet (${signals.count ?? 0} published rows)`));

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

  if (deployedCfg.reporting?.post) {
    const check = controlCall(target, botId, "GET", "/reporting/check") as {
      enabled?: boolean;
      username?: string;
      builderCodeConfigured?: boolean;
    };
    if (!check.enabled || !check.builderCodeConfigured || !check.username || (aresUsername && check.username !== aresUsername)) {
      throw new Error("refusing to resume: the droplet's Ares reporting check did not match local configuration");
    }
    console.log(pc.green(`Ares reporting verified by the droplet for @${check.username}`));
  }

  const startup = startRuntimeAfterPreflights(
    deployedCfg,
    (method, path, body) => controlCall(target, botId, method, path, body),
  );
  if (deployedCfg.strategy.id === "market-make") {
    console.log(pc.green("market-make controller loops started in HALTED mode; reconciliation still requires review"));
    // The first boot was intentionally held until preflights and halted init.
    // Persist autostart for later host/process restarts; durable activation
    // state still decides whether those loops may add inventory.
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
  } else {
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
    console.log(
      pc.green(`loop started: positions every ${positionCheckSeconds}s; signals every ${signalCheckMinutes}m`),
    );
  }

  console.log("");
  if (deployedCfg.strategy.id === "market-make") {
    console.log(pc.bold(`${botId} is installed on ${name} in ${chosen.name} and remains HALTED.`));
    console.log(`  cassie market-make reconcile ${botId}`);
    console.log(`  cassie market-make reconcile ${botId} --apply`);
    console.log(`  cassie market-make dry-run ${botId}`);
    console.log(`  cassie market-make status ${botId}`);
    console.log(`  cassie market-make resume ${botId}`);
  } else {
    console.log(pc.bold(`${botId} is live on ${name} in ${chosen.name}.`));
    console.log(`  cassie status ${botId}`);
  }
  console.log(`  cassie logs ${botId}`);
  console.log(`  cassie destroy ${botId}`);
}

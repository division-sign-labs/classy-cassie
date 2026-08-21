// packages/cli/src/commands/deploy.ts
// `cassie deploy <botId>`: provision a DigitalOcean droplet in the operator's
// own account and run the bot on it under systemd. Credentials travel over SSH
// on stdin — never in argv, never in droplet user-data.

import pc from "picocolors";
import { KeyRoles, type BotConfig } from "@quotient-forecasting/cassie-core";
import { buildRuntimeCreds, confirm, getKeystoreSecret } from "../context.js";
import { loadBotConfig, saveBotConfig } from "../paths.js";
import { resolveQuotientToken } from "../quotient-token.js";
import { discoverAresBuilderCode, resolveAresApiKey, verifyAresApiKey } from "../ares-config.js";
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

export function dropletName(botId: string): string {
  return `cassie-${botId}`;
}

export function firewallName(botId: string): string {
  return `cassie-${botId}`;
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

/** Stop the running bot and cancel its resting orders before replacing it. */
function quiesce(cfg: BotConfig): void {
  if (!cfg.deployment) return;
  const target: Target = { host: cfg.deployment.host, user: cfg.deployment.user };
  if (!sshExec(target, "true").ok) {
    console.log(pc.yellow("the existing droplet is unreachable; continuing without a clean stop"));
    return;
  }
  try {
    controlCall(target, cfg.id, "POST", "/shutdown");
    console.log(pc.green("running bot stopped, resting orders canceled"));
  } catch (error) {
    console.log(pc.yellow(`could not reach the running bot (${(error as Error).message.slice(0, 120)})`));
  }
  sshExec(target, `systemctl stop cassie@${cfg.id} || true`);
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

  const region = opts.region ?? cfg.deployment?.region ?? DEFAULT_REGION;
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

  console.log("");
  if (reuse) {
    console.log(pc.bold(`redeploying ${botId} to ${name} in ${chosen.name}`));
    console.log(pc.dim(`${existing!.size_slug}  ${publicIpv4(existing!)}`));
  } else {
    console.log(pc.bold(`deploying ${botId} to a new droplet in ${chosen.name}`));
    console.log(pc.dim(`${name}  ${size}  ${DROPLET_IMAGE}`));
    if (existing) console.log(pc.yellow(`the current droplet in ${existing.region.slug} will be replaced`));
  }
  if (!opts.yes && !(await confirm("Deploy?", true))) return;

  const { publicKey } = ensureKeypair();
  const sshKeyId = await client.upsertSshKey("cassie", publicKey);

  quiesce(cfg);

  let droplet: Droplet;
  if (reuse) {
    droplet = existing!;
  } else {
    // Replace rather than run two of the same bot. The old one was already
    // quiesced above, so its resting orders are gone before this point.
    const stale = [existing, await client.dropletByName(name)].filter(
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

  const env: [string, string | null][] = [
    ["CASSIE_BOT_ID", botId],
    // Compact, not pretty-printed: systemd's EnvironmentFile unescapes \" inside
    // a quoted value but leaves \n as a literal backslash-n, which lands in the
    // middle of the JSON and fails to parse. One line has no newlines to escape.
    ["CASSIE_BOT_CONFIG", JSON.stringify(deployedCfg)],
    ["CASSIE_BOT_CREDS", JSON.stringify(creds)],
    ["CASSIE_REQUIRED_REGION", droplet.region.slug],
    ["QUOTIENT_API_TOKEN", quotientToken],
    ["TELEGRAM_BOT_TOKEN", telegramToken],
    ["ARES_API_KEY", resolvedAres?.value ?? null],
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

  const signals = controlCall(target, botId, "GET", "/signals/check") as { count?: number };
  console.log(pc.green(`signals credential verified by the droplet (${signals.count ?? 0} published rows)`));

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

  controlCall(target, botId, "POST", "/resume");
  const started = controlCall(target, botId, "POST", "/init") as { tickIntervalMin?: number };
  console.log(pc.green(`loop started: every ${started.tickIntervalMin ?? cfg.tickIntervalMin} minutes`));

  console.log("");
  console.log(pc.bold(`${botId} is live on ${name} in ${chosen.name}.`));
  console.log(`  cassie status ${botId}`);
  console.log(`  cassie logs ${botId}`);
  console.log(`  cassie destroy ${botId}`);
}

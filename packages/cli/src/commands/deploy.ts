// packages/cli/src/commands/deploy.ts
// `cassie deploy <botId>` (§11): wraps wrangler against the operator's own
// Cloudflare account. Secrets are piped via stdin and never echoed.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { KeyRoles, serializeBotConfig } from "@quotient-forecasting/cassie-core";
import { buildRuntimeCreds, confirm, getKeystoreSecret, keystore, getPassphrase } from "../context.js";
import { ensureCloudflareReady, registerWorkersDevSubdomain } from "../cloudflare.js";
import { forgetControlToken, loadBotConfig, readControlToken, saveBotConfig, saveControlToken } from "../paths.js";
import { resolveQuotientToken } from "../quotient-token.js";
import { discoverAresBuilderCode, resolveAresApiKey, verifyAresApiKey } from "../ares-config.js";
import { runWrangler, type WranglerProject } from "../wrangler.js";

const require = createRequire(import.meta.url);

function workspaceRuntime(dir: string): boolean {
  return existsSync(join(dir, "../../pnpm-workspace.yaml"));
}

function runtimeProject(dir: string, packaged: boolean): WranglerProject | null {
  const config = join(dir, packaged ? "wrangler.package.jsonc" : "wrangler.jsonc");
  return existsSync(config) ? { cwd: dir, config } : null;
}

function runtimeCfProject(): WranglerProject {
  const explicit = process.env.CASSIE_RUNTIME_CF;
  if (explicit) {
    const project = runtimeProject(explicit, false) ?? runtimeProject(explicit, true);
    if (project) return project;
  }

  // Source checkout: packages/cli/dist/commands -> packages/runtime-cf.
  const adjacent = join(dirname(fileURLToPath(import.meta.url)), "../../../runtime-cf");
  const source = runtimeProject(adjacent, false);
  if (source && workspaceRuntime(adjacent)) return source;

  // Published install: resolve the runtime package rather than assuming npm's
  // dependency layout. Its Dockerfile installs the pinned Container runtime.
  try {
    const installed = dirname(require.resolve("@quotient-forecasting/cassie-runtime-cf/package.json"));
    const project = runtimeProject(installed, !workspaceRuntime(installed));
    if (project) return project;
  } catch {
    // Fall through to the cwd candidate for contributor workflows.
  }

  const fromCwd = join(process.cwd(), "packages/runtime-cf");
  const project = runtimeProject(fromCwd, false);
  if (project) return project;
  throw new Error("cannot locate the Cassie Cloudflare runtime (set CASSIE_RUNTIME_CF to its path)");
}

function ensureDockerRunning(): void {
  const result = spawnSync("docker", ["info"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(
      "Cloudflare Container deploys require Docker. Start Docker Desktop (or another Docker-compatible engine), then retry.",
    );
  }
}

/**
 * A fresh Cloudflare account has no workers.dev subdomain, so there is nowhere
 * to publish and the deploy fails. wrangler offers to register one, but the
 * prompt degrades to its non-interactive `no` fallback because we pipe stdio
 * here (secrets go in on stdin later). Detected so we can hand the terminal
 * over and let wrangler run its own registration flow.
 */
function isMissingSubdomainError(out: string): boolean {
  return /workers\.dev subdomain/i.test(out) && /register/i.test(out);
}

/**
 * Call the deployed control API, tolerating DNS and secret propagation. A just-registered workers.dev
 * subdomain resolves nowhere for a minute or two, which surfaces as a thrown
 * `fetch failed` rather than an HTTP status. Retry those; surface HTTP
 * responses immediately, since those mean the worker answered.
 */
async function deployedControlRequest(
  controlUrl: string,
  botId: string,
  controlToken: string,
  action: string,
  method: "GET" | "POST",
  attempts = 24,
): Promise<Response> {
  let lastErr: unknown;
  let announced = false;
  const waitFor = async (what: string, ms: number) => {
    if (!announced) {
      process.stdout.write(pc.dim(`waiting for ${what}`));
      announced = true;
    }
    process.stdout.write(pc.dim("."));
    await new Promise((r) => setTimeout(r, ms));
  };

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${controlUrl}/bots/${botId}/${action}`, {
        method,
        headers: { authorization: `Bearer ${controlToken}` },
      });
      // A 401 immediately after pushing a fresh CONTROL_TOKEN is the secret not
      // having reached the running isolate yet — on a redeploy the worker is
      // still checking against the *previous* deploy's token. Transient, and
      // indistinguishable from a real auth failure except by waiting.
      if (res.status === 401 && i < attempts - 1) {
        lastErr = new Error("401 (CONTROL_TOKEN not propagated yet)");
        await waitFor("the new control token to propagate", 5_000);
        continue;
      }
      if ((res.status === 500 || res.status === 503) && i < attempts - 1) {
        const detail = await res.clone().text().catch(() => "");
        lastErr = new Error(`${res.status}: ${detail.slice(0, 200)}`);
        await waitFor("the EEUR Container to provision", 15_000);
        continue;
      }
      if (announced) console.log("");
      return res;
    } catch (err) {
      lastErr = err;
      await waitFor("the workers.dev DNS record to resolve", 15_000);
    }
  }
  console.log("");
  throw new Error(
    `could not call ${action} at ${controlUrl} after ${attempts} tries (${String(lastErr)}).\n` +
      "The worker itself deployed and its secrets are set — this is the new subdomain's DNS\n" +
      "or the CONTROL_TOKEN secret still propagating.\n" +
      "Wait a minute and run `cassie deploy` again; it picks up from here.",
  );
}

async function quiesceExistingDeployment(
  cfg: ReturnType<typeof loadBotConfig>,
  controlToken: string | null,
): Promise<void> {
  if (!cfg.controlUrl) return;
  if (!controlToken) {
    throw new Error("cannot safely replace the deployed runtime: its existing control token is unavailable");
  }

  const shutdown = await deployedControlRequest(cfg.controlUrl, cfg.id, controlToken, "shutdown", "POST", 3);
  if (shutdown.ok) {
    const result = (await shutdown.json()) as { schedulesCanceled?: number; restingOrdersCanceled?: boolean };
    console.log(
      pc.green(
        `old runtime quiesced${result.schedulesCanceled === undefined ? "" : ` (${result.schedulesCanceled} schedules canceled)`}`,
      ),
    );
    return;
  }
  if (shutdown.status !== 404) {
    throw new Error(`old runtime shutdown failed: ${shutdown.status} ${(await shutdown.text()).slice(0, 300)}`);
  }

  // Compatibility with Workers deployed before /shutdown existed. Pausing
  // prevents their surviving alarm from trading while the new runtime starts.
  const pause = await deployedControlRequest(cfg.controlUrl, cfg.id, controlToken, "pause", "POST", 3);
  if (!pause.ok) throw new Error(`old runtime pause failed: ${pause.status} ${(await pause.text()).slice(0, 300)}`);
  const cancel = await deployedControlRequest(cfg.controlUrl, cfg.id, controlToken, "orders/cancel-all", "POST", 3);
  if (!cancel.ok) throw new Error(`old runtime cancel-all failed: ${cancel.status} ${(await cancel.text()).slice(0, 300)}`);
  console.log(pc.yellow("old runtime lacked /shutdown; it is paused and all resting orders were canceled"));
}

export async function runDeploy(botId: string, opts: { rotateToken?: boolean } = {}): Promise<void> {
  const rotateToken = opts.rotateToken === true;
  const cfg = loadBotConfig(botId);
  if (cfg.venue === "lighter") {
    throw new Error("lighter is not yet wired and verified in the deployed Container runtime — use `cassie run`");
  }
  if (cfg.venue !== "fixture" && cfg.signals.source !== "live") {
    console.log(pc.yellow("deployed bots need live signals; fixture mode is local-only. Setting signals.source=live for the deployed config."));
  }
  const account = cfg.account;
  if (!account) throw new Error("bot has no venue account — finish `cassie init` first");

  // Cloudflare setup runs first so the account questions land before the
  // passphrase prompt — nobody should unlock a keystore only to hit a login wall.
  const project = runtimeCfProject();
  const { accountId } = await ensureCloudflareReady(project.cwd);
  ensureDockerRunning();

  const creds = await buildRuntimeCreds(cfg);
  const resolvedQuotient = await resolveQuotientToken(botId);
  if (!resolvedQuotient) {
    throw new Error(
      "no Quotient signals key found — set QUOTIENT_API_TOKEN/QUOTIENT_API_KEY in the environment or nearest .local.env, " +
        "store quotient-token in this bot's keystore, or log in with the quotient CLI. Deployment stopped so an old " +
        "Cloudflare secret cannot remain active by accident.",
    );
  }
  const quotientToken = resolvedQuotient.token;
  // Always name the winning source. Never print any part of the key itself.
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
  const reportingApiKey = resolvedAres?.value ?? null;

  const existingToken = await getKeystoreSecret(botId, KeyRoles.controlToken);
  const oldControlToken = readControlToken(botId) ?? existingToken;
  const controlToken = rotateToken || !existingToken ? randomBytes(32).toString("hex") : existingToken;

  const workerName = `cassie-bot-${botId}`;
  console.log(pc.bold(`deploying ${workerName} as a Cloudflare Container constrained to EEUR`));
  if (!(await confirm("continue?", true))) return;

  await quiesceExistingDeployment(cfg, oldControlToken);

  let dep = runWrangler(["deploy", "--name", workerName, "--containers-rollout=immediate"], project);
  if (!dep.ok && isMissingSubdomainError(dep.out)) {
    if (!(await registerWorkersDevSubdomain(project.cwd, workerName, accountId, project.config))) {
      throw new Error("deploy stopped: no workers.dev subdomain on this Cloudflare account yet.");
    }
    // The interactive run already published; repeat it piped to capture the URL.
    dep = runWrangler(["deploy", "--name", workerName, "--containers-rollout=immediate"], project);
  }
  process.stdout.write(dep.out);
  if (!dep.ok) throw new Error(`wrangler deploy failed:\n${dep.out.slice(-800)}`);
  const urlMatch = dep.out.match(/https:\/\/[^\s]+\.workers\.dev/);
  if (!urlMatch) throw new Error("could not find workers.dev URL in wrangler output");
  const controlUrl = urlMatch[0];

  // Control token (§11), stored locally + as a Worker secret. Reused across
  // redeploys: rotating it on every deploy invalidated any other terminal
  // holding the old one, and left a window where warm state still compared
  // against the previous value. Rotate deliberately with `--rotate-token`.
  if (controlToken !== existingToken) {
    keystore().putEntry(botId, KeyRoles.controlToken, controlToken, await getPassphrase(), { runtimeEligible: false });
    if (rotateToken) console.log(pc.dim("control token rotated"));
  }

  const idKey = botId.toUpperCase().replaceAll("-", "_");
  const deployedCfg = { ...cfg, signals: { ...cfg.signals, source: "live" as const, fixturePath: undefined }, controlUrl };
  const secrets: [string, string | null][] = [
    ["CONTROL_TOKEN", controlToken],
    [`BOT_${idKey}_CONFIG`, serializeBotConfig(deployedCfg)],
    [`BOT_${idKey}_CREDS`, JSON.stringify(creds)],
    ["TELEGRAM_BOT_TOKEN", telegramToken],
    ["ARES_API_KEY", reportingApiKey],
    ["QUOTIENT_API_TOKEN", quotientToken],
  ];
  for (const [name, value] of secrets) {
    if (!value) {
      // Silence here reads as "set" — say which capability is off instead.
      console.log(pc.dim(`secret ${name}: not set locally, skipping`));
      continue;
    }
    process.stdout.write(pc.dim(`secret put ${name}… `));
    const res = runWrangler(["secret", "put", name, "--name", workerName], project, value);
    if (!res.ok) throw new Error(`wrangler secret put ${name} failed:\n${res.out.slice(-500)}`);
    console.log(pc.green("ok"));
  }

  // The worker and its secrets are live from here on. Record that before
  // starting the schedule, so a failure below leaves a deployment cassie still
  // knows how to reach rather than an orphan only visible in the CF dashboard.
  saveBotConfig(deployedCfg);

  const runtimeRes = await deployedControlRequest(controlUrl, botId, controlToken, "runtime", "GET");
  if (!runtimeRes.ok) {
    throw new Error(`container runtime check failed: ${runtimeRes.status} ${(await runtimeRes.text()).slice(0, 300)}`);
  }
  const runtime = (await runtimeRes.json()) as { runtime?: string; region?: string; requiredRegion?: string; location?: string };
  if (runtime.runtime !== "cloudflare-container" || runtime.region !== "EEUR" || runtime.requiredRegion !== "EEUR") {
    throw new Error(`refusing to resume: expected cloudflare-container in EEUR, got ${JSON.stringify(runtime)}`);
  }
  console.log(pc.green(`runtime verified: Cloudflare Container in EEUR${runtime.location ? ` (${runtime.location})` : ""}`));

  if (deployedCfg.venue === "polymarket") {
    const geoblockRes = await deployedControlRequest(controlUrl, botId, controlToken, "geoblock/check", "GET");
    if (!geoblockRes.ok) {
      throw new Error(`Polymarket region check failed: ${geoblockRes.status} ${(await geoblockRes.text()).slice(0, 300)}`);
    }
    const geoblock = (await geoblockRes.json()) as { blocked?: boolean; country?: string; region?: string };
    if (geoblock.blocked) {
      throw new Error(
        `refusing to resume: Polymarket reports the EEUR Container location as blocked (${geoblock.country ?? "unknown"}/${geoblock.region ?? "unknown"})`,
      );
    }
    console.log(pc.green(`Polymarket order placement permitted from container (${geoblock.country ?? "unknown"})`));
  }

  // Verify the deployed Worker is actually using a key accepted by the signal
  // gateway. This is read-only and happens before the schedule is restarted.
  const signalRes = await deployedControlRequest(controlUrl, botId, controlToken, "signals/check", "GET");
  if (!signalRes.ok) {
    throw new Error(
      `deployed signal credential check failed: ${signalRes.status} ${(await signalRes.text()).slice(0, 300)}\n` +
        "Schedule was not restarted. Fix the reported credential source and deploy again.",
    );
  }
  const signalCheck = (await signalRes.json()) as { count?: number };
  console.log(pc.green(`signals credential verified by deployed runtime (${signalCheck.count ?? 0} published rows)`));

  if (deployedCfg.reporting?.post) {
    const reportingRes = await deployedControlRequest(controlUrl, botId, controlToken, "reporting/check", "GET");
    if (!reportingRes.ok) {
      throw new Error(`deployed Ares credential check failed: ${reportingRes.status} ${(await reportingRes.text()).slice(0, 300)}`);
    }
    const check = (await reportingRes.json()) as {
      enabled?: boolean;
      username?: string;
      builderCodeConfigured?: boolean;
    };
    if (!check.enabled || !check.builderCodeConfigured || !check.username || (aresUsername && check.username !== aresUsername)) {
      throw new Error(`refusing to resume: deployed Ares reporting check did not match local configuration`);
    }
    console.log(pc.green(`Ares reporting verified by deployed runtime for @${check.username}`));
  }

  const resumeRes = await deployedControlRequest(controlUrl, botId, controlToken, "resume", "POST");
  if (!resumeRes.ok) throw new Error(`resume failed: ${resumeRes.status} ${(await resumeRes.text()).slice(0, 300)}`);

  // Start the tick schedule. A freshly registered workers.dev subdomain can
  // take a few minutes to resolve, so a connection-level failure here means
  // "DNS hasn't caught up", not "the worker is broken".
  const initRes = await deployedControlRequest(controlUrl, botId, controlToken, "init", "POST");
  if (!initRes.ok) {
    throw new Error(`init failed: ${initRes.status} ${(await initRes.text()).slice(0, 300)}`);
  }
  console.log(pc.green(`container loop started: ${JSON.stringify(await initRes.json())}`));

  // Local agent access. Reads against a deployed bot (logs, portfolio, orders)
  // otherwise unlock the keystore just to fetch this token — which means a
  // coding agent driving the CLI stalls on a passphrase prompt it cannot
  // answer. Deploy already holds the token, so granting costs nothing here.
  // Asked every deploy so answering no also revokes.
  console.log("");
  console.log(pc.dim("Agents and scripts can read this bot (logs, portfolio, orders) without"));
  console.log(pc.dim("your keystore passphrase if the control token is cached locally (0600)."));
  console.log(pc.dim("It reaches only this bot's control API — which includes placing trades."));
  const cached = readControlToken(botId) !== null;
  if (await confirm("Allow local agents to reach this bot without the passphrase?", cached)) {
    const at = saveControlToken(botId, controlToken);
    console.log(pc.dim(`control token cached at ${at}`));
  } else if (forgetControlToken(botId)) {
    console.log(pc.dim("cached control token removed — reads will ask for the passphrase again"));
  }

  console.log(pc.bold(`\ndeployed in EEUR. control API: ${controlUrl}/bots/${botId}/…`));
  console.log(pc.dim("cassie portfolio/trade/orders/logs now reach the deployed bot through the control API."));
}

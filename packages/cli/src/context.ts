// packages/cli/src/context.ts
// Shared CLI plumbing: passphrase capture (once), keystore access, runtime
// creds assembly, SetupContext implementation for wizard-driven adapter setup,
// and control-API access for deployed bots.

import { spawnSync } from "node:child_process";
import prompts from "prompts";
import pc from "picocolors";
import {
  Keystore,
  KeyRoles,
  WrongPassphraseError,
  createAdapter,
  type BotConfig,
  type RuntimeCreds,
  type SetupContext,
  type VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import { dirs } from "./paths.js";
import { getOperatorDefault, setOperatorDefault } from "./defaults.js";
import { ControlApiError, controlCall, type Target } from "./ssh.js";
import { resolveLocalValue } from "./local-env.js";
import { systemPassphraseStore } from "./passphrase-store.js";

const cachedPassphrases = new Map<string, string>();

export async function getPassphrase(botId: string, confirmNew = false): Promise<string> {
  const cached = cachedPassphrases.get(botId);
  if (cached !== undefined) return cached;
  // A nearest .local.env or exported value is an explicit automation override.
  // Otherwise use per-bot native storage before asking the operator.
  const supplied = resolveLocalValue(["CASSIE_PASSPHRASE"]);
  if (supplied) {
    cachedPassphrases.set(botId, supplied.value);
    return supplied.value;
  }

  let storeError: Error | undefined;
  if (systemPassphraseStore.isSupported()) {
    try {
      const remembered = await systemPassphraseStore.get(botId);
      if (remembered !== undefined) {
        const ks = keystore();
        let valid = true;
        if (ks.exists(botId)) {
          try {
            ks.verifyPassphrase(botId, remembered);
          } catch (error) {
            if (!(error instanceof WrongPassphraseError)) throw error;
            valid = false;
            storeError = new Error(`the saved passphrase for ${botId} did not unlock the keystore`);
            console.error(pc.yellow(`The saved passphrase for ${botId} did not unlock the keystore.`));
          }
        }
        if (valid) {
          cachedPassphrases.set(botId, remembered);
          return remembered;
        }
      }
    } catch (error) {
      storeError = error as Error;
    }
  }

  if (!process.stdin.isTTY) {
    const detail = storeError ? ` ${systemPassphraseStore.label()}: ${storeError.message}.` : "";
    throw new Error(
      `no non-interactive keystore passphrase for bot "${botId}". ` +
        `Run \`cassie passphrase remember ${botId}\` once, or set CASSIE_PASSPHRASE.${detail}`,
    );
  }
  const { pass } = await prompts(
    { type: "password", name: "pass", message: "Keystore passphrase" },
    { onCancel: () => process.exit(130) },
  );
  if (typeof pass !== "string" || pass.length === 0) throw new Error("keystore passphrase is required");
  if (confirmNew) {
    const { again } = await prompts(
      { type: "password", name: "again", message: "Confirm passphrase" },
      { onCancel: () => process.exit(130) },
    );
    if (again !== pass) {
      console.error(pc.red("passphrases do not match"));
      process.exit(1);
    }
  }
  const ks = keystore();
  if (ks.exists(botId)) ks.verifyPassphrase(botId, pass);
  cachedPassphrases.set(botId, pass);
  await offerToRememberPassphrase(botId, pass);
  return pass;
}

export function clearCachedPassphrase(botId?: string): void {
  if (botId === undefined) cachedPassphrases.clear();
  else cachedPassphrases.delete(botId);
}

async function offerToRememberPassphrase(botId: string, passphrase: string): Promise<void> {
  if (!(await systemPassphraseStore.isAvailable(botId))) return;
  const { remember } = await prompts(
    {
      type: "confirm",
      name: "remember",
      message: `Save in ${systemPassphraseStore.label()} for later non-interactive commands?`,
      initial: true,
    },
    { onCancel: () => process.exit(130) },
  );
  if (!remember) return;
  try {
    await systemPassphraseStore.set(botId, passphrase);
    console.log(pc.dim(`Saved in ${systemPassphraseStore.label()}.`));
  } catch (error) {
    console.error(pc.yellow(`Could not save in ${systemPassphraseStore.label()}: ${(error as Error).message}`));
  }
}

export function keystore(): Keystore {
  return new Keystore(dirs.keys());
}

export async function ask(message: string, opts: { secret?: boolean; default?: string } = {}): Promise<string> {
  const { v } = await prompts(
    {
      type: opts.secret ? "password" : "text",
      name: "v",
      message,
      initial: opts.default,
    },
    { onCancel: () => process.exit(130) },
  );
  return String(v ?? "");
}

export async function confirm(message: string, defaultYes = true): Promise<boolean> {
  const { v } = await prompts(
    { type: "confirm", name: "v", message, initial: defaultYes },
    { onCancel: () => process.exit(130) },
  );
  return Boolean(v);
}

export async function select(
  message: string,
  choices: Array<{ value: string; title: string; description?: string }>,
): Promise<string> {
  const { v } = await prompts(
    { type: "select", name: "v", message, choices, initial: 0 },
    { onCancel: () => process.exit(130) },
  );
  return String(v ?? choices[0]?.value ?? "");
}

export function openUrl(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const res = spawnSync(opener, [url], { stdio: "ignore" });
  if (res.status !== 0) console.log(pc.dim(`→ ${url}`));
}

export function makeSetupContext(botId: string): SetupContext {
  const ks = keystore();
  return {
    botId,
    ask,
    confirm,
    select,
    print: (m) => console.log(m),
    async poll(waitingMsg, check, opts = {}) {
      const interval = opts.intervalMs ?? 15_000;
      const deadline = Date.now() + (opts.timeoutMs ?? 60 * 60_000);
      process.stdout.write(pc.dim(`${waitingMsg} (Ctrl-C aborts; polling every ${Math.round(interval / 1000)}s)\n`));
      for (;;) {
        const result = await check();
        if (result !== null) return result;
        if (Date.now() > deadline) throw new Error(`timed out: ${waitingMsg}`);
        process.stdout.write(pc.dim("."));
        await new Promise((r) => setTimeout(r, interval));
      }
    },
    async pollSkippable(waitingMsg, check, opts = {}) {
      return pollWithSkip(waitingMsg, check, opts);
    },
    async getSecret(role) {
      const pass = await getPassphrase(botId);
      return ks.getEntry(botId, role, pass);
    },
    async putSecret(role, value, meta = {}) {
      const pass = await getPassphrase(botId);
      ks.putEntry(botId, role, value, pass, meta);
    },
    async getOperatorDefault(name) {
      return getOperatorDefault(name);
    },
    async setOperatorDefault(name, value) {
      setOperatorDefault(name, value);
    },
    openUrl,
  };
}

async function pollWithSkip<T>(
  waitingMsg: string,
  check: () => Promise<T | null>,
  opts: { intervalMs?: number; timeoutMs?: number },
): Promise<T | null> {
  const interval = opts.intervalMs ?? 15_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 60 * 60_000);
  const input = process.stdin;
  const canReadSkip = Boolean(input.isTTY && typeof input.setRawMode === "function");
  const wasRaw = canReadSkip ? Boolean(input.isRaw) : false;
  const wasPaused = canReadSkip ? input.isPaused() : false;
  let skipped = false;
  let lineOpen = false;
  let wakeForSkip: (() => void) | undefined;

  const finishLine = (): void => {
    if (!lineOpen) return;
    process.stdout.write("\n");
    lineOpen = false;
  };
  const restoreInput = (): void => {
    if (!canReadSkip) return;
    input.off("data", onData);
    input.setRawMode?.(wasRaw);
    if (wasPaused) input.pause();
  };
  const onData = (chunk: Buffer | string): void => {
    const key = chunk.toString();
    if (key.includes("\u0003")) {
      restoreInput();
      finishLine();
      process.kill(process.pid, "SIGINT");
      return;
    }
    if (key.toLowerCase().includes("s")) {
      skipped = true;
      wakeForSkip?.();
    }
  };

  if (canReadSkip) {
    input.setRawMode?.(true);
    input.resume();
    input.on("data", onData);
  }
  const controls = canReadSkip ? "press s to skip; Ctrl-C aborts" : "Ctrl-C aborts";
  process.stdout.write(pc.dim(`${waitingMsg} (${controls}; polling every ${Math.round(interval / 1000)}s)\n`));

  try {
    for (;;) {
      if (skipped) return null;
      const result = await check();
      if (result !== null) return result;
      if (skipped) return null;
      if (Date.now() > deadline) throw new Error(`timed out: ${waitingMsg}`);
      process.stdout.write(pc.dim("."));
      lineOpen = true;
      if (canReadSkip) {
        await new Promise<void>((resolve) => {
          let settled = false;
          let timer: NodeJS.Timeout;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (wakeForSkip === finish) wakeForSkip = undefined;
            resolve();
          };
          timer = setTimeout(finish, interval);
          wakeForSkip = finish;
          if (skipped) finish();
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    }
  } finally {
    restoreInput();
    finishLine();
  }
}

/** Assemble the runtime-eligible credential blob (§11) from the keystore. */
export async function buildRuntimeCreds(cfg: BotConfig): Promise<RuntimeCreds> {
  const ks = keystore();
  const pass = await getPassphrase(cfg.id);
  const acct = requireAccount(cfg);
  switch (acct.venue) {
    case "polymarket": {
      const signerPk = ks.getEntry(cfg.id, KeyRoles.master, pass);
      const l2raw = ks.getEntry(cfg.id, "polymarket-l2", pass);
      if (!signerPk || !l2raw) throw new Error("missing polymarket credentials — run `cassie fund` to finish setup");
      const l2 = JSON.parse(l2raw);
      // The stored blob may be the bare L2 creds or the full creds object.
      return {
        venue: "polymarket",
        signerPk,
        funder: acct.funder,
        signatureType: acct.signatureType,
        l2: l2.l2 ?? l2,
      };
    }
    case "hyperliquid": {
      const agentPk = ks.getEntry(cfg.id, KeyRoles.agent, pass);
      if (!agentPk) throw new Error("missing hyperliquid agent key — run `cassie fund` to approve the agent");
      return { venue: "hyperliquid", agentPk, masterAddress: acct.masterAddress };
    }
    case "lighter": {
      const apiPk = ks.getEntry(cfg.id, KeyRoles.lighterApi, pass);
      if (!apiPk || acct.accountIndex === undefined) {
        throw new Error("missing lighter API key/account index — run `cassie fund` to provision");
      }
      return { venue: "lighter", apiPrivateKey: apiPk, accountIndex: acct.accountIndex, apiKeyIndex: acct.apiKeyIndex ?? 2 };
    }
    case "kalshi": {
      const privateKeyB64 = ks.getEntry(cfg.id, KeyRoles.kalshiApi, pass);
      if (!privateKeyB64) throw new Error("missing kalshi API key — re-run `cassie init` to store it");
      return { venue: "kalshi", keyId: acct.keyId, privateKeyB64 };
    }
    default:
      throw new Error("unsupported venue account");
  }
}

export function requireAccount(cfg: BotConfig): NonNullable<BotConfig["account"]> {
  if (!cfg.account) throw new Error(`bot "${cfg.id}" has no venue account yet — finish \`cassie init\``);
  return cfg.account;
}

/**
 * An operator-supplied Polygon RPC, for chain reads and transaction waits. The
 * public endpoints are rate-limited, and some networks cannot complete a TLS
 * handshake with them at all, which surfaces as a bare "fetch failed".
 */
export function withOperatorRpc(cfg: BotConfig): BotConfig["venueUrls"] {
  if (cfg.venue !== "polymarket" || cfg.venueUrls.polymarket.rpc) return cfg.venueUrls;
  const rpc = resolveLocalValue(["POLYGON_RPC_URL", "POLYGON_RPC"]);
  if (!rpc) return cfg.venueUrls;
  return { ...cfg.venueUrls, polymarket: { ...cfg.venueUrls.polymarket, rpc: rpc.value } };
}

export async function adapterFor(cfg: BotConfig, opts: { needCreds?: boolean; fixtureBooks?: string } = {}): Promise<VenueAdapter> {
  const creds = opts.needCreds === false ? undefined : await buildRuntimeCreds(cfg).catch((err) => {
    if (opts.needCreds) throw err;
    return undefined;
  });
  return createAdapter(cfg.venue, { urls: withOperatorRpc(cfg), creds, fixtureBooks: opts.fixtureBooks });
}

export async function getKeystoreSecret(botId: string, role: string): Promise<string | null> {
  const pass = await getPassphrase(botId);
  return keystore().getEntry(botId, role, pass);
}

// ---------------------------------------------------------------------------
// Control API (deployed bots)
// ---------------------------------------------------------------------------

export function isDeployed(cfg: BotConfig): boolean {
  return Boolean(cfg.deployment);
}

export function targetFor(cfg: BotConfig): Target {
  if (!cfg.deployment) throw new Error(`bot "${cfg.id}" is not deployed — run \`cassie deploy ${cfg.id}\``);
  return { host: cfg.deployment.host, user: cfg.deployment.user };
}

/**
 * Reach a deployed bot. The droplet serves this on a unix socket, so the SSH
 * key is the only credential involved and reads never touch the keystore.
 */
export async function controlFetch(cfg: BotConfig, path: string, init: RequestInit = {}): Promise<unknown> {
  const method = (init.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const body = typeof init.body === "string" ? init.body : undefined;
  try {
    return controlCall(targetFor(cfg), cfg.id, method, path, body);
  } catch (error) {
    // The runtime answers a risk-module skip with 422 and a full result body.
    // That is an outcome the caller renders, not a transport failure.
    if (error instanceof ControlApiError && isSkipResult(error.body)) return error.body;
    throw error;
  }
}

function isSkipResult(body: unknown): boolean {
  return typeof body === "object" && body !== null && "placed" in body && "skipReasons" in body;
}

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
  createAdapter,
  type BotConfig,
  type RuntimeCreds,
  type SetupContext,
  type VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import { dirs } from "./paths.js";
import { getOperatorDefault, setOperatorDefault } from "./defaults.js";
import { controlCall, type Target } from "./ssh.js";
import { resolveLocalValue } from "./local-env.js";

let cachedPassphrase: string | undefined;

export async function getPassphrase(confirmNew = false): Promise<string> {
  if (cachedPassphrase !== undefined) return cachedPassphrase;
  if (process.env.CASSIE_PASSPHRASE) {
    cachedPassphrase = process.env.CASSIE_PASSPHRASE;
    return cachedPassphrase;
  }
  const { pass } = await prompts(
    { type: "password", name: "pass", message: "Keystore passphrase" },
    { onCancel: () => process.exit(130) },
  );
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
  cachedPassphrase = pass as string;
  return cachedPassphrase;
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
    async getSecret(role) {
      const pass = await getPassphrase();
      return ks.getEntry(botId, role, pass);
    },
    async putSecret(role, value, meta = {}) {
      const pass = await getPassphrase();
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

/** Assemble the runtime-eligible credential blob (§11) from the keystore. */
export async function buildRuntimeCreds(cfg: BotConfig): Promise<RuntimeCreds> {
  const ks = keystore();
  const pass = await getPassphrase();
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
  const pass = await getPassphrase();
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
  return controlCall(targetFor(cfg), cfg.id, method, path, body);
}

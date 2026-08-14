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
  type VenueAccount,
  type VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import { dirs, readControlToken } from "./paths.js";
import { getOperatorDefault, setOperatorDefault } from "./defaults.js";

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
    openUrl(url) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      const res = spawnSync(opener, [url], { stdio: "ignore" });
      if (res.status !== 0) console.log(pc.dim(`→ ${url}`));
    },
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
    case "fixture":
      return { venue: "fixture" };
  }
}

export function requireAccount(cfg: BotConfig): VenueAccount {
  if (!cfg.account) throw new Error(`bot "${cfg.id}" has no venue account yet — finish \`cassie init\``);
  return cfg.account;
}

export async function adapterFor(cfg: BotConfig, opts: { needCreds?: boolean; fixtureBooks?: string } = {}): Promise<VenueAdapter> {
  const creds = opts.needCreds === false ? undefined : await buildRuntimeCreds(cfg).catch((err) => {
    if (opts.needCreds) throw err;
    return undefined;
  });
  return createAdapter(cfg.venue, { urls: cfg.venueUrls, creds, fixtureBooks: opts.fixtureBooks });
}

export async function getKeystoreSecret(botId: string, role: string): Promise<string | null> {
  const pass = await getPassphrase();
  return keystore().getEntry(botId, role, pass);
}

// ---------------------------------------------------------------------------
// Control API (deployed bots)
// ---------------------------------------------------------------------------

export async function controlFetch(cfg: BotConfig, path: string, init: RequestInit = {}): Promise<unknown> {
  if (!cfg.controlUrl) throw new Error("bot is not deployed (no controlUrl)");
  // Reaching a deployed bot (logs, portfolio, orders) should not unlock the
  // keystore: talking to your own Worker needs one token, and that is not the
  // passphrase guarding the keys that move money.
  // env → the cache `deploy` offers to write → the keystore (prompts).
  const token =
    process.env.CASSIE_CONTROL_TOKEN ??
    readControlToken(cfg.id) ??
    (await getKeystoreSecret(cfg.id, KeyRoles.controlToken));
  if (!token) {
    throw new Error(
      "no control token — redeploy with `cassie deploy` to mint one (it offers to cache it for agents)",
    );
  }
  const res = await fetch(`${cfg.controlUrl}/bots/${cfg.id}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`control API ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function isDeployed(cfg: BotConfig): boolean {
  return Boolean(cfg.controlUrl);
}

// packages/cli/src/quotient-token.ts
// Resolves the Quotient signals API key from the places an operator may already
// have it, so the wizard can stop asking for a paste when a sibling tool is
// already logged in. Order: nearest .local.env → exported env → this bot's
// keystore → the quotient CLI config (XDG_CONFIG_HOME honoured).
//
// A bot with `signals.keySource: "keystore"` opts out of that chain: its own
// keystore entry decides, so several bots sharing one working directory can run
// on different Quotient accounts.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyRoles } from "@quotient-forecasting/cassie-core";
import { getKeystoreSecret } from "./context.js";
import { environmentValue, localEnvPath, localEnvValue } from "./local-env.js";
import { loadBotConfig } from "./paths.js";

export { localEnvPath } from "./local-env.js";

export type TokenSource = "env" | "local-env" | "keystore" | "quotient-cli";

export interface ResolvedToken {
  token: string;
  source: TokenSource;
  /** Human-readable origin that never contains key material. */
  origin: string;
}

function quotientConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "quotient", "config.json");
}

/** The quotient CLI's saved API key, if that CLI is installed and logged in. */
export function quotientCliToken(): string | null {
  const p = quotientConfigPath();
  if (!existsSync(p)) return null;
  try {
    const cfg = JSON.parse(readFileSync(p, "utf8")) as { apiKey?: unknown };
    return typeof cfg.apiKey === "string" && cfg.apiKey.length > 0 ? cfg.apiKey : null;
  } catch {
    return null;
  }
}

/** Read only Quotient variables; unrelated secrets in .local.env stay ignored. */
export function localEnvQuotientToken(startDir = process.cwd()): ResolvedToken | null {
  const found = localEnvValue(["QUOTIENT_API_TOKEN", "QUOTIENT_API_KEY"], startDir);
  return found ? { token: found.value, source: "local-env", origin: found.origin } : null;
}

function environmentQuotientToken(): ResolvedToken | null {
  const found = environmentValue(["QUOTIENT_API_TOKEN", "QUOTIENT_API_KEY"]);
  return found ? { token: found.value, source: "env", origin: found.origin } : null;
}

/** Discovery sources that do not require unlocking a Cassie keystore. */
export function discoverQuotientToken(startDir = process.cwd()): ResolvedToken | null {
  // Project-local config is authoritative over ambient shell state. Long-lived
  // terminals frequently retain an obsolete exported key after .local.env is
  // rotated; silently preferring that stale export caused deployed 401 loops.
  const direct = localEnvQuotientToken(startDir) ?? environmentQuotientToken();
  if (direct) return direct;
  const cli = quotientCliToken();
  return cli ? { token: cli, source: "quotient-cli", origin: quotientConfigPath() } : null;
}

function keystoreToken(botId: string, token: string): ResolvedToken {
  return { token, source: "keystore", origin: `bot ${botId} keystore entry ${KeyRoles.quotientToken}` };
}

/** Whether this bot pins its key to its own keystore entry. */
export function pinsKeyToKeystore(botId: string): boolean {
  try {
    return loadBotConfig(botId).signals.keySource === "keystore";
  } catch {
    // No config yet (mid-`init`), so there is nothing to pin to.
    return false;
  }
}

/** Full resolution chain, for the commands that need a token to run. */
export async function resolveQuotientToken(botId: string): Promise<ResolvedToken | null> {
  const pinned = pinsKeyToKeystore(botId);
  if (pinned) {
    const stored = await getKeystoreSecret(botId, KeyRoles.quotientToken);
    if (stored) return keystoreToken(botId, stored);
    throw new Error(
      `${botId} pins its Quotient key to its keystore but no ${KeyRoles.quotientToken} entry is stored. ` +
        `Run \`cassie signals-key ${botId}\` to set it, or \`cassie signals-key ${botId} --auto\` to fall back to ` +
        "the nearest .local.env and the environment.",
    );
  }
  const direct = localEnvQuotientToken() ?? environmentQuotientToken();
  if (direct) return direct;
  const stored = await getKeystoreSecret(botId, KeyRoles.quotientToken);
  if (stored) return keystoreToken(botId, stored);
  const cli = quotientCliToken();
  if (cli) return { token: cli, source: "quotient-cli", origin: quotientConfigPath() };
  return null;
}

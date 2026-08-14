// packages/cli/src/paths.ts
// ~/.cassie layout. CASSIE_HOME overrides (used by tests and CI).

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parseBotConfig, serializeBotConfig, type BotConfig } from "@quotient-forecasting/cassie-core";

export function cassieHome(): string {
  return process.env.CASSIE_HOME ?? join(homedir(), ".cassie");
}

export const dirs = {
  home: () => cassieHome(),
  bots: () => join(cassieHome(), "bots"),
  keys: () => join(cassieHome(), "keys"),
  state: () => join(cassieHome(), "state"),
  control: () => join(cassieHome(), "control"),
};

export function botConfigPath(botId: string): string {
  return join(dirs.bots(), `${botId}.json`);
}

export function statePath(botId: string): string {
  return join(dirs.state(), `${botId}.sqlite`);
}

/**
 * Cached control token for a deployed bot, mode 0600.
 *
 * `deploy` already holds this token and has already unlocked the keystore, so
 * caching it there means later reads (logs, portfolio, orders) need no
 * passphrase — the keystore passphrase guards keys that move money, and
 * reaching your own Worker is not that. Delete with `cassie control-token
 * <botId> --forget`.
 */
export function controlTokenPath(botId: string): string {
  return join(dirs.control(), `${botId}.token`);
}

export function saveControlToken(botId: string, token: string): string {
  const p = controlTokenPath(botId);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, token, { encoding: "utf8", mode: 0o600 });
  return p;
}

export function readControlToken(botId: string): string | null {
  const p = controlTokenPath(botId);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8").trim();
  return raw.length > 0 ? raw : null;
}

export function forgetControlToken(botId: string): boolean {
  const p = controlTokenPath(botId);
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}

export function loadBotConfig(botId: string): BotConfig {
  const p = botConfigPath(botId);
  if (!existsSync(p)) {
    throw new Error(`no bot "${botId}" — run \`cassie init\` first (looked in ${p})`);
  }
  return parseBotConfig(JSON.parse(readFileSync(p, "utf8")));
}

export function saveBotConfig(cfg: BotConfig): void {
  mkdirSync(dirs.bots(), { recursive: true, mode: 0o700 });
  writeFileSync(botConfigPath(cfg.id), serializeBotConfig(cfg), { mode: 0o600 });
}

export function listBotIds(): string[] {
  if (!existsSync(dirs.bots())) return [];
  return readdirSync(dirs.bots())
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

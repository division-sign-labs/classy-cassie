// packages/cli/src/paths.ts
// ~/.cassie layout. CASSIE_HOME overrides (used by tests and CI).

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { parseBotConfig, serializeBotConfig, type BotConfig } from "@quotient-forecasting/cassie-core";

const BOT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Validate before using an operator-supplied bot id as a path component. */
export function safeBotId(botId: string): string {
  if (!BOT_ID_RE.test(botId)) {
    throw new Error("bot id must be lowercase alphanumerics/dashes, start with an alphanumeric, and be at most 32 characters");
  }
  return botId;
}

export function cassieHome(): string {
  return process.env.CASSIE_HOME ?? join(homedir(), ".cassie");
}

export const dirs = {
  home: () => cassieHome(),
  bots: () => join(cassieHome(), "bots"),
  keys: () => join(cassieHome(), "keys"),
  state: () => join(cassieHome(), "state"),
  run: () => join(cassieHome(), "run"),
  ssh: () => join(cassieHome(), "ssh"),
};

export function botConfigPath(botId: string): string {
  return join(dirs.bots(), `${safeBotId(botId)}.json`);
}

export function statePath(botId: string): string {
  return join(dirs.state(), `${safeBotId(botId)}.sqlite`);
}

/** Crash-safe private-file replacement used for configs and local credentials. */
export function atomicWritePrivateFile(path: string, contents: string): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    // A file fsync alone does not make its directory entry durable across a
    // host power loss. POSIX directory fsync closes that final rename window.
    // Windows does not support opening directories through this Node API; its
    // rename durability is therefore the platform fallback.
    if (process.platform !== "win32") {
      const parentDescriptor = openSync(parent, "r");
      try {
        fsyncSync(parentDescriptor);
      } finally {
        closeSync(parentDescriptor);
      }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) rmSync(temporary);
  }
}

export function loadBotConfig(botId: string): BotConfig {
  const p = botConfigPath(botId);
  if (!existsSync(p)) {
    throw new Error(`no bot "${botId}" — run \`cassie init\` first (looked in ${p})`);
  }
  return parseBotConfig(JSON.parse(readFileSync(p, "utf8")));
}

export function saveBotConfig(cfg: BotConfig): void {
  atomicWritePrivateFile(botConfigPath(cfg.id), serializeBotConfig(cfg));
}

export function listBotIds(): string[] {
  if (!existsSync(dirs.bots())) return [];
  return readdirSync(dirs.bots())
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

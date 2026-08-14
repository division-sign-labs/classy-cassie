// packages/cli/src/defaults.ts
// Operator-level defaults shared across bots (e.g. the Polymarket Builder key so
// every new bot can create its account without re-pasting credentials).
// Stored at <CASSIE_HOME>/defaults.json, chmod 0600. Env vars win over the file:
//   POLYMARKET_BUILDER_KEY / POLYMARKET_BUILDER_SECRET / POLYMARKET_BUILDER_PASSPHRASE

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { dirs } from "./paths.js";

type DefaultsFile = Record<string, string>;

function defaultsPath(): string {
  return join(dirs.home(), "defaults.json");
}

function loadFile(): DefaultsFile {
  const p = defaultsPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as DefaultsFile;
  } catch {
    return {};
  }
}

export function getOperatorDefault(name: string): string | null {
  if (name === "polymarket-builder") {
    const key = process.env.POLYMARKET_BUILDER_KEY;
    const secret = process.env.POLYMARKET_BUILDER_SECRET;
    const passphrase = process.env.POLYMARKET_BUILDER_PASSPHRASE;
    if (key && secret && passphrase) {
      return JSON.stringify({ kind: "builder", key, secret, passphrase });
    }
  }
  return loadFile()[name] ?? null;
}

export function setOperatorDefault(name: string, value: string): void {
  mkdirSync(dirs.home(), { recursive: true, mode: 0o700 });
  const file = loadFile();
  file[name] = value;
  const p = defaultsPath();
  writeFileSync(p, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
}

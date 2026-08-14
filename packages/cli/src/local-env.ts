// packages/cli/src/local-env.ts
// Narrow dotenv reader for operator-owned .local.env files. Callers name the
// exact variables they need so loading one integration never splashes unrelated
// secrets (wallet keys in particular) into process.env.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type LocalValueSource = "local-env" | "env";

export interface ResolvedLocalValue {
  value: string;
  source: LocalValueSource;
  /** Human-readable origin. Never includes the value itself. */
  origin: string;
  name: string;
}

function decodeEnvValue(raw: string): string {
  const value = raw.trim();
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
    const inner = value.slice(1, -1);
    return quote === '"' ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"') : inner;
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function valueFromEnvFile(contents: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = contents.match(new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=\\s*(.*)$`, "m"));
  if (!match?.[1]) return null;
  const value = decodeEnvValue(match[1]);
  return value.length > 0 ? value : null;
}

/** Find the nearest .local.env, walking from cwd toward the filesystem root. */
export function localEnvPath(startDir = process.cwd()): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ".local.env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Resolve the first named variable from the nearest .local.env only. */
export function localEnvValue(names: readonly string[], startDir = process.cwd()): ResolvedLocalValue | null {
  const path = localEnvPath(startDir);
  if (!path) return null;
  try {
    const contents = readFileSync(path, "utf8");
    for (const name of names) {
      const value = valueFromEnvFile(contents, name);
      if (value) return { value, source: "local-env", origin: `${path} (${name})`, name };
    }
  } catch {
    return null;
  }
  return null;
}

/** Resolve the first named variable from the ambient process environment. */
export function environmentValue(names: readonly string[]): ResolvedLocalValue | null {
  for (const name of names) {
    const value = process.env[name];
    if (value) return { value, source: "env", origin: `exported ${name}`, name };
  }
  return null;
}

/** Project-local config deliberately wins over stale long-lived shell exports. */
export function resolveLocalValue(names: readonly string[], startDir = process.cwd()): ResolvedLocalValue | null {
  return localEnvValue(names, startDir) ?? environmentValue(names);
}

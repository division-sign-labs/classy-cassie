// packages/cli/src/version.ts
// One source of truth for the version. The droplet installs the runtime pinned
// to it, so a CLI and the bot it deploys are never a release apart.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

export function cliVersion(): string {
  if (cached) return cached;
  // dist/version.js -> package.json
  const manifest = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
  cached = (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
  return cached;
}

// packages/cli/src/wrangler.ts
// Invoke Cassie's pinned Wrangler dependency without requiring pnpm or a
// separately installed global binary.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface WranglerProject {
  cwd: string;
  config?: string;
}

const require = createRequire(import.meta.url);
const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");

function projectArgs(args: string[], project: WranglerProject): string[] {
  return project.config ? [...args, "--config", project.config] : args;
}

export function runWrangler(
  args: string[],
  project: WranglerProject,
  input?: string,
): { out: string; ok: boolean } {
  const result = spawnSync(process.execPath, [wranglerBin, ...projectArgs(args, project)], {
    cwd: project.cwd,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const error = result.error ? `${result.error.message}\n` : "";
  return { out: error + (result.stdout ?? "") + (result.stderr ?? ""), ok: result.status === 0 };
}

/** Hand over the terminal only for Wrangler flows that need a human. */
export function runWranglerInteractive(args: string[], project: WranglerProject): boolean {
  const result = spawnSync(process.execPath, [wranglerBin, ...projectArgs(args, project)], {
    cwd: project.cwd,
    stdio: "inherit",
    env: process.env,
  });
  return result.status === 0;
}

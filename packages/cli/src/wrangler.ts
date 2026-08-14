// packages/cli/src/wrangler.ts
// Invoke Cassie's pinned Wrangler dependency without requiring pnpm or a
// separately installed global binary.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { restrictedChildEnv } from "./child-env.js";

export interface WranglerProject {
  cwd: string;
  config?: string;
}

export interface MaterializedWranglerProject {
  project: WranglerProject;
  dispose(): void;
}

const require = createRequire(import.meta.url);
const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");

function stripJsoncComments(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        result += char;
      } else {
        result += " ";
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        result += "  ";
        index++;
        blockComment = false;
      } else {
        result += char === "\n" || char === "\r" ? char : " ";
      }
      continue;
    }
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
    } else if (char === "/" && next === "/") {
      result += "  ";
      index++;
      lineComment = true;
    } else if (char === "/" && next === "*") {
      result += "  ";
      index++;
      blockComment = true;
    } else {
      result += char;
    }
  }
  return result;
}

function stripTrailingCommas(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(source[lookahead] ?? "")) lookahead++;
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }
    result += char;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absoluteFrom(configDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(configDir, value);
}

/**
 * Move Cassie's deployment config to an isolated temporary file while keeping
 * every file path anchored to the package it came from. Cloudflare container
 * application names are account-global, so each Worker must get its own name
 * instead of sharing the checked-in placeholder.
 */
export function materializeWorkerWranglerProject(
  sourceProject: WranglerProject,
  workerName: string,
): MaterializedWranglerProject {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName)) {
    throw new Error(`invalid Cloudflare Worker name ${JSON.stringify(workerName)}`);
  }
  if (!sourceProject.config) throw new Error("Cassie's Cloudflare runtime has no Wrangler config");

  const cwd = resolve(sourceProject.cwd);
  const sourceConfig = absoluteFrom(cwd, sourceProject.config);
  const configDir = dirname(sourceConfig);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripTrailingCommas(stripJsoncComments(readFileSync(sourceConfig, "utf8")))) as unknown;
  } catch (error) {
    throw new Error(`cannot parse Wrangler config ${sourceConfig}: ${String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`Wrangler config ${sourceConfig} must contain an object`);
  if (typeof parsed.main !== "string" || parsed.main.length === 0) {
    throw new Error(`Wrangler config ${sourceConfig} must define main`);
  }
  if (!Array.isArray(parsed.containers) || parsed.containers.length !== 1 || !isRecord(parsed.containers[0])) {
    throw new Error(`Wrangler config ${sourceConfig} must define exactly one container application`);
  }
  const sourceContainer = parsed.containers[0];
  if (typeof sourceContainer.image !== "string" || sourceContainer.image.length === 0) {
    throw new Error(`Wrangler config ${sourceConfig} must define containers[0].image`);
  }
  if (
    sourceContainer.image_build_context !== undefined &&
    (typeof sourceContainer.image_build_context !== "string" || sourceContainer.image_build_context.length === 0)
  ) {
    throw new Error(`Wrangler config ${sourceConfig} has an invalid containers[0].image_build_context`);
  }

  const config: Record<string, unknown> = {
    ...parsed,
    name: workerName,
    main: absoluteFrom(configDir, parsed.main),
    containers: [
      {
        ...sourceContainer,
        name: workerName,
        image: absoluteFrom(configDir, sourceContainer.image),
        image_build_context:
          sourceContainer.image_build_context === undefined
            ? configDir
            : absoluteFrom(configDir, sourceContainer.image_build_context),
      },
    ],
  };
  delete config.$schema;

  const temporaryDir = mkdtempSync(join(tmpdir(), "cassie-wrangler-"));
  const temporaryConfig = join(temporaryDir, "wrangler.json");
  try {
    writeFileSync(temporaryConfig, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    rmSync(temporaryDir, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  return {
    project: { cwd, config: temporaryConfig },
    dispose() {
      if (disposed) return;
      disposed = true;
      rmSync(temporaryDir, { recursive: true, force: true });
    },
  };
}

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
    env: restrictedChildEnv(["CLOUDFLARE_", "CF_", "WRANGLER_", "DOCKER_"]),
  });
  const error = result.error ? `${result.error.message}\n` : "";
  return { out: error + (result.stdout ?? "") + (result.stderr ?? ""), ok: result.status === 0 };
}

/** Hand over the terminal only for Wrangler flows that need a human. */
export function runWranglerInteractive(args: string[], project: WranglerProject): boolean {
  const result = spawnSync(process.execPath, [wranglerBin, ...projectArgs(args, project)], {
    cwd: project.cwd,
    stdio: "inherit",
    env: restrictedChildEnv(["CLOUDFLARE_", "CF_", "WRANGLER_", "DOCKER_"]),
  });
  return result.status === 0;
}

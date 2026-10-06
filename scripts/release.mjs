// scripts/release.mjs
// Build, check and publish one archive containing all Cassie workspace modules.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { RELEASE_PACKAGE, stageReleasePackage } from "./package-release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VISIBILITY_TIMEOUT_MS = 10 * 60_000;

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function inherit(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

function workspacePackages() {
  const listed = JSON.parse(capture("pnpm", ["-r", "list", "--depth", "-1", "--json"]));
  return listed.map(pkg => {
    const manifest = JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf8"));
    if (!manifest.private) throw new Error(`${pkg.name} must be private; publish the assembled Cassie archive instead`);
    return { name: pkg.name, version: pkg.version, path: pkg.path, manifest };
  });
}

function assertReleaseGitState() {
  if (capture("git", ["status", "--porcelain"])) throw new Error("release requires a clean working tree");
  const branch = capture("git", ["branch", "--show-current"]);
  if (branch !== "main") throw new Error(`release requires branch main; current branch is ${branch || "detached"}`);
  if (capture("git", ["rev-parse", "HEAD"]) !== capture("git", ["rev-parse", "@{upstream}"])) {
    throw new Error("release commit must be pushed before publishing");
  }
}

export async function registryVersion(registry, pkg, { consumer = false, fetchImpl = fetch } = {}) {
  // Use npm install's exact URL and metadata format for the final visibility check.
  const url = new URL(pkg.name.replace("/", "%2f"), registry.endsWith("/") ? registry : `${registry}/`);
  if (!consumer) url.searchParams.set("cassie_release_check", String(Date.now()));
  const response = await fetchImpl(url, {
    headers: {
      accept: consumer ? "application/vnd.npm.install-v1+json" : "application/json",
      "cache-control": "no-cache",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status} for ${pkg.name}`);
  const document = await response.json();
  return document.versions?.[pkg.version];
}

export async function waitForConsumerVisibility(registry, pkg, {
  timeoutMs = VISIBILITY_TIMEOUT_MS,
  check = registryVersion,
  now = Date.now,
  sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms)),
  log = console.log,
} = {}) {
  const startedAt = now();
  let lastNoticeAt = -Infinity;
  let lastError;
  while (now() - startedAt < timeoutMs) {
    try {
      if (await check(registry, pkg, { consumer: true })) {
        log(`npm visible: ${pkg.name}@${pkg.version}`);
        return;
      }
      lastError = undefined;
    } catch (error) { lastError = error; }
    if (now() - lastNoticeAt >= 10_000) {
      log(`waiting for npm: ${pkg.name}@${pkg.version}`);
      lastNoticeAt = now();
    }
    await sleep(Math.min(2_000, Math.max(0, timeoutMs - (now() - startedAt))));
  }
  throw new Error(`npm did not expose ${pkg.name}@${pkg.version} within ${Math.round(timeoutMs / 1000)} seconds${lastError ? `: ${lastError.message}` : ""}. Re-run pnpm release:publish to verify the accepted release.`);
}

function smokeInstall(pkg, source, registry, preferOnline = false) {
  const directory = mkdtempSync(join(tmpdir(), "cassie-install-check-"));
  const env = { ...process.env, CASSIE_SKILLS_DIR: join(directory, "skills"), CASSIE_SKIP_SKILL_INSTALL: "0" };
  try {
    console.log(`checking installation: ${source}`);
    inherit("npm", ["install", "--global", "--prefix", directory, source,
      preferOnline ? "--prefer-online" : "--prefer-offline", "--registry", registry, "--no-audit", "--no-fund"], {
      cwd: directory, env,
    });
    const executable = process.platform === "win32" ? join(directory, "cassie.cmd") : join(directory, "bin", "cassie");
    for (const args of [["--version"], ["runtime", "--version"]]) {
      const installedVersion = capture(executable, args, { cwd: directory, env });
      if (installedVersion !== pkg.version) throw new Error(`installed ${args.join(" ")} reported ${installedVersion}; expected ${pkg.version}`);
    }
    const installed = join(directory, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", pkg.name);
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    if (JSON.stringify(manifest.bundleDependencies) !== JSON.stringify(pkg.bundled)) {
      throw new Error("installed Cassie is missing bundled modules; use a new CLI version for the single-package release");
    }
    const runtime = join(installed, "node_modules", "@quotient-forecasting", "cassie-runtime-node");
    for (const path of ["index.html", "app.js", "app.css"]) {
      if (!existsSync(join(runtime, "dist", "dashboard", "ui", path))) throw new Error(`missing dashboard asset: ${path}`);
    }
    if (!existsSync(join(directory, "skills", "cassie", "SKILL.md")) ||
        !existsSync(join(directory, "skills", "cassie", "thesis", "mappings.json"))) {
      throw new Error("installed Cassie did not install the operator skill");
    }
    capture(process.execPath, ["--input-type=module", "-e",
      `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(join(installed, "package.json"))}); const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.exec('select 1'); db.close();`], { cwd: directory, env });
    console.log(`install check passed: cassie and runtime ${pkg.version}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function publishRelease(pkg, archive, registry, publishArgs = [], {
  lookup = registryVersion,
  publish = () => inherit("npm", ["publish", archive.path, "--access", "public", "--registry", registry, ...publishArgs]),
  wait = waitForConsumerVisibility,
  smoke = () => smokeInstall(pkg, `${pkg.name}@${pkg.version}`, registry, true),
  log = console.log,
} = {}) {
  const existing = await lookup(registry, pkg);
  if (existing) {
    if (existing.dist?.integrity !== archive.integrity) {
      throw new Error(`${pkg.name}@${pkg.version} already exists with different contents. Bump the CLI version before publishing.`);
    }
    log(`already published: ${pkg.name}@${pkg.version}`);
  } else {
    await publish();
  }
  await wait(registry, pkg);
  await smoke();
  log(`release ready: npm install --global ${pkg.name}@${pkg.version}`);
}

export function packAndCheckRelease(packages, registry, directory) {
  const pkg = stageReleasePackage(packages, join(directory, "package"));
  copyFileSync(join(ROOT, "LICENSE"), join(pkg.path, "LICENSE"));
  const [packed] = JSON.parse(capture("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: pkg.path }));
  const archive = { path: join(directory, packed.filename), integrity: packed.integrity };
  if (JSON.stringify([...packed.bundled].sort()) !== JSON.stringify(pkg.bundled)) throw new Error("npm archive is missing bundled modules");
  console.log(`packed ${RELEASE_PACKAGE}@${pkg.version}: ${pkg.bundled.length} internal modules, one archive`);
  smokeInstall(pkg, archive.path, registry);
  return { pkg, archive };
}

async function main() {
  const { values } = parseArgs({ options: {
    "dry-run": { type: "boolean", default: false },
    tag: { type: "string" },
    registry: { type: "string" },
    provenance: { type: "boolean" },
  } });
  if (!values["dry-run"]) assertReleaseGitState();
  const packages = workspacePackages();
  const registry = values.registry ?? capture("npm", ["config", "get", "registry"]);
  inherit("pnpm", ["test"]); // Includes the only workspace build.
  inherit("pnpm", ["typecheck"]);
  const directory = mkdtempSync(join(tmpdir(), "cassie-release-"));
  try {
    const { pkg, archive } = packAndCheckRelease(packages, registry, directory);
    if (values["dry-run"]) {
      console.log("release check passed; one package is ready to publish");
      return;
    }
    assertReleaseGitState();
    const publishArgs = [...(values.tag ? ["--tag", values.tag] : []), ...(values.provenance ? ["--provenance"] : [])];
    await publishRelease(pkg, archive, registry, publishArgs);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

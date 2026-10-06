// scripts/cassie.mjs
// Run the checked-out CLI after rebuilding changed workspace inputs. No install,
// watch loop, or automatic restart: a trading process owns its entire lifetime.

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_VERSION = 1;
const WORKSPACE_DIRS = ["packages", "strategies", "skills"];
const IGNORED_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__", "coverage"]);
const SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

function walk(directory, files, filter = () => true) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (!filter(entry)) continue;
    if (entry.isDirectory()) walk(path, files, filter);
    else if (entry.isFile()) files.push(path);
    // Do not follow workspace links outside these explicit source directories.
  }
}

function hashFiles(root, files) {
  const digest = createHash("sha256");
  for (const path of files.sort()) {
    const contents = readFileSync(path);
    digest.update(`${relative(root, path)}\0${contents.length}\0`);
    digest.update(contents);
  }
  return digest.digest("hex");
}

/** Content hashes include runtime resources and config, but exclude tests/builds. */
export function workspaceInputFingerprint(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === "package.json" || entry.name === "pnpm-lock.yaml" ||
        entry.name === "pnpm-workspace.yaml" || entry.name === ".npmrc" || /^tsconfig.*\.json$/.test(entry.name))) {
      files.push(join(root, entry.name));
    }
  }
  const include = (entry) => !entry.name.startsWith(".") && !IGNORED_DIRS.has(entry.name) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".tsbuildinfo");
  for (const directory of [...WORKSPACE_DIRS, "scripts"]) walk(join(root, directory), files, include);
  return hashFiles(root, files);
}

function packagesWithBuild(root) {
  const packages = [];
  for (const directory of WORKSPACE_DIRS) {
    const base = join(root, directory);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const path = join(base, entry.name);
      if (!entry.isDirectory() || !existsSync(join(path, "package.json"))) continue;
      const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
      if (manifest.scripts?.build) packages.push({ path, manifest });
    }
  }
  return packages;
}

function exportedFiles(value) {
  if (typeof value === "string") return value.startsWith("./dist/") && !value.includes("*") ? [value] : [];
  if (value && typeof value === "object") return Object.values(value).flatMap(exportedFiles);
  return [];
}

/** Missing, deleted, or modified compiled outputs invalidate the cached build. */
export function workspaceOutputFingerprint(root) {
  const files = [];
  const packages = packagesWithBuild(root);
  if (!packages.length || !existsSync(join(root, "packages/cli/dist/main.js"))) return null;
  for (const { path, manifest } of packages) {
    const outputs = [];
    walk(join(path, "dist"), outputs);
    const expected = exportedFiles([manifest.exports, manifest.bin, manifest.main, manifest.module, manifest.types]);
    if (!outputs.length || expected.some((entry) => !existsSync(join(path, entry)))) return null;
    files.push(...outputs);
  }
  return hashFiles(root, files);
}

export function workspaceCacheDirectory(root) {
  const key = createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 24);
  return join(tmpdir(), `cassie-workspace-${key}`);
}

/** Use the invoking pnpm executable when possible; never invoke a shell/install. */
export function workspaceBuildCommand(env = process.env, node = process.execPath) {
  const pnpm = env.npm_execpath;
  return pnpm && /^pnpm(?:\.[cm]?js)?$/i.test(basename(pnpm))
    ? { command: node, args: [pnpm, "build"] }
    : { command: "pnpm", args: ["build"] };
}

/** Forward graceful signals and wait for exit; never escalate or restart a child. */
export function runChild(command, args, options = {}) {
  const { spawnImpl = spawn, signalSource = process, quiet = false, diagnostics = process.stderr, ...spawnOptions } = options;
  return new Promise((resolvePromise, reject) => {
    let child;
    let interrupted;
    let output = "";
    const capture = (chunk) => { output = (output + chunk.toString()).slice(-1024 * 1024); };
    const handlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of handlers) signalSource.removeListener(signal, handler);
    };
    for (const signal of Object.keys(SIGNALS)) {
      const handler = () => {
        if (interrupted) return;
        interrupted = signal;
        child?.kill(signal);
      };
      handlers.set(signal, handler);
      signalSource.on(signal, handler);
    }
    try {
      child = spawnImpl(command, args, { ...spawnOptions, shell: false, stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit" });
      if (quiet) {
        child.stdout?.on("data", capture);
        child.stderr?.on("data", capture);
      }
      child.once("error", (error) => { cleanup(); reject(error); });
      child.once("close", (code, signal) => {
        cleanup();
        if (quiet && (code !== 0 || signal || interrupted) && output) diagnostics.write(output);
        resolvePromise({ code: interrupted ? SIGNALS[interrupted] : code ?? SIGNALS[signal] ?? 1, signal, interrupted });
      });
    } catch (error) { cleanup(); reject(error); }
  });
}

function acquireBuildLock(cacheDirectory) {
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  const path = join(cacheDirectory, "build.lock");
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  try { writeFileSync(path, owner, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`A workspace build is already running or was interrupted. After it has stopped, remove ${path} and retry.`);
  }
  return () => {
    if (existsSync(path) && readFileSync(path, "utf8") === owner) rmSync(path);
  };
}

/** Rebuild once on a cache miss, and fail closed if sources change during build. */
export async function ensureWorkspaceBuild(root, options = {}) {
  const { cacheDirectory = workspaceCacheDirectory(root), env = process.env,
    runCommand = runChild, log = (message) => console.error(message) } = options;
  const release = acquireBuildLock(cacheDirectory);
  try {
    const stampPath = join(cacheDirectory, "build.json");
    const input = workspaceInputFingerprint(root);
    const output = workspaceOutputFingerprint(root);
    let stamp;
    try { stamp = JSON.parse(readFileSync(stampPath, "utf8")); } catch { /* Missing or corrupt cache rebuilds. */ }
    if (output && stamp?.version === CACHE_VERSION && stamp.input === input && stamp.output === output && stamp.node === process.version) {
      return { built: false, code: 0 };
    }
    // A failed build must not leave an older success stamp valid.
    rmSync(stampPath, { force: true });
    log("Updating Cassie…");
    const build = workspaceBuildCommand(env);
    const result = await runCommand(build.command, build.args, { cwd: root, env, quiet: true });
    if (result.code !== 0 || result.interrupted) return { built: false, code: result.code || 1 };
    if (workspaceInputFingerprint(root) !== input) throw new Error("Workspace files changed during the build. Save your changes and run the command again.");
    const compiled = workspaceOutputFingerprint(root);
    if (!compiled) throw new Error("Workspace build completed without the required CLI outputs.");
    const temporary = `${stampPath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: CACHE_VERSION, input, output: compiled, node: process.version }), { mode: 0o600 });
    renameSync(temporary, stampPath);
    return { built: true, code: 0 };
  } finally { release(); }
}

/** Preserve caller cwd for relative paths while resolving code from this checkout. */
export async function runWorkspaceCli(args, options = {}) {
  const { root = ROOT, cwd = process.cwd(), env = process.env, runCommand = runChild } = options;
  const build = await ensureWorkspaceBuild(root, { ...options, env, runCommand });
  if (build.code !== 0) return build.code;
  const result = await runCommand(process.execPath, [join(root, "packages/cli/dist/main.js"), ...args], { cwd, env });
  return result.code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorkspaceCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`cassie: ${error.message}`);
    process.exitCode = 1;
  });
}

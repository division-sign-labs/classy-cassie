// scripts/release.mjs
// Publishes public workspace packages in dependency order. Each version must
// become visible through npm's consumer read path before any dependent is
// published, making interrupted or partially propagated releases resumable.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISH_BRANCH = "main";
const VISIBILITY_TIMEOUT_MS = 10 * 60_000;
const VISIBILITY_POLL_MS = 2_000;

function fail(message) {
  throw new Error(message);
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
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
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

export function orderWorkspacePackages(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  const visit = (pkg, chain = []) => {
    if (visited.has(pkg.name)) return;
    if (visiting.has(pkg.name)) fail(`workspace dependency cycle: ${[...chain, pkg.name].join(" -> ")}`);
    visiting.add(pkg.name);

    const dependencyNames = Object.keys({
      ...pkg.manifest.dependencies,
      ...pkg.manifest.optionalDependencies,
      ...pkg.manifest.peerDependencies,
    }).sort();
    for (const name of dependencyNames) {
      const dependency = byName.get(name);
      if (dependency) visit(dependency, [...chain, pkg.name]);
    }

    visiting.delete(pkg.name);
    visited.add(pkg.name);
    ordered.push(pkg);
  };

  for (const pkg of [...packages].sort((a, b) => a.name.localeCompare(b.name))) visit(pkg);
  return ordered;
}

export function parseVisibleVersion(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    const trimmed = raw.trim();
    return trimmed || undefined;
  }
}

function workspacePackages() {
  const listed = JSON.parse(capture("pnpm", ["-r", "list", "--depth", "-1", "--json"]));
  return listed
    .filter((pkg) => !pkg.private)
    .map((pkg) => {
      const manifest = JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf8"));
      if (manifest.publishConfig?.access !== "public") {
        fail(`${pkg.name} must declare publishConfig.access=public or private=true`);
      }
      return { name: pkg.name, version: pkg.version, path: pkg.path, manifest };
    });
}

function assertReleaseGitState() {
  if (capture("git", ["status", "--porcelain"])) fail("release requires a clean working tree");
  const branch = capture("git", ["branch", "--show-current"]);
  if (branch !== PUBLISH_BRANCH) fail(`release requires branch ${PUBLISH_BRANCH}; current branch is ${branch || "detached"}`);
  const local = capture("git", ["rev-parse", "HEAD"]);
  const upstream = capture("git", ["rev-parse", "@{upstream}"]);
  if (local !== upstream) fail("release commit must be pushed before publishing");
}

export async function registryContainsVersion(registry, pkg, fetchImpl = fetch) {
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  const url = new URL(encodeURIComponent(pkg.name), base);
  url.searchParams.set("cassie_release_check", String(Date.now()));
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "cache-control": "no-cache" },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) fail(`npm registry returned HTTP ${response.status} for ${pkg.name}`);
  const document = await response.json();
  return Object.hasOwn(document.versions ?? {}, pkg.version);
}

function versionVisibleToNpm(pkg) {
  const result = spawnSync(
    "npm",
    ["view", `${pkg.name}@${pkg.version}`, "version", "--json", "--prefer-online"],
    { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
  );
  if (result.error || result.status !== 0) return false;
  return parseVisibleVersion(result.stdout) === pkg.version;
}

async function waitForConsumerVisibility(pkg, timeoutMs = VISIBILITY_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastNoticeAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    if (versionVisibleToNpm(pkg)) {
      console.log(`npm visible: ${pkg.name}@${pkg.version}`);
      return;
    }
    if (Date.now() - lastNoticeAt >= 10_000) {
      console.log(`waiting for npm: ${pkg.name}@${pkg.version}`);
      lastNoticeAt = Date.now();
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, VISIBILITY_POLL_MS));
  }
  fail(`npm did not expose ${pkg.name}@${pkg.version} within ${Math.round(timeoutMs / 1000)} seconds`);
}

function smokeInstall(cliPackage) {
  const directory = mkdtempSync(join(tmpdir(), "cassie-registry-install-"));
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "cassie-registry-install-check", private: true }, null, 2)}\n`,
  );
  try {
    console.log(`installing ${cliPackage.name}@${cliPackage.version} from npm`);
    inherit("npm", ["install", `${cliPackage.name}@${cliPackage.version}`, "--prefer-online", "--no-audit", "--no-fund"], {
      cwd: directory,
      env: { ...process.env, CASSIE_SKILLS_DIR: join(directory, "skills") },
    });
    const executable = join(directory, "node_modules", ".bin", process.platform === "win32" ? "cassie.cmd" : "cassie");
    const installedVersion = capture(executable, ["--version"], { cwd: directory });
    if (installedVersion !== cliPackage.version) {
      fail(`installed cassie reported ${installedVersion}; expected ${cliPackage.version}`);
    }
    console.log(`registry install passed: cassie ${installedVersion}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function packAndSmokeInstall(packages) {
  const packDirectory = mkdtempSync(join(tmpdir(), "cassie-release-pack-"));
  const installDirectory = mkdtempSync(join(tmpdir(), "cassie-release-install-"));
  writeFileSync(
    join(installDirectory, "package.json"),
    `${JSON.stringify({ name: "cassie-release-install-check", private: true }, null, 2)}\n`,
  );
  try {
    for (const pkg of packages) {
      inherit("pnpm", ["pack", "--pack-destination", packDirectory], { cwd: pkg.path });
    }
    const tarballs = readdirSync(packDirectory)
      .filter((name) => name.endsWith(".tgz"))
      .sort()
      .map((name) => join(packDirectory, name));
    if (tarballs.length !== packages.length) {
      fail(`packed ${tarballs.length} tarballs; expected ${packages.length}`);
    }
    inherit("npm", ["install", ...tarballs, "--prefer-offline", "--no-audit", "--no-fund"], {
      cwd: installDirectory,
      env: { ...process.env, CASSIE_SKILLS_DIR: join(installDirectory, "skills") },
    });
    const cliPackage = packages.find((pkg) => pkg.name === "@quotient-forecasting/cassie");
    if (!cliPackage) fail("release set does not contain @quotient-forecasting/cassie");
    const executable = join(
      installDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "cassie.cmd" : "cassie",
    );
    const installedVersion = capture(executable, ["--version"], { cwd: installDirectory });
    if (installedVersion !== cliPackage.version) {
      fail(`packed cassie reported ${installedVersion}; expected ${cliPackage.version}`);
    }
    console.log(`local package install passed: cassie ${installedVersion}`);
  } finally {
    rmSync(packDirectory, { recursive: true, force: true });
    rmSync(installDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const publishArgs = args.filter((arg) => arg !== "--dry-run");
  const packages = orderWorkspacePackages(workspacePackages());

  console.log(packages.map((pkg, index) => `${index + 1}. ${pkg.name}@${pkg.version}`).join("\n"));

  if (dryRun) {
    packAndSmokeInstall(packages);
    console.log(`release package check passed for ${packages.length} packages`);
    return;
  }

  assertReleaseGitState();
  const registry = capture("npm", ["config", "get", "registry"]);
  for (const pkg of packages) {
    if (await registryContainsVersion(registry, pkg)) {
      console.log(`already published: ${pkg.name}@${pkg.version}`);
    } else {
      inherit("pnpm", ["publish", "--access", "public", "--publish-branch", PUBLISH_BRANCH, ...publishArgs], {
        cwd: pkg.path,
      });
    }
    await waitForConsumerVisibility(pkg);
  }

  const cliPackage = packages.find((pkg) => pkg.name === "@quotient-forecasting/cassie");
  if (!cliPackage) fail("release set does not contain @quotient-forecasting/cassie");
  smokeInstall(cliPackage);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

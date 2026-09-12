// packages/cli/test/workspace-runtime.test.ts
// Artifact boundaries and deployment shell are checked using fixtures, never SSH or a bot.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  activateWorkspaceRuntime,
  collectWorkspaceRuntime,
  findWorkspaceRoot,
  stageWorkspaceRuntime,
  workspaceStageCommand,
  type WorkspaceRuntimeArtifact,
} from "../src/workspace-runtime.js";
import type { ExecResult } from "../src/ssh.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cassie runtime fixture "));
  temporaryDirectories.push(root);
  const write = (path: string, contents: string) => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  };
  write("package.json", JSON.stringify({ name: "cassie-monorepo", private: true, packageManager: "pnpm@10.15.0" }));
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n  - "strategies/*"\n');
  write("packages/runtime-node/package.json", JSON.stringify({
    name: "@quotient-forecasting/cassie-runtime-node", version: "1.2.3", files: ["dist", "README.md"],
    dependencies: { "@quotient-forecasting/cassie-core": "workspace:*", "better-sqlite3": "12.2.0" },
    optionalDependencies: { "@quotient-forecasting/strategy-example": "workspace:*" },
  }));
  write("packages/core/package.json", JSON.stringify({ name: "@quotient-forecasting/cassie-core", version: "1.2.3", files: ["dist"] }));
  write("strategies/example/package.json", JSON.stringify({
    name: "@quotient-forecasting/strategy-example", version: "1.2.3", files: ["dist", "strategy.v1.json", "strategy.v1.provenance.json"],
  }));
  write("packages/cli/package.json", JSON.stringify({ name: "@quotient-forecasting/cassie", version: "1.2.3" }));
  for (const path of ["packages/runtime-node", "packages/core", "strategies/example"]) {
    write(`${path}/dist/index.js`, "export const version = 'fixture';\n");
    write(`${path}/dist/index.d.ts`, "export declare const version: string;\n");
  }
  write("packages/runtime-node/dist/service.js", "export class BotService {}\n");
  write("packages/runtime-node/dist/main.js", "console.log('fixture');\n");
  write("strategies/example/strategy.v1.json", '{"maxOrder":2}\n');
  write("strategies/example/strategy.v1.provenance.json", '{"source":"fixture"}\n');
  return { root, write };
}

const target = { host: "203.0.113.20", user: "root" };
const artifact = (): WorkspaceRuntimeArtifact => ({
  id: "a".repeat(64), dependencyId: "b".repeat(64), version: "1.2.3", pnpmVersion: "10.15.0",
  archiveBase64: Buffer.from("fixture archive payload including 'quotes' and $(literal)").toString("base64"),
});
function result(ok = true, stdout = "", stderr = ""): ExecResult { return { ok, stdout, stderr, code: ok ? 0 : 1 }; }

function shellSyntax(command: string) {
  const directory = mkdtempSync(join(tmpdir(), "cassie shell syntax "));
  temporaryDirectories.push(directory);
  const path = join(directory, "command.sh");
  writeFileSync(path, command);
  // -n parses the generated shell without executing any command in it.
  const checked = spawnSync("bash", ["-n", path], { encoding: "utf8" });
  expect(checked.error).toBeUndefined();
  expect(checked.status, checked.stderr).toBe(0);
}

describe("workspace runtime artifact", () => {
  it("finds the checkout from a nested directory", () => {
    const h = fixture();
    expect(findWorkspaceRoot(join(h.root, "packages/runtime-node/dist"))).toBe(realpathSync(h.root));
  });

  it("finds the source CLI's checkout when invoked from outside the checkout", () => {
    const h = fixture();
    const caller = mkdtempSync(join(tmpdir(), "cassie caller "));
    temporaryDirectories.push(caller);
    expect(findWorkspaceRoot(caller, join(h.root, "packages/cli"))).toBe(realpathSync(h.root));
  });

  it("prefers the current checkout over another checkout supplying the CLI", () => {
    const caller = fixture();
    const cli = fixture();
    expect(findWorkspaceRoot(join(caller.root, "packages/core"), join(cli.root, "packages/cli"))).toBe(realpathSync(caller.root));
  });

  it("resolves a linked source CLI to its real checkout", () => {
    const h = fixture();
    const caller = mkdtempSync(join(tmpdir(), "cassie linked CLI "));
    temporaryDirectories.push(caller);
    const linked = join(caller, "cli");
    symlinkSync(join(h.root, "packages/cli"), linked);
    expect(findWorkspaceRoot(caller, linked)).toBe(realpathSync(h.root));
  });

  it("skips unrelated workspace markers and fails clearly for an installed CLI without a checkout", () => {
    const h = fixture();
    const other = fixture();
    other.write("packages/runtime-node/package.json", JSON.stringify({ name: "unrelated-runtime" }));
    expect(findWorkspaceRoot(other.root, join(h.root, "packages/cli"))).toBe(realpathSync(h.root));
    expect(() => findWorkspaceRoot(other.root, join(other.root, "packages/cli"))).toThrow(/Run --from-workspace from the checkout/);
    other.write("packages/runtime-node/package.json", "invalid JSON");
    expect(() => findWorkspaceRoot(other.root, other.root)).toThrow(/Cassie source checkout not found/);
  });

  it("changes release identity for compiled code or runtime assets while retaining dependency identity", () => {
    const h = fixture();
    const original = collectWorkspaceRuntime(h.root);
    const repeated = collectWorkspaceRuntime(h.root);
    expect(repeated.id).toBe(original.id);
    expect(repeated.dependencyId).toBe(original.dependencyId);
    h.write("packages/core/dist/index.js", "export const version = 'edited';\n");
    const code = collectWorkspaceRuntime(h.root);
    expect(code.id).not.toBe(original.id);
    expect(code.dependencyId).toBe(original.dependencyId);
    h.write("strategies/example/strategy.v1.json", '{"maxOrder":3}\n');
    const resource = collectWorkspaceRuntime(h.root);
    expect(resource.id).not.toBe(code.id);
    expect(resource.dependencyId).toBe(original.dependencyId);
  });

  it.each(["pnpm-lock.yaml", "packages/cli/package.json", "package.json"])("changes both identities when dependency input %s changes", (path) => {
    const h = fixture();
    const original = collectWorkspaceRuntime(h.root);
    if (path === "pnpm-lock.yaml") h.write(path, "lockfileVersion: '9.0'\n# changed dependency graph\n");
    else if (path === "package.json") h.write(path, JSON.stringify({ packageManager: "pnpm@10.16.0" }));
    else h.write(path, JSON.stringify({ name: "@quotient-forecasting/cassie", version: "1.2.4" }));
    const changed = collectWorkspaceRuntime(h.root);
    expect(changed.id).not.toBe(original.id);
    expect(changed.dependencyId).not.toBe(original.dependencyId);
  });

  it("ships reachable built packages and named JSON resources with verifiable checksums", () => {
    const h = fixture();
    const built = collectWorkspaceRuntime(h.root);
    expect(built.files.has("packages/core/dist/index.js")).toBe(true);
    expect(built.files.has("strategies/example/dist/index.js")).toBe(true);
    expect(built.files.get("strategies/example/strategy.v1.json")?.toString()).toBe('{"maxOrder":2}\n');
    expect(built.files.has("strategies/example/strategy.v1.provenance.json")).toBe(true);
    expect(built.files.has("packages/cli/dist/index.js")).toBe(false);
    expect(built.files.has("packages/cli/package.json")).toBe(true);
    const receipt = JSON.parse(built.files.get("workspace-build.json")!.toString()) as { id: string; dependencyId: string; files: Record<string, string> };
    expect(receipt).toMatchObject({ id: built.id, dependencyId: built.dependencyId });
    for (const [path, expected] of Object.entries(receipt.files)) {
      expect(createHash("sha256").update(built.files.get(path)!).digest("hex")).toBe(expected);
    }
    expect(JSON.parse(built.files.get("packages/runtime-node/workspace-build.json")!.toString())).toEqual({ id: built.id, dependencyId: built.dependencyId });
  });

  it("ships the dashboard's static UI from the runtime's built tree", () => {
    const h = fixture();
    h.write("packages/runtime-node/dist/dashboard/ui/index.html", "<!doctype html><title>fixture</title>\n");
    h.write("packages/runtime-node/dist/dashboard/ui/app.css", "body{margin:0}\n");
    h.write("packages/runtime-node/dist/dashboard/ui/app.js", "console.log('ui');\n");
    const built = collectWorkspaceRuntime(h.root);
    for (const file of ["index.html", "app.css", "app.js"]) expect(built.files.has(`packages/runtime-node/dist/dashboard/ui/${file}`)).toBe(true);
  });

  it("excludes credentials, environments, source, databases and local dependency trees", () => {
    const h = fixture();
    const original = collectWorkspaceRuntime(h.root);
    const sentinel = "TEST_PRIVATE_MATERIAL_MUST_NOT_SHIP";
    for (const path of [".env", ".local.env", ".cassie/keys/bot.json", ".cassie/state/bot.sqlite", "credentials.json",
      "packages/runtime-node/.env", "packages/runtime-node/src/service.ts", "packages/runtime-node/node_modules/private/index.js",
      "node_modules/private/index.js", "packages/cli/dist/index.js", "strategies/example/README.md"]) h.write(path, sentinel);
    const built = collectWorkspaceRuntime(h.root);
    expect(built.id).toBe(original.id);
    expect(built.dependencyId).toBe(original.dependencyId);
    expect([...built.files.values()].some(contents => contents.includes(sentinel))).toBe(false);
    expect([...built.files.keys()].some(path => /(?:^|\/)(?:src|node_modules|\.cassie)(?:\/|$)|\.env$|\.sqlite$/.test(path))).toBe(false);
  });

  it.each(["packages/core/dist/index.js", "packages/core/dist", "strategies/example/strategy.v1.json", "packages/core/package.json"])("rejects symlink artifact input %s", (path) => {
    const h = fixture();
    const source = join(h.root, path);
    const saved = join(h.root, "saved");
    renameSync(source, saved);
    symlinkSync(saved, source);
    expect(() => collectWorkspaceRuntime(h.root)).toThrow(/symlink|ordinary file|built directory/);
  });

  it("rejects a package-directory symlink even when its target is inside the checkout", () => {
    const h = fixture();
    mkdirSync(join(h.root, "vendor"));
    renameSync(join(h.root, "packages/core"), join(h.root, "vendor/core"));
    symlinkSync(join(h.root, "vendor/core"), join(h.root, "packages/core"));
    expect(() => collectWorkspaceRuntime(h.root)).toThrow(/symlink|ordinary file/);
  });

  it("rejects undeclared binary or secret files placed inside dist", () => {
    const h = fixture();
    h.write("packages/core/dist/credentials.pem", "test private material");
    expect(() => collectWorkspaceRuntime(h.root)).toThrow(/unexpected built artifact/);
  });

  it("requires a pinned package manager and all workspace dependencies", () => {
    const h = fixture();
    h.write("package.json", JSON.stringify({ packageManager: "pnpm@latest" }));
    expect(() => collectWorkspaceRuntime(h.root)).toThrow(/exact pnpm version/);
    h.write("package.json", JSON.stringify({ packageManager: "pnpm@10.15.0" }));
    rmSync(join(h.root, "packages/core/package.json"));
    expect(() => collectWorkspaceRuntime(h.root)).toThrow(/missing workspace dependency/);
  });
});

describe("workspace runtime staging", () => {
  it("sends archive bytes only as SSH stdin after validating the target platform", () => {
    const a = artifact();
    const exec = vi.fn().mockReturnValueOnce(result(true, "linux-arm64-137\n")).mockReturnValueOnce(result(true, "staged"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(stageWorkspaceRuntime(target, "bot-1", a, { exec })).toEqual({ id: a.id, releasePath: `/opt/cassie/releases/${a.id}-linux-arm64-137` });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0]).toHaveLength(2);
    expect(exec.mock.calls[0]![1]).toContain('<24');
    expect(exec.mock.calls[1]![2]).toBe(a.archiveBase64);
    for (const call of exec.mock.calls) expect(call[1]).not.toContain(a.archiveBase64);
    const command = exec.mock.calls[1]![1] as string;
    const checksum = createHash("sha256").update(Buffer.from(a.archiveBase64, "base64")).digest("hex");
    expect(command).toContain(checksum);
    expect(command).toContain("base64 --decode >");
    expect(command).not.toMatch(/systemctl|\/var\/lib\/cassie|\/etc\/cassie/);
    shellSyntax(command);
  });

  it.each(["darwin-arm64-137", "linux-ia32-137", "linux-x64-137; touch /tmp/injected", "linux-x64-137\nextra"])("rejects unsupported or injected platform %s before archive transfer", (platform) => {
    const exec = vi.fn(() => result(true, platform));
    expect(() => stageWorkspaceRuntime(target, "bot-1", artifact(), { exec })).toThrow(/requires Linux/);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]).toHaveLength(2);
  });

  it("rejects artifact hash, version and bot-id injection before any SSH call", () => {
    for (const field of ["id", "dependencyId", "version", "pnpmVersion"] as const) {
      const exec = vi.fn();
      expect(() => stageWorkspaceRuntime(target, "bot-1", { ...artifact(), [field]: "1; touch /tmp/injected" }, { exec })).toThrow(/invalid workspace artifact/);
      expect(exec).not.toHaveBeenCalled();
    }
    expect(() => workspaceStageCommand(artifact(), "bot';touch", "linux-x64-137")).toThrow(/bot id/);
    expect(() => workspaceStageCommand(artifact(), "bot-1", "linux-x64-137;touch")).toThrow(/requires Linux/);
  });

  it("keeps install operations inside the dependency-cache miss branch and validates both cached and fresh releases", () => {
    const command = workspaceStageCommand(artifact(), "bot-1", "linux-x64-137");
    const releaseHit = command.slice(command.indexOf('if [ -f "$release/.ready" ]'), command.indexOf("incoming=$(mktemp"));
    expect(releaseHit).toContain("exit 0");
    expect(releaseHit).toContain("cat >/dev/null");
    expect(releaseHit.indexOf("cat >/dev/null")).toBeLessThan(releaseHit.indexOf("exit 0"));
    expect(releaseHit).not.toMatch(/npm install|pnpm_bin|rebuild better-sqlite3/);
    expect(releaseHit).toContain("runuser -u cassie -- node");
    expect(command).toContain('find "$incoming/artifact" -type d -exec chmod 0755');
    expect(command).toContain('find "$incoming/artifact" -type f -exec chmod 0644');
    const finalSmoke = command.lastIndexOf("runuser -u cassie -- node");
    expect(finalSmoke).toBeGreaterThan(command.indexOf('mv "$candidate" "$release"'));
    expect(finalSmoke).toBeLessThan(command.lastIndexOf("touch .ready"));
    const dependencyMiss = command.indexOf('if [ ! -f "$cache/.ready" ]');
    const install = command.indexOf("npm install");
    const reuse = command.indexOf("echo 'reusing installed runtime dependencies'");
    expect(install).toBeGreaterThan(dependencyMiss);
    expect(install).toBeLessThan(reuse);
    expect(command.slice(reuse)).not.toMatch(/npm install|install --prod|rebuild better-sqlite3/);
    expect(command).toContain("--prod --frozen-lockfile --ignore-scripts");
    expect(command).toContain("rebuild better-sqlite3");
    expect(command).toContain("cp -al");
    for (const section of [releaseHit, command.slice(command.indexOf('cd "$candidate"'))]) {
      expect(section).toContain("artifact checksum mismatch");
      expect(section).toContain("better-sqlite3");
      expect(section).toContain(":memory:");
      expect(section).toContain("select 1");
      expect(section).toContain("./packages/runtime-node/dist/service.js");
    }
  });

  it("reports staging failure without an activation command", () => {
    const exec = vi.fn().mockReturnValueOnce(result(true, "linux-x64-137")).mockReturnValueOnce(result(false, "", "native module failed"));
    expect(() => stageWorkspaceRuntime(target, "bot-1", artifact(), { exec })).toThrow(/active runtime was not changed: native module failed/);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.map(call => call[1]).join("\n")).not.toContain("current.next");
  });
});

describe("workspace runtime activation", () => {
  it("atomically updates runtime pointers, retains the previous release and leaves state and credentials alone", () => {
    const a = artifact();
    const exec = vi.fn(() => result());
    activateWorkspaceRuntime(target, "bot-1", { id: a.id, releasePath: `/opt/cassie/releases/${a.id}-linux-x64-137` }, { exec });
    expect(exec).toHaveBeenCalledTimes(1);
    const call = exec.mock.calls[0] as unknown as [typeof target, string];
    expect(call).toHaveLength(2);
    const command = call[1];
    expect(command).toContain("/.ready");
    expect(command).toContain("/activation.lock");
    expect(command).toContain("readlink");
    expect(command).toContain("/previous.next");
    expect(command.indexOf("/previous.next")).toBeLessThan(command.indexOf("/current.next"));
    expect(command).toContain("mv -Tf");
    expect(command).not.toMatch(/\/var\/lib|\/etc\/cassie|\.sqlite|\.env|credentials|systemctl|npm|\brm\b/);
    shellSyntax(command);
  });

  it("refuses paths outside the staged release and propagates activation failure", () => {
    const a = artifact();
    const exec = vi.fn(() => result(false, "", "pointer update denied"));
    for (const releasePath of ["/var/lib/cassie/bot.sqlite", `/opt/cassie/releases/${a.id}-linux-x64-137;touch`, `/opt/cassie/releases/${"c".repeat(64)}-linux-x64-137`]) {
      expect(() => activateWorkspaceRuntime(target, "bot-1", { id: a.id, releasePath }, { exec })).toThrow(/invalid staged workspace path/);
    }
    expect(exec).not.toHaveBeenCalled();
    expect(() => activateWorkspaceRuntime(target, "bot-1", { id: a.id, releasePath: `/opt/cassie/releases/${a.id}-linux-x64-137` }, { exec })).toThrow(/runtime remains stopped: pointer update denied/);
  });
});

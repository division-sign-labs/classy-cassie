// packages/cli/test/workspace-cli.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ensureWorkspaceBuild,
  runChild,
  runWorkspaceCli,
  workspaceBuildCommand,
  workspaceInputFingerprint,
  workspaceOutputFingerprint,
} from "../../../scripts/cassie.mjs";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cassie workspace ' $ "));
  temporaryDirectories.push(root);
  const write = (path: string, content = "export const value = 1;\n") => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  write("package.json", JSON.stringify({ scripts: { build: "pnpm -r build" } }));
  write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n  - "strategies/*"\n');
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write("tsconfig.base.json", "{}");
  for (const path of ["packages/core", "packages/cli", "strategies/example"]) {
    write(`${path}/package.json`, JSON.stringify({ scripts: { build: "tsc" }, exports: { import: "./dist/index.js" } }));
    write(`${path}/src/index.ts`);
  }
  write("strategies/example/policy.json", '{"maximum":1}');
  write("skills/cassie/SKILL.md", "runtime reference\n");
  const compile = () => {
    for (const path of ["packages/core", "packages/cli", "strategies/example"]) write(`${path}/dist/index.js`);
    write("packages/core/dist/extra.js", "export const extra = true;\n");
  };
  const runCommand = vi.fn(async () => { compile(); return { code: 0 }; });
  const options = { root, cacheDirectory: join(root, ".cache"), env: {}, runCommand, log: vi.fn() };
  return { root, write, compile, runCommand, options };
}

describe("workspace build cache", () => {
  it("builds initially, then skips an unchanged workspace without installing packages", async () => {
    const h = fixture();
    await expect(ensureWorkspaceBuild(h.root, h.options)).resolves.toEqual({ built: true, code: 0 });
    await expect(ensureWorkspaceBuild(h.root, h.options)).resolves.toEqual({ built: false, code: 0 });
    expect(h.runCommand).toHaveBeenCalledExactlyOnceWith("pnpm", ["build"], { cwd: h.root, env: {}, quiet: true });
  });

  it("detects content changes even with the original timestamp and file length", async () => {
    const h = fixture();
    await ensureWorkspaceBuild(h.root, h.options);
    const path = join(h.root, "packages/core/src/index.ts");
    const before = statSync(path);
    h.write("packages/core/src/index.ts", "export const value = 2;\n");
    utimesSync(path, before.atime, before.mtime);
    await ensureWorkspaceBuild(h.root, h.options);
    expect(h.runCommand).toHaveBeenCalledTimes(2);
  });

  it("includes runtime resources, manifests, configuration, additions and removals", () => {
    const h = fixture();
    let previous = workspaceInputFingerprint(h.root);
    for (const [path, content] of [
      ["strategies/example/policy.json", '{"maximum":2}'],
      ["skills/cassie/SKILL.md", "updated runtime reference\n"],
      ["packages/core/package.json", '{"scripts":{"build":"tsc --pretty"}}'],
      ["tsconfig.base.json", '{"strict":true}'],
      ["pnpm-lock.yaml", "lockfileVersion: '9.1'\n"],
      ["packages/core/src/new.ts", "export const added = true;\n"],
    ]) {
      h.write(path!, content!);
      const current = workspaceInputFingerprint(h.root);
      expect(current).not.toBe(previous);
      previous = current;
    }
    rmSync(join(h.root, "packages/core/src/new.ts"));
    expect(workspaceInputFingerprint(h.root)).not.toBe(previous);
  });

  it("ignores tests, dependency folders, dotfiles and compiled output as inputs", () => {
    const h = fixture();
    const before = workspaceInputFingerprint(h.root);
    for (const path of ["packages/core/test/a.test.ts", "packages/core/src/a.spec.ts", "packages/core/node_modules/a/index.js",
      "packages/core/dist/index.js", "packages/core/.local.env", "packages/core/tsconfig.tsbuildinfo"]) h.write(path);
    expect(workspaceInputFingerprint(h.root)).toBe(before);
  });

  it("rebuilds if any verified compiled artifact was changed or deleted", async () => {
    const h = fixture();
    await ensureWorkspaceBuild(h.root, h.options);
    h.write("packages/core/dist/extra.js", "modified\n");
    await ensureWorkspaceBuild(h.root, h.options);
    rmSync(join(h.root, "packages/core/dist/extra.js"));
    await ensureWorkspaceBuild(h.root, h.options);
    rmSync(join(h.root, "strategies/example/dist/index.js"));
    expect(workspaceOutputFingerprint(h.root)).toBeNull();
    await ensureWorkspaceBuild(h.root, h.options);
    expect(h.runCommand).toHaveBeenCalledTimes(4);
  });

  it("does not launch after build failure and leaves no success stamp or lock", async () => {
    const h = fixture();
    const runCommand = vi.fn(async () => ({ code: 2 }));
    await expect(runWorkspaceCli(["run", "bot"], { ...h.options, runCommand })).resolves.toBe(2);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(existsSync(join(h.options.cacheDirectory, "build.json"))).toBe(false);
    expect(existsSync(join(h.options.cacheDirectory, "build.lock"))).toBe(false);
  });

  it("rejects source edits during compilation and incomplete successful builds", async () => {
    const h = fixture();
    const changed = vi.fn(async () => { h.compile(); h.write("packages/core/src/index.ts", "changed\n"); return { code: 0 }; });
    await expect(ensureWorkspaceBuild(h.root, { ...h.options, runCommand: changed })).rejects.toThrow("changed during the build");
    expect(existsSync(join(h.options.cacheDirectory, "build.json"))).toBe(false);
    rmSync(join(h.root, "packages/cli/dist/index.js"));
    await expect(ensureWorkspaceBuild(h.root, { ...h.options, runCommand: async () => ({ code: 0 }) })).rejects.toThrow("without the required CLI outputs");
  });

  it("refuses concurrent builds without disturbing the active owner", async () => {
    const h = fixture();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const first = ensureWorkspaceBuild(h.root, { ...h.options, runCommand: async () => { await pending; h.compile(); return { code: 0 }; } });
    const owner = readFileSync(join(h.options.cacheDirectory, "build.lock"), "utf8");
    await expect(ensureWorkspaceBuild(h.root, h.options)).rejects.toThrow("workspace build is already running");
    expect(readFileSync(join(h.options.cacheDirectory, "build.lock"), "utf8")).toBe(owner);
    finish();
    await first;
    expect(existsSync(join(h.options.cacheDirectory, "build.lock"))).toBe(false);
  });
});

describe("workspace CLI process", () => {
  it.each([0, 1])("keeps successful build output quiet and exposes failures (%s)", async (code) => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() });
    const diagnostics = { write: vi.fn() };
    const result = runChild("pnpm", ["build"], { quiet: true, diagnostics, signalSource: new EventEmitter(), spawnImpl: () => child });
    child.stdout.emit("data", "build details\n");
    child.stderr.emit("data", "compiler diagnostic\n");
    child.emit("close", code, null);
    await expect(result).resolves.toMatchObject({ code });
    if (code === 0) expect(diagnostics.write).not.toHaveBeenCalled();
    else expect(diagnostics.write).toHaveBeenCalledWith("build details\ncompiler diagnostic\n");
  });

  it("uses the invoking pnpm file without shell quoting and forwards exact CLI arguments", async () => {
    const h = fixture();
    const env = { npm_execpath: "/tools with spaces/pnpm.cjs" };
    expect(workspaceBuildCommand(env, "/node")).toEqual({ command: "/node", args: [env.npm_execpath, "build"] });
    expect(workspaceBuildCommand({ npm_execpath: "/tools/npm-cli.js" })).toEqual({ command: "pnpm", args: ["build"] });
    const args = ["run", "bot", "--label", 'a "quote"; $(touch NEVER) `literal`'];
    const cwd = join(h.root, "caller directory");
    const runCommand = vi.fn(async (_command: string, commandArgs: string[]) => {
      if (commandArgs.includes("build")) { h.compile(); return { code: 0 }; }
      return { code: 7 };
    });
    await expect(runWorkspaceCli(args, { ...h.options, env, cwd, runCommand })).resolves.toBe(7);
    expect(runCommand.mock.calls).toEqual([
      [process.execPath, [env.npm_execpath, "build"], { cwd: h.root, env, quiet: true }],
      [process.execPath, [join(h.root, "packages/cli/dist/index.js"), ...args], { cwd, env }],
    ]);
  });

  it("forwards a graceful signal once and waits for the child to exit", async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const signalSource = new EventEmitter();
    const spawnImpl = vi.fn(() => child);
    let settled = false;
    const running = runChild("node", ["literal;$(arg)"], { signalSource, spawnImpl, cwd: "/workspace" }).then((result: unknown) => { settled = true; return result; });
    expect(spawnImpl).toHaveBeenCalledWith("node", ["literal;$(arg)"], { cwd: "/workspace", shell: false, stdio: "inherit" });
    signalSource.emit("SIGINT");
    signalSource.emit("SIGTERM");
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGINT");
    child.emit("close", 0, null);
    await expect(running).resolves.toMatchObject({ code: 130, interrupted: "SIGINT" });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) expect(signalSource.listenerCount(signal)).toBe(0);
  });

  it("cleans signal handlers after spawn errors and preserves child failure codes", async () => {
    const signalSource = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const running = runChild("missing", [], { signalSource, spawnImpl: () => child });
    child.emit("error", new Error("ENOENT"));
    await expect(running).rejects.toThrow("ENOENT");
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
    const second = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const result = runChild("node", [], { signalSource, spawnImpl: () => second });
    second.emit("close", 12, null);
    await expect(result).resolves.toMatchObject({ code: 12 });
  });

  it("never launches or restarts a bot after an interrupted build", async () => {
    const h = fixture();
    const runCommand = vi.fn(async () => { h.compile(); return { code: 130, interrupted: "SIGINT" }; });
    await expect(runWorkspaceCli(["run", "bot"], { ...h.options, runCommand })).resolves.toBe(130);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(existsSync(join(h.options.cacheDirectory, "build.json"))).toBe(false);
  });
});

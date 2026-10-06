// packages/cli/test/package-release.test.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RELEASE_PACKAGE, stageReleasePackage } from "../../../scripts/package-release.mjs";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cassie-package-test-"));
  directories.push(root);
  function write(path: string, content: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  function pkg(name: string, dependencies: Record<string, string> = {}) {
    const path = join(root, "source", name);
    const manifest = {
      name, version: name === RELEASE_PACKAGE ? "1.2.3" : "0.0.1", private: true, type: "module",
      files: ["dist", "README.md"], dependencies,
      exports: { ".": "./dist/index.js", "./main": "./dist/main.js" },
      scripts: { prepack: "node -e 'process.exit(9)'" },
    };
    write(join(path, "dist/index.js"), "export const value = 42;\n");
    write(join(path, "README.md"), name);
    write(join(path, ".env"), "EXCLUDED_ENV_VALUE=fixture\n");
    write(join(path, "src/index.ts"), "// excluded source\n");
    write(join(path, "package.json"), JSON.stringify(manifest));
    return { name, version: manifest.version, path, manifest };
  }
  const core = pkg("@quotient-forecasting/cassie-core");
  const runtime = pkg("@quotient-forecasting/cassie-runtime-node", { [core.name]: "workspace:*" });
  const skill = pkg("@quotient-forecasting/cassie-skill");
  skill.manifest.files = ["install.mjs", "SKILL.md", "thesis"];
  write(join(skill.path, "SKILL.md"), "fixture skill");
  write(join(skill.path, "thesis/mappings.json"), "{}");
  write(join(skill.path, "install.mjs"), "import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync(process.env.CASSIE_SKILLS_DIR,{recursive:true}); writeFileSync(process.env.CASSIE_SKILLS_DIR+'/installed','yes');\n");
  const cli = pkg(RELEASE_PACKAGE, { [runtime.name]: "workspace:*", [skill.name]: "workspace:*" });
  Object.assign(cli.manifest, { bin: { cassie: "./dist/main.js" } });
  write(join(cli.path, "dist/main.js"), readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"));
  write(join(cli.path, "dist/index.js"), "import {value} from '@quotient-forecasting/cassie-core'; export function runCli() { console.log(value); }\n");
  write(join(runtime.path, "dist/main.js"), "import {readFileSync} from 'node:fs'; console.log(JSON.parse(readFileSync(new URL('../package.json',import.meta.url))).version);\n");
  return { root, cli, core, runtime, skill, packages: [cli, core, runtime, skill], write };
}

describe("single Cassie archive", () => {
  it("installs globally from one archive with an empty cache and no registry access", () => {
    const f = fixture();
    // A separate third-party archive must still be installed by npm, even when
    // only an internal bundled module imports it.
    const external = join(f.root, "external");
    f.write(join(external, "package.json"), JSON.stringify({ name: "cassie-third-party-test", version: "1.0.0", type: "module", main: "index.js" }));
    f.write(join(external, "index.js"), "export const value = 42;\n");
    const [externalArchive] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--cache", join(f.root, "cache")], { cwd: external, encoding: "utf8" }));
    f.core.manifest.dependencies["cassie-third-party-test"] = `file:${join(external, externalArchive.filename)}`;
    f.write(join(f.core.path, "dist/index.js"), "export {value} from 'cassie-third-party-test';\n");
    const staged = stageReleasePackage(f.packages, join(f.root, "package"));
    const cache = join(f.root, "cache"), prefix = join(f.root, "global");
    const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--cache", cache], {
      cwd: staged.path, encoding: "utf8",
    }))[0];
    expect(packed.bundled.sort()).toEqual([f.core.name, f.runtime.name, f.skill.name]);
    expect(packed.files.map((file: { path: string }) => file.path).join("\n")).not.toMatch(/\.env|src\//);
    execFileSync("npm", ["install", "--global", "--prefix", prefix, join(staged.path, packed.filename),
      "--offline", "--cache", cache, "--registry", "http://127.0.0.1:1", "--no-audit", "--no-fund"], {
      cwd: f.root, env: { ...process.env, CASSIE_SKILLS_DIR: join(f.root, "skills") }, encoding: "utf8",
    });
    const executable = join(prefix, "bin", "cassie");
    expect(execFileSync(executable, [], { encoding: "utf8" }).trim()).toBe("42");
    expect(execFileSync(executable, ["runtime", "--version"], { encoding: "utf8" }).trim()).toBe("1.2.3");
    expect(existsSync(join(f.root, "skills/installed"))).toBe(true);
    expect(existsSync(join(prefix, "bin/cassie-runtime"))).toBe(false);
  });

  it("keeps native and other third-party dependencies outside the archive at their pinned versions", () => {
    const f = fixture();
    f.core.manifest.dependencies = { viem: "2.55.15" };
    f.runtime.manifest.dependencies["better-sqlite3"] = "13.0.3";
    const staged = stageReleasePackage(f.packages, join(f.root, "package"));
    const manifest = JSON.parse(readFileSync(join(staged.path, "package.json"), "utf8"));
    expect(manifest.dependencies).toMatchObject({ viem: "2.55.15", "better-sqlite3": "13.0.3", [f.core.name]: "1.2.3" });
    expect(manifest.bundleDependencies).not.toContain("better-sqlite3");
    expect(manifest.private).toBeUndefined();
    expect(manifest.scripts.prepack).toBeUndefined();
    const runtime = JSON.parse(readFileSync(join(staged.path, "node_modules", f.runtime.name, "package.json"), "utf8"));
    expect(runtime.version).toBe("1.2.3");
    expect(runtime.dependencies[f.core.name]).toBe("1.2.3");
    expect(runtime.dependencies["better-sqlite3"]).toBeUndefined();
  });

  it("rejects conflicting dependency versions and missing workspace modules", () => {
    const f = fixture();
    f.core.manifest.dependencies = { zod: "1.0.0" };
    f.runtime.manifest.dependencies.zod = "2.0.0";
    expect(() => stageReleasePackage(f.packages, join(f.root, "package"))).toThrow("conflicting dependency zod");
    delete f.runtime.manifest.dependencies.zod;
    expect(() => stageReleasePackage(f.packages.filter(pkg => pkg !== f.core), join(f.root, "package")))
      .toThrow("missing workspace dependency");
  });

  it("rejects symlinks in packaged files", () => {
    const f = fixture();
    symlinkSync(join(f.core.path, ".env"), join(f.core.path, "dist/leaked.env"));
    expect(() => stageReleasePackage(f.packages, join(f.root, "package"))).toThrow("must not be a symlink");
  });
});

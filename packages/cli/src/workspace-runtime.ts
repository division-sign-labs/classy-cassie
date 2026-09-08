// packages/cli/src/workspace-runtime.ts
// Ship built workspace code; reuse immutable dependencies compiled on the target.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { restrictedChildEnv } from "./child-env.js";
import { safeBotId } from "./paths.js";
import { sshExec, type Target } from "./ssh.js";

const RUNTIME = "@quotient-forecasting/cassie-runtime-node";
const RUNTIME_PATH = "packages/runtime-node";
const SHA256 = /^[a-f0-9]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const REMOTE_ROOT = "/opt/cassie";

export interface WorkspaceRuntimeArtifact {
  id: string;
  dependencyId: string;
  version: string;
  pnpmVersion: string;
  archiveBase64: string;
}
export interface StagedWorkspaceRuntime { releasePath: string; id: string }
type Manifest = { name: string; version: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; files?: string[]; packageManager?: string };
type WorkspacePackage = { path: string; manifest: Manifest };
type FileSet = Map<string, Buffer>;

function hash(files: FileSet): string {
  const digest = createHash("sha256");
  for (const [path, contents] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    digest.update(`${path}\0${contents.length}\0`).update(contents);
  }
  return digest.digest("hex");
}

function enclosingWorkspace(start: string): string | undefined {
  let path = realpathSync(start);
  for (;;) {
    const manifest = join(path, `${RUNTIME_PATH}/package.json`);
    if (existsSync(join(path, "pnpm-workspace.yaml")) && existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, "utf8")) as Manifest).name === RUNTIME) return path;
      } catch { /* An unrelated or incomplete workspace is not a Cassie checkout. */ }
    }
    const parent = dirname(path);
    if (parent === path) return undefined;
    path = parent;
  }
}

/** Prefer the caller's checkout, then the checkout supplying this CLI (including aliases and links). */
export function findWorkspaceRoot(start = process.cwd(), cliDirectory = dirname(fileURLToPath(import.meta.url))): string {
  const root = enclosingWorkspace(start) ?? enclosingWorkspace(cliDirectory);
  if (!root) throw new Error("Cassie source checkout not found. Run --from-workspace from the checkout.");
  return root;
}

function addFile(files: FileSet, root: string, path: string): void {
  if (path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`invalid artifact path: ${path}`);
  const absolute = join(root, path);
  let ancestor = root;
  for (const part of path.split("/")) {
    ancestor = join(ancestor, part);
    if (lstatSync(ancestor).isSymbolicLink()) throw new Error(`artifact cannot contain symlinks: ${path}`);
  }
  if (!lstatSync(absolute).isFile() || relative(root, realpathSync(absolute)).startsWith("..")) throw new Error(`artifact requires an ordinary file inside the checkout: ${path}`);
  files.set(path, readFileSync(absolute));
}

function addBuiltTree(files: FileSet, root: string, path: string): void {
  if (!lstatSync(join(root, path)).isDirectory()) throw new Error(`missing built directory: ${path}`);
  for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
    const child = `${path}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`artifact cannot contain symlinks: ${child}`);
    if (entry.isDirectory()) addBuiltTree(files, root, child);
    else if (entry.isFile() && /\.(?:js|mjs|cjs|json|map|d\.ts)$/.test(entry.name)) addFile(files, root, child);
    else throw new Error(`unexpected built artifact: ${child}`);
  }
}

/** Explicit packaging boundary: no node_modules, source checkout, env, wallet or database files. */
export function collectWorkspaceRuntime(root: string): { files: FileSet; id: string; dependencyId: string; version: string; pnpmVersion: string } {
  root = realpathSync(root);
  const files: FileSet = new Map();
  for (const file of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) addFile(files, root, file);
  const rootManifest = JSON.parse(files.get("package.json")!.toString()) as Manifest;
  const pnpmVersion = rootManifest.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)$/)?.[1];
  if (!pnpmVersion) throw new Error("workspace packageManager must pin an exact pnpm version");
  const packages = new Map<string, WorkspacePackage>();
  for (const group of ["packages", "strategies", "skills"]) {
    if (!existsSync(join(root, group))) continue;
    for (const name of readdirSync(join(root, group)).sort()) {
      const path = `${group}/${name}`, manifestPath = `${path}/package.json`;
      if (!existsSync(join(root, manifestPath))) continue;
      addFile(files, root, manifestPath);
      const manifest = JSON.parse(files.get(manifestPath)!.toString()) as Manifest;
      if (packages.has(manifest.name)) throw new Error(`duplicate workspace package: ${manifest.name}`);
      packages.set(manifest.name, { path, manifest });
    }
  }
  const runtime = packages.get(RUNTIME);
  if (!runtime || runtime.path !== RUNTIME_PATH || !SEMVER.test(runtime.manifest.version)) throw new Error("invalid workspace runtime manifest");
  // The lockfile and all importer manifests define the cached dependency graph.
  const dependencyId = hash(files);
  const visited = new Set<string>();
  function include(name: string): void {
    if (visited.has(name)) return;
    visited.add(name);
    const pkg = packages.get(name)!;
    addBuiltTree(files, root, `${pkg.path}/dist`);
    for (const resource of pkg.manifest.files ?? []) {
      if (resource === "dist" || resource === "README.md") continue;
      // Runtime resources are named JSON assets; arbitrary package globs stay out.
      if (!/^[a-zA-Z0-9_.-]+\.json$/.test(resource)) throw new Error(`unsupported runtime resource: ${pkg.path}/${resource}`);
      addFile(files, root, `${pkg.path}/${resource}`);
    }
    for (const [dependency, spec] of Object.entries({ ...pkg.manifest.dependencies, ...pkg.manifest.optionalDependencies })) {
      if (packages.has(dependency)) include(dependency);
      else if (spec.startsWith("workspace:")) throw new Error(`missing workspace dependency ${dependency}`);
    }
  }
  include(RUNTIME);
  const id = hash(files);
  const checksums = Object.fromEntries([...files].map(([path, bytes]) => [path, createHash("sha256").update(bytes).digest("hex")]));
  files.set("workspace-build.json", Buffer.from(JSON.stringify({ id, dependencyId, version: runtime.manifest.version, pnpmVersion, files: checksums }) + "\n"));
  // Runtime identity is read beside the installed package, rather than trusted from an environment variable.
  files.set(`${RUNTIME_PATH}/workspace-build.json`, Buffer.from(JSON.stringify({ id, dependencyId }) + "\n"));
  return { files, id, dependencyId, version: runtime.manifest.version, pnpmVersion };
}

export function buildWorkspaceRuntime(root = findWorkspaceRoot()): WorkspaceRuntimeArtifact {
  // A caller-supplied build path must not silently fall back to a different checkout.
  root = findWorkspaceRoot(root, root);
  const build = spawnSync("pnpm", ["--filter", `${RUNTIME}...`, "build"], {
    cwd: root, env: restrictedChildEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024,
  });
  if (build.error || build.status !== 0) {
    const diagnostic = [build.stdout, build.stderr].filter(Boolean).join("\n").trim();
    if (diagnostic) console.error(diagnostic);
    throw new Error("Workspace build failed. Deployed bot unchanged.");
  }
  const artifact = collectWorkspaceRuntime(root);
  const staging = mkdtempSync(join(tmpdir(), "cassie-workspace-"));
  try {
    for (const [path, bytes] of artifact.files) {
      mkdirSync(dirname(join(staging, path)), { recursive: true });
      writeFileSync(join(staging, path), bytes);
    }
    const archive = spawnSync("tar", ["-czf", "-", "-C", staging, "."], {
      env: { ...restrictedChildEnv(), COPYFILE_DISABLE: "1" }, maxBuffer: 64 * 1024 * 1024,
    });
    if (archive.error || archive.status !== 0) throw new Error("could not archive the built workspace runtime");
    return { id: artifact.id, dependencyId: artifact.dependencyId, version: artifact.version, pnpmVersion: artifact.pnpmVersion, archiveBase64: archive.stdout.toString("base64") };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function validateArtifact(a: WorkspaceRuntimeArtifact): void {
  if (!SHA256.test(a.id) || !SHA256.test(a.dependencyId) || !SEMVER.test(a.version) || !SEMVER.test(a.pnpmVersion)) throw new Error("invalid workspace artifact identity");
}

/** Shell payload is fixed code plus validated hashes; archive contents travel on stdin. */
export function workspaceStageCommand(a: WorkspaceRuntimeArtifact, botId: string, platform: string): string {
  validateArtifact(a); safeBotId(botId);
  if (!/^linux-(?:x64|arm64)-\d+$/.test(platform)) throw new Error("workspace runtime requires Linux x64/arm64 with Node 24 or newer");
  const release = `${REMOTE_ROOT}/releases/${a.id}-${platform}`;
  const cache = `${REMOTE_ROOT}/dependencies/${a.dependencyId}-${platform}`;
  const archiveSha = createHash("sha256").update(Buffer.from(a.archiveBase64, "base64")).digest("hex");
  const verify = `const fs=require('node:fs'),crypto=require('node:crypto');const m=JSON.parse(fs.readFileSync('workspace-build.json'));if(m.id!==${JSON.stringify(a.id)}||m.dependencyId!==${JSON.stringify(a.dependencyId)})throw Error('artifact identity mismatch');for(const [p,h] of Object.entries(m.files)){if(p.startsWith('/')||p.split('/').includes('..'))throw Error('invalid artifact path');if(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==h)throw Error('artifact checksum mismatch: '+p);}`;
  const smoke = `const {createRequire}=require('node:module');const r=createRequire(process.cwd()+'/packages/runtime-node/package.json');const Database=r('better-sqlite3');const db=new Database(':memory:');db.exec('select 1');db.close();import('./packages/runtime-node/dist/service.js').then(()=>console.log('workspace runtime smoke passed')).catch(e=>{console.error(e.message);process.exitCode=1;});`;
  return `set -eu
umask 022
install -d -m 0755 ${REMOTE_ROOT}/releases ${REMOTE_ROOT}/dependencies ${REMOTE_ROOT}/incoming
exec 9>${REMOTE_ROOT}/workspace-stage.lock
flock -w 600 9
release=${quote(release)}
cache=${quote(cache)}
if [ -f "$release/.ready" ]; then
  cat >/dev/null
  cd "$release"
  node -e ${quote(verify)}
  runuser -u cassie -- node -e ${quote(smoke)}
  echo 'workspace release already staged'
  exit 0
fi
incoming=$(mktemp -d ${REMOTE_ROOT}/incoming/build.XXXXXX)
trap 'rm -rf "$incoming"' EXIT
base64 --decode > "$incoming/artifact.tar.gz"
echo ${quote(`${archiveSha}  `)}"$incoming/artifact.tar.gz" | sha256sum --check --status
mkdir "$incoming/artifact"
tar --no-same-owner -xzf "$incoming/artifact.tar.gz" -C "$incoming/artifact"
# Developer umasks must not make an otherwise valid release unreadable by the bot.
find "$incoming/artifact" -type d -exec chmod 0755 {} +
find "$incoming/artifact" -type f -exec chmod 0644 {} +
cd "$incoming/artifact"
node -e ${quote(verify)}
if [ ! -f "$cache/.ready" ]; then
  echo 'installing locked runtime dependencies for this target'
  pnpm_bin=${REMOTE_ROOT}/tools/pnpm-${a.pnpmVersion}/node_modules/.bin/pnpm
  if [ ! -x "$pnpm_bin" ]; then
    npm install --prefix ${REMOTE_ROOT}/tools/pnpm-${a.pnpmVersion} --ignore-scripts --no-audit --no-fund pnpm@${a.pnpmVersion}
  fi
  depstage="$incoming/dependencies"
  mkdir "$depstage"
  node -e ${quote(`const fs=require('node:fs'),path=require('node:path');const m=JSON.parse(fs.readFileSync('workspace-build.json'));const dst=process.argv[1];for(const p of Object.keys(m.files)){if(p==='pnpm-lock.yaml'||p==='pnpm-workspace.yaml'||p==='package.json'||p.endsWith('/package.json')){fs.mkdirSync(path.dirname(path.join(dst,p)),{recursive:true});fs.copyFileSync(p,path.join(dst,p));}}`)} "$depstage"
  cd "$depstage"
  CI=1 "$pnpm_bin" --filter '${RUNTIME}...' install --prod --frozen-lockfile --ignore-scripts
  "$pnpm_bin" --filter '${RUNTIME}' rebuild better-sqlite3
  touch .ready
  if [ -e "$cache" ]; then echo 'incomplete dependency cache requires inspection' >&2; exit 1; fi
  mv "$depstage" "$cache"
else
  echo 'reusing installed runtime dependencies'
fi
candidate="$incoming/release"
cp -al "$cache" "$candidate"
# Remove linked manifests before overlaying so the dependency cache remains immutable.
cd "$incoming/artifact"
node -e ${quote(`const fs=require('node:fs'),path=require('node:path');const dst=process.argv[1];const copy=(src,rel='')=>{for(const e of fs.readdirSync(src,{withFileTypes:true})){const p=path.join(rel,e.name),to=path.join(dst,p);if(e.isDirectory()){fs.mkdirSync(to,{recursive:true});copy(path.join(src,e.name),p);}else{fs.rmSync(to,{force:true});fs.copyFileSync(path.join(src,e.name),to);}}};copy('.');`)} "$candidate"
rm -f "$candidate/.ready"
cd "$candidate"
node -e ${quote(verify)}
if [ -e "$release" ]; then echo 'incomplete release requires inspection' >&2; exit 1; fi
mv "$candidate" "$release"
cd "$release"
if ! runuser -u cassie -- node -e ${quote(smoke)}; then
  rm -rf "$release"
  exit 1
fi
touch .ready
echo 'workspace release staged'
`;
}

export function stageWorkspaceRuntime(target: Target, botId: string, artifact: WorkspaceRuntimeArtifact,
  deps: { exec: typeof sshExec } = { exec: sshExec }): StagedWorkspaceRuntime {
  validateArtifact(artifact); safeBotId(botId);
  const probe = deps.exec(target, `node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1);console.log(process.platform+"-"+process.arch+"-"+process.versions.modules)'`);
  const platform = probe.stdout.trim();
  if (!probe.ok || !/^linux-(?:x64|arm64)-\d+$/.test(platform)) throw new Error("workspace runtime requires Linux x64/arm64 with Node 24 or newer");
  const result = deps.exec(target, workspaceStageCommand(artifact, botId, platform), artifact.archiveBase64);
  if (!result.ok) throw new Error(`workspace staging failed; the active runtime was not changed: ${(result.stderr || result.stdout).trim().slice(-1500)}`);
  console.log(result.stdout.trim());
  return { id: artifact.id, releasePath: `${REMOTE_ROOT}/releases/${artifact.id}-${platform}` };
}

/** Called only after checked shutdown and checkpoint preservation. No database or credentials move here. */
export function activateWorkspaceRuntime(target: Target, botId: string, staged: StagedWorkspaceRuntime,
  deps: { exec: typeof sshExec } = { exec: sshExec }): void {
  safeBotId(botId);
  if (!SHA256.test(staged.id) || !new RegExp(`^${REMOTE_ROOT}/releases/${staged.id}-linux-(?:x64|arm64)-\\d+$`).test(staged.releasePath)) throw new Error("invalid staged workspace path");
  const dir = `${REMOTE_ROOT}/bots/${botId}`;
  const result = deps.exec(target, `set -eu
test -f ${quote(staged.releasePath + "/.ready")}
install -d -m 0755 ${quote(dir)}
exec 9>${quote(dir + "/activation.lock")}
flock -w 30 9
if [ -L ${quote(dir + "/current")} ]; then
  old=$(readlink ${quote(dir + "/current")})
  ln -sfn "$old" ${quote(dir + "/previous.next")}
  mv -Tf ${quote(dir + "/previous.next")} ${quote(dir + "/previous")}
fi
ln -sfn ${quote(staged.releasePath)} ${quote(dir + "/current.next")}
mv -Tf ${quote(dir + "/current.next")} ${quote(dir + "/current")}
`);
  if (!result.ok) throw new Error(`workspace activation failed; the runtime remains stopped: ${(result.stderr || result.stdout).trim().slice(-600)}`);
}

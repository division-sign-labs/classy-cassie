// skills/cassie/install.mjs
// Install Cassie's operator skill for supported coding agents.

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(packageDir, "../..");

function defaultRoots() {
  return [join(homedir(), ".agents", "skills"), join(homedir(), ".claude", "skills")];
}

export function installCassieSkill(options = {}) {
  const override = process.env.CASSIE_SKILLS_DIR?.trim();
  if (!options.force && process.env.CASSIE_SKIP_SKILL_INSTALL === "1") return [];

  // A workspace dependency's lifecycle runs during contributor installs too.
  // Keep those installs repo-local unless a test explicitly supplies a target.
  if (!options.force && !override && existsSync(join(workspaceRoot, "pnpm-workspace.yaml"))) return [];

  const roots = options.roots ?? (override ? [resolve(override)] : defaultRoots());
  const installed = [];
  for (const root of roots) {
    const destination = join(root, "cassie");
    mkdirSync(destination, { recursive: true });
    cpSync(join(packageDir, "SKILL.md"), join(destination, "SKILL.md"), { force: true });
    cpSync(join(packageDir, "thesis"), join(destination, "thesis"), { recursive: true, force: true });
    installed.push(destination);
  }

  if (!options.quiet) {
    for (const destination of installed) console.log(`cassie skill installed: ${destination}`);
  }
  return installed;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    installCassieSkill();
  } catch (error) {
    // Skill discovery is useful but must not make the CLI itself uninstallable.
    // `cassie skill install` retries strictly and reports the actionable error.
    console.warn(`cassie skill install skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

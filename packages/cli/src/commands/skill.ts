// packages/cli/src/commands/skill.ts
// Explicit fallback for package managers configured with --ignore-scripts.

import { installCassieSkill } from "@quotient-forecasting/cassie-skill";

export function installSkill(): void {
  const installed = installCassieSkill({ force: true, quiet: true });
  if (installed.length === 0) throw new Error("no agent skill directory was available");
  console.log("Cassie skill installed.");
  for (const destination of installed) console.log(destination);
  console.log("Restart your agent session to load the skill.");
}

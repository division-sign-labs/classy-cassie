// packages/cli/src/commands/skill.ts
// Explicit fallback for package managers configured with --ignore-scripts.

import pc from "picocolors";
import { installCassieSkill } from "@quotient-forecasting/cassie-skill";

export function installSkill(): void {
  const installed = installCassieSkill({ force: true, quiet: true });
  if (installed.length === 0) throw new Error("no agent skill directory was available");
  for (const destination of installed) console.log(pc.green(`cassie skill installed: ${destination}`));
  console.log(pc.dim("Restart an open agent session if it does not discover the skill immediately."));
}

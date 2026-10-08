// packages/cli/src/commands/pause.ts
// Operator pause/resume for a running bot (deployed or `cassie run`), through its control socket.
import pc from "picocolors";
import type { BotConfig } from "@quotient-forecasting/cassie-core";
import { loadBotConfig } from "../paths.js";
import { swingControl } from "./swing.js";

/** Strategies whose resume needs a review step of its own. */
const OWN_RESUME: Record<string, string> = {
  "quotient-swing": "cassie swing resume",
  "market-make": "cassie market-make resume",
  "kalshi-commodities": "cassie commodities resume",
};

function control(cfg: BotConfig, path: string): Promise<unknown> {
  return swingControl(cfg, path, "POST");
}

export async function pauseBot(botId: string): Promise<void> {
  const cfg = loadBotConfig(botId);
  await control(cfg, "/pause");
  console.log(pc.yellow(`${botId} paused.`));
  console.log("No new entries. Positions stay open.");
  console.log(`Resume with: ${OWN_RESUME[cfg.strategy.id] ?? "cassie resume"} ${botId}`);
}

export async function resumeBot(botId: string): Promise<void> {
  const cfg = loadBotConfig(botId);
  const own = OWN_RESUME[cfg.strategy.id];
  if (own) throw new Error(`${cfg.strategy.id} bots resume with \`${own} ${botId}\``);
  await control(cfg, "/resume");
  console.log(pc.green(`${botId} resumed.`));
  console.log("The next tick can place orders.");
}

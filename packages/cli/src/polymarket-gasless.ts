// packages/cli/src/polymarket-gasless.ts
// Reuse operator-wide gasless authorization; fall back to the bot's setup credential.
import { GASLESS_AUTH_ROLE, parsePolymarketGaslessAuth, type BotConfig, type PolymarketGaslessAuth } from "@quotient-forecasting/cassie-core";
import { getOperatorDefault } from "./defaults.js";
import { getKeystoreSecret } from "./context.js";

export async function resolvePolymarketGaslessAuth(
  cfg: BotConfig,
  deps = { defaultAuth: getOperatorDefault, botSecret: getKeystoreSecret },
): Promise<PolymarketGaslessAuth | undefined> {
  if (cfg.venue !== "polymarket" || !["signals", "flip-flat", "agent"].includes(cfg.strategy.id)) return undefined;
  const raw = deps.defaultAuth("polymarket-builder") ?? await deps.botSecret(cfg.id, GASLESS_AUTH_ROLE);
  if (!raw) throw new Error("Polymarket auto-redemption needs a saved Builder or Relayer key; run cassie init to configure one");
  return parsePolymarketGaslessAuth(raw);
}

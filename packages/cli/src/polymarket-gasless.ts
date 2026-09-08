// packages/cli/src/polymarket-gasless.ts
// Resolve an operator or bot override, then the bundled Quotient service credential.
import { GASLESS_AUTH_ROLE, parsePolymarketGaslessAuth, QUOTIENT_POLYMARKET_GASLESS_AUTH, type BotConfig, type PolymarketGaslessAuth } from "@quotient-forecasting/cassie-core";
import { getOperatorDefault } from "./defaults.js";
import { getKeystoreSecret } from "./context.js";

export async function resolvePolymarketGaslessAuth(
  cfg: BotConfig,
  deps = { defaultAuth: getOperatorDefault, botSecret: getKeystoreSecret },
): Promise<PolymarketGaslessAuth | undefined> {
  if (cfg.venue !== "polymarket" || !["signals", "flip-flat", "agent"].includes(cfg.strategy.id)) return undefined;
  const raw = deps.defaultAuth("polymarket-builder") ?? await deps.botSecret(cfg.id, GASLESS_AUTH_ROLE);
  return raw ? parsePolymarketGaslessAuth(raw) : QUOTIENT_POLYMARKET_GASLESS_AUTH;
}

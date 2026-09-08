// packages/cli/src/commands/run.ts
// `cassie run <botId>`: the bot in this terminal, on this machine.

import { join } from "node:path";
import pc from "picocolors";
import { KeyRoles, consoleLogger, usesStrategyKey } from "@quotient-forecasting/cassie-core";
import { runLocal } from "@quotient-forecasting/cassie-runtime-node";
import { buildRuntimeCreds, getKeystoreSecret, requireAccount } from "../context.js";
import { dirs, loadBotConfig, statePath } from "../paths.js";
import { missingStrategyKeyMessage, resolveQuotientToken, resolveStrategyKey } from "../quotient-token.js";
import { POLYMARKET_FEE_DISCLOSURE } from "./strategy.js";
import { resolveSurplusApiKey } from "../surplus-config.js";
import { QuotientSwingConfigSchema } from "@quotient-forecasting/strategy-quotient-swing";
import { resolvePolymarketGaslessAuth } from "../polymarket-gasless.js";

export interface RunOpts {
  debug?: boolean;
}

export async function runBot(botId: string, opts: RunOpts): Promise<void> {
  const cfg = loadBotConfig(botId);
  if (cfg.strategy.id === "quotient-swing") QuotientSwingConfigSchema.parse(cfg.strategy.config);
  if (cfg.deployment) {
    throw new Error(`Bot ${botId} is assigned to a droplet.\ncassie deploy ${botId} --from-workspace`);
  }
  const account = requireAccount(cfg);
  const creds = await buildRuntimeCreds(cfg);
  const polymarketGaslessAuth = await resolvePolymarketGaslessAuth(cfg);
  const strategyKeyed = usesStrategyKey(cfg.strategy.id);
  const resolvedStrategyKey = strategyKeyed ? await resolveStrategyKey(botId) : null;
  if (strategyKeyed && !resolvedStrategyKey) throw new Error(missingStrategyKeyMessage(botId));
  if (resolvedStrategyKey) console.log(pc.dim(`strategy credential: ${resolvedStrategyKey.origin}`));
  const strategyKey = resolvedStrategyKey?.token;
  // A strategy bot no longer needs a developer key; keep resolving it for the
  // strategies whose research calls still run on one.
  const quotientToken = strategyKeyed
    ? (await resolveQuotientToken(botId).catch(() => null))?.token
    : (await resolveQuotientToken(botId))?.token;
  const telegramToken =
    process.env.TELEGRAM_BOT_TOKEN ?? (await getKeystoreSecret(botId, KeyRoles.telegramToken)) ?? undefined;
  let surplusApiKey: string | undefined;
  if (cfg.strategy.id === "agent") {
    const resolved = await resolveSurplusApiKey(botId);
    if (!resolved) {
      throw new Error(`the ${cfg.strategy.id} strategy needs SURPLUS_API_KEY (environment, nearest .local.env, or bot keystore)`);
    }
    console.log(pc.dim(`Surplus credential: ${resolved.origin}`));
    surplusApiKey = resolved.value;
  }

  if (cfg.strategy.id === "quotient-swing") {
    const swing = QuotientSwingConfigSchema.parse(cfg.strategy.config);
    console.log(`Starting ${botId}: quotient-swing on Hyperliquid.`);
    console.log(`Decisions: ${Number((swing.tickIntervalMin * 60).toFixed(4))}s`);
    console.log(`Forecast refresh: ${swing.signalPollIntervalMin}m`);
    console.log("Live trading starts after account checks.");
    console.log("Existing operator and safety halts remain in effect.");
  } else {
    const signalPollIntervalMin = Number(
      (cfg.strategy.config as Record<string, unknown>).signalPollIntervalMin ?? 5,
    );
    console.log(`Starting ${botId}: ${cfg.strategy.id} on ${cfg.venue}.`);
    console.log(`Position checks: ${Number((cfg.tickIntervalMin * 60).toFixed(4))}s`);
    console.log(`Signal refresh: ${Number(signalPollIntervalMin.toFixed(4))}m`);
  }
  console.log(pc.dim(cfg.strategy.id === "quotient-swing" ? "Ctrl-C cancels working orders and retains exchange-native protective stops." : "Ctrl-C cancels resting orders before exit."));

  await runLocal({
    config: cfg,
    account,
    creds,
    polymarketGaslessAuth,
    statePath: statePath(botId),
    controlSocket: join(dirs.run(), `${botId}.sock`),
    quotientToken,
    strategyKey,
    telegramToken,
    surplusApiKey,
    log: consoleLogger(botId, opts.debug ? "debug" : "info"),
  });
}

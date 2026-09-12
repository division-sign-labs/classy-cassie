// packages/cli/src/commands/run.ts
// `cassie run <botId>`: the bot in this terminal, on this machine.

import { join } from "node:path";
import pc from "picocolors";
import { consoleLogger } from "@quotient-forecasting/cassie-core";
import { runLocal } from "@quotient-forecasting/cassie-runtime-node";
import { buildRuntimeCreds, requireAccount } from "../context.js";
import { describeTelegramSettings, resolveTelegramSettings } from "../telegram-settings.js";
import { dirs, loadBotConfig, statePath } from "../paths.js";
import { resolveQuotientToken } from "../quotient-token.js";
import { resolveSurplusApiKey } from "../surplus-config.js";
import { MarketMakeConfigSchema } from "@quotient-forecasting/strategy-market-make";
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
  const twoSidedMaker = cfg.strategy.id === "market-make" && Boolean(cfg.strategy.config.two_sided) && !MarketMakeConfigSchema.parse(cfg.strategy.config).two_sided?.adaptive;
  const quotientToken = twoSidedMaker ? undefined : (await resolveQuotientToken(botId))?.token;
  const telegram = await resolveTelegramSettings(botId, cfg.alerts.telegram);
  console.log(pc.dim(describeTelegramSettings(telegram)));
  let surplusApiKey: string | undefined;
  if (cfg.strategy.id === "agent") {
    const resolved = await resolveSurplusApiKey(botId);
    if (!resolved) {
      throw new Error(`the ${cfg.strategy.id} strategy needs SURPLUS_API_KEY (environment, nearest .local.env, or bot keystore)`);
    }
    console.log(pc.dim(`Surplus credential: ${resolved.origin}`));
    surplusApiKey = resolved.value;
  }

  if (cfg.strategy.id === "market-make") {
    const maker = MarketMakeConfigSchema.parse(cfg.strategy.config);
    console.log(`Starting ${botId}: market-make on Polymarket.`);
    console.log(`Position checks: ${Number((cfg.tickIntervalMin * 60).toFixed(4))}s`);
    if (maker.two_sided?.adaptive) console.log(`Forecast refresh: ${maker.two_sided.adaptive.forecast_refresh_seconds}s`);
    else if (!maker.two_sided) console.log(`Forecast refresh: ${maker.quotient_feed.active_poll_seconds}s active / ${maker.quotient_feed.idle_poll_seconds}s idle`);
    console.log("New configurations require reviewed activation.");
    if (!maker.two_sided) {
      console.log(`cassie market-make reconcile ${botId}`);
      console.log(`cassie market-make reconcile ${botId} --apply`);
      console.log(`cassie market-make resume ${botId}`);
    }
  } else if (cfg.strategy.id === "quotient-swing") {
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
    telegramToken: telegram.token,
    telegramChatId: telegram.chatId,
    surplusApiKey,
    log: consoleLogger(botId, opts.debug ? "debug" : "info"),
  });
}

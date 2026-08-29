// packages/cli/src/commands/run.ts
// `cassie run <botId>`: the bot in this terminal, on this machine.

import { join } from "node:path";
import pc from "picocolors";
import { KeyRoles, consoleLogger } from "@quotient-forecasting/cassie-core";
import { runLocal } from "@quotient-forecasting/cassie-runtime-node";
import { buildRuntimeCreds, getKeystoreSecret, requireAccount } from "../context.js";
import { dirs, loadBotConfig, statePath } from "../paths.js";
import { resolveQuotientToken } from "../quotient-token.js";
import { resolveAresApiKey } from "../ares-config.js";
import { resolveSurplusApiKey } from "../surplus-config.js";

export interface RunOpts {
  debug?: boolean;
}

export async function runBot(botId: string, opts: RunOpts): Promise<void> {
  const cfg = loadBotConfig(botId);
  const account = requireAccount(cfg);
  const creds = await buildRuntimeCreds(cfg);
  const quotientToken = (await resolveQuotientToken(botId))?.token;
  const telegramToken =
    process.env.TELEGRAM_BOT_TOKEN ?? (await getKeystoreSecret(botId, KeyRoles.telegramToken)) ?? undefined;
  const reportingApiKey = cfg.reporting ? (await resolveAresApiKey(botId))?.value : undefined;
  let surplusApiKey: string | undefined;
  if (cfg.strategy.id === "agent") {
    const resolved = await resolveSurplusApiKey(botId);
    if (!resolved) {
      throw new Error("this bot runs the agent strategy and needs SURPLUS_API_KEY (environment, nearest .local.env, or bot keystore)");
    }
    console.log(pc.dim(`Surplus credential: ${resolved.origin}`));
    surplusApiKey = resolved.value;
  }

  const signalPollIntervalMin = Number(
    (cfg.strategy.config as Record<string, unknown>).signalPollIntervalMin ?? 5,
  );
  console.log(
    pc.bold(
      `running ${botId} on ${cfg.venue} (strategy ${cfg.strategy.id}, ` +
        `positions every ${Number((cfg.tickIntervalMin * 60).toFixed(4))}s, ` +
        `signals every ${Number(signalPollIntervalMin.toFixed(4))}m)`,
    ),
  );
  console.log(pc.dim("Ctrl-C cancels resting orders before exit."));

  await runLocal({
    config: cfg,
    account,
    creds,
    statePath: statePath(botId),
    controlSocket: join(dirs.run(), `${botId}.sock`),
    quotientToken,
    telegramToken,
    reportingApiKey,
    surplusApiKey,
    log: consoleLogger(botId, opts.debug ? "debug" : "info"),
  });
}

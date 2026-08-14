// packages/cli/src/commands/run.ts
// `cassie run <botId>` (§11 local runtime).

import pc from "picocolors";
import { KeyRoles, consoleLogger } from "@quotient-forecasting/cassie-core";
import { runLocal } from "@quotient-forecasting/cassie-runtime-local";
import { buildRuntimeCreds, getKeystoreSecret, requireAccount } from "../context.js";
import { loadBotConfig, statePath } from "../paths.js";
import { resolveQuotientToken } from "../quotient-token.js";
import { resolveAresApiKey } from "../ares-config.js";

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

  console.log(pc.bold(`running ${botId} on ${cfg.venue} (strategy ${cfg.strategy.id}, every ${cfg.tickIntervalMin}m)`));
  console.log(pc.dim("Ctrl-C cancels resting orders before exit."));

  await runLocal({
    config: cfg,
    account,
    creds,
    statePath: statePath(botId),
    quotientToken,
    telegramToken,
    reportingApiKey,
    log: consoleLogger(botId, opts.debug ? "debug" : "info"),
  });
}

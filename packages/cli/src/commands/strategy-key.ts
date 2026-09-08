// packages/cli/src/commands/strategy-key.ts
// Pins a strategy-scoped Quotient key (qsk_…) to one bot's keystore. The key
// is issued per strategy from the Quotient admin console and can be revoked
// there; it is the only credential the signals strategy runs on. Verified
// against the gateway before it is stored so a dead or mis-scoped key fails
// here instead of as a 401 loop on the droplet.

import { KeyRoles, checkStrategyKeyAccess, strategyRulesId, usesStrategyKey } from "@quotient-forecasting/cassie-core";
import { ask, getPassphrase, keystore } from "../context.js";
import { loadBotConfig } from "../paths.js";
import { resolveStrategyKey } from "../quotient-token.js";

export interface StrategyKeyOpts {
  /** Show which source the next run or deployment would use; store nothing. */
  status?: boolean;
}

export async function configureStrategyKey(botId: string, key: string | undefined, opts: StrategyKeyOpts = {}): Promise<void> {
  const cfg = loadBotConfig(botId);
  if (!usesStrategyKey(cfg.strategy.id)) {
    throw new Error(`${botId} runs ${cfg.strategy.id}, which does not use a strategy key`);
  }
  const strategyId = strategyRulesId(cfg.strategy.id);

  if (opts.status) {
    const resolved = await resolveStrategyKey(botId);
    console.log(resolved ? `${botId}: strategy key from ${resolved.origin}` : `${botId}: no strategy key found`);
    if (!resolved) console.log(`cassie strategy-key ${botId} <key>`);
    return;
  }

  const token = (key ?? (await ask(`Strategy key for ${strategyId} (qsk_…)`, { secret: true }))).trim();
  if (!token) throw new Error("no key given");
  if (!token.startsWith("qsk_")) throw new Error("a strategy key starts with qsk_; developer keys (qt_) cannot run a strategy");

  const { version } = await checkStrategyKeyAccess(cfg.signals, cfg.strategy.id, token);
  console.log(`Key verified for the ${strategyId} strategy (rules version ${version})`);
  console.log(cfg.signals.baseUrl);

  keystore().putEntry(botId, KeyRoles.strategyKey, token, await getPassphrase(botId), { runtimeEligible: true });
  console.log(`${botId}: strategy key saved`);
  console.log(`cassie deploy ${botId}`);
}

// packages/cli/src/commands/signals-key.ts
// Pins one bot's Quotient signals key to its own keystore, so several bots run
// from one working directory can trade on different Quotient accounts. The key
// is verified against the gateway before it is stored — a deploy that installs
// a dead key only shows up later, as a 401 loop on the droplet.

import pc from "picocolors";
import { KeyRoles, checkLiveSignalAccess, parseBotConfig } from "@quotient-forecasting/cassie-core";
import { ask, getPassphrase, keystore } from "../context.js";
import { loadBotConfig, saveBotConfig } from "../paths.js";
import { discoverQuotientToken } from "../quotient-token.js";

export interface SignalsKeyOpts {
  /** Unpin: go back to the nearest .local.env, the environment, then the keystore. */
  auto?: boolean;
}

export async function configureSignalsKey(botId: string, key: string | undefined, opts: SignalsKeyOpts): Promise<void> {
  const cfg = loadBotConfig(botId);

  if (opts.auto) {
    saveBotConfig(parseBotConfig({ ...cfg, signals: { ...cfg.signals, keySource: "auto" } }));
    const discovered = discoverQuotientToken();
    console.log(pc.green(`${botId}: signals key unpinned`));
    console.log(
      pc.dim(
        discovered
          ? `next deploy would use ${discovered.origin}`
          : "no key found in the nearest .local.env, the environment, or the quotient CLI — the stored keystore entry would be used",
      ),
    );
    return;
  }

  const token = (key ?? (await ask("Quotient API key", { secret: true }))).trim();
  if (!token) throw new Error("no key given");

  const { count } = await checkLiveSignalAccess(cfg.signals, token);
  console.log(pc.green(`key verified against ${cfg.signals.baseUrl} (${count} published signals)`));

  keystore().putEntry(botId, KeyRoles.quotientToken, token, await getPassphrase(botId), { runtimeEligible: true });
  saveBotConfig(parseBotConfig({ ...cfg, signals: { ...cfg.signals, keySource: "keystore" } }));
  console.log(pc.green(`${botId}: signals key stored and pinned to this bot's keystore`));
  console.log(pc.dim(`run \`cassie deploy ${botId}\` to install it on the droplet`));
}

// packages/cli/src/commands/reporting.ts
// Per-bot trade attribution and publishing configuration. Builder attribution
// is public config; the authoring API key remains in .local.env or the keystore.

import pc from "picocolors";
import { KeyRoles, parseBotConfig } from "@quotient-forecasting/cassie-core";
import { ask, getPassphrase, keystore } from "../context.js";
import { discoverAresBuilderCode, resolveAresApiKey, verifyAresApiKey } from "../ares-config.js";
import { loadBotConfig, saveBotConfig } from "../paths.js";

export interface ReportingOpts {
  off?: boolean;
  post?: boolean;
}

export async function configureReporting(botId: string, opts: ReportingOpts): Promise<void> {
  const cfg = loadBotConfig(botId);
  if (opts.off) {
    saveBotConfig(parseBotConfig({ ...cfg, reporting: undefined }));
    console.log(pc.green(`Ares reporting and builder attribution disabled for ${botId}`));
    return;
  }
  if (cfg.venue !== "polymarket") throw new Error("Ares position cards are supported only for Polymarket bots");

  const discoveredBuilder = discoverAresBuilderCode();
  const builderCode =
    discoveredBuilder?.value ??
    cfg.reporting?.builderCode ??
    (await ask("Ares builder code (0x + 64 hex)")).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(builderCode)) {
    throw new Error("Ares builder code must be 0x followed by 64 hex characters");
  }
  if (discoveredBuilder) console.log(pc.dim(`Ares builder code: ${discoveredBuilder.origin}`));

  let resolvedKey = await resolveAresApiKey(botId);
  if (!resolvedKey) {
    const apiKey = (await ask("Ares API key", { secret: true })).trim();
    if (!apiKey) throw new Error("Ares posting was enabled without an API key");
    keystore().putEntry(botId, KeyRoles.aresApiKey, apiKey, await getPassphrase(), { runtimeEligible: true });
    resolvedKey = { value: apiKey, origin: `bot ${botId} keystore entry ${KeyRoles.aresApiKey}` };
  }
  console.log(pc.dim(`Ares authoring key: ${resolvedKey.origin}`));
  const username = await verifyAresApiKey(resolvedKey.value, cfg.reporting?.baseUrl);

  const updated = parseBotConfig({
    ...cfg,
    reporting: {
      provider: "ares",
      builderCode,
      post: opts.post !== false,
      postOn: cfg.reporting?.postOn ?? ["entry", "exit"],
      baseUrl: cfg.reporting?.baseUrl ?? "https://api.ares.pro",
    },
  });
  saveBotConfig(updated);
  console.log(
    pc.green(
      `${botId}: Ares builder attribution enabled; position posting ${updated.reporting?.post ? "enabled" : "disabled"} as @${username}`,
    ),
  );
}

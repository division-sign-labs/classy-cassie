// packages/cli/src/surplus-config.ts
// Resolve and verify the Surplus Intelligence API key (the agent strategy's
// LLM credential). Mirrors ares-config.ts: origin strings name the winning
// source and never contain key material.

import { KeyRoles, SurplusClient } from "@quotient-forecasting/cassie-core";
import { getKeystoreSecret } from "./context.js";
import { resolveLocalValue } from "./local-env.js";

export interface ResolvedSurplusKey {
  value: string;
  origin: string;
}

export function discoverSurplusApiKey(startDir = process.cwd()): ResolvedSurplusKey | null {
  const found = resolveLocalValue(["SURPLUS_API_KEY"], startDir);
  return found ? { value: found.value, origin: found.origin } : null;
}

export async function resolveSurplusApiKey(botId: string): Promise<ResolvedSurplusKey | null> {
  const direct = discoverSurplusApiKey();
  if (direct) return direct;
  const stored = await getKeystoreSecret(botId, KeyRoles.surplusApiKey);
  return stored ? { value: stored, origin: `bot ${botId} keystore entry ${KeyRoles.surplusApiKey}` } : null;
}

/** Read-only trust-boundary check: a model-list read on the standard route. */
export async function verifySurplusApiKey(apiKey: string, opts: { baseUrl?: string; fallbackBaseUrl?: string } = {}): Promise<void> {
  await new SurplusClient({ apiKey, baseUrl: opts.baseUrl, fallbackBaseUrl: opts.fallbackBaseUrl }).verify();
}

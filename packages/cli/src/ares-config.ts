// packages/cli/src/ares-config.ts
// Resolve the two independent Ares settings: a public builder attribution code
// stored in bot config, and a secret authoring key supplied only to runtimes.

import { AresClient, KeyRoles } from "@quotient/cassie-core";
import { getKeystoreSecret } from "./context.js";
import { resolveLocalValue, type ResolvedLocalValue } from "./local-env.js";

export interface ResolvedAresValue {
  value: string;
  origin: string;
}

export function discoverAresBuilderCode(startDir = process.cwd()): ResolvedAresValue | null {
  const found = resolveLocalValue(["ARES_BUILDER_CODE"], startDir);
  if (!found) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(found.value)) {
    throw new Error(`invalid ARES_BUILDER_CODE from ${found.origin}: expected 0x followed by 64 hex characters`);
  }
  return { value: found.value, origin: found.origin };
}

function asAresValue(found: ResolvedLocalValue | null): ResolvedAresValue | null {
  return found ? { value: found.value, origin: found.origin } : null;
}

export function discoverAresApiKey(startDir = process.cwd()): ResolvedAresValue | null {
  return asAresValue(resolveLocalValue(["ARES_API_KEY"], startDir));
}

export async function resolveAresApiKey(botId: string): Promise<ResolvedAresValue | null> {
  const direct = discoverAresApiKey();
  if (direct) return direct;
  const stored = await getKeystoreSecret(botId, KeyRoles.aresApiKey);
  return stored ? { value: stored, origin: `bot ${botId} keystore entry ${KeyRoles.aresApiKey}` } : null;
}

/** Read-only trust-boundary check; returns only the bound username. */
export async function verifyAresApiKey(apiKey: string, baseUrl?: string): Promise<string> {
  const me = await new AresClient({ apiKey, baseUrl }).me();
  if (!me.username) throw new Error("Ares /me returned no username");
  return me.username;
}

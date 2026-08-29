// packages/cli/src/commands/passphrase.ts
// Native credential-store management for the local keystore passphrase.

import { ask, clearCachedPassphrase, keystore } from "../context.js";
import { systemPassphraseStore } from "../passphrase-store.js";

export async function rememberPassphrase(botId: string): Promise<void> {
  const ks = keystore();
  if (!ks.exists(botId)) throw new Error(`no keystore for bot "${botId}"`);
  if (!(await systemPassphraseStore.isAvailable(botId))) {
    throw new Error(`${systemPassphraseStore.label()} is unavailable`);
  }
  const passphrase = await ask("Keystore passphrase", { secret: true });
  if (!passphrase) throw new Error("keystore passphrase is required");
  ks.verifyPassphrase(botId, passphrase);
  await systemPassphraseStore.set(botId, passphrase);
  console.log(`Saved the ${botId} passphrase in ${systemPassphraseStore.label()}.`);
}

export async function forgetPassphrase(botId: string): Promise<void> {
  if (!(await systemPassphraseStore.isAvailable(botId))) {
    throw new Error(`${systemPassphraseStore.label()} is unavailable`);
  }
  const deleted = await systemPassphraseStore.delete(botId);
  clearCachedPassphrase(botId);
  console.log(deleted ? `Removed the saved ${botId} passphrase.` : `No passphrase is saved for ${botId}.`);
}

export async function passphraseStatus(botId: string): Promise<void> {
  if (!(await systemPassphraseStore.isAvailable(botId))) {
    console.log(`${systemPassphraseStore.label()}: unavailable`);
    return;
  }
  const saved = (await systemPassphraseStore.get(botId)) !== undefined;
  console.log(`${systemPassphraseStore.label()}: ${saved ? `saved for ${botId}` : `no passphrase saved for ${botId}`}`);
}

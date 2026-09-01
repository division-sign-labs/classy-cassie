// packages/cli/src/commands/passphrase.ts
// Native credential-store management for the local keystore passphrase.

import { ask, clearCachedPassphrase, getPassphrase, keystore } from "../context.js";
import { resolveLocalValue } from "../local-env.js";
import { systemPassphraseStore } from "../passphrase-store.js";

export async function changePassphrase(botId: string): Promise<void> {
  const ks = keystore();
  if (!ks.exists(botId)) throw new Error(`no keystore for bot "${botId}"`);

  // Capture only the human-readable origin: the override value must never be
  // echoed, logged, or accepted on argv.
  const explicitOverrideOrigin = resolveLocalValue(["CASSIE_PASSPHRASE"])?.origin;

  const currentPassphrase = await getPassphrase(botId);

  // getPassphrase may have just offered to remember a manually entered
  // current passphrase. Check afterwards so that newly accepted entry is not
  // left stale when the keystore rotates below.
  let savedPassphraseExists = false;
  let savedPassphraseReadError: Error | undefined;
  if (systemPassphraseStore.isSupported()) {
    try {
      savedPassphraseExists = (await systemPassphraseStore.get(botId)) !== undefined;
    } catch (error) {
      savedPassphraseReadError = error as Error;
    }
  }

  const newPassphrase = await ask("New keystore passphrase", { secret: true });
  const confirmation = await ask("Confirm new keystore passphrase", { secret: true });

  if (newPassphrase.trim().length === 0) throw new Error("new keystore passphrase is required");
  if (confirmation !== newPassphrase) throw new Error("new keystore passphrases do not match");
  if (newPassphrase === currentPassphrase) {
    throw new Error("new keystore passphrase must differ from the current passphrase");
  }

  ks.changePassphrase(botId, currentPassphrase, newPassphrase);
  clearCachedPassphrase(botId);
  console.log(`Changed the keystore passphrase for bot "${botId}".`);

  if (savedPassphraseExists) {
    try {
      await systemPassphraseStore.set(botId, newPassphrase);
      console.log(`Updated the saved passphrase in ${systemPassphraseStore.label()}.`);
    } catch (error) {
      console.error(
        `Warning: the keystore passphrase was changed, but the saved ${systemPassphraseStore.label()} entry ` +
          `could not be updated: ${(error as Error).message}. ` +
          `Run \`cassie passphrase remember ${botId}\` to repair it.`,
      );
    }
  } else if (savedPassphraseReadError) {
    console.error(
      `Warning: the keystore passphrase was changed, but Cassie could not check ${systemPassphraseStore.label()} ` +
        `for an existing saved entry: ${savedPassphraseReadError.message}. ` +
        `Run \`cassie passphrase remember ${botId}\` if this bot should have a saved passphrase.`,
    );
  }

  if (explicitOverrideOrigin) {
    console.error(
      `Warning: CASSIE_PASSPHRASE is still supplied by ${explicitOverrideOrigin}. ` +
        "Update or remove that override before the next local keystore command.",
    );
  }

  console.log("Running deployments are unaffected; they use already-deployed runtime credentials, not this local passphrase.");
}

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

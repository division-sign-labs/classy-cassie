// packages/cli/src/commands/wallet.ts
// Wallet commands (§4): create / import (stdin only) / export (guarded) / list.

import pc from "picocolors";
import { addressFromPk, generateEoa, KeyRoles } from "@quotient-forecasting/cassie-core";
import { ask, confirm, getPassphrase, keystore } from "../context.js";

export async function walletCreate(botId: string): Promise<void> {
  const ks = keystore();
  if (ks.entryMeta(botId, KeyRoles.master)) {
    console.error(pc.red(`bot "${botId}" already has a master key — refusing to overwrite`));
    process.exit(1);
  }
  const pass = await getPassphrase(true);
  if (ks.exists(botId)) ks.verifyPassphrase(botId, pass);
  const eoa = generateEoa();
  ks.putEntry(botId, KeyRoles.master, eoa.privateKey, pass, { address: eoa.address, runtimeEligible: false });
  console.log(`created master key for ${pc.bold(botId)}`);
  console.log(`address: ${pc.green(eoa.address)}`);
  console.log(pc.dim(`stored encrypted at ~/.cassie/keys/${botId}.json`));
}

/** Import via stdin, so keys stay out of shell history. */
export async function walletImport(botId: string): Promise<void> {
  const ks = keystore();
  if (ks.entryMeta(botId, KeyRoles.master)) {
    console.error(pc.red(`bot "${botId}" already has a master key — refusing to overwrite`));
    process.exit(1);
  }
  let pk: string;
  if (process.stdin.isTTY) {
    pk = (await ask("Paste private key (input hidden)", { secret: true })).trim();
  } else {
    pk = (await readStdin()).trim();
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    console.error(pc.red("that does not look like a 32-byte hex private key (0x…64 hex chars)"));
    process.exit(1);
  }
  const address = addressFromPk(pk);
  const pass = await getPassphrase(true);
  if (ks.exists(botId)) ks.verifyPassphrase(botId, pass);
  ks.putEntry(botId, KeyRoles.master, pk, pass, { address, runtimeEligible: false });
  console.log(`imported master key for ${pc.bold(botId)} — address ${pc.green(address)}`);
}

export async function walletExport(botId: string, opts: { yesPrintMyKey?: boolean }): Promise<void> {
  if (!opts.yesPrintMyKey) {
    console.error(pc.red("refusing to print a private key without --yes-print-my-key"));
    process.exit(1);
  }
  const ok = await confirm(pc.yellow("This prints the RAW PRIVATE KEY to this terminal. Continue?"), false);
  if (!ok) process.exit(1);
  const pass = await getPassphrase();
  const pk = keystore().getEntry(botId, KeyRoles.master, pass);
  if (!pk) {
    console.error(pc.red(`no master key for bot "${botId}"`));
    process.exit(1);
  }
  process.stdout.write(pk + "\n");
}

export async function walletList(): Promise<void> {
  const entries = keystore().list();
  if (entries.length === 0) {
    console.log("no keys yet — `cassie wallet create <botId>` or `cassie init`");
    return;
  }
  for (const bot of entries) {
    console.log(pc.bold(bot.botId));
    for (const e of bot.entries) {
      const flag = e.runtimeEligible ? pc.yellow("runtime-eligible") : pc.dim("local-only");
      console.log(`  ${e.name.padEnd(16)} ${e.address ?? "".padEnd(42)} ${flag}`);
    }
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

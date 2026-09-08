// packages/cli/src/commands/wallet.ts
// Wallet commands (§4): create / import (stdin only) / export (guarded) / list.

import pc from "picocolors";
import { addressFromPk, generateEoa, KeyRoles } from "@quotient-forecasting/cassie-core";
import { ask, confirm, getPassphrase, keystore } from "../context.js";

export async function walletCreate(botId: string): Promise<void> {
  const ks = keystore();
  if (ks.entryMeta(botId, KeyRoles.master)) {
    console.error(pc.red(`bot "${botId}" already has a master key`));
    process.exit(1);
  }
  const pass = await getPassphrase(botId, true);
  if (ks.exists(botId)) ks.verifyPassphrase(botId, pass);
  const eoa = generateEoa();
  ks.putEntry(botId, KeyRoles.master, eoa.privateKey, pass, { address: eoa.address, runtimeEligible: false });
  console.log(`Wallet created: ${botId}`);
  console.log(eoa.address);
}

/** Import via stdin, so keys stay out of shell history. */
export async function walletImport(botId: string): Promise<void> {
  const ks = keystore();
  if (ks.entryMeta(botId, KeyRoles.master)) {
    console.error(pc.red(`bot "${botId}" already has a master key`));
    process.exit(1);
  }
  let pk: string;
  if (process.stdin.isTTY) {
    pk = (await ask("Private key", { secret: true })).trim();
  } else {
    pk = (await readStdin()).trim();
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    console.error(pc.red("private key must be 0x followed by 64 hex characters"));
    process.exit(1);
  }
  const address = addressFromPk(pk);
  const pass = await getPassphrase(botId, true);
  if (ks.exists(botId)) ks.verifyPassphrase(botId, pass);
  ks.putEntry(botId, KeyRoles.master, pk, pass, { address, runtimeEligible: false });
  console.log(`Wallet imported: ${botId}`);
  console.log(address);
}

export async function walletExport(botId: string, opts: { yesPrintMyKey?: boolean }): Promise<void> {
  if (!opts.yesPrintMyKey) {
    console.error(pc.red("private-key export requires --yes-print-my-key"));
    process.exit(1);
  }
  const ok = await confirm(pc.yellow("Print the raw private key in this terminal?"), false);
  if (!ok) process.exit(1);
  const pass = await getPassphrase(botId);
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
    console.log("No wallets.");
    console.log("cassie wallet create <botId>");
    return;
  }
  for (const bot of entries) {
    console.log(pc.bold(bot.botId));
    for (const e of bot.entries) {
      const flag = e.runtimeEligible ? "runtime-eligible" : "local-only";
      console.log(`  ${e.name} · ${flag}`);
      if (e.address) console.log(e.address);
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

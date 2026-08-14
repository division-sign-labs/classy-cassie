// packages/cli/src/commands/withdraw.ts
// `cassie withdraw <botId> <amount|all> --to <address>` — send collateral back
// out of a venue. Signs with the master/L1 key from the local keystore, so it
// runs on the machine that holds it; deployed bots cannot withdraw remotely.

import pc from "picocolors";
import { adapterFor, confirm, makeSetupContext, requireAccount } from "../context.js";
import { loadBotConfig } from "../paths.js";

export async function runWithdraw(botId: string, amountArg: string, opts: { to?: string; yes?: boolean }): Promise<void> {
  const cfg = loadBotConfig(botId);
  const account = requireAccount(cfg);
  if (!opts.to || !/^0x[0-9a-fA-F]{40}$/.test(opts.to)) {
    throw new Error("--to <address> required (0x… EVM address)");
  }
  const amount = amountArg.toLowerCase() === "all" ? ("all" as const) : Number(amountArg);
  if (amount !== "all" && !(amount > 0)) throw new Error("amount must be a positive number or 'all'");

  const adapter = await adapterFor(cfg, { needCreds: false });
  if (!adapter.withdraw) {
    throw new Error(
      cfg.venue === "lighter"
        ? "lighter withdrawals are not wired in the MVP — use the Lighter app with your L1 wallet"
        : `withdraw is not supported on the ${cfg.venue} venue`,
    );
  }

  const destChain = cfg.venue === "hyperliquid" ? "Arbitrum" : cfg.venue === "polymarket" ? "Polygon (pUSD)" : cfg.venue;
  console.log(pc.bold("withdrawal:"));
  console.log(`  bot:     ${botId} (${cfg.venue})`);
  console.log(`  amount:  ${amount === "all" ? "entire balance" : amount}`);
  console.log(`  to:      ${opts.to} on ${destChain}`);
  if (!opts.yes && !(await confirm("send it?", false))) return;

  const receipt = await adapter.withdraw(makeSetupContext(botId), account, { to: opts.to, amount });
  console.log(pc.green(receipt));
}

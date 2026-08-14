// packages/cli/src/commands/fund.ts
// `cassie fund <botId> [--from splits]` (§4, §6): venue-owned funding flow;
// the Splits path prints exact splits-cli invocations, then keeps polling.

import pc from "picocolors";
import { splitsDisburseCommands, splitsRegisterSignerCommands } from "@quotient-forecasting/cassie-core";
import { adapterFor, ask, makeSetupContext, requireAccount } from "../context.js";
import { loadBotConfig, saveBotConfig } from "../paths.js";

const SPLITS_CHAIN_BY_VENUE: Record<string, string> = {
  polymarket: "polygon", // or any bridge-supported chain; polygon is the direct path
  hyperliquid: "arbitrum",
  lighter: "arbitrum",
};

export async function runFund(botId: string, opts: { from?: string }): Promise<void> {
  const cfg = loadBotConfig(botId);
  const account = requireAccount(cfg);
  const adapter = await adapterFor(cfg, { needCreds: false });
  const ctx = makeSetupContext(botId);

  if (opts.from === "splits") {
    const instructions = await adapter.fundingInstructions(account);
    const target =
      instructions.addresses.find((a) => a.chain === "evm" || a.chain === "arbitrum") ?? instructions.addresses[0];
    if (!target) throw new Error("no funding address available");
    const amount = await ask(`Amount of ${target.asset} to disburse (min ${target.minimum})`, { default: "20" });
    console.log(pc.bold("\nRun these with your Splits signer set (cassie never touches Splits auth):\n"));
    for (const line of splitsDisburseCommands({
      to: target.address,
      chain: SPLITS_CHAIN_BY_VENUE[cfg.venue] ?? "polygon",
      asset: target.asset,
      amount,
    })) {
      console.log("  " + line);
    }
    console.log("");
  }

  if (adapter.runFundingFlow) {
    const updated = await adapter.runFundingFlow(ctx, account);
    saveBotConfig({ ...cfg, account: updated });
  } else {
    const instructions = await adapter.fundingInstructions(account);
    console.log(instructions.summary);
    for (const a of instructions.addresses) {
      console.log(`  [${a.chain}] ${a.address}  (${a.asset}, min ${a.minimum})${a.note ? "  — " + a.note : ""}`);
    }
    const bal = await adapter.awaitFunding(account, { onPoll: (m) => console.log(pc.dim(m)) });
    console.log(pc.green(`credited: ${bal.total} ${bal.asset}`));
  }
  console.log(pc.green(`funding flow complete for ${botId}`));
}

export async function registerSplitsSigner(botId: string): Promise<void> {
  const cfg = loadBotConfig(botId);
  const account = requireAccount(cfg);
  const addr =
    account.venue === "polymarket"
      ? account.signerAddress
      : account.venue === "hyperliquid"
        ? account.masterAddress
        : account.venue === "lighter"
          ? account.l1Address
          : "0x";
  console.log(pc.bold("To attach this bot's EOA as a signer on a Splits subaccount:\n"));
  for (const line of splitsRegisterSignerCommands(addr)) console.log("  " + line);
}

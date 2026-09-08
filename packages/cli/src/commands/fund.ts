// packages/cli/src/commands/fund.ts
// `cassie fund <botId> [--from splits]` (§4, §6): venue-owned funding flow.
// The Splits path creates no transaction implicitly; it prints an exact
// proposal command for the operator's authenticated organization.

import pc from "picocolors";
import { parseBotConfig, splitsTransferProposalCommand } from "@quotient-forecasting/cassie-core";
import { adapterFor, ask, makeSetupContext, requireAccount } from "../context.js";
import { loadBotConfig, saveBotConfig } from "../paths.js";

const ARBITRUM_CHAIN_ID = 42161;
const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

export async function runFund(botId: string, opts: { from?: string }): Promise<void> {
  if (opts.from !== undefined && opts.from !== "splits") {
    throw new Error(`unsupported treasury source ${JSON.stringify(opts.from)}; expected "splits"`);
  }
  const cfg = loadBotConfig(botId);
  const account = requireAccount(cfg);
  // Kalshi balance reads are authenticated, so its funding poll needs creds;
  // every other venue's funding flow is read-only or keystore-driven.
  const adapter = await adapterFor(cfg, { needCreds: cfg.venue === "kalshi" });
  const ctx = makeSetupContext(botId);

  if (opts.from === "splits") {
    if (cfg.venue === "kalshi") {
      throw new Error(
        "Splits cannot fund Kalshi. Use ACH, debit, or wire.\nhttps://kalshi.com",
      );
    }
    if (!cfg.treasury) {
      throw new Error(`bot "${botId}" has no Splits treasury\nCreate a Splits subaccount:\ncassie init`);
    }
    if (cfg.venue === "lighter") {
      throw new Error(
        "Splits funding is manual for Lighter.\nUse this sending address:\n" +
          `${cfg.treasury.accountAddress}\nRequest a deposit address:\ncassie fund ${botId}\n` +
          "Create the Splits transfer to that deposit address on the same chain and token.",
      );
    }
    if (cfg.venue === "polymarket") {
      throw new Error(
        `Splits funding requires manual Polymarket route validation.\nCheck supported chains, tokens, and minimums:\ncassie fund ${botId}\nCreate a matching Splits proposal.`,
      );
    }
    if (cfg.venue === "hyperliquid" && cfg.venueUrls.hyperliquid.testnet) {
      throw new Error(
        `Splits funding is disabled on Hyperliquid testnet.\nDo not send mainnet assets.\nUse testnet funding:\ncassie fund ${botId}`,
      );
    }
    if (cfg.treasury.threshold > 1) {
      throw new Error(
        "Multiple Splits signatures required. Create the proposal and collect signatures in Splits.",
      );
    }
    const instructions = await adapter.fundingInstructions(account);
    const target =
      instructions.addresses.find((a) => a.chain === "evm" || a.chain === "arbitrum") ?? instructions.addresses[0];
    if (!target) throw new Error("no funding address available");
    const amount = await ask(`Amount (${target.asset}, minimum ${target.minimum})`, { default: "20" });
    if (!Number.isFinite(Number(amount)) || Number(amount) < target.minimum) {
      throw new Error(`amount must be at least ${target.minimum} ${target.asset}`);
    }
    const chainId = ARBITRUM_CHAIN_ID;
    const token = USDC_ARBITRUM;
    console.log("Arbitrum One · native USDC");
    const command = splitsTransferProposalCommand({
      account: cfg.treasury.accountAddress,
      recipient: target.address,
      chainId,
      token,
      amount: amount.trim(),
    });
    console.log("Splits proposal");
    console.log(command);
    console.log("Approve the proposal at the returned signUrl with your passkey.");
    await ask("Press Enter after the transfer completes");
  }

  if (adapter.runFundingFlow) {
    const updated = await adapter.runFundingFlow(ctx, account);
    saveBotConfig(parseBotConfig({ ...cfg, account: updated }));
  } else {
    const instructions = await adapter.fundingInstructions(account);
    console.log(instructions.summary);
    for (const a of instructions.addresses) {
      console.log(`${a.chain} · ${a.asset} · minimum ${a.minimum}`);
      console.log(a.address);
      if (a.note) console.log(a.note);
    }
    const bal = await adapter.awaitFunding(account, { onPoll: (m) => console.log(pc.dim(m)) });
    console.log(pc.green(`credited: ${bal.total} ${bal.asset}`));
  }
}

export async function registerSplitsSigner(botId: string): Promise<void> {
  const cfg = loadBotConfig(botId);
  const account = requireAccount(cfg);
  if (account.venue === "kalshi") {
    throw new Error("Kalshi bots have no on-chain signer.");
  }
  const addr =
    account.venue === "polymarket"
      ? account.signerAddress
      : account.venue === "hyperliquid"
        ? account.masterAddress
        : account.venue === "lighter"
          ? account.l1Address
          : "0x";
  console.log("Register signer");
  console.log(`splits auth register-signer ${addr} --name cassie-${botId}`);
  console.log("Registration grants no account authority.");
  console.log("Create a subaccount:");
  console.log("cassie init");
  if (cfg.venue === "polymarket") {
    console.log(pc.yellow("Do not authorize this Polymarket signer in Splits; its private key runs on the bot."));
  }
}

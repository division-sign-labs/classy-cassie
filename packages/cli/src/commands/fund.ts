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
  const adapter = await adapterFor(cfg, { needCreds: false });
  const ctx = makeSetupContext(botId);

  if (opts.from === "splits") {
    if (!cfg.treasury) {
      throw new Error(`bot "${botId}" has no Splits treasury — run \`cassie init\` and choose the Splits subaccount option`);
    }
    if (cfg.venue === "lighter") {
      throw new Error(
        "Lighter intent addresses are bound to the sending address. `--from splits` is not automated: run `cassie fund`, choose the source chain, enter this Splits account as the sending address — " +
          `${cfg.treasury.accountAddress} — then create the Splits transfer on that same chain/token to the returned intent address.`,
      );
    }
    if (cfg.venue === "polymarket") {
      throw new Error(
        "Polymarket bridge routes and minimums vary by source chain/token. `--from splits` is disabled until Cassie can validate a proposal against the live supported-assets route; use `cassie fund` for the current bridge instructions and create the Splits proposal manually.",
      );
    }
    if (cfg.venue === "hyperliquid" && cfg.venueUrls.hyperliquid.testnet) {
      throw new Error(
        "`--from splits` is disabled for Hyperliquid testnet; use the configured testnet faucet through `cassie fund` instead of sending mainnet assets.",
      );
    }
    if (cfg.treasury.threshold > 1) {
      throw new Error(
        "This Splits account requires multiple signatures, but Cassie does not yet provide a safe local Splits signing step. Lower the account threshold in Splits or create the proposal and collect every signature manually.",
      );
    }
    const instructions = await adapter.fundingInstructions(account);
    const target =
      instructions.addresses.find((a) => a.chain === "evm" || a.chain === "arbitrum") ?? instructions.addresses[0];
    if (!target) throw new Error("no funding address available");
    const amount = await ask(`Amount of ${target.asset} to disburse (min ${target.minimum})`, { default: "20" });
    if (!Number.isFinite(Number(amount)) || Number(amount) < target.minimum) {
      throw new Error(`amount must be at least ${target.minimum} ${target.asset}`);
    }
    const chainId = ARBITRUM_CHAIN_ID;
    const token = USDC_ARBITRUM;
    console.log(pc.dim(`using Arbitrum One (${chainId}) native USDC ${token}; Hyperliquid's bridge sender is chain-bound`));
    const command = splitsTransferProposalCommand({
      account: cfg.treasury.accountAddress,
      recipient: target.address,
      chainId,
      token,
      amount: amount.trim(),
    });
    console.log(pc.bold("\nCreate this proposal with the official Splits CLI:\n"));
    console.log(`  ${command}`);
    console.log(pc.dim("\nThis proposes a transfer; it does not bypass your account threshold."));
    console.log(pc.dim("Approve the returned signUrl with your passkey, then come back here."));
    if (cfg.venue === "hyperliquid") {
      console.log(pc.yellow(`Also send about $2 of ETH on Arbitrum to ${target.address} for the bridge transaction's gas.`));
    }
    await ask("Press Enter after the Splits proposal has executed");
  }

  if (adapter.runFundingFlow) {
    const updated = await adapter.runFundingFlow(ctx, account);
    saveBotConfig(parseBotConfig({ ...cfg, account: updated }));
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
  console.log(pc.bold("Register this EOA with the currently authenticated Splits user:\n"));
  console.log(`  splits auth register-signer ${addr} --name cassie-${botId}`);
  console.log("");
  console.log(pc.yellow("Registration alone grants no account authority."));
  console.log(pc.dim("Run `cassie init` to create an isolated organization subaccount with an explicit signer set."));
  if (cfg.venue === "polymarket") {
    console.log(pc.yellow("Do not attach this Polymarket signer to Splits: its raw key is deployed with the trading runtime."));
  }
}

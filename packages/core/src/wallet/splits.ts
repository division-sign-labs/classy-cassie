// packages/core/src/wallet/splits.ts
// Thin Splits (splits.org) treasury integration (§4): cassie never touches
// Splits auth; it prints exact `splits` CLI invocations for the operator to
// copy-paste and sign through their own signer set.

export interface SplitsTransferParams {
  /** Destination address (venue funding target from fundingInstructions). */
  to: string;
  /** Chain name as splits-cli expects it, e.g. "polygon", "arbitrum", "base". */
  chain: string;
  asset: string;
  amount: string;
}

export function splitsDisburseCommands(p: SplitsTransferParams): string[] {
  return [
    `# Disburse ${p.amount} ${p.asset} on ${p.chain} from your Splits subaccount:`,
    `splits transfer --chain ${p.chain} --asset ${p.asset} --amount ${p.amount} --to ${p.to}`,
    `# splits-cli owns its own auth (SPLITS_API_KEY / splits auth login); cassie never sees it.`,
  ];
}

export function splitsRegisterSignerCommands(botAddress: string): string[] {
  return [
    `# Attach the bot EOA as a signer on a Splits subaccount:`,
    `splits auth register-signer ${botAddress}`,
    `splits accounts update-signers  # then follow the interactive flow to add ${botAddress}`,
  ];
}

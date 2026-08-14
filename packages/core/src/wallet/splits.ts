// packages/core/src/wallet/splits.ts
// Thin Splits (splits.org) command rendering for operator-approved treasury
// transfers. Authentication remains owned by the official Splits CLI.

export interface SplitsTransferParams {
  /** Organization-owned Splits smart-account address. */
  account: string;
  /** Destination address (venue funding target from fundingInstructions). */
  recipient: string;
  /** Numeric EVM chain id. */
  chainId: number;
  /** ERC-20 contract address on chainId (symbols are not accepted). */
  token: string;
  /** Decimal amount in human-readable token units. */
  amount: string;
}

function evmAddress(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label}: expected a 20-byte EVM address`);
  return value;
}

/** Exact official @splits/splits-cli v0.2.11 proposal command. */
export function splitsTransferProposalArgs(p: SplitsTransferParams): string[] {
  if (!Number.isSafeInteger(p.chainId) || p.chainId <= 0) throw new Error("chainId must be a positive integer");
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(p.amount) || Number(p.amount) <= 0) {
    throw new Error("amount must be a positive decimal without exponent notation");
  }
  return [
    "transactions",
    "create",
    "transfer",
    "--account",
    evmAddress(p.account, "account"),
    "--chain-id",
    String(p.chainId),
    "--recipient",
    evmAddress(p.recipient, "recipient"),
    "--token",
    evmAddress(p.token, "token"),
    "--amount",
    p.amount,
  ];
}

export function splitsTransferProposalCommand(p: SplitsTransferParams): string {
  return `splits ${splitsTransferProposalArgs(p).join(" ")}`;
}

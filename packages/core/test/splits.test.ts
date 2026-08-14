// packages/core/test/splits.test.ts

import { describe, expect, it } from "vitest";
import { splitsTransferProposalArgs, splitsTransferProposalCommand } from "@quotient-forecasting/cassie-core";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";

describe("Splits transfer proposals", () => {
  it("renders the exact transactions create transfer command", () => {
    const params = { account: ACCOUNT, recipient: RECIPIENT, token: TOKEN, chainId: 42161, amount: "20.5" };
    expect(splitsTransferProposalArgs(params)).toEqual([
      "transactions",
      "create",
      "transfer",
      "--account",
      ACCOUNT,
      "--chain-id",
      "42161",
      "--recipient",
      RECIPIENT,
      "--token",
      TOKEN,
      "--amount",
      "20.5",
    ]);
    expect(splitsTransferProposalCommand(params)).toBe(
      `splits transactions create transfer --account ${ACCOUNT} --chain-id 42161 --recipient ${RECIPIENT} --token ${TOKEN} --amount 20.5`,
    );
  });

  it("fails closed on values that would be invalid or unsafe to paste", () => {
    const valid = { account: ACCOUNT, recipient: RECIPIENT, token: TOKEN, chainId: 42161, amount: "20" };
    expect(() => splitsTransferProposalArgs({ ...valid, account: "$(bad)" })).toThrow(/account/);
    expect(() => splitsTransferProposalArgs({ ...valid, token: "USDC" })).toThrow(/token/);
    expect(() => splitsTransferProposalArgs({ ...valid, chainId: 0 })).toThrow(/chainId/);
    expect(() => splitsTransferProposalArgs({ ...valid, amount: "1e3" })).toThrow(/amount/);
    expect(() => splitsTransferProposalArgs({ ...valid, amount: "0" })).toThrow(/amount/);
  });
});

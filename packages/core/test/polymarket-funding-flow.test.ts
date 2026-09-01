// packages/core/test/polymarket-funding-flow.test.ts
// Polymarket top-ups start polling even when collateral already exists, allow
// an interactive skip, and distinguish the credited delta from total balance.

import { describe, expect, it, vi } from "vitest";
import {
  PolymarketAdapter,
  VenueUrlsSchema,
  type SetupContext,
  type VenueAccount,
} from "@quotient-forecasting/cassie-core";

const account: VenueAccount = {
  venue: "polymarket",
  signerAddress: "0x1000000000000000000000000000000000000001",
  funder: "0x2000000000000000000000000000000000000002",
  signatureType: 3,
};

type FundingInternals = {
  ensureCredsFromKeystore: (ctx: SetupContext, acct: VenueAccount) => Promise<void>;
  collateralBalance: () => Promise<number>;
  requestBridgeAddresses: (funder: string) => Promise<Record<string, string>>;
  bridgeMinimum: () => Promise<number>;
  gaslessClient: (ctx: SetupContext, acct: VenueAccount) => Promise<unknown>;
  ensureTradingApprovals: (ctx: SetupContext, client: unknown) => Promise<void>;
};

function fundingHarness(balances: number[]) {
  const adapter = new PolymarketAdapter({ urls: VenueUrlsSchema.parse({}) });
  const inner = adapter as unknown as FundingInternals;
  const remaining = [...balances];
  const collateralBalance = vi.fn(async () => {
    const balance = remaining.shift();
    if (balance === undefined) throw new Error("test exhausted collateral balance samples");
    return balance;
  });
  const ensureTradingApprovals = vi.fn(async () => {});

  inner.ensureCredsFromKeystore = vi.fn(async () => {});
  inner.collateralBalance = collateralBalance;
  inner.requestBridgeAddresses = vi.fn(async () => ({
    evm: "0x3000000000000000000000000000000000000003",
  }));
  inner.bridgeMinimum = vi.fn(async () => 2);
  inner.gaslessClient = vi.fn(async () => ({}));
  inner.ensureTradingApprovals = ensureTradingApprovals;

  return { adapter, collateralBalance, ensureTradingApprovals };
}

function setupContext(
  pollSkippable: (waitingMsg: string, check: () => Promise<number | null>) => Promise<number | null>,
) {
  const printed: string[] = [];
  const confirm = vi.fn(async () => true);
  const skippable = vi.fn(pollSkippable);
  const ctx = {
    botId: "funding-test",
    ask: vi.fn(async () => ""),
    confirm,
    print: (message: string) => printed.push(message),
    poll: vi.fn(async (_waitingMsg: string, check: () => Promise<number | null>) => {
      const result = await check();
      if (result === null) throw new Error("test fallback poll did not receive a credit");
      return result;
    }),
    pollSkippable: skippable,
    getSecret: vi.fn(async () => null),
    putSecret: vi.fn(async () => {}),
  } as unknown as SetupContext;
  return { ctx, printed, confirm, skippable };
}

describe("Polymarket funding top-ups", () => {
  it("polls an already-funded account and reports credited delta separately from total balance", async () => {
    const { adapter, ensureTradingApprovals } = fundingHarness([145.13, 500.15]);
    const { ctx, printed, confirm, skippable } = setupContext(async (_message, check) => check());

    await expect(adapter.runFundingFlow(ctx, account)).resolves.toMatchObject({
      bridgeAddresses: { evm: "0x3000000000000000000000000000000000000003" },
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(skippable).toHaveBeenCalledTimes(1);
    expect(skippable.mock.calls[0]?.[0]).toBe("waiting for bridge credit");
    expect(printed).toContain("Deposit credited: 355.02 pUSD.");
    expect(printed).toContain("Balance: 500.15 pUSD.");
    expect(ensureTradingApprovals).toHaveBeenCalledTimes(1);
  });

  it("continues to approval verification when polling is skipped without claiming a credit", async () => {
    const { adapter, collateralBalance, ensureTradingApprovals } = fundingHarness([145.13, 145.13]);
    const { ctx, printed, confirm, skippable } = setupContext(async () => null);

    await adapter.runFundingFlow(ctx, account);

    expect(confirm).not.toHaveBeenCalled();
    expect(skippable).toHaveBeenCalledTimes(1);
    expect(collateralBalance).toHaveBeenCalledTimes(2);
    expect(printed.some((line) => line.startsWith("Deposit credited:"))).toBe(false);
    expect(printed).toContain("Deposit polling skipped. Balance: 145.13 pUSD; continuing to trading approvals.");
    expect(ensureTradingApprovals).toHaveBeenCalledTimes(1);
    expect(printed.at(-1)).toBe("Funding flow complete. L2 credentials derived and stored.");
  });
});

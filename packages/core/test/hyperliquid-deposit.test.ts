// packages/core/test/hyperliquid-deposit.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InfoClient } from "@nktkas/hyperliquid";
import { VenueUrlsSchema } from "../src/config.js";
import { HyperliquidAdapter } from "../src/venues/hyperliquid.js";
import type { SetupContext, VenueAccount } from "../src/types.js";

const clients = vi.hoisted(() => ({ public: vi.fn(), wallet: vi.fn(), account: vi.fn() }));
vi.mock("viem", async original => ({
  ...await original<typeof import("viem")>(), createPublicClient: clients.public, createWalletClient: clients.wallet,
}));
vi.mock("viem/accounts", async original => ({
  ...await original<typeof import("viem/accounts")>(), privateKeyToAccount: clients.account,
}));

const USER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";
const TX = `0x${"a".repeat(64)}`;
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const BRIDGE = "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7";
const ACCOUNT: VenueAccount = { venue: "hyperliquid", masterAddress: USER, agentAddress: AGENT };
type Internals = { provisionAgent(ctx: SetupContext, account: VenueAccount): Promise<VenueAccount> };

function fixture() {
  let nativeBalance = 0;
  let afterReceipt: number[] = [20];
  let receiptObserved = false;
  const info = {
    clearinghouseState: vi.fn(async () => {
      if (receiptObserved && afterReceipt.length) nativeBalance = afterReceipt.shift()!;
      return { marginSummary: { accountValue: String(nativeBalance) } };
    }),
    extraAgents: vi.fn(async () => [{ address: USER, name: "cassie-deposit" }]),
  };
  const pub = {
    readContract: vi.fn(async () => 20_000_000n), estimateContractGas: vi.fn(async (_args: Record<string, unknown>) => 100_000n),
    getGasPrice: vi.fn(async () => 100_000_000n), getBalance: vi.fn(async () => 10n ** 18n),
    waitForTransactionReceipt: vi.fn(async () => { receiptObserved = true; return { status: "success" }; }),
  };
  const wallet = { writeContract: vi.fn(async () => TX) };
  clients.public.mockReturnValue(pub); clients.wallet.mockReturnValue(wallet); clients.account.mockReturnValue({ address: USER });
  const adapter = new HyperliquidAdapter({ urls: VenueUrlsSchema.parse({}) }, { info: info as unknown as InfoClient });
  const provisionAgent = vi.spyOn(adapter as unknown as Internals, "provisionAgent").mockResolvedValue(ACCOUNT);
  const print = vi.fn(); const confirm = vi.fn(async () => true); const getSecret = vi.fn(async () => "test-only-secret");
  const poll = vi.fn(async (_message: string, check: () => Promise<unknown>) => {
    for (let attempt = 0; attempt < 8; attempt++) { const result = await check(); if (result !== null) return result; }
    throw new Error("test poll did not reach its condition");
  });
  const ctx = { botId: "deposit", print, confirm, getSecret, putSecret: vi.fn(), poll } as unknown as SetupContext;
  return { adapter, info, pub, wallet, provisionAgent, ctx, print, confirm, getSecret, poll,
    setNative: (value: number) => { nativeBalance = value; }, setCredits: (values: number[]) => { afterReceipt = values; },
    lines: () => print.mock.calls.map(([line]) => String(line)),
  };
}
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("Hyperliquid Arbitrum deposits", () => {
  it("does not fund from a keystore wallet that differs from the bot account", async () => {
    const h = fixture(); clients.account.mockReturnValue({ address: AGENT });
    await expect(h.adapter.runFundingFlow(h.ctx, ACCOUNT)).rejects.toThrow("Funding wallet does not match");
    expect(h.wallet.writeContract).not.toHaveBeenCalled();
  });

  it("keeps deposit instructions free of contract addresses and fixed ETH budgets", async () => {
    const h = fixture(); const instructions = await h.adapter.fundingInstructions(ACCOUNT);
    expect(instructions.summary).toBe("Send at least 5 USDC on Arbitrum.");
    expect(instructions.addresses).toEqual([{ chain: "arbitrum", address: USER, asset: "USDC", minimum: 5, note: "Deposits under 5 USDC are lost." }]);
    expect(JSON.stringify(instructions)).not.toMatch(new RegExp(`${USDC}|${BRIDGE}|\\$2|ETH`));
  });

  it("uses existing ETH without another top-up prompt and signs only after confirmation", async () => {
    const h = fixture(); await h.adapter.runFundingFlow(h.ctx, ACCOUNT);
    expect(h.lines().some(line => /^Add .*ETH/.test(line))).toBe(false);
    expect(h.wallet.writeContract).toHaveBeenCalledOnce();
    expect(h.wallet.writeContract).toHaveBeenCalledWith(expect.objectContaining({ address: USDC, functionName: "transfer", args: [BRIDGE, 20_000_000n], gas: 120_000n, gasPrice: 120_000_000n }));
    expect(h.confirm.mock.invocationCallOrder[0]).toBeLessThan(h.getSecret.mock.invocationCallOrder[0]!);
    expect(h.confirm.mock.invocationCallOrder[0]).toBeLessThan(h.wallet.writeContract.mock.invocationCallOrder[0]!);
    expect(h.lines().filter(line => line === "Deposit credited.")).toHaveLength(1);
    expect(h.lines().join("\n")).not.toMatch(/Approved named agent|agent key|test-only-secret|\$2/);
  });

  it("prints a standalone wallet address when waiting for USDC", async () => {
    const h = fixture(); h.pub.readContract.mockResolvedValueOnce(0n).mockResolvedValue(20_000_000n);
    await h.adapter.runFundingFlow(h.ctx, ACCOUNT);
    expect(h.lines().filter(line => line.includes(USER))).toEqual([USER]);
    expect(h.lines().join("\n")).not.toContain(USDC);
    expect(h.lines().join("\n")).not.toContain(BRIDGE);
  });

  it("asks only for the calculated ETH shortfall", async () => {
    const h = fixture(); h.pub.getBalance.mockResolvedValueOnce(0n).mockResolvedValue(10n ** 18n);
    await h.adapter.runFundingFlow(h.ctx, ACCOUNT);
    expect(h.lines()).toContain("Add 0.000015 ETH on Arbitrum for gas.");
    expect(h.lines().filter(line => line.includes(USER))).toEqual([USER]);
    expect(h.lines().join("\n")).not.toContain("$2");
  });

  it("estimates a zero-ETH wallet without a fee-affordability cap but pays the real buffered gas price", async () => {
    const h = fixture(); h.pub.getBalance.mockResolvedValueOnce(0n).mockResolvedValue(10n ** 18n);
    h.pub.estimateContractGas.mockImplementation(async args => {
      // Models providers that cap eth_estimateGas by sender balance when a
      // nonzero/default fee is used. The override is simulation-only.
      if (args.gasPrice !== 0n) throw new Error("gas required exceeds allowance (0)");
      return 100_000n;
    });
    await h.adapter.runFundingFlow(h.ctx, ACCOUNT);
    expect(h.pub.estimateContractGas).toHaveBeenCalledWith(expect.objectContaining({ account: USER, gasPrice: 0n }));
    expect(h.lines()).toContain("Add 0.000015 ETH on Arbitrum for gas.");
    expect(h.wallet.writeContract).toHaveBeenCalledWith(expect.objectContaining({ gasPrice: 120_000_000n }));
    expect(h.confirm.mock.invocationCallOrder[0]).toBeLessThan(h.wallet.writeContract.mock.invocationCallOrder[0]!);
  });

  it("does not unlock a signing key or submit a transaction if confirmation is declined", async () => {
    const h = fixture(); h.confirm.mockResolvedValue(false);
    await expect(h.adapter.runFundingFlow(h.ctx, ACCOUNT)).rejects.toThrow("declined");
    expect(h.getSecret).not.toHaveBeenCalled();
    expect(h.wallet.writeContract).not.toHaveBeenCalled();
    expect(h.provisionAgent).not.toHaveBeenCalled();
  });

  it("stops after an on-chain revert without claiming a deposit or provisioning an agent", async () => {
    const h = fixture(); h.pub.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    await expect(h.adapter.runFundingFlow(h.ctx, ACCOUNT)).rejects.toThrow("reverted");
    expect(h.lines()).not.toContain("Deposit credited.");
    expect(h.provisionAgent).not.toHaveBeenCalled();
    expect(h.wallet.writeContract).toHaveBeenCalledOnce();
  });

  it("never resubmits after an uncertain bridge transaction acknowledgement", async () => {
    const h = fixture(); h.wallet.writeContract.mockRejectedValue(new Error("send timeout"));
    await expect(h.adapter.runFundingFlow(h.ctx, ACCOUNT)).rejects.toThrow("send timeout");
    expect(h.wallet.writeContract).toHaveBeenCalledOnce();
    expect(h.lines()).not.toContain("Deposit credited.");
  });

  it("waits for a top-up increment rather than treating an existing positive balance as credit", async () => {
    const h = fixture(); h.setNative(100); h.setCredits([100, 100, 120]);
    await h.adapter.runFundingFlow(h.ctx, ACCOUNT);
    expect(h.info.clearinghouseState.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(h.lines()).toContain("Deposit credited.");
  });

  it("keeps existing agent approval silent", async () => {
    const h = fixture(); h.provisionAgent.mockRestore();
    await (h.adapter as unknown as Internals).provisionAgent(h.ctx, ACCOUNT);
    expect(h.lines()).toEqual([]);
  });
});

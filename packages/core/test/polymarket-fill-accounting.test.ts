// packages/core/test/polymarket-fill-accounting.test.ts
// Account-side fills must follow owned maker legs, including complementary
// token matches, rather than borrowing the taker's token or another maker.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PolymarketAdapter } from "../src/venues/polymarket.js";
import { VenueUrlsSchema } from "../src/config.js";
import type { VenueAccount } from "../src/types.js";

const sdk = vi.hoisted(() => ({ balanceAllowance: vi.fn(), updateBalanceAllowance: vi.fn() }));
vi.mock("@polymarket/client/actions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@polymarket/client/actions")>(),
  fetchBalanceAllowance: sdk.balanceAllowance,
  updateBalanceAllowance: sdk.updateBalanceAllowance,
}));

const account: VenueAccount = {
  venue: "polymarket", signerAddress: "0x1111111111111111111111111111111111111111",
  funder: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", signatureType: 3,
};
const ts = Date.parse("2026-09-04T20:00:00.000Z");

function maker(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "owned-maker", tokenId: "yes-token", matchedAmount: "5", price: "0.4", side: "BUY",
    feeRateBps: "0", makerAddress: account.funder, owner: "account-api-owner", ...overrides,
  };
}
function trade(overrides: Record<string, unknown> = {}) {
  return {
    id: "trade-1", tokenId: "yes-token", conditionId: "condition-1", matchedAt: new Date(ts).toISOString(),
    status: "CONFIRMED", traderSide: "MAKER", size: "100", price: "0.4", side: "SELL",
    feeRateBps: "500", takerOrderId: "taker-order", makerOrders: [maker()], ...overrides,
  };
}
function fixture(rows: ReturnType<typeof trade>[], secondPage: ReturnType<typeof trade>[] = [], attribution = false) {
  process.env.CASSIE_POLYMARKET_BUILDER_CODE = attribution ? `0x${"cd".repeat(32)}` : "off";
  const adapter = new PolymarketAdapter({ urls: VenueUrlsSchema.parse({}) });
  delete process.env.CASSIE_POLYMARKET_BUILDER_CODE;
  const listAccountTrades = vi.fn(() => (async function* () {
    yield { items: rows };
    if (secondPage.length) yield { items: secondPage };
  })());
  const client = { listAccountTrades };
  const internal = adapter as unknown as {
    secure(): Promise<unknown>;
    yesRefOf(tokenId: string): Promise<unknown>;
    marketInfoForToken(tokenId: string): Promise<unknown>;
  };
  internal.secure = async () => client;
  internal.yesRefOf = async (tokenId) => ({ marketRef: "yes-token", isYes: tokenId === "yes-token" });
  internal.marketInfoForToken = async () => ({ conditionId: "condition-1", info: {} });
  return { adapter, listAccountTrades, client, internal };
}

describe("Polymarket builder fee accounting", () => {
  it("adds Quotient's builder fee on notional at the maker rate to an owned maker leg and at the taker rate to a taker fill", async () => {
    const makerSide = fixture([trade()], [], true);
    const [makerFill] = await makerSide.adapter.fills(account, 0);
    // 5 shares × 0.40 × 50 bps = 0.01; the maker pays no protocol fee.
    expect(makerFill).toMatchObject({ id: "trade-1:owned-maker", size: 5, fee: 0.01 });

    const takerSide = fixture([trade({ traderSide: "TAKER", tokenId: "no-token", size: "100", side: "SELL", price: "0.3", feeRateBps: "500", makerOrders: [] })], [], true);
    const [takerFill] = await takerSide.adapter.fills(account, 0);
    // Protocol 100 × 0.05 × 0.3 × 0.7 = 1.05, plus 100 × 0.30 × 50 bps = 0.15.
    expect(takerFill).toMatchObject({ size: 100, price: 0.3, fee: 1.2 });
  });
});

describe("Polymarket account-side fill accounting", () => {
  it("ignores other makers even when their matching token appears first", async () => {
    const { adapter } = fixture([trade({ makerOrders: [
      maker({ orderId: "someone-else", makerAddress: "0x2222222222222222222222222222222222222222", matchedAmount: "95" }),
      maker({ makerAddress: account.funder.toUpperCase() }),
    ] })]);
    await expect(adapter.fills(account, 0)).resolves.toEqual([{
      id: "trade-1:owned-maker", orderId: "owned-maker", makerOrderId: "owned-maker",
      marketRef: "yes-token", tokenId: "yes-token", conditionId: "condition-1", outcome: "YES",
      side: "BUY", size: 5, matchedAmountDelta: 5, price: 0.4, ts, fee: 0, settlementStatus: "CONFIRMED",
    }]);
  });

  it("uses the owned complementary NO token and maker side instead of the YES taker's fields", async () => {
    const { adapter } = fixture([trade({ side: "BUY", makerOrders: [
      maker({ tokenId: "no-token", side: "BUY", price: "0.6", matchedAmount: "8" }),
    ] })]);
    expect(await adapter.fills(account, 0)).toEqual([expect.objectContaining({
      tokenId: "no-token", marketRef: "yes-token", outcome: "NO", side: "BUY", size: 8, price: 0.6, fee: 0,
    })]);
  });

  it("emits every owned maker order with its own stable identity and never inherits taker fees", async () => {
    const { adapter } = fixture([trade({ makerOrders: [
      maker({ orderId: "maker-a", matchedAmount: "3", feeRateBps: null }),
      maker({ orderId: "maker-b", matchedAmount: "7", price: "0.41", feeRateBps: "500" }),
    ] })]);
    const first = await adapter.fills(account, 0);
    expect(first.map((fill) => ({ id: fill.id, size: fill.size, fee: fill.fee }))).toEqual([
      { id: "trade-1:maker-a", size: 3, fee: 0 }, { id: "trade-1:maker-b", size: 7, fee: 0 },
    ]);
    expect(await adapter.fills(account, 0)).toEqual(first);
  });

  it("aggregates repeated parts of the same owned maker order without colliding with another order", async () => {
    const { adapter } = fixture([trade({ makerOrders: [
      maker({ matchedAmount: "2", price: "0.4" }),
      maker({ matchedAmount: "3", price: "0.5" }),
    ] })]);
    const fills = await adapter.fills(account, 0);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ id: "trade-1:owned-maker", size: 5, matchedAmountDelta: 5, fee: 0 });
    expect(fills[0]!.price).toBeCloseTo(0.46);
  });

  it("retains taker identity and charges only the taker using the protocol fee curve", async () => {
    const { adapter } = fixture([trade({
      traderSide: "TAKER", tokenId: "no-token", size: "100", side: "SELL", price: "0.3", feeRateBps: "500",
    })]);
    expect(await adapter.fills(account, 0)).toEqual([expect.objectContaining({
      id: "trade-1", orderId: "taker-order", tokenId: "no-token", outcome: "NO", side: "SELL",
      size: 100, price: 0.3, fee: 1.05,
    })]);
    expect((await adapter.fills(account, 0))[0]).not.toHaveProperty("makerOrderId");
  });

  it.each(["MATCHED", "MINED", "RETRYING", "CONFIRMED", "TRADE_STATUS_CONFIRMED"])(
    "exposes stable %s settlement events but only successful final fills to generic consumers", async (status) => {
      const { adapter } = fixture([trade({ status })]);
      const settlements = await adapter.tradeSettlements(account, 0);
      expect(settlements[0]).toMatchObject({ id: "trade-1:owned-maker", settlementStatus: status.replace(/^TRADE_STATUS_/, "") });
      expect(await adapter.fills(account, 0)).toHaveLength(status.endsWith("CONFIRMED") ? 1 : 0);
    },
  );

  it.each(["FAILED", "TRADE_STATUS_FAILED"])("exposes terminal %s for reservation release without inventing inventory", async (status) => {
    const { adapter } = fixture([trade({ status })]);
    await expect(adapter.fills(account, 0)).resolves.toEqual([]);
    expect(await adapter.tradeSettlements(account, 0)).toEqual([expect.objectContaining({
      id: "trade-1:owned-maker", orderId: "owned-maker", size: 5, settlementStatus: "FAILED",
    })]);
  });

  it("rejects unknown settlement status and maker data that cannot establish account ownership", async () => {
    await expect(fixture([trade({ status: "MYSTERY" })]).adapter.fills(account, 0)).rejects.toThrow(/unsupported settlement status/);
    await expect(fixture([trade({ makerOrders: [maker({ makerAddress: account.signerAddress })] })]).adapter.fills(account, 0))
      .rejects.toThrow(/no maker leg owned by the account funder/);
  });

  it("uses the server time filter with overlap and excludes older failed trades locally", async () => {
    const { adapter, listAccountTrades } = fixture([
      trade({ id: "old", status: "FAILED", matchedAt: new Date(ts - 1).toISOString() }), trade(),
    ]);
    expect(await adapter.fills(account, ts)).toHaveLength(1);
    expect(listAccountTrades).toHaveBeenCalledWith({ after: String(ts / 1_000 - 1) });
  });

  it("does not duplicate pagination records and prefers the newest settlement status", async () => {
    expect(await fixture([trade()], [trade()]).adapter.fills(account, 0)).toHaveLength(1);
    const failed = fixture([trade({ status: "MATCHED" })], [trade({ status: "FAILED" })]);
    await expect(failed.adapter.fills(account, 0)).resolves.toEqual([]);
    expect((await failed.adapter.tradeSettlements(account, 0))[0]!.settlementStatus).toBe("FAILED");
    const finalized = fixture([trade()], [trade({ status: "MATCHED" })]);
    expect((await finalized.adapter.fills(account, 0))[0]!.settlementStatus).toBe("CONFIRMED");
  });

  it("rejects conflicting order parts and invalid account-side fill quantities", async () => {
    const conflicting = fixture([trade({ makerOrders: [maker(), maker({ tokenId: "no-token" })] })]);
    await expect(conflicting.adapter.fills(account, 0)).rejects.toThrow(/conflicting tokens or sides/);
    await expect(fixture([trade({ makerOrders: [maker({ matchedAmount: "NaN" })] })]).adapter.fills(account, 0))
      .rejects.toThrow(/invalid account fill terms/);
  });
});

describe("Polymarket authoritative token balances", () => {
  beforeEach(() => {
    sdk.balanceAllowance.mockReset();
    sdk.updateBalanceAllowance.mockReset().mockResolvedValue(undefined);
  });

  it("reads the exact CONDITIONAL token through the pinned SDK and converts six decimals", async () => {
    const { adapter, client } = fixture([]);
    sdk.balanceAllowance.mockResolvedValue({ balance: "12500001", allowances: {} });
    await expect(adapter.tokenBalance(account, "no-token")).resolves.toBe(12.500001);
    expect(sdk.updateBalanceAllowance).toHaveBeenCalledWith(client, { assetType: "CONDITIONAL", tokenId: "no-token" });
    expect(sdk.balanceAllowance).toHaveBeenCalledWith(client, { assetType: "CONDITIONAL", tokenId: "no-token" });
    expect(sdk.updateBalanceAllowance.mock.invocationCallOrder[0]).toBeLessThan(sdk.balanceAllowance.mock.invocationCallOrder[0]!);
  });

  it("accepts zero but rejects malformed or negative authoritative balances", async () => {
    const { adapter } = fixture([]);
    sdk.balanceAllowance.mockResolvedValue({ balance: "0" });
    await expect(adapter.tokenBalance(account, "yes-token")).resolves.toBe(0);
    for (const balance of ["NaN", "-1", "Infinity"]) {
      sdk.balanceAllowance.mockResolvedValue({ balance });
      await expect(adapter.tokenBalance(account, "yes-token")).rejects.toThrow(/invalid Polymarket balance/);
    }
  });

  it("does not fall back to a stale balance when the explicit cache refresh fails", async () => {
    const { adapter } = fixture([]);
    sdk.updateBalanceAllowance.mockRejectedValue(new Error("refresh unavailable"));
    await expect(adapter.tokenBalance(account, "yes-token")).rejects.toThrow(/refresh unavailable/);
    expect(sdk.balanceAllowance).not.toHaveBeenCalled();
  });
});

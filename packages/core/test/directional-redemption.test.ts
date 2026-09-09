// packages/core/test/directional-redemption.test.ts
import { describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine.js";
import { computePortfolio, MemoryStateStore, parseBotConfig, silentLogger,
  type Position, type RedemptionHooks, type VenueAdapter } from "@quotient-forecasting/cassie-core";

const loss: Position = { marketRef: "yes-token", tokenId: "no-token", conditionId: "condition", side: "NO",
  size: 0.75, avgPrice: 0.8, currentPrice: 0, unrealizedPnl: -0.6, redeemable: true };

function setup() {
  const state = new MemoryStateStore();
  const positions = [loss];
  const send = vi.fn();
  const redeem = vi.fn(async (_account, _position, hooks?: RedemptionHooks) => {
    await hooks?.beforeSubmit();
    await hooks?.submitted({ transactionId: "relay-123" });
    return { transactionHash: "0xsettled", transactionId: "relay-123" };
  });
  const adapter = { id: "polymarket", positions: async () => positions, balances: async () => [{ total: 100 }],
    openOrders: vi.fn(async () => []), fills: async () => [], quote: vi.fn(async () => { throw new Error("no book after resolution"); }),
    cancelOrder: vi.fn(), redeem, redemptionStatus: vi.fn(async () => "pending") } as unknown as VenueAdapter;
  const account = { venue: "polymarket" as const, signerAddress: "0x1", funder: "0x2", signatureType: 3 };
  const config = parseBotConfig({ id: "redemption", venue: "polymarket", execution: { mode: "legacy" } });
  const strategyTick = vi.fn(async () => [{ kind: "redeem" as const, marketRef: loss.marketRef }]);
  const engine = () => new Engine({ botId: config.id, config, adapter, account, state, log: silentLogger, alerter: { send },
    strategy: { id: "test", tick: strategyTick }, signals: { latest: async () => [] } });
  return { state, adapter, account, engine, redeem, send, positions, strategyTick };
}

describe("directional resolution settlement", () => {
  it("redeems resolved holdings even when the strategy fails", async () => {
    const s = setup(); s.strategyTick.mockRejectedValue(new Error("forecast unavailable"));
    expect((await s.engine().tick(1)).errors).toBe(1);
    expect(s.redeem).toHaveBeenCalledOnce();
    expect(JSON.parse((await s.state.get("engine:redemption:condition"))!).status).toBe("confirmed");
  });

  it("redeems a zero-value loser below the trade minimum and deduplicates across restart/indexer lag", async () => {
    const s = setup();
    expect((await s.engine().tick(1)).errors).toBe(0);
    expect(s.redeem).toHaveBeenCalledOnce();
    expect(s.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "resolution", data: expect.objectContaining({ transactionId: "relay-123" }) }));
    await s.engine().tick(2);
    expect(s.redeem).toHaveBeenCalledOnce();
  });
  it("never resubmits an ambiguous request after restart", async () => {
    const s = setup();
    s.redeem.mockImplementationOnce(async (_a, _p, hooks) => { await hooks?.beforeSubmit(); throw new Error("connection lost after submit"); });
    expect((await s.engine().tick(1)).errors).toBe(1);
    await s.engine().tick(2);
    expect(s.redeem).toHaveBeenCalledOnce();
  });
  it("recovers a timed-out receipt by reading its authoritative settlement", async () => {
    const s = setup();
    s.redeem.mockImplementationOnce(async (_a, _p, hooks) => {
      await hooks?.beforeSubmit(); await hooks?.submitted({ transactionId: "relay-123" }); throw new Error("wait timed out");
    });
    await s.engine().tick(1);
    vi.mocked(s.adapter.redemptionStatus!).mockResolvedValue("confirmed");
    await s.engine().tick(2);
    expect(s.redeem).toHaveBeenCalledOnce();
    expect(JSON.parse((await s.state.get("engine:redemption:condition"))!)).toMatchObject({ status: "confirmed" });
  });
  it("only releases a failed submission after the venue confirms failure", async () => {
    const s = setup();
    await s.state.set("engine:redemption:condition", JSON.stringify({ status: "pending", receipt: { transactionId: "failed" } }));
    vi.mocked(s.adapter.redemptionStatus!).mockResolvedValue("failed");
    await s.engine().tick(1);
    expect(s.redeem).not.toHaveBeenCalled();
    await s.engine().tick(2);
    expect(s.redeem).toHaveBeenCalledOnce();
  });
  it("does not burn an unresolved position whose market price merely fell to zero", async () => {
    const s = setup(); s.positions[0] = { ...loss, redeemable: false };
    await s.engine().tick(1);
    expect(s.redeem).not.toHaveBeenCalled();
  });
  it("cancels working orders and waits for the next empty snapshot before redemption", async () => {
    const s = setup();
    vi.mocked(s.adapter.openOrders).mockResolvedValue([{ id: "order", marketRef: loss.marketRef, side: "BUY", size: 1, filledSize: 0, price: 0.1, status: "open" }]);
    await s.engine().tick(1);
    expect(s.adapter.cancelOrder).toHaveBeenCalledWith(s.account, "order");
    expect(s.redeem).not.toHaveBeenCalled();
    vi.mocked(s.adapter.openOrders).mockResolvedValue([]);
    await s.engine().tick(2);
    expect(s.redeem).toHaveBeenCalledOnce();
  });
  it("values resolved losers at zero and winners at their payout without a book", async () => {
    const s = setup(); s.positions.push({ ...loss, marketRef: "winner", side: "YES", size: 2, currentPrice: 1 });
    const portfolio = await computePortfolio("redemption", s.adapter, s.account);
    expect(portfolio.equity).toBe(102);
    expect(portfolio.positions.map(p => p.value)).toEqual([0, 2]);
    expect(s.adapter.quote).not.toHaveBeenCalled();
  });
});

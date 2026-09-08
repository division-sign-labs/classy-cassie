// packages/core/test/hyperliquid-funding.test.ts
import { describe, expect, it, vi } from "vitest";
import { prepareHyperliquidPerpFunding, type HyperliquidPerpFundingOptions } from "../src/venues/hyperliquid-funding.js";

const USER = "0x1111111111111111111111111111111111111111";
const TOKEN_ID = "0xeb62eee3685fc4c43992febcd9e75443";
const NOW = 1_800_000_000_000;
function fixture() {
  let mode = "default";
  const balances = new Map([["", "600.064501"], ["xyz", "0"], ["other", "0"]]);
  const positions = new Map<string, unknown[]>();
  const orders = new Map<string, unknown[]>();
  const info = {
    userAbstraction: vi.fn(async () => mode),
    perpDexs: vi.fn(async () => [null, { name: "xyz" }, { name: "other" }]),
    meta: vi.fn(async () => ({ collateralToken: 0, universe: [{ name: "xyz:AAPL" }] })),
    spotMeta: vi.fn(async () => ({ tokens: [{ index: 0, name: "USDC", tokenId: TOKEN_ID }] })),
    clearinghouseState: vi.fn(async ({ dex = "" }: { dex?: string }) => ({ time: NOW,
      marginSummary: { accountValue: balances.get(dex) ?? "0", totalMarginUsed: "0", totalNtlPos: "0" },
      withdrawable: balances.get(dex) ?? "0", assetPositions: positions.get(dex) ?? [],
    })),
    openOrders: vi.fn(async ({ dex = "" }: { dex?: string }) => orders.get(dex) ?? []),
    spotClearinghouseState: vi.fn(async () => ({ balances: [] as unknown[] })),
    userNonFundingLedgerUpdates: vi.fn(async () => [] as unknown[]),
  };
  const exchange = {
    userSetAbstraction: vi.fn(async () => { mode = "disabled"; return { status: "ok", response: { type: "default" } }; }),
    sendAsset: vi.fn(async () => { balances.set("", "0"); balances.set("xyz", "600.064501"); return { status: "ok", response: { type: "default" } }; }),
  };
  const context = { print: vi.fn(), confirm: vi.fn(async () => true) };
  const sleep = vi.fn(async () => {});
  const options = { info, exchange, context, masterAddress: USER, destinationDex: "xyz", now: () => NOW, sleep } as unknown as HyperliquidPerpFundingOptions;
  return { options, info, exchange, context, sleep, balances, positions, orders, setMode: (value: string) => { mode = value; } };
}

describe("Hyperliquid Standard DEX funding", () => {
  it("confirms the exact amount and destination once, selects Standard mode, then transfers with pinned SDK methods", async () => {
    const h = fixture();
    expect(await prepareHyperliquidPerpFunding(h.options)).toEqual({ status: "ready", modeChanged: true, movedUsdc: "600.064501", nativeUsdc: "0", destinationUsdc: "600.064501" });
    expect(h.context.print.mock.calls).toEqual([["Hyperliquid account"], [USER]]);
    expect(h.context.confirm).toHaveBeenCalledOnce();
    expect(h.context.confirm).toHaveBeenCalledWith("Enable Standard mode and move 600.064501 USDC from native perps to xyz?", false);
    expect(h.exchange.userSetAbstraction).toHaveBeenCalledExactlyOnceWith({ user: USER, abstraction: "disabled" });
    expect(h.exchange.sendAsset).toHaveBeenCalledExactlyOnceWith({ destination: USER, sourceDex: "", destinationDex: "xyz", token: `USDC:${TOKEN_ID}`, amount: "600.064501", fromSubAccount: "" });
    expect(h.exchange.userSetAbstraction.mock.invocationCallOrder[0]).toBeLessThan(h.exchange.sendAsset.mock.invocationCallOrder[0]!);
    expect(h.info.clearinghouseState).toHaveBeenCalledWith({ user: USER, dex: "other" });
  });

  it("moves new native collateral into the DEX while positions are open there, confirming arrival from the ledger", async () => {
    const h = fixture(); h.setMode("disabled");
    h.balances.set("", "158.114076"); h.balances.set("xyz", "601.893941");
    h.positions.set("xyz", [{ position: { szi: "1.42" } }]);
    const ledger: unknown[] = [];
    h.exchange.sendAsset.mockImplementation(async () => {
      h.balances.set("", "0"); h.balances.set("xyz", "760.4");
      ledger.push({ time: NOW, hash: "0xabc", delta: { type: "send", user: USER, destination: USER, sourceDex: "", destinationDex: "xyz", token: `USDC:${TOKEN_ID}`, amount: "158.114076" } });
      return { status: "ok", response: { type: "default" } };
    });
    h.info.userNonFundingLedgerUpdates.mockImplementation(async () => ledger);
    expect(await prepareHyperliquidPerpFunding(h.options)).toMatchObject({ status: "ready", modeChanged: false, movedUsdc: "158.114076", nativeUsdc: "0" });
    expect(h.context.confirm).toHaveBeenCalledWith("move 158.114076 USDC from native perps to xyz?", false);
    expect(h.exchange.sendAsset).toHaveBeenCalledOnce();
    expect(h.exchange.userSetAbstraction).not.toHaveBeenCalled();
  });

  it("does not confirm an occupied-destination transfer the ledger has not recorded", async () => {
    const h = fixture(); h.setMode("disabled");
    h.balances.set("", "158.114076"); h.balances.set("xyz", "601.893941");
    h.positions.set("xyz", [{ position: { szi: "1.42" } }]);
    h.exchange.sendAsset.mockImplementation(async () => { h.balances.set("", "0"); return { status: "ok", response: { type: "default" } }; });
    await expect(prepareHyperliquidPerpFunding(h.options)).rejects.toThrow("balances are not confirmed");
    expect(h.exchange.sendAsset).toHaveBeenCalledOnce();
  });

  it("still requires an idle account for the account-mode change", async () => {
    const h = fixture(); h.positions.set("xyz", [{ position: { szi: "1" } }]);
    await expect(prepareHyperliquidPerpFunding(h.options)).rejects.toThrow("before the account-mode change");
    expect(h.exchange.sendAsset).not.toHaveBeenCalled();
    expect(h.exchange.userSetAbstraction).not.toHaveBeenCalled();
  });

  it("is idempotent when native funds were already moved", async () => {
    const h = fixture(); await prepareHyperliquidPerpFunding(h.options);
    expect(await prepareHyperliquidPerpFunding(h.options)).toMatchObject({ status: "ready", modeChanged: false, movedUsdc: "0" });
    expect(h.context.confirm).toHaveBeenCalledOnce();
    expect(h.exchange.sendAsset).toHaveBeenCalledOnce();
    expect(h.exchange.userSetAbstraction).toHaveBeenCalledOnce();
  });

  it("skips the mode write for an existing Standard account", async () => {
    const h = fixture(); h.setMode("disabled");
    expect(await prepareHyperliquidPerpFunding(h.options)).toMatchObject({ modeChanged: false, movedUsdc: "600.064501" });
    expect(h.exchange.userSetAbstraction).not.toHaveBeenCalled();
    expect(h.context.confirm).toHaveBeenCalledWith("move 600.064501 USDC from native perps to xyz?", false);
  });

  it("cancels before either signed write when consent is declined", async () => {
    const h = fixture(); h.context.confirm.mockResolvedValue(false);
    expect(await prepareHyperliquidPerpFunding(h.options)).toMatchObject({ status: "canceled", movedUsdc: "0", modeChanged: false });
    expect(h.exchange.userSetAbstraction).not.toHaveBeenCalled();
    expect(h.exchange.sendAsset).not.toHaveBeenCalled();
  });

  it.each(["unifiedAccount", "portfolioMargin", "dexAbstraction", "unknown"])("does not migrate %s", async mode => {
    const h = fixture(); h.setMode(mode);
    await expect(prepareHyperliquidPerpFunding(h.options)).rejects.toThrow("cannot migrate account mode");
    expect(h.context.confirm).not.toHaveBeenCalled();
    expect(h.exchange.userSetAbstraction).not.toHaveBeenCalled();
    expect(h.exchange.sendAsset).not.toHaveBeenCalled();
  });

  it.each(["", "xyz", "other"])("rejects existing positions on DEX '%s' before changing mode", async dex => {
    const h = fixture(); h.positions.set(dex, [{ position: { szi: "1" } }]);
    await expect(prepareHyperliquidPerpFunding(h.options)).rejects.toThrow(/positions|orders/);
    expect(h.exchange.userSetAbstraction).not.toHaveBeenCalled();
  });

  it.each(["", "xyz", "other"])("rejects working orders on DEX '%s' before changing mode", async dex => {
    const h = fixture(); h.orders.set(dex, [{ oid: 123 }]);
    await expect(prepareHyperliquidPerpFunding(h.options)).rejects.toThrow(/positions|orders/);
    expect(h.exchange.userSetAbstraction).not.toHaveBeenCalled();
  });

  it("does not migrate spot holdings or borrowing", async () => {
    const h = fixture(); h.info.spotClearinghouseState.mockResolvedValue({ balances: [{ coin: "USDC", total: "1", hold: "0" }] });
    await expect(prepareHyperliquidPerpFunding(h.options)).rejects.toThrow("empty spot balances");
    expect(h.exchange.userSetAbstraction).not.toHaveBeenCalled();
  });

  it("rechecks exposure and balances after the confirmation prompt", async () => {
    for (const mutate of [
      (h: ReturnType<typeof fixture>) => { h.balances.set("", "900"); },
      (h: ReturnType<typeof fixture>) => { h.positions.set("other", [{ position: { szi: "1" } }]); },
      (h: ReturnType<typeof fixture>) => { h.setMode("disabled"); },
    ]) {
      const h = fixture(); h.context.confirm.mockImplementation(async () => { mutate(h); return true; });
      await expect(prepareHyperliquidPerpFunding(h.options)).rejects.toThrow();
      expect(h.exchange.userSetAbstraction).not.toHaveBeenCalled();
      expect(h.exchange.sendAsset).not.toHaveBeenCalled();
    }
  });

  it("requires a mode readback before submitting the transfer", async () => {
    const h = fixture(); h.exchange.userSetAbstraction.mockResolvedValue({ status: "ok", response: { type: "default" } });
    await expect(prepareHyperliquidPerpFunding(h.options)).rejects.toThrow("Standard mode is not confirmed");
    expect(h.exchange.sendAsset).not.toHaveBeenCalled();
  });

  it("does not retry or continue after a lost mode acknowledgement", async () => {
    const h = fixture(); h.exchange.userSetAbstraction.mockRejectedValue(new Error("timeout"));
    await expect(prepareHyperliquidPerpFunding(h.options)).rejects.toThrow("mode acknowledgement is uncertain");
    expect(h.exchange.userSetAbstraction).toHaveBeenCalledOnce();
    expect(h.exchange.sendAsset).not.toHaveBeenCalled();
  });

  it("never retries an uncertain asset transfer", async () => {
    const h = fixture(); h.exchange.sendAsset.mockRejectedValue(new Error("timeout"));
    await expect(prepareHyperliquidPerpFunding(h.options)).rejects.toThrow("Transfer acknowledgement is uncertain");
    expect(h.exchange.sendAsset).toHaveBeenCalledOnce();
  });

  it("polls only reads for delayed indexing and does not resend", async () => {
    const h = fixture();
    h.exchange.sendAsset.mockResolvedValue({ status: "ok", response: { type: "default" } });
    h.sleep.mockImplementation(async () => { h.balances.set("", "0"); h.balances.set("xyz", "600.064501"); });
    expect(await prepareHyperliquidPerpFunding(h.options)).toMatchObject({ movedUsdc: "600.064501" });
    expect(h.sleep).toHaveBeenCalledOnce();
    expect(h.exchange.sendAsset).toHaveBeenCalledOnce();
  });

  it("does not report success from an acknowledgement without confirmed destination credit", async () => {
    const h = fixture(); h.exchange.sendAsset.mockResolvedValue({ status: "ok", response: { type: "default" } });
    await expect(prepareHyperliquidPerpFunding(h.options)).rejects.toThrow("balances are not confirmed");
    expect(h.exchange.sendAsset).toHaveBeenCalledOnce();
  });

  it("validates DEX collateral and canonical USDC identity before consent", async () => {
    const h = fixture(); h.info.meta.mockResolvedValue({ collateralToken: 1, universe: [{ name: "xyz:AAPL" }] });
    await expect(prepareHyperliquidPerpFunding(h.options)).rejects.toThrow("USDC collateral");
    expect(h.context.confirm).not.toHaveBeenCalled();
    const token = fixture(); token.info.spotMeta.mockResolvedValue({ tokens: [{ index: 0, name: "OTHER", tokenId: TOKEN_ID }] });
    await expect(prepareHyperliquidPerpFunding(token.options)).rejects.toThrow("USDC token identity");
  });
});

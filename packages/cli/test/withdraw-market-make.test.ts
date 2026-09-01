// packages/cli/test/withdraw-market-make.test.ts

import { describe, expect, it, vi } from "vitest";
import { parseBotConfig, type BotConfig } from "@quotient-forecasting/cassie-core";
import {
  MARKET_MAKE_PRESET,
  MarketMakeConfigSchema,
  marketMakeConfigHash,
} from "@quotient-forecasting/strategy-market-make";
import {
  assertFlatHaltedMarketMakeStatus,
  createWithdrawHandler,
  type WithdrawDependencies,
} from "../src/commands/withdraw.js";

const NOW = 2_000_000_000_000;
const DESTINATION = `0x${"a".repeat(40)}`;
const POLICY = MarketMakeConfigSchema.parse(MARKET_MAKE_PRESET);
const CONFIG_HASH = marketMakeConfigHash(POLICY);

function marketMaker(): BotConfig {
  return parseBotConfig({
    id: "maker-withdraw",
    venue: "polymarket",
    account: {
      venue: "polymarket",
      signerAddress: `0x${"b".repeat(40)}`,
      funder: `0x${"c".repeat(40)}`,
    },
    strategy: { id: "market-make", config: POLICY },
  });
}

function flatCurrentStatus(): Record<string, unknown> {
  const reconciliation = { id: "runtime:flat:final", ts: NOW - 1_000, ok: true };
  return {
    strategyId: "market-make",
    schemaVersion: "q-directed-polymarket-mm/1",
    configHash: CONFIG_HASH,
    deploymentId: "local:maker-withdraw:1",
    started: true,
    lifecycle: "HALTED",
    lastReconciliation: reconciliation,
    settlementQuiescent: true,
    settlementQuiescentAt: reconciliation.ts,
    activeMarkets: 0,
    liveOrders: 0,
    deployedUsd: 0,
    persistence: {
      lifecycle: "HALTED",
      deploymentConfigHash: CONFIG_HASH,
      deploymentId: "local:maker-withdraw:1",
      deploymentUpdatedAt: NOW - 10_000,
      lastReconciliation: reconciliation,
      counts: {
        activeInventoryCycles: 0,
        activeOrders: 0,
        unknownOrders: 0,
        cancelPendingOrders: 0,
      },
      availability: {
        collateralTotalUsd: 500,
        collateralReservedUsd: 0,
        collateralFreeUsd: 500,
        tokens: [],
      },
      updatedAt: NOW - 500,
    },
  };
}

function persistence(status: Record<string, unknown>): Record<string, unknown> {
  return status.persistence as Record<string, unknown>;
}

describe("market-make withdrawal guard", () => {
  it("rejects ACTIVE and exit-only lifecycles", () => {
    for (const lifecycle of ["ACTIVE", "RISK_EXIT_ONLY", "LOSS_EXIT_ONLY"]) {
      const status = flatCurrentStatus();
      status.lifecycle = lifecycle;
      persistence(status).lifecycle = lifecycle;
      expect(() => assertFlatHaltedMarketMakeStatus(marketMaker(), status, NOW)).toThrow(
        /lifecycle must be HALTED/,
      );
    }
  });

  it("rejects any active position or token inventory", () => {
    const status = flatCurrentStatus();
    status.activeMarkets = 1;
    const persisted = persistence(status);
    (persisted.counts as Record<string, unknown>).activeInventoryCycles = 1;
    (persisted.availability as Record<string, unknown>).tokens = [{
      tokenId: "yes-token",
      totalQuantity: 10,
      reservedQuantity: 0,
      freeQuantity: 10,
    }];

    expect(() => assertFlatHaltedMarketMakeStatus(marketMaker(), status, NOW)).toThrow(
      /active market\/inventory is not zero/,
    );
  });

  it("rejects any working, unknown, or cancel-pending order", () => {
    for (const countKey of ["activeOrders", "unknownOrders", "cancelPendingOrders"]) {
      const status = flatCurrentStatus();
      status.liveOrders = countKey === "activeOrders" ? 1 : 0;
      (persistence(status).counts as Record<string, unknown>)[countKey] = 1;
      expect(() => assertFlatHaltedMarketMakeStatus(marketMaker(), status, NOW)).toThrow(
        /order is not zero/,
      );
    }
  });

  it("rejects a stale or identity-obsolete reconciliation", () => {
    const stale = flatCurrentStatus();
    const staleReconciliation = { id: "runtime:stale:final", ts: NOW - 61_000, ok: true };
    stale.lastReconciliation = staleReconciliation;
    stale.settlementQuiescentAt = staleReconciliation.ts;
    persistence(stale).lastReconciliation = staleReconciliation;
    persistence(stale).deploymentUpdatedAt = NOW - 120_000;
    expect(() => assertFlatHaltedMarketMakeStatus(marketMaker(), stale, NOW)).toThrow(
      /last reconciliation is stale/,
    );

    const obsolete = flatCurrentStatus();
    persistence(obsolete).deploymentUpdatedAt = NOW;
    expect(() => assertFlatHaltedMarketMakeStatus(marketMaker(), obsolete, NOW)).toThrow(
      /predates the current configuration\/deployment/,
    );
  });

  it("rejects flat status that is still inside order/fill settlement quarantine", () => {
    const status = flatCurrentStatus();
    status.settlementQuiescent = false;
    expect(() => assertFlatHaltedMarketMakeStatus(marketMaker(), status, NOW)).toThrow(
      /settlement is not quiescent/,
    );

    const mismatched = flatCurrentStatus();
    mismatched.settlementQuiescentAt = NOW - 2_000;
    expect(() => assertFlatHaltedMarketMakeStatus(marketMaker(), mismatched, NOW)).toThrow(
      /settlement proof does not belong/,
    );
  });

  it("fails closed when the runtime is unreachable before adapter or confirmation", async () => {
    const adapterFor = vi.fn();
    const confirm = vi.fn();
    const handler = createWithdrawHandler({
      loadConfig: () => marketMaker(),
      adapterFor: adapterFor as unknown as WithdrawDependencies["adapterFor"],
      confirm,
      marketMakeStatus: vi.fn(async () => {
        throw new Error("socket unavailable");
      }),
      now: () => NOW,
      log: vi.fn(),
    });

    await expect(handler("maker-withdraw", "all", { to: DESTINATION })).rejects.toThrow(
      /runtime status is unreachable.*socket unavailable/,
    );
    expect(adapterFor).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("allows a current, flat, HALTED market-maker to reach withdrawal execution", async () => {
    const withdraw = vi.fn(async () => "withdrawal submitted");
    const adapterFor = vi.fn(async () => ({ withdraw }));
    const marketMakeStatus = vi.fn(async () => flatCurrentStatus());
    const log = vi.fn();
    const handler = createWithdrawHandler({
      loadConfig: () => marketMaker(),
      adapterFor: adapterFor as unknown as WithdrawDependencies["adapterFor"],
      makeSetupContext: (() => ({})) as unknown as WithdrawDependencies["makeSetupContext"],
      marketMakeStatus,
      now: () => NOW,
      log,
    });

    await handler("maker-withdraw", "all", { to: DESTINATION, yes: true });

    expect(marketMakeStatus).toHaveBeenCalledTimes(2);
    expect(adapterFor).toHaveBeenCalledWith(expect.anything(), { needCreds: true });
    expect(withdraw).toHaveBeenCalledOnce();
    expect(withdraw.mock.calls[0]?.[2]).toEqual({ to: DESTINATION, amount: "all" });
    expect(log.mock.calls.flat().join("\n")).toContain("withdrawal submitted");
  });

  it("rechecks --yes immediately before execution and refuses changed state", async () => {
    const withdraw = vi.fn(async () => "withdrawal submitted");
    const adapterFor = vi.fn(async () => ({ withdraw }));
    const changed = flatCurrentStatus();
    changed.settlementQuiescent = false;
    const marketMakeStatus = vi.fn()
      .mockResolvedValueOnce(flatCurrentStatus())
      .mockResolvedValueOnce(changed);
    const handler = createWithdrawHandler({
      loadConfig: () => marketMaker(),
      adapterFor: adapterFor as unknown as WithdrawDependencies["adapterFor"],
      makeSetupContext: (() => ({})) as unknown as WithdrawDependencies["makeSetupContext"],
      marketMakeStatus,
      now: () => NOW,
      log: vi.fn(),
    });

    await expect(handler("maker-withdraw", "all", { to: DESTINATION, yes: true })).rejects.toThrow(
      /settlement is not quiescent/,
    );
    expect(marketMakeStatus).toHaveBeenCalledTimes(2);
    expect(withdraw).not.toHaveBeenCalled();
  });
});

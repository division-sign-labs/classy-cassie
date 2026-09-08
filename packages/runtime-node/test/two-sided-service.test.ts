// packages/runtime-node/test/two-sided-service.test.ts
// Two-sided service wiring uses its existing SQLite checkpoint store and keeps
// the dedicated order lifecycle isolated from generic/manual trading routes.

import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotConfigSchema, type StateStore, type VenueAccount } from "@quotient-forecasting/cassie-core";
import { createTwoSidedMarketMakeConfig } from "@quotient-forecasting/strategy-market-make";
import { BotService } from "../src/service.js";
import { SqliteStateStore } from "../src/state.js";

const constructors = vi.hoisted(() => ({
  adapter: vi.fn(),
  twoSided: vi.fn(),
  directional: vi.fn(),
  quotient: vi.fn(),
}));

vi.mock("@quotient-forecasting/cassie-core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@quotient-forecasting/cassie-core")>(),
  createAdapter: constructors.adapter,
  MarketMakeQuotientClient: class {
    constructor(...args: unknown[]) { constructors.quotient(...args); }
  },
}));
vi.mock("../src/two-sided-market-make-controller.js", () => ({
  TwoSidedMarketMakeController: class {
    constructor(...args: unknown[]) { return constructors.twoSided(...args); }
  },
}));
vi.mock("../src/market-make-controller.js", () => ({
  MarketMakeController: class {
    constructor(...args: unknown[]) {
      constructors.directional(...args);
      throw new Error("directional controller must not run for two-sided configuration");
    }
  },
}));
// Keep unrelated swing strategy changes out of these service-routing tests.
vi.mock("../src/swing-controller.js", () => ({ SwingController: class {} }));

const account: VenueAccount = {
  venue: "polymarket",
  signerAddress: "0x0000000000000000000000000000000000000001",
  funder: "0x0000000000000000000000000000000000000002",
  signatureType: 3,
};

function controllerDouble() {
  const status = { strategyId: "two-sided-spread-v1", mode: "two_sided", halted: true, lifecycle: "HALTED" };
  return {
    status: vi.fn(() => status),
    start: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    tick: vi.fn().mockResolvedValue({ ordersPlaced: 0 }),
    dryRun: vi.fn().mockResolvedValue({ actions: [], candidates: [] }),
    halt: vi.fn().mockResolvedValue(status),
    resume: vi.fn().mockResolvedValue({ ...status, halted: false, lifecycle: "ACTIVE" }),
    reconcile: vi.fn().mockResolvedValue({ applied: false, proposalHash: "a".repeat(64) }),
    stateSnapshot: vi.fn(() => ({ version: 1, orders: [], inventory: {} })),
  };
}

describe("two-sided market-make BotService integration", () => {
  let directory: string;
  let path: string;
  let service: BotService | undefined;
  let controller: ReturnType<typeof controllerDouble>;
  let venue: {
    cancelAll: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    placeOrder: ReturnType<typeof vi.fn>;
    openOrders: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    directory = mkdtempSync(join(tmpdir(), "cassie-two-sided-service-"));
    path = join(directory, "bot.sqlite");
    controller = controllerDouble();
    venue = {
      cancelAll: vi.fn().mockResolvedValue(undefined),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      placeOrder: vi.fn().mockResolvedValue(undefined),
      openOrders: vi.fn().mockResolvedValue([]),
    };
    constructors.adapter.mockReturnValue(venue);
    constructors.twoSided.mockReturnValue(controller);
  });

  afterEach(async () => {
    await service?.shutdown().catch(() => undefined);
    service = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  function createService() {
    service = new BotService({
      config: BotConfigSchema.parse({
        id: "two-sided-service",
        venue: "polymarket",
        strategy: { id: "market-make", config: createTwoSidedMarketMakeConfig() },
        tickIntervalMin: 0.25,
      }),
      account,
      statePath: path,
      runtime: "local",
      deploymentId: "two-sided-test-deployment",
      // Deliberately no Quotient key: spread quoting is independent of forecasts.
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    return service;
  }

  it("routes the explicit two-sided preset without constructing a directional or Quotient client", async () => {
    const bot = createService();
    expect(constructors.twoSided).toHaveBeenCalledOnce();
    expect(constructors.directional).not.toHaveBeenCalled();
    expect(constructors.quotient).not.toHaveBeenCalled();
    const [dependencies, options] = constructors.twoSided.mock.calls[0]!;
    expect(dependencies).toMatchObject({
      config: { strategy_id: "two-sided-spread-v1", two_sided: { target_markets: 3 } },
      venue,
      account,
      botId: "two-sided-service",
    });
    expect(dependencies).not.toHaveProperty("quotient");
    expect(options).toMatchObject({
      deploymentId: "two-sided-test-deployment", autoSchedule: false, enableSubscriptions: true,
    });
    expect(bot.status().marketMake).toBe(controller.status());
    expect(bot.status().tickIntervalMin).toBe(1);
    await expect(bot.signalCheck()).resolves.toMatchObject({ ok: true, required: false, source: "polymarket-books" });
  });

  it("passes the same existing SQLite kv store without adding a directional ledger or another database", async () => {
    const existing = new SqliteStateStore(path);
    await existing.set("existing-user-state", "preserved");
    existing.close();

    createService();
    const [{ stateStore }] = constructors.twoSided.mock.calls[0]! as [{ stateStore: StateStore }];
    expect(stateStore).toBeInstanceOf(SqliteStateStore);
    expect(await stateStore.get("existing-user-state")).toBe("preserved");
    await stateStore.set("two-sided-test-checkpoint", JSON.stringify({ orders: [], inventory: {} }));

    const database = new Database(path, { readonly: true });
    try {
      expect(database.prepare("SELECT value FROM kv WHERE key = ?").get("two-sided-test-checkpoint")).toEqual({
        value: '{"orders":[],"inventory":{}}',
      });
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
      expect(tables).toEqual([{ name: "errors" }, { name: "kv" }, { name: "sqlite_sequence" }]);
    } finally {
      database.close();
    }
    expect(readdirSync(directory).filter((name) => name.endsWith(".sqlite"))).toEqual(["bot.sqlite"]);
  });

  it("routes ticks, previews, halt/resume, and hash-bound reconciliation to the two-sided controller", async () => {
    const bot = createService();
    await bot.tick(42);
    await bot.marketMakeDryRun();
    await bot.marketMakeHalt({ liquidate: false });
    await bot.marketMakeResume({ acknowledgeLossReset: true });
    await bot.marketMakeReconcile({ apply: true, expectedProposalHash: "b".repeat(64) });
    expect(controller.tick).toHaveBeenCalledOnce();
    expect(controller.dryRun).toHaveBeenCalledOnce();
    expect(controller.halt).toHaveBeenCalledWith({ liquidate: false });
    expect(controller.resume).toHaveBeenCalledWith({ acknowledgeLossReset: true });
    expect(controller.reconcile).toHaveBeenCalledWith({ apply: true, expectedProposalHash: "b".repeat(64) });
    expect(bot.marketMakeSnapshot().strategy).toEqual({ version: 1, orders: [], inventory: {} });
    await expect(bot.marketMakeReconcile({ apply: true })).rejects.toThrow(/exact proposal hash/);
    expect(controller.reconcile).toHaveBeenCalledOnce();
  });

  it("blocks generic orders, cancellation, and resume from bypassing the dedicated inventory ledger", async () => {
    const bot = createService();
    await expect(bot.manualOrder({ marketRef: "yes-token", side: "BUY", size: 5 })).rejects.toThrow(/manual orders are disabled/);
    await expect(bot.cancelOrder("managed-order")).rejects.toThrow(/generic order cancellation is disabled/);
    await expect(bot.cancelAll()).rejects.toThrow(/generic cancel-all is disabled/);
    await expect(bot.resume()).rejects.toThrow(/market-make\/resume/);
    expect(venue.placeOrder).not.toHaveBeenCalled();
    expect(venue.cancelOrder).not.toHaveBeenCalled();
    expect(venue.cancelAll).not.toHaveBeenCalled();
  });

  it("independently cancels and authoritatively verifies empty venue orders at shutdown", async () => {
    const bot = createService();
    const expected = {
      stopped: true,
      restingOrdersCanceled: true,
      cancellation: {
        method: "market-make-venue", requested: true, completed: true, verifiedOpenOrders: true, remainingOpenOrders: 0,
      },
    };
    await expect(bot.shutdown()).resolves.toEqual(expected);
    expect(controller.shutdown).toHaveBeenCalledOnce();
    expect(venue.cancelAll).toHaveBeenCalledExactlyOnceWith(account);
    expect(venue.openOrders).toHaveBeenCalledExactlyOnceWith(account);
    expect(controller.shutdown.mock.invocationCallOrder[0]).toBeLessThan(venue.cancelAll.mock.invocationCallOrder[0]!);
    expect(venue.cancelAll.mock.invocationCallOrder[0]).toBeLessThan(venue.openOrders.mock.invocationCallOrder[0]!);
    await expect(bot.shutdown()).resolves.toEqual(expected);
    expect(venue.cancelAll).toHaveBeenCalledOnce();
  });

  it("still independently cancels and verifies when controller shutdown fails", async () => {
    controller.shutdown.mockRejectedValue(new Error("controller checkpoint unavailable"));
    const bot = createService();
    await expect(bot.shutdown()).rejects.toThrow(/controller checkpoint unavailable/);
    expect(venue.cancelAll).toHaveBeenCalledExactlyOnceWith(account);
    expect(venue.openOrders).toHaveBeenCalledExactlyOnceWith(account);
  });

  it("never reports successful shutdown if the venue still has a resting order", async () => {
    venue.openOrders.mockResolvedValue([{ id: "still-open" }]);
    const bot = createService();
    await expect(bot.shutdown()).rejects.toThrow(/found 1 resting order/);
    await expect(bot.shutdown()).rejects.toThrow(/found 1 resting order/);
    expect(venue.cancelAll).toHaveBeenCalledOnce();
    expect(venue.openOrders).toHaveBeenCalledOnce();
  });

  it("does not treat cancel acknowledgement as proof when authoritative orders cannot be read", async () => {
    venue.openOrders.mockRejectedValue(new Error("venue read timed out"));
    const bot = createService();
    await expect(bot.shutdown()).rejects.toThrow(/authoritative open-orders check failed: venue read timed out/);
    expect(venue.cancelAll).toHaveBeenCalledOnce();
    expect(venue.openOrders).toHaveBeenCalledOnce();
  });
});

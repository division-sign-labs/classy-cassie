// packages/runtime-node/test/adaptive-market-make-service.test.ts
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotConfigSchema, type StateStore, type VenueAccount } from "@quotient-forecasting/cassie-core";
import {
  createAdaptiveMarketMakeConfig, createTwoSidedMarketMakeConfig, marketMakeConfigHash, type MarketMakeConfig,
} from "@quotient-forecasting/strategy-market-make";
import { BotService } from "../src/service.js";
import { SqliteStateStore } from "../src/state.js";

const calls = vi.hoisted(() => ({ adapter: vi.fn(), controller: vi.fn(), directional: vi.fn(), quotient: vi.fn(), signalAccess: vi.fn() }));
vi.mock("@quotient-forecasting/cassie-core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@quotient-forecasting/cassie-core")>(),
  createAdapter: calls.adapter,
  checkLiveSignalAccess: calls.signalAccess,
  MarketMakeQuotientClient: class {
    constructor(...args: unknown[]) { calls.quotient(...args); }
  },
}));
vi.mock("../src/two-sided-market-make-controller.js", () => ({
  TwoSidedMarketMakeController: class {
    constructor(...args: unknown[]) { return calls.controller(...args); }
  },
}));
vi.mock("../src/market-make-controller.js", () => ({
  MarketMakeController: class {
    constructor(...args: unknown[]) {
      calls.directional(...args);
      throw new Error("adaptive mode must not create the legacy directional controller");
    }
  },
}));
vi.mock("../src/swing-controller.js", () => ({ SwingController: class {} }));

const account: VenueAccount = {
  venue: "polymarket", signerAddress: "0x0000000000000000000000000000000000000001",
  funder: "0x0000000000000000000000000000000000000002", signatureType: 3,
};

describe("adaptive market-make BotService wiring", () => {
  let directory: string;
  const services: BotService[] = [];
  let controller: {
    status: ReturnType<typeof vi.fn>; shutdown: ReturnType<typeof vi.fn>;
    tick: ReturnType<typeof vi.fn>; dryRun: ReturnType<typeof vi.fn>;
  };
  let venue: { cancelAll: ReturnType<typeof vi.fn>; openOrders: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    directory = mkdtempSync(join(tmpdir(), "cassie-adaptive-service-"));
    controller = {
      status: vi.fn(() => ({ mode: "q-adaptive", halted: true })),
      shutdown: vi.fn().mockResolvedValue(undefined),
      tick: vi.fn().mockResolvedValue({ ordersPlaced: 0 }),
      dryRun: vi.fn().mockResolvedValue({ actions: [], decisions: [] }),
    };
    venue = { cancelAll: vi.fn().mockResolvedValue(undefined), openOrders: vi.fn().mockResolvedValue([]) };
    calls.adapter.mockReturnValue(venue);
    calls.controller.mockReturnValue(controller);
    calls.signalAccess.mockResolvedValue({ ok: true, count: 3 });
  });
  afterEach(async () => {
    for (const service of services.splice(0)) await service.shutdown().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  });

  function createService(config: MarketMakeConfig = createAdaptiveMarketMakeConfig(), quotientToken?: string, file = "bot.sqlite") {
    const service = new BotService({
      config: BotConfigSchema.parse({
        id: "adaptive-service", venue: "polymarket", strategy: { id: "market-make", config }, tickIntervalMin: .25,
      }),
      account, quotientToken, statePath: join(directory, file), runtime: "local", deploymentId: "adaptive-test-deployment",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    services.push(service);
    return service;
  }

  it("requires Quotient access only for the explicit adaptive opt-in", () => {
    expect(() => createService()).toThrow(/needs a Quotient API key/);
    expect(calls.controller).not.toHaveBeenCalled();
    expect(calls.quotient).not.toHaveBeenCalled();
    expect(calls.directional).not.toHaveBeenCalled();
    createService(createTwoSidedMarketMakeConfig(), undefined, "ordinary.sqlite");
    expect(calls.controller).toHaveBeenCalledOnce();
    expect(calls.quotient).not.toHaveBeenCalled();
    expect(calls.controller.mock.calls[0]![0]).not.toHaveProperty("quotient");
  });

  it("passes the adaptive identity and scoped client to the two-sided lifecycle, not the legacy controller", async () => {
    const config = createAdaptiveMarketMakeConfig();
    const bot = createService(config, "test-quotient-token");
    expect(calls.controller).toHaveBeenCalledOnce();
    expect(calls.directional).not.toHaveBeenCalled();
    expect(calls.quotient).toHaveBeenCalledExactlyOnceWith({
      baseUrl: bot.config.signals.baseUrl, signalsPath: bot.config.signals.path, token: "test-quotient-token",
    });
    const [dependencies, options] = calls.controller.mock.calls[0]!;
    expect(dependencies).toMatchObject({
      config: { strategy_id: "quotient-adaptive-liquidity-v1", schema_version: "polymarket-adaptive-mm/1", two_sided: { adaptive: config.two_sided!.adaptive } },
      venue: expect.any(Object), account, botId: "adaptive-service", quotient: expect.any(Object),
    });
    // The venue arrives wrapped for call counting; calls still reach the adapter.
    await dependencies.venue.openOrders(account);
    expect(venue.openOrders).toHaveBeenCalledOnce();
    expect(marketMakeConfigHash(dependencies.config)).not.toBe(marketMakeConfigHash(createTwoSidedMarketMakeConfig()));
    expect(options).toMatchObject({ deploymentId: "adaptive-test-deployment", autoSchedule: false, enableSubscriptions: true });
    expect(bot.status().marketMake).toEqual({ mode: "q-adaptive", halted: true });
    await bot.tick(42);
    await bot.marketMakeDryRun();
    expect(controller.tick).toHaveBeenCalledOnce();
    expect(controller.dryRun).toHaveBeenCalledOnce();
  });

  it("persists adaptive checkpoint data in the existing SQLite kv store without a second ledger", async () => {
    const path = join(directory, "bot.sqlite");
    const existing = new SqliteStateStore(path);
    await existing.set("existing-user-state", "preserved");
    existing.close();
    createService(createAdaptiveMarketMakeConfig(), "test-quotient-token");
    const [{ stateStore }] = calls.controller.mock.calls[0]! as [{ stateStore: StateStore }];
    expect(stateStore).toBeInstanceOf(SqliteStateStore);
    expect(await stateStore.get("existing-user-state")).toBe("preserved");
    await stateStore.set("adaptive-checkpoint", '{"forecasts":{}}');
    const database = new Database(path, { readonly: true });
    try {
      expect(database.prepare("SELECT value FROM kv WHERE key = ?").get("adaptive-checkpoint")).toEqual({ value: '{"forecasts":{}}' });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([
        { name: "equity_samples" }, { name: "errors" }, { name: "kv" }, { name: "metrics_samples" }, { name: "sqlite_sequence" },
      ]);
    } finally { database.close(); }
    expect(readdirSync(directory).filter((name) => name.endsWith(".sqlite"))).toEqual(["bot.sqlite"]);
  });

  it("checks adaptive signal access instead of taking the ordinary book-only bypass", async () => {
    const adaptive = createService(createAdaptiveMarketMakeConfig(), "test-quotient-token");
    await expect(adaptive.signalCheck()).resolves.toEqual({ ok: true, count: 3 });
    expect(calls.signalAccess).toHaveBeenCalledExactlyOnceWith(adaptive.config.signals, "test-quotient-token");
    const ordinary = createService(createTwoSidedMarketMakeConfig(), undefined, "ordinary.sqlite");
    await expect(ordinary.signalCheck()).resolves.toMatchObject({ ok: true, required: false, source: "polymarket-books" });
    expect(calls.signalAccess).toHaveBeenCalledOnce();
  });

  it("keeps the independent authenticated shutdown check in adaptive mode", async () => {
    const bot = createService(createAdaptiveMarketMakeConfig(), "test-quotient-token");
    await expect(bot.shutdown()).resolves.toMatchObject({
      stopped: true, restingOrdersCanceled: true,
      cancellation: { completed: true, verifiedOpenOrders: true, remainingOpenOrders: 0 },
    });
    expect(controller.shutdown).toHaveBeenCalledOnce();
    expect(venue.cancelAll).toHaveBeenCalledExactlyOnceWith(account);
    expect(venue.openOrders).toHaveBeenCalledExactlyOnceWith(account);
    expect(controller.shutdown.mock.invocationCallOrder[0]).toBeLessThan(venue.cancelAll.mock.invocationCallOrder[0]!);
    expect(venue.cancelAll.mock.invocationCallOrder[0]).toBeLessThan(venue.openOrders.mock.invocationCallOrder[0]!);
  });
});

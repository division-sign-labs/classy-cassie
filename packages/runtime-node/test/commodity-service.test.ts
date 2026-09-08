// packages/runtime-node/test/commodity-service.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotConfigSchema, COMMODITY_LEDGER_KEY, COMMODITY_REPORT_KEY, type StrategyContext, type StateStore } from "@quotient-forecasting/cassie-core";
import { BotService } from "../src/service.js";
const doubles = vi.hoisted(() => ({ engine: vi.fn(), adapter: vi.fn() }));
vi.mock("@quotient-forecasting/cassie-core", async original => ({ ...await original<typeof import("@quotient-forecasting/cassie-core")>(),
  Engine: class { constructor(...args: unknown[]) { return doubles.engine(...args); } }, createAdapter: doubles.adapter }));
vi.mock("../src/swing-controller.js", () => ({ SwingController: class {} }));
const ledgerKey = `strategy:${COMMODITY_LEDGER_KEY}`;
const oldLedger = JSON.stringify({ highWater: 1000, day: "2026-09-05", dayStart: 1000, halted: true, holdings: {} });

describe("commodity runtime activation and preview", () => {
  let dir: string, service: BotService, store: StateStore, ctx: StrategyContext;
  let engine: Record<string, ReturnType<typeof vi.fn> | boolean>;
  const cancel = vi.fn(), submit = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 8, 5, 12)); vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "cassie-commodity-service-"));
    engine = { adaptivePredictionExecution: true, recoverPredictions: vi.fn().mockResolvedValue(undefined), resumePredictions: vi.fn().mockResolvedValue(undefined),
      beginPredictionShutdown: vi.fn().mockResolvedValue(undefined), predictionStatus: vi.fn().mockResolvedValue({ parents: [], blocked: false, dailySpentUsd: {}, entryCooldowns: {} }),
      supervisePredictions: vi.fn().mockResolvedValue(undefined), checkTriggers: vi.fn().mockResolvedValue(undefined), heartbeatIfResting: vi.fn().mockResolvedValue(false),
      cancelAllResting: cancel, tick: vi.fn().mockResolvedValue({ ordersPlaced: 0 }), strategyContext: vi.fn(async () => ctx) };
    doubles.engine.mockImplementation((deps: { state: StateStore }) => { store = deps.state; return engine; });
    doubles.adapter.mockReturnValue({ cancelAll: cancel, placeOrder: submit, openOrders: vi.fn().mockResolvedValue([]) });
    service = new BotService({ config: BotConfigSchema.parse({ id: "commodity-test", venue: "kalshi", strategy: { id: "kalshi-commodities", config: {} }, tickIntervalMin: 1 }),
      account: { venue: "kalshi", keyId: "test" }, statePath: join(dir, "bot.sqlite"), runtime: "local", quotientToken: "test-token", log: { info() {}, warn() {}, error() {}, debug() {} } });
    ctx = { botId: "commodity-test", venueId: "kalshi", config: {}, now: Date.now, equity: 1000, positions: [], openOrders: [],
      execution: { parents: [], blocked: false, entryCooldowns: {}, dailySpentUsd: {} }, log: { info() {}, warn() {}, error() {}, debug() {} },
      signals: { latest: async () => [], snapshot: async () => ({ receivedAt: Date.now(), contracts: [], excluded: [] }) } as StrategyContext["signals"],
      memory: { get: async <T>(key: string) => { const value = await store.get(`strategy:${key}`); return value ? JSON.parse(value) as T : undefined; },
        set: vi.fn(async (key, value) => { await store.set(`strategy:${key}`, JSON.stringify(value)); }) },
      venue: { balances: async () => [{ asset: "USD", total: 1000, available: 1000 }], positions: async () => ctx.positions, openOrders: async () => ctx.openOrders,
        fills: async () => [], book: async () => { throw new Error("unused"); }, quote: async () => { throw new Error("unused"); } } };
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in service test"); }));
  });
  afterEach(async () => {
    await service.shutdown(); vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true });
  });

  it("overwrites an old unpaused flag before recovery and rejects generic resume", async () => {
    await store.set("engine:paused", "false");
    (engine.recoverPredictions as ReturnType<typeof vi.fn>).mockImplementation(async () => { expect(await store.get("engine:paused")).toBe("true"); });
    await service.start();
    expect(await service.paused()).toBe(true);
    await expect(service.resume()).rejects.toThrow("commodities resume");
    expect(engine.resumePredictions).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not clear a latched drawdown without an explicit reset", async () => {
    await service.start(); await store.set(ledgerKey, oldLedger);
    await expect(service.commodityResume(false)).rejects.toThrow("drawdown stop is latched");
    expect(await store.get(ledgerKey)).toBe(oldLedger);
    expect(await service.paused()).toBe(true);
    expect(engine.resumePredictions).not.toHaveBeenCalled();
  });

  it("requires a flat account before resetting and resumes after an accepted audit", async () => {
    await service.start(); await store.set(ledgerKey, oldLedger);
    ctx.positions = [{ marketRef: "held", side: "YES", size: 1, avgPrice: .5 }];
    await expect(service.commodityResume(true)).rejects.toThrow("flat account");
    expect(await store.get(ledgerKey)).toBe(oldLedger);
    ctx.positions = []; ctx.openOrders = [{ id: "o1", marketRef: "held", side: "BUY", size: 1, filledSize: 0, price: .5, status: "open" }];
    await expect(service.commodityResume(true)).rejects.toThrow("flat account");
    ctx.openOrders = [];
    await service.commodityResume(true);
    expect(engine.resumePredictions).toHaveBeenCalledOnce();
    expect(await store.get(ledgerKey)).toBeNull();
    expect(await service.paused()).toBe(false);
  });

  it("preserves the loss latch and paused state when the executor audit rejects reset", async () => {
    await service.start(); await store.set(ledgerKey, oldLedger);
    (engine.resumePredictions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("unresolved order"));
    await expect(service.commodityResume(true)).rejects.toThrow("unresolved order");
    expect(await store.get(ledgerKey)).toBe(oldLedger);
    expect(await service.paused()).toBe(true);
  });

  it("runs the real strategy preview against copied memory without orders or ledger mutation", async () => {
    await store.set(ledgerKey, oldLedger);
    await store.set(`strategy:${COMMODITY_REPORT_KEY}`, '{"previous":true}');
    const originalSet = ctx.memory.set;
    const result = await service.commodityDryRun();
    expect(result).toMatchObject({ halted: true, actions: [] });
    expect(await store.get(ledgerKey)).toBe(oldLedger);
    expect(await store.get(`strategy:${COMMODITY_REPORT_KEY}`)).toBe('{"previous":true}');
    expect(originalSet).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
    expect(engine.supervisePredictions).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

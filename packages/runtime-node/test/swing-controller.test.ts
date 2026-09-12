// packages/runtime-node/test/swing-controller.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBotConfig, type PerpAccountSnapshot, type PerpExecutionState, type PerpMarketSnapshot, type VenueAdapter } from "@quotient-forecasting/cassie-core";
import type { SwingQuotientDataClient, SwingQuotientSnapshot } from "../src/swing-data.js";
import { SqliteStateStore } from "../src/state.js";
import { SwingController } from "../src/swing-controller.js";

const engine = vi.hoisted(() => ({ constructed: vi.fn(), tick: vi.fn(), context: vi.fn(), resume: vi.fn(), supervise: vi.fn(), halt: vi.fn(), cancel: vi.fn(),
  status: vi.fn(async (): Promise<PerpExecutionState> => ({ cycles: [], halted: true, highWaterEquity: 1000, drawdownPct: 0, cashFlowsComplete: true })) }));
vi.mock("@quotient-forecasting/cassie-core", async importOriginal => ({ ...await importOriginal<object>(), Engine: class {
  constructor() { engine.constructed(); }
  tick = engine.tick; strategyContext = engine.context;
  resumePerps = engine.resume; supervisePerps = engine.supervise; haltPerps = engine.halt; cancelAllResting = engine.cancel; perpStatus = engine.status;
} }));

const NOW = Date.parse("2026-09-04T15:00:00Z");
let directory: string, state: SqliteStateStore, controller: SwingController | undefined;
beforeEach(() => {
  vi.clearAllMocks(); engine.resume.mockReset();
  engine.status.mockResolvedValue({ cycles: [], halted: true, highWaterEquity: 1000, drawdownPct: 0, cashFlowsComplete: true });
  engine.tick.mockResolvedValue({ seq: 1, skipped: false, actions: 0, ordersPlaced: 0, errors: 0 });
  directory = mkdtempSync(join(tmpdir(), "cassie-swing-controller-")); state = new SqliteStateStore(join(directory, "state.sqlite"));
});
afterEach(async () => { await controller?.shutdown(false); controller = undefined; state.close(); rmSync(directory, { recursive: true, force: true }); });
function setup(refresh?: () => Promise<SwingQuotientSnapshot>) {
  let now = NOW;
  const q: SwingQuotientSnapshot = { receivedAt: NOW, assets: [{ assetKey: "company:nvidia", marketRef: "xyz:NVDA", assetClass: "equity", name: "NVIDIA" }],
    outlooks: [{ id: "outlook:test", assetKey: "company:nvidia", marketRef: "xyz:NVDA", basisId: "basis:test", targetFamilyKey: "family:test",
      anchorAt: NOW + 48 * 3_600_000, publishedAt: NOW, observedAt: NOW, status: "active", freshnessState: "fresh", basisVerified: true,
      provider: "hyperliquid", priceField: "mid", window: "point", candleInterval: null, groundingStatus: "actionable", rangeStatus: "complete",
      method: "full_quantile_curve", spotAtObservation: 100, expectedPrice: 104, expectedLogReturn: .038, directionalSide: "bullish",
      medianPrice: 103, p10: 94, p25: 98, p75: 108, p90: 112, sigmaTotal: .05, spotGapSigma: 0.59, scoreSigma: null, probabilityAboveSpot: null,
      freshnessReason: null, mode: "signal" }],
    excluded: [], rawResponse: { contract: "asset-price/1", series: [] } };
  const market = { instrument: { marketRef: "xyz:NVDA", dex: "xyz", active: true, maxLeverage: 20, maintenanceMarginRate: .025, szDecimals: 3, minNotional: 10 },
    book: { marketRef: "xyz:NVDA", bids: [{ price: 99.99, size: 100 }], asks: [{ price: 100.01, size: 100 }], ts: NOW },
    quote: { volume24h: 1e6 }, markPrice: 100, oraclePrice: 100, fundingRateHourly: 0, makerFeeRate: .00015, takerFeeRate: .00045, ts: NOW } as unknown as PerpMarketSnapshot;
  const adapter = { perpMarketSnapshot: vi.fn(async () => market), placeOrder: vi.fn(), placePerpStop: vi.fn(),
    perpAccountSnapshot: vi.fn(async () => account), configurePerpLeverage: vi.fn(), cancelAll: vi.fn(), cancelOrder: vi.fn(), disarmScheduledCancel: vi.fn() };
  const account = { equity: 375, availableCollateral: 375, marginUsed: 0, grossNotional: 0, abstraction: "disabled", collateral: "USDC", dex: "xyz", ts: NOW,
    positions: [], openOrders: [] } as PerpAccountSnapshot;
  const data = { refresh: vi.fn(refresh ?? (async () => q)), cached: vi.fn(() => q) };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  engine.context.mockResolvedValue({ perpAccount: account, config: {}, memory: { get: async () => null } });
  controller = new SwingController({ config: parseBotConfig({ id: "swing-test", venue: "hyperliquid", strategy: { id: "quotient-swing", config: {} } }),
    adapter: adapter as unknown as VenueAdapter, account: { venue: "hyperliquid", masterAddress: "0x0000000000000000000000000000000000000001" },
    state, statePath: join(directory, "state.sqlite"), quotientToken: "test-not-a-secret", now: () => now,
    data: data as unknown as SwingQuotientDataClient, alerter: { send: async () => {} }, log });
  return { controller, adapter, data, q, market, log, advance: (ms: number) => { now += ms; } };
}

describe("swing live startup and read-only isolation", () => {
  it("keeps the actual halt visible in the journal without logging it every tick", async () => {
    const { controller, log, advance } = setup();
    const status = { cycles: [], halted: true, haltReason: "operator", highWaterEquity: 1000, drawdownPct: 0, cashFlowsComplete: true };
    engine.status.mockResolvedValue(status);
    await controller.tick(); await controller.supervise(); await controller.tick();
    expect(log.warn).toHaveBeenCalledExactlyOnceWith("swing entries halted: operator");
    advance(5 * 60_000); await controller.supervise(); expect(log.warn).toHaveBeenCalledTimes(2);
    engine.status.mockResolvedValue({ ...status, halted: false });
    await controller.supervise(); await controller.supervise();
    expect(log.info).toHaveBeenCalledExactlyOnceWith("swing entries resumed");
    engine.status.mockResolvedValue({ ...status, haltReason: "drawdown" });
    await controller.supervise();
    expect(log.warn).toHaveBeenLastCalledWith("swing entries halted: drawdown");
    expect(engine.resume).not.toHaveBeenCalled();
  });
  it("reports a self-clearing entry pause as waiting, not halted", async () => {
    const { controller, log } = setup();
    const status = { cycles: [], halted: false, entriesPaused: "cash-flow-deferred", highWaterEquity: 1000, drawdownPct: 0, cashFlowsComplete: true };
    engine.status.mockResolvedValue(status);
    await controller.supervise(); await controller.supervise();
    expect(log.warn).toHaveBeenCalledExactlyOnceWith("swing entries wait: cash-flow-deferred");
    engine.status.mockResolvedValue({ ...status, entriesPaused: undefined });
    await controller.supervise();
    expect(log.info).toHaveBeenCalledExactlyOnceWith("swing entries resumed");
    expect(engine.resume).not.toHaveBeenCalled();
  });
  it("constructs live execution and ticks without a separate startup step", async () => {
    const { controller } = setup();
    controller.start(); await controller.refreshResearch(); await controller.tick();
    expect(engine.constructed).toHaveBeenCalledOnce();
    expect(engine.tick).toHaveBeenCalledOnce();
    expect(engine.resume).not.toHaveBeenCalled();
    const status = await controller.status();
    expect(status).not.toHaveProperty("paper"); expect(status).not.toHaveProperty("paperDiagnostics");
    expect(status).not.toHaveProperty("paperRequiredForLive"); expect(status).not.toHaveProperty("startupError");
  });
  it("does not authorize entries from status, check, dry-run, research or a tick before run", async () => {
    const { controller, adapter } = setup();
    await controller.status();
    expect((await controller.check()).account.equity).toBe(375);
    expect((await controller.dryRun()).state.lastNav).toBe(375);
    await controller.tick();
    expect(adapter.perpAccountSnapshot).toHaveBeenCalledOnce();
    expect(engine.resume).not.toHaveBeenCalled();
    expect(adapter.placeOrder).not.toHaveBeenCalled(); expect(adapter.placePerpStop).not.toHaveBeenCalled();
  });
  it("allows explicit operator recovery and preserves the engine's checks", async () => {
    const { controller } = setup(); await controller.refreshResearch();
    await controller.resume();
    expect(engine.resume).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("keeps ticking and supervising through failed research, and resume does not depend on it", async () => {
    const { controller, data, q } = setup(async () => { throw new Error("upstream unavailable"); });
    controller.start(); await controller.refreshResearch(); await controller.tick();
    expect(engine.tick).toHaveBeenCalledOnce();
    await controller.resume();
    expect(engine.resume).toHaveBeenCalledExactlyOnceWith(false);
    data.refresh.mockResolvedValueOnce(q); await controller.refreshResearch(); await controller.tick();
    expect(engine.tick).toHaveBeenCalledTimes(2);
  });
  it("supervises and ticks positions without waiting for an unresolved research request", async () => {
    let release!: (value: SwingQuotientSnapshot) => void;
    const { controller } = setup(() => new Promise(resolve => { release = resolve; }));
    controller.start(); const pending = controller.refreshResearch();
    await controller.supervise(); await controller.tick();
    expect(engine.supervise).toHaveBeenCalledOnce();
    expect(engine.tick).toHaveBeenCalledOnce();
    release({ receivedAt: NOW, assets: [], outlooks: [], excluded: [], rawResponse: {} }); await pending;
  });
  it("does not bypass an engine refusal or silently reset a drawdown", async () => {
    const { controller } = setup(); await controller.refreshResearch();
    engine.resume.mockRejectedValueOnce(new Error("loss stop requires an explicit loss-reset acknowledgement"));
    await expect(controller.resume()).rejects.toThrow("loss-reset");
    await controller.resume(true);
    expect(engine.resume).toHaveBeenLastCalledWith(true);
  });
  it("does not fall back to a pretend balance when live account NAV is missing", async () => {
    const { controller, adapter } = setup();
    engine.context.mockResolvedValue({});
    await expect(controller.dryRun()).rejects.toThrow("authoritative live account NAV");
    await expect(controller.tick()).rejects.toThrow("authoritative live account NAV");
    adapter.perpAccountSnapshot.mockResolvedValueOnce(undefined as unknown as PerpAccountSnapshot);
    await expect(controller.check()).rejects.toThrow("authoritative live account NAV");
  });
});

// packages/runtime-node/test/swing-controller-audit.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBotConfig, toCloid, type PerpAccountSnapshot, type PerpMarketSnapshot, type VenueAdapter } from "@quotient-forecasting/cassie-core";
import type { SwingOutlook, SwingSnapshot } from "@quotient-forecasting/strategy-quotient-swing";
import { SwingController } from "../src/swing-controller.js";
import type { SwingQuotientDataClient, SwingQuotientSnapshot } from "../src/swing-data.js";
import type { SqliteStateStore } from "../src/state.js";

const fixtures = vi.hoisted(() => ({
  closed: false, record: vi.fn(), recordResearch: vi.fn(), read: vi.fn(), close: vi.fn(),
  context: {} as Record<string, unknown>, execution: {} as Record<string, unknown>, resume: vi.fn(), start: vi.fn(),
}));
vi.mock("../src/swing-recordings.js", () => ({
  swingResearchHash: () => "research-config-fixture",
  SwingRecordingStore: class {
    record(...args: unknown[]) { if (fixtures.closed) throw new Error("write after close"); fixtures.record(...args); }
    recordResearch(...args: unknown[]) { if (fixtures.closed) throw new Error("research write after close"); fixtures.recordResearch(...args); }
    read(...args: unknown[]) { return fixtures.read(...args) ?? []; }
    close() { fixtures.closed = true; fixtures.close(); }
  },
}));
vi.mock("@quotient-forecasting/cassie-core", async importOriginal => ({ ...await importOriginal<object>(), Engine: class {
  async tick() { return { seq: 1, skipped: false, actions: 0, ordersPlaced: 0, errors: 0 }; }
  async strategyContext() { return fixtures.context; }
  async perpStatus() { return fixtures.execution; }
  async supervisePerps() {}
  async startPerps() { fixtures.start(); }
  async cancelAllResting() {}
  async resumePerps(acknowledgeLossReset: boolean) { fixtures.resume(acknowledgeLossReset); }
} }));

const NOW = Date.parse("2026-09-04T15:00:00Z"), HOUR = 3_600_000;
let controller: SwingController | undefined;
beforeEach(() => {
  vi.clearAllMocks(); fixtures.closed = false;
  fixtures.execution = { halted: false, cycles: [], highWaterEquity: 1400, drawdownPct: 0, cashFlowsComplete: true, lastReconciledAt: NOW };
  fixtures.context = { perpExecution: fixtures.execution, perpAccount: { equity: 1400, availableCollateral: 1400,
    marginUsed: 0, grossNotional: 0, abstraction: "disabled", collateral: "USDC", dex: "xyz", ts: NOW,
    positions: [], openOrders: [] } as PerpAccountSnapshot };
});
afterEach(async () => { if (!fixtures.closed) await controller?.shutdown(false); controller = undefined; });

function forecast(): SwingOutlook {
  return { id: "outlook:original", assetKey: "company:nvda", marketRef: "xyz:NVDA", basisId: "basis:nvda", targetFamilyKey: "family:nvda",
    anchorAt: NOW + 48 * HOUR, publishedAt: NOW - HOUR, observedAt: NOW - HOUR - 60_000,
    status: "active", freshnessState: "fresh", freshnessReason: null, mode: "signal", basisVerified: true, provider: "hyperliquid",
    priceField: "mid", window: "point", candleInterval: null,
    groundingStatus: "actionable", rangeStatus: "complete", method: "full_quantile_curve", directionalSide: "bullish",
    spotAtObservation: 100, expectedPrice: 104, expectedLogReturn: .038, medianPrice: 103, p10: 94, p25: 98, p75: 108, p90: 112, sigmaTotal: .05,
    spotGapSigma: 0.59, scoreSigma: 0.6, probabilityAboveSpot: 0.7 };
}
function setup() {
  let now = NOW;
  const q: SwingQuotientSnapshot = { receivedAt: NOW - 30_000,
    assets: [{ assetKey: "company:nvda", marketRef: "xyz:NVDA", assetClass: "equity", name: "NVIDIA" }],
    outlooks: [forecast()], excluded: [], rawResponse: { contract: "asset-price/1", series: [{ asset_key: "company:nvda", mode: "signal" }] } };
  const m = { instrument: { marketRef: "xyz:NVDA", dex: "xyz", assetId: 110_001, collateralToken: 0,
    active: true, maxLeverage: 20, onlyIsolated: true, strictIsolated: true, maintenanceMarginRate: .025,
    szDecimals: 3, minNotional: 10, deployerFeeScale: 1, growthMode: false,
    marginTiers: [{ lowerBound: 0, maxLeverage: 20, maintenanceMarginRate: .025 }] },
    book: { marketRef: "xyz:NVDA", bids: [{ price: 99.99, size: 100 }], asks: [{ price: 100.01, size: 100 }], ts: NOW - 5000 },
    quote: { marketRef: "xyz:NVDA", price: 100, volume24h: 1_234_567, ts: NOW - 5000 }, markPrice: 100.01, oraclePrice: 100,
    fundingRateHourly: -.000012, makerFeeRate: .0003, takerFeeRate: .0009, ts: NOW - 10_000 } as unknown as PerpMarketSnapshot;
  const adapter = { perpMarketSnapshot: vi.fn(async () => m), placeOrder: vi.fn(), placePerpStop: vi.fn(),
    perpAccountSnapshot: vi.fn(async () => fixtures.context.perpAccount as PerpAccountSnapshot) };
  const data = { refresh: vi.fn(async () => q), cached: vi.fn(() => q) };
  const memory = new Map<string, string>();
  const state = { get: vi.fn(async (key: string) => memory.get(key) ?? null), set: vi.fn(async (key: string, value: string) => { memory.set(key, value); }) };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  controller = new SwingController({ config: parseBotConfig({ id: "swing-audit", venue: "hyperliquid", strategy: { id: "quotient-swing", config: {} } }),
    adapter: adapter as unknown as VenueAdapter, account: { venue: "hyperliquid", masterAddress: "0x0000000000000000000000000000000000000001" },
    state: state as unknown as SqliteStateStore, statePath: "/unused-fixture/state.sqlite", quotientToken: "test-token", now: () => now,
    data: data as unknown as SwingQuotientDataClient, alerter: { send: async () => {} }, log });
  return { controller, q, m, adapter, data, state, log, memory, advance: (ms: number) => { now += ms; } };
}
function recorded(): SwingSnapshot { return fixtures.record.mock.lastCall![0] as SwingSnapshot; }

describe("runtime preserves source and account contract facts", () => {
  it("preflights inputs and NAV without buying research or authorizing entries", async () => {
    const { controller, data, adapter } = setup();
    expect(await controller.check()).toMatchObject({ ok: true, assets: 1, count: 1, eligibleOutlooks: 1, account: { equity: 1400 } });
    expect(data.refresh).toHaveBeenCalledOnce(); expect(adapter.perpMarketSnapshot).toHaveBeenCalledOnce();
    expect(fixtures.start).not.toHaveBeenCalled(); expect(fixtures.resume).not.toHaveBeenCalled();
    expect(adapter.placeOrder).not.toHaveBeenCalled(); expect(adapter.placePerpStop).not.toHaveBeenCalled();
  });
  it("counts only outlooks that pass the freshness and gap rules as eligible", async () => {
    const { controller, q } = setup();
    q.outlooks.push({ ...forecast(), id: "outlook:neutral", anchorAt: NOW + 72 * HOUR, directionalSide: "neutral", spotGapSigma: 0.02 });
    q.outlooks.push({ ...forecast(), id: "outlook:stale", anchorAt: NOW + 96 * HOUR, publishedAt: NOW - 3 * HOUR, observedAt: NOW - 3 * HOUR });
    await controller.refreshResearch();
    expect((await controller.status()).research).toMatchObject({ outlooks: 3, eligibleOutlooks: 1 });
  });
  it("shares in-flight paid inputs between simultaneous preflight and research", async () => {
    const { controller, data, q } = setup();
    let release!: (value: SwingQuotientSnapshot) => void;
    data.refresh.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const check = controller.check(), research = controller.refreshResearch();
    expect(data.refresh).toHaveBeenCalledOnce();
    release(q); await Promise.all([check, research]);
    expect(fixtures.recordResearch.mock.calls.filter(args => args[2].kind === "quotient")).toHaveLength(1);
  });
  it("fails preflight on input failures without starting execution", async () => {
    const { controller, data } = setup();
    data.refresh.mockRejectedValueOnce(new Error("Q unavailable"));
    await expect(controller.check()).rejects.toThrow("Q unavailable");
    expect(fixtures.start).not.toHaveBeenCalled();
  });
  it("polls exact outlook candidates instead of all 52 directory assets", async () => {
    const { controller, q, adapter } = setup();
    for (let i = 0; i < 51; i++) q.assets.push({ assetKey: `company:unused-${i}`, marketRef: `xyz:UNUSED${i}`, assetClass: "equity", name: "Unused" });
    await controller.refreshResearch(); await controller.tick();
    expect(adapter.perpMarketSnapshot.mock.calls.every((args: unknown[]) => args[1] === "xyz:NVDA")).toBe(true);
    expect(recorded().coveredAssetKeys).toHaveLength(52);
    expect(recorded().markets).toHaveLength(1);
    expect((await controller.status()).research).toMatchObject({ assets: 52, markets: 1, outlooks: 1, eligibleOutlooks: 1 });
  });
  it("keeps pending cycles supervised even when their asset has no current outlook", async () => {
    const { controller, q, adapter } = setup();
    q.assets = []; q.outlooks = [];
    fixtures.execution.cycles = [{ status: "pending", marketRef: "xyz:NVDA", provenance: { record: { assetKey: "company:nvda", marketRef: "xyz:NVDA" } } }];
    await controller.supervise(); await controller.refreshMarkets();
    expect(adapter.perpMarketSnapshot).toHaveBeenCalledOnce();
    expect(adapter.perpMarketSnapshot.mock.calls[0]?.[1]).toBe("xyz:NVDA");
  });
  it("backs off failing symbols without refreshing their clocks or repeating identical warnings", async () => {
    const { controller, adapter, log, advance } = setup();
    await controller.refreshResearch();
    adapter.perpMarketSnapshot.mockRejectedValue(new Error("HTTP 429: rate limit"));
    await controller.refreshMarkets();
    expect(adapter.perpMarketSnapshot).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledOnce();
    await controller.refreshMarkets(); advance(59_999); await controller.refreshMarkets();
    expect(adapter.perpMarketSnapshot).toHaveBeenCalledTimes(2);
    advance(1); await controller.refreshMarkets();
    expect(adapter.perpMarketSnapshot).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledOnce();
    expect((await controller.status()).research.marketFailures).toEqual([{ marketRef: "xyz:NVDA", error: "HTTP 429: rate limit", failures: 2, retryAt: NOW + 180_000 }]);
    await controller.tick();
    expect(recorded().markets[0]!.book.ts).toBe(NOW - 5000);
  });
  it("honors request-budget deferrals at info level without hiding real HTTP 429 failures", async () => {
    const { controller, adapter, log, advance } = setup();
    adapter.perpMarketSnapshot.mockRejectedValue(Object.assign(new Error("Hyperliquid info deferred: rate-budget"), { retryAfterMs: 45_000 }));
    await controller.refreshResearch();
    expect(log.warn).not.toHaveBeenCalled(); expect(log.info).toHaveBeenCalledOnce();
    expect((await controller.status()).research.marketFailures[0]).toMatchObject({ deferred: true, retryAt: NOW + 45_000 });
    advance(44_999); await controller.refreshMarkets(); expect(adapter.perpMarketSnapshot).toHaveBeenCalledOnce();
    advance(1); adapter.perpMarketSnapshot.mockRejectedValue(new Error("HTTP 429")); await controller.refreshMarkets();
    expect(log.warn).toHaveBeenCalledOnce();
    expect((await controller.status()).research.marketFailures[0]).not.toHaveProperty("deferred");
  });
  it.each([[Infinity, 15_000], [-1, 15_000], [3_600_000, 900_000]])("bounds retryAfterMs %s safely", async (retryAfterMs, expectedDelay) => {
    const { controller, adapter } = setup();
    adapter.perpMarketSnapshot.mockRejectedValue(Object.assign(new Error("Hyperliquid info deferred: rate-budget"), { retryAfterMs }));
    await controller.refreshResearch();
    expect((await controller.status()).research.marketFailures[0]!.retryAt).toBe(NOW + expectedDelay);
  });
  it("clears a recovered symbol's cooldown and exposes distinct failures immediately", async () => {
    const { controller, adapter, m, log, advance } = setup();
    adapter.perpMarketSnapshot.mockRejectedValue(new Error("missing margin table"));
    await controller.refreshResearch(); advance(15_000);
    adapter.perpMarketSnapshot.mockRejectedValue(new Error("HTTP 429"));
    await controller.refreshMarkets();
    expect(log.warn).toHaveBeenCalledTimes(2);
    advance(120_000); adapter.perpMarketSnapshot.mockResolvedValue(m);
    await controller.refreshMarkets();
    expect((await controller.status()).research.marketFailures).toEqual([]);
  });
  it("refreshes, records usable data and starts live execution without a calendar or activation", async () => {
    const { controller, data } = setup();
    controller.start(); await controller.refreshResearch(); await controller.tick();
    expect(data.refresh).toHaveBeenCalledOnce();
    expect(fixtures.record).toHaveBeenCalledWith(expect.any(Object), "live", "research-config-fixture", true);
    expect(recorded().markets[0]).not.toHaveProperty("calendarVerifiedUntil");
    expect(recorded().markets[0]).not.toHaveProperty("sessionOpen");
    expect(recorded().markets[0]).not.toHaveProperty("events");
    expect(fixtures.start).toHaveBeenCalledOnce(); expect(fixtures.resume).not.toHaveBeenCalled();
    expect(await controller.check()).not.toHaveProperty("calendarConfigured");
  });
  it("marks an observation unusable when no current outlook remains, without any audit predicate", async () => {
    const { controller, q } = setup();
    q.outlooks[0]!.publishedAt = NOW - 3 * HOUR; q.outlooks[0]!.observedAt = NOW - 3 * HOUR;
    await controller.refreshResearch(); await controller.tick();
    expect(fixtures.record.mock.lastCall![3]).toBe(false);
    expect(recorded().markets[0]!.outlooks[0]).not.toHaveProperty("sourceAudit");
  });
  it("still refuses operator recovery when research has failed", async () => {
    const { controller, data } = setup();
    data.refresh.mockRejectedValueOnce(new Error("Q unavailable"));
    await controller.refreshResearch();
    await expect(controller.resume()).rejects.toThrow("resuming trading requires current research and venue data");
    expect(fixtures.resume).not.toHaveBeenCalled();
  });
  it("maps signed hourly funding, actual book/funding timestamps, volume, fees and original forecast fields exactly", async () => {
    const { controller, m } = setup(); await controller.refreshResearch(); await controller.tick();
    const market = recorded().markets[0]!;
    expect(market).toMatchObject({ assetKey: "company:nvda", marketRef: "xyz:NVDA", assetClass: "equity", markPrice: 100.01,
      oraclePrice: 100, volume24hUsd: 1_234_567, fundingHourly: -.000012,
      fundingObservedAt: NOW - 10_000, makerFeeRate: .0003, takerFeeRate: .0009 });
    for (const key of ["candles1h", "candles4h", "fundingHistoryHourly", "assessment", "assessments", "themes"]) expect(market).not.toHaveProperty(key);
    expect(market.book.ts).toBe(m.book.ts);
    expect(market.outlooks[0]).toMatchObject({ anchorAt: NOW + 48 * HOUR, publishedAt: NOW - HOUR, observedAt: NOW - HOUR - 60_000,
      spotGapSigma: 0.59, scoreSigma: 0.6, freshnessReason: null, mode: "signal" });
  });
  it("archives the untouched raw wire at the real receipt time", async () => {
    const { controller, q } = setup(); await controller.refreshResearch();
    expect(fixtures.recordResearch).toHaveBeenCalledWith(q.receivedAt, "research-config-fixture", expect.objectContaining({ kind: "quotient", rawResponse: q.rawResponse }));
    expect(fixtures.recordResearch).toHaveBeenCalledOnce();
  });
  it("classifies ledger-owned targets apart from stops, exits and entries", async () => {
    const { controller } = setup();
    fixtures.execution.cycles = [{ status: "open", marketRef: "xyz:NVDA", targetOrderId: "o-target", targetClientId: "cycle-1-tp-2",
      provenance: { record: { assetKey: "company:nvda", marketRef: "xyz:NVDA" } } },
    { status: "closed", marketRef: "xyz:NVDA", targetOrderId: "o-closed", provenance: { record: { assetKey: "company:nvda", marketRef: "xyz:NVDA" } } }];
    const order = (id: string, extra: Record<string, unknown>) => ({ id, marketRef: "xyz:NVDA", side: "SELL", size: 1, filledSize: 0, price: 103, createdAt: NOW - 1000, ...extra });
    fixtures.context = { perpExecution: fixtures.execution, perpAccount: { ...(fixtures.context.perpAccount as PerpAccountSnapshot),
      openOrders: [order("o-stop", { isTrigger: true, reduceOnly: true }), order("o-target", { reduceOnly: true }),
        order("o-target-by-cloid", { reduceOnly: true, clientId: toCloid("cycle-1-tp-2").toUpperCase() }),
        order("o-closed", { reduceOnly: true }), order("o-exit", { reduceOnly: true }), order("o-entry", { reduceOnly: false })] } as PerpAccountSnapshot };
    await controller.refreshResearch(); await controller.tick();
    expect(recorded().openOrders.map(o => [o.id, o.purpose])).toEqual([["o-stop", "stop"], ["o-target", "target"], ["o-target-by-cloid", "target"],
      ["o-closed", "exit"], ["o-exit", "exit"], ["o-entry", "entry"]]);
  });
  it("reports per-reason rejection counts from the last strategy report", async () => {
    const { controller, memory } = setup();
    memory.set("strategy:quotient-swing:report", JSON.stringify({ state: {}, decisions: [], candidates: [], drawdown: 0,
      rejected: [{ marketRef: "xyz:NVDA", reason: "gap_below_min" }, { marketRef: "xyz:GOLD", reason: "gap_below_min" }, { marketRef: "xyz:CL", reason: "stale_book" }] }));
    await controller.refreshResearch(); await controller.tick();
    expect((await controller.status()).research.rejectionCounts).toEqual({ gap_below_min: 2, stale_book: 1 });
  });
  it("failed venue refresh preserves the old book and funding clock", async () => {
    const { controller, adapter, advance } = setup(); await controller.refreshResearch(); await controller.tick();
    adapter.perpMarketSnapshot.mockRejectedValueOnce(new Error("venue unavailable")); advance(120_000);
    await controller.refreshMarkets(); await controller.tick();
    expect(recorded().now).toBe(NOW + 120_000);
    expect(recorded().markets[0]!.book.ts).toBe(NOW - 5000);
    expect(recorded().markets[0]!.fundingObservedAt).toBe(NOW - 10_000);
    expect(fixtures.record.mock.lastCall![3]).toBe(false);
  });
  it("failed Q refresh cannot rewrite receipt/source freshness", async () => {
    const { controller, data, advance } = setup(); await controller.refreshResearch();
    data.refresh.mockRejectedValueOnce(new Error("Q unavailable")); advance(HOUR);
    await controller.refreshResearch(); await controller.tick();
    expect(fixtures.recordResearch).toHaveBeenCalledTimes(1);
    expect(recorded().markets[0]!.outlooks[0]!.publishedAt).toBe(NOW - HOUR);
    expect((await controller.status()).research.error).toBe("Q unavailable");
  });
  it("uses authoritative account NAV once, without adding unrealized P&L a second time", async () => {
    const { controller } = setup();
    fixtures.context = { perpExecution: fixtures.execution, perpAccount: {
      equity: 1400, availableCollateral: 1200, marginUsed: 200, grossNotional: 400, abstraction: "disabled", collateral: "USDC", dex: "xyz", ts: NOW - 1000,
      positions: [{ marketRef: "xyz:NVDA", side: "LONG", size: 4, avgPrice: 75, currentPrice: 100, unrealizedPnl: 100, marginUsed: 200,
        leverage: 2, liquidationPrice: 40, marginMode: "isolated" }], openOrders: [],
    } as PerpAccountSnapshot };
    await controller.refreshResearch(); await controller.tick();
    expect(recorded()).toMatchObject({ nav: 1400, availableMarginUsd: 1200, accountObservedAt: NOW - 1000, accountReconciled: true });
    expect(recorded().positions[0]).toMatchObject({ isolatedMarginUsd: 200, liquidationPrice: 40, leverage: 2 });
  });
  it("replays the captured live observations offline without starting execution", async () => {
    const { controller, adapter } = setup();
    await controller.refreshResearch(); await controller.tick();
    fixtures.read.mockReturnValueOnce([recorded()]);
    controller.replay({ from: NOW - HOUR, until: NOW });
    expect(fixtures.read).toHaveBeenCalledExactlyOnceWith("research-config-fixture", "live", NOW - HOUR, NOW);
    expect(fixtures.start).not.toHaveBeenCalled(); expect(fixtures.resume).not.toHaveBeenCalled();
    expect(adapter.placeOrder).not.toHaveBeenCalled(); expect(adapter.placePerpStop).not.toHaveBeenCalled(); expect(adapter.perpAccountSnapshot).not.toHaveBeenCalled();
  });
});

describe("shutdown and asynchronous research", () => {
  it("does not write to a closed recording store when a pending Q response finishes", async () => {
    const { controller, data, q, state } = setup();
    let release!: (q: SwingQuotientSnapshot) => void;
    data.refresh.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = controller.refreshResearch(); await controller.shutdown(false); release(q); await pending;
    expect(fixtures.close).toHaveBeenCalledOnce(); expect(fixtures.recordResearch).not.toHaveBeenCalled();
    expect(fixtures.record).not.toHaveBeenCalled(); expect(state.set).not.toHaveBeenCalled();
  });
  it("does not turn an in-flight venue result into a post-shutdown state write", async () => {
    const { controller, adapter, m, state } = setup();
    let release!: (m: PerpMarketSnapshot) => void;
    adapter.perpMarketSnapshot.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = controller.refreshResearch();
    await vi.waitFor(() => expect(adapter.perpMarketSnapshot).toHaveBeenCalledOnce());
    await controller.shutdown(false); release(m); await pending;
    expect(fixtures.recordResearch).toHaveBeenCalledTimes(1); expect(fixtures.record).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalled();
  });
});

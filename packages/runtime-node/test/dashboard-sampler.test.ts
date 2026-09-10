// packages/runtime-node/test/dashboard-sampler.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotPortfolio } from "@quotient-forecasting/cassie-core";
import { MetricsRegistry } from "@quotient-forecasting/cassie-core";
import { DashboardSampler, dashboardSampleMinutesFromEnv, equitySampleFromPortfolio } from "../src/dashboard/sampler.js";
import type { EquitySampleRow } from "../src/state.js";

const MINUTE = 60_000;

function portfolio(venue: BotPortfolio["venue"] = "polymarket"): BotPortfolio {
  return {
    botId: "b",
    venue,
    balances: [{ asset: "USDC", total: 100, available: 60 }, { asset: "pUSD", total: 10, available: 10 }],
    positions: [{ marketRef: "m", side: "YES", size: 5, avgPrice: 0.4 }],
    openOrders: [{ id: "o" } as never, { id: "p" } as never],
    equity: 130,
    unrealizedPnl: 2.5,
    realizedPnl: -1,
  };
}

function fakeStore() {
  const equity: EquitySampleRow[] = [];
  const metrics: Array<{ ts: number; keys: string[] }> = [];
  const prunes: number[] = [];
  return {
    equity,
    metrics,
    prunes,
    insertEquitySample: (row: EquitySampleRow) => { equity.push(row); },
    insertMetricSamples: (ts: number, deltas: Array<{ key: string }>) => { metrics.push({ ts, keys: deltas.map((d) => d.key) }); },
    pruneSamples: (olderThan: number) => { prunes.push(olderThan); return { equity: 0, metrics: 0 }; },
  };
}

const log = { info: () => {}, warn: vi.fn(), error: () => {}, debug: () => {} };

describe("equitySampleFromPortfolio", () => {
  it("uses total collateral for prediction venues and available for perps", () => {
    expect(equitySampleFromPortfolio(portfolio(), 7)).toEqual({ ts: 7, equity: 130, cash: 110, unrealizedPnl: 2.5, realizedPnl: -1, positions: 1, resting: 2 });
    expect(equitySampleFromPortfolio(portfolio("hyperliquid"), 7).cash).toBe(70);
  });
});

describe("dashboardSampleMinutesFromEnv", () => {
  it("defaults to five and bounds the override", () => {
    expect(dashboardSampleMinutesFromEnv({})).toBe(5);
    expect(dashboardSampleMinutesFromEnv({ CASSIE_DASHBOARD_SAMPLE_MINUTES: "2" })).toBe(2);
    expect(() => dashboardSampleMinutesFromEnv({ CASSIE_DASHBOARD_SAMPLE_MINUTES: "0" })).toThrow(/1 to 1440/);
    expect(() => dashboardSampleMinutesFromEnv({ CASSIE_DASHBOARD_SAMPLE_MINUTES: "soon" })).toThrow();
  });
});

describe("DashboardSampler", () => {
  beforeEach(() => { vi.useFakeTimers(); log.warn.mockClear(); });
  afterEach(() => vi.useRealTimers());

  it("samples after the warm-up, then on the interval, and prunes once", async () => {
    const store = fakeStore();
    const metrics = new MetricsRegistry();
    metrics.record("polymarket.book", { ok: true, ms: 1 });
    const sampler = new DashboardSampler({ store, metrics, portfolio: async () => portfolio(), log, intervalMs: 5 * MINUTE, initialDelayMs: MINUTE, now: () => Date.now() });
    sampler.start();
    sampler.start();
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(store.equity).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.equity).toHaveLength(1);
    expect(store.metrics[0]?.keys).toEqual(["polymarket.book"]);
    expect(store.prunes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(store.equity).toHaveLength(2);
    expect(store.prunes).toHaveLength(1);
    expect(sampler.status()).toMatchObject({ errors: 0, intervalMinutes: 5 });
    expect(sampler.status().lastSampleAt).toBeDefined();
    sampler.stop();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(store.equity).toHaveLength(2);
  });

  it("still flushes metrics when the venue read fails, and warns once per message", async () => {
    const store = fakeStore();
    const metrics = new MetricsRegistry();
    metrics.record("k", { ok: true, ms: 1 });
    const sampler = new DashboardSampler({ store, metrics, portfolio: async () => { throw new Error("venue down"); }, log, intervalMs: MINUTE, initialDelayMs: 0 });
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    metrics.record("k", { ok: true, ms: 1 });
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(store.equity).toHaveLength(0);
    expect(store.metrics).toHaveLength(2);
    expect(sampler.status()).toMatchObject({ errors: 2, lastError: "equity sample skipped: venue down" });
    expect(log.warn).toHaveBeenCalledTimes(1);
    sampler.stop();
  });

  it("does not write after stop even if a sample was in flight", async () => {
    const store = fakeStore();
    let release!: () => void;
    const sampler = new DashboardSampler({
      store, metrics: new MetricsRegistry(), log, intervalMs: MINUTE, initialDelayMs: 0,
      portfolio: () => new Promise<BotPortfolio>((resolve) => { release = () => resolve(portfolio()); }),
    });
    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    sampler.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.equity).toHaveLength(0);
    expect(store.metrics).toHaveLength(0);
  });

  it("counts a store failure without throwing", async () => {
    const store = fakeStore();
    store.insertEquitySample = () => { throw new Error("database connection is not open"); };
    const sampler = new DashboardSampler({ store, metrics: new MetricsRegistry(), portfolio: async () => portfolio(), log, intervalMs: MINUTE, initialDelayMs: 0 });
    await sampler.sampleOnce();
    expect(sampler.status()).toMatchObject({ errors: 1, lastError: "equity sample not written: database connection is not open" });
  });
});

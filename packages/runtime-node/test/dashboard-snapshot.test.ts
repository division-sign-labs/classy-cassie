// packages/runtime-node/test/dashboard-snapshot.test.ts
import { describe, expect, it } from "vitest";
import { MetricsRegistry, parseBotConfig } from "@quotient-forecasting/cassie-core";
import type { BotPortfolio, ErrorRecord } from "@quotient-forecasting/cassie-core";
import {
  DashboardSnapshotCache,
  buildDashboardSnapshot,
  downsample,
  engineMetrics,
  hourlyBins,
  offlineDashboardSnapshot,
  parseDashboardRange,
  rangeSince,
  summarizeHistory,
  type DashboardServiceView,
} from "../src/dashboard/snapshot.js";
import { EngineCounters } from "../src/dashboard/counters.js";
import type { EquitySampleRow } from "../src/state.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-09T12:00:00Z");

function point(ts: number, equity: number): EquitySampleRow {
  return { ts, equity, cash: equity / 2, unrealizedPnl: 0, realizedPnl: 0, positions: 1, resting: 0 };
}

function portfolio(): BotPortfolio {
  return {
    botId: "bot-1",
    venue: "polymarket",
    balances: [{ asset: "USDC", total: 100, available: 90 }],
    positions: [],
    openOrders: [{ id: "o1", marketRef: "m", side: "BUY", price: 0.5, size: 10 } as never],
    equity: 100,
    unrealizedPnl: 0,
    realizedPnl: 0,
  };
}

function view(over: Partial<DashboardServiceView> = {}, samples: EquitySampleRow[] = []): DashboardServiceView {
  const metrics = new MetricsRegistry({ now: () => NOW - 3 * DAY });
  const counters = new EngineCounters();
  return {
    config: parseBotConfig({ id: "bot-1", venue: "polymarket", strategy: { id: "flip-flat" } }),
    identity: { runtime: "droplet", protocol: 2, botId: "bot-1", version: "0.5.0", region: "blr1", deploymentId: "do-1" },
    startedAt: NOW - 2 * DAY,
    status: () => ({ active: true, lastTickAt: NOW - 30_000, tickIntervalMin: 1 }),
    paused: async () => false,
    portfolio: async () => portfolio(),
    logs: async () => [
      { ts: NOW - 2000, level: "error", code: "a", message: "older" },
      { ts: NOW - 1000, level: "warn", code: "b", message: "newer" },
    ] as ErrorRecord[],
    signalCheckMinutes: () => 5,
    metrics,
    counters,
    samplerStatus: () => ({ lastSampleAt: NOW - 60_000, errors: 0, intervalMinutes: 5 }),
    equitySamples: (q) => samples.filter((s) => q.since === undefined || s.ts >= q.since),
    metricTotals: () => [],
    metricHourly: () => [],
    hyperliquidSchedulerStats: () => undefined,
    ...over,
  };
}

describe("range and downsampling", () => {
  it("parses ranges and rejects others", () => {
    expect(parseDashboardRange(null)).toBe("24h");
    expect(parseDashboardRange("7d")).toBe("7d");
    expect(() => parseDashboardRange("1y")).toThrow(/24h, 7d, 30d, all/);
    expect(rangeSince("24h", NOW)).toBe(NOW - DAY);
    expect(rangeSince("all", NOW)).toBeUndefined();
  });

  it("keeps first and last and at most max points", () => {
    const points = Array.from({ length: 5000 }, (_, i) => point(i * 60_000, 100 + (i % 7)));
    const out = downsample(points, 600);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.length).toBeGreaterThan(500);
    expect(out[0]).toEqual(points[0]);
    expect(out[out.length - 1]).toEqual(points[points.length - 1]);
    for (let i = 1; i < out.length; i++) expect(out[i]!.ts).toBeGreaterThan(out[i - 1]!.ts);
    expect(downsample(points.slice(0, 10), 600)).toHaveLength(10);
  });

  it("summarises high water, drawdown and change", () => {
    const s = summarizeHistory([point(0, 100), point(1, 120), point(2, 90), point(3, 110)], 5);
    expect(s.highWater).toBe(120);
    expect(s.maxDrawdownPct).toBeCloseTo(25);
    expect(s.changeUsd).toBe(10);
    expect(s.changePct).toBeCloseTo(10);
    expect(s.sampleMinutes).toBe(5);
    expect(summarizeHistory([], 5)).toEqual({ highWater: 0, maxDrawdownPct: 0, changeUsd: 0, changePct: 0, sampleMinutes: 5 });
    expect(summarizeHistory([point(0, 0), point(1, 5)], 5).changePct).toBe(0);
  });
});

describe("buildDashboardSnapshot", () => {
  it("assembles bot, portfolio, history, metrics and errors", async () => {
    const samples = [point(NOW - 3 * DAY, 90), point(NOW - 2 * DAY, 95), point(NOW - 3600_000, 100)];
    const v = view({}, samples);
    v.metrics.record("polymarket.placeOrder", { ok: true, ms: 10 });
    v.metrics.record("polymarket.placeOrder", { ok: false, ms: 20, error: "rejected" });
    v.metrics.record("polymarket.cancelOrder", { ok: true, ms: 5 });
    (v.counters as EngineCounters).ticks = 4;
    (v.counters as EngineCounters).alertsByKind["skipped-order"] = 2;
    const snap = await buildDashboardSnapshot(v, { range: "7d", now: () => NOW });
    expect(snap.schema).toBe(1);
    expect(snap.bot).toMatchObject({ id: "bot-1", venue: "polymarket", strategy: "flip-flat", runtime: "droplet", version: "0.5.0",
      region: "blr1", active: true, paused: false, tickIntervalMin: 1, positionCheckSeconds: 60, signalCheckMinutes: 5 });
    expect(snap.bot.lastTickAt).toBe(new Date(NOW - 30_000).toISOString());
    expect(snap.portfolio?.equity).toBe(100);
    expect(snap.orders).toHaveLength(1);
    expect(snap.history.range).toBe("7d");
    expect(snap.history.points).toHaveLength(3);
    expect(snap.history.summary).toMatchObject({ highWater: 100, changeUsd: 10, sampleMinutes: 5 });
    expect(snap.metrics.sinceStart.rows.map((r) => r.key)).toEqual(["polymarket.cancelOrder", "polymarket.placeOrder"]);
    expect(snap.metrics.sinceStart.rows[1]).toMatchObject({ calls: 2, errors: 1, avgMs: 15, maxMs: 20, lastError: "rejected" });
    expect(snap.metrics.last24h.rows.map((r) => r.calls)).toEqual([1, 2]);
    expect(snap.metrics.last24h.hourly).toEqual([{ hourTs: Math.floor(NOW / 3600_000) * 3600_000, calls: 3, errors: 1 }]);
    expect(snap.metrics.engine).toMatchObject({ ticks: 4, ordersPlaced: 1, ordersCanceled: 1, ordersSkipped: 2 });
    expect(snap.metrics.hyperliquidScheduler).toBeUndefined();
    expect(snap.metrics.sampler).toEqual({ lastSampleAt: new Date(NOW - 60_000).toISOString(), errors: 0 });
    expect(snap.errors.map((e) => e.code)).toEqual(["b", "a"]);
  });

  it("limits history to the range", async () => {
    const samples = [point(NOW - 3 * DAY, 90), point(NOW - 3600_000, 100)];
    const snap = await buildDashboardSnapshot(view({}, samples), { range: "24h", now: () => NOW });
    expect(snap.history.points).toHaveLength(1);
  });

  it("survives a venue read failure", async () => {
    const snap = await buildDashboardSnapshot(view({ portfolio: async () => { throw new Error("venue down"); } }), { range: "24h", now: () => NOW });
    expect(snap.portfolio).toBeNull();
    expect(snap.portfolioError).toBe("venue down");
    expect(snap.orders).toEqual([]);
  });

  it("reads halt state from market-make and swing status", async () => {
    const mm = await buildDashboardSnapshot(view({ status: () => ({ active: true, tickIntervalMin: 1, marketMake: { halted: true, haltReason: "review", lifecycle: "HALTED" } }) }), { range: "24h", now: () => NOW });
    expect(mm.bot).toMatchObject({ halted: true, haltReason: "review", lifecycle: "HALTED" });
    const swing = await buildDashboardSnapshot(view({
      config: parseBotConfig({ id: "bot-1", venue: "hyperliquid", strategy: { id: "quotient-swing" } }),
      swingStatus: async () => ({ halted: true, execution: { haltReason: "drawdown" } }),
      hyperliquidSchedulerStats: () => ({ queued: 0, active: 0, backgroundActive: 0, weightInWindow: 12, cooldownRemainingMs: 0, requests: 3, coalesced: 0, rejected: 0, rateLimited: 0 }),
    }), { range: "24h", now: () => NOW });
    expect(swing.bot).toMatchObject({ halted: true, haltReason: "drawdown" });
    expect(swing.metrics.hyperliquidScheduler?.weightInWindow).toBe(12);
  });

  it("derives engine order counts from ok calls only", () => {
    const counters = new EngineCounters();
    counters.alertsSent = 3;
    const out = engineMetrics(counters.snapshot(), {
      "hyperliquid.placeOrder": { calls: 5, errors: 2, totalMs: 0, maxMs: 0 },
      "hyperliquid.placePerpStop": { calls: 1, errors: 0, totalMs: 0, maxMs: 0 },
      "hyperliquid.cancelAll": { calls: 2, errors: 0, totalMs: 0, maxMs: 0 },
      "hyperliquid.book": { calls: 50, errors: 0, totalMs: 0, maxMs: 0 },
    });
    expect(out).toMatchObject({ ordersPlaced: 4, ordersCanceled: 2, ordersSkipped: 0, alertsSent: 3 });
  });

  it("adds pending deltas to the current hour", () => {
    const hour = Math.floor(NOW / 3600_000) * 3600_000;
    expect(hourlyBins([{ hourTs: hour - 3600_000, calls: 2, errors: 0 }], [{ key: "k", calls: 3, errors: 1, totalMs: 0, maxMs: 0 }], NOW)).toEqual([
      { hourTs: hour - 3600_000, calls: 2, errors: 0 },
      { hourTs: hour, calls: 3, errors: 1 },
    ]);
  });
});

describe("DashboardSnapshotCache", () => {
  it("shares one build per range within the ttl and drops a failed build", async () => {
    let t = 0;
    let builds = 0;
    const cache = new DashboardSnapshotCache(async (range) => {
      builds += 1;
      if (range === "7d") throw new Error("nope");
      return { history: { range } } as never;
    }, 10_000, () => t);
    await Promise.all([cache.get("24h"), cache.get("24h")]);
    expect(builds).toBe(1);
    t = 5_000;
    await cache.get("24h");
    expect(builds).toBe(1);
    t = 20_000;
    await cache.get("24h");
    expect(builds).toBe(2);
    await expect(cache.get("7d")).rejects.toThrow("nope");
    await expect(cache.get("7d")).rejects.toThrow("nope");
    expect(builds).toBe(4);
  });
});

describe("offlineDashboardSnapshot", () => {
  it("builds history, persisted metrics and errors without a portfolio", async () => {
    const samples = [point(NOW - 20 * 60_000, 50), point(NOW - 15 * 60_000, 52), point(NOW - 10 * 60_000, 51)];
    const store = {
      readEquitySamples: (q: { since?: number }) => samples.filter((s) => q.since === undefined || s.ts >= q.since),
      readMetricTotals: () => [{ key: "polymarket.book", calls: 9, errors: 1, totalMs: 90, maxMs: 30 }],
      readMetricHourly: () => [{ hourTs: Math.floor(NOW / 3600_000) * 3600_000, calls: 9, errors: 1 }],
      readErrors: async () => [{ ts: NOW - 5000, level: "error", code: "z", message: "m" }] as ErrorRecord[],
    };
    const snap = await offlineDashboardSnapshot({ config: parseBotConfig({ id: "bot-1", venue: "polymarket" }), store, range: "24h", now: () => NOW });
    expect(snap.bot).toMatchObject({ id: "bot-1", runtime: "local", active: false, paused: false, version: "unknown" });
    expect(snap.portfolio).toBeNull();
    expect(snap.history.points).toHaveLength(3);
    expect(snap.history.summary.sampleMinutes).toBe(5);
    expect(snap.metrics.last24h.rows[0]).toMatchObject({ key: "polymarket.book", calls: 9, avgMs: 10 });
    expect(snap.metrics.sinceStart.rows).toEqual([]);
    expect(snap.errors[0]?.code).toBe("z");
  });
});

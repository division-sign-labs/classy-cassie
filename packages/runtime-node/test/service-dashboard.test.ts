// packages/runtime-node/test/service-dashboard.test.ts
// BotService wiring for the dashboard: adapter calls are counted, ticks and
// alerts are counted, and the sampler can be switched off.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotConfigSchema, MetricsRegistry, type VenueAccount } from "@quotient-forecasting/cassie-core";
import { BotService, buildAlerter } from "../src/service.js";
import { EngineCounters } from "../src/dashboard/counters.js";

const doubles = vi.hoisted(() => ({ engine: vi.fn(), adapter: vi.fn() }));
vi.mock("@quotient-forecasting/cassie-core", async importOriginal => ({
  ...await importOriginal<typeof import("@quotient-forecasting/cassie-core")>(),
  Engine: class { constructor(...args: unknown[]) { return doubles.engine(...args); } },
  createAdapter: doubles.adapter,
}));
vi.mock("../src/swing-controller.js", () => ({ SwingController: class {} }));

const account: VenueAccount = { venue: "polymarket", signerAddress: "0x0000000000000000000000000000000000000001",
  funder: "0x0000000000000000000000000000000000000002", signatureType: 3 };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function engineDouble(tick: () => Promise<unknown>) {
  return {
    adaptivePredictionExecution: false,
    recoverPredictions: vi.fn().mockResolvedValue(undefined),
    resumePredictions: vi.fn().mockResolvedValue(undefined),
    beginPredictionShutdown: vi.fn().mockResolvedValue(undefined),
    predictionStatus: vi.fn().mockResolvedValue({ parents: [], blocked: false }),
    supervisePredictions: vi.fn().mockResolvedValue(undefined),
    checkTriggers: vi.fn().mockResolvedValue(undefined),
    heartbeatIfResting: vi.fn().mockResolvedValue(true),
    hasArmedTriggers: vi.fn().mockResolvedValue(false),
    cancelAllResting: vi.fn().mockResolvedValue(undefined),
    cancelPredictionOrder: vi.fn().mockResolvedValue(true),
    tick: vi.fn().mockImplementation(tick),
  };
}

describe("BotService dashboard wiring", () => {
  let dir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "cassie-service-dashboard-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function make(opts: { metrics?: MetricsRegistry; dashboard?: { enabled?: boolean; sampleMinutes?: number }; tick?: () => Promise<unknown> } = {}) {
    doubles.engine.mockReturnValue(engineDouble(opts.tick ?? (async () => ({ ordersPlaced: 0 }))));
    doubles.adapter.mockReturnValue({
      id: "polymarket",
      cancelAll: vi.fn().mockResolvedValue(undefined),
      openOrders: vi.fn().mockResolvedValue([{ id: "o1" }]),
      balances: vi.fn().mockResolvedValue([{ asset: "USDC", total: 100, available: 100 }]),
      positions: vi.fn().mockResolvedValue([]),
    });
    return new BotService({
      config: BotConfigSchema.parse({ id: "dash-test", venue: "polymarket", strategy: { id: "signals", config: {} }, tickIntervalMin: 1 }),
      account, statePath: join(dir, "bot.sqlite"), runtime: "local", quotientToken: "test-token", log,
      ...(opts.metrics ? { metrics: opts.metrics } : {}), ...(opts.dashboard ? { dashboard: opts.dashboard } : {}),
    });
  }

  it("counts adapter calls under the venue prefix and serves a snapshot", async () => {
    const metrics = new MetricsRegistry();
    const service = make({ metrics, dashboard: { enabled: false } });
    expect(await service.orders()).toEqual([{ id: "o1" }]);
    expect(metrics.snapshot()["polymarket.openOrders"]).toMatchObject({ calls: 1, errors: 0 });
    const snapshot = await service.dashboardSnapshot("24h");
    expect(snapshot.bot).toMatchObject({ id: "dash-test", venue: "polymarket", strategy: "signals", runtime: "local", active: false, signalCheckMinutes: 5 });
    expect(snapshot.portfolio?.equity).toBe(100);
    expect(snapshot.metrics.sinceStart.rows.map((r) => r.key)).toEqual(["polymarket.balances", "polymarket.openOrders", "polymarket.positions"]);
    expect(snapshot.metrics.sampler).toEqual({ errors: 0 });
    expect(service.samplerStatus()).toEqual({ errors: 0, intervalMinutes: 0 });
    await service.shutdown();
  });

  it("counts ticks and tick errors", async () => {
    let fail = false;
    const service = make({ dashboard: { enabled: false }, tick: async () => { if (fail) throw new Error("tick boom"); return { ordersPlaced: 0 }; } });
    await service.tick(1);
    fail = true;
    await expect(service.tick(2)).rejects.toThrow("tick boom");
    expect(service.counters.snapshot()).toMatchObject({ ticks: 2, tickErrors: 1 });
    await service.shutdown();
  });

  it("creates a sampler by default and none when disabled", () => {
    expect(make().samplerStatus().intervalMinutes).toBe(5);
    expect(make({ dashboard: { sampleMinutes: 2 } }).samplerStatus().intervalMinutes).toBe(2);
    expect(make({ dashboard: { enabled: false } }).samplerStatus().intervalMinutes).toBe(0);
  });
});

describe("buildAlerter counting", () => {
  it("counts attempts by kind and failed deliveries even though SafeAlerter swallows them", async () => {
    const counters = new EngineCounters();
    const config = BotConfigSchema.parse({ id: "b", venue: "polymarket", alerts: { telegram: { chatId: "123" } } });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("telegram down"); }) as typeof fetch;
    try {
      const alerter = buildAlerter({ config, account, statePath: "/dev/null", runtime: "local", telegramToken: "t" }, log, counters);
      await alerter.send({ kind: "skipped-order", botId: "b", message: "capped" });
      await alerter.send({ kind: "fill", botId: "b", message: "filled" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(counters.snapshot()).toMatchObject({ alertsSent: 0, alertsFailed: 2, alertsByKind: { "skipped-order": 1, fill: 1 } });
    const console = buildAlerter({ config: BotConfigSchema.parse({ id: "b", venue: "polymarket" }), account, statePath: "/dev/null", runtime: "local" }, log, counters);
    await console.send({ kind: "test", botId: "b", message: "ping" });
    expect(counters.snapshot()).toMatchObject({ alertsSent: 1, alertsByKind: { test: 1 } });
  });
});

describe("buildAlerter webhook sink", () => {
  it("posts to the webhook when a URL is set and counts the delivery", async () => {
    const counters = new EngineCounters();
    const config = BotConfigSchema.parse({ id: "b", venue: "polymarket", alerts: { webhook: { format: "json", kinds: ["exit"] } } });
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const alerter = buildAlerter({ config, account, statePath: "/dev/null", runtime: "local", webhookUrl: "https://hooks.example.com/b", webhookSecret: "s" }, log, counters);
      await alerter.send({ kind: "entry", botId: "b", message: "filtered out by kinds" });
      await alerter.send({ kind: "exit", botId: "b", message: "sold" });
      await alerter.flush?.();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hooks.example.com/b");
    expect(calls[0]!.headers["x-cassie-signature"]).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(counters.snapshot()).toMatchObject({ alertsByKind: { entry: 1, exit: 1 } });
  });

  it("stays on the console sink without a URL", async () => {
    const counters = new EngineCounters();
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const alerter = buildAlerter({ config: BotConfigSchema.parse({ id: "b", venue: "polymarket" }), account, statePath: "/dev/null", runtime: "local" }, log, counters);
      await alerter.send({ kind: "test", botId: "b", message: "ping" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

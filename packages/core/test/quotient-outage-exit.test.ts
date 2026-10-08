// packages/core/test/quotient-outage-exit.test.ts
// When Quotient cannot be reached, the tick must still evaluate held
// positions: entries stop, exits fire on the last committed forecast, and
// the engine keeps ticking instead of recording a failed tick.

import { describe, expect, it } from "vitest";
import {
  MemoryStateStore,
  parseBotConfig,
  silentLogger,
  Engine,
  FixtureVenue,
  type MarketForecast,
  type Position,
  type Signal,
  type SignalSource,
  type StrategyMemory,
  type VenueAccount,
} from "@quotient-forecasting/cassie-core";
import { FlipFlatStrategy } from "../../../strategies/flip-flat/dist/index.js";
import { RecordingAlerter, booksFixture, signalsFixture } from "./helpers.js";

const MARKET = "m-1";
const START = Date.parse("2026-09-07T12:00:00Z");

function memory(): StrategyMemory {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async <T>(key: string, value: T) => { values.set(key, value); },
  };
}

function forecast(probYes: number, offsetMs = 0): MarketForecast {
  return { id: "f-1", ts: new Date(START + offsetMs).toISOString(), venue: "polymarket", marketRef: MARKET, probYes };
}

function signal(prob: number): Signal {
  return { id: "s-1", ts: new Date(START).toISOString(), venue: "polymarket", marketRef: MARKET, side: "YES", prob, refPrice: 0.55, spreadPp: 15, ttlSec: 86_400 };
}

/** A strategy context whose signal source can be switched into an outage between ticks. */
function harness() {
  const state = { now: START, outage: false, mid: 0.55, signals: [signal(0.7)], forecasts: [forecast(0.7)] };
  const position: Position = { marketRef: MARKET, side: "YES", size: 10, avgPrice: 0.55 };
  const fail = () => { throw new Error("signal API 503 for /api/v1/signals"); };
  const signals: SignalSource = {
    latest: async () => (state.outage ? fail() : state.signals),
    forecasts: async () => (state.outage ? fail() : state.forecasts),
  };
  const mem = memory();
  const logs: string[] = [];
  const ctx = () => ({
    botId: "outage",
    venueId: "polymarket" as const,
    config: { allocationMode: "portfolio-kelly", scenarioExitEnabled: true },
    signals,
    positions: [position],
    openOrders: [],
    equity: 1_000,
    now: () => state.now,
    log: { ...silentLogger, warn: (message: string) => { logs.push(message); } },
    memory: mem,
    venue: {
      quote: async () => ({ marketRef: MARKET, bid: state.mid - 0.01, ask: state.mid + 0.01, mid: state.mid, volume24h: 1e6, spreadBps: 40, ts: state.now }),
      book: async () => ({ marketRef: MARKET, bids: [{ price: Number((state.mid - 0.01).toFixed(4)), size: 10_000 }], asks: [{ price: Number((state.mid + 0.01).toFixed(4)), size: 10_000 }], ts: state.now }),
      balances: async () => [{ asset: "pUSD", total: 1_000, available: 1_000 }],
    },
  });
  return { state, ctx, logs };
}

describe("exits during a Quotient outage", () => {
  it("still exits on the last committed forecast when every Quotient read fails", async () => {
    const { state, ctx, logs } = harness();
    const strategy = new FlipFlatStrategy();
    // Tick 1: Quotient answers. Entry Q is 0.85 from the signal; the committed
    // forecast has retreated to 0.52, but at mid 0.45 the held side still has
    // +7pp of edge, so the collapse branch waits (and Q is not below 50%).
    state.signals = [signal(0.85)];
    state.forecasts = [forecast(0.52)];
    state.mid = 0.45;
    expect((await strategy.tick(ctx() as never)).filter((a) => a.kind === "exit")).toHaveLength(0);

    // Outage. The market rises through the committed forecast: the collapse
    // fires on that forecast, without waiting for fresh data.
    state.outage = true;
    state.now += 60_000;
    state.mid = 0.55;
    const actions = await strategy.tick(ctx() as never);
    expect(actions.filter((a) => a.kind === "enter")).toHaveLength(0);
    expect(actions.filter((a) => a.kind === "exit")).toMatchObject([{ marketRef: MARKET, reason: expect.stringContaining("q_collapse") }]);
    expect(logs.some((line) => line.includes("signal refresh failed"))).toBe(true);
  });

  it("holds through the outage while the committed forecast still has edge", async () => {
    const { state, ctx } = harness();
    const strategy = new FlipFlatStrategy();
    await strategy.tick(ctx() as never);
    state.outage = true;
    state.now += 60_000;
    state.mid = 0.58;
    expect((await strategy.tick(ctx() as never)).filter((a) => a.kind === "exit")).toHaveLength(0);
  });

  it("keeps the engine tick alive when the signal source rejects", async () => {
    const config = parseBotConfig({
      id: "outage-engine",
      venue: "polymarket",
      execution: { mode: "legacy" },
      strategy: { id: "flip-flat", config: { entrySpreadPp: 10, dailyBudgetUsd: 25, positionBudgetPct: 50 } },
      tickIntervalMin: 5,
    });
    const venue = new FixtureVenue(booksFixture);
    const failing: SignalSource = { latest: async () => { throw new Error("signal API 503"); } };
    const alerter = new RecordingAlerter();
    const state = new MemoryStateStore();
    const account: VenueAccount = { venue: "fixture", address: "0xF1XTURE" };
    const engine = new Engine({ botId: config.id, config, adapter: venue, account, strategy: new FlipFlatStrategy(), signals: failing, alerter, state, log: silentLogger });
    const result = await engine.tick();
    expect(result.skipped).toBe(false);
    expect(result.errors).toBe(0);
    expect(result.ordersPlaced).toBe(0);
    expect(signalsFixture.length).toBeGreaterThan(0);
  });
});

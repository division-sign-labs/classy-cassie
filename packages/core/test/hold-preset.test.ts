// packages/core/test/hold-preset.test.ts
// The hold preset of the signals strategy: one fixed-dollar lot per market,
// a resolution window at entry, no top-ups, cash-bounded lots.

import { describe, expect, it } from "vitest";
import {
  silentLogger,
  type Position,
  type Signal,
  type SignalSource,
  type StrategyContext,
  type StrategyMemory,
} from "@quotient-forecasting/cassie-core";
import { FlipFlatStrategy } from "../../../strategies/flip-flat/dist/index.js";

const NOW = Date.parse("2026-09-17T00:00:00Z");
const DAY_MS = 86_400_000;

const HOLD = {
  allocationMode: "fixed-notional",
  lotNotionalUsd: 10,
  nearResolutionDays: null,
  entrySpreadPp: 15,
  maxEntrySpreadPp: null,
  maxWindowDays: 60,
  takeProfitPrice: null,
  maxHoldDays: null,
  scenarioExitEnabled: true,
  adverseCrossConfirmations: null,
  qCollapsePp: null,
  flipConfirmations: 2,
  flipExitMaxRemainingEdgePp: null,
};

function sig(marketRef: string, spreadPp: number, daysOut: number | undefined): Signal {
  return {
    id: `sig-${marketRef}`,
    ts: new Date(NOW).toISOString(),
    venue: "polymarket",
    marketRef,
    side: "YES",
    prob: 0.5 + spreadPp / 100,
    refPrice: 0.5,
    spreadPp,
    ttlSec: 7 * 86_400,
    ...(daysOut === undefined ? {} : { endsAt: NOW + daysOut * DAY_MS }),
  };
}

function memory(): StrategyMemory {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async <T>(key: string, value: T) => {
      values.set(key, value);
    },
  };
}

function ctxWith(
  signals: Signal[],
  config: Record<string, unknown>,
  over: { positions?: Position[]; available?: number } = {},
): StrategyContext {
  const source: SignalSource = { latest: async () => signals, forecasts: async () => [] };
  const available = over.available ?? 1_000;
  return {
    botId: "hold-preset",
    venueId: "polymarket",
    config: { ...HOLD, ...config },
    signals: source,
    positions: over.positions ?? [],
    openOrders: [],
    equity: available,
    now: () => NOW,
    log: silentLogger,
    memory: memory(),
    venue: {
      quote: async (marketRef: string) => ({ marketRef, bid: 0.49, ask: 0.51, mid: 0.5, volume24h: 1e6, spreadBps: 40, ts: NOW }),
      book: async (marketRef: string) => ({
        marketRef,
        bids: [{ price: 0.49, size: 6_000 }],
        asks: [{ price: 0.51, size: 6_000 }],
        ts: NOW,
      }),
      balances: async () => [{ asset: "pUSD", total: available, available }],
      positions: async () => over.positions ?? [],
      openOrders: async () => [],
      fills: async () => [],
      eventRef: async (marketRef: string) => `event:${marketRef}`,
    },
  } as never;
}

function entries(actions: Awaited<ReturnType<FlipFlatStrategy["tick"]>>) {
  return actions.filter((action): action is Extract<typeof action, { kind: "enter" }> => action.kind === "enter");
}

describe("hold preset", () => {
  it("places one fixed lot on a qualifying signal", async () => {
    const actions = await new FlipFlatStrategy().tick(ctxWith([sig("near", 20, 10)], {}));
    const entered = entries(actions);
    expect(entered).toHaveLength(1);
    expect(entered[0]!.notional).toBe(10);
    expect(entered[0]!.provenance).toMatchObject({ allocationMode: "fixed-notional", lotNotionalUsd: 10, signalEdgePp: 20 });
  });

  it("skips markets past the resolution window and markets with no date", async () => {
    const actions = await new FlipFlatStrategy().tick(
      ctxWith([sig("far", 25, 90), sig("undated", 25, undefined), sig("at-window", 25, 60), sig("near", 25, 3)], {}),
    );
    expect(entries(actions).map((action) => action.marketRef)).toEqual(["at-window", "near"]);
  });

  it("enters any window when the cap is off", async () => {
    const actions = await new FlipFlatStrategy().tick(ctxWith([sig("far", 25, 90), sig("undated", 25, undefined)], { maxWindowDays: null }));
    expect(entries(actions)).toHaveLength(2);
  });

  it("applies the 15pp floor and no ceiling", async () => {
    const actions = await new FlipFlatStrategy().tick(ctxWith([sig("thin", 12, 10), sig("at-floor", 15, 10), sig("wide", 45, 10)], {}));
    expect(entries(actions).map((action) => action.marketRef)).toEqual(["wide", "at-floor"]);
  });

  it("never tops up a held market", async () => {
    const held: Position = { marketRef: "near", side: "YES", size: 20, avgPrice: 0.5 };
    const actions = await new FlipFlatStrategy().tick(ctxWith([sig("near", 30, 10)], {}, { positions: [held] }));
    expect(entries(actions)).toHaveLength(0);
  });

  it("bounds the lot by spendable cash and keeps sizing equal across a tick", async () => {
    const actions = await new FlipFlatStrategy().tick(ctxWith([sig("a", 30, 10), sig("b", 25, 10)], {}, { available: 16 }));
    const sized = entries(actions).map((action) => action.notional);
    expect(sized[0]).toBe(10);
    expect(sized[1]).toBeCloseTo(5.7, 5);
  });
});

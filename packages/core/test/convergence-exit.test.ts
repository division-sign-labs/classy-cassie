// packages/core/test/convergence-exit.test.ts
// Convergence exit: bank the trade when the market prices in the forecast,
// instead of holding for a flip that may never come. Both legs must hold —
// edge closed AND in profit — so a market moving against the entry (which also
// closes the edge) is not mistaken for the thesis paying out.

import { describe, expect, it } from "vitest";
import { silentLogger, type Position, type Signal, type SignalSource, type StrategyMemory } from "@quotient-forecasting/cassie-core";
import { FlipFlatStrategy } from "../../../strategies/flip-flat/dist/index.js";

const MARKET = "m-1";

function sig(over: Partial<Signal> = {}): Signal {
  return {
    id: "sig-1",
    ts: new Date().toISOString(),
    venue: "polymarket",
    marketRef: MARKET,
    side: "YES",
    prob: 0.7,
    refPrice: 0.55,
    spreadPp: 15,
    ttlSec: 86_400,
    ...over,
  };
}

function position(over: Partial<Position> = {}): Position {
  return { marketRef: MARKET, side: "YES", size: 10, avgPrice: 0.55, ...over };
}

function strategyMemory(): StrategyMemory {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async <T>(key: string, value: T) => {
      values.set(key, value);
    },
  };
}

/** `mid` is always the YES mid, as the venue reports it. */
function ctxWith(signals: Signal[], positions: Position[], mid: number, config: Record<string, unknown> = {}) {
  return {
    venueId: "polymarket" as const,
    config,
    signals: { latest: async () => signals } as SignalSource,
    positions,
    openOrders: [],
    equity: 1_000,
    now: () => Date.now(),
    log: silentLogger,
    memory: strategyMemory(),
    venue: {
      quote: async () => ({ marketRef: MARKET, bid: mid - 0.01, ask: mid + 0.01, mid, volume24h: 1e6, spreadBps: 40, ts: Date.now() }),
      balances: async () => [{ asset: "pUSD", total: 1_000, available: 1_000 }],
    },
  } as never;
}

async function exits(ctx: unknown) {
  const actions = await new FlipFlatStrategy().tick(ctx as never);
  return actions.filter((a) => a.kind === "exit");
}

describe("convergence exit", () => {
  it("sells once the market prices in the forecast at a profit", async () => {
    // Entered at 0.55, forecast 0.70, market now 0.69 → 1pp left, +25%.
    const got = await exits(ctxWith([sig()], [position()], 0.69));
    expect(got).toHaveLength(1);
    expect(got[0]!.reason).toMatch(/converged/);
  });

  it("holds while meaningful edge remains", async () => {
    // Market 0.60 vs forecast 0.70 → 10pp left, well above the 2pp threshold.
    expect(await exits(ctxWith([sig()], [position()], 0.6))).toHaveLength(0);
  });

  it("holds when the edge closed but the position is not up enough", async () => {
    // Entered at 0.69 and the market barely moved: converged, but +0% — this is
    // the case that separates "thesis paid" from "market moved against us".
    expect(await exits(ctxWith([sig()], [position({ avgPrice: 0.69 })], 0.69))).toHaveLength(0);
  });

  it("does not fire when the market moved against the entry", async () => {
    // Entered 0.80, forecast 0.70, market fell to 0.69: edge is closed, but the
    // position is down 14%. Exiting here would book a loss as a "convergence".
    expect(await exits(ctxWith([sig()], [position({ avgPrice: 0.8 })], 0.69))).toHaveLength(0);
  });

  it("exits on an overshoot past the forecast", async () => {
    // Market 0.78 above a 0.70 forecast — negative remaining edge, deep profit.
    expect(await exits(ctxWith([sig()], [position()], 0.78))).toHaveLength(1);
  });

  it("measures a NO position on its own token, not the YES mid", async () => {
    // NO forecast 0.70 (so YES 0.30). YES mid 0.29 → NO price 0.71, which has
    // converged past a 0.55 entry at +29%. Reading the YES mid instead would
    // see 0.29 against a 0.70 forecast and hold forever.
    const got = await exits(ctxWith([sig({ side: "NO", prob: 0.7 })], [position({ side: "NO" })], 0.29));
    expect(got).toHaveLength(1);
  });

  it("holds a NO position that has not converged", async () => {
    // YES mid 0.55 → NO price 0.45, still 25pp under a 0.70 NO forecast.
    expect(await exits(ctxWith([sig({ side: "NO", prob: 0.7 })], [position({ side: "NO" })], 0.55))).toHaveLength(0);
  });

  it("can be turned off", async () => {
    const ctx = ctxWith([sig()], [position()], 0.69, { convergenceExit: false });
    expect(await exits(ctx)).toHaveLength(0);
  });

  it("respects a custom profit floor", async () => {
    // +25% clears the default 1% but not a 40% floor.
    const ctx = ctxWith([sig()], [position()], 0.69, { minProfitPct: 40 });
    expect(await exits(ctx)).toHaveLength(0);
  });

  it("still exits on a flip regardless of profit", async () => {
    // Flip takes precedence: the forecast itself changed side.
    const got = await exits(
      ctxWith([sig({ side: "NO" })], [position({ side: "YES", size: 2 })], 0.69, {
        minEntryNotional: 10,
      }),
    );
    expect(got).toHaveLength(1);
    expect(got[0]!.reason).toMatch(/flip/);
  });
});

// packages/core/test/convergence-exit.test.ts
// Positive convergence exit: sell early once the market has priced in the
// held-side forecast and the executable bid is at least 2% above cost. A
// converged loss remains open until the independent maximum holding period.

import { describe, expect, it } from "vitest";
import {
  silentLogger,
  type MarketForecast,
  type Position,
  type Signal,
  type SignalSource,
  type StrategyMemory,
} from "@quotient-forecasting/cassie-core";
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
function ctxWith(
  signals: Signal[],
  positions: Position[],
  mid: number,
  config: Record<string, unknown> = {},
  forecasts?: MarketForecast[],
) {
  return {
    venueId: "polymarket" as const,
    config,
    signals: {
      latest: async () => signals,
      ...(forecasts ? { forecasts: async () => forecasts } : {}),
    } as SignalSource,
    positions,
    openOrders: [],
    equity: 1_000,
    now: () => Date.now(),
    log: silentLogger,
    memory: strategyMemory(),
    venue: {
      quote: async () => ({ marketRef: MARKET, bid: mid - 0.01, ask: mid + 0.01, mid, volume24h: 1e6, spreadBps: 40, ts: Date.now() }),
      book: async () => ({
        marketRef: MARKET,
        bids: [{ price: mid - 0.01, size: 1_000 }],
        asks: [{ price: mid + 0.01, size: 1_000 }],
        ts: Date.now(),
      }),
      balances: async () => [{ asset: "pUSD", total: 1_000, available: 1_000 }],
    },
  } as never;
}

async function exits(ctx: unknown) {
  const actions = await new FlipFlatStrategy().tick(ctx as never);
  return actions.filter((a) => a.kind === "exit");
}

describe("convergence exit", () => {
  it("queries held-market forecasts and exits even when no entry signal is published", async () => {
    const forecast: MarketForecast = {
      id: "forecast-spider-man",
      ts: "2026-08-24T22:06:19.902Z",
      venue: "polymarket",
      marketRef: MARKET,
      probYes: 0.9184779613,
    };
    const got = await exits(ctxWith([], [position({ avgPrice: 0.62 })], 0.992, {}, [forecast]));
    expect(got).toHaveLength(1);
    expect(got[0]!.reason).toMatch(/converged: -7\.4pp edge left/);
  });

  it("does not apply entry-signal freshness to a held-position exit", async () => {
    const stale = sig({ ts: "2026-08-01T00:00:00Z", ttlSec: 60 });
    expect(await exits(ctxWith([stale], [position()], 0.78))).toHaveLength(1);
  });

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

  it("holds at breakeven even after the edge is closed", async () => {
    // The executable bid is below cost, so this is not positive convergence.
    expect(await exits(ctxWith([sig()], [position({ avgPrice: 0.69 })], 0.69))).toHaveLength(0);
  });

  it("holds a converged loss before the maximum holding period", async () => {
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

  it("holds through a signal-side flip while the held side keeps edge", async () => {
    // Held YES from 0.55, market fell to 0.10. The published signal now sits on
    // NO at 0.75, i.e. Q still values YES at 0.25 — 15pp above the price, so
    // holding remains +EV despite the flipped side and the deep loss.
    const got = await exits(ctxWith([sig({ side: "NO", prob: 0.75 })], [position()], 0.1));
    expect(got).toHaveLength(0);
  });

  it("does not realize a loss merely because the forecast crossed below price", async () => {
    // Signal flipped to NO at 0.70 → YES valued at 0.30 against a 0.55 mid:
    // −25pp of edge. The forecast has converged past the price, so sell.
    expect(await exits(ctxWith([sig({ side: "NO", prob: 0.7 })], [position()], 0.55))).toHaveLength(0);
  });
});

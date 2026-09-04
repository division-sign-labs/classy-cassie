// packages/core/test/take-profit-exit.test.ts
// Take-profit exit: sell once the held outcome's executable bid reaches the
// price floor (90¢ by default). The forecast plays no part; a position below
// the floor stays open until the independent maximum holding period.

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

/** `mid` is always the YES mid, as the venue reports it; the book is 2¢ wide around it. */
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
        bids: [{ price: Number((mid - 0.01).toFixed(4)), size: 1_000 }],
        asks: [{ price: Number((mid + 0.01).toFixed(4)), size: 1_000 }],
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

describe("take-profit exit", () => {
  it("sells at a 0.90 bid even when no entry signal is published", async () => {
    const got = await exits(ctxWith([], [position({ avgPrice: 0.62 })], 0.91));
    expect(got).toHaveLength(1);
    expect(got[0]!.reason).toBe("take profit: held YES bid 0.900 >= 0.900");
  });

  it("does not apply entry-signal freshness to a held-position exit", async () => {
    const stale = sig({ ts: "2026-08-01T00:00:00Z", ttlSec: 60 });
    expect(await exits(ctxWith([stale], [position()], 0.91))).toHaveLength(1);
  });

  it("holds at a 0.89 bid", async () => {
    expect(await exits(ctxWith([sig()], [position()], 0.9))).toHaveLength(0);
  });

  it("ignores the forecast in both directions", async () => {
    const forecast = (probYes: number): MarketForecast => ({
      id: "forecast-1",
      ts: "2026-08-24T22:06:19.902Z",
      venue: "polymarket",
      marketRef: MARKET,
      probYes,
    });
    // Priced in at 0.69 with the bid below the floor: hold.
    expect(await exits(ctxWith([sig()], [position()], 0.69, {}, [forecast(0.7)]))).toHaveLength(0);
    // Plenty of edge left at 0.91 (Q 0.99), yet the floor sells.
    expect(await exits(ctxWith([sig({ prob: 0.99 })], [position()], 0.91, {}, [forecast(0.99)]))).toHaveLength(1);
  });

  it("measures a NO position on its own token, not the YES mid", async () => {
    // YES mid 0.09 → NO bid mirrors the YES ask 0.10 → 0.90.
    const got = await exits(ctxWith([sig({ side: "NO", prob: 0.7 })], [position({ side: "NO" })], 0.09));
    expect(got).toHaveLength(1);
    expect(got[0]!.reason).toBe("take profit: held NO bid 0.900 >= 0.900");
  });

  it("holds a NO position whose own bid is below the floor", async () => {
    expect(await exits(ctxWith([sig({ side: "NO", prob: 0.7 })], [position({ side: "NO" })], 0.55))).toHaveLength(0);
  });

  it("honors a configured price floor", async () => {
    expect(await exits(ctxWith([sig()], [position()], 0.91, { takeProfitPrice: 0.95 }))).toHaveLength(0);
    expect(await exits(ctxWith([sig()], [position()], 0.96, { takeProfitPrice: 0.95 }))).toHaveLength(1);
  });

  it("can be turned off", async () => {
    expect(await exits(ctxWith([sig()], [position()], 0.97, { takeProfitPrice: null }))).toHaveLength(0);
  });

  it("holds through a signal-side flip while below the floor", async () => {
    // Held YES from 0.55, market fell to 0.10, and the published signal now sits
    // on NO. Nothing about that reaches the price floor, so the position stays.
    expect(await exits(ctxWith([sig({ side: "NO", prob: 0.75 })], [position()], 0.1))).toHaveLength(0);
  });
});

// packages/core/test/entry-liquidity.test.ts
// Entry eligibility requires enough near-touch depth to unwind the held outcome.

import { describe, expect, it } from "vitest";
import {
  silentLogger,
  type OrderBook,
  type Position,
  type Signal,
  type StrategyContext,
  type StrategyMemory,
} from "@quotient-forecasting/cassie-core";
import {
  bidDepthWithin2cUsd,
  FlipFlatConfigSchema,
  FlipFlatStrategy,
} from "../../../strategies/flip-flat/dist/index.js";

const MARKET = "liquidity-market";
const NOW = Date.parse("2026-08-31T12:00:00Z");

function memory(): StrategyMemory {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async <T>(key: string, value: T) => {
      values.set(key, value);
    },
  };
}

function signal(side: "YES" | "NO" = "YES", prob = 0.7): Signal {
  return {
    id: `sig-${side.toLowerCase()}`,
    ts: new Date(NOW).toISOString(),
    venue: "polymarket",
    marketRef: MARKET,
    side,
    prob,
    refPrice: 0.5,
    spreadPp: Math.abs(prob - 0.5) * 100,
    ttlSec: 86_400,
  };
}

function book(input: {
  bids?: Array<{ price: number; size: number }>;
  asks?: Array<{ price: number; size: number }>;
} = {}): OrderBook {
  return {
    marketRef: MARKET,
    bids: input.bids ?? [],
    asks: input.asks ?? [],
    ts: NOW,
  };
}

function context(input: {
  signal?: Signal;
  book: OrderBook | Error;
  mid?: number;
  positions?: Position[];
  config?: Record<string, unknown>;
  logs?: string[];
}): StrategyContext {
  const positions = input.positions ?? [];
  const mid = input.mid ?? 0.5;
  const logs = input.logs;
  return {
    botId: "entry-liquidity",
    venueId: "polymarket",
    config: {
      allocationMode: "portfolio-kelly",
      kellyFraction: 0.25,
      marketCapPct: 2.5,
      eventCapPct: 5,
      takeProfitPrice: null,
      ...input.config,
    },
    signals: { latest: async () => [input.signal ?? signal()] },
    venue: {
      balances: async () => [{ asset: "pUSD", total: 1_000, available: 1_000 }],
      positions: async () => positions,
      book: async () => {
        if (input.book instanceof Error) throw input.book;
        return input.book;
      },
      quote: async () => ({
        marketRef: MARKET,
        bid: mid - 0.01,
        ask: mid + 0.01,
        mid,
        volume24h: 1_000_000,
        spreadBps: 400,
        ts: NOW,
      }),
      openOrders: async () => [],
      fills: async () => [],
      eventRef: async () => "polymarket:event-liquidity",
    },
    positions,
    openOrders: [],
    equity: 1_000,
    log: logs
      ? {
          ...silentLogger,
          info: (message: string) => logs.push(message),
          warn: (message: string) => logs.push(message),
        }
      : silentLogger,
    now: () => NOW,
    memory: memory(),
  };
}

async function entries(ctx: StrategyContext) {
  return (await new FlipFlatStrategy().tick(ctx)).filter((action) => action.kind === "enter");
}

describe("flip-flat entry-side unwind liquidity", () => {
  it("defaults to $2,500 of held-outcome bid depth within two cents", () => {
    expect(FlipFlatConfigSchema.parse({}).minExitDepth2cUsd).toBe(2_500);
  });

  it("allows a YES entry when its near-touch bid notional exceeds the floor", async () => {
    const got = await entries(
      context({
        book: book({
          bids: [
            { price: 0.5, size: 3_000 },
            { price: 0.49, size: 2_200 },
            { price: 0.47, size: 100_000 },
          ],
          asks: [{ price: 0.51, size: 10_000 }],
        }),
      }),
    );

    expect(got).toHaveLength(1);
  });

  it("skips a YES entry below the floor and logs measured versus required depth", async () => {
    const logs: string[] = [];
    const got = await entries(
      context({
        logs,
        book: book({
          bids: [
            { price: 0.5, size: 2_000 },
            { price: 0.49, size: 2_000 },
          ],
          asks: [{ price: 0.51, size: 10_000 }],
        }),
      }),
    );

    expect(got).toHaveLength(0);
    expect(logs.join("\n")).toMatch(/measured \$1980\.00 < required \$2500\.00/);
  });

  it("uses mirrored YES asks as the held-outcome bids for a NO entry", async () => {
    const got = await entries(
      context({
        signal: signal("NO"),
        book: book({
          bids: [{ price: 0.49, size: 1 }],
          asks: [{ price: 0.51, size: 6_000 }],
        }),
      }),
    );

    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ marketRef: MARKET, side: "NO" });
  });

  it("includes a level exactly two cents down and accepts exactly $2,500", async () => {
    const exact = book({
      bids: [
        { price: 0.5, size: 2_000 },
        { price: 0.48, size: 3_125 },
        { price: 0.479, size: 100_000 },
      ],
      asks: [{ price: 0.51, size: 10_000 }],
    });

    expect(bidDepthWithin2cUsd(exact)).toBeCloseTo(2_500, 8);
    expect(await entries(context({ book: exact }))).toHaveLength(1);
  });

  it("does not read the book when the entry-liquidity gate is disabled", async () => {
    expect(
      await entries(
        context({
          book: new Error("book unavailable"),
          config: { minExitDepth2cUsd: 0 },
        }),
      ),
    ).toHaveLength(1);
  });

  it("applies the same floor to a same-side top-up", async () => {
    const got = await entries(
      context({
        positions: [{ marketRef: MARKET, side: "YES", size: 10, avgPrice: 0.2 }],
        book: book({
          bids: [{ price: 0.5, size: 1_000 }],
          asks: [{ price: 0.51, size: 10_000 }],
        }),
      }),
    );

    expect(got).toHaveLength(0);
  });

  it("never applies the entry-depth floor to a take-profit exit", async () => {
    const actions = await new FlipFlatStrategy().tick(
      context({
        signal: signal("YES", 0.54),
        mid: 0.91,
        positions: [{ marketRef: MARKET, side: "YES", size: 10, avgPrice: 0.5 }],
        config: { takeProfitPrice: 0.9, minExitDepth2cUsd: 2_500 },
        book: book({
          bids: [{ price: 0.9, size: 1 }],
          asks: [{ price: 0.92, size: 1 }],
        }),
      }),
    );

    expect(actions.filter((action) => action.kind === "exit")).toHaveLength(1);
  });
});

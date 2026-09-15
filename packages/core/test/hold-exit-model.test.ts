// packages/core/test/hold-exit-model.test.ts
// Price-floor take-profit exits plus a persistent maximum holding period.

import { describe, expect, it } from "vitest";
import {
  silentLogger,
  type Order,
  type Position,
  type Signal,
  type SignalSource,
  type StrategyContext,
  type StrategyMemory,
} from "@quotient-forecasting/cassie-core";
import {
  FlipFlatConfigSchema,
  FlipFlatStrategy,
} from "../../../strategies/flip-flat/dist/index.js";

const MARKET = "hold-market";
const START = Date.parse("2026-08-01T00:00:00Z");
const DAY_MS = 86_400_000;

function memory(): StrategyMemory {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async <T>(key: string, value: T) => {
      values.set(key, value);
    },
  };
}

function signal(prob = 0.52): Signal {
  return {
    id: "sig-hold",
    ts: new Date(START).toISOString(),
    venue: "polymarket",
    marketRef: MARKET,
    side: "YES",
    prob,
    refPrice: 0.5,
    spreadPp: Math.abs(prob - 0.5) * 100,
    ttlSec: 30 * 86_400,
  };
}

function position(avgPrice = 0.5): Position {
  return { marketRef: MARKET, side: "YES", size: 10, avgPrice };
}

function context(input: {
  clock: { now: number };
  mid?: number;
  yesBid?: number | null;
  yesAsk?: number | null;
  signals?: Signal[];
  positions?: Position[];
  openOrders?: Order[];
  memory?: StrategyMemory;
  config?: Record<string, unknown>;
}): StrategyContext {
  const mid = input.mid ?? 0.5;
  const yesBid = input.yesBid === undefined ? mid : input.yesBid;
  const yesAsk = input.yesAsk === undefined ? mid : input.yesAsk;
  const signals = input.signals ?? [];
  return {
    botId: "hold-exit-model",
    venueId: "polymarket",
    config: {
      allocationMode: "daily-budget",
      dailyBudgetUsd: 100,
      positionBudgetPct: 25,
      ...input.config,
    },
    signals: { latest: async () => signals } as SignalSource,
    venue: {
      book: async (marketRef: string) => ({
        marketRef,
        bids: yesBid === null ? [] : [{ price: yesBid, size: 1_000 }],
        asks: yesAsk === null ? [] : [{ price: yesAsk, size: 1_000 }],
        ts: input.clock.now,
      }),
      quote: async (marketRef: string) => ({
        marketRef,
        bid: mid - 0.01,
        ask: mid + 0.01,
        mid,
        volume24h: 1_000_000,
        spreadBps: 40,
        ts: input.clock.now,
      }),
      balances: async () => [{ asset: "pUSD", total: 1_000, available: 1_000 }],
    },
    positions: input.positions ?? [position()],
    openOrders: input.openOrders ?? [],
    equity: 1_000,
    log: silentLogger,
    now: () => input.clock.now,
    memory: input.memory ?? memory(),
  } as StrategyContext;
}

async function exits(strategy: FlipFlatStrategy, ctx: StrategyContext) {
  return (await strategy.tick(ctx)).filter((action) => action.kind === "exit");
}

describe("flip-flat hold and exit model", () => {
  it("defaults to a 90¢ take-profit and a seven-day maximum hold", () => {
    const config = FlipFlatConfigSchema.parse({});
    expect(config.takeProfitPrice).toBe(0.9);
    expect(config.maxHoldDays).toBe(7);
    expect(() => FlipFlatConfigSchema.parse({ takeProfitPrice: 1.5 })).toThrow();
    expect(() => FlipFlatConfigSchema.parse({ takeProfitPrice: 0 })).toThrow();
    expect(FlipFlatConfigSchema.parse({ takeProfitPrice: null }).takeProfitPrice).toBeNull();
  });

  it("takes profit once the held side's executable bid reaches 90¢", async () => {
    const clock = { now: START };
    const got = await exits(new FlipFlatStrategy(), context({ clock, mid: 0.91 }));

    expect(got).toHaveLength(1);
    expect(got[0]!.reason).toBe("take profit: held YES bid 0.910 >= 0.900");
    expect(got[0]!.provenance).toMatchObject({ exitModel: "legacy", takeProfitPrice: 0.9, executableBid: 0.91 });
  });

  it("holds below the take-profit price", async () => {
    const clock = { now: START };
    expect(await exits(new FlipFlatStrategy(), context({ clock, mid: 0.89 }))).toHaveLength(0);
  });

  it("ignores the forecast: a priced-in position below the floor stays open", async () => {
    const clock = { now: START };
    expect(await exits(new FlipFlatStrategy(), context({ clock, mid: 0.6, signals: [signal(0.6)] }))).toHaveLength(0);
  });

  it("holds a losing position before the deadline", async () => {
    const clock = { now: START };
    expect(
      await exits(new FlipFlatStrategy(), context({ clock, mid: 0.5, positions: [position(0.6)] })),
    ).toHaveLength(0);
  });

  it("does not take profit when the held side has no executable bid", async () => {
    const clock = { now: START };
    expect(await exits(new FlipFlatStrategy(), context({ clock, mid: 0.95, yesBid: null }))).toHaveLength(0);
  });

  it("uses the mirrored YES ask as the executable bid for a held NO position", async () => {
    const clock = { now: START };
    const got = await exits(
      new FlipFlatStrategy(),
      context({ clock, mid: 0.09, yesBid: 0.08, yesAsk: 0.1, positions: [{ ...position(0.5), side: "NO" }] }),
    );

    expect(got).toHaveLength(1);
    expect(got[0]!.reason).toBe("take profit: held NO bid 0.900 >= 0.900");
  });

  it("honors a configured price floor", async () => {
    const clock = { now: START };
    expect(
      await exits(new FlipFlatStrategy(), context({ clock, mid: 0.91, config: { takeProfitPrice: 0.95 } })),
    ).toHaveLength(0);
    expect(
      await exits(new FlipFlatStrategy(), context({ clock, mid: 0.96, config: { takeProfitPrice: 0.95 } })),
    ).toHaveLength(1);
  });

  it("exits at seven days even when no forecast exists", async () => {
    const clock = { now: START };
    const strategy = new FlipFlatStrategy();
    const ctx = context({ clock, signals: [] });

    expect(await exits(strategy, ctx)).toHaveLength(0);
    clock.now += 7 * DAY_MS;
    const got = await exits(strategy, ctx);

    expect(got).toHaveLength(1);
    expect(got[0]!.reason).toBe("max hold reached: 7.00d held (limit 7d)");
  });

  it("allows the maximum holding deadline to be disabled", async () => {
    const clock = { now: START };
    const strategy = new FlipFlatStrategy();
    const ctx = context({
      clock,
      signals: [],
      config: { takeProfitPrice: null, maxHoldDays: null },
    });

    expect(await exits(strategy, ctx)).toHaveLength(0);
    clock.now += 30 * DAY_MS;
    expect(await exits(strategy, ctx)).toHaveLength(0);
  });

  it("does not emit a deadline exit while any order is open for the market", async () => {
    const clock = { now: START };
    const strategy = new FlipFlatStrategy();
    const ctx = context({
      clock,
      signals: [],
      openOrders: [
        {
          id: "existing-order",
          marketRef: MARKET,
          side: "SELL",
          size: 10,
          filledSize: 0,
          price: 0.5,
          status: "open",
        },
      ],
    });

    expect(await exits(strategy, ctx)).toHaveLength(0);
    clock.now += 7 * DAY_MS;
    expect(await exits(strategy, ctx)).toHaveLength(0);
  });

  it("does not reset the original hold time after a same-market top-up", async () => {
    const clock = { now: START };
    const sharedMemory = memory();
    const strategy = new FlipFlatStrategy();
    const ctx = context({
      clock,
      signals: [],
      memory: sharedMemory,
      config: { allocationMode: "portfolio-kelly", takeProfitPrice: null },
    });

    expect(await exits(strategy, ctx)).toHaveLength(0);
    clock.now += 6 * DAY_MS;
    await strategy.onActionResult(
      ctx,
      { kind: "enter", marketRef: MARKET, side: "YES", notional: 5, reason: "top-up" },
      { placed: true, placedNotional: 5 },
    );
    clock.now += DAY_MS;

    expect(await exits(strategy, ctx)).toHaveLength(1);
  });

  it("prunes an absent position before seeding a later holding", async () => {
    const clock = { now: START };
    const strategy = new FlipFlatStrategy();
    const ctx = context({ clock, positions: [], config: { takeProfitPrice: null } });
    await strategy.onActionResult(
      ctx,
      { kind: "enter", marketRef: MARKET, side: "YES", notional: 5 },
      { placed: true, placedNotional: 5 },
    );

    clock.now += DAY_MS;
    expect(await exits(strategy, ctx)).toHaveLength(0);
    clock.now += 7 * DAY_MS;
    ctx.positions = [position()];
    expect(await exits(strategy, ctx)).toHaveLength(0);
  });
});

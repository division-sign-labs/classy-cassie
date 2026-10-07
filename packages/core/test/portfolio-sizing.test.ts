// packages/core/test/portfolio-sizing.test.ts
// Portfolio-relative sizing for the base signals strategy: quarter-Kelly
// targets, market/event concentration caps, repeat-signal top-ups, and the
// size haircut for markets that resolve soon.

import { describe, expect, it } from "vitest";
import {
  silentLogger,
  type Order,
  type Position,
  type Signal,
  type StrategyContext,
  type StrategyMemory,
} from "@quotient-forecasting/cassie-core";
import {
  FlipFlatStrategy,
  nearResolutionSizeFactor,
  portfolioKellyTargetUsd,
} from "../../../strategies/flip-flat/dist/index.js";

const NOW = Date.parse("2026-08-31T12:00:00Z");
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

function signal(marketRef: string, spreadPp = 20, over: Partial<Signal> = {}): Signal {
  return {
    id: `sig-${marketRef}`,
    ts: new Date(NOW).toISOString(),
    venue: "polymarket",
    marketRef,
    side: "YES",
    prob: 0.5 + spreadPp / 100,
    refPrice: 0.5,
    spreadPp,
    ttlSec: 86_400,
    ...over,
  };
}

function context(input: {
  signals: Signal[];
  positions?: Position[];
  openOrders?: Order[];
  equity?: number;
  eventRef?: (marketRef: string) => Promise<string | undefined>;
  config?: Record<string, unknown>;
}): StrategyContext {
  const positions = input.positions ?? [];
  const openOrders = input.openOrders ?? [];
  const equity = input.equity ?? 1_000;
  return {
    botId: "portfolio-sizing",
    venueId: "polymarket",
    config: {
      allocationMode: "portfolio-kelly",
      kellyFraction: 0.25,
      marketCapPct: 5,
      eventCapPct: 7.5,
      takeProfitPrice: null,
      ...input.config,
    },
    signals: { latest: async () => input.signals },
    venue: {
      balances: async () => [{ asset: "pUSD", total: equity, available: equity }],
      positions: async () => positions,
      book: async (marketRef: string) => ({
        marketRef,
        bids: [{ price: 0.49, size: 6_000 }],
        asks: [{ price: 0.51, size: 6_000 }],
        ts: NOW,
      }),
      quote: async (marketRef: string) => ({
        marketRef,
        bid: 0.49,
        ask: 0.51,
        mid: 0.5,
        volume24h: 1_000_000,
        spreadBps: 400,
        ts: NOW,
      }),
      openOrders: async () => openOrders,
      fills: async () => [],
      eventRef: input.eventRef ?? (async (marketRef: string) => `event:${marketRef}`),
    },
    positions,
    openOrders,
    equity,
    log: silentLogger,
    now: () => NOW,
    memory: memory(),
  };
}

async function entries(ctx: StrategyContext) {
  return (await new FlipFlatStrategy().tick(ctx)).filter((action) => action.kind === "enter");
}

describe("portfolio Kelly target", () => {
  it("computes quarter Kelly for a binary contract", () => {
    // Full Kelly = (0.60 - 0.50) / (1 - 0.50) = 20%; quarter Kelly = 5%.
    expect(
      portfolioKellyTargetUsd({
        prob: 0.6,
        price: 0.5,
        equity: 1_000,
        kellyFraction: 0.25,
        marketCapPct: 100,
      }),
    ).toBeCloseTo(50, 8);
  });

  it("caps the target at 5% of equity", () => {
    expect(
      portfolioKellyTargetUsd({
        prob: 0.7,
        price: 0.5,
        equity: 1_000,
        kellyFraction: 0.25,
        marketCapPct: 5,
      }),
    ).toBeCloseTo(50, 8);
  });

  it("scales the target with current equity", () => {
    const target = (equity: number) =>
      portfolioKellyTargetUsd({
        prob: 0.51,
        price: 0.5,
        equity,
        kellyFraction: 0.25,
        marketCapPct: 5,
      });
    expect(target(1_000)).toBeCloseTo(5, 8);
    expect(target(2_000)).toBeCloseTo(10, 8);
  });
});

describe("flip-flat portfolio allocation", () => {
  it("uses quarter Kelly and the event cap without a market cap, resolution cut, or exit-depth floor", async () => {
    const ctx = context({ signals: [signal("near", 8, { endsAt: NOW + DAY_MS })] });
    ctx.config = {};
    ctx.venue.book = async () => { throw new Error("no exit-depth lookup needed"); };
    const got = await entries(ctx);
    expect(got).toHaveLength(1);
    expect(got[0]!.notional).toBeCloseTo(40);
    expect(got[0]!.provenance).toMatchObject({ targetUsd: expect.closeTo(40), eventCapUsd: 50 });
    expect(got[0]!.provenance).not.toHaveProperty("marketCapUsd");
    expect(got[0]!.provenance).not.toHaveProperty("nearResolutionSizeFactor");
  });

  it("reserves sibling positions and entries against the default 5% event cap", async () => {
    const ctx = context({
      signals: [signal("first", 8), signal("second", 6)],
      positions: [{ marketRef: "held", side: "YES", size: 20, avgPrice: 0.5 }],
      eventRef: async () => "same-event",
    });
    ctx.config = {};
    const got = await entries(ctx);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ marketRef: "first", notional: expect.closeTo(40) });
  });

  it("skips a published signal when the live price leaves no positive Kelly stake", async () => {
    const ctx = context({ signals: [signal("no-edge", 0)] });
    ctx.config = {};
    expect(await entries(ctx)).toEqual([]);
  });

  it.each(["portfolio-kelly", "daily-budget", "fixed-notional"])("uses publication edge eligibility for sports in %s mode", async (allocationMode) => {
    const ctx = context({ config: { allocationMode, entrySpreadPp: 15, maxEntrySpreadPp: 30 }, signals: [
      signal("sport-low", 5, { sleeve: "sports" }), signal("sport-high", 40, { sleeve: "sports" }),
      signal("other-low", 5), signal("other-high", 40),
    ] });
    const got = await entries(ctx);
    expect(got.map(action => action.marketRef).sort()).toEqual(["sport-high", "sport-low"]);
    expect(got.every(action => action.provenance?.signalSleeve === "sports")).toBe(true);
    if (allocationMode === "portfolio-kelly") expect(got.find(action => action.marketRef === "sport-low")!.notional).toBeCloseTo(25);
  });

  it("still rejects stale sports forecasts and insufficient sports exit liquidity", async () => {
    const ctx = context({ config: { minExitDepth2cUsd: 2_500 }, signals: [signal("old", 5, { sleeve: "sports", ts: new Date(NOW - 86_400_001).toISOString() }),
      signal("thin", 5, { sleeve: "sports" })] });
    ctx.venue.book = async marketRef => ({ marketRef, bids: [{ price: .49, size: 100 }], asks: [{ price: .51, size: 100 }], ts: NOW });
    expect(await entries(ctx)).toEqual([]);
  });

  it("uses current probability for sports Kelly sizing even when publication approved the entry", async () => {
    expect(await entries(context({ signals: [signal("no-kelly-stake", -5, { sleeve: "sports" })] }))).toEqual([]);
  });

  it("opens a new eligible market at its capped Kelly target", async () => {
    const got = await entries(context({ signals: [signal("m-new")] }));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ marketRef: "m-new", side: "YES", notional: 50 });
  });

  it("tops up a same-side position only by the gap from its cost basis", async () => {
    const got = await entries(
      context({
        signals: [signal("m-held")],
        positions: [{ marketRef: "m-held", side: "YES", size: 20, avgPrice: 0.25 }],
      }),
    );
    expect(got).toHaveLength(1);
    // $50 target - (20 shares x $0.25 average entry) = $45 top-up.
    expect(got[0]).toMatchObject({ marketRef: "m-held", side: "YES", notional: 45 });
  });

  it.each([
    {
      name: "the held cost basis is already at the target",
      positions: [{ marketRef: "m-held", side: "YES" as const, size: 200, avgPrice: 0.25 }],
      openOrders: [] as Order[],
    },
    {
      name: "the held position is on the opposite side",
      positions: [{ marketRef: "m-held", side: "NO" as const, size: 20, avgPrice: 0.25 }],
      openOrders: [] as Order[],
    },
    {
      name: "an order for the market is still open",
      positions: [{ marketRef: "m-held", side: "YES" as const, size: 20, avgPrice: 0.25 }],
      openOrders: [
        {
          id: "o-held",
          marketRef: "m-held",
          side: "BUY" as const,
          size: 10,
          filledSize: 0,
          price: 0.5,
          status: "open" as const,
        },
      ],
    },
  ])("does not top up when $name", async ({ positions, openOrders }) => {
    expect(await entries(context({ signals: [signal("m-held")], positions, openOrders }))).toHaveLength(0);
  });

  it("reserves two planned sibling entries against the 7.5% event cap", async () => {
    const siblings = new Set(["m-a", "m-b", "m-c"]);
    const got = await entries(
      context({
        signals: [signal("m-a", 22), signal("m-b", 21), signal("m-c", 20)],
        eventRef: async (marketRef) => (siblings.has(marketRef) ? "polymarket:event-1" : `event:${marketRef}`),
      }),
    );
    expect(got.map((entry) => entry.marketRef)).toEqual(["m-a", "m-b"]);
    expect(got.reduce((sum, entry) => sum + entry.notional, 0)).toBe(75);
  });

  it("fails closed when the market event cannot be resolved", async () => {
    expect(
      await entries(
        context({
          signals: [signal("m-unresolved")],
          eventRef: async () => undefined,
        }),
      ),
    ).toHaveLength(0);
  });

  it("fails closed when an existing exposure cannot be assigned to an event", async () => {
    expect(
      await entries(
        context({
          signals: [signal("m-new")],
          positions: [{ marketRef: "m-unknown-held", side: "YES", size: 20, avgPrice: 0.25 }],
          eventRef: async (marketRef) => (marketRef === "m-new" ? "polymarket:event-new" : undefined),
        }),
      ),
    ).toHaveLength(0);
  });

  describe("near-resolution size haircut", () => {
    const cfg = { nearResolutionDays: 3, nearResolutionSizeCutPct: 25 };

    it("cuts size inside the window, measured from now, inclusive of the boundary", () => {
      expect(nearResolutionSizeFactor(NOW + 2 * DAY_MS, NOW, cfg)).toBeCloseTo(0.75, 8);
      expect(nearResolutionSizeFactor(NOW + 3 * DAY_MS, NOW, cfg)).toBeCloseTo(0.75, 8);
      expect(nearResolutionSizeFactor(NOW + 3 * DAY_MS + 1, NOW, cfg)).toBe(1);
      expect(nearResolutionSizeFactor(NOW - DAY_MS, NOW, cfg)).toBeCloseTo(0.75, 8);
    });

    it("keeps full size without a resolution date or with the window off", () => {
      expect(nearResolutionSizeFactor(undefined, NOW, cfg)).toBe(1);
      expect(nearResolutionSizeFactor(NOW + DAY_MS, NOW, { ...cfg, nearResolutionDays: null })).toBe(1);
      expect(nearResolutionSizeFactor(NOW + DAY_MS, NOW, { ...cfg, nearResolutionSizeCutPct: 0 })).toBe(1);
    });

    it("sizes a portfolio entry at 75% of its target when the market resolves in two days", async () => {
      const got = await entries(context({ config: cfg, signals: [signal("m-soon", 20, { endsAt: NOW + 2 * DAY_MS })] }));
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ marketRef: "m-soon", notional: 37.5 });
      expect(got[0]!.provenance).toMatchObject({ targetUsd: 37.5, nearResolutionSizeFactor: 0.75, resolvesAt: NOW + 2 * DAY_MS });
    });

    it("leaves an entry alone when the market resolves later than the window", async () => {
      const got = await entries(context({ config: cfg, signals: [signal("m-later", 20, { endsAt: NOW + 10 * DAY_MS })] }));
      expect(got[0]).toMatchObject({ notional: 50 });
      expect(got[0]!.provenance).not.toHaveProperty("nearResolutionSizeFactor");
    });

    it("does not top a reduced position back up to the full target", async () => {
      const got = await entries(
        context({
          config: cfg,
          signals: [signal("m-soon", 20, { endsAt: NOW + 2 * DAY_MS })],
          positions: [{ marketRef: "m-soon", side: "YES", size: 75, avgPrice: 0.5 }],
        }),
      );
      expect(got).toHaveLength(0);
    });

    it("cuts a daily-budget entry by the same fraction", async () => {
      const got = await entries(
        context({
          signals: [signal("m-soon", 20, { endsAt: NOW + DAY_MS })],
          config: { allocationMode: "daily-budget", dailyBudgetUsd: 100, positionBudgetPct: 25 },
        }),
      );
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ notional: 18.75 });
    });
  });

  it("does not impose the former $100 daily entry throttle", async () => {
    const refs = ["m-1", "m-2", "m-3", "m-4", "m-5"];
    const got = await entries(
      context({
        signals: refs.map((marketRef) => signal(marketRef)),
        eventRef: async (marketRef) => `event:${marketRef}`,
      }),
    );
    expect(got).toHaveLength(5);
    expect(got.reduce((sum, entry) => sum + entry.notional, 0)).toBe(250);
  });
});

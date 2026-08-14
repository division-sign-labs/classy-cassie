// packages/core/test/signal-ranking.test.ts
// Capital goes to the widest edges. topN and the daily entry budget both
// bind partway down the signal list, so before ranking, "which markets get
// funded" was decided by the gateway's row order — a 25pp edge could be skipped
// for a 10pp one that happened to come back first.

import { describe, expect, it } from "vitest";
import {
  silentLogger,
  type Signal,
  type SignalSource,
  type StrategyContext,
  type StrategyMemory,
} from "@quotient-forecasting/cassie-core";
import { FlipFlatStrategy } from "../../../strategies/flip-flat/dist/index.js";

function sig(marketRef: string, spreadPp: number): Signal {
  return {
    id: `sig-${marketRef}`,
    ts: new Date().toISOString(),
    venue: "polymarket",
    marketRef,
    side: "YES",
    prob: 0.5 + spreadPp / 200,
    refPrice: 0.5,
    spreadPp,
    ttlSec: 7 * 86_400,
  };
}

/** Returns signals in deliberately worst-first order. */
function sourceOf(signals: Signal[]): SignalSource {
  return { latest: async () => signals };
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

function ctxWith(signals: Signal[], config: Record<string, unknown>, memory = strategyMemory(), now = () => Date.now()) {
  return {
    venueId: "polymarket" as const,
    config,
    signals: sourceOf(signals),
    positions: [],
    openOrders: [],
    equity: 1_000,
    now,
    log: silentLogger,
    memory,
    venue: {
      quote: async () => ({ marketRef: "x", bid: 0.49, ask: 0.51, mid: 0.5, volume24h: 1e6, spreadBps: 40, ts: Date.now() }),
      balances: async () => [{ asset: "pUSD", total: 1_000, available: 1_000 }],
    },
  } as never;
}

describe("signal ranking by edge", () => {
  it("funds the widest edges when slots are scarce", async () => {
    // Worst-first on the wire: the thin edges would win on insertion order.
    const signals = [sig("m-thin", 11), sig("m-mid", 18), sig("m-wide", 30)];
    const actions = await new FlipFlatStrategy().tick(
      ctxWith(signals, { entrySpreadPp: 10, topN: 2, dailyBudgetUsd: 100, positionBudgetPct: 50 }),
    );

    const entered = actions.filter((a) => a.kind === "enter").map((a) => a.marketRef);
    expect(entered).toEqual(["m-wide", "m-mid"]);
    expect(entered).not.toContain("m-thin");
  });

  it("still enters everything when slots are plentiful", async () => {
    const signals = [sig("m-thin", 11), sig("m-wide", 30)];
    const actions = await new FlipFlatStrategy().tick(
      ctxWith(signals, { entrySpreadPp: 10, topN: 5, dailyBudgetUsd: 100, positionBudgetPct: 50 }),
    );
    expect(actions.filter((a) => a.kind === "enter")).toHaveLength(2);
  });

  it("counts a resting order toward top N", async () => {
    const ctx = ctxWith(
      [sig("m-resting", 35), sig("m-next", 30)],
      { entrySpreadPp: 10, topN: 1, dailyBudgetUsd: 100, positionBudgetPct: 50 },
    ) as unknown as StrategyContext;
    ctx.openOrders = [
      { id: "o-1", marketRef: "m-resting", side: "BUY", size: 10, filledSize: 0, price: 0.5, status: "open" },
    ];
    const actions = await new FlipFlatStrategy().tick(ctx);
    expect(actions.filter((action) => action.kind === "enter")).toHaveLength(0);
  });

  it("orders by edge even when every signal qualifies", async () => {
    const signals = [sig("a", 12), sig("b", 40), sig("c", 25)];
    const actions = await new FlipFlatStrategy().tick(
      ctxWith(signals, { entrySpreadPp: 10, topN: 5, dailyBudgetUsd: 150, positionBudgetPct: 20 }),
    );
    expect(actions.filter((a) => a.kind === "enter").map((a) => a.marketRef)).toEqual(["b", "c", "a"]);
  });

  it("allocates the configured share of the daily budget to the widest edge", async () => {
    const signals = [sig("m-thin", 11), sig("m-wide", 35)];
    const actions = await new FlipFlatStrategy().tick(
      ctxWith(signals, { entrySpreadPp: 10, topN: 1, dailyBudgetUsd: 100, positionBudgetPct: 50 }),
    );
    const entered = actions.filter((a) => a.kind === "enter");
    expect(entered).toHaveLength(1);
    expect(entered[0]!.marketRef).toBe("m-wide");
    expect(entered[0]!.notional).toBe(50);
  });

  it("does not plan more than the remaining daily budget", async () => {
    const signals = [sig("a", 30), sig("b", 25), sig("c", 20)];
    const actions = await new FlipFlatStrategy().tick(
      ctxWith(signals, { entrySpreadPp: 10, topN: 3, dailyBudgetUsd: 100, positionBudgetPct: 60 }),
    );
    const entered = actions.filter((a) => a.kind === "enter");
    expect(entered.map((a) => a.notional)).toEqual([60, 40]);
  });

  it("charges only successfully placed entry notional and resets the next UTC day", async () => {
    const memory = strategyMemory();
    let now = Date.parse("2026-08-14T12:00:00Z");
    const ctx = ctxWith(
      [sig("a", 30), sig("b", 25)],
      { entrySpreadPp: 10, topN: 2, dailyBudgetUsd: 100, positionBudgetPct: 50 },
      memory,
      () => now,
    );
    const strategy = new FlipFlatStrategy();
    const first = await strategy.tick(ctx);
    const entries = first.filter((a) => a.kind === "enter");
    await strategy.onActionResult(ctx, entries[0]!, { placed: true, placedNotional: 50 });
    await strategy.onActionResult(ctx, entries[1]!, { placed: true, placedNotional: 50 });
    expect((await strategy.tick(ctx)).filter((a) => a.kind === "enter")).toHaveLength(0);

    now = Date.parse("2026-08-15T00:00:01Z");
    expect((await strategy.tick(ctx)).filter((a) => a.kind === "enter")).toHaveLength(2);
  });

  it("does not charge rejected entries to the daily budget", async () => {
    const memory = strategyMemory();
    const ctx = ctxWith(
      [sig("a", 30), sig("b", 25)],
      { entrySpreadPp: 10, topN: 2, dailyBudgetUsd: 100, positionBudgetPct: 50 },
      memory,
    );
    const strategy = new FlipFlatStrategy();
    const first = await strategy.tick(ctx);
    for (const entry of first.filter((action) => action.kind === "enter")) {
      await strategy.onActionResult(ctx, entry, { placed: false });
    }
    expect((await strategy.tick(ctx)).filter((action) => action.kind === "enter")).toHaveLength(2);
  });

  it("skips an entry whose sized notional is below the configured floor", async () => {
    const actions = await new FlipFlatStrategy().tick(
      ctxWith([sig("m-small", 20)], {
        entrySpreadPp: 10,
        dailyBudgetUsd: 10,
        positionBudgetPct: 50,
        minEntryNotional: 10,
      }),
    );
    expect(actions.filter((a) => a.kind === "enter")).toHaveLength(0);
  });

  it("carries the entry floor to the engine for post-cap enforcement", async () => {
    const actions = await new FlipFlatStrategy().tick(
      ctxWith([sig("m-large", 20)], {
        entrySpreadPp: 10,
        dailyBudgetUsd: 100,
        positionBudgetPct: 50,
        minEntryNotional: 10,
      }),
    );
    expect(actions.find((a) => a.kind === "enter")).toMatchObject({ minNotional: 10 });
  });
});

// packages/core/test/signal-ranking.test.ts
// Capital goes to the widest edges. maxOpenPositions and the sizing budget both
// bind partway down the signal list, so before ranking, "which markets get
// funded" was decided by the gateway's row order — a 25pp edge could be skipped
// for a 10pp one that happened to come back first.

import { describe, expect, it } from "vitest";
import { MemoryStateStore, silentLogger, type Signal, type SignalSource } from "@quotient/cassie-core";
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
    ttlSec: 86_400,
  };
}

/** Returns signals in deliberately worst-first order. */
function sourceOf(signals: Signal[]): SignalSource {
  return { latest: async () => signals };
}

function ctxWith(signals: Signal[], config: Record<string, unknown>) {
  return {
    venueId: "polymarket" as const,
    config,
    signals: sourceOf(signals),
    positions: [],
    openOrders: [],
    equity: 1_000,
    now: () => Date.now(),
    log: silentLogger,
    state: new MemoryStateStore(),
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
      ctxWith(signals, { entrySpreadPp: 10, maxOpenPositions: 2, maxPositionNotional: 50 }),
    );

    const entered = actions.filter((a) => a.kind === "enter").map((a) => a.marketRef);
    expect(entered).toEqual(["m-wide", "m-mid"]);
    expect(entered).not.toContain("m-thin");
  });

  it("still enters everything when slots are plentiful", async () => {
    const signals = [sig("m-thin", 11), sig("m-wide", 30)];
    const actions = await new FlipFlatStrategy().tick(
      ctxWith(signals, { entrySpreadPp: 10, maxOpenPositions: 5, maxPositionNotional: 50 }),
    );
    expect(actions.filter((a) => a.kind === "enter")).toHaveLength(2);
  });

  it("orders by edge even when every signal qualifies", async () => {
    const signals = [sig("a", 12), sig("b", 40), sig("c", 25)];
    const actions = await new FlipFlatStrategy().tick(
      ctxWith(signals, { entrySpreadPp: 10, maxOpenPositions: 5, maxPositionNotional: 50 }),
    );
    expect(actions.filter((a) => a.kind === "enter").map((a) => a.marketRef)).toEqual(["b", "c", "a"]);
  });

  it("leaves the budget to the widest edge under quarter-Kelly", async () => {
    const signals = [sig("m-thin", 11), sig("m-wide", 35)];
    const actions = await new FlipFlatStrategy().tick(
      ctxWith(signals, { entrySpreadPp: 10, maxOpenPositions: 1, sizing: "quarter-kelly", maxPositionNotional: 500 }),
    );
    const entered = actions.filter((a) => a.kind === "enter");
    expect(entered).toHaveLength(1);
    expect(entered[0]!.marketRef).toBe("m-wide");
  });
});

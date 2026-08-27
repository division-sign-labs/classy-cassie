// packages/core/test/agent-strategy.test.ts
// The monitoring-agent strategy against fakes: deterministic quarter-Kelly
// numbers, the anti-hallucination gate, the min-edge probability clamp,
// budget/slot caps, the paid-wake cadence gate, the Quotient spend meter, and
// preview's no-persistence guarantee.

import { describe, expect, it } from "vitest";
import {
  silentLogger,
  type MarketFilter,
  type MarketRow,
  type Order,
  type Position,
  type QuotientMarketRow,
  type StrategyContext,
  type StrategyMemory,
} from "@quotient-forecasting/cassie-core";
import {
  AgentStrategy,
  type AgentDecisionBatch,
  type AgentStrategyDeps,
} from "../../../strategies/agent/dist/index.js";

const MARKET = "KX-A";

function mapMemory(): StrategyMemory & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, value);
    },
  };
}

interface FakeWorld {
  deps: AgentStrategyDeps;
  counters: { mispriced: number; search: number; lookup: number; llm: number };
}

function fakeWorld(opts: {
  rows?: MarketRow[];
  qRows?: QuotientMarketRow[];
  batch?: AgentDecisionBatch;
} = {}): FakeWorld {
  const counters = { mispriced: 0, search: 0, lookup: 0, llm: 0 };
  const batch: AgentDecisionBatch = opts.batch ?? { assessment: "quiet", enters: [], exits: [] };
  return {
    counters,
    deps: {
      lister: {
        venue: "kalshi",
        async list(_filter: MarketFilter): Promise<MarketRow[]> {
          return (
            opts.rows ?? [
              { venue: "kalshi", marketRef: MARKET, question: "Will WTI close above $80?", volume24h: 42_000, yesPrice: 0.4, category: "Commodities" },
            ]
          );
        },
      },
      research: {
        async mispriced() {
          counters.mispriced++;
          return opts.qRows ?? [];
        },
        async searchMarkets() {
          counters.search++;
          return [];
        },
        async lookup() {
          counters.lookup++;
          return [];
        },
      },
      surplus: {
        async completeStructured<T>() {
          counters.llm++;
          return {
            parsed: batch as T,
            requestedModel: "gpt-5.6-sol",
            actualModel: "gpt-5.6-sol",
            promptTokens: 100,
            completionTokens: 50,
            routingMode: "minimum_discount" as const,
          };
        },
      },
    },
  };
}

function ctxOf(memory: StrategyMemory, over: Partial<StrategyContext> = {}, nowMs = 1_756_000_000_000): StrategyContext {
  return {
    botId: "bot-t",
    venueId: "kalshi",
    config: { prompt: "commodities ending within a week", budgetUsd: 200, riskBudgetPct: 5 },
    signals: { latest: async () => [] },
    venue: {
      balances: async () => [{ asset: "USD", total: 1_000, available: 1_000 }],
      positions: async () => [],
      book: async () => ({ marketRef: MARKET, bids: [], asks: [], ts: nowMs }),
      quote: async (m: string) => ({ marketRef: m, bid: 0.39, ask: 0.41, mid: 0.4, volume24h: 42_000, spreadBps: 500, ts: nowMs }),
      openOrders: async () => [],
      fills: async () => [],
    },
    positions: [] as Position[],
    openOrders: [] as Order[],
    equity: 1_000,
    log: silentLogger,
    now: () => nowMs,
    memory,
    ...over,
  };
}

const enterYes = {
  marketRef: MARKET,
  side: "YES" as const,
  prob: 0.6,
  confidence: "high" as const,
  rationale: "supply squeeze into expiry",
};

describe("AgentStrategy sizing", () => {
  it("computes the exact quarter-Kelly/fixed-fractional entry notional", async () => {
    const world = fakeWorld({ batch: { assessment: "one edge", enters: [enterYes], exits: [] } });
    const strategy = new AgentStrategy(world.deps);
    const memory = mapMemory();
    const actions = await strategy.tick(ctxOf(memory));
    // kellyEquity = min(1000, 200) = 200; ff = 5% = $10 risk; quarter-Kelly at
    // prob .6 / price .4 = 8.33% → ff binds: size 25 shares, notional $10.00.
    expect(actions).toEqual([
      expect.objectContaining({ kind: "enter", marketRef: MARKET, side: "YES", notional: 10, minNotional: 1 }),
    ]);
    expect(world.counters.llm).toBe(1);
    const report = memory.store.get("agent:lastRun") as { executed: Array<{ notional?: number; arithmetic?: string[] }> };
    expect(report.executed[0]!.notional).toBe(10);
    expect(report.executed[0]!.arithmetic!.join(" ")).toContain("full Kelly");
  });

  it("drops a hallucinated marketRef before any sizing", async () => {
    const world = fakeWorld({
      batch: { assessment: "?", enters: [{ ...enterYes, marketRef: "KX-INVENTED" }], exits: [] },
    });
    const strategy = new AgentStrategy(world.deps);
    const memory = mapMemory();
    const actions = await strategy.tick(ctxOf(memory));
    expect(actions).toEqual([]);
    const report = memory.store.get("agent:lastRun") as { executed: Array<{ skipped?: string }> };
    expect(report.executed[0]!.skipped).toMatch(/not in the candidate or held set/);
  });

  it("min-edge clamp sizes on Q's more conservative probability and gates the entry", async () => {
    const world = fakeWorld({
      qRows: [{ marketKey: `kalshi:${MARKET}`, qProbability: 0.45 }],
      batch: { assessment: "model is excited, Q is not", enters: [enterYes], exits: [] },
    });
    const strategy = new AgentStrategy(world.deps);
    const memory = mapMemory();
    const actions = await strategy.tick(ctxOf(memory));
    // Q at .45 vs price .40 → 5pp edge, below the high-confidence 7pp bar.
    expect(actions).toEqual([]);
    const report = memory.store.get("agent:lastRun") as { executed: Array<{ skipped?: string; sizingProb?: number }> };
    expect(report.executed[0]!.sizingProb).toBeCloseTo(0.45, 9);
    expect(report.executed[0]!.skipped).toMatch(/below the high-confidence bar/);
  });

  it("caps entries by headroom and maxPositions", async () => {
    const world = fakeWorld({
      rows: [
        { venue: "kalshi", marketRef: "KX-A", question: "a", volume24h: 40_000, yesPrice: 0.4 },
        { venue: "kalshi", marketRef: "KX-B", question: "b", volume24h: 40_000, yesPrice: 0.4 },
      ],
      batch: {
        assessment: "two edges",
        enters: [enterYes, { ...enterYes, marketRef: "KX-B" }],
        exits: [],
      },
    });
    const strategy = new AgentStrategy(world.deps);
    const memory = mapMemory();
    // A held position consumes budget headroom and one slot: deployed = 38 × 0.5
    // = $19 of the $20 budget, so the first entry (quarter-Kelly $1.67) shrinks
    // to the $1 headroom, and maxPositions 2 blocks the second (held + first
    // entry fill both slots).
    const held: Position = { marketRef: "KX-H", side: "YES", size: 38, avgPrice: 0.5 };
    const ctx = ctxOf(memory, {
      positions: [held],
      config: { prompt: "p", budgetUsd: 20, riskBudgetPct: 20, maxPositions: 2, minEntryNotional: 1 },
    });
    const actions = await strategy.tick(ctx);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "enter", marketRef: "KX-A", notional: 1 });
    const report = memory.store.get("agent:lastRun") as { executed: Array<{ marketRef: string; skipped?: string }> };
    const second = report.executed.find((line) => line.marketRef === "KX-B");
    expect(second!.skipped).toMatch(/maxPositions 2 reached/);
  });

  it("honors the optional daily budget via onActionResult persistence", async () => {
    const world = fakeWorld({ batch: { assessment: "edge", enters: [enterYes], exits: [] } });
    const strategy = new AgentStrategy(world.deps);
    const memory = mapMemory();
    const ctx = ctxOf(memory, {
      config: { prompt: "p", budgetUsd: 200, riskBudgetPct: 5, dailyBudgetUsd: 12, agentIntervalMin: 0.0001 },
    });
    const [action] = await strategy.tick(ctx);
    expect(action).toMatchObject({ kind: "enter", notional: 10 });
    await strategy.onActionResult!(ctx, action!, { placed: true, placedNotional: 10 });

    // Same day, next wake: only $2 of daily budget remains — below minEntryNotional’s
    // default $1? No: $2 ≥ $1, so the entry is capped to $2.
    const actions2 = await strategy.tick(ctxOf(memory, {
      config: { prompt: "p", budgetUsd: 200, riskBudgetPct: 5, dailyBudgetUsd: 12, agentIntervalMin: 0.0001 },
    }, 1_756_000_600_000));
    expect(actions2).toEqual([expect.objectContaining({ kind: "enter", notional: 2 })]);
  });
});

describe("AgentStrategy cadence and spend", () => {
  it("a second tick inside the interval makes zero paid calls", async () => {
    const world = fakeWorld();
    const strategy = new AgentStrategy(world.deps);
    const memory = mapMemory();
    await strategy.tick(ctxOf(memory));
    expect(world.counters.mispriced).toBe(1);
    const before = { ...world.counters };
    const actions = await strategy.tick(ctxOf(memory, {}, 1_756_000_000_000 + 5 * 60_000));
    expect(actions).toEqual([]);
    expect(world.counters).toEqual(before);
  });

  it("redeems still fire on a gated tick", async () => {
    const world = fakeWorld();
    const strategy = new AgentStrategy(world.deps);
    const memory = mapMemory();
    await strategy.tick(ctxOf(memory));
    const redeemable: Position = { marketRef: "KX-R", side: "YES", size: 5, avgPrice: 0.9, redeemable: true };
    const actions = await strategy.tick(ctxOf(memory, { positions: [redeemable] }, 1_756_000_000_000 + 60_000));
    expect(actions).toEqual([{ kind: "redeem", marketRef: "KX-R", reason: "market resolved" }]);
  });

  it("the spend meter stops enrichment at the per-wake cap", async () => {
    const world = fakeWorld();
    const strategy = new AgentStrategy(world.deps);
    const memory = mapMemory();
    await strategy.tick(ctxOf(memory, {
      config: { prompt: "p", budgetUsd: 200, maxQuotientSpendUsdPerWake: 0.02 },
    }));
    // $0.02 cap: mispriced ($0.02) fits; search ($0.01) and lookups do not.
    expect(world.counters.mispriced).toBe(1);
    expect(world.counters.search).toBe(0);
    expect(world.counters.lookup).toBe(0);
    const report = memory.store.get("agent:lastRun") as { quotientSpendUsd: number };
    expect(report.quotientSpendUsd).toBe(0.02);
  });
});

describe("AgentStrategy preview", () => {
  it("runs the full cycle without persisting anything", async () => {
    const world = fakeWorld({ batch: { assessment: "edge", enters: [enterYes], exits: [] } });
    const strategy = new AgentStrategy(world.deps);
    const memory = mapMemory();
    const report = await strategy.preview(ctxOf(memory));
    expect(report.executed[0]).toMatchObject({ kind: "enter", marketRef: MARKET, notional: 10 });
    expect(report.assessment).toBe("edge");
    expect(world.counters.llm).toBe(1);
    expect(memory.store.size).toBe(0);
  });
});

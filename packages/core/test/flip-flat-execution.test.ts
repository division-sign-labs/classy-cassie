// packages/core/test/flip-flat-execution.test.ts
import { describe, expect, it, vi } from "vitest";
import { silentLogger, type Order, type PredictionExecutionMarket, type Signal, type StrategyContext } from "@quotient-forecasting/cassie-core";
import { FlipFlatStrategy, PENDING_ENTRIES_MEMORY_KEY, DAILY_BUDGET_MEMORY_KEY, SCENARIO_EXIT_MEMORY_KEY } from "../../../strategies/flip-flat/dist/index.js";

const NOW = Date.parse("2026-09-04T12:00:00Z");
const HOLD_STARTS_MEMORY_KEY = "position-hold-starts";
type Parent = NonNullable<StrategyContext["execution"]>["parents"][number];

function parent(overrides: Partial<Parent> = {}): Parent {
  return {
    id: "parent-a", marketRef: "a", tokenId: "a-yes", conditionId: "condition-a", outcome: "YES", side: "BUY",
    status: "active", admittedAt: NOW - 60_000, deadlineAt: NOW + 60_000, filledSize: 0, filledNotionalUsd: 0,
    feeUsd: 0, reservedNotionalUsd: 10, reservedSize: 20, remainingSize: 20, priorMarketSize: 0,
    childOrderIds: ["child-a"], reason: "signal a", urgent: false,
    signalId: "signal-a", signalTs: new Date(NOW - 60_000).toISOString(), qHeld: 0.7,
    provenance: { eventRef: "event", signalId: "signal-a", signalTs: new Date(NOW - 60_000).toISOString(), qHeld: 0.7 },
    ...overrides,
  };
}

function signal(marketRef: string, prob = 0.7, side: "YES" | "NO" = "YES"): Signal {
  return { id: `signal-${marketRef}`, marketRef, venue: "polymarket", side, prob, refPrice: 0.5, spreadPp: (prob - 0.5) * 100,
    ttlSec: 3600, ts: new Date(NOW).toISOString() };
}

function setup(config: Record<string, unknown> = {}) {
  const memory = new Map<string, unknown>();
  const signals: Signal[] = [];
  const marketData = new Map<string, { bid: number; ask: number }>();
  const ctx: StrategyContext = {
    botId: "adaptive-test", venueId: "polymarket", config: { minExitDepth2cUsd: 0, takeProfitPrice: null, maxHoldDays: null, ...config },
    positions: [], openOrders: [], equity: 1000, log: silentLogger, now: () => NOW,
    memory: { get: async <T>(key: string) => memory.get(key) as T | undefined, set: async (key, value) => { memory.set(key, value); } },
    signals: { latest: async () => signals },
    execution: { parents: [], blocked: false, entryCooldowns: {}, dailySpentUsd: {} },
    venue: {
      balances: async () => [{ asset: "pUSD", total: 1000, available: 1000 }],
      positions: async () => ctx.positions, openOrders: async () => ctx.openOrders, fills: async () => [], eventRef: async () => "event",
      book: async () => { throw new Error("YES book must not be used for exact-token execution"); },
      quote: async () => { throw new Error("YES quote must not be mirrored for exact-token execution"); },
      executionMarket: async (marketRef, outcome): Promise<PredictionExecutionMarket> => {
        const { bid, ask } = marketData.get(`${marketRef}:${outcome}`) ?? { bid: 0.49, ask: 0.51 };
        return { marketRef, tokenId: `${marketRef}-${outcome.toLowerCase()}`, conditionId: `condition-${marketRef}`, outcome,
          tickSize: 0.01, minOrderSize: 1, acceptingOrders: true, observedAt: NOW,
          book: { marketRef, bids: [{ price: bid, size: 10000 }], asks: [{ price: ask, size: 10000 }], ts: NOW },
          quote: { marketRef, bid, ask, mid: (bid + ask) / 2, ts: NOW, volume24h: 100000, spreadBps: 400 } };
      },
    },
  };
  return { ctx, memory, signals, marketData, strategy: new FlipFlatStrategy() };
}

describe("signals strategy adaptive accounting", () => {
  it("redeems both resolved outcomes once, including a loser with zero value and no entry signal", async () => {
    const { ctx, strategy } = setup();
    ctx.positions = [
      { marketRef: "a", conditionId: "condition-a", side: "YES", size: 2, avgPrice: 0.7, currentPrice: 0, redeemable: true },
      { marketRef: "a", conditionId: "condition-a", side: "NO", size: 1, avgPrice: 0.3, currentPrice: 1, redeemable: true },
    ];
    expect(await strategy.tick(ctx)).toEqual([{ kind: "redeem", marketRef: "a", reason: "market resolved" }]);
  });
  it("does not book admission acknowledgments as spending, holdings, or a second reservation", async () => {
    const { ctx, memory, strategy } = setup({ allocationMode: "daily-budget" });
    await strategy.onActionResult(ctx, { kind: "enter", marketRef: "a", side: "YES", notional: 20, reason: "signal" }, { placed: false, executionId: "parent-a" });
    expect(memory.has(DAILY_BUDGET_MEMORY_KEY)).toBe(false);
    expect(memory.has(PENDING_ENTRIES_MEMORY_KEY)).toBe(false);
    expect(memory.has(HOLD_STARTS_MEMORY_KEY)).toBe(false);
  });

  it("combines legacy spending, confirmed adaptive spending, and working reservations once", async () => {
    const { ctx, memory, signals, strategy } = setup({ allocationMode: "daily-budget", dailyBudgetUsd: 100, positionBudgetPct: 100 });
    memory.set(DAILY_BUDGET_MEMORY_KEY, { utcDay: "2026-09-04", placedUsd: 5 });
    ctx.execution!.dailySpentUsd["2026-09-04"] = 10;
    ctx.execution!.parents = [parent({ reservedNotionalUsd: 30 })];
    signals.push(signal("b"));
    const actions = await strategy.tick(ctx);
    expect(actions).toContainEqual(expect.objectContaining({ kind: "enter", marketRef: "b", notional: 55 }));
    expect(memory.get(DAILY_BUDGET_MEMORY_KEY)).toEqual({ utcDay: "2026-09-04", placedUsd: 5 });
  });

  it("counts partial fills and their working parent once across a shared event cap", async () => {
    const { ctx, signals, strategy } = setup({ eventCapPct: 3 });
    ctx.execution!.parents = [parent({ filledSize: 20, filledNotionalUsd: 10, firstFillAt: NOW - 30_000 })];
    ctx.positions = [{ marketRef: "a", side: "YES", size: 10, avgPrice: 0.5 }];
    ctx.openOrders = [{ id: "child-a", marketRef: "a", tokenId: "a-yes", side: "BUY", outcome: "YES", size: 20, filledSize: 0, price: 0.4, status: "open" }];
    signals.push(signal("b"));
    const actions = await strategy.tick(ctx);
    expect(actions).toContainEqual(expect.objectContaining({ kind: "enter", marketRef: "b", notional: 10 }));
  });

  it("anchors hold age to confirmed fills and does not resurrect reservations after an exit", async () => {
    const { ctx, memory, signals, strategy } = setup();
    const firstFillAt = NOW - 20_000;
    ctx.execution!.parents = [parent({ status: "completed", filledSize: 20, filledNotionalUsd: 10, firstFillAt,
      reservedNotionalUsd: 0, remainingSize: 0, reservedSize: 0 })];
    ctx.positions = [{ marketRef: "a", side: "YES", size: 20, avgPrice: 0.5 }];
    await strategy.tick(ctx);
    expect(memory.get(HOLD_STARTS_MEMORY_KEY)).toEqual({ byMarket: { a: firstFillAt } });
    expect(memory.get(SCENARIO_EXIT_MEMORY_KEY)).toMatchObject({ byMarket: { a: { entryFilledAt: firstFillAt, entryFillSource: "venue-fill" } } });
    ctx.positions = [];
    signals.push(signal("a"));
    expect(await strategy.tick(ctx)).toContainEqual(expect.objectContaining({ kind: "enter", marketRef: "a" }));
  });

  it("replaces a position-observation age seed when confirmation arrives later", async () => {
    const { ctx, memory, strategy } = setup();
    ctx.positions = [{ marketRef: "a", side: "YES", size: 20, avgPrice: 0.5 }];
    ctx.execution!.parents = [parent()];
    await strategy.tick(ctx);
    expect(memory.get(HOLD_STARTS_MEMORY_KEY)).toEqual({ byMarket: { a: NOW } });
    const firstFillAt = NOW - 20_000;
    ctx.execution!.parents[0] = parent({ filledSize: 20, filledNotionalUsd: 10, firstFillAt });
    await strategy.tick(ctx);
    expect(memory.get(HOLD_STARTS_MEMORY_KEY)).toEqual({ byMarket: { a: firstFillAt } });
  });
});

describe("signals strategy fill-receipt reconciliation", () => {
  const ACCOUNTING_KEY = "adaptive-execution-accounting";

  it("treats a sub-unit residue between fill receipts and the position index as absorbed", async () => {
    const { ctx, memory, signals, strategy } = setup();
    const info = vi.fn(); const warn = vi.fn();
    ctx.log = { ...silentLogger, info, warn };
    // The receipt carries five decimals, the venue position index four.
    ctx.execution!.parents = [parent({ status: "completed", filledSize: 17.71715, filledNotionalUsd: 8, firstFillAt: NOW - 30_000,
      lastFillAt: NOW - 30_000, terminalAt: NOW - 25_000, reservedNotionalUsd: 0, remainingSize: 0, reservedSize: 0 })];
    ctx.positions = [{ marketRef: "a", side: "YES", size: 17.7171, avgPrice: 0.45 }];
    signals.push(signal("a"));
    const actions = await strategy.tick(ctx);
    expect(actions).toContainEqual(expect.objectContaining({ kind: "enter", marketRef: "a" }));
    expect(info.mock.calls.some(([message]) => String(message).includes("entry handoff pending"))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect((memory.get(ACCOUNTING_KEY) as { byParent: Record<string, { absorbedSize: number }> }).byParent["parent-a"]!.absorbedSize).toBe(17.71715);
  });

  it("releases a finished entry whose receipts never appeared in the venue position after the reservation window, once", async () => {
    const { ctx, memory, signals, strategy } = setup({ pendingEntryReservationSec: 900 });
    const info = vi.fn(); const warn = vi.fn();
    ctx.log = { ...silentLogger, info, warn };
    ctx.execution!.parents = [parent({ status: "completed", filledSize: 20, filledNotionalUsd: 10, firstFillAt: NOW - 902_000,
      lastFillAt: NOW - 902_000, terminalAt: NOW - 901_000, reservedNotionalUsd: 0, remainingSize: 0, reservedSize: 0 })];
    ctx.positions = [];
    signals.push(signal("a"));
    const actions = await strategy.tick(ctx);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/adaptive entry parent-a for a released after 901s: 20\.0000 shares from fill receipts never appeared/);
    expect((memory.get(ACCOUNTING_KEY) as { byParent: Record<string, { absorbedSize: number }> }).byParent["parent-a"]!.absorbedSize).toBe(20);
    expect(actions).toContainEqual(expect.objectContaining({ kind: "enter", marketRef: "a" }));
    await strategy.tick(ctx);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps a finished entry reserved while its receipts are recent and unobserved", async () => {
    const { ctx, signals, strategy } = setup({ pendingEntryReservationSec: 900 });
    const info = vi.fn();
    ctx.log = { ...silentLogger, info };
    ctx.execution!.parents = [parent({ status: "completed", filledSize: 20, filledNotionalUsd: 10, firstFillAt: NOW - 30_000,
      lastFillAt: NOW - 30_000, terminalAt: NOW - 25_000, reservedNotionalUsd: 0, remainingSize: 0, reservedSize: 0 })];
    ctx.positions = [];
    signals.push(signal("a"));
    const actions = await strategy.tick(ctx);
    expect(actions).not.toContainEqual(expect.objectContaining({ kind: "enter", marketRef: "a" }));
    expect(info.mock.calls.some(([message]) => String(message).includes("entry handoff pending for a"))).toBe(true);
  });
});

describe("signals strategy working-order exits", () => {
  it.each(["BUY", "SELL"] as const)("reevaluates routine exits while a managed %s order works", async (side) => {
    const { ctx, signals, marketData, strategy } = setup({ takeProfitPrice: 0.45 });
    ctx.execution!.parents = [parent({ side, priorMarketSize: 10 })];
    ctx.positions = [{ marketRef: "a", side: "YES", size: 10, avgPrice: 0.4 }];
    ctx.openOrders = [{ id: "child-a", marketRef: "a", tokenId: "a-yes", side, size: 10, filledSize: 0, price: 0.6, status: "open" }];
    signals.push(signal("a", 0.51));
    // The exact-token bid of 0.49 clears the 0.45 floor on every tick the order works.
    for (let i = 0; i < 2; i++) expect(await strategy.tick(ctx)).toContainEqual(expect.objectContaining({ kind: "exit", marketRef: "a" }));
    marketData.set("a:YES", { bid: 0.4, ask: 0.42 });
    expect((await strategy.tick(ctx)).filter((action) => action.kind === "exit")).toEqual([]);
  });

  it("upgrades a pending normal exit to urgent when Q collapses", async () => {
    const { ctx, signals, strategy } = setup({ scenarioExitEnabled: true });
    ctx.positions = [{ marketRef: "a", side: "YES", size: 10, avgPrice: 0.5 }];
    ctx.execution!.parents = [parent({ id: "entry", childOrderIds: [], status: "completed", filledSize: 10, filledNotionalUsd: 5,
      firstFillAt: NOW - 30_000, reservedNotionalUsd: 0, reservedSize: 0, remainingSize: 0 })];
    signals.push(signal("a", 0.7));
    await strategy.tick(ctx);
    ctx.execution!.parents.push(parent({ id: "exit", side: "SELL" }));
    ctx.openOrders = [{ id: "child-a", marketRef: "a", tokenId: "a-yes", side: "SELL", size: 10, filledSize: 0, price: 0.6, status: "open" }];
    signals[0] = signal("a", 0.35);
    expect(await strategy.tick(ctx)).toContainEqual(expect.objectContaining({ kind: "exit", urgent: true, provenance: expect.objectContaining({ exitReason: "q_collapse" }) }));
  });

  it("uses the NO outcome quote for exits and entries", async () => {
    const { ctx, signals, marketData, strategy } = setup({ takeProfitPrice: 0.6 });
    ctx.positions = [{ marketRef: "a", side: "NO", size: 10, avgPrice: 0.4 }];
    marketData.set("a:NO", { bid: 0.69, ask: 0.71 });
    signals.push(signal("a", 0.71, "NO"));
    expect(await strategy.tick(ctx)).toContainEqual(expect.objectContaining({ kind: "exit", marketRef: "a" }));
  });

  it("leaves the previous exit decision intact when the exact token read fails", async () => {
    const { ctx, signals, strategy } = setup({ takeProfitPrice: 0.5 });
    ctx.positions = [{ marketRef: "a", side: "YES", size: 10, avgPrice: 0.5 }];
    signals.push(signal("a", 0.51));
    ctx.venue.executionMarket = async () => { throw new Error("book unavailable"); };
    await expect(strategy.tick(ctx)).rejects.toThrow("book unavailable");
  });
});

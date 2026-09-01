// packages/core/test/scenario-exit.test.ts
// Seven-day signal-exit state machine for the signals (flip-flat) strategy:
// Q-collapse, confirmed adverse cross, confirmed Q flip, positive
// price-led convergence, and the time stop, with per-forecast confirmation
// counting, immutable entry Q, and idempotent exit submission.

import { describe, expect, it } from "vitest";
import {
  type Action,
  type Fill,
  type MarketForecast,
  type Order,
  type Position,
  type Signal,
  type StrategyContext,
  type StrategyMemory,
} from "@quotient-forecasting/cassie-core";
import {
  FlipFlatConfigSchema,
  FlipFlatStrategy,
  SCENARIO_EXIT_MEMORY_KEY,
  applyForecastObservation,
  evaluateScenarioExit,
  forecastVersionKey,
  heldSideLiquidation,
  type ScenarioPositionRecord,
} from "../../../strategies/flip-flat/dist/index.js";

const MARKET = "scenario-market";
const START = Date.parse("2026-09-01T00:00:00Z");
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function memory(): StrategyMemory {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async <T>(key: string, value: T) => {
      values.set(key, value);
    },
  };
}

interface Env {
  clock: { now: number };
  positions: Position[];
  signals: Signal[];
  forecasts: MarketForecast[];
  yesBids: Array<{ price: number; size: number }>;
  yesAsks: Array<{ price: number; size: number }>;
  fills: Fill[];
  openOrders: Order[];
  memory: StrategyMemory;
  config: Record<string, unknown>;
  logs: string[];
}

function env(over: Partial<Env> = {}): Env {
  return {
    clock: { now: START },
    positions: [],
    signals: [],
    forecasts: [],
    yesBids: [{ price: 0.49, size: 10_000 }],
    yesAsks: [{ price: 0.51, size: 10_000 }],
    fills: [],
    openOrders: [],
    memory: memory(),
    config: {},
    logs: [],
    ...over,
  };
}

/** YES mid at `mid` with a 2c-wide book; NO positions read the mirrored book. */
function setYesMid(e: Env, mid: number, size = 10_000): void {
  e.yesBids = [{ price: Number((mid - 0.01).toFixed(4)), size }];
  e.yesAsks = [{ price: Number((mid + 0.01).toFixed(4)), size }];
}

function forecast(id: string, offsetMs: number, probYes: number): MarketForecast {
  return {
    id,
    ts: new Date(START + offsetMs).toISOString(),
    venue: "polymarket",
    marketRef: MARKET,
    probYes,
  };
}

function signal(side: "YES" | "NO", prob: number, over: Partial<Signal> = {}): Signal {
  return {
    id: `sig-${side}`,
    ts: new Date(START).toISOString(),
    venue: "polymarket",
    marketRef: MARKET,
    side,
    prob,
    refPrice: 0.5,
    spreadPp: Math.abs(prob - 0.5) * 100,
    ttlSec: 30 * 86_400,
    ...over,
  };
}

function ctx(e: Env): StrategyContext {
  const yesBook = () => ({ marketRef: MARKET, bids: e.yesBids, asks: e.yesAsks, ts: e.clock.now });
  return {
    botId: "scenario-exit",
    venueId: "polymarket",
    config: {
      allocationMode: "portfolio-kelly",
      scenarioExitEnabled: true,
      ...e.config,
    },
    signals: {
      latest: async () => e.signals,
      forecasts: async () => e.forecasts,
    },
    venue: {
      book: async () => yesBook(),
      quote: async () => {
        const bid = e.yesBids[0]?.price ?? 0;
        const ask = e.yesAsks[0]?.price ?? 1;
        return { marketRef: MARKET, bid, ask, mid: (bid + ask) / 2, volume24h: 1_000_000, spreadBps: 40, ts: e.clock.now };
      },
      balances: async () => [{ asset: "pUSD", total: 1_000, available: 1_000 }],
      positions: async () => e.positions,
      openOrders: async () => e.openOrders,
      fills: async (since: number) => e.fills.filter((fill) => fill.ts >= since),
      eventRef: async (marketRef: string) => `event:${marketRef}`,
    },
    positions: e.positions,
    openOrders: e.openOrders,
    equity: 1_000,
    log: {
      debug: () => undefined,
      info: (msg: string) => {
        e.logs.push(msg);
      },
      warn: (msg: string) => {
        e.logs.push(msg);
      },
      error: (msg: string) => {
        e.logs.push(msg);
      },
    },
    now: () => e.clock.now,
    memory: e.memory,
  } as StrategyContext;
}

/** Simulate an engine-placed entry: immutable entry Q comes from the published signal snapshot. */
async function enter(
  strategy: FlipFlatStrategy,
  e: Env,
  input: { side: "YES" | "NO"; entryQ: number; avgPrice: number; size?: number; ackStatus?: "filled" | "open"; orderId?: string },
): Promise<void> {
  const size = input.size ?? 10;
  const sig = signal(input.side, input.entryQ);
  const action: Action = {
    kind: "enter",
    marketRef: MARKET,
    side: input.side,
    notional: size * input.avgPrice,
    provenance: { signalId: sig.id, signalTs: sig.ts, side: sig.side, qHeld: input.entryQ, signalRefPrice: sig.refPrice },
  };
  await strategy.onActionResult(ctx(e), action, {
    placed: true,
    placedNotional: size * input.avgPrice,
    placedSize: size,
    limitPrice: input.avgPrice,
    orderId: input.orderId ?? "entry-1",
    clientId: "client-1",
    status: input.ackStatus ?? "filled",
    ...(input.ackStatus === "open" ? {} : { filledSize: size }),
    placedAt: e.clock.now,
  });
  e.positions = [{ marketRef: MARKET, side: input.side, size, avgPrice: input.avgPrice }];
}

async function exits(strategy: FlipFlatStrategy, e: Env): Promise<Extract<Action, { kind: "exit" }>[]> {
  return (await strategy.tick(ctx(e))).filter((action): action is Extract<Action, { kind: "exit" }> => action.kind === "exit");
}

async function record(e: Env): Promise<ScenarioPositionRecord> {
  const state = await e.memory.get<{ byMarket: Record<string, ScenarioPositionRecord> }>(SCENARIO_EXIT_MEMORY_KEY);
  const rec = state?.byMarket[MARKET];
  if (!rec) throw new Error("no scenario record");
  return rec;
}

describe("scenario exit configuration", () => {
  it("is off by default so existing bots keep the legacy exit overlay", () => {
    const cfg = FlipFlatConfigSchema.parse({});
    expect(cfg.scenarioExitEnabled).toBe(false);
    expect(cfg.positiveConvergenceEdgePp).toBe(3);
    expect(cfg.positiveConvergenceMinProfitPct).toBe(4);
    expect(cfg.positiveConvergenceMaxQRetreatPp).toBe(1);
    expect(cfg.adverseCrossConfirmations).toBe(2);
    expect(cfg.qCollapsePp).toBe(30);
    expect(cfg.flipConfirmations).toBe(2);
    expect(cfg.flipExitMaxRemainingEdgePp).toBe(5);
    expect(cfg.maxHoldDays).toBe(7);
  });

  it("does not run the state machine when disabled", async () => {
    const e = env({ config: { scenarioExitEnabled: false, convergenceExit: false } });
    const strategy = new FlipFlatStrategy();
    await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.6 });
    e.forecasts = [forecast("f", HOUR_MS, 0.2)];
    setYesMid(e, 0.25);
    expect(await exits(strategy, e)).toHaveLength(0);
  });
});

describe("pure exit precedence", () => {
  const cfg = FlipFlatConfigSchema.parse({ scenarioExitEnabled: true });
  const base = {
    resolved: false,
    entryQHeld: 0.8,
    currentQHeld: 0.2,
    midHeld: 0.25,
    executablePnlPct: -60,
    ageMs: 8 * DAY_MS,
    adverseCrossConfirmations: 2,
    flipConfirmed: true,
  };

  it("returns one canonical reason in precedence order", () => {
    expect(evaluateScenarioExit({ ...base, resolved: true }, cfg).reason).toBe("market_resolved");
    expect(evaluateScenarioExit(base, cfg).reason).toBe("q_collapse");
    expect(evaluateScenarioExit({ ...base, entryQHeld: 0.4 }, cfg).reason).toBe("adverse_cross");
    expect(evaluateScenarioExit({ ...base, entryQHeld: 0.4, adverseCrossConfirmations: 1 }, cfg).reason).toBe("q_flip");
    expect(
      evaluateScenarioExit(
        { ...base, entryQHeld: 0.7, currentQHeld: 0.7, midHeld: 0.69, executablePnlPct: 10, adverseCrossConfirmations: 0, flipConfirmed: false },
        cfg,
      ).reason,
    ).toBe("positive_convergence");
    expect(
      evaluateScenarioExit(
        { ...base, entryQHeld: 0.7, currentQHeld: 0.7, midHeld: 0.5, executablePnlPct: -10, adverseCrossConfirmations: 0, flipConfirmed: false },
        cfg,
      ).reason,
    ).toBe("time_stop");
    expect(
      evaluateScenarioExit(
        { ...base, entryQHeld: 0.7, currentQHeld: 0.7, midHeld: 0.5, executablePnlPct: -10, ageMs: DAY_MS, adverseCrossConfirmations: 0, flipConfirmed: false },
        cfg,
      ).reason,
    ).toBeUndefined();
  });

  it("counts a forecast version once and resets on a new committed forecast", () => {
    const rec = { adverseCross: { count: 0, versions: [] as string[] }, flip: { count: 0, versions: [] as string[], confirmed: false } } as Pick<
      ScenarioPositionRecord,
      "lastForecastVersion" | "lastForecastTs" | "currentQHeld" | "adverseCross" | "flip"
    >;
    const v1 = forecastVersionKey(forecast("f", 0, 0.45));
    const v2 = forecastVersionKey(forecast("f", HOUR_MS, 0.45));
    const v3 = forecastVersionKey(forecast("f", 2 * HOUR_MS, 0.6));
    expect(v1).not.toBe(v2);
    for (let i = 0; i < 4; i++) {
      applyForecastObservation(rec, { version: v1, forecastTs: "t1", qHeld: 0.45, remainingEdgePp: -3 }, cfg);
    }
    expect(rec.flip).toMatchObject({ count: 1, confirmed: false });
    expect(rec.adverseCross.count).toBe(1);
    applyForecastObservation(rec, { version: v2, forecastTs: "t2", qHeld: 0.45, remainingEdgePp: -3 }, cfg);
    expect(rec.flip).toMatchObject({ count: 2, confirmed: true, versions: [v1, v2] });
    expect(rec.adverseCross).toMatchObject({ count: 2, versions: [v1, v2] });
    applyForecastObservation(rec, { version: v3, forecastTs: "t3", qHeld: 0.6, remainingEdgePp: 4 }, cfg);
    expect(rec.flip).toMatchObject({ count: 0, confirmed: false });
    expect(rec.adverseCross.count).toBe(0);
  });

  it("walks the held-side bids after fees for executable proceeds", () => {
    const liq = heldSideLiquidation(
      { marketRef: MARKET, bids: [{ price: 0.5, size: 5 }, { price: 0.4, size: 100 }], asks: [], ts: 0 },
      10,
      100,
    );
    expect(liq).toMatchObject({ bestBid: 0.5, executableSize: 10, unfilledSize: 0 });
    expect(liq!.grossProceedsUsd).toBeCloseTo(4.5, 9);
    expect(liq!.netProceedsUsd).toBeCloseTo(4.455, 9);
  });
});

describe("seven-day signal exit state machine", () => {
  it("1. exits immediately at a loss on a large Q collapse (80→20, market 25)", async () => {
    const e = env();
    const strategy = new FlipFlatStrategy();
    await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.6 });
    e.forecasts = [forecast("f", HOUR_MS, 0.2)];
    setYesMid(e, 0.25);
    const got = await exits(strategy, e);
    expect(got).toHaveLength(1);
    expect(got[0]!.reason).toMatch(/^q_collapse: entryQ 80\.0% → Q 20\.0%, mid 0\.250, bid 0\.240, edge -5\.0pp, retreat \+60\.0pp, pnl -60\.0%/);
    expect(got[0]!.provenance).toMatchObject({ exitReason: "q_collapse", entryQPct: 80, currentQPct: 20 });
  });

  it("2. exits via a confirmed Q flip after two distinct forecasts at 45% with the market at 43", async () => {
    const e = env();
    const strategy = new FlipFlatStrategy();
    await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.6 });
    setYesMid(e, 0.43);
    e.forecasts = [forecast("f", HOUR_MS, 0.45)];
    expect(await exits(strategy, e)).toHaveLength(0);
    expect((await record(e)).flip).toMatchObject({ count: 1, confirmed: false });
    e.clock.now += 5 * 60_000;
    e.forecasts = [forecast("f", 2 * HOUR_MS, 0.45)];
    const got = await exits(strategy, e);
    expect(got).toHaveLength(1);
    expect(got[0]!.reason).toMatch(/^q_flip: entryQ 80\.0% → Q 45\.0%, mid 0\.430, bid 0\.420, edge \+2\.0pp/);
    expect(got[0]!.reason).toMatch(/flip 2\/2/);
    expect((got[0]!.provenance as { confirmingForecastIds: string[] }).confirmingForecastIds).toHaveLength(2);
  });

  it("3. holds a confirmed flip while YES remains cheap versus Q (market 30, edge +15pp), then exits when the edge closes", async () => {
    const e = env();
    const strategy = new FlipFlatStrategy();
    await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.6 });
    setYesMid(e, 0.3);
    e.forecasts = [forecast("f", HOUR_MS, 0.45)];
    expect(await exits(strategy, e)).toHaveLength(0);
    e.forecasts = [forecast("f", 2 * HOUR_MS, 0.45)];
    expect(await exits(strategy, e)).toHaveLength(0);
    expect((await record(e)).flip).toMatchObject({ count: 2, confirmed: true });
    // Same forecast, market closes the edge to +2pp: the retained confirmation exits.
    setYesMid(e, 0.43);
    const got = await exits(strategy, e);
    expect(got).toHaveLength(1);
    expect(got[0]!.reason).toMatch(/^q_flip:/);
  });

  it("4. never counts the same forecast twice however often it is polled", async () => {
    const e = env();
    const strategy = new FlipFlatStrategy();
    await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.7 });
    // Q 55 vs market 60: non-positive spread at a loss; still one forecast.
    setYesMid(e, 0.6);
    e.forecasts = [forecast("f", HOUR_MS, 0.55)];
    for (let i = 0; i < 6; i++) {
      e.clock.now += 60_000;
      expect(await exits(strategy, e)).toHaveLength(0);
    }
    const rec = await record(e);
    expect(rec.adverseCross).toMatchObject({ count: 1 });
    expect(rec.adverseCross.versions).toHaveLength(1);
    // A flipped forecast polled repeatedly likewise stays at one confirmation
    // (market 30 keeps +15pp of edge, so the adverse run resets instead).
    setYesMid(e, 0.3);
    e.forecasts = [forecast("f", 2 * HOUR_MS, 0.45)];
    for (let i = 0; i < 6; i++) {
      e.clock.now += 60_000;
      expect(await exits(strategy, e)).toHaveLength(0);
    }
    expect((await record(e)).flip).toMatchObject({ count: 1, confirmed: false });
    expect((await record(e)).adverseCross.count).toBe(0);
  });

  it("5. exits at a loss once two genuinely distinct adverse forecasts confirm the cross", async () => {
    const e = env();
    const strategy = new FlipFlatStrategy();
    await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.7 });
    setYesMid(e, 0.6);
    e.forecasts = [forecast("f", HOUR_MS, 0.55)];
    expect(await exits(strategy, e)).toHaveLength(0);
    e.forecasts = [forecast("f", 2 * HOUR_MS, 0.56)];
    const got = await exits(strategy, e);
    expect(got).toHaveLength(1);
    expect(got[0]!.reason).toMatch(/^adverse_cross: entryQ 80\.0% → Q 56\.0%, mid 0\.600, bid 0\.590, edge -4\.0pp, retreat \+24\.0pp, pnl -15\.7%, adverse 2\/2/);
  });

  it("5b. resets the adverse run when a new committed forecast restores positive edge", async () => {
    const e = env();
    const strategy = new FlipFlatStrategy();
    await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.7 });
    setYesMid(e, 0.6);
    e.forecasts = [forecast("f", HOUR_MS, 0.55)];
    await exits(strategy, e);
    e.forecasts = [forecast("f", 2 * HOUR_MS, 0.7)];
    await exits(strategy, e);
    expect((await record(e)).adverseCross.count).toBe(0);
    e.forecasts = [forecast("f", 3 * HOUR_MS, 0.55)];
    expect(await exits(strategy, e)).toHaveLength(0);
    expect((await record(e)).adverseCross.count).toBe(1);
  });

  describe("6. positive convergence needs ≤3pp edge, ≥4% executable gain, and ≤1pp Q retreat", () => {
    async function setup(input: { entryQ: number; currentQ: number; mid: number; avgPrice: number }) {
      const e = env();
      const strategy = new FlipFlatStrategy();
      await enter(strategy, e, { side: "YES", entryQ: input.entryQ, avgPrice: input.avgPrice });
      setYesMid(e, input.mid);
      e.forecasts = [forecast("f", HOUR_MS, input.currentQ)];
      return { e, strategy };
    }

    it("takes profit when all three hold", async () => {
      const { e, strategy } = await setup({ entryQ: 0.7, currentQ: 0.7, mid: 0.69, avgPrice: 0.6 });
      const got = await exits(strategy, e);
      expect(got).toHaveLength(1);
      // Bid 0.68 on a 0.60 basis is +13.3% executable return.
      expect(got[0]!.reason).toMatch(/^positive_convergence: entryQ 70\.0% → Q 70\.0%, mid 0\.690, bid 0\.680, edge \+1\.0pp, retreat \+0\.0pp, pnl \+13\.3%/);
    });

    it("holds with 4pp of edge left", async () => {
      const { e, strategy } = await setup({ entryQ: 0.7, currentQ: 0.7, mid: 0.66, avgPrice: 0.6 });
      expect(await exits(strategy, e)).toHaveLength(0);
    });

    it("holds below a 4% executable return (a return, not four cents)", async () => {
      // Bid 0.68 on a 0.66 basis is +3.0%: two cents of gain is not enough.
      const { e, strategy } = await setup({ entryQ: 0.7, currentQ: 0.7, mid: 0.69, avgPrice: 0.66 });
      expect(await exits(strategy, e)).toHaveLength(0);
      // Bid 0.68 on a 0.65 basis is +4.6%: three cents clears the 4% return.
      const passing = await setup({ entryQ: 0.7, currentQ: 0.7, mid: 0.69, avgPrice: 0.65 });
      expect(await exits(passing.strategy, passing.e)).toHaveLength(1);
    });

    it("holds when Q retreated more than 1pp from entry (forecast-led, not market-led)", async () => {
      const { e, strategy } = await setup({ entryQ: 0.72, currentQ: 0.7, mid: 0.69, avgPrice: 0.6 });
      expect(await exits(strategy, e)).toHaveLength(0);
    });

    it("allows Q flat or higher than entry", async () => {
      const { e, strategy } = await setup({ entryQ: 0.68, currentQ: 0.7, mid: 0.69, avgPrice: 0.6 });
      expect(await exits(strategy, e)).toHaveLength(1);
    });

    it("measures the gain after the configured exit fee", async () => {
      // +4.6% gross becomes +3.6% after a 100bps fee.
      const e = env({ config: { exitFeeBps: 100 } });
      const strategy = new FlipFlatStrategy();
      await enter(strategy, e, { side: "YES", entryQ: 0.7, avgPrice: 0.65 });
      setYesMid(e, 0.69);
      e.forecasts = [forecast("f", HOUR_MS, 0.7)];
      expect(await exits(strategy, e)).toHaveLength(0);
    });
  });

  describe("7. the profit floor never vetoes the other branches", () => {
    it("collapse at a loss", async () => {
      const e = env();
      const strategy = new FlipFlatStrategy();
      await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.6 });
      setYesMid(e, 0.25);
      e.forecasts = [forecast("f", HOUR_MS, 0.2)];
      expect((await exits(strategy, e))[0]?.reason).toMatch(/^q_collapse:.*pnl -60\.0%/);
    });

    it("flip at a loss", async () => {
      const e = env();
      const strategy = new FlipFlatStrategy();
      await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.6 });
      setYesMid(e, 0.43);
      e.forecasts = [forecast("f", HOUR_MS, 0.45)];
      await exits(strategy, e);
      e.forecasts = [forecast("f", 2 * HOUR_MS, 0.45)];
      expect((await exits(strategy, e))[0]?.reason).toMatch(/^q_flip:.*pnl -30\.0%/);
    });

    it("time stop at a loss with Q still favorable", async () => {
      const e = env();
      const strategy = new FlipFlatStrategy();
      await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.6 });
      setYesMid(e, 0.5);
      e.forecasts = [forecast("f", HOUR_MS, 0.8)];
      e.clock.now += 7 * DAY_MS;
      const got = await exits(strategy, e);
      expect(got).toHaveLength(1);
      expect(got[0]!.reason).toMatch(/^time_stop:.*pnl -18\.3%.*age 7\.00d/);
    });

    it("resolution redeems regardless of P&L", async () => {
      const e = env();
      const strategy = new FlipFlatStrategy();
      await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.9 });
      e.positions = [{ ...e.positions[0]!, redeemable: true }];
      setYesMid(e, 0.5);
      const actions = await strategy.tick(ctx(e));
      expect(actions.filter((action) => action.kind === "redeem")).toHaveLength(1);
      expect(actions.filter((action) => action.kind === "exit")).toHaveLength(0);
    });
  });

  describe("8. YES and NO behave symmetrically", () => {
    it("collapses a NO position on its own contract", async () => {
      const e = env();
      const strategy = new FlipFlatStrategy();
      // Entered NO with Q_no 80%. Forecast now YES 80% (Q_no 20%); YES mid 0.75 → NO mid 0.25.
      await enter(strategy, e, { side: "NO", entryQ: 0.8, avgPrice: 0.6 });
      setYesMid(e, 0.75);
      e.forecasts = [forecast("f", HOUR_MS, 0.8)];
      const got = await exits(strategy, e);
      expect(got).toHaveLength(1);
      expect(got[0]!.reason).toMatch(/^q_collapse: entryQ 80\.0% → Q 20\.0%, mid 0\.250, bid 0\.240, edge -5\.0pp, retreat \+60\.0pp/);
    });

    it("flips a NO position after two forecasts below 50% on NO with the NO edge at +2pp", async () => {
      const e = env();
      const strategy = new FlipFlatStrategy();
      await enter(strategy, e, { side: "NO", entryQ: 0.8, avgPrice: 0.6 });
      // YES 55% → Q_no 45%; YES mid 0.57 → NO mid 0.43.
      setYesMid(e, 0.57);
      e.forecasts = [forecast("f", HOUR_MS, 0.55)];
      expect(await exits(strategy, e)).toHaveLength(0);
      e.forecasts = [forecast("f", 2 * HOUR_MS, 0.55)];
      const got = await exits(strategy, e);
      expect(got).toHaveLength(1);
      expect(got[0]!.reason).toMatch(/^q_flip: entryQ 80\.0% → Q 45\.0%, mid 0\.430/);
    });

    it("holds a NO flip while NO remains cheap versus Q", async () => {
      const e = env();
      const strategy = new FlipFlatStrategy();
      await enter(strategy, e, { side: "NO", entryQ: 0.8, avgPrice: 0.6 });
      // YES mid 0.70 → NO mid 0.30 against Q_no 45%: +15pp.
      setYesMid(e, 0.7);
      e.forecasts = [forecast("f", HOUR_MS, 0.55)];
      await exits(strategy, e);
      e.forecasts = [forecast("f", 2 * HOUR_MS, 0.55)];
      expect(await exits(strategy, e)).toHaveLength(0);
    });

    it("takes NO profit on the mirrored executable bid", async () => {
      const e = env();
      const strategy = new FlipFlatStrategy();
      await enter(strategy, e, { side: "NO", entryQ: 0.7, avgPrice: 0.6 });
      // YES mid 0.31 → NO mid 0.69; NO bid mirrors the YES ask 0.32 → 0.68.
      setYesMid(e, 0.31);
      e.forecasts = [forecast("f", HOUR_MS, 0.3)];
      const got = await exits(strategy, e);
      expect(got).toHaveLength(1);
      expect(got[0]!.reason).toMatch(/^positive_convergence: entryQ 70\.0% → Q 70\.0%, mid 0\.690, bid 0\.680/);
    });
  });

  it("9. keeps the immutable entry Q when the linked forecast changes", async () => {
    const e = env();
    const strategy = new FlipFlatStrategy();
    await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.6 });
    setYesMid(e, 0.62);
    e.forecasts = [forecast("f", HOUR_MS, 0.75)];
    await exits(strategy, e);
    e.forecasts = [forecast("f", 2 * HOUR_MS, 0.65)];
    await exits(strategy, e);
    e.signals = [signal("YES", 0.66, { id: "sig-later", ts: new Date(START + 3 * HOUR_MS).toISOString() })];
    e.forecasts = [forecast("f", 3 * HOUR_MS, 0.66)];
    await exits(strategy, e);
    const rec = await record(e);
    expect(rec.entry).toMatchObject({ qHeld: 0.8, signalId: "sig-YES", source: "published-signal" });
    expect(rec.currentQHeld).toBeCloseTo(0.66, 9);
    expect(rec.lastEvaluation?.entryQPct).toBe(80);
    expect(rec.lastEvaluation?.qRetreatPp).toBeCloseTo(14, 6);
  });

  it("9b. a same-side top-up does not rewrite the entry snapshot or the age anchor", async () => {
    const e = env();
    const strategy = new FlipFlatStrategy();
    await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.6 });
    e.clock.now += 2 * DAY_MS;
    await enter(strategy, e, { side: "YES", entryQ: 0.7, avgPrice: 0.62, orderId: "entry-2" });
    const rec = await record(e);
    expect(rec.entry?.qHeld).toBe(0.8);
    expect(rec.entryFilledAt).toBe(START);
  });

  it("10. exits at seven days from the actual entry fill regardless of P&L", async () => {
    const e = env();
    const strategy = new FlipFlatStrategy();
    // Order rested at placement; the venue fill lands two hours later.
    await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.6, ackStatus: "open", orderId: "entry-rested" });
    e.fills = [
      { id: "fill-1", orderId: "entry-rested", marketRef: MARKET, outcome: "YES", side: "BUY", size: 10, price: 0.6, ts: START + 2 * HOUR_MS },
    ];
    setYesMid(e, 0.5);
    e.forecasts = [forecast("f", HOUR_MS, 0.8)];
    e.clock.now = START + 3 * HOUR_MS;
    expect(await exits(strategy, e)).toHaveLength(0);
    expect(await record(e)).toMatchObject({ entryFilledAt: START + 2 * HOUR_MS, entryFillSource: "venue-fill" });
    // Seven days from placement is not yet seven days from the fill.
    e.clock.now = START + 7 * DAY_MS + HOUR_MS;
    expect(await exits(strategy, e)).toHaveLength(0);
    e.clock.now = START + 7 * DAY_MS + 2 * HOUR_MS;
    const got = await exits(strategy, e);
    expect(got).toHaveLength(1);
    expect(got[0]!.reason).toMatch(/^time_stop:.*age 7\.00d/);
  });

  it("10b. can disable the time stop and honors a custom maximum", async () => {
    const e = env({ config: { maxHoldDays: 3 } });
    const strategy = new FlipFlatStrategy();
    await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.6 });
    setYesMid(e, 0.5);
    e.forecasts = [forecast("f", HOUR_MS, 0.8)];
    e.clock.now += 3 * DAY_MS;
    expect((await exits(strategy, e))[0]?.reason).toMatch(/^time_stop/);

    const off = env({ config: { maxHoldDays: null } });
    const offStrategy = new FlipFlatStrategy();
    await enter(offStrategy, off, { side: "YES", entryQ: 0.8, avgPrice: 0.6 });
    setYesMid(off, 0.5);
    off.forecasts = [forecast("f", HOUR_MS, 0.8)];
    off.clock.now += 30 * DAY_MS;
    expect(await exits(offStrategy, off)).toHaveLength(0);
  });

  it("11. emits exactly one exit and one canonical reason when every branch qualifies, and never a duplicate", async () => {
    const e = env();
    const strategy = new FlipFlatStrategy();
    await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.7 });
    // Two flipped, adverse forecasts, a 60pp collapse, a deep loss, and an expired hold.
    setYesMid(e, 0.25);
    e.forecasts = [forecast("f", HOUR_MS, 0.2)];
    e.clock.now += DAY_MS;
    let got = await exits(strategy, e);
    expect(got).toHaveLength(1);
    expect(got[0]!.reason).toMatch(/^q_collapse:/);
    // The engine accepts it; later polls must not submit a second sell.
    await strategy.onActionResult(ctx(e), got[0]!, { placed: true, orderId: "exit-1", status: "open", placedAt: e.clock.now });
    e.forecasts = [forecast("f", 2 * HOUR_MS, 0.2)];
    // Polls inside the retry window: the venue shows neither the order nor the close yet.
    for (let i = 0; i < 3; i++) {
      e.clock.now += 60_000;
      expect(await exits(strategy, e)).toHaveLength(0);
    }
    // The order is visible: still no duplicate even far past the retry window.
    e.openOrders = [{ id: "exit-1", marketRef: MARKET, side: "SELL", size: 10, filledSize: 0, price: 0.24, status: "open" }];
    e.clock.now += 8 * DAY_MS;
    expect(await exits(strategy, e)).toHaveLength(0);
    // Order gone, position still held past the retry window: one fresh submission.
    e.openOrders = [];
    got = await exits(strategy, e);
    expect(got).toHaveLength(1);
    expect(got[0]!.reason).toMatch(/^q_collapse:/);
  });

  it("re-evaluates next tick when the engine could not place the exit", async () => {
    const e = env();
    const strategy = new FlipFlatStrategy();
    await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.6 });
    setYesMid(e, 0.25);
    e.forecasts = [forecast("f", HOUR_MS, 0.2)];
    const first = await exits(strategy, e);
    expect(first).toHaveLength(1);
    await strategy.onActionResult(ctx(e), first[0]!, { placed: false });
    e.clock.now += 60_000;
    expect(await exits(strategy, e)).toHaveLength(1);
  });

  it("seeds a legacy position from the active same-side signal and keeps the other branches when none exists", async () => {
    const e = env();
    const strategy = new FlipFlatStrategy();
    e.positions = [{ marketRef: MARKET, side: "YES", size: 10, avgPrice: 0.6 }];
    e.signals = [signal("YES", 0.75)];
    setYesMid(e, 0.62);
    e.forecasts = [forecast("f", HOUR_MS, 0.75)];
    expect(await exits(strategy, e)).toHaveLength(0);
    expect((await record(e)).entry).toMatchObject({ qHeld: 0.75, source: "seeded-from-active-signal" });

    const bare = env();
    const bareStrategy = new FlipFlatStrategy();
    bare.positions = [{ marketRef: MARKET, side: "YES", size: 10, avgPrice: 0.6 }];
    setYesMid(bare, 0.25);
    bare.forecasts = [forecast("f", HOUR_MS, 0.2)];
    // Entry Q unknown: no collapse. Two flipped forecasts still exit.
    expect(await exits(bareStrategy, bare)).toHaveLength(0);
    expect((await record(bare)).entry).toBeUndefined();
    bare.forecasts = [forecast("f", 2 * HOUR_MS, 0.2)];
    const got = await exits(bareStrategy, bare);
    expect(got).toHaveLength(1);
    expect(got[0]!.reason).toMatch(/^adverse_cross: entryQ n\/a/);
  });

  it("only the time stop can fire without any forecast", async () => {
    const e = env();
    const strategy = new FlipFlatStrategy();
    await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.6 });
    setYesMid(e, 0.25);
    expect(await exits(strategy, e)).toHaveLength(0);
    e.clock.now += 7 * DAY_MS;
    expect((await exits(strategy, e))[0]?.reason).toMatch(/^time_stop/);
  });

  it("logs the full telemetry on every trigger", async () => {
    const e = env();
    const strategy = new FlipFlatStrategy();
    await enter(strategy, e, { side: "YES", entryQ: 0.8, avgPrice: 0.6 });
    setYesMid(e, 0.25);
    e.forecasts = [forecast("f", HOUR_MS, 0.2)];
    await exits(strategy, e);
    const line = e.logs.find((msg) => msg.startsWith("scenario exit triggered"));
    expect(line).toMatch(/entryQ 80\.0% → Q 20\.0%, mid 0\.250, bid 0\.240, edge -5\.0pp, retreat \+60\.0pp, pnl -60\.0%, adverse \d\/2, flip \d\/2, age \d+\.\d\dd, forecasts \[/);
  });
});

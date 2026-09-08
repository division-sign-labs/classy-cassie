// strategies/quotient-swing/test/strategy.test.ts
import { describe, expect, it } from "vitest";
import { QuotientSwingConfigSchema, REMOVED_SWING_CONFIG_KEYS } from "../src/schema.js";
import { fundingReserve, HOUR, liquidationDistance, quotePrice, sigmaStop } from "../src/math.js";
import { buildCandidate, candidateFor, eligibleHorizons, entryProblem, forecastProblem } from "../src/selection.js";
import { allocateSwing } from "../src/risk.js";
import { createSwingState, reduceSwing } from "../src/reducer.js";
import { createPaperSwingState, reducePaperSwing, replaySwing } from "../src/replay.js";
import { QuotientSwingStrategy, SWING_REPORT_KEY, SWING_STATE_KEY, swingDecisionToAction } from "../src/index.js";
import type { PerpCycle, StrategyContext } from "@quotient-forecasting/cassie-core";
import type { SwingCandidate, SwingDecision, SwingState } from "../src/types.js";
import { advance, goldMarket, market, NOW, outlook, snapshot } from "./fixtures.js";

const cfg = QuotientSwingConfigSchema.parse({});
function candidate(): SwingCandidate {
  const s = snapshot(), c = buildCandidate(s.markets[0]!, s, cfg);
  if (typeof c === "string") throw new Error(c);
  return c;
}
function heldState(): SwingState {
  const result = reduceSwing(snapshot(), createSwingState(1000), cfg);
  const e = result.state.entries["xyz:NVDA"]!;
  e.status = "held"; e.filledAt = NOW - HOUR; e.entryPrice = 99.99;
  return result.state;
}
function enterDecision(): Extract<SwingDecision, { kind: "enter" }> {
  const d = reduceSwing(snapshot(), createSwingState(1000), cfg).decisions.find(x => x.kind === "enter");
  if (!d || d.kind !== "enter") throw new Error("no entry");
  return d;
}
function baseContext(values: Map<string, unknown>, s = snapshot(), cycles: PerpCycle[] = []): StrategyContext {
  return { botId: "test", venueId: "fixture", config: { mode: "live" }, equity: s.nav,
    signals: { latest: async () => [] }, positions: [], openOrders: [], now: () => NOW,
    venue: { balances: async () => [], positions: async () => [], book: async () => market().book,
      quote: async () => ({ marketRef: "xyz:NVDA", bid: 99.99, ask: 100.01, mid: 100, spreadBps: 2, volume24h: 1_000_000, ts: NOW }),
      openOrders: async () => [], fills: async () => [] },
    perpExecution: { cycles, halted: false, highWaterEquity: s.nav, drawdownPct: 0, cashFlowsComplete: true },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    memory: { get: async <T>(key: string) => values.get(key) as T | undefined,
      set: async <T>(key: string, value: T) => { values.set(key, value); } } };
}

describe("configuration", () => {
  it("drops keys from earlier strategy revisions so a deployed config still validates", () => {
    const legacy = Object.fromEntries(REMOVED_SWING_CONFIG_KEYS.map(k => [k, 1]));
    const parsed = QuotientSwingConfigSchema.parse({ ...legacy, riskBasePct: 5 });
    for (const key of REMOVED_SWING_CONFIG_KEYS) expect(parsed).not.toHaveProperty(key);
    expect(parsed).not.toHaveProperty("classShare");
    expect(parsed.reservedAssets).toEqual(["commodity:wti"]);
    expect(parsed.freshnessStates).toEqual(["fresh"]);
  });
  it("rejects an inverted gap window and a single margin above the total", () => {
    expect(() => QuotientSwingConfigSchema.parse({ minGapSigma: 1, maxGapSigma: 0.5 })).toThrow();
    expect(() => QuotientSwingConfigSchema.parse({ singleMarginPct: 10, totalMarginPct: 5 })).toThrow();
    expect(QuotientSwingConfigSchema.parse({ reservedAssets: [] }).reservedAssets).toEqual([]);
  });
});

describe("outlook eligibility", () => {
  it("requires a published direction whose gap sits inside the configured sigma window", () => {
    expect(entryProblem(outlook({ directionalSide: "neutral" }), cfg)).toBe("neutral_horizon");
    expect(entryProblem(outlook({ medianPrice: 102 }), cfg)).toBe("gap_below_min");
    expect(entryProblem(outlook({ medianPrice: 112 }), cfg)).toBe("gap_above_max");
    expect(entryProblem(outlook({ medianPrice: 97, spotGapSigma: -0.3 }), cfg)).toBe("gap_side_mismatch");
    expect(entryProblem(outlook(), cfg)).toBeUndefined();
  });
  it("accepts clamped curves, rejects unknown ranges and stale or old publications", () => {
    expect(forecastProblem(outlook({ rangeStatus: "clamped" }), NOW, cfg)).toBeUndefined();
    expect(forecastProblem(outlook({ rangeStatus: "unknown" }), NOW, cfg)).toBe("incomplete_curve");
    expect(forecastProblem(outlook({ freshnessState: "thin" }), NOW, cfg)).toBe("outlook_not_fresh");
    expect(forecastProblem(outlook({ freshnessState: "thin" }), NOW, QuotientSwingConfigSchema.parse({ freshnessStates: ["fresh", "thin"] }))).toBeUndefined();
    expect(forecastProblem(outlook({ publishedAt: NOW - 3 * HOUR }), NOW, cfg)).toBe("outlook_publication_age");
    expect(forecastProblem(outlook({ spotGapSigma: Number.NaN }), NOW, cfg)).toBe("invalid_distribution");
  });
  it("only considers exact Hyperliquid bases inside the entry window", () => {
    for (const o of [outlook({ provider: "kalshi" }), outlook({ marketRef: "xyz:GOLD" }), outlook({ basisVerified: false }),
      outlook({ anchorAt: NOW + 12 * HOUR }), outlook({ anchorAt: NOW + 121 * HOUR })]) {
      expect(eligibleHorizons(market({ outlooks: [o] }), NOW, cfg)).toEqual([]);
    }
    const m = market({ outlooks: [outlook({ id: "far", anchorAt: NOW + 100 * HOUR }), outlook()] });
    expect(eligibleHorizons(m, NOW, cfg).map(o => o.id)).toEqual(["outlook-1", "far"]);
  });
  it("rejects a median the market has already crossed", () => {
    const s = advance(snapshot(), 0, 110);
    expect(buildCandidate(s.markets[0]!, s, cfg)).toBe("median_crossed");
  });
  it("rejects illiquid, future-dated and crossed books", () => {
    const m = market({ volume24hUsd: 99_999 });
    expect(buildCandidate(m, snapshot({ markets: [m] }), cfg)).toBe("volume");
    const future = market(); future.book.ts = NOW + 1;
    expect(buildCandidate(future, snapshot({ markets: [future] }), cfg)).toBe("stale_book");
    const crossed = market(); crossed.book.bids[0]!.price = 101;
    expect(buildCandidate(crossed, snapshot({ markets: [crossed] }), cfg)).toBe("invalid_book");
  });
});

describe("candidate geometry and ranking", () => {
  it("prices a crossing entry, a sigma-scaled stop and the median as the target", () => {
    const c = candidate();
    expect(c.entryPrice).toBeCloseTo(100.22, 10);
    expect(c.targetPrice).toBe(107);
    expect(c.stopPrice).toBeCloseTo(quotePrice(sigmaStop(100.22, "LONG", 0.1, 72, 72.5, cfg.stopSigmaMultiple), 0.01, "LONG", true), 10);
    expect(c.stopFraction).toBeGreaterThan(0.25);
    expect(c.costFraction).toBeCloseTo(0.001 + 0.0002 + 0.004 + 0.000001 * 72 * 1.5, 10);
    expect(c.netEdge).toBeCloseTo(Math.log(107 / 100.22) - c.costFraction, 10);
    expect(c.rank).toBe(c.netEdge);
    expect(c.themes).toEqual(["equity"]);
  });
  it("mirrors the geometry for a bearish outlook", () => {
    const m = market({ outlooks: [outlook({ directionalSide: "bearish", medianPrice: 94, expectedPrice: 93, expectedLogReturn: Math.log(0.93), p10: 80, p25: 88, p75: 99, p90: 104 })] });
    const c = candidateFor(m.outlooks[0]!, m, NOW, cfg);
    expect(typeof c).toBe("object");
    if (typeof c === "string") return;
    expect(c.side).toBe("SHORT");
    expect(c.entryPrice).toBeCloseTo(99.79, 10);
    expect(c.targetPrice).toBe(94);
    expect(c.stopPrice).toBeGreaterThan(c.entryPrice);
    expect(c.netEdge).toBeCloseTo(Math.log(99.79 / 94) - c.costFraction, 10);
  });
  it("rejects an edge inside costs", () => {
    const m = market({ outlooks: [outlook({ medianPrice: 100.5, spotGapSigma: 0.35 })] });
    expect(candidateFor(m.outlooks[0]!, m, NOW, cfg)).toBe("edge_inside_costs");
  });
  it("picks the best-edged horizon for a market and ranks markets by net edge", () => {
    const weak = outlook({ id: "weak", anchorAt: NOW + 48 * HOUR, medianPrice: 103 });
    const m = market({ outlooks: [weak, outlook()] });
    const c = buildCandidate(m, snapshot({ markets: [m] }), cfg);
    expect(typeof c === "object" && c.outlook.id).toBe("outlook-1");
    const gold = goldMarket({}, { medianPrice: 104 });
    const r = reduceSwing(snapshot({ markets: [gold, market()] }), createSwingState(1000), cfg);
    expect(r.candidates.map(x => x.marketRef)).toEqual(["xyz:NVDA", "xyz:GOLD"]);
    expect(r.decisions.flatMap(d => d.kind === "enter" ? [d.candidate.marketRef] : [])).toEqual(["xyz:NVDA", "xyz:GOLD"]);
  });
  it("breaks an edge tie toward the nearer anchor", () => {
    const gold = goldMarket({}, { anchorAt: NOW + 48 * HOUR });
    const r = reduceSwing(snapshot({ markets: [market(), gold] }), createSwingState(1000), cfg);
    expect(r.candidates.map(x => x.marketRef)).toEqual(["xyz:GOLD", "xyz:NVDA"]);
  });
});

describe("risk and execution budgets", () => {
  it("opens from an eligible forecast with nothing beyond the published curve and the book", () => {
    const r = reduceSwing(snapshot(), createSwingState(1000), QuotientSwingConfigSchema.parse({ mode: "live" }));
    expect(r.decisions.find(d => d.kind === "enter")).toMatchObject({ candidate: { marketRef: "xyz:NVDA", side: "LONG" } });
    expect(r.rejected).toEqual([]);
  });
  it("sizes from NAV, rounds down, and respects isolated margin and liquidation buffers", () => {
    const c = candidate(), s = snapshot(), result = allocateSwing(c, s.markets[0]!, s, [], cfg, 0);
    expect(typeof result).toBe("object");
    if (typeof result === "string") return;
    expect(result.marginUsd).toBeLessThanOrEqual(100 + 1e-8);
    expect(result.notional).toBeLessThanOrEqual(2000);
    expect(result.stopRiskUsd).toBeLessThanOrEqual(100 + 1e-8);
    expect(result.leverage).toBeLessThanOrEqual(20);
    expect(result.leverage).toBeGreaterThanOrEqual(2);
    expect(1 - result.liquidationPrice / c.entryPrice).toBeGreaterThanOrEqual(cfg.liquidationStopMultiple * c.stopFraction + cfg.emergencyGapFraction);
    expect(result.size * 1000).toBeCloseTo(Math.round(result.size * 1000), 7);
  });
  it("scales with account size instead of a configured balance", () => {
    const c = candidate(), small = snapshot({ nav: 600, availableMarginUsd: 600 }), large = snapshot({ nav: 6000, availableMarginUsd: 6000 });
    const a = allocateSwing(c, small.markets[0]!, small, [], cfg, 0), b = allocateSwing(c, large.markets[0]!, large, [], cfg, 0);
    if (typeof a === "string" || typeof b === "string") throw new Error("allocation failed");
    expect(b.notional / a.notional).toBeCloseTo(10, 1);
  });
  it("ramps the risk budget with net edge when margin is not the binding cap", () => {
    const c = candidate(), s = snapshot(), roomy = QuotientSwingConfigSchema.parse({ singleMarginPct: 15, totalMarginPct: 50 });
    const low = allocateSwing({ ...c, netEdge: 0.005 }, s.markets[0]!, s, [], roomy, 0), high = allocateSwing(c, s.markets[0]!, s, [], roomy, 0);
    if (typeof low === "string" || typeof high === "string") throw new Error("allocation failed");
    expect(low.stopRiskUsd).toBeLessThan(high.stopRiskUsd);
    expect(low.stopRiskUsd).toBeLessThanOrEqual(50 + 1e-8);
  });
  it("never counts favorable funding as entry alpha", () => {
    expect(fundingReserve(-0.001, "LONG", 72, 1.5)).toBe(0);
    expect(fundingReserve(-0.001, "SHORT", 72, 1.5)).toBeCloseTo(0.108);
    expect(liquidationDistance("LONG", 20, 0.025)).toBeLessThan(0.03);
  });
  it("keeps a slot free for a reserved asset and lets that asset take it", () => {
    const two = QuotientSwingConfigSchema.parse({ maxPositions: 2 });
    const held = heldState();
    const gold = goldMarket();
    const blocked = reduceSwing(snapshot({ markets: [market(), gold], positions: [{ marketRef: "xyz:NVDA", side: "LONG", size: 5, avgPrice: 99.99 }] }), held, two);
    expect(blocked.decisions.some(d => d.kind === "enter")).toBe(false);
    expect(blocked.rejected).toContainEqual({ marketRef: "xyz:GOLD", reason: "position_count" });
    const oil = goldMarket({ assetKey: "commodity:wti", marketRef: "xyz:CL", book: { marketRef: "xyz:CL", ts: NOW, bids: [{ price: 99.99, size: 1000 }], asks: [{ price: 100.01, size: 1000 }] } },
      { assetKey: "commodity:wti", marketRef: "xyz:CL", basisId: "hl-cl" });
    const s = snapshot({ markets: [market(), oil], coveredAssetKeys: ["company:nvda", "commodity:wti"], positions: [{ marketRef: "xyz:NVDA", side: "LONG", size: 5, avgPrice: 99.99 }] });
    const allowed = reduceSwing(s, heldState(), two);
    expect(allowed.decisions.flatMap(d => d.kind === "enter" ? [d.candidate.marketRef] : [])).toEqual(["xyz:CL"]);
    const open = QuotientSwingConfigSchema.parse({ maxPositions: 2, reservedAssets: [] });
    expect(reduceSwing(snapshot({ markets: [market(), gold], positions: [{ marketRef: "xyz:NVDA", side: "LONG", size: 5, avgPrice: 99.99 }] }), heldState(), open)
      .decisions.flatMap(d => d.kind === "enter" ? [d.candidate.marketRef] : [])).toEqual(["xyz:GOLD"]);
  });
  it("retains reservations and prevents another position on the same underlying", () => {
    const s = snapshot(), first = reduceSwing(s, createSwingState(1000), cfg);
    expect(first.decisions.filter(d => d.kind === "enter")).toHaveLength(1);
    const second = reduceSwing(advance(s, 1), first.state, cfg);
    expect(second.decisions.filter(d => d.kind === "enter")).toHaveLength(0);
    expect(first.state.entries["xyz:NVDA"]?.originalAnchorAt).toBe(outlook().anchorAt);
  });
  it("still blocks opening risk with unknown account exposure", () => {
    const r = reduceSwing(snapshot({ positions: [{ marketRef: "xyz:GOLD", side: "LONG", size: 1, avgPrice: 100 }] }), createSwingState(1000), cfg);
    expect(r.decisions).toHaveLength(0);
    expect(r.rejected.at(-1)?.reason).toBe("untracked_exposure");
  });
  it("does not let a deposit erase drawdown", () => {
    const state = createSwingState(1000); state.lastNav = 800;
    const r = reduceSwing(snapshot({ nav: 1800, netCashFlow: 1000 }), state, cfg);
    expect(r.drawdown).toBeCloseTo(0.2);
    expect(r.state.highWaterNav).toBe(2250);
  });
});

describe("position exits", () => {
  const position = { marketRef: "xyz:NVDA", side: "LONG" as const, size: 5, avgPrice: 99.99 };
  it("keeps a supported position and leaves the resting target alone", () => {
    const r = reduceSwing(snapshot({ positions: [position] }), heldState(), cfg);
    expect(r.decisions).toEqual([]);
    expect(r.state.entries["xyz:NVDA"]).toMatchObject({ status: "held", size: position.size, targetPrice: 107 });
  });
  it("moves the target with the latest median in either direction", () => {
    const lower = market({ outlooks: [outlook({ medianPrice: 106 })] });
    const r = reduceSwing(snapshot({ markets: [lower], positions: [position] }), heldState(), cfg);
    expect(r.decisions).toEqual([{ kind: "target", marketRef: "xyz:NVDA", targetPrice: 106, reason: "forecast_revision" }]);
    expect(r.state.entries["xyz:NVDA"]?.targetPrice).toBe(106);
    const higher = market({ outlooks: [outlook({ medianPrice: 109 })] });
    const next = reduceSwing(advance(snapshot({ markets: [higher], positions: [position] }), 1), r.state, cfg);
    expect(next.decisions).toEqual([{ kind: "target", marketRef: "xyz:NVDA", targetPrice: 109, reason: "forecast_revision" }]);
  });
  it("exits passively when the latest revision flips against the position", () => {
    const flipped = market({ outlooks: [outlook({ directionalSide: "bearish", medianPrice: 97, p25: 95, spotGapSigma: -0.3 })] });
    const r = reduceSwing(snapshot({ markets: [flipped], positions: [position] }), heldState(), cfg);
    expect(r.decisions.find(d => d.kind === "exit")).toMatchObject({ reason: "forecast_reversal", urgent: false, postOnly: true, limitPrice: 100.01 });
    const faint = market({ outlooks: [outlook({ directionalSide: "bearish", medianPrice: 101, spotGapSigma: -0.05 })] });
    expect(reduceSwing(snapshot({ markets: [faint], positions: [position] }), heldState(), cfg).decisions.some(d => d.kind === "exit")).toBe(false);
  });
  it("exits when the latest median crosses the entry price", () => {
    const crossed = market({ outlooks: [outlook({ medianPrice: 99, spotGapSigma: 0.2 })] });
    const r = reduceSwing(snapshot({ markets: [crossed], positions: [position] }), heldState(), cfg);
    expect(r.decisions.find(d => d.kind === "exit")).toMatchObject({ reason: "median_crossed_entry" });
  });
  it("falls back to a passive exit when price is through the target with nothing resting", () => {
    const s = advance(snapshot({ positions: [position] }), 1, 108);
    expect(reduceSwing(s, heldState(), cfg).decisions.find(d => d.kind === "exit")).toMatchObject({ reason: "target_convergence", urgent: false });
    const resting = { ...s, openOrders: [{ id: "tp", marketRef: "xyz:NVDA", purpose: "target" as const, size: 5, filledSize: 0, price: 107, createdAt: NOW }] };
    expect(reduceSwing(resting, heldState(), cfg).decisions.some(d => d.kind === "exit")).toBe(false);
  });
  it("halts additions at 25% drawdown while retaining ordinary position exit rules", () => {
    const r = reduceSwing(snapshot({ nav: 750, positions: [position] }), heldState(), cfg);
    expect(r.state.halted).toBe(true);
    expect(r.decisions.some(d => d.kind === "enter")).toBe(false);
    expect(r.decisions.some(d => d.kind === "exit")).toBe(false);
    const stopped = advance(snapshot({ nav: 750, positions: [position] }), 1, 70);
    expect(reduceSwing(stopped, r.state, cfg).decisions.find(d => d.kind === "exit")).toMatchObject({ reason: "protective_stop" });
  });
  it("exits at its original anchor without adopting a farther revision", () => {
    const state = heldState(); state.entries["xyz:NVDA"]!.originalAnchorAt = NOW;
    const r = reduceSwing(snapshot({ positions: [position] }), state, cfg);
    expect(r.decisions.find(d => d.kind === "exit")).toMatchObject({ reason: "time_exit" });
  });
  it("exits after the maximum hold even when the anchor is farther away", () => {
    const state = heldState(); state.entries["xyz:NVDA"]!.filledAt = NOW - 49 * HOUR;
    const r = reduceSwing(snapshot({ positions: [position] }), state, cfg);
    expect(r.decisions.find(d => d.kind === "exit")).toMatchObject({ reason: "time_exit", urgent: true });
    const younger = heldState(); younger.entries["xyz:NVDA"]!.filledAt = NOW - 47 * HOUR;
    expect(reduceSwing(snapshot({ positions: [position] }), younger, cfg).decisions.some(d => d.kind === "exit")).toBe(false);
  });
  it("does not treat a missing forecast as a neutral position instruction", () => {
    const m = market({ outlooks: [] });
    const r = reduceSwing(snapshot({ markets: [m], positions: [position] }), heldState(), cfg);
    expect(r.decisions.some(d => d.kind === "exit")).toBe(false);
    expect(r.state.entries["xyz:NVDA"]?.staleSince).toBe(NOW);
    const later = advance(snapshot({ markets: [m], positions: [position] }), 25 * 60);
    expect(reduceSwing(later, r.state, cfg).decisions.find(d => d.kind === "exit")).toMatchObject({ reason: "forecast_unavailable" });
  });
});

describe("engine actions", () => {
  it("emits a crossing IOC entry with stop and target, and target moves as their own action", () => {
    const action = swingDecisionToAction(enterDecision());
    expect(action).toMatchObject({ kind: "enter", tif: "IOC", postOnly: false, targetPx: 107, themes: ["equity"], reason: "quotient_edge" });
    expect(action).not.toHaveProperty("limitPrice");
    if (action.kind === "enter") {
      expect(action.stopPx).toBeLessThan(90);
      expect(action.clientId).toMatch(/^0x[0-9a-f]{32}$/);
      expect(action.provenance).toMatchObject({ strategy: "quotient-swing", outlookId: "outlook-1", gapSigma: outlook().spotGapSigma });
    }
    expect(swingDecisionToAction({ kind: "target", marketRef: "xyz:NVDA", targetPrice: 106, reason: "forecast_revision" }))
      .toEqual({ kind: "target", marketRef: "xyz:NVDA", targetPx: 106, reason: "forecast_revision" });
    expect(swingDecisionToAction({ kind: "exit", marketRef: "xyz:NVDA", reason: "forecast_reversal", urgent: false, limitPrice: 100.01, postOnly: true }))
      .toMatchObject({ kind: "exit", fraction: 1, tif: "GTC", postOnly: true, limitPrice: 100.01 });
  });
  it("restores the target from the engine cycle after a restart", async () => {
    const values = new Map<string, unknown>();
    const state = heldState(); values.set(SWING_STATE_KEY, state);
    const cycle = { id: "c1", marketRef: "xyz:NVDA", side: "LONG", status: "open", anchorAt: outlook().anchorAt, createdAt: NOW - HOUR,
      openedAt: NOW - HOUR, initialStopPx: 86.3, stopPx: 86.3, entryPrice: 99.99, initialRiskUsd: 50, desiredNotional: 500, filledSize: 5,
      leverage: 4, themes: ["equity"], entryOrderIds: [], entryClientIds: [], targetPx: 105 } as PerpCycle;
    const s = snapshot({ positions: [{ marketRef: "xyz:NVDA", side: "LONG", size: 5, avgPrice: 99.99 }] });
    await new QuotientSwingStrategy({ snapshot: async () => s }).tick(baseContext(values, s, [cycle]));
    expect((values.get(SWING_STATE_KEY) as SwingState).entries["xyz:NVDA"]).toMatchObject({ status: "held", size: 5, leverage: 4 });
    const report = values.get(SWING_REPORT_KEY) as { decisions: SwingDecision[] };
    expect(report.decisions).toEqual([{ kind: "target", marketRef: "xyz:NVDA", targetPrice: 107, reason: "forecast_revision" }]);
  });
  it("releases a planned entry the engine no longer tracks and keeps one with a live cycle", async () => {
    const planned = reduceSwing(snapshot(), createSwingState(1000), cfg).state;
    expect(planned.entries["xyz:NVDA"]?.status).toBe("planned");
    const orphan = new Map<string, unknown>([[SWING_STATE_KEY, structuredClone(planned)]]);
    const retried = await new QuotientSwingStrategy({ snapshot: async () => snapshot() }).tick(baseContext(orphan, snapshot(), []));
    expect(retried.filter(a => a.kind === "enter")).toHaveLength(1);
    const cycle = { id: planned.entries["xyz:NVDA"]!.clientId, marketRef: "xyz:NVDA", side: "LONG", status: "pending", anchorAt: outlook().anchorAt,
      createdAt: NOW, initialStopPx: 74, stopPx: 74, entryPrice: 100.22, initialRiskUsd: 50, desiredNotional: 480, filledSize: 0, leverage: 8,
      themes: ["equity"], entryOrderIds: [], entryClientIds: [], targetPx: 107 } as PerpCycle;
    const tracked = new Map<string, unknown>([[SWING_STATE_KEY, structuredClone(planned)]]);
    const kept = await new QuotientSwingStrategy({ snapshot: async () => snapshot() }).tick(baseContext(tracked, snapshot(), [cycle]));
    expect(kept.some(a => a.kind === "enter")).toBe(false);
    expect((tracked.get(SWING_STATE_KEY) as SwingState).entries["xyz:NVDA"]?.status).toBe("accepted");
  });
  it("uses the engine cash-flow-adjusted high water and explicit resume state", async () => {
    const values = new Map<string, unknown>();
    values.set(SWING_STATE_KEY, { ...createSwingState(1000), halted: true, lastNav: 800 });
    const s = snapshot({ nav: 1800 });
    const ctx = baseContext(values, s);
    ctx.perpExecution = { cycles: [], halted: false, highWaterEquity: 2250, drawdownPct: 20, cashFlowsComplete: true };
    await new QuotientSwingStrategy({ snapshot: async () => s }).tick(ctx);
    expect((values.get(SWING_REPORT_KEY) as { drawdown: number }).drawdown).toBeCloseTo(0.2);
    expect((values.get(SWING_STATE_KEY) as SwingState).halted).toBe(false);
    expect((values.get(SWING_STATE_KEY) as SwingState).highWaterNav).toBe(2250);
  });
});

describe("paper accounting", () => {
  it("fills the crossing entry on the placing observation and pays taker fees", () => {
    const r = reducePaperSwing(snapshot(), createPaperSwingState(1000), cfg);
    expect(r.state.positions).toHaveLength(1);
    expect(r.state.orders).toHaveLength(0);
    expect(r.state.fills[0]).toMatchObject({ reason: "taker_entry", side: "BUY" });
    expect(r.state.feesUsd).toBeGreaterThan(0);
  });
  it("closes at the resting target with a maker fee once price trades through it", () => {
    const first = reducePaperSwing(snapshot(), createPaperSwingState(1000), cfg);
    const touched = reducePaperSwing(advance(snapshot(), 60, 107), first.state, cfg, { fillModel: "cross", costMultiplier: 1 });
    expect(touched.state.positions).toHaveLength(1);
    const through = reducePaperSwing(advance(snapshot(), 120, 107.5), first.state, cfg);
    expect(through.state.positions).toHaveLength(0);
    expect(through.state.fills.at(-1)).toMatchObject({ reason: "target", price: 107 });
    expect(through.state.fundingUsd).toBeGreaterThan(0);
    expect(through.state.cash).toBeGreaterThan(1000);
  });
  it("exits on the native stop with slippage and signed funding", () => {
    const first = reducePaperSwing(snapshot(), createPaperSwingState(1000), cfg);
    const stopped = reducePaperSwing(advance(snapshot(), 2, 70), first.state, cfg);
    expect(stopped.state.positions).toHaveLength(0);
    expect(stopped.state.fills.at(-1)?.reason).toBe("native_stop");
    expect(stopped.state.fills.at(-1)?.price).toBeLessThan(70);
    expect(stopped.state.cash).toBeLessThan(1000);
  });
  it("keeps forecast exits passive and does not fill them on their creation observation", () => {
    const first = reducePaperSwing(snapshot(), createPaperSwingState(1000), cfg);
    const reversed = market({ outlooks: [outlook({ directionalSide: "bearish", medianPrice: 97, p25: 95, spotGapSigma: -0.3 })] });
    const flipped = advance(snapshot({ markets: [reversed] }), 2, 100);
    const exit = reducePaperSwing(flipped, first.state, cfg);
    expect(exit.state.positions).toHaveLength(1);
    expect(exit.state.orders.some(o => o.purpose === "exit")).toBe(true);
    const filled = reducePaperSwing(advance(flipped, 1, 100.04), exit.state, cfg);
    expect(filled.state.positions).toHaveLength(0);
    expect(filled.state.fills.at(-1)?.reason).toBe("forecast_reversal");
  });
  it("rejects time travel and does not publish a Sharpe from a few ticks", () => {
    expect(() => replaySwing([snapshot(), { ...snapshot(), now: NOW - 1 }])).toThrow("time");
    const r = replaySwing([snapshot(), advance(snapshot(), 1, 100)]);
    expect(r.dailySharpe).toBeNull();
    expect(r.provisional).toBe(true);
  });
  it("excludes funding transfers from replay performance", () => {
    const a = snapshot({ markets: [] }), b = { ...advance(a, 1), netCashFlow: 1000 };
    const report = replaySwing([a, b]);
    expect(report.finalNav).toBe(2000);
    expect(report.equityCurve.at(-1)?.performanceIndex).toBe(1);
    expect(report.maxDrawdown).toBe(0);
  });
});

// strategies/quotient-swing/src/replay.ts
// Chronological paper accounting over recorded snapshots; limits need a later observable price crossing.
import { QuotientSwingConfigSchema, type QuotientSwingConfig } from "./schema.js";
import { createSwingState, reduceSwing } from "./reducer.js";
import { HOUR, signOf } from "./math.js";
import type { SwingDecision, SwingHeldPosition, SwingMarketSnapshot, SwingOpenOrder, SwingReduction, SwingSnapshot, SwingState } from "./types.js";

export interface SwingPaperFill {
  at: number;
  marketRef: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  feeUsd: number;
  reason: string;
}

export interface SwingPaperOrder extends SwingOpenOrder {
  decision: Extract<SwingDecision, { kind: "exit" }>;
  expiresAt: number;
}

export interface SwingPaperState {
  strategy: SwingState;
  initialNav: number;
  cash: number;
  positions: SwingHeldPosition[];
  orders: SwingPaperOrder[];
  fills: SwingPaperFill[];
  feesUsd: number;
  fundingUsd: number;
  lastAt: number;
  priorFunding: Record<string, { rate: number; mark: number }>;
  equityCurve: Array<{ at: number; nav: number; performanceIndex?: number }>;
}

export interface SwingPaperOptions {
  fillModel: "cross" | "touch";
  /** Stress multiplier applied to both fees and execution slippage. */
  costMultiplier: number;
}

export function createPaperSwingState(nav: number, now = 0): SwingPaperState {
  return { strategy: createSwingState(nav, now), initialNav: nav, cash: nav, positions: [], orders: [], fills: [],
    feesUsd: 0, fundingUsd: 0, lastAt: now, priorFunding: {}, equityCurve: [] };
}

function paperNav(state: SwingPaperState, markets: SwingMarketSnapshot[]): number {
  return state.cash + state.positions.reduce((sum, p) => {
    const mark = markets.find(m => m.marketRef === p.marketRef)?.markPrice ?? p.currentPrice ?? p.avgPrice;
    return sum + signOf(p.side) * (mark - p.avgPrice) * p.size;
  }, 0);
}

export function reducePaperSwing(input: SwingSnapshot, previous: SwingPaperState, config: QuotientSwingConfig,
  options: SwingPaperOptions = { fillModel: "cross", costMultiplier: 1 }): { state: SwingPaperState; report: SwingReduction } {
  if (input.now < previous.lastAt || options.costMultiplier < 1 || !Number.isFinite(options.costMultiplier)) throw new Error("invalid replay time or cost multiplier");
  const state: SwingPaperState = { ...previous, strategy: structuredClone(previous.strategy), positions: previous.positions.map(p => ({ ...p })),
    orders: previous.orders.map(o => ({ ...o })), fills: [...previous.fills], priorFunding: { ...previous.priorFunding }, equityCurve: [...previous.equityCurve] };
  state.cash += input.netCashFlow;
  const closedMarkets = new Set<string>();
  const close = (p: SwingHeldPosition, market: SwingMarketSnapshot, fraction: number, price: number, feeRate: number, reason: string) => {
    const size = p.size * fraction, fee = size * price * feeRate * options.costMultiplier;
    state.cash += signOf(p.side) * (price - p.avgPrice) * size - fee;
    state.feesUsd += fee;
    state.fills.push({ at: input.now, marketRef: p.marketRef, side: p.side === "LONG" ? "SELL" : "BUY", size, price, feeUsd: fee, reason });
    p.size -= size;
    if (p.isolatedMarginUsd !== undefined) p.isolatedMarginUsd *= 1 - fraction;
  };
  const crossed = (signedGap: number) => options.fillModel === "cross" ? signedGap > 0 : signedGap >= 0;
  // The previous observation's known rate prices the elapsed interval, not a future rate.
  for (const p of state.positions) {
    const prior = state.priorFunding[p.marketRef];
    if (prior && previous.lastAt > 0) {
      const payment = signOf(p.side) * prior.rate * (input.now - previous.lastAt) / HOUR * prior.mark * p.size;
      state.cash -= payment; state.fundingUsd += payment;
    }
    const market = input.markets.find(m => m.marketRef === p.marketRef), entry = state.strategy.entries[p.marketRef];
    if (!market || !entry || market.book.ts > input.now || input.now - market.book.ts > config.maxBookAgeSec * 1000) continue;
    const executable = p.side === "LONG" ? market.book.bids[0]?.price : market.book.asks[0]?.price;
    if (executable === undefined) continue;
    const d = signOf(p.side);
    if (d * (executable - entry.stopPrice) <= 0) {
      // The native stop is a market order; assume the stop level or the executable quote, whichever is worse.
      const raw = p.side === "LONG" ? Math.min(executable, entry.stopPrice) : Math.max(executable, entry.stopPrice);
      close(p, market, 1, raw * (1 - d * config.maxSlippageBps / 10_000 * options.costMultiplier), market.takerFeeRate, "native_stop");
      closedMarkets.add(p.marketRef);
    } else if (crossed(d * (executable - entry.targetPrice))) {
      // The resting target fills as a maker order at its own price.
      close(p, market, 1, entry.targetPrice, market.makerFeeRate, "target");
      closedMarkets.add(p.marketRef);
    }
  }
  state.positions = state.positions.filter(p => p.size > 1e-10);
  state.orders = state.orders.filter(o => !closedMarkets.has(o.marketRef));
  // Evaluate old resting exits before this observation produces new decisions.
  for (const order of state.orders) {
    if (order.createdAt >= input.now || order.expiresAt <= input.now) continue;
    const market = input.markets.find(m => m.marketRef === order.marketRef);
    if (!market || market.book.ts > input.now || input.now - market.book.ts > config.maxBookAgeSec * 1000) continue;
    const heldPosition = state.positions.find(p => p.marketRef === order.marketRef);
    if (!heldPosition) { order.filledSize = order.size; continue; }
    const exitQuote = heldPosition.side === "LONG" ? market.book.bids[0] : market.book.asks[0];
    if (!exitQuote || !crossed(signOf(heldPosition.side) * (exitQuote.price - order.price))) continue;
    const size = Math.min(order.size - order.filledSize, heldPosition.size, exitQuote.size);
    if (size <= 0) continue;
    close(heldPosition, market, size / heldPosition.size, order.price, market.makerFeeRate, order.decision.reason);
    order.filledSize += size;
    if (order.filledSize >= order.size - 1e-10) {
      const record = state.strategy.entries[order.marketRef];
      if (record) { record.status = "held"; delete record.exitSubmittedAt; }
    }
  }
  const expired = state.orders.filter(o => o.expiresAt <= input.now);
  for (const o of expired) {
    if (!state.positions.some(p => p.marketRef === o.marketRef && p.size > 0)) delete state.strategy.entries[o.marketRef];
    else if (state.strategy.entries[o.marketRef]) {
      state.strategy.entries[o.marketRef]!.status = "held";
      delete state.strategy.entries[o.marketRef]!.exitSubmittedAt;
    }
  }
  state.positions = state.positions.filter(p => p.size > 1e-10);
  state.orders = state.orders.filter(o => o.expiresAt > input.now && o.filledSize < o.size - 1e-10);
  const nav = paperNav(state, input.markets);
  if (nav <= 0) {
    state.strategy.halted = true;
    throw new Error("paper account exhausted; inspect gap and liquidation losses");
  }
  const margins = state.positions.reduce((sum, p) => sum + (p.isolatedMarginUsd ?? 0), 0);
  const snapshot: SwingSnapshot = { ...input, nav, positions: state.positions, openOrders: state.orders,
    availableMarginUsd: Math.max(0, nav - margins), accountReconciled: true, accountObservedAt: input.now };
  const report = reduceSwing(snapshot, state.strategy, config);
  state.strategy = report.state;
  for (const decision of report.decisions) {
    if (decision.kind === "cancel") {
      state.orders = state.orders.filter(o => o.id !== decision.orderId);
      if (!state.positions.some(p => p.marketRef === decision.marketRef)) delete state.strategy.entries[decision.marketRef];
    } else if (decision.kind === "target") {
      // The reducer already moved the record's target; the paper venue has no separate resting order to replace.
      continue;
    } else if (decision.kind === "exit") {
      const held = state.positions.find(p => p.marketRef === decision.marketRef), market = input.markets.find(m => m.marketRef === decision.marketRef);
      if (!held || !market) continue;
      if (decision.postOnly && decision.limitPrice !== undefined) {
        const id = `paper-exit:${decision.marketRef}:${input.now}`;
        state.orders.push({ id, clientId: id, marketRef: decision.marketRef, purpose: "exit", size: held.size,
          filledSize: 0, price: decision.limitPrice, createdAt: input.now, expiresAt: input.now + config.exitRetryMin * 60_000, decision });
        continue;
      }
      const quote = held.side === "LONG" ? market.book.bids[0] : market.book.asks[0];
      if (!quote) continue;
      // The paper fill is bounded by visible depth, and remaining risk is evaluated again next tick.
      const fraction = Math.min(1, quote.size / held.size);
      if (fraction <= 0) continue;
      close(held, market, fraction, quote.price * (1 - signOf(held.side) * config.maxSlippageBps / 10_000 * options.costMultiplier), market.takerFeeRate, decision.reason);
      const entry = state.strategy.entries[decision.marketRef];
      if (entry && fraction < 1) { entry.status = "held"; delete entry.exitSubmittedAt; }
    } else {
      const c = decision.candidate, market = input.markets.find(m => m.marketRef === c.marketRef)!;
      const entry = state.strategy.entries[c.marketRef]!;
      const quote = c.side === "LONG" ? market.book.asks[0]! : market.book.bids[0]!;
      const price = quote.price * (1 + signOf(c.side) * config.maxSlippageBps / 10_000 * options.costMultiplier);
      if (signOf(c.side) * (price - c.entryPrice) > 1e-10) { delete state.strategy.entries[c.marketRef]; continue; }
      const size = Math.min(decision.size, quote.size), fee = size * price * market.takerFeeRate * options.costMultiplier;
      if (size <= 0) { delete state.strategy.entries[c.marketRef]; continue; }
      state.cash -= fee; state.feesUsd += fee;
      state.positions.push({ marketRef: c.marketRef, side: c.side, size, avgPrice: price, leverage: decision.leverage,
        isolatedMarginUsd: size * price / decision.leverage, liquidationPrice: decision.liquidationPrice });
      state.fills.push({ at: input.now, marketRef: c.marketRef, side: c.side === "LONG" ? "BUY" : "SELL", size, price, feeUsd: fee, reason: "taker_entry" });
      entry.status = "held"; entry.filledAt = input.now; entry.entryPrice = price;
    }
  }
  state.positions = state.positions.filter(p => p.size > 1e-10);
  state.lastAt = input.now;
  for (const m of input.markets) state.priorFunding[m.marketRef] = { rate: m.fundingHourly, mark: m.markPrice };
  const finalNav = paperNav(state, input.markets);
  state.strategy.lastNav = finalNav;
  const previousPoint = previous.equityCurve.at(-1), previousNav = previousPoint?.nav ?? previous.initialNav;
  const previousIndex = previousPoint?.performanceIndex ?? previousNav / previous.initialNav;
  const capitalAfterTransfer = previousNav + input.netCashFlow;
  const performanceIndex = capitalAfterTransfer > 0 ? previousIndex * finalNav / capitalAfterTransfer : previousIndex;
  state.equityCurve.push({ at: input.now, nav: finalNav, performanceIndex });
  return { state, report };
}

export interface SwingReplayReport {
  observations: number;
  finalNav: number;
  feesUsd: number;
  fundingUsd: number;
  maxDrawdown: number;
  dailySharpe: number | null;
  observedDays: number;
  fills: SwingPaperFill[];
  equityCurve: SwingPaperState["equityCurve"];
  fillModel: SwingPaperOptions["fillModel"];
  provisional: true;
}

export function replaySwing(snapshots: SwingSnapshot[], config: unknown = {}, options: SwingPaperOptions = { fillModel: "cross", costMultiplier: 1 }): SwingReplayReport {
  if (!snapshots.length) throw new Error("replay needs at least one observation");
  const cfg = QuotientSwingConfigSchema.parse(config);
  let state = createPaperSwingState(snapshots[0]!.nav);
  for (const s of snapshots) state = reducePaperSwing(s, state, cfg, options).state;
  let peak = 1, drawdown = 0;
  const days = new Map<number, number>();
  for (const point of state.equityCurve) {
    const index = point.performanceIndex ?? point.nav / state.initialNav;
    peak = Math.max(peak, index); drawdown = Math.max(drawdown, 1 - index / peak);
    days.set(Math.floor(point.at / (24 * HOUR)), index);
  }
  const values = [...days.values()], returns = values.slice(1).map((v, i) => v / values[i]! - 1);
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const sd = returns.length > 1 ? Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1)) : 0;
  return { observations: snapshots.length, finalNav: state.equityCurve.at(-1)!.nav, feesUsd: state.feesUsd,
    fundingUsd: state.fundingUsd, maxDrawdown: drawdown, dailySharpe: returns.length >= 30 && sd > 0 ? mean / sd * Math.sqrt(365) : null,
    observedDays: days.size, fills: state.fills, equityCurve: state.equityCurve, fillModel: options.fillModel, provisional: true };
}

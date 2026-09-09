// strategies/quotient-swing/src/reducer.ts
// The same deterministic reducer drives the strategy, paper trading, and replay.
import type { QuotientSwingConfig } from "./schema.js";
import type { SwingDecision, SwingEntryRecord, SwingReduction, SwingSnapshot, SwingState } from "./types.js";
import { HOUR, finitePositive, quotePrice, signOf } from "./math.js";
import { allocateSwing } from "./risk.js";
import { buildCandidate, exactHyperliquidBasis, forecastProblem, outlookSide } from "./selection.js";

export function createSwingState(nav: number, now = 0): SwingState {
  if (!finitePositive(nav)) throw new Error("initial NAV must be positive");
  return { version: 1, highWaterNav: nav, lastNav: nav, lastAt: now, halted: false, entries: {}, cooldowns: {} };
}

function cloneState(state: SwingState): SwingState {
  return { ...state, entries: Object.fromEntries(Object.entries(state.entries).map(([key, value]) => [key,
    { ...value, themes: [...value.themes] }])), cooldowns: { ...state.cooldowns } };
}

export function reduceSwing(snapshot: SwingSnapshot, previous: SwingState, cfg: QuotientSwingConfig): SwingReduction {
  if (!finitePositive(snapshot.nav) || !Number.isFinite(snapshot.now) || !Number.isFinite(snapshot.netCashFlow)
    || snapshot.now < previous.lastAt) throw new Error("invalid or out-of-order account snapshot");
  const state = cloneState(previous), decisions: SwingDecision[] = [], rejected: SwingReduction["rejected"] = [];
  // Unitize the high-water mark through external cash flows, so deposits cannot repair a drawdown.
  if (snapshot.netCashFlow !== 0 && previous.lastNav > 0) {
    const flowFactor = 1 + snapshot.netCashFlow / previous.lastNav;
    if (flowFactor <= 0) { state.halted = true; state.haltReason = "invalid_cash_flow"; }
    else state.highWaterNav *= flowFactor;
  }
  state.highWaterNav = Math.max(state.highWaterNav, snapshot.nav);
  const drawdown = Math.max(0, 1 - snapshot.nav / state.highWaterNav);
  if (drawdown >= cfg.drawdownHaltFraction) { state.halted = true; state.haltReason = "drawdown_halt"; }
  const haltReason = state.haltReason ?? "execution_halted";
  state.lastNav = snapshot.nav;
  state.lastAt = snapshot.now;
  const accountFresh = snapshot.accountReconciled && snapshot.accountObservedAt <= snapshot.now
    && snapshot.now - snapshot.accountObservedAt <= cfg.maxAccountAgeSec * 1000;
  const held = new Map(snapshot.positions.filter(p => p.size > 0).map(p => [p.marketRef, p]));
  const occupied = new Set([...held.keys(), ...snapshot.openOrders.filter(o => o.purpose === "entry").map(o => o.marketRef)]);
  let untrackedExposure = snapshot.positions.some(p => p.size > 0 && !state.entries[p.marketRef]);

  for (const [marketRef, entry] of Object.entries(state.entries)) {
    const position = held.get(marketRef);
    const orders = snapshot.openOrders.filter(o => o.marketRef === marketRef && o.purpose === "entry");
    const pendingMarket = snapshot.markets.find(m => m.marketRef === marketRef);
    const pendingCandidate = orders.length > 0 && pendingMarket ? buildCandidate(pendingMarket, snapshot, cfg) : undefined;
    const entryInvalidated = orders.length > 0 && (!pendingCandidate || typeof pendingCandidate === "string"
      || pendingCandidate.side !== entry.side || pendingCandidate.outlook.anchorAt !== entry.originalAnchorAt);
    for (const order of snapshot.openOrders.filter(o => o.marketRef === marketRef && o.purpose === "exit")) {
      if (snapshot.now - order.createdAt >= cfg.exitRetryMin * 60_000) {
        decisions.push({ kind: "cancel", marketRef, orderId: order.id, reason: "exit_ttl" });
      }
    }
    for (const order of orders) {
      if (snapshot.now - order.createdAt >= cfg.entryTtlMin * 60_000 || state.halted || entryInvalidated) {
        decisions.push({ kind: "cancel", marketRef, orderId: order.id,
          reason: state.halted ? haltReason : entryInvalidated ? "entry_invalidated" : "entry_ttl" });
      }
    }
    if (!position) {
      if (accountFresh && orders.length === 0 && (entry.status === "held" || entry.status === "exiting")) {
        delete state.entries[marketRef];
        state.cooldowns[marketRef] = snapshot.now + cfg.postExitCooldownHours * HOUR;
      } else if (accountFresh && orders.length === 0 && snapshot.now - entry.submittedAt >= cfg.unresolvedEntryTimeoutMin * 60_000) {
        // The provider certifies authoritative reconciliation; unresolved exchange submissions must set accountReconciled=false.
        delete state.entries[marketRef];
        state.cooldowns[marketRef] = snapshot.now + cfg.postExitCooldownHours * HOUR;
      }
      continue;
    }
    if (position.side !== entry.side) { untrackedExposure = true; rejected.push({ marketRef, reason: "position_side_changed" }); continue; }
    entry.filledAt ??= snapshot.now;
    entry.entryPrice = position.avgPrice;
    if (entry.status !== "exiting") entry.status = "held";
    const m = snapshot.markets.find(x => x.marketRef === marketRef);
    if (!m) { rejected.push({ marketRef, reason: "held_market_snapshot_missing" }); continue; }
    const latest = m.outlooks.filter(o => exactHyperliquidBasis(o, m) && o.basisId === entry.basisId
      && o.targetFamilyKey === entry.targetFamilyKey && o.anchorAt === entry.originalAnchorAt)
      .sort((a, b) => b.publishedAt - a.publishedAt || a.id.localeCompare(b.id))[0];
    const exitPrice = entry.side === "LONG" ? m.book.bids[0]?.price : m.book.asks[0]?.price;
    if (!exitPrice || !finitePositive(exitPrice) || m.book.ts > snapshot.now || snapshot.now - m.book.ts > cfg.maxBookAgeSec * 1000) {
      rejected.push({ marketRef, reason: "held_exit_quote_unavailable" }); continue;
    }
    const d = signOf(entry.side), pendingQuantity = orders.reduce((sum, o) => sum + Math.max(0, o.size - o.filledSize), 0);
    entry.size = position.size;
    entry.reservedNotional = (position.size + pendingQuantity) * m.markPrice;
    entry.marginUsd = (position.isolatedMarginUsd ?? position.size * position.avgPrice / entry.leverage)
      + pendingQuantity * entry.entryPrice / entry.leverage;
    entry.stopRiskUsd = Math.max(0, d * (m.markPrice - entry.stopPrice)) * position.size
      + pendingQuantity * Math.abs(entry.entryPrice - entry.initialStop);
    const exit = (reason: string, urgent: boolean) => {
      const existingExit = snapshot.openOrders.some(o => o.marketRef === marketRef && o.purpose === "exit");
      if (existingExit || (entry.status === "exiting" && snapshot.now - (entry.exitSubmittedAt ?? 0) < cfg.exitRetryMin * 60_000)) return;
      const passiveQuote = entry.side === "LONG" ? m.book.asks[0]?.price : m.book.bids[0]?.price;
      const spread = m.book.asks[0] && m.book.bids[0] ? (m.book.asks[0]!.price / m.book.bids[0]!.price - 1) * 10_000 : Infinity;
      const passive = !urgent && passiveQuote !== undefined && spread > 0 && spread <= cfg.maxSpreadBps;
      decisions.push({ kind: "exit", marketRef, reason, urgent, ...(passive ? { limitPrice: passiveQuote, postOnly: true } : {}) });
      entry.exitSubmittedAt = snapshot.now;
      entry.status = "exiting";
    };
    if (d * (exitPrice - entry.stopPrice) <= 0) { exit("protective_stop", true); continue; }
    if (snapshot.now >= Math.min(entry.originalAnchorAt, entry.filledAt + cfg.maxHoldHours * HOUR)) { exit("time_exit", true); continue; }
    if (!latest || forecastProblem(latest, snapshot.now, cfg)) {
      entry.staleSince ??= snapshot.now;
      if (snapshot.now - entry.staleSince >= cfg.staleExitHours * HOUR) { exit("forecast_unavailable", false); continue; }
    } else {
      delete entry.staleSince;
      entry.lastForecastId = latest.id;
      const latestSide = outlookSide(latest);
      if (latestSide && latestSide !== entry.side && Math.abs(latest.spotGapSigma) >= cfg.minGapSigma) { exit("forecast_reversal", false); continue; }
      if (d * (latest.medianPrice - entry.entryPrice) <= 0) { exit("median_crossed_entry", false); continue; }
      const next = quotePrice(latest.medianPrice, m.priceTick, entry.side, true);
      if (Math.abs(next - entry.targetPrice) > 1e-12) {
        decisions.push({ kind: "target", marketRef, targetPrice: next, reason: "forecast_revision" });
        entry.targetPrice = next;
      }
    }
    // The executor owns the resting target; this catches price through the target with nothing resting.
    if (d * (exitPrice - entry.targetPrice) >= 0 && !snapshot.openOrders.some(o => o.marketRef === marketRef && o.purpose === "target")) {
      exit("target_convergence", false);
    }
  }

  const candidates: SwingReduction["candidates"] = [];
  if (!accountFresh || state.halted || untrackedExposure) {
    rejected.push({ marketRef: "*", reason: !accountFresh ? "account_unreconciled" : state.halted ? haltReason : "untracked_exposure" });
    return { state, decisions, candidates, rejected, drawdown };
  }
  for (const market of snapshot.markets) {
    if (state.entries[market.marketRef] || occupied.has(market.marketRef)) continue;
    if ((state.cooldowns[market.marketRef] ?? 0) > snapshot.now) continue;
    const result = buildCandidate(market, snapshot, cfg);
    if (typeof result === "string") rejected.push({ marketRef: market.marketRef, reason: result });
    else candidates.push(result);
  }
  candidates.sort((a, b) => b.rank - a.rank || a.outlook.anchorAt - b.outlook.anchorAt || a.marketRef.localeCompare(b.marketRef));
  for (const [index, candidate] of candidates.entries()) {
    const entries = Object.values(state.entries);
    // A reserved asset always keeps a slot; other candidates leave one free for each reserved asset not yet held.
    const reservedOpen = cfg.reservedAssets.filter(k => k !== candidate.assetKey && !entries.some(e => e.assetKey === k)).length;
    if (entries.length + reservedOpen >= cfg.maxPositions) { rejected.push({ marketRef: candidate.marketRef, reason: "position_count" }); continue; }
    // An asset may have more than one exact venue instrument: the underlying owns the slot.
    if (entries.some(e => e.assetKey === candidate.assetKey)) continue;
    const market = snapshot.markets.find(m => m.marketRef === candidate.marketRef)!;
    // The underlyings still to place this tick and the open reserved slots share the unused margin budget
    // equally, bounded by the slots left; an absent reserved asset keeps its share for when it appears.
    const pending = new Set(candidates.slice(index).filter(o => !entries.some(e => e.assetKey === o.assetKey)).map(o => o.assetKey)).size;
    const slots = Math.max(1, Math.min(pending + reservedOpen, cfg.maxPositions - entries.length));
    const allocation = allocateSwing(candidate, market, snapshot, entries, cfg, drawdown, slots);
    if (typeof allocation === "string") { rejected.push({ marketRef: candidate.marketRef, reason: allocation }); continue; }
    const clientId = `qs-${candidate.marketRef}-${candidate.outlook.id}-${snapshot.now}`;
    const record: SwingEntryRecord = { marketRef: candidate.marketRef, assetKey: candidate.assetKey, assetClass: candidate.assetClass,
      side: candidate.side, outlookId: candidate.outlook.id, basisId: candidate.outlook.basisId, targetFamilyKey: candidate.outlook.targetFamilyKey,
      originalAnchorAt: candidate.outlook.anchorAt, submittedAt: snapshot.now, entryPrice: candidate.entryPrice,
      initialStop: candidate.stopPrice, stopPrice: candidate.stopPrice, targetPrice: candidate.targetPrice,
      size: allocation.size, leverage: allocation.leverage, marginUsd: allocation.marginUsd,
      reservedNotional: allocation.notional, stopRiskUsd: allocation.stopRiskUsd, fundingFraction: candidate.fundingFraction,
      themes: candidate.themes, clientId, status: "planned", lastForecastId: candidate.outlook.id };
    state.entries[candidate.marketRef] = record;
    decisions.push({ kind: "enter", candidate, record: { ...record }, ...allocation, clientId });
  }
  return { state, decisions, candidates, rejected, drawdown };
}

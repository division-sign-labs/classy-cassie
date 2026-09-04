// packages/core/src/thesis/ticket.ts
// Thesis intake sizing module (§13). The strict split: elicitation lives in the
// skill, arithmetic lives here. No figure produced by an LLM ever reaches an
// order — every number on a FilledTicket comes from these functions, and every
// line carries its provenance (answer → rule → number).

import type { FilledTicket, OrderBook, Quote, ThesisTicket, TicketLine } from "../types.js";
import type { RiskConfig } from "../config.js";
import { checkCapacity } from "../risk/capacity.js";
import { DEFAULT_MAPPINGS, atrSpecFor, type Mappings } from "./mappings.js";

export interface MarketSnapshot {
  entryPx: number;
  /** ATR in price units, computed per mappings' timeframe spec. */
  atr: number;
  /** Account equity in USD. */
  equity: number;
  /** Current funding rate, decimal per 8h period (perps). */
  fundingRate8h?: number;
  /** When provided, §9 capacity checks run on the computed size. */
  book?: OrderBook;
  quote?: Quote;
  risk?: RiskConfig;
}

export interface TicketOverrides {
  stopPx?: number;
  tpPx?: number;
  size?: number;
  riskBudgetPct?: number;
}

/**
 * Deterministic ticket arithmetic. Overrides (operator edits during approval)
 * re-run the guardrails; violations require a second explicit confirm at the
 * CLI — nothing is silently blocked, nothing silently passes.
 */
export function buildTicket(
  ticket: ThesisTicket,
  snap: MarketSnapshot,
  mappings: Mappings = DEFAULT_MAPPINGS,
  overrides: TicketOverrides = {},
): FilledTicket {
  const m = mappings;
  const lines: TicketLine[] = [];
  const violations: string[] = [];
  const warnings: string[] = [];
  const bullish = ticket.side === "LONG" || ticket.side === "YES";
  const entryPx = snap.entryPx;
  const riskBudgetPct = overrides.riskBudgetPct ?? ticket.riskBudgetPct;

  if (riskBudgetPct > m.riskBudget.softCap) {
    violations.push(
      `risk budget ${riskBudgetPct}% exceeds the soft cap of ${m.riskBudget.softCap}% — requires override confirm`,
    );
  }

  // ---- Stop (§13 mapping) --------------------------------------------------
  const atrSpec = atrSpecFor(m, ticket.timeframe);
  const volStopDist = atrSpec.k * snap.atr;
  const floorDist = m.stopFloorAtrMult * snap.atr;
  let stopPx: number;
  let stopProvenance: string;
  if (overrides.stopPx !== undefined) {
    stopPx = overrides.stopPx;
    stopProvenance = `operator override`;
  } else if (ticket.invalidationPx !== undefined) {
    const provided = ticket.invalidationPx;
    const providedDist = Math.abs(entryPx - provided);
    if (providedDist < floorDist) {
      stopPx = bullish ? entryPx - floorDist : entryPx + floorDist;
      stopProvenance = `invalidation ${provided} was inside the ${m.stopFloorAtrMult}×ATR floor (${fmt(floorDist)}); widened to the floor`;
      warnings.push(`stop widened from ${fmt(provided)} to ${fmt(stopPx)} (0.5×ATR floor)`);
    } else {
      stopPx = provided;
      stopProvenance = `operator invalidation level`;
    }
  } else {
    stopPx = bullish ? entryPx - volStopDist : entryPx + volStopDist;
    stopProvenance = `volatility-anchored: ${atrSpec.k} × ATR${atrSpec.lookback}(${atrSpec.interval}) = ${fmt(volStopDist)} (no invalidation given)`;
  }
  const stopDist = Math.abs(entryPx - stopPx);
  if (stopDist <= 0) throw new Error("stop distance is zero — stop equals entry");
  lines.push({ field: "entry", value: fmt(entryPx), provenance: "current market price" });
  lines.push({ field: "stop", value: fmt(stopPx), provenance: stopProvenance });

  // ---- Target (§13 mapping) ------------------------------------------------
  const r = m.rMultiples[ticket.magnitude];
  const useTrailing =
    ticket.magnitude === m.trailingWhen.magnitude &&
    (m.trailingWhen.timeframes as string[]).includes(ticket.timeframe) &&
    overrides.tpPx === undefined;
  let tpPx: number | undefined;
  let trailBps: number | undefined;
  let targetDist: number;
  if (overrides.tpPx !== undefined) {
    tpPx = overrides.tpPx;
    targetDist = Math.abs(tpPx - entryPx);
    lines.push({ field: "target", value: fmt(tpPx), provenance: "operator override" });
  } else if (useTrailing) {
    trailBps = Math.round((stopDist / entryPx) * 10_000);
    targetDist = r * stopDist; // still used for Kelly payoff ratio
    lines.push({
      field: "target",
      value: `trailing stop, ${trailBps}bps`,
      provenance: `magnitude "repricing" + timeframe "${ticket.timeframe}" → trailing stop (trail = stop distance ${fmt(stopDist)}) instead of fixed TP`,
      warning: true,
    });
  } else {
    targetDist = r * stopDist;
    tpPx = bullish ? entryPx + targetDist : entryPx - targetDist;
    lines.push({
      field: "target",
      value: fmt(tpPx),
      provenance: `magnitude "${ticket.magnitude}" → ${r}R × stop distance ${fmt(stopDist)}`,
    });
  }

  // ---- Size (§13): two risk fractions, take the smaller --------------------
  const ffFraction = riskBudgetPct / 100;
  const b = targetDist / stopDist; // payoff ratio
  const p0 = 1 / (1 + b); // breakeven probability
  const edge = m.edges[ticket.confidence];
  const p = p0 + edge;
  const fullKelly = p - (1 - p) / b;
  const qkFraction = Math.max(0, fullKelly / 4);

  const chosen: "fixed-fractional" | "quarter-kelly" = qkFraction < ffFraction ? "quarter-kelly" : "fixed-fractional";
  const chosenFraction = Math.min(ffFraction, qkFraction);
  const riskUsd = chosenFraction * snap.equity;
  let size = overrides.size !== undefined ? overrides.size : riskUsd / stopDist;

  lines.push({
    field: "sizing/fixed-fractional",
    value: `risk $${fmt(ffFraction * snap.equity)} → ${fmt((ffFraction * snap.equity) / stopDist)} units`,
    provenance: `${riskBudgetPct}% of equity $${fmt(snap.equity)} at the stop; size = risk / stop distance ${fmt(stopDist)}`,
  });
  lines.push({
    field: "sizing/quarter-kelly",
    value: `risk $${fmt(qkFraction * snap.equity)} → ${fmt((qkFraction * snap.equity) / stopDist)} units`,
    provenance: `b = ${fmt(b)} (target/stop), p₀ = 1/(1+b) = ${fmt(p0)}, p = p₀ + edge(${ticket.confidence}) ${edge} = ${fmt(p)}, f* = p − (1−p)/b = ${fmt(fullKelly)}, fraction = max(0, f*/4) = ${fmt(qkFraction)}`,
  });
  lines.push({
    field: "size",
    value:
      overrides.size !== undefined
        ? `${fmt(size)} units (operator override)`
        : `${fmt(size)} units`,
    provenance:
      overrides.size !== undefined
        ? "operator override"
        : `smaller of the two: ${chosen} (risk $${fmt(riskUsd)})`,
  });

  // ---- Leverage: derived from size and equity ------------------------------
  const levCap = m.leverageCaps[ticket.timeframe];
  let notional = size * entryPx;
  let leverage = notional / snap.equity;
  if (overrides.size === undefined && leverage > levCap) {
    const cappedSize = (levCap * snap.equity) / entryPx;
    lines.push({
      field: "leverage-cap",
      value: `${fmt(leverage)}x → ${levCap}x`,
      provenance: `timeframe "${ticket.timeframe}" caps leverage at ${levCap}x; size reduced ${fmt(size)} → ${fmt(cappedSize)}`,
      warning: true,
    });
    size = cappedSize;
    notional = size * entryPx;
    leverage = levCap;
  } else if (overrides.size !== undefined && leverage > levCap) {
    violations.push(`overridden size implies ${fmt(leverage)}x leverage, above the ${levCap}x cap for "${ticket.timeframe}"`);
  }

  // Liquidation estimate (isolated-margin approximation with maintenance margin).
  const lev = Math.max(leverage, 1e-9);
  const liqPx = bullish
    ? entryPx * (1 - 1 / lev + m.maintenanceMarginFrac)
    : entryPx * (1 + 1 / lev - m.maintenanceMarginFrac);
  lines.push({
    field: "leverage",
    value: `${fmt(leverage)}x (notional $${fmt(notional)} / equity $${fmt(snap.equity)})`,
    provenance: "derived from size and equity",
  });
  lines.push({
    field: "liquidation",
    value: fmt(liqPx),
    provenance: `est. at ${fmt(leverage)}x with ${(m.maintenanceMarginFrac * 100).toFixed(2)}% maintenance margin (approximation)`,
  });

  // Guardrail: implied liquidation must sit at least liqBufferStopMult × stopDistance beyond the stop.
  const liqBuffer = m.liqBufferStopMult * stopDist;
  const liqOk = bullish ? liqPx <= stopPx - liqBuffer : liqPx >= stopPx + liqBuffer;
  if (!liqOk && leverage > 0.01) {
    violations.push(
      `liquidation ${fmt(liqPx)} sits inside the buffer: it must be at least ${m.liqBufferStopMult}× stop distance (${fmt(liqBuffer)}) beyond the stop ${fmt(stopPx)}`,
    );
  }

  // ---- Funding (§13) -------------------------------------------------------
  if (snap.fundingRate8h !== undefined && ticket.venue !== "polymarket") {
    const periods = (m.horizonDays[ticket.timeframe] * 24) / 8;
    const payingSide = snap.fundingRate8h >= 0 ? "LONG" : "SHORT";
    const pays = ticket.side === payingSide;
    const dragPx = Math.abs(snap.fundingRate8h) * periods * entryPx * (pays ? 1 : -1);
    const fracOfTarget = dragPx / targetDist;
    const warn = pays && fracOfTarget > m.fundingWarnFracOfTarget;
    lines.push({
      field: "funding",
      value: `${pays ? "-" : "+"}$${fmt(Math.abs(dragPx) * size)} est. over ${m.horizonDays[ticket.timeframe]}d`,
      provenance: `rate ${(snap.fundingRate8h * 100).toFixed(4)}%/8h × ${periods} periods${warn ? ` — drag is ${(fracOfTarget * 100).toFixed(0)}% of target distance (warn > ${m.fundingWarnFracOfTarget * 100}%)` : ""}`,
      warning: warn,
    });
    if (warn) warnings.push(`estimated funding drag exceeds ${m.fundingWarnFracOfTarget * 100}% of target distance`);
  }

  // ---- Capacity (§9 on the computed size) ----------------------------------
  if (snap.book && snap.quote && snap.risk) {
    const cap = checkCapacity({
      side: bullish ? "BUY" : "SELL",
      desiredSize: size,
      refPrice: entryPx,
      book: snap.book,
      quote: snap.quote,
      risk: snap.risk,
    });
    if (!cap.ok) {
      violations.push(`capacity check failed: ${cap.skipReasons.join("; ")}`);
    } else if (cap.size < size) {
      lines.push({
        field: "capacity",
        value: `${fmt(size)} → ${fmt(cap.size)} units`,
        provenance: cap.notes.join("; ") || "depth cap binds",
        warning: true,
      });
      if (overrides.size !== undefined && overrides.size > cap.size) {
        violations.push(`overridden size ${fmt(overrides.size)} exceeds the capacity cap ${fmt(cap.size)}`);
      } else {
        size = cap.size;
        notional = size * entryPx;
        leverage = notional / snap.equity;
      }
    }
  }

  return {
    ticket: { ...ticket, riskBudgetPct },
    entryPx,
    stopPx: round(stopPx, 6),
    tpPx: tpPx === undefined ? undefined : round(tpPx, 6),
    trailBps,
    size: round(size, 6),
    notional: round(notional, 2),
    leverage: round(leverage, 3),
    liqPx: round(liqPx, 6),
    sizing: {
      fixedFractionalRisk: round(ffFraction * snap.equity, 2),
      quarterKellyRisk: round(qkFraction * snap.equity, 2),
      chosen,
    },
    lines,
    violations,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Prediction-markets variant (§13): thin by design — binaries have no
// meaningful TP/SL. Exit is the take-profit price, the hold deadline, or resolution, owned by flip-flat.
// ---------------------------------------------------------------------------

export interface PredictionSizeResult {
  size: number;
  notional: number;
  entrySpreadPp: number;
  fixedFractionalRisk: number;
  quarterKellyRisk: number;
  chosen: "fixed-fractional" | "quarter-kelly";
  arithmetic: string[];
}

export function buildPredictionSize(
  p: { prob: number; price: number; equity: number; riskBudgetPct: number; confidence: ThesisTicket["confidence"] },
  mappings: Mappings = DEFAULT_MAPPINGS,
): PredictionSizeResult {
  const { prob, price, equity, riskBudgetPct } = p;
  if (price <= 0 || price >= 1) throw new Error("prediction price must be in (0,1)");
  const entrySpreadPp = mappings.predictionEntrySpreadPp[p.confidence];
  // Buying at `price`: win pays (1 - price), loss costs `price` ⇒ b = (1-price)/price.
  const b = (1 - price) / price;
  const ffFraction = riskBudgetPct / 100;
  const fullKelly = prob - (1 - prob) / b;
  const qkFraction = Math.max(0, fullKelly / 4);
  const chosen: PredictionSizeResult["chosen"] = qkFraction < ffFraction ? "quarter-kelly" : "fixed-fractional";
  const riskUsd = Math.min(ffFraction, qkFraction) * equity;
  const size = riskUsd / price; // loss per share if wrong = price paid
  return {
    size: round(size, 4),
    notional: round(size * price, 2),
    entrySpreadPp,
    fixedFractionalRisk: round(ffFraction * equity, 2),
    quarterKellyRisk: round(qkFraction * equity, 2),
    chosen,
    arithmetic: [
      `b = (1−price)/price = ${fmt(b)}; p = model prob ${fmt(prob)}`,
      `full Kelly f* = p − (1−p)/b = ${fmt(fullKelly)}; quarter = ${fmt(qkFraction)}`,
      `fixed-fractional = ${riskBudgetPct}% = ${fmt(ffFraction)}`,
      `risk = min × equity $${fmt(equity)} = $${fmt(riskUsd)}; size = risk / price = ${fmt(size)} shares`,
    ],
  };
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(4).replace(/\.?0+$/, "");
  return n.toPrecision(4).replace(/\.?0+$/, "");
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

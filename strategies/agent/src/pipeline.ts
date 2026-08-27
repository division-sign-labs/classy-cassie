// strategies/agent/src/pipeline.ts
// Pure steps of the wake cycle: joining venue catalog rows with Quotient's
// read, ranking what the model gets to see, and the deterministic gate+size
// step that turns a model decision into an order notional (or a named skip).
// Everything here is side-effect-free so the tests pin exact numbers.

import {
  buildPredictionSize,
  DEFAULT_MAPPINGS,
  type Mappings,
  type MarketRow,
  type QuotientMarketRow,
} from "@quotient-forecasting/cassie-core";
import type { AgentConfig, AgentDecision, Candidate } from "./schema.js";

/** Match a Quotient row to a venue catalog row. */
export function quotientRowMatches(row: MarketRow, q: QuotientMarketRow): boolean {
  if (row.venue === "kalshi") {
    return q.nativeMarketId === row.marketRef || (q.marketKey?.endsWith(`:${row.marketRef}`) ?? false);
  }
  if (row.venue === "polymarket" && row.conditionId) {
    const cond = row.conditionId.toLowerCase();
    return q.conditionId?.toLowerCase() === cond || (q.marketKey?.toLowerCase().endsWith(`:${cond}`) ?? false);
  }
  return false;
}

export function toCandidate(row: MarketRow, q?: QuotientMarketRow): Candidate {
  const price = row.yesPrice;
  const qProb = q?.qProbability ?? undefined;
  const spreadPp =
    q?.spreadPp ?? (qProb !== undefined && price !== undefined ? Math.abs(qProb - price) * 100 : undefined);
  return {
    marketRef: row.marketRef,
    question: row.question,
    endDate: row.endDate,
    price,
    volume24h: Math.round(row.volume24h),
    category: row.category,
    qProb,
    qThesis: q?.thesis,
    spreadPp: spreadPp !== undefined ? Number(spreadPp.toFixed(1)) : undefined,
  };
}

/**
 * Rank what the model sees: forecast-backed spread first, then volume. The
 * model reranks within this set; the cap keeps one wake's prompt bounded.
 */
export function rankCandidates(candidates: Candidate[], max: number): Candidate[] {
  return [...candidates]
    .sort((a, b) => (b.spreadPp ?? 0) - (a.spreadPp ?? 0) || b.volume24h - a.volume24h)
    .slice(0, max);
}

export interface SizedDecision {
  ok: boolean;
  skipped?: string;
  sizingProb?: number;
  notional?: number;
  arithmetic?: string[];
}

/**
 * The deterministic gate + size step. Inputs: the model's decision, the LIVE
 * venue mid (never a model or catalog figure), Quotient's YES-space
 * probability when one exists, and the bankroll the sizer may draw on.
 * No model-produced number reaches the order: `prob` only feeds quarter-Kelly
 * through buildPredictionSize, min'd against the fixed-fractional ceiling,
 * and the engine's checkCapacity still runs after this.
 */
export function gateAndSize(
  decision: AgentDecision,
  liveMid: number,
  qProbYes: number | undefined,
  cfg: AgentConfig,
  kellyEquityUsd: number,
  headroomUsd: number,
  dailyRemainingUsd: number | undefined,
  mappings: Mappings = DEFAULT_MAPPINGS,
): SizedDecision {
  if (!(liveMid > 0 && liveMid < 1)) return { ok: false, skipped: `no usable live mid (${liveMid})` };
  const price = decision.side === "NO" ? 1 - liveMid : liveMid;
  if (!(price > 0 && price < 1)) return { ok: false, skipped: `side price out of range (${price})` };

  // Side-space probabilities. min-edge sizes on whichever of {model, Q} sits
  // closer to the price — the more conservative edge — whenever Q has a read.
  const modelProb = decision.prob;
  const qSideProb = qProbYes !== undefined ? (decision.side === "NO" ? 1 - qProbYes : qProbYes) : undefined;
  const sizingProb =
    cfg.probClamp === "min-edge" && qSideProb !== undefined
      ? Math.abs(qSideProb - price) < Math.abs(modelProb - price)
        ? qSideProb
        : modelProb
      : modelProb;

  const edgePp = (sizingProb - price) * 100;
  const requiredPp = mappings.predictionEntrySpreadPp[decision.confidence];
  if (edgePp < requiredPp) {
    return {
      ok: false,
      sizingProb,
      skipped: `edge ${edgePp.toFixed(1)}pp below the ${decision.confidence}-confidence bar of ${requiredPp}pp`,
    };
  }

  const sized = buildPredictionSize(
    { prob: sizingProb, price, equity: kellyEquityUsd, riskBudgetPct: cfg.riskBudgetPct, confidence: decision.confidence },
    mappings,
  );
  const capped = Math.min(sized.notional, headroomUsd, dailyRemainingUsd ?? Number.POSITIVE_INFINITY);
  if (!(capped >= Math.max(cfg.minEntryNotional, 0.01))) {
    return {
      ok: false,
      sizingProb,
      skipped: `sized notional $${capped.toFixed(2)} below minEntryNotional $${cfg.minEntryNotional.toFixed(2)} (headroom $${headroomUsd.toFixed(2)})`,
    };
  }
  return {
    ok: true,
    sizingProb,
    notional: Number(capped.toFixed(2)),
    arithmetic: sized.arithmetic,
  };
}

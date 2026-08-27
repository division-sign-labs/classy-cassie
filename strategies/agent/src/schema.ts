// strategies/agent/src/schema.ts
// Config and LLM-output contracts for the monitoring-agent strategy.
//
// The division of authority: the model selects, ranks, and vetoes — its
// `prob` is a calibrated probability, not a size. Every number that reaches
// an order comes from buildPredictionSize (quarter-Kelly) and the engine's
// risk module. See the LLM-numbers policy in core/thesis/ticket.ts.

import { z } from "zod";

export const AgentConfigSchema = z.object({
  /** The operator's natural-language mandate, passed to the model verbatim. */
  prompt: z.string().min(1),
  /** Structural filters applied deterministically before anything is paid for. */
  criteria: z
    .object({
      maxDaysToEnd: z.number().positive().optional(),
      minVolume24h: z.number().nonnegative().default(10_000),
      categories: z.array(z.string()).default([]),
    })
    .prefault({}),
  /** Stored persona (not secret). Fetched once via `cassie agent persona`; ~1.5 KB brief. */
  persona: z
    .object({
      handle: z.string(),
      brief: z.string().max(4_000),
      fetchedAt: z.string(),
    })
    .optional(),
  /** Agent bankroll: caps both the Kelly equity base and cumulative deployed cost basis. */
  budgetUsd: z.number().positive(),
  /** Per-trade fixed-fractional ceiling (%); buildPredictionSize takes min(this, quarter-Kelly). */
  riskBudgetPct: z.number().positive().max(20).default(5),
  /** Optional per-UTC-day entry cap on top of the bankroll (flip-flat's meter pattern). */
  dailyBudgetUsd: z.number().positive().optional(),
  maxPositions: z.number().int().positive().default(5),
  minEntryNotional: z.number().nonnegative().default(1),
  /** Paid wake cadence; engine ticks stay cheap housekeeping between wakes. */
  agentIntervalMin: z.number().positive().default(60),
  /** Hard ceiling on Quotient spend per wake, USD. */
  maxQuotientSpendUsdPerWake: z.number().positive().default(0.1),
  quotientCacheTtlMin: z.number().positive().default(240),
  /** How many enriched candidates the model sees per wake. */
  maxCandidates: z.number().int().positive().default(30),
  /**
   * Sizing probability: "min-edge" (default) sizes on whichever of {model
   * prob, Q prob} sits closer to the venue price — the more conservative
   * edge; "model" trusts the model's prob alone.
   */
  probClamp: z.enum(["min-edge", "model"]).default("min-edge"),
  llm: z
    .object({
      baseUrl: z.string().default("https://api.surplusintelligence.ai/min70/v1"),
      fallbackBaseUrl: z.string().default("https://api.surplusintelligence.ai/v1"),
      modelPool: z.array(z.string()).min(1).default(["gpt-5.6-sol", "glm-5.2", "gemini-3.7-flash"]),
      maxOutputTokens: z.number().int().positive().default(4_000),
    })
    .prefault({}),
});
export type AgentConfig = z.output<typeof AgentConfigSchema>;

// ---------------------------------------------------------------------------
// LLM output contract
// ---------------------------------------------------------------------------

export const AgentDecisionSchema = z.object({
  marketRef: z.string(),
  side: z.enum(["YES", "NO"]),
  /** The model's calibrated probability that the NAMED side pays out. */
  prob: z.number().min(0.01).max(0.99),
  confidence: z.enum(["low", "medium", "high"]),
  rationale: z.string().max(400),
  personaNote: z.string().max(200).optional(),
});
export type AgentDecision = z.output<typeof AgentDecisionSchema>;

export const AgentExitSchema = z.object({
  marketRef: z.string(),
  reason: z.string().max(200),
});

export const AgentDecisionBatchSchema = z.object({
  /** One-paragraph read of the landscape; log/status only, never an order input. */
  assessment: z.string().max(600),
  enters: z.array(AgentDecisionSchema).max(10),
  exits: z.array(AgentExitSchema).max(10),
  /** MarketRefs deliberately passed over, for the audit trail. */
  passesNoted: z.array(z.string()).max(10).optional(),
});
export type AgentDecisionBatch = z.output<typeof AgentDecisionBatchSchema>;

// ---------------------------------------------------------------------------
// Candidate + run report shapes
// ---------------------------------------------------------------------------

/** One market as the model sees it: catalog row joined with Quotient's read. */
export interface Candidate {
  marketRef: string;
  question: string;
  endDate?: string;
  /** Live YES price 0–1 from discovery (the sizing price is re-read at order time). */
  price?: number;
  volume24h: number;
  category?: string;
  /** Quotient's calibrated YES probability, when a forecast exists. */
  qProb?: number;
  qThesis?: string;
  /** |qProb − price| in percentage points, when both exist. */
  spreadPp?: number;
}

export interface HeldBrief {
  marketRef: string;
  side: string;
  size: number;
  avgPrice: number;
  qProb?: number;
}

export interface ExecutedLine {
  kind: "enter" | "exit" | "redeem";
  marketRef: string;
  side?: string;
  notional?: number;
  skipped?: string;
  sizingProb?: number;
  arithmetic?: string[];
}

/** Persisted to memory as agent:lastRun; rendered by `cassie agent status` / dry-run. */
export interface AgentRunReport {
  ranAt: string;
  venue: string;
  discovered: number;
  candidates: Candidate[];
  held: HeldBrief[];
  assessment?: string;
  model?: string;
  decisions?: AgentDecisionBatch;
  executed: ExecutedLine[];
  quotientSpendUsd: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Populated instead of decisions when the wake failed partway. */
  error?: string;
}

export const AGENT_MEMORY_KEYS = {
  lastRunAt: "agent:lastRunAt",
  lastRun: "agent:lastRun",
  dailyBudget: "agent:daily-entry-budget",
  qCachePrefix: "agent:q:",
} as const;

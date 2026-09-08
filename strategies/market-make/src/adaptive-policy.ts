// strategies/market-make/src/adaptive-policy.ts
import { z } from "zod";

const finite = z.number().finite();

/** Operational hypotheses, not fitted volatility estimates or profitability claims. */
export const AdaptivePolicySchema = z.object({
  forecast_refresh_seconds: finite.positive().default(900),
  forecast_full_weight_seconds: finite.positive().default(86_400),
  forecast_max_age_seconds: finite.positive().default(129_600),
  max_forecast_candidates: finite.int().positive().max(100).default(30),
  movement_window_seconds: finite.positive().default(300),
  movement_minimum_seconds: finite.positive().default(30),
  movement_minimum_ticks: finite.positive().default(1),
  book_max_age_seconds: finite.positive().default(5),
  clock_skew_seconds: finite.nonnegative().default(5),
  maximum_complement_deviation_pp: finite.nonnegative().max(10).default(3),
  defensive_gap_pp: finite.nonnegative().max(100).default(5),
  directional_minimum_gap_pp: finite.positive().max(100).default(10),
  directional_maximum_gap_pp: finite.positive().max(100).default(30),
  gap_buffer_pp_per_tick: finite.positive().max(100).default(10),
  maximum_quote_buffer_ticks: finite.int().nonnegative().max(10).default(1),
  size_reduction_per_10pp: finite.nonnegative().max(1).default(0.05),
  minimum_size_multiplier: finite.positive().max(1).default(0.75),
}).strict().superRefine((value, context) => {
  if (value.forecast_full_weight_seconds > value.forecast_max_age_seconds) {
    context.addIssue({ code: "custom", path: ["forecast_max_age_seconds"], message: "Must cover the full-weight forecast interval" });
  }
  if (value.movement_minimum_seconds > value.movement_window_seconds) {
    context.addIssue({ code: "custom", path: ["movement_window_seconds"], message: "Must cover the minimum movement interval" });
  }
  if (value.directional_minimum_gap_pp > value.directional_maximum_gap_pp) {
    context.addIssue({ code: "custom", path: ["directional_maximum_gap_pp"], message: "Must cover the minimum directional gap" });
  }
});

export type AdaptivePolicy = z.infer<typeof AdaptivePolicySchema>;

export interface AdaptiveForecast {
  marketKey: string;
  qYes: number;
  /** Forecast publication time, never the HTTP retrieval time. */
  forecastAt: number;
  forecastStatus?: string;
  drawdownRiskElevated?: boolean;
}

export interface AdaptiveMovement {
  observedAt: number;
  referenceAt: number;
  referenceYesMid: number;
  yesMid: number;
}

export interface AdaptiveQuoteContext {
  regime: "balanced" | "defensive" | "directional" | "reduce-only";
  forecastAgeSeconds?: number;
  gapPp?: number;
  quoteBufferTicks: number;
  sizeMultiplier: number;
  reason: string;
  favoredOutcome?: "YES" | "NO";
  targetShareQuantity?: number;
  inventoryAction?: "hold" | "exit";
  inventoryReason?: string;
  remainingEdgePp?: number;
  holdDeadlineAt?: number;
}

/** Entry evidence and exit settings supplied by the durable inventory controller. */
export interface AdaptiveInventoryControl {
  firstHeldAt?: number;
  initialEdgePp?: number;
  qBacked?: boolean;
  maximumHoldSeconds: number;
  minimumHoldEdgePp: number;
  remainingEdgeExitPp: number;
  capturedGapFraction: number;
  forceReduceReason?: string;
}

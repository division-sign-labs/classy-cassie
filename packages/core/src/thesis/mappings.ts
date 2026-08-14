// packages/core/src/thesis/mappings.ts
// The entire thesis-intake policy surface (§13). The canonical versioned copy
// lives at skills/cassie/thesis/mappings.json; DEFAULT_MAPPINGS mirrors it so
// core works without file I/O. Alternative files load via `--mappings <file>`.
// EXTEND: confidence edges, ATR multipliers, R-multiples, leverage caps are all
// policy — change them by PR-ing the JSON file, not this code.

import { z } from "zod";
import type { Timeframe } from "../types.js";

export const MappingsSchema = z.object({
  version: z.number(),
  /** edge(confidence): assumed probability edge over breakeven, in absolute terms. */
  edges: z.object({ low: z.number(), medium: z.number(), high: z.number() }),
  /** timeframe → (candle interval, lookback, k) for the volatility-anchored stop. */
  atr: z.record(
    z.enum(["intraday", "days", "weeks", "quarter"]),
    z.object({ interval: z.enum(["1h", "4h", "1d"]), lookback: z.number(), k: z.number() }),
  ),
  /** magnitude → R-multiple of stop distance for the target. */
  rMultiples: z.object({ small: z.number(), meaningful: z.number(), repricing: z.number() }),
  /** magnitude+timeframe combos that default to a trailing stop instead of fixed TP. */
  trailingWhen: z.object({ magnitude: z.literal("repricing"), timeframes: z.array(z.enum(["weeks", "quarter"])) }),
  leverageCaps: z.object({ intraday: z.number(), days: z.number(), weeks: z.number(), quarter: z.number() }),
  /** Stop floor: a provided invalidation inside this × ATR is widened to it. */
  stopFloorAtrMult: z.number(),
  /** Liquidation must sit at least this × stopDistance beyond the stop. */
  liqBufferStopMult: z.number(),
  /** Maintenance margin fraction used in the liquidation-price estimate. */
  maintenanceMarginFrac: z.number(),
  riskBudget: z.object({ default: z.number(), softCap: z.number() }),
  /** Warn when estimated funding drag exceeds this fraction of target distance. */
  fundingWarnFracOfTarget: z.number(),
  horizonDays: z.object({ intraday: z.number(), days: z.number(), weeks: z.number(), quarter: z.number() }),
  /** Prediction-markets variant: confidence → entrySpreadPp. */
  predictionEntrySpreadPp: z.object({ low: z.number(), medium: z.number(), high: z.number() }),
});
export type Mappings = z.output<typeof MappingsSchema>;

export const DEFAULT_MAPPINGS: Mappings = {
  version: 1,
  edges: { low: 0.03, medium: 0.06, high: 0.1 },
  atr: {
    intraday: { interval: "1h", lookback: 14, k: 1.5 },
    days: { interval: "4h", lookback: 14, k: 2.0 },
    weeks: { interval: "1d", lookback: 14, k: 2.5 },
    quarter: { interval: "1d", lookback: 20, k: 3.0 },
  },
  rMultiples: { small: 1.5, meaningful: 2.5, repricing: 4 },
  trailingWhen: { magnitude: "repricing", timeframes: ["weeks", "quarter"] },
  leverageCaps: { intraday: 10, days: 5, weeks: 3, quarter: 2 },
  stopFloorAtrMult: 0.5,
  liqBufferStopMult: 2,
  maintenanceMarginFrac: 0.005,
  riskBudget: { default: 1, softCap: 2 },
  fundingWarnFracOfTarget: 0.25,
  horizonDays: { intraday: 1, days: 5, weeks: 21, quarter: 90 },
  predictionEntrySpreadPp: { low: 12, medium: 10, high: 7 },
};

export function parseMappings(raw: unknown): Mappings {
  return MappingsSchema.parse(raw);
}

export function atrSpecFor(m: Mappings, tf: Timeframe) {
  const spec = m.atr[tf];
  if (!spec) throw new Error(`mappings missing atr spec for timeframe ${tf}`);
  return spec;
}

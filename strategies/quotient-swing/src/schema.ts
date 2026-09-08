// strategies/quotient-swing/src/schema.ts
// Strategy parameters, validated before every decision cycle.
import { z } from "zod";

const LiveSwingConfigSchema = z.object({
  mode: z.literal("live").default("live"),
  minHorizonHours: z.number().min(24).default(24),
  maxHorizonHours: z.number().max(120).default(120),
  maxPublicationAgeHours: z.number().positive().default(2),
  maxBookAgeSec: z.number().positive().default(30),
  maxAccountAgeSec: z.number().positive().default(60),
  maxFundingAgeMin: z.number().positive().default(60),
  /** Outlook freshness states accepted for entry and for keeping a held forecast current. */
  freshnessStates: z.array(z.string().min(1)).min(1).default(["fresh"]),
  /** Entry requires |spot_gap_sigma| inside [minGapSigma, maxGapSigma] on the published side. */
  minGapSigma: z.number().positive().default(0.30),
  maxGapSigma: z.number().positive().default(1.0),
  /** Native stop distance as a multiple of the outlook's own horizon uncertainty. Backtest: stops only subtract, so this is a safety net. */
  stopSigmaMultiple: z.number().positive().default(3.0),
  /** Maximum hold after the fill; the backtest found trades still open after 48h average a loss. */
  maxHoldHours: z.number().positive().max(120).default(48),
  /** Adverse funding reserve as a multiple of the current hourly rate over the remaining horizon. */
  fundingReserveMultiple: z.number().min(1).default(1.5),
  riskBasePct: z.number().positive().max(10).default(5),
  riskMaxPct: z.number().positive().max(10).default(10),
  /** Net edge (log return to the median after costs) where the risk ramp starts and saturates. */
  riskBaseEdge: z.number().positive().default(0.005),
  riskMaxEdge: z.number().positive().default(0.02),
  singleNotionalNav: z.number().positive().max(2).default(2),
  grossNotionalNav: z.number().positive().max(10).default(10),
  /** Concurrent positions; with margin-based sizing the total margin cap is the practical limit. */
  maxPositions: z.number().int().positive().max(20).default(9),
  /** Planned stop-loss budget across the book; set at or above totalMarginPct so margin allocation is the binding rule. */
  totalStopRiskPct: z.number().positive().max(100).default(90),
  /** Assets that always keep one of the position slots available to them; other candidates leave that slot free. */
  reservedAssets: z.array(z.string().min(1)).default(["commodity:wti"]),
  /** Engine-side theme caps; kept equal to the portfolio caps so they never bind below them. */
  themeNotionalNav: z.number().positive().max(10).default(10),
  themeStopRiskPct: z.number().positive().max(100).default(90),
  /** Isolated margin posted per position and in total, as a share of NAV. */
  singleMarginPct: z.number().positive().max(25).default(10),
  totalMarginPct: z.number().positive().max(90).default(90),
  maxLeverage: z.number().int().positive().max(20).default(20),
  liquidationStopMultiple: z.number().min(1).default(1),
  emergencyGapFraction: z.number().min(0.01).default(0.01),
  maxSpreadBps: z.number().positive().default(20),
  minVolume24hUsd: z.number().nonnegative().default(100_000),
  maxOracleGapFraction: z.number().positive().default(0.01),
  maxSlippageBps: z.number().positive().default(20),
  exitDepthBps: z.number().positive().default(50),
  minDepthMultiple: z.number().positive().default(1),
  minOrderNotional: z.number().positive().default(10),
  entryTtlMin: z.number().positive().default(15),
  unresolvedEntryTimeoutMin: z.number().positive().default(30),
  exitRetryMin: z.number().positive().default(5),
  drawdownReduceFraction: z.number().positive().default(0.15),
  drawdownHaltFraction: z.number().positive().max(0.25).default(0.25),
  staleExitHours: z.number().positive().default(24),
  /** Re-entry waits for the next hourly revision; a fresh gap on the same asset is a new trade. */
  postExitCooldownHours: z.number().positive().default(1),
  tickIntervalMin: z.number().positive().default(1),
  signalPollIntervalMin: z.number().positive().default(5),
}).strict().superRefine((c, ctx) => {
  for (const [bad, path, message] of [
    [c.minHorizonHours > c.maxHorizonHours, "minHorizonHours", "minimum horizon exceeds maximum"],
    [c.minGapSigma >= c.maxGapSigma, "minGapSigma", "minimum gap must be below maximum gap"],
    [c.riskBasePct > c.riskMaxPct, "riskBasePct", "base risk exceeds maximum risk"],
    [c.riskBaseEdge >= c.riskMaxEdge, "riskBaseEdge", "base edge must be below maximum edge"],
    [c.singleMarginPct > c.totalMarginPct, "singleMarginPct", "single margin exceeds total margin"],
    [c.drawdownReduceFraction >= c.drawdownHaltFraction, "drawdownReduceFraction", "reduction drawdown must be below halt drawdown"],
  ] as const) if (bad) ctx.addIssue({ code: "custom", path: [path], message });
});

/** Keys from earlier strategy revisions that a deployed bot config may still carry. */
export const REMOVED_SWING_CONFIG_KEYS = [
  "paperInitialNav", "maxSyntheticAgeHours", "maxVenueForecastAgeHours", "minNetEdge", "minNetSigma", "nearConflictSigma",
  "riskBaseScore", "riskMaxScore", "stopAtrMultiple", "swingBufferFraction", "trailingAtrMultiple", "convergenceSigma",
  "modelCacheMinutes", "requireModelAssessment", "classShare",
] as const;

export const QuotientSwingConfigSchema = z.preprocess(value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const config = { ...(value as Record<string, unknown>) };
  for (const key of REMOVED_SWING_CONFIG_KEYS) delete config[key];
  return config;
}, LiveSwingConfigSchema);

export type QuotientSwingConfig = z.infer<typeof QuotientSwingConfigSchema>;
export const SwingConfigSchema = QuotientSwingConfigSchema;

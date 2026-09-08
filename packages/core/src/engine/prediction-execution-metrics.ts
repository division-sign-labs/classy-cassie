// packages/core/src/engine/prediction-execution-metrics.ts
// Execution-quality metrics derived only from validated, confirmed fills.

/** Validated parent execution terms, child receipts, and confirmed incremental fills. */
export interface PredictionExecutionMetricsInput {
  /** Original positive share target for the parent, before partial fills. */
  targetSize: number;
  side: "BUY" | "SELL";
  /** Executable best bid and ask at parent admission, in outcome-token price units. */
  arrivalBid?: number;
  arrivalAsk?: number;
  /** Epoch milliseconds at parent admission and, when known, terminal reconciliation. */
  admittedAt: number;
  terminalAt?: number;
  children: Array<{
    /** True only for an order submitted with the venue's post-only guarantee. */
    postOnly: boolean;
    createdAt: number;
    cancelRequestedAt?: number;
  }>;
  /** Confirmed incremental fills, already deduplicated by their owned order and trade identities. */
  fills: Array<{
    size: number;
    price: number;
    /** Actual fee in USD; never an estimate of fees avoided. */
    fee: number;
    ts: number;
    postOnly: boolean;
  }>;
}

/** Share-weighted execution quality. USD improvement is gross; fees remain a separate metric. */
export interface PredictionExecutionMetrics {
  makerFillSize: number;
  takerFillSize: number;
  /** Share of confirmed filled quantity obtained by post-only children; null before any fill. */
  makerShare: number | null;
  /** Confirmed filled shares divided by the parent share target, in [0, 1]. */
  fillRatio: number;
  timeToFirstFillMs: number | null;
  /** Admission to terminal reconciliation, including partial or canceled terminal executions. */
  completionTimeMs: number | null;
  /** Number of child orders for which cancellation was requested, regardless of retry count. */
  cancelCount: number;
  /** Signed USD savings against the original executable touch; null without fills or that touch. */
  priceImprovementUsd: number | null;
  feeUsd: number;
}

/** Derive metrics from validated input without mutating it or consulting current venue prices. */
export function derivePredictionExecutionMetrics(input: PredictionExecutionMetricsInput): PredictionExecutionMetrics {
  let makerFillSize = 0;
  let takerFillSize = 0;
  let feeUsd = 0;
  let firstFillAt: number | undefined;
  let improvementUsd = 0;
  const arrivalTouch = input.side === "BUY" ? input.arrivalAsk : input.arrivalBid;

  for (const fill of input.fills) {
    if (fill.postOnly) makerFillSize += fill.size;
    else takerFillSize += fill.size;
    feeUsd += fill.fee;
    firstFillAt = Math.min(firstFillAt ?? fill.ts, fill.ts);
    if (arrivalTouch !== undefined) {
      improvementUsd += fill.size * (input.side === "BUY" ? arrivalTouch - fill.price : fill.price - arrivalTouch);
    }
  }

  const filledSize = makerFillSize + takerFillSize;
  return {
    makerFillSize,
    takerFillSize,
    makerShare: filledSize > 0 ? makerFillSize / filledSize : null,
    fillRatio: Math.min(1, Math.max(0, filledSize / input.targetSize)),
    timeToFirstFillMs: firstFillAt === undefined ? null : Math.max(0, firstFillAt - input.admittedAt),
    completionTimeMs: input.terminalAt === undefined ? null : Math.max(0, input.terminalAt - input.admittedAt),
    cancelCount: input.children.filter(child => child.cancelRequestedAt !== undefined).length,
    priceImprovementUsd: filledSize > 0 && arrivalTouch !== undefined ? improvementUsd : null,
    feeUsd,
  };
}

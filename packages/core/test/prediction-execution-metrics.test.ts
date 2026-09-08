// packages/core/test/prediction-execution-metrics.test.ts
import { describe, expect, it } from "vitest";
import { derivePredictionExecutionMetrics, type PredictionExecutionMetricsInput } from "../src/engine/prediction-execution-metrics.js";

const NOW = 1_000_000;
const base: PredictionExecutionMetricsInput = {
  targetSize: 100,
  side: "BUY",
  arrivalBid: .5,
  arrivalAsk: .6,
  admittedAt: NOW,
  children: [],
  fills: [],
};

describe("prediction execution quality metrics", () => {
  it("reports a waiting execution without inventing fill statistics", () => {
    expect(derivePredictionExecutionMetrics(base)).toEqual({
      makerFillSize: 0, takerFillSize: 0, makerShare: null, fillRatio: 0,
      timeToFirstFillMs: null, completionTimeMs: null, cancelCount: 0, priceImprovementUsd: null, feeUsd: 0,
    });
  });

  it("measures BUY improvement at the arrival ask and weights maker share by quantity", () => {
    const metrics = derivePredictionExecutionMetrics({ ...base, terminalAt: NOW + 70_000,
      children: [{ postOnly: true, createdAt: NOW, cancelRequestedAt: NOW + 40_000 }, { postOnly: false, createdAt: NOW + 50_000 }],
      // Deliberately out of timestamp order: first fill is an economic timestamp, not array position.
      fills: [{ size: 25, price: .61, fee: .25, ts: NOW + 60_000, postOnly: false },
        { size: 75, price: .54, fee: 0, ts: NOW + 20_000, postOnly: true }],
    });
    expect(metrics).toMatchObject({ makerFillSize: 75, takerFillSize: 25, makerShare: .75, fillRatio: 1,
      timeToFirstFillMs: 20_000, completionTimeMs: 70_000, cancelCount: 1, feeUsd: .25 });
    expect(metrics.priceImprovementUsd).toBeCloseTo(4.25);
  });

  it("measures SELL improvement at the arrival bid and preserves negative execution improvement", () => {
    const metrics = derivePredictionExecutionMetrics({ ...base, side: "SELL", terminalAt: NOW + 80_000,
      fills: [{ size: 20, price: .55, fee: 0, ts: NOW + 15_000, postOnly: true },
        { size: 80, price: .48, fee: .3, ts: NOW + 65_000, postOnly: false }],
    });
    expect(metrics.makerShare).toBe(.2);
    expect(metrics.priceImprovementUsd).toBeCloseTo(-.6);
    expect(metrics.feeUsd).toBe(.3);
  });

  it("keeps a canceled partial execution's fill ratio separate from its terminal duration", () => {
    const metrics = derivePredictionExecutionMetrics({ ...base, terminalAt: NOW + 130_000,
      children: [{ postOnly: true, createdAt: NOW, cancelRequestedAt: NOW + 30_000 },
        { postOnly: true, createdAt: NOW + 40_000, cancelRequestedAt: NOW + 120_000 }],
      fills: [{ size: 10, price: .51, fee: 0, ts: NOW + 5000, postOnly: true },
        { size: 20, price: .55, fee: 0, ts: NOW + 50_000, postOnly: true }],
    });
    expect(metrics).toMatchObject({ makerFillSize: 30, takerFillSize: 0, makerShare: 1, fillRatio: .3,
      timeToFirstFillMs: 5000, completionTimeMs: 130_000, cancelCount: 2, feeUsd: 0 });
    expect(metrics.priceImprovementUsd).toBeCloseTo(1.9);
  });

  it("does not substitute the opposite touch when the applicable arrival benchmark is missing", () => {
    const input: PredictionExecutionMetricsInput = { ...base, arrivalAsk: undefined,
      fills: [{ size: 10, price: .51, fee: 0, ts: NOW + 5000, postOnly: true }] };
    const before = structuredClone(input);
    expect(derivePredictionExecutionMetrics(input).priceImprovementUsd).toBeNull();
    expect(input).toEqual(before);
    expect(derivePredictionExecutionMetrics({ ...input, side: "SELL", arrivalBid: undefined, arrivalAsk: .6 }).priceImprovementUsd).toBeNull();
  });

  it("reports cancellation and terminal duration for a completely unfilled parent", () => {
    const metrics = derivePredictionExecutionMetrics({ ...base, admittedAt: 0, terminalAt: 120_000,
      children: [{ postOnly: true, createdAt: 0, cancelRequestedAt: 0 }] });
    expect(metrics).toMatchObject({ fillRatio: 0, makerShare: null, priceImprovementUsd: null,
      timeToFirstFillMs: null, completionTimeMs: 120_000, cancelCount: 1 });
  });
});

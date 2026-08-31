// packages/runtime-node/test/tick-schedule.test.ts

import { describe, expect, it } from "vitest";
import {
  nextTickAtMs,
  tickIdAt,
  tickIntervalSeconds,
} from "../src/tick-schedule.js";

describe("durable tick scheduling", () => {
  it("converts the configured minute cadence to seconds", () => {
    expect(tickIntervalSeconds(JSON.stringify({ tickIntervalMin: 5 }))).toBe(300);
    expect(tickIntervalSeconds(JSON.stringify({ tickIntervalMin: 0.01 }))).toBe(1);
  });

  it("reads the cadence from the top level, not from strategy.config", () => {
    const config = JSON.stringify({
      tickIntervalMin: 5,
      strategy: { id: "signals", config: { tickIntervalMin: 60 } },
    });
    expect(tickIntervalSeconds(config)).toBe(300);
    expect(() => tickIntervalSeconds(JSON.stringify({ strategy: { config: { tickIntervalMin: 5 } } }))).toThrow();
  });

  it.each(["not json", "[]", "{}", '{"tickIntervalMin":0}', '{"tickIntervalMin":"5"}'])(
    "rejects an invalid runtime config: %s",
    (config) => expect(() => tickIntervalSeconds(config)).toThrow(),
  );

  it("aligns the successor to the next cadence boundary", () => {
    expect(nextTickAtMs(1_000, 300)).toBe(300_000);
    expect(nextTickAtMs(300_000, 300)).toBe(600_000);
    expect(nextTickAtMs(599_999, 300)).toBe(600_000);
  });

  it("derives a stable id for every cadence slot", () => {
    expect(tickIdAt(300_000, 300)).toBe(1);
    expect(tickIdAt(599_999, 300)).toBe(1);
    expect(tickIdAt(600_000, 300)).toBe(2);
  });
});

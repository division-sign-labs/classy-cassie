// packages/cli/test/monitor-cadence.test.ts
import { describe, expect, it } from "vitest";
import type { BotConfig } from "@quotient-forecasting/cassie-core";
import { statusCadence } from "../src/commands/monitor.js";

describe("status cadence", () => {
  it("describes two-sided book updates without claiming a directional signal loop", () => {
    const config = { tickIntervalMin: 0.25, strategy: { id: "market-make", config: { two_sided: {}, reconciliation: { rest_reconcile_seconds: 15 } } } } as BotConfig;
    expect(statusCadence(config)).toBe("two-sided quotes on book updates, routine account checks every 60s; fills trigger reconciliation");
  });
  it("preserves the directional signal cadence", () => {
    const config = { tickIntervalMin: 1, strategy: { id: "flip-flat", config: { signalPollIntervalMin: 5 } } } as BotConfig;
    expect(statusCadence(config)).toBe("positions every 60s, signals every 5m");
  });
});

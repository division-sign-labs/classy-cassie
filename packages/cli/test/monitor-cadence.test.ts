// packages/cli/test/monitor-cadence.test.ts
import { describe, expect, it } from "vitest";
import type { BotConfig } from "@quotient-forecasting/cassie-core";
import { statusCadence } from "../src/commands/monitor.js";

describe("status cadence", () => {
  it("preserves the directional signal cadence", () => {
    const config = { tickIntervalMin: 1, strategy: { id: "flip-flat", config: { signalPollIntervalMin: 5 } } } as BotConfig;
    expect(statusCadence(config)).toBe("positions every 60s, signals every 5m");
  });
});

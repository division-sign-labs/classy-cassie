// packages/cli/test/strategy-tick-interval.test.ts
// The engine cadence is bot-level, so `--position-check-seconds` writes it at
// the top of the bot config and deletes any older copy under strategy.config.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBotConfig } from "@quotient-forecasting/cassie-core";
import { loadBotConfig, saveBotConfig } from "../src/paths.js";
import { runStrategy } from "../src/commands/strategy.js";

const originalHome = process.env.CASSIE_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.CASSIE_HOME;
  else process.env.CASSIE_HOME = originalHome;
  vi.restoreAllMocks();
});

function seedBot(strategyConfig: Record<string, unknown>): void {
  process.env.CASSIE_HOME = mkdtempSync(join(tmpdir(), "cassie-strategy-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  saveBotConfig(
    parseBotConfig({
      id: "tickbot",
      venue: "polymarket",
      strategy: { id: "signals", config: { entrySpreadPp: 10, ...strategyConfig } },
      tickIntervalMin: 1,
    }),
  );
}

describe("cassie strategy --position-check-seconds", () => {
  it("saves the cadence at the top level only", async () => {
    seedBot({});
    await runStrategy("tickbot", { positionCheckSeconds: "300" });
    const cfg = loadBotConfig("tickbot");
    expect(cfg.tickIntervalMin).toBe(5);
    expect(cfg.strategy.config).not.toHaveProperty("tickIntervalMin");
  });

  it("clears a stale strategy-level copy on the next save", async () => {
    seedBot({ tickIntervalMin: 60 });
    expect(loadBotConfig("tickbot").strategy.config).toHaveProperty("tickIntervalMin", 60);
    await runStrategy("tickbot", { positionCheckSeconds: "300" });
    const cfg = loadBotConfig("tickbot");
    expect(cfg.tickIntervalMin).toBe(5);
    expect(cfg.strategy.config).not.toHaveProperty("tickIntervalMin");
  });
});

// packages/cli/test/hold-preset-cli.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBotConfig } from "@quotient-forecasting/cassie-core";
import { HOLD_STRATEGY, runStrategy } from "../src/commands/strategy.js";
import { loadBotConfig, saveBotConfig } from "../src/paths.js";

const originalHome = process.env.CASSIE_HOME;
let root: string;
let output: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cassie-hold-preset-"));
  process.env.CASSIE_HOME = root;
  output = [];
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => output.push(parts.map(String).join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.CASSIE_HOME;
  else process.env.CASSIE_HOME = originalHome;
});

function bot(): string {
  const cfg = parseBotConfig({
    id: "hold-preset-test",
    venue: "polymarket",
    strategy: { id: "signals", config: { entrySpreadPp: 10, maxEntrySpreadPp: 30, takeProfitPrice: 0.9, kellyFraction: 0.25 } },
    alerts: { telegram: { chatId: "chat" } },
    tickIntervalMin: 1,
    createdAt: "2026-01-01T00:00:00Z",
  });
  saveBotConfig(cfg);
  return cfg.id;
}

describe("hold preset on the CLI", () => {
  it("replaces the strategy settings with the preset", async () => {
    const id = bot();
    await runStrategy(id, { preset: "hold" });
    expect(loadBotConfig(id).strategy.config).toEqual({ ...HOLD_STRATEGY });
    const text = output.join("\n");
    expect(text).toMatch(/allocation mode:\s+fixed-notional/);
    expect(text).toMatch(/lot per entry:\s+\$10\.00/);
    expect(text).toMatch(/resolution window:\s+60 days or less at entry/);
    expect(text).toMatch(/Q flip:\s+2 distinct forecasts below 50%, exit on confirmation at any remaining edge/);
    expect(text).toMatch(/time stop:\s+off \(hold to resolution\)/);
    expect(text).toMatch(/Q collapse:\s+off/);
    expect(text).toMatch(/adverse cross:\s+off/);
  });

  it("accepts off for the gated exits and a fixed lot size", async () => {
    const id = bot();
    await runStrategy(id, {
      lotNotional: "25",
      maxWindowDays: "off",
      qCollapsePp: "off",
      adverseCrossConfirmations: "off",
      flipExitMaxRemainingEdgePp: "off",
    });
    const config = loadBotConfig(id).strategy.config as Record<string, unknown>;
    expect(config.allocationMode).toBe("fixed-notional");
    expect(config.lotNotionalUsd).toBe(25);
    expect(config.kellyFraction).toBeUndefined();
    expect(config.maxWindowDays).toBeNull();
    expect(config.qCollapsePp).toBeNull();
    expect(config.adverseCrossConfirmations).toBeNull();
    expect(config.flipExitMaxRemainingEdgePp).toBeNull();
    expect(output.join("\n")).toMatch(/lot per entry:\s+\$25\.00/);
  });

  it("refuses a lot size together with Kelly sizing", async () => {
    const id = bot();
    await expect(runStrategy(id, { lotNotional: "25", kellyFraction: "0.5" })).rejects.toThrow(/cannot be combined/);
  });
});

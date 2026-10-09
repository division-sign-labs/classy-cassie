// packages/cli/test/strategy-config.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBotConfig } from "@quotient-forecasting/cassie-core";
import { loadBotConfig, saveBotConfig } from "../src/paths.js";
import * as context from "../src/context.js";
import {
  RECOMMENDED_STRATEGY,
  elicitRecommendedStrategyConfig,
  elicitStrategyConfig,
  recommendedStrategySummary,
  runStrategy,
} from "../src/commands/strategy.js";

const originalHome = process.env.CASSIE_HOME;
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.CASSIE_HOME;
  else process.env.CASSIE_HOME = originalHome;
});

describe("signals recommended allocation", () => {
  it("saves and displays the sports hold policy without changing the Q exit settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "cassie-sports-hold-")); roots.push(root); process.env.CASSIE_HOME = root;
    saveBotConfig(parseBotConfig({ id: "sports", venue: "polymarket", strategy: { id: "signals", config: { scenarioExitEnabled: true, flipConfirmations: 2 } } }));
    const lines: string[] = []; vi.spyOn(console, "log").mockImplementation((...parts) => { lines.push(parts.map(String).join(" ")); });
    await runStrategy("sports", { sportsHoldAfterStart: "on" });
    expect(loadBotConfig("sports").strategy.config).toMatchObject({ sportsHoldAfterStart: true, scenarioExitEnabled: true, flipConfirmations: 2 });
    expect(lines.join("\n")).toMatch(/sports after kickoff:\s+hold to settlement/);
    await runStrategy("sports", { sportsHoldAfterStart: "off" });
    expect(loadBotConfig("sports").strategy.config.sportsHoldAfterStart).toBe(false);
    await expect(runStrategy("sports", { sportsHoldAfterStart: "maybe" })).rejects.toThrow(/on or off/);
  });
  it("uses quarter Kelly with a 5% event cap on prediction venues", async () => {
    const recommended = await elicitRecommendedStrategyConfig({}, "polymarket");

    expect(RECOMMENDED_STRATEGY.marketCapPct).toBeNull();
    expect(RECOMMENDED_STRATEGY.eventCapPct).toBe(5);
    expect(recommended).toMatchObject({
      allocationMode: "portfolio-kelly",
      kellyFraction: 0.25,
      marketCapPct: null,
      eventCapPct: 5,
      nearResolutionDays: null,
      minExitDepth2cUsd: 0,
      entrySpreadPp: 0,
      maxEntrySpreadPp: null,
      maxHoldDays: null,
    });
    expect(recommendedStrategySummary("kalshi")).toBe("quarter-Kelly sizing, 5% per event");
  });

  it("displays the recommended AUM caps for an empty prediction strategy config", async () => {
    const root = mkdtempSync(join(tmpdir(), "cassie-strategy-config-"));
    roots.push(root);
    process.env.CASSIE_HOME = root;
    saveBotConfig(
      parseBotConfig({
        id: "cap-display",
        venue: "polymarket",
        strategy: { id: "signals", config: {} },
      }),
    );
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map(String).join(" "));
    });

    await runStrategy("cap-display", { top: "unlimited" });

    const output = lines.join("\n");
    expect(output).toMatch(/per-market cap:\s+off/);
    expect(output).toMatch(/per-event cap:\s+5% of portfolio equity/);
    expect(output).toMatch(/near resolution:\s+off/);
    expect(output).toMatch(/entry liquidity:\s+off/);
    expect(output).toMatch(/minimum entry edge:\s+0pp/);
    expect(output).toMatch(/maximum entry edge:\s+unlimited/);
    expect(output).toMatch(/exit model:\s+signal state machine/);
    expect(output).toMatch(/adverse cross:\s+edge <= 0pp and P&L <= 0% on 1 distinct forecasts/);
    expect(output).toMatch(/Q flip:\s+1 distinct forecasts below 50%, exit on confirmation at any remaining edge/);
    expect(output).toMatch(/time stop:\s+off \(hold to resolution\)/);
  });

  it("defaults custom bot setup to hold to resolution and preserves explicit exits", async () => {
    vi.spyOn(context, "ask").mockImplementation(async (_message, options) => String(options?.default ?? ""));

    expect(await elicitStrategyConfig({}, "polymarket")).toMatchObject({
      maxHoldDays: null, marketCapPct: null, eventCapPct: 5,
      minExitDepth2cUsd: 0, entrySpreadPp: 0, maxEntrySpreadPp: null,
    });
    expect(await elicitStrategyConfig({ maxHoldDays: 7 }, "polymarket")).toMatchObject({ maxHoldDays: 7 });
  });

  it("can remove a saved market cap while keeping the event cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "cassie-market-cap-"));
    roots.push(root);
    process.env.CASSIE_HOME = root;
    saveBotConfig(parseBotConfig({ id: "market-cap", venue: "polymarket",
      strategy: { id: "signals", config: { marketCapPct: 2.5, eventCapPct: 5 } },
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runStrategy("market-cap", { marketCapPct: "off" });
    expect(loadBotConfig("market-cap").strategy.config).toMatchObject({ marketCapPct: null, eventCapPct: 5 });
    await expect(runStrategy("market-cap", { marketCapPct: "101" })).rejects.toThrow(/at most 100%/);
  });

  it("preserves a saved deadline until it is disabled or the recommended preset is selected", async () => {
    const root = mkdtempSync(join(tmpdir(), "cassie-hold-default-"));
    roots.push(root);
    process.env.CASSIE_HOME = root;
    const id = "hold-default";
    saveBotConfig(parseBotConfig({
      id,
      venue: "polymarket",
      strategy: { id: "signals", config: { takeProfitPrice: 0.9, maxHoldDays: 7 } },
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runStrategy(id, { top: "unlimited" });
    expect(loadBotConfig(id).strategy.config).toMatchObject({ maxHoldDays: 7 });
    await runStrategy(id, { maxHoldDays: "unlimited" });
    expect(loadBotConfig(id).strategy.config).toMatchObject({ maxHoldDays: null });
    await runStrategy(id, { maxHoldDays: "7" });
    await runStrategy(id, { preset: "recommended" });
    const reset = loadBotConfig(id).strategy.config;
    expect(reset).toMatchObject({ allocationMode: "portfolio-kelly", maxHoldDays: null });
    // The preset drops a take-profit saved by an older release.
    expect(reset).not.toHaveProperty("takeProfitPrice");
  });

  it("accepts the near-resolution flags and reports the window as off when disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "cassie-strategy-config-"));
    roots.push(root);
    process.env.CASSIE_HOME = root;
    saveBotConfig(
      parseBotConfig({
        id: "near-resolution",
        venue: "polymarket",
        strategy: { id: "signals", config: {} },
      }),
    );
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map(String).join(" "));
    });

    await runStrategy("near-resolution", { nearResolutionDays: "2", nearResolutionSizeCutPct: "50" });
    expect(lines.join("\n")).toMatch(/near resolution:\s+50% smaller when the market resolves within 2 days/);

    lines.length = 0;
    await runStrategy("near-resolution", { nearResolutionDays: "off" });
    expect(lines.join("\n")).toMatch(/near resolution:\s+off/);
    await expect(runStrategy("near-resolution", { nearResolutionSizeCutPct: "101" })).rejects.toThrow(/at most 100%/);
  });
});

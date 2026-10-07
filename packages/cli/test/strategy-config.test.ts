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
  it("uses the 2.5% market and 5% parent-event caps on prediction venues", async () => {
    const recommended = await elicitRecommendedStrategyConfig({}, "polymarket");

    expect(RECOMMENDED_STRATEGY.marketCapPct).toBe(2.5);
    expect(RECOMMENDED_STRATEGY.eventCapPct).toBe(5);
    expect(recommended).toMatchObject({
      allocationMode: "portfolio-kelly",
      marketCapPct: 2.5,
      eventCapPct: 5,
      nearResolutionDays: 3,
      nearResolutionSizeCutPct: 25,
      maxHoldDays: null,
    });
    expect(recommendedStrategySummary("kalshi")).toContain("2.5% per market and 5% per event");
    expect(recommendedStrategySummary("kalshi")).toContain("25% smaller within 3 days of resolution");
    expect(RECOMMENDED_STRATEGY.takeProfitPrice).toBe(0.9);
    expect(recommendedStrategySummary("kalshi")).toContain("sell at a 90¢ bid or hold to resolution, no time limit");
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
    expect(output).toMatch(/per-market cap:\s+2\.5% of portfolio equity/);
    expect(output).toMatch(/per-event cap:\s+5% of portfolio equity/);
    expect(output).toMatch(/near resolution:\s+25% smaller when the market resolves within 3 days/);
    expect(output).toMatch(/take profit:\s+sell once the held-side bid reaches \$0\.90/);
    expect(output).toMatch(/maximum hold:\s+unlimited/);
  });

  it("defaults custom bot setup to unlimited and preserves an explicit deadline", async () => {
    vi.spyOn(context, "ask").mockImplementation(async (_message, options) => String(options?.default ?? ""));

    expect(await elicitStrategyConfig({}, "polymarket")).toMatchObject({ maxHoldDays: null });
    expect(await elicitStrategyConfig({ maxHoldDays: 7 }, "polymarket")).toMatchObject({ maxHoldDays: 7 });
  });

  it("preserves a saved deadline until it is disabled or the recommended preset is selected", async () => {
    const root = mkdtempSync(join(tmpdir(), "cassie-hold-default-"));
    roots.push(root);
    process.env.CASSIE_HOME = root;
    const id = "hold-default";
    saveBotConfig(parseBotConfig({
      id,
      venue: "polymarket",
      strategy: { id: "signals", config: { maxHoldDays: 7 } },
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runStrategy(id, { top: "unlimited" });
    expect(loadBotConfig(id).strategy.config.maxHoldDays).toBe(7);
    await runStrategy(id, { maxHoldDays: "unlimited" });
    expect(loadBotConfig(id).strategy.config.maxHoldDays).toBeNull();
    await runStrategy(id, { maxHoldDays: "7" });
    await runStrategy(id, { preset: "recommended" });
    expect(loadBotConfig(id).strategy.config).toMatchObject({
      allocationMode: "portfolio-kelly",
      takeProfitPrice: 0.9,
      maxHoldDays: null,
    });
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
    await runStrategy("near-resolution", { nearResolutionDays: "off", takeProfitPrice: "off" });
    expect(lines.join("\n")).toMatch(/near resolution:\s+off/);
    expect(lines.join("\n")).toMatch(/take profit:\s+off/);
    await expect(runStrategy("near-resolution", { nearResolutionSizeCutPct: "101" })).rejects.toThrow(/at most 100%/);
    await expect(runStrategy("near-resolution", { takeProfitPrice: "1.5" })).rejects.toThrow(/between 0 and 1/);
  });
});

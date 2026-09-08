// packages/cli/test/strategy-config.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBotConfig } from "@quotient-forecasting/cassie-core";
import { loadBotConfig, saveBotConfig } from "../src/paths.js";
import {
  RECOMMENDED_STRATEGY,
  elicitRecommendedStrategyConfig,
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
    });
    // Entry and exit rules are served by Quotient, never written by the CLI.
    expect(recommended).not.toHaveProperty("entrySpreadPp");
    expect(recommended).not.toHaveProperty("convergenceExitPp");
    expect(recommended).not.toHaveProperty("maxHoldDays");
    expect(recommendedStrategySummary("kalshi")).toContain("2.5% per market and 5% per event");
    expect(recommendedStrategySummary("kalshi")).toContain("served by Quotient");
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
    expect(output).toMatch(/entry and exit rules:\s+served by Quotient/);
    expect(output).toMatch(/Quotient fee:\s+0\.75% of notional per fill/);
    expect(output).not.toMatch(/convergence exit/);
  });

  it("strips rule keys an older CLI saved and never writes them back", async () => {
    const root = mkdtempSync(join(tmpdir(), "cassie-strategy-config-"));
    roots.push(root);
    process.env.CASSIE_HOME = root;
    saveBotConfig(
      parseBotConfig({
        id: "legacy-rules",
        venue: "polymarket",
        strategy: { id: "signals", config: { entrySpreadPp: 4, convergenceExitPp: 1, maxHoldDays: 30, marketCapPct: 2 } },
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runStrategy("legacy-rules", { marketCapPct: "3" });
    const saved = loadBotConfig("legacy-rules").strategy.config as Record<string, unknown>;
    expect(saved).toMatchObject({ marketCapPct: 3 });
    expect(saved).not.toHaveProperty("entrySpreadPp");
    expect(saved).not.toHaveProperty("convergenceExitPp");
    expect(saved).not.toHaveProperty("maxHoldDays");
  });
});

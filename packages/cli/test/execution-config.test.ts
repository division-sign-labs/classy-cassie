// packages/cli/test/execution-config.test.ts

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBotConfig, type BotConfig } from "@quotient-forecasting/cassie-core";
import { runStrategy, type StrategyOptions } from "../src/commands/strategy.js";
import { botConfigPath, loadBotConfig, saveBotConfig } from "../src/paths.js";

const originalHome = process.env.CASSIE_HOME;
let root: string;
let output: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cassie-execution-config-"));
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

function bot(overrides: Record<string, unknown> = {}): BotConfig {
  const cfg = parseBotConfig({
    id: "execution-test",
    venue: "polymarket",
    strategy: { id: "signals", config: { entrySpreadPp: 12, customSetting: "keep" } },
    risk: { slippagePct: 2, maxOrderNotional: 45 },
    alerts: { telegram: { chatId: "chat" } },
    tickIntervalMin: 2,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
  saveBotConfig(cfg);
  return cfg;
}

describe("directional execution settings", () => {
  it("changes only execution when only execution flags are supplied", async () => {
    const before = bot();

    await runStrategy(before.id, { execution: "adaptive", entryDeadlineSeconds: "180", exitPassiveSeconds: "30" });

    expect(loadBotConfig(before.id)).toEqual({
      ...before,
      execution: { mode: "adaptive", entryDeadlineSec: 180, entryCrossingSec: 60, exitPassiveSec: 30 },
    });
    expect(output.join("\n")).toMatch(/execution:\s+adaptive/);
    expect(output.join("\n")).toMatch(/entry deadline:\s+180 sec/);
    expect(output.join("\n")).toMatch(/exit passive phase:\s+30 sec/);
  });

  it("sets and disables the entry crossing window", async () => {
    const before = bot({ execution: { mode: "adaptive", entryDeadlineSec: 120, exitPassiveSec: 60 } });
    await runStrategy(before.id, { entryCrossingSeconds: "45" });
    expect(loadBotConfig(before.id).execution).toEqual({ mode: "adaptive", entryDeadlineSec: 120, entryCrossingSec: 45, exitPassiveSec: 60 });
    expect(output.join("\n")).toMatch(/entry crossing:\s+45 sec marketable limit inside the price bound after the deadline/);
    await runStrategy(before.id, { entryCrossingSeconds: "0" });
    expect(loadBotConfig(before.id).execution!.entryCrossingSec).toBe(0);
    expect(output.join("\n")).toMatch(/entry crossing:\s+off \(maker-only entries\)/);
  });

  it("preserves saved deadlines when switching mode and permits an immediate exit phase", async () => {
    const before = bot({ execution: { mode: "adaptive", entryDeadlineSec: 240, exitPassiveSec: 90 } });

    await runStrategy(before.id, { execution: "legacy" });
    expect(loadBotConfig(before.id).execution).toEqual({ mode: "legacy", entryDeadlineSec: 240, entryCrossingSec: 60, exitPassiveSec: 90 });
    expect(output.join("\n")).toMatch(/exit passive phase:\s+90 sec \(inactive in legacy mode\)/);

    await runStrategy(before.id, { exitPassiveSeconds: "0" });
    expect(loadBotConfig(before.id).execution).toEqual({ mode: "legacy", entryDeadlineSec: 240, entryCrossingSec: 60, exitPassiveSec: 0 });
  });

  it.each(["signals", "flip-flat"])("reports adaptive defaults for Polymarket %s without writing an execution block", async (id) => {
    const before = bot({ strategy: { id, config: {} } });

    await runStrategy(before.id, { top: "unlimited" });

    expect(loadBotConfig(before.id).execution).toBeUndefined();
    expect(JSON.parse(readFileSync(botConfigPath(before.id), "utf8"))).not.toHaveProperty("execution");
    expect(output.join("\n")).toMatch(/execution:\s+adaptive/);
    expect(output.join("\n")).toMatch(/entry deadline:\s+off \(entries start with the marketable limit\)/);
    expect(output.join("\n")).toMatch(/exit passive phase:\s+60 sec/);
  });

  it("supports combined strategy and execution updates without replacing unrelated settings", async () => {
    const before = bot({ execution: { mode: "legacy", entryDeadlineSec: 240, exitPassiveSec: 45 } });

    await runStrategy(before.id, { execution: "adaptive", slippage: "1", top: "4" });

    const after = loadBotConfig(before.id);
    expect(after.execution).toEqual({ ...before.execution, mode: "adaptive" });
    expect(after.risk).toEqual({ ...before.risk, slippagePct: 1 });
    expect(after.strategy.config).toMatchObject({ ...before.strategy.config, topN: 4 });
    expect(after.alerts).toEqual(before.alerts);
    expect(after.tickIntervalMin).toBe(before.tickIntervalMin);
  });

  it("drops legacy reporting on save without requiring a reporting credential", async () => {
    const before = bot();
    writeFileSync(botConfigPath(before.id), JSON.stringify({ ...before, reporting: { provider: "ares", builderCode: "retired-invalid-code", post: true } }));

    await runStrategy(before.id, { entryDeadlineSeconds: "150" });

    expect(loadBotConfig(before.id)).toEqual({ ...before, execution: { mode: "adaptive", entryDeadlineSec: 150, entryCrossingSec: 60, exitPassiveSec: 60 } });
    expect(JSON.parse(readFileSync(botConfigPath(before.id), "utf8"))).not.toHaveProperty("reporting");
  });

  it("saves a zero entry deadline so entries start with the marketable limit", async () => {
    const before = bot();
    await runStrategy(before.id, { entryDeadlineSeconds: "0" });
    expect(loadBotConfig(before.id).execution).toEqual({ mode: "adaptive", entryDeadlineSec: 0, entryCrossingSec: 60, exitPassiveSec: 60 });
    await runStrategy(before.id, { top: "unlimited" });
    expect(output.join("\n")).toMatch(/entry deadline:\s+off \(entries start with the marketable limit\)/);
  });

  it.each(["kalshi", "hyperliquid", "lighter"])("leaves %s on legacy execution and rejects execution flags", async (venue) => {
    const before = bot({ venue });
    await runStrategy(before.id, { top: "unlimited" });
    expect(output.join("\n")).toMatch(/execution:\s+legacy/);
    expect(output.join("\n")).not.toMatch(/entry deadline:/);
    const persisted = readFileSync(botConfigPath(before.id), "utf8");

    for (const opts of [{ execution: "legacy" }, { entryDeadlineSeconds: "100" }, { exitPassiveSeconds: "0" }]) {
      await expect(runStrategy(before.id, opts)).rejects.toThrow(/only for Polymarket signals/);
    }
    expect(readFileSync(botConfigPath(before.id), "utf8")).toBe(persisted);
  });

  it.each(["agent", "market-make", "quotient-swing"])("rejects execution flags for %s", async (id) => {
    const before = bot({ venue: id === "quotient-swing" ? "hyperliquid" : "polymarket", strategy: { id, config: {} } });
    const persisted = readFileSync(botConfigPath(before.id), "utf8");

    await expect(runStrategy(before.id, { execution: "adaptive" })).rejects.toThrow(/only for Polymarket signals/);

    expect(readFileSync(botConfigPath(before.id), "utf8")).toBe(persisted);
  });

  it.each<StrategyOptions>([
    { execution: "market" },
    { entryDeadlineSeconds: "0", entryCrossingSeconds: "0" },
    { entryDeadlineSeconds: "-1" },
    { entryDeadlineSeconds: "3601" },
    { entryDeadlineSeconds: "Infinity" },
    { exitPassiveSeconds: "-1" },
    { exitPassiveSeconds: "3601" },
    { exitPassiveSeconds: "NaN" },
    { entryCrossingSeconds: "-1" },
    { entryCrossingSeconds: "3601" },
    { entryCrossingSeconds: "NaN" },
  ])("rejects invalid settings %j without writing", async (opts) => {
    const before = bot();
    const persisted = readFileSync(botConfigPath(before.id), "utf8");

    await expect(runStrategy(before.id, opts)).rejects.toThrow();

    expect(readFileSync(botConfigPath(before.id), "utf8")).toBe(persisted);
  });
});

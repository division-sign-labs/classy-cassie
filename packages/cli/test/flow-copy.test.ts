// packages/cli/test/flow-copy.test.ts
// Concise setup copy retains consent, costs and standalone copyable values.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => ({ ask: vi.fn(), confirm: vi.fn(), open: vi.fn() }));
vi.mock("../src/context.js", async original => ({ ...await original<typeof import("../src/context.js")>(),
  ask: prompts.ask, confirm: prompts.confirm, openUrl: prompts.open }));
vi.mock("../src/local-env.js", async original => ({ ...await original<typeof import("../src/local-env.js")>(),
  resolveLocalValue: () => null }));

import { elicitAgentConfig } from "../src/commands/agent.js";
import { saveThesis } from "../src/commands/ticket.js";
import { DigitalOcean, ensureDigitalOceanReady, tokenPath } from "../src/digitalocean.js";

let directory: string;
let output: string[];
beforeEach(() => {
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), "cassie-flow-copy-"));
  vi.stubEnv("CASSIE_HOME", directory);
  vi.stubEnv("XDG_CONFIG_HOME", directory);
  output = [];
  vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => { output.push(values.map(String).join(" ")); });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("flow copy", () => {
  it("asks one-purpose agent questions and retains the recurring research cost warning", async () => {
    prompts.ask.mockImplementation(async (label: string, options?: { default?: string }) => label === "Agent mandate" ? "Track energy forecasts" : options?.default ?? "");
    const config = await elicitAgentConfig({});
    expect(config).toMatchObject({ prompt: "Track energy forecasts", budgetUsd: 100, riskBudgetPct: 5, agentIntervalMin: 60 });
    expect(prompts.ask).toHaveBeenCalledWith("Agent mandate", expect.any(Object));
    expect(prompts.ask).toHaveBeenCalledWith("Maximum deployed bankroll, USD", expect.any(Object));
    expect(output).toContain("Each scan uses paid research.");
    expect(output.join("\n")).not.toContain("The model decides");
  });

  it("prints a saved thesis path and shell-safe command on separate lines", () => {
    const path = join(directory, "Sam's thesis.json");
    saveThesis({ venue: "hyperliquid", instrument: "xyz:NVDA", side: "LONG", confidence: "medium",
      timeframe: "days", magnitude: "meaningful", riskBudgetPct: 1 }, path);
    expect(output).toEqual(["Thesis saved.", path, `cassie trade BOT_ID --from-thesis '${path.replaceAll("'", "'\\''")}'`]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ instrument: "xyz:NVDA", riskBudgetPct: 1 });
  });

  it("keeps DigitalOcean billing, scopes and owner-only storage visible without printing the token", async () => {
    const token = "not-a-real-digitalocean-token";
    prompts.confirm.mockResolvedValue(false);
    prompts.ask.mockResolvedValue(token);
    vi.spyOn(DigitalOcean.prototype, "account").mockResolvedValue({ account: { email: "owner@example.com", status: "active", droplet_limit: 5 } });
    await ensureDigitalOceanReady();
    expect(output).toContain("DigitalOcean bills your account for the droplet.");
    expect(output).toContain("Create an API token with read and write scope:");
    expect(output).toContain("https://cloud.digitalocean.com/account/api/tokens");
    expect(output).toContain(tokenPath());
    expect(output).toContain("Saved with owner-only permissions (0600):");
    expect(output.join("\n")).not.toContain(token);
    expect(prompts.ask).toHaveBeenCalledWith("Paste the token", { secret: true });
    expect(prompts.open).not.toHaveBeenCalled();
    expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
  });
});

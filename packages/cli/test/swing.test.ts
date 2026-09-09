// packages/cli/test/swing.test.ts
// Live configuration and startup checks use in-memory files and a fake control client.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { parseBotConfig, type BotConfig } from "@quotient-forecasting/cassie-core";

const harness = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), files: new Set<string>(), configText: "{}",
  control: vi.fn(), confirm: vi.fn(),
  request: vi.fn(() => { throw new Error("network access is forbidden in this test"); }),
}));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => String(path).startsWith("/private/tmp/cassie-swing-test/")
      ? harness.files.has(String(path)) : actual.existsSync(path),
    readFileSync: (path: Parameters<typeof actual.readFileSync>[0], options?: Parameters<typeof actual.readFileSync>[1]) => {
      if (String(path) === "/private/tmp/cassie-swing-test/config.json") return harness.configText;
      // Other command modules load their checked-in strategy presets during import.
      return actual.readFileSync(path, options);
    },
  };
});
vi.mock("node:http", async importOriginal => ({
  ...await importOriginal<typeof import("node:http")>(), request: harness.request,
}));
vi.mock("../src/context.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/context.js")>(), controlFetch: harness.control, confirm: harness.confirm,
}));
vi.mock("../src/paths.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/paths.js")>();
  return { ...actual, loadBotConfig: harness.load, saveBotConfig: harness.save,
    statePath: () => "/private/tmp/cassie-swing-test/state.sqlite",
    dirs: { ...actual.dirs, run: () => "/private/tmp/cassie-swing-test/run" } };
});

import { configureSwing, swingResume } from "../src/commands/swing.js";
import { configureInitTelegram, offerInitDeployment, requireSafeStrategyTransition } from "../src/commands/init.js";
import { assertGenericOrderMutationAllowed } from "../src/commands/ops.js";
import { runDeploy, runtimeAutostartBeforePreflights, startRuntimeAfterPreflights } from "../src/commands/deploy.js";
import { runBot } from "../src/commands/run.js";

function bot(strategyId = "quotient-swing", config: Record<string, unknown> = {}): BotConfig {
  return parseBotConfig({ id: "swing-test", venue: "hyperliquid", strategy: { id: strategyId, config } });
}
function deployed(cfg = bot()): BotConfig {
  return { ...cfg, deployment: { provider: "digitalocean", dropletId: 123,
    host: "203.0.113.10", region: "sgp1", size: "s-1vcpu-1gb", user: "root" } };
}

beforeEach(() => {
  harness.files.clear(); harness.configText = "{}";
  harness.load.mockReset().mockReturnValue(bot()); harness.save.mockReset(); harness.request.mockClear();
  harness.control.mockReset().mockResolvedValue({ halted: false }); harness.confirm.mockReset().mockResolvedValue(true);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network access is forbidden in this test"); }));
});
afterEach(() => {
  try {
    expect(harness.request).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});

describe("swing configuration boundaries", () => {
  it("preserves real filesystem checks outside its isolated test paths", () => {
    expect(existsSync(new URL("../src/commands/swing.ts", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../../core/package.json", import.meta.url))).toBe(true);
    expect(existsSync("/private/tmp/cassie-swing-test/missing.json")).toBe(false);
  });

  it("rejects local configuration changes while a runtime socket exists", () => {
    harness.files.add("/private/tmp/cassie-swing-test/run/swing-test.sock");
    expect(() => configureSwing("swing-test", {})).toThrow(/stop the local runtime/);
    expect(harness.save).not.toHaveBeenCalled();
  });

  it("rejects deployed configuration changes even without a local socket", () => {
    harness.load.mockReturnValue(deployed());
    expect(() => configureSwing("swing-test", {})).toThrow(/reviewed deployment workflow/);
    expect(harness.save).not.toHaveBeenCalled();
  });

  it.each(["signals", "agent"])("does not reuse %s strategy state for a swing bot", strategy => {
    harness.load.mockReturnValue(bot(strategy));
    harness.files.add("/private/tmp/cassie-swing-test/state.sqlite");
    expect(() => configureSwing("swing-test", {})).toThrow(/create a new bot id/);
    expect(harness.save).not.toHaveBeenCalled();
  });

  it("configures an unused bot in live mode without calendar setup, starting or resuming it", () => {
    harness.load.mockReturnValue(bot("signals"));
    configureSwing("swing-test", {});
    expect(harness.save).toHaveBeenCalledOnce();
    expect(harness.save.mock.calls[0]?.[0]).toMatchObject({
      id: "swing-test", venue: "hyperliquid", tickIntervalMin: 1,
      strategy: { id: "quotient-swing", config: { mode: "live",
        riskBasePct: 10, riskMaxPct: 15 } },
    });
    const saved = harness.save.mock.calls[0]?.[0] as BotConfig;
    expect(Object.keys(saved.strategy.config).some(key => /calendar|earnings|closure|macro/i.test(key))).toBe(false);
    expect(saved.strategy.config).not.toHaveProperty("paperInitialNav");
  });

  it("preserves explicit settings and existing swing state for a stopped swing bot", () => {
    harness.load.mockReturnValue(bot("quotient-swing", { mode: "live", riskBasePct: 4, tickIntervalMin: 2,
      grossNotionalNav: 3, paperInitialNav: 500 }));
    harness.files.add("/private/tmp/cassie-swing-test/state.sqlite");
    configureSwing("swing-test", {});
    const saved = harness.save.mock.calls[0]?.[0] as BotConfig;
    expect(saved).toMatchObject({ tickIntervalMin: 2, strategy: { config: {
      mode: "live", riskBasePct: 4, grossNotionalNav: 3,
    } } });
    expect(saved.strategy.config).not.toHaveProperty("paperInitialNav");
  });

  it("drops settings from earlier strategy revisions when reconfiguring a deployed bot", () => {
    const retired = { paperInitialNav: 1000, maxSyntheticAgeHours: 12, maxVenueForecastAgeHours: 24, minNetEdge: 0.005, minNetSigma: 0.2,
      nearConflictSigma: 0.15, riskBaseScore: 0.3, riskMaxScore: 0.6, stopAtrMultiple: 2, swingBufferFraction: 0.01, trailingAtrMultiple: 2,
      convergenceSigma: 0.05, modelCacheMinutes: 60, requireModelAssessment: true, classShare: { commodity: 0.5, equity: 0.5 } };
    harness.load.mockReturnValue(bot("quotient-swing", { mode: "live", riskBasePct: 5, ...retired }));
    configureSwing("swing-test", {});
    const saved = harness.save.mock.calls[0]?.[0] as BotConfig;
    for (const key of Object.keys(retired)) expect(saved.strategy.config).not.toHaveProperty(key);
    expect(saved.strategy.config).toMatchObject({ minGapSigma: 0.3, maxGapSigma: 1, stopSigmaMultiple: 3, maxHoldHours: 48,
      singleMarginPct: 20, totalMarginPct: 80, maxPositions: 9, reservedAssets: ["commodity:wti"] });
    expect(saved.strategy.config).not.toHaveProperty("classShare");
  });

  it("rejects a retired paper configuration instead of silently making it live", () => {
    harness.configText = JSON.stringify({ mode: "paper" });
    expect(() => configureSwing("swing-test", { config: "/private/tmp/cassie-swing-test/config.json" })).toThrow();
    expect(harness.save).not.toHaveBeenCalled();
  });

  it("rejects retired paper runtimes before credentials, compilation, or remote work", async () => {
    harness.load.mockReturnValue(bot("quotient-swing", { mode: "paper" }));
    await expect(runBot("swing-test", {})).rejects.toThrow(/live/);
    await expect(runDeploy("swing-test", { fromWorkspace: true })).rejects.toThrow(/live/);
  });

  it("accepts a strict live config file without calendar settings", () => {
    harness.configText = JSON.stringify({ riskBasePct: 4 });
    configureSwing("swing-test", { config: "/private/tmp/cassie-swing-test/config.json" });
    expect(harness.save.mock.calls[0]?.[0]).toMatchObject({ strategy: { config: {
      mode: "live", riskBasePct: 4,
    } } });
  });

  it.each(["[]", "null", "42"])("rejects a non-object config %s without saving", value => {
    harness.configText = value;
    expect(() => configureSwing("swing-test", { config: "/private/tmp/cassie-swing-test/config.json" })).toThrow(/JSON object/);
    expect(harness.save).not.toHaveBeenCalled();
  });

  it.each([
    { riskMaxPct: 26 }, { unknownSetting: true }, { calendarUrl: "https://example.com/calendar.json" },
    { calendarFile: "/reviewed/calendar.json" },
  ])("validates the complete config before saving: %j", value => {
    harness.configText = JSON.stringify(value);
    expect(() => configureSwing("swing-test", { config: "/private/tmp/cassie-swing-test/config.json" })).toThrow();
    expect(harness.save).not.toHaveBeenCalled();
  });

  it("rejects a non-Hyperliquid bot without changing its config", () => {
    harness.load.mockReturnValue(parseBotConfig({ ...bot("signals"), venue: "polymarket" }));
    expect(() => configureSwing("swing-test", {})).toThrow(/requires Hyperliquid/);
    expect(harness.save).not.toHaveBeenCalled();
  });
});

describe("swing identity and native-stop protection", () => {
  it.each(["signals", "agent", "market-make"])("requires a new id when switching %s to or from swing", strategy => {
    expect(() => requireSafeStrategyTransition(strategy, "quotient-swing")).toThrow(/separate bot id/);
    expect(() => requireSafeStrategyTransition("quotient-swing", strategy)).toThrow(/separate bot id/);
  });

  it("allows a new swing identity and reconfiguration of that same strategy", () => {
    expect(() => requireSafeStrategyTransition(undefined, "quotient-swing")).not.toThrow();
    expect(() => requireSafeStrategyTransition("quotient-swing", "quotient-swing")).not.toThrow();
  });

  it.each([false, true])("blocks generic cancellation for local/deployed=%s without blocking reads", isDeployed => {
    const cfg = isDeployed ? deployed() : bot();
    for (const opts of [{ cancel: "native-stop-id" }, { cancel: "" }, { cancelAll: true }]) {
      expect(() => assertGenericOrderMutationAllowed(cfg, opts)).toThrow(/native stops:\ncassie swing halt swing-test/);
    }
    expect(() => assertGenericOrderMutationAllowed(cfg, {})).not.toThrow();
    expect(() => assertGenericOrderMutationAllowed(cfg, { cancelAll: false })).not.toThrow();
  });
});

describe("swing deployment starts live after preflights", () => {
  it("keeps first-boot autostart off until deployment preflights complete", () => {
    expect(runtimeAutostartBeforePreflights(bot())).toBe("0");
  });

  it("initializes and reads status without a separate halt or resume", async () => {
    const calls: Array<{ method: string; path: string; body?: string }> = [];
    const initialized = { ok: true };
    const status = { halted: false, execution: { halted: false } };
    const result = await startRuntimeAfterPreflights(bot(), (method, path, body) => {
      calls.push({ method, path, body });
      if (path === "/init") return initialized;
      if (path === "/swing/status") return status;
      throw new Error(`unexpected control operation: ${path}`);
    });
    expect(calls).toEqual([
      { method: "POST", path: "/init", body: undefined },
      { method: "GET", path: "/swing/status", body: undefined },
    ]);
    expect(result).toEqual({ started: initialized, swingStatus: status });
  });

  it("propagates startup failure without trying a recovery resume", async () => {
    const call = vi.fn(() => { throw new Error("startup check failed"); });
    await expect(startRuntimeAfterPreflights(bot(), call)).rejects.toThrow("startup check failed");
    expect(call).toHaveBeenCalledExactlyOnceWith("POST", "/init");
  });

  it.each([null, [], "ok"])("rejects malformed init response %j without trying resume", async response => {
    const paths: string[] = [];
    await expect(startRuntimeAfterPreflights(bot(), (_method, path) => {
      paths.push(path); return response;
    })).rejects.toThrow(/\/init returned a non-object/);
    expect(paths).toEqual(["/init"]);
  });

  it("preserves a durable operator or safety halt in the reported startup result", async () => {
    const status = { halted: true, execution: { haltReason: "operator" } };
    const call = vi.fn((_method: string, path: string) => path === "/init" ? { ok: true } : status);
    await expect(startRuntimeAfterPreflights(bot(), call)).resolves.toMatchObject({ swingStatus: status });
    expect(call.mock.calls.map(([, path]) => path)).toEqual(["/init", "/swing/status"]);
  });

  it("requires a definite execution state before reporting startup", async () => {
    await expect(startRuntimeAfterPreflights(bot(), () => ({ ok: true }))).rejects.toThrow(/invalid execution status/);
  });
});

describe("swing halt recovery", () => {
  beforeEach(() => { harness.load.mockReturnValue(deployed()); });

  it("resumes after reading status without asking for normal activation confirmation", async () => {
    await swingResume("swing-test");
    expect(harness.confirm).not.toHaveBeenCalled();
    expect(harness.control.mock.calls.map(([, path]) => path)).toEqual(["/swing/status", "/swing/resume"]);
    expect(harness.control.mock.calls[1]?.[2]).toEqual({ method: "POST", body: JSON.stringify({ confirmed: true, acknowledgeLossReset: false }) });
  });

  it("still asks for explicit confirmation before resetting a loss stop", async () => {
    await swingResume("swing-test", { acknowledgeLossReset: true });
    expect(harness.confirm).toHaveBeenCalledExactlyOnceWith("Reset the drawdown high-water mark after reviewing the losses?", false);
    expect(harness.control.mock.calls[1]?.[2]).toEqual({ method: "POST", body: JSON.stringify({ confirmed: true, acknowledgeLossReset: true }) });
  });

  it("does not reset or resume when loss-reset confirmation is declined", async () => {
    harness.confirm.mockResolvedValue(false);
    await swingResume("swing-test", { acknowledgeLossReset: true });
    expect(harness.control.mock.calls.map(([, path]) => path)).toEqual(["/swing/status"]);
  });

  it("does not retry or resume when the preceding status read fails", async () => {
    harness.control.mockRejectedValue(new Error("status unavailable"));
    await expect(swingResume("swing-test")).rejects.toThrow("status unavailable");
    expect(harness.control).toHaveBeenCalledOnce();
    expect(harness.confirm).not.toHaveBeenCalled();
  });
});

describe("concise setup output", () => {
  it("prints commands on their own lines", async () => {
    const messages: string[] = [];
    await offerInitDeployment("swing-test", false, {
      confirm: vi.fn().mockResolvedValue(false), deploy: vi.fn(), print: message => messages.push(message),
    });
    expect(messages.filter(message => message.includes("cassie "))).toEqual([
      "cassie run swing-test", "cassie deploy swing-test",
    ]);
  });
});

function telegramSetup() {
  const messages: string[] = [];
  return {
    ask: vi.fn().mockResolvedValueOnce("test-token").mockResolvedValueOnce("42"),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue("skip"),
    print: (message: string) => messages.push(message), messages,
    send: vi.fn().mockResolvedValue(undefined), saveToken: vi.fn(),
  };
}

describe("Telegram setup failure recovery", () => {
  it("saves the token only after the test succeeds", async () => {
    const d = telegramSetup();
    d.send.mockImplementation(async () => { expect(d.saveToken).not.toHaveBeenCalled(); });
    await expect(configureInitTelegram(undefined, d)).resolves.toEqual({ chatId: "42" });
    expect(d.saveToken).toHaveBeenCalledExactlyOnceWith("test-token");
    expect(d.messages).toContain("Telegram test sent.");
  });

  it("offers corrected settings after a rejected bot recipient without exposing provider payloads", async () => {
    const d = telegramSetup();
    d.ask.mockResolvedValueOnce("corrected-token").mockResolvedValueOnce("123");
    d.send.mockRejectedValueOnce(new Error("403 bots can't send messages to bots; secret-token-in-provider-payload"));
    d.select.mockResolvedValue("edit");
    await expect(configureInitTelegram(undefined, d)).resolves.toEqual({ chatId: "123" });
    expect(d.send.mock.calls).toEqual([["test-token", "42"], ["corrected-token", "123"]]);
    expect(d.saveToken).toHaveBeenCalledExactlyOnceWith("corrected-token");
    expect(d.messages).toContain("Telegram rejected a bot chat ID. Use your personal chat ID.");
    expect(d.messages.join("\n")).not.toContain("secret-token-in-provider-payload");
  });

  it("allows an explicit retry without re-entering or saving the credentials", async () => {
    const d = telegramSetup();
    d.send.mockRejectedValueOnce(new Error("connection failed"));
    d.select.mockResolvedValue("retry");
    await expect(configureInitTelegram(undefined, d)).resolves.toEqual({ chatId: "42" });
    expect(d.ask).toHaveBeenCalledTimes(2);
    expect(d.send).toHaveBeenCalledTimes(2);
    expect(d.saveToken).toHaveBeenCalledOnce();
  });

  it("disables alerts only after the user explicitly skips a failed test", async () => {
    const d = telegramSetup();
    d.send.mockRejectedValue(new Error("chat not found"));
    await expect(configureInitTelegram({ chatId: "previous" }, d)).resolves.toBeUndefined();
    expect(d.select).toHaveBeenCalledOnce();
    expect(d.saveToken).not.toHaveBeenCalled();
    expect(d.messages).toContain("Telegram alerts skipped.");
    expect(d.messages).not.toContain("Telegram test sent.");
  });

  it("leaves existing alerts unchanged when setup is declined", async () => {
    const d = telegramSetup();
    d.confirm.mockResolvedValue(false);
    await expect(configureInitTelegram({ chatId: "previous" }, d)).resolves.toEqual({ chatId: "previous" });
    expect(d.ask).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
    expect(d.saveToken).not.toHaveBeenCalled();
  });

  it("labels a deliberately skipped test as untested", async () => {
    const d = telegramSetup();
    d.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(configureInitTelegram(undefined, d)).resolves.toEqual({ chatId: "42" });
    expect(d.send).not.toHaveBeenCalled();
    expect(d.messages).toContain("Telegram saved without a test.");
    expect(d.messages).not.toContain("Telegram test sent.");
  });

  it("does not mistake a local save failure for a Telegram failure", async () => {
    const d = telegramSetup();
    d.saveToken.mockImplementation(() => { throw new Error("keystore unavailable"); });
    await expect(configureInitTelegram(undefined, d)).rejects.toThrow("keystore unavailable");
    expect(d.select).not.toHaveBeenCalled();
    expect(d.messages).not.toContain("Telegram test sent.");
  });
});

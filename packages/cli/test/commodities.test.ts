// packages/cli/test/commodities.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBotConfig, COMMODITY_LEDGER_KEY, type BotConfig } from "@quotient-forecasting/cassie-core";
const h = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), files: new Set<string>(), configText: "{}", creds: vi.fn(), confirm: vi.fn(), control: vi.fn(),
  source: vi.fn(), adapter: vi.fn(), submit: vi.fn(), cancel: vi.fn(), sqliteWrite: vi.fn(), service: vi.fn(), disk: new Map<string, string>(), resolveToken: vi.fn(), discoverToken: vi.fn() }));
const root = "/private/tmp/cassie-commodities-test";
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, existsSync: (p: Parameters<typeof actual.existsSync>[0]) => String(p).startsWith("/private/tmp/cassie-commodities-test") ? h.files.has(String(p)) : actual.existsSync(p),
    readFileSync: (p: Parameters<typeof actual.readFileSync>[0], opts?: Parameters<typeof actual.readFileSync>[1]) => String(p) === "/private/tmp/cassie-commodities-test/config.json" ? h.configText : actual.readFileSync(p, opts) };
});
vi.mock("@quotient-forecasting/cassie-core", async original => ({ ...await original<typeof import("@quotient-forecasting/cassie-core")>(), createAdapter: h.adapter }));
vi.mock("@quotient-forecasting/cassie-runtime-node", async original => ({ ...await original<typeof import("@quotient-forecasting/cassie-runtime-node")>(),
  CommodityDataSource: class { constructor(options: unknown) { h.source(options); } async latest() { return []; } async snapshot() { return { receivedAt: Date.now(), contracts: [], excluded: [] }; } },
  SqliteStateStore: class { async get(key: string) { return h.disk.get(key) ?? null; } async set(...args: unknown[]) { h.sqliteWrite(...args); } async delete(...args: unknown[]) { h.sqliteWrite(...args); } close() {} },
  buildLocalService: h.service }));
vi.mock("../src/context.js", async original => ({ ...await original<typeof import("../src/context.js")>(), buildRuntimeCreds: h.creds, confirm: h.confirm }));
vi.mock("../src/quotient-token.js", async original => ({ ...await original<typeof import("../src/quotient-token.js")>(), discoverQuotientToken: h.discoverToken, resolveQuotientToken: h.resolveToken }));
vi.mock("../src/paths.js", async original => { const actual = await original<typeof import("../src/paths.js")>(); return { ...actual, loadBotConfig: h.load, saveBotConfig: h.save,
  statePath: () => "/private/tmp/cassie-commodities-test/state.sqlite", dirs: { ...actual.dirs, run: () => "/private/tmp/cassie-commodities-test/run" } }; });
vi.mock("../src/commands/swing.js", () => ({ swingControl: h.control }));
import { configureCommodities, scanCommodities, commodityDryRun, commodityResume } from "../src/commands/commodities.js";
import { requireSafeStrategyTransition } from "../src/commands/init.js";
import { startRuntimeAfterPreflights } from "../src/commands/deploy.js";
function bot(strategyId = "kalshi-commodities"): BotConfig { return parseBotConfig({ id: "commodities-test", venue: "kalshi", account: { venue: "kalshi", keyId: "test" }, strategy: { id: strategyId, config: {} } }); }

beforeEach(() => {
  vi.clearAllMocks(); h.files.clear(); h.disk.clear(); h.configText = "{}";
  h.load.mockReturnValue(bot()); h.creds.mockResolvedValue({ venue: "kalshi", keyId: "test", privateKeyB64: "never-signed" });
  h.confirm.mockResolvedValue(true); h.resolveToken.mockResolvedValue({ token: "quotient-test" }); h.discoverToken.mockReturnValue({ token: "quotient-test" });
  h.control.mockResolvedValue({ paused: true, config: {}, report: null });
  h.adapter.mockReturnValue({ id: "kalshi", verifiedAgainst: "2026-09-05", positions: async () => [], openOrders: async () => [],
    balances: async () => [{ asset: "USD", total: 1000, available: 1000 }], fills: async () => [], book: async () => { throw new Error("unused"); },
    quote: async () => { throw new Error("unused"); }, placeOrder: h.submit, cancelOrder: h.cancel, cancelAll: h.cancel });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in CLI test"); }));
});
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("commodity CLI configuration and review", () => {
  it.each(["socket", "lock", "deployed"])("refuses configuration for a running %s bot", type => {
    if (type === "socket") h.files.add(`${root}/run/commodities-test.sock`);
    if (type === "lock") h.files.add(`${root}/state.sqlite.run.lock`);
    if (type === "deployed") h.load.mockReturnValue({ ...bot(), deployment: { provider: "digitalocean", dropletId: 123, host: "203.0.113.1", region: "nyc1", size: "small", user: "root" } });
    expect(() => configureCommodities("commodities-test")).toThrow("stop the local runtime");
    expect(h.save).not.toHaveBeenCalled();
  });

  it("refuses to repurpose existing strategy state", () => {
    h.load.mockReturnValue(bot("signals")); h.files.add(`${root}/state.sqlite`);
    expect(() => configureCommodities("commodities-test")).toThrow("existing strategy state cannot be repurposed");
    expect(h.save).not.toHaveBeenCalled();
  });

  it("configures a new bot with capped risk and supervision settings without starting it", () => {
    h.load.mockReturnValue(bot("signals")); configureCommodities("commodities-test");
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.save.mock.calls[0]![0]).toMatchObject({ strategy: { id: "kalshi-commodities", config: { assets: ["oil"], entryStyle: "marketable", grossCapPct: 10 } },
      tickIntervalMin: 1, risk: { depthCapPct: 2, maxOrderNotional: 100, minDailyVolume: 0 }, execution: { mode: "adaptive", entryDeadlineSec: 20, exitPassiveSec: 20 } });
    expect(h.creds).not.toHaveBeenCalled(); expect(h.control).not.toHaveBeenCalled(); expect(h.service).not.toHaveBeenCalled();
  });

  it.each(["null", "[]", '{"grossCapPct":99}', '{"unreviewed":true}'])("rejects invalid config %s before saving", value => {
    h.configText = value;
    expect(() => configureCommodities("commodities-test", { config: `${root}/config.json` })).toThrow();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("public scan needs Quotient research but never unlocks exchange credentials or creates a service", async () => {
    await scanCommodities({ equity: "1200" });
    expect(h.source).toHaveBeenCalledWith(expect.objectContaining({ token: "quotient-test" }));
    expect(h.adapter).toHaveBeenCalledWith("kalshi", expect.not.objectContaining({ creds: expect.anything() }));
    expect(h.creds).not.toHaveBeenCalled(); expect(h.resolveToken).not.toHaveBeenCalled(); expect(h.service).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled(); expect(h.cancel).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"hypotheticalPortfolio": true'));
  });

  it("local dry-run copies a saved loss latch without mutating disk or invoking order lifecycle", async () => {
    h.files.add(`${root}/state.sqlite`);
    const saved = JSON.stringify({ highWater: 1000, day: new Date().toISOString().slice(0, 10), dayStart: 1000, halted: true, holdings: {} });
    h.disk.set(`strategy:${COMMODITY_LEDGER_KEY}`, saved);
    await commodityDryRun("commodities-test");
    expect(h.creds).toHaveBeenCalledOnce();
    expect(h.disk.get(`strategy:${COMMODITY_LEDGER_KEY}`)).toBe(saved);
    expect(h.sqliteWrite).not.toHaveBeenCalled(); expect(h.service).not.toHaveBeenCalled(); expect(h.submit).not.toHaveBeenCalled(); expect(h.cancel).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"halted": true'));
  });

  it("sends an explicit live authorization only after displaying status and confirmation", async () => {
    await commodityResume("commodities-test");
    expect(h.control.mock.calls.map(c => c[1])).toEqual(["/commodities/status", "/commodities/resume"]);
    expect(h.confirm).toHaveBeenCalledWith(expect.stringContaining("Enable automated live commodity trading"), false);
    expect(h.control.mock.calls[1]!.slice(1)).toEqual(["/commodities/resume", "POST", { confirmed: true, acknowledgeLossReset: false }]);
    h.control.mockClear(); h.confirm.mockResolvedValue(false);
    await commodityResume("commodities-test");
    expect(h.control.mock.calls.map(c => c[1])).toEqual(["/commodities/status"]);
  });

  it("requires a separate confirmation for acknowledged loss resets", async () => {
    h.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await commodityResume("commodities-test", { acknowledgeLossReset: true });
    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(h.control.mock.calls.map(c => c[1])).toEqual(["/commodities/status"]);
  });

  it("keeps a deployed commodity runtime paused and never calls generic resume", async () => {
    const calls: string[] = [];
    const result = await startRuntimeAfterPreflights(bot(), (method, path) => { calls.push(`${method} ${path}`); return { ok: true }; });
    expect(calls).toEqual(["POST /pause", "POST /init"]);
    expect(result.started).toEqual({ ok: true });
  });

  it("protects commodity identity in the init strategy transition", () => {
    expect(() => requireSafeStrategyTransition("signals", "kalshi-commodities")).toThrow("separate bot id");
    expect(() => requireSafeStrategyTransition("kalshi-commodities", "signals")).toThrow("separate bot id");
    expect(() => requireSafeStrategyTransition(undefined, "kalshi-commodities")).not.toThrow();
  });
});

// packages/cli/test/dashboard-sources.test.ts
// Each bot is read from the best source available, and no failure escapes.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBotConfig, type BotConfig } from "@quotient-forecasting/cassie-core";
import type { DashboardRange, DashboardSnapshot, SqliteStateStore } from "@quotient-forecasting/cassie-runtime-node";
import { ControlApiError } from "../src/ssh.js";
import { createDashboardSources, degradedSnapshot, fetchBotEntry, isRouteMissing, mapLimit, socketGet, type SourceDeps } from "../src/dashboard/sources.js";

const NOW = Date.parse("2026-09-09T12:00:00Z");

function snapshot(range: DashboardRange): DashboardSnapshot {
  return { schema: 1, history: { range } } as unknown as DashboardSnapshot;
}

function config(id: string, deployed: boolean): BotConfig {
  return parseBotConfig({
    id, venue: "polymarket", strategy: { id: "flip-flat" },
    ...(deployed ? { deployment: { provider: "digitalocean", dropletId: 1, host: "203.0.113.10", region: "blr1", size: "s-1vcpu-1gb" } } : {}),
  });
}

function storeStub(): Pick<SqliteStateStore, "readEquitySamples" | "readMetricTotals" | "readMetricHourly" | "readErrors" | "close"> & { closed: number } {
  const stub = {
    closed: 0,
    readEquitySamples: () => [{ ts: NOW - 60_000, equity: 10, cash: 5, unrealizedPnl: 0, realizedPnl: 0, positions: 1, resting: 0 }],
    readMetricTotals: () => [],
    readMetricHourly: () => [],
    readErrors: async () => [],
    close: () => { stub.closed += 1; },
  };
  return stub;
}

function deps(over: Partial<SourceDeps> = {}): SourceDeps {
  return {
    loadConfig: (id) => config(id, false),
    control: async () => { throw new Error("no droplet in this test"); },
    socketPath: (id) => `/nonexistent/${id}.sock`,
    socketGet: async () => { throw new Error("no socket"); },
    statePath: (id) => `/nonexistent/${id}.sqlite`,
    openReadonlyStore: () => null,
    now: () => NOW,
    legacy: new Map(),
    ...over,
  };
}

describe("isRouteMissing", () => {
  it("recognises a 404 by status or by the control API's body", () => {
    expect(isRouteMissing(new ControlApiError("control API: x", undefined, 404))).toBe(true);
    expect(isRouteMissing(new ControlApiError("control API: x", { error: "unknown route GET /dashboard" }))).toBe(true);
    expect(isRouteMissing(new ControlApiError("control API: x", { error: "venue down" }, 500))).toBe(false);
    expect(isRouteMissing(new Error("ssh timed out"))).toBe(false);
  });
});

describe("fetchBotEntry", () => {
  it("reads a deployed bot through /dashboard", async () => {
    const calls: string[] = [];
    const entry = await fetchBotEntry("bot-1", "7d", deps({
      loadConfig: (id) => config(id, true),
      control: async (_cfg, path) => { calls.push(path); return snapshot("7d"); },
    }));
    expect(entry).toMatchObject({ id: "bot-1", source: "droplet", host: "203.0.113.10", fetchedAt: new Date(NOW).toISOString(), snapshot: { history: { range: "7d" } } });
    expect(calls).toEqual(["/dashboard?range=7d"]);
  });

  it("falls back to the legacy routes on an old runtime, remembers it, and re-probes after a redeploy", async () => {
    const calls: string[] = [];
    let version = "0.4.12";
    let hasDashboard = false;
    const d = deps({
      loadConfig: (id) => config(id, true),
      control: async (_cfg, path) => {
        calls.push(path);
        if (path.startsWith("/dashboard")) {
          if (hasDashboard) return snapshot("24h");
          throw new ControlApiError("control API: unknown route", { error: "unknown route GET /dashboard" }, 404);
        }
        if (path === "/runtime") return { runtime: "droplet", version, region: "blr1", active: true, paused: false, tickIntervalMin: 1, lastTickAt: NOW - 5000 };
        if (path === "/portfolio") return { botId: "bot-1", venue: "polymarket", balances: [], positions: [], openOrders: [], equity: 42, unrealizedPnl: 0, realizedPnl: 0 };
        if (path === "/orders") return [{ id: "o1" }];
        if (path === "/logs?tail=50") return [{ ts: NOW - 2000, level: "error", code: "a", message: "older" }, { ts: NOW - 1000, level: "warn", code: "b", message: "newer" }];
        throw new Error(`unexpected ${path}`);
      },
    });
    const first = await fetchBotEntry("bot-1", "24h", d);
    expect(first.degraded).toBe(true);
    expect(first.degradedReason).toBe("runtime 0.4.12 predates the dashboard; redeploy to record history and metrics");
    expect(first.snapshot?.portfolio?.equity).toBe(42);
    expect(first.snapshot?.orders).toEqual([{ id: "o1" }]);
    expect(first.snapshot?.errors.map((e) => e.code)).toEqual(["b", "a"]);
    expect(first.snapshot?.bot).toMatchObject({ version: "0.4.12", region: "blr1", active: true, lastTickAt: new Date(NOW - 5000).toISOString() });
    expect(first.snapshot?.history.points).toEqual([]);
    expect(calls.filter((c) => c.startsWith("/dashboard"))).toHaveLength(1);

    await fetchBotEntry("bot-1", "24h", d);
    expect(calls.filter((c) => c.startsWith("/dashboard"))).toHaveLength(1);

    version = "0.5.0";
    hasDashboard = true;
    const third = await fetchBotEntry("bot-1", "24h", d);
    expect(third.degraded).toBeUndefined();
    expect(third.snapshot?.history.range).toBe("24h");
    expect(calls.filter((c) => c.startsWith("/dashboard"))).toHaveLength(2);
  });

  it("keeps a legacy bot readable when one legacy route fails", async () => {
    const entry = await fetchBotEntry("bot-1", "24h", deps({
      loadConfig: (id) => config(id, true),
      control: async (_cfg, path) => {
        if (path.startsWith("/dashboard")) throw new ControlApiError("x", undefined, 404);
        if (path === "/runtime") return { version: "0.4.12" };
        if (path === "/portfolio") throw new Error("venue down");
        return [];
      },
    }));
    expect(entry.degraded).toBe(true);
    expect(entry.snapshot?.portfolio).toBeNull();
    expect(entry.snapshot?.portfolioError).toBe("venue down");
  });

  it("turns a transport failure into an entry error", async () => {
    const entry = await fetchBotEntry("bot-1", "24h", deps({
      loadConfig: (id) => config(id, true),
      control: async () => { throw new Error("ssh root@203.0.113.10: timed out"); },
    }));
    expect(entry).toMatchObject({ id: "bot-1", source: "droplet", error: "ssh root@203.0.113.10: timed out" });
    expect(entry.snapshot).toBeUndefined();
  });

  it("reports a missing config without throwing", async () => {
    const entry = await fetchBotEntry("nope", "24h", deps({ loadConfig: () => { throw new Error("no bot nope"); } }));
    expect(entry).toMatchObject({ id: "nope", source: "offline", error: "no bot nope" });
  });

  it("reads a stopped bot from its SQLite file and closes it", async () => {
    const store = storeStub();
    const entry = await fetchBotEntry("bot-1", "24h", deps({ openReadonlyStore: () => store as unknown as SqliteStateStore }));
    expect(entry).toMatchObject({ id: "bot-1", source: "offline" });
    expect(entry.snapshot?.portfolio).toBeNull();
    expect(entry.snapshot?.history.points).toHaveLength(1);
    expect(store.closed).toBe(1);
    const never = await fetchBotEntry("bot-1", "24h", deps());
    expect(never).toMatchObject({ source: "offline", error: "never run" });
  });

  describe("local socket", () => {
    let dir: string;
    let server: Server;
    let socketPath: string;
    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "cassie-dash-src-"));
      socketPath = join(dir, "bot-1.sock");
      server = createServer((req, res) => {
        const body = req.url === "/health" ? { ok: true } : req.url?.startsWith("/dashboard") ? snapshot("30d") : { error: `unknown route GET ${req.url}` };
        res.writeHead(req.url === "/health" || req.url?.startsWith("/dashboard") ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
      await new Promise<void>((r) => server.listen(socketPath, r));
    });
    afterEach(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    });

    it("reads a running local bot over its socket", async () => {
      const entry = await fetchBotEntry("bot-1", "30d", deps({ socketPath: () => socketPath, socketGet }));
      expect(entry).toMatchObject({ id: "bot-1", source: "local", snapshot: { history: { range: "30d" } } });
    });

    it("treats a stale socket file as not running", async () => {
      await new Promise<void>((r) => server.close(() => r()));
      writeFileSync(socketPath, "");
      server = createServer(() => {});
      const store = storeStub();
      const entry = await fetchBotEntry("bot-1", "24h", deps({ socketPath: () => socketPath, socketGet, openReadonlyStore: () => store as unknown as SqliteStateStore }));
      expect(entry.source).toBe("offline");
      expect(store.closed).toBe(1);
    });
  });
});

describe("degradedSnapshot", () => {
  it("carries halt state from the runtime status", () => {
    const snap = degradedSnapshot({
      cfg: config("bot-1", true), runtime: { marketMake: { halted: true, haltReason: "review", lifecycle: "HALTED" }, tickIntervalMin: 2 },
      portfolio: null, orders: [], errors: [], range: "24h", now: NOW,
    });
    expect(snap.bot).toMatchObject({ halted: true, haltReason: "review", lifecycle: "HALTED", tickIntervalMin: 2, positionCheckSeconds: 120, version: "unknown" });
  });
});

describe("createDashboardSources", () => {
  it("caches per bot and range, dedupes in-flight loads, and refreshes when stale", async () => {
    let t = NOW;
    let fetches = 0;
    let release: (() => void) | undefined;
    const sources = createDashboardSources(["a", "b"], {
      refreshSeconds: 30,
      deps: deps({ now: () => t }),
      fetch: async (id, range) => {
        fetches += 1;
        if (release) await new Promise<void>((r) => { release = r; });
        return { id, source: "offline", snapshot: snapshot(range) };
      },
    });
    expect(await sources.get("zzz", "24h")).toBeUndefined();
    const [x, y] = await Promise.all([sources.get("a", "7d"), sources.get("a", "7d")]);
    expect(x).toBe(y);
    expect(fetches).toBe(1);
    await sources.get("a", "7d");
    expect(fetches).toBe(1);
    t += 31_000;
    await sources.get("a", "7d");
    expect(fetches).toBe(2);
    const list = await sources.list("24h");
    expect(list.map((e) => e.id)).toEqual(["a", "b"]);
    expect(fetches).toBe(4);
    sources.stop();
  });

  it("runs the background cycle for the default range", async () => {
    const seen: string[] = [];
    const sources = createDashboardSources(["a", "b", "c"], {
      refreshSeconds: 30,
      deps: deps(),
      fetch: async (id, range) => { seen.push(`${id}:${range}`); return { id, source: "offline" }; },
    });
    sources.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.sort()).toEqual(["a:24h", "b:24h", "c:24h"]);
    sources.stop();
  });
});

describe("mapLimit", () => {
  it("never runs more than the limit at once and preserves order", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(peak).toBe(3);
  });
});

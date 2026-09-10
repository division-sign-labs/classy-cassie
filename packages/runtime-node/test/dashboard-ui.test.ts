// packages/runtime-node/test/dashboard-ui.test.ts
// The dashboard page's pure helpers, imported straight from the served module.

import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser module without types
import * as ui from "../src/dashboard/ui/app.js";

const MINUS = "−";
const H = 3_600_000;

describe("formatters", () => {
  it("fmtMoney groups, signs, and uses the minus glyph", () => {
    expect(ui.fmtMoney(1234.56)).toBe("$1,234.56");
    expect(ui.fmtMoney(-12.3)).toBe(`${MINUS}$12.30`);
    expect(ui.fmtMoney(3, { sign: true })).toBe("+$3.00");
    expect(ui.fmtMoney(-0.001)).toBe("$0.00");
    expect(ui.fmtMoney(Number.NaN)).toBe("—");
    expect(ui.fmtMoney(undefined)).toBe("—");
  });

  it("fmtPct takes percents", () => {
    expect(ui.fmtPct(2.34)).toBe("+2.3%");
    expect(ui.fmtPct(-4)).toBe(`${MINUS}4.0%`);
    expect(ui.fmtPct(0)).toBe("0.0%");
    expect(ui.fmtPct(2.1, { sign: false })).toBe("2.1%");
    expect(ui.fmtPct(null)).toBe("—");
  });

  it("fmtNum matches render.ts num() rounding", () => {
    const num = (n: number, dp = 4) => String(Math.round(n * 10 ** dp) / 10 ** dp);
    for (const n of [0.123456, 1, 0.5, 12.34567, 100]) expect(ui.fmtNum(n)).toBe(num(n));
    expect(ui.fmtNum(-2)).toBe(`${MINUS}2`);
    expect(ui.fmtNum(undefined)).toBe("—");
  });

  it("fmtAgo matches monitor.ts ago()", () => {
    const now = Date.UTC(2026, 8, 8, 12, 0, 0);
    expect(ui.fmtAgo(undefined)).toBe("never");
    expect(ui.fmtAgo(now - 10_000, now)).toBe("just now");
    expect(ui.fmtAgo(now + 60_000, now)).toBe("just now");
    expect(ui.fmtAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(ui.fmtAgo(now - (2 * H + 15 * 60_000), now)).toBe("2h 15m ago");
    expect(ui.fmtAgo(now - (3 * 24 * H + 4 * H), now)).toBe("3d 4h ago");
    expect(ui.fmtAgo(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m ago");
    expect(ui.fmtAgo("garbage", now)).toBe("unknown");
    expect(ui.fmtDuration(now - (3 * 24 * H + 4 * H), now)).toBe("3d 4h");
  });

  it("shortRef matches render.ts", () => {
    const long = "0x1234567890abcdef1234567890abcdef";
    expect(ui.shortRef(long)).toBe(`${long.slice(0, 10)}…${long.slice(-6)}`);
    expect(ui.shortRef("BTC-PERP")).toBe("BTC-PERP");
  });

  it("fmtMs and fmtInt", () => {
    expect(ui.fmtMs(12.4)).toBe("12 ms");
    expect(ui.fmtMs(1234)).toBe("1.2 s");
    expect(ui.fmtInt(12345)).toBe("12,345");
  });

  it("toMs accepts ms, seconds, and ISO", () => {
    expect(ui.toMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(ui.toMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(ui.toMs("2026-09-08T12:00:00.000Z")).toBe(Date.UTC(2026, 8, 8, 12));
    expect(ui.toMs("nope")).toBeUndefined();
  });
});

describe("math", () => {
  it("niceTicks widens a flat domain and lands on nice numbers", () => {
    const flat = ui.niceTicks(100, 100);
    expect(flat.lo).toBeLessThan(100);
    expect(flat.hi).toBeGreaterThan(100);
    expect(flat.ticks).toContain(100);
    const zero = ui.niceTicks(0, 0);
    expect(zero.ticks).toContain(0);
    const neg = ui.niceTicks(-50, -10);
    expect(neg.ticks.every((t: number) => t < 0)).toBe(true);
    const cross = ui.niceTicks(-10, 30);
    expect(cross.ticks).toContain(0);
    expect(cross.lo).toBeLessThan(-10);
    expect(cross.hi).toBeGreaterThan(30);
    for (const t of cross.ticks) expect(t).toBeGreaterThanOrEqual(cross.lo);
  });

  it("timeTicks picks hourly labels for a day and daily for a week", () => {
    const t0 = Date.UTC(2026, 8, 8, 0, 0, 0);
    const day = ui.timeTicks(t0, t0 + 24 * H, 600);
    expect(day.length).toBeGreaterThanOrEqual(4);
    expect(day.length).toBeLessThanOrEqual(8);
    expect(day[0].label).toMatch(/\d{2}:\d{2}/);
    const week = ui.timeTicks(t0, t0 + 7 * 24 * H, 600);
    expect(week.length).toBeGreaterThanOrEqual(4);
    expect(week[0].label).not.toMatch(/:/);
    const year = ui.timeTicks(t0, t0 + 400 * 24 * H, 600);
    expect(year[0].label).toMatch(/\d{4}$/);
  });

  it("thin keeps the ends", () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({ ts: i, v: i }));
    const out = ui.thin(pts, 50);
    expect(out.length).toBe(50);
    expect(out[0]).toBe(pts[0]);
    expect(out[49]).toBe(pts[999]);
    expect(ui.thin(pts.slice(0, 10), 50)).toHaveLength(10);
  });

  it("nearestIndex", () => {
    expect(ui.nearestIndex([0, 10, 20], 12)).toBe(1);
    expect(ui.nearestIndex([0, 10, 20], 16)).toBe(2);
    expect(ui.nearestIndex([], 1)).toBe(-1);
  });

  it("botStatus truth table", () => {
    const snap = (bot: Record<string, unknown>) => ({ id: "b", source: "droplet", snapshot: { bot } });
    expect(ui.botStatus(undefined)).toBe("unreachable");
    expect(ui.botStatus({ id: "b", source: "offline", snapshot: { bot: { active: true } } })).toBe("offline");
    expect(ui.botStatus({ id: "b", source: "droplet", error: "ssh" })).toBe("unreachable");
    expect(ui.botStatus(snap({ active: true, paused: false, halted: true }))).toBe("halted");
    expect(ui.botStatus(snap({ active: true, paused: true }))).toBe("paused");
    expect(ui.botStatus(snap({ active: true, paused: false }))).toBe("running");
    expect(ui.botStatus(snap({ active: false, paused: false }))).toBe("stopped");
  });

  it("cadenceText", () => {
    expect(ui.cadenceText({ tickIntervalMin: 1, signalCheckMinutes: 5 })).toBe("positions every 60s, signals every 5m");
    expect(ui.cadenceText({ positionCheckSeconds: 30 })).toBe("positions every 30s");
  });

  it("hash round trip", () => {
    const state = { tab: "metrics", selectedId: "poly-1", range: "7d" };
    const hash = ui.buildHash(state);
    expect(hash).toBe("#metrics?bot=poly-1&range=7d");
    expect(ui.parseHash(hash)).toEqual({ tab: "metrics", bot: "poly-1", range: "7d" });
    expect(ui.parseHash("")).toEqual({ tab: undefined, bot: undefined, range: undefined });
    expect(ui.buildHash({})).toBe("#overview");
  });

  it("filterLogs and sortRows", () => {
    const rows = [
      { level: "error", code: "order-ttl", message: "Order expired" },
      { level: "warn", code: "signals", message: "Quotient unreachable" },
      { level: "info", code: "fill", message: "filled" },
    ];
    expect(ui.filterLogs(rows, new Set(["error", "warn"]), "")).toHaveLength(2);
    expect(ui.filterLogs(rows, new Set(["error", "warn", "info"]), "quotient")).toHaveLength(1);
    expect(ui.filterLogs(rows, new Set(["error"]), "TTL")).toHaveLength(1);
    const metrics = [
      { key: "a", calls: 5, errors: 1, avgMs: 30 },
      { key: "b", calls: 9, errors: 0, avgMs: 10 },
      { key: "c", calls: 5, errors: 2, avgMs: undefined },
    ];
    expect(ui.sortRows(metrics, "calls", "desc").map((r: { key: string }) => r.key)).toEqual(["b", "a", "c"]);
    expect(ui.sortRows(metrics, "errors", "asc").map((r: { key: string }) => r.key)).toEqual(["b", "a", "c"]);
    expect(ui.sortRows(metrics, "avgMs", "desc").map((r: { key: string }) => r.key)).toEqual(["a", "b", "c"]);
  });

  it("dailyStats needs two days", () => {
    const d0 = Date.UTC(2026, 8, 1, 12), d1 = Date.UTC(2026, 8, 2, 12), d2 = Date.UTC(2026, 8, 3, 12);
    expect(ui.dailyStats([{ ts: d0, equity: 100 }])).toBeNull();
    const s = ui.dailyStats([{ ts: d0, equity: 100 }, { ts: d1, equity: 110 }, { ts: d2, equity: 104 }]);
    expect(s.best.changeUsd).toBe(10);
    expect(s.worst.changeUsd).toBe(-6);
  });

  it("barPath is a closed rounded-top shape", () => {
    expect(ui.barPath(10, 100, 20, 40)).toMatch(/^M10,100V63Q10,60 13,60H27Q30,60 30,63V100Z$/);
  });
});

describe("botStatus while loading", () => {
  it("reports loading for a pending entry without a snapshot", async () => {
    const { botStatus } = await import("../src/dashboard/ui/app.js");
    expect(botStatus({ id: "a", source: "droplet", pending: true })).toBe("loading");
    expect(botStatus({ id: "a", source: "droplet", pending: true, snapshot: { bot: { active: true } } })).toBe("running");
  });
});

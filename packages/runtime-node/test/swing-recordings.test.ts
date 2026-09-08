// packages/runtime-node/test/swing-recordings.test.ts
import { afterEach, describe, expect, it } from "vitest";
import type { SwingSnapshot } from "@quotient-forecasting/strategy-quotient-swing";
import { SwingRecordingStore, swingResearchHash } from "../src/swing-recordings.js";

const START = Date.parse("2026-09-07T14:00:00Z"), STEP = 5 * 60_000;
let stores: SwingRecordingStore[] = [];
afterEach(() => { for (const store of stores) store.close(); stores = []; });
function store(): SwingRecordingStore { const result = new SwingRecordingStore(":memory:"); stores.push(result); return result; }
function snapshot(at: number): SwingSnapshot {
  return { now: at, nav: 1000, netCashFlow: 0, availableMarginUsd: 1000, coveredAssetKeys: [], markets: [],
    positions: [], openOrders: [], accountObservedAt: at, accountReconciled: true };
}
function recordHours(db: SwingRecordingStore, hash: string, hours: number, opts: { missing?: number; unusable?: number } = {}): number {
  const count = hours * 60 / 5;
  for (let i = 0; i <= count; i++) {
    if (opts.missing !== undefined && i >= opts.missing && i < opts.missing + 3) continue;
    const at = START + i * STEP;
    db.record(snapshot(at), "paper", hash, opts.unusable === undefined || i % opts.unusable !== 0);
  }
  return START + hours * 3_600_000;
}

describe("swing paper recordings and readiness", () => {
  it("keeps full research provenance immutable and scoped to actual receipt time and configuration", () => {
    const db = store();
    const payload = { type: "quotient", rawResponse: { outlooks: [{ id: "po-1", audit: { q_sources: [{ id: "forecast-1", created_at: "2026-09-07T13:00:00Z" }] } }] } };
    db.recordResearch(START, "v1", payload);
    db.recordResearch(START, "v1", { type: "rewritten" });
    db.recordResearch(START + STEP, "v1", { type: "assessment", verdict: "half", evidence: ["https://example.com/filing"] });
    db.recordResearch(START, "v2", { type: "different-config" });
    expect(db.readResearch("v1", START, START)).toEqual([{ receivedAt: START, payload }]);
    expect(db.readResearch("v1", START + 1, START + STEP)).toHaveLength(1);
    expect(db.readResearch("v2", START, START)[0]?.payload).toEqual({ type: "different-config" });
    expect(db.readResearch("missing", START, START + STEP)).toEqual([]);
  });
  it("retains distinct research kinds received at the same instant and keeps the first of each", () => {
    const db = store();
    db.recordResearch(START, "v1", { kind: "quotient", rawResponse: { id: "original" } });
    db.recordResearch(START, "v1", { kind: "markets", markets: [] });
    db.recordResearch(START, "v1", { kind: "quotient", rawResponse: { id: "rewritten" } });
    const records = db.readResearch("v1", START, START);
    expect(records).toHaveLength(2);
    expect(records[0]?.payload).toEqual({ kind: "quotient", rawResponse: { id: "original" } });
    expect(records[1]?.payload).toEqual({ kind: "markets", markets: [] });
  });
  it("preserves original receipt timestamps, order and immutable observation payloads", () => {
    const db = store(); db.record(snapshot(START + STEP), "paper", "v1", true);
    db.record(snapshot(START), "paper", "v1", true);
    db.record({ ...snapshot(START), nav: 9999 }, "paper", "v1", false);
    const records = db.read("v1", "paper", START, START + STEP);
    expect(records.map(r => r.now)).toEqual([START, START + STEP]);
    expect(records[0]?.nav).toBe(1000);
    expect(db.read("v1", "paper", START + 1, START + STEP)).toHaveLength(1);
  });
  it("separates actual execution observations from paper evidence and configuration versions", () => {
    const db = store(); const now = recordHours(db, "v1", 72);
    db.record(snapshot(now), "live", "v2", true);
    expect(db.read("v2", "paper", START, now)).toEqual([]);
    expect(db.read("v2", "live", START, now)).toHaveLength(1);
    expect(db.readiness("v2", now).ready).toBe(false);
    expect(db.readiness("v1", now).ready).toBe(true);
  });
  it("reports paper observation duration without requiring external-market sessions", () => {
    const short = store(), complete = store();
    expect(short.readiness("v1", recordHours(short, "v1", 71)).ready).toBe(false);
    const now = recordHours(complete, "v1", 72);
    expect(complete.readiness("v1", now)).toMatchObject({ ready: true, elapsedHours: 72, reasons: [] });
    expect(complete.readiness("v1", now)).not.toHaveProperty("coveredSessions");
  });
  it("rejects observation gaps, stale record tails and low usable coverage", () => {
    const gap = store(), poor = store(), stale = store();
    const gapNow = recordHours(gap, "v1", 72, { missing: 200 });
    expect(gap.readiness("v1", gapNow)).toMatchObject({ ready: false, maxGapMinutes: 20 });
    const poorNow = recordHours(poor, "v1", 72, { unusable: 10 });
    expect(poor.readiness("v1", poorNow).usableFraction).toBeLessThan(0.95);
    const staleNow = recordHours(stale, "v1", 72);
    expect(stale.readiness("v1", staleNow + 11 * 60_000).ready).toBe(false);
  });
  it("does not use observations received after the requested readiness time", () => {
    const db = store(); const now = recordHours(db, "v1", 72);
    expect(db.readiness("v1", now - HOUR).elapsedHours).toBe(71);
    expect(db.readiness("v1", now - HOUR).ready).toBe(false);
  });
  it("binds readiness to research settings while permitting paper to live promotion", () => {
    const base = { mode: "paper", riskBasePct: 5, maxLeverage: 20 };
    expect(swingResearchHash(base)).toBe(swingResearchHash({ maxLeverage: 20, riskBasePct: 5, mode: "live" }));
    expect(swingResearchHash(base)).not.toBe(swingResearchHash({ ...base, riskBasePct: 6 }));
    expect(swingResearchHash(base)).not.toBe(swingResearchHash({ ...base, maxLeverage: 10 }));
    expect(swingResearchHash({ ...base, nested: { risk: 5 } })).not.toBe(swingResearchHash({ ...base, nested: { risk: 6 } }));
  });
});

const HOUR = 3_600_000;

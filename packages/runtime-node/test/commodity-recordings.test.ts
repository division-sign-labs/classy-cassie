// packages/runtime-node/test/commodity-recordings.test.ts
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommodityConfigSchema, type CommodityReport } from "@quotient-forecasting/cassie-core";
import { CommodityRecordingStore } from "../src/commodity-recordings.js";

const NOW = Date.UTC(2026, 8, 5, 12), DAY = 86_400_000;
let directories: string[] = [], stores: CommodityRecordingStore[] = [];
const config = CommodityConfigSchema.parse({});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cassie-commodity-recordings-")); directories.push(dir);
  const path = join(dir, "state.sqlite.commodities.sqlite"), store = new CommodityRecordingStore(path); stores.push(store);
  return { dir, path, store };
}
function report(at = NOW): CommodityReport {
  return { at, equity: 1000, drawdownPct: 0, halted: false, candidates: [], excluded: [], actions: [],
    observations: { cash: 990, positions: [{ marketRef: "gold-a", side: "YES", size: 20, avgPrice: .5 }],
      books: [{ marketRef: "gold-a", ts: at, bids: [{ price: .49, size: 1000 }], asks: [{ price: .51, size: 1000 }] }] },
    research: { receivedAt: at, contracts: [], excluded: [], outlookDiagnostics: { source: "https://source.example/contract", audit: { forecastIds: ["q-1"], raw: { opaque: "preserve this exactly" } } } } };
}
function count(path: string, table: string): number {
  const read = new Database(path, { readonly: true });
  try { return (read.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n; } finally { read.close(); }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { for (const store of stores) store.close(); for (const dir of directories) rmSync(dir, { recursive: true, force: true }); stores = []; directories = []; vi.useRealTimers(); });

describe("bounded commodity forward recordings", () => {
  it("captures exact decisions, books, positions and public source provenance without changing the engine ledger", () => {
    const { store, dir } = setup(), input = report(), enginePath = join(dir, "state.sqlite");
    writeFileSync(enginePath, "authoritative engine state");
    store.record(input, config);
    const [frame] = store.read();
    expect(frame).toMatchObject({ at: NOW, recordedAt: NOW, config, research: input.research });
    const { research, ...decision } = input;
    expect(frame!.report).toEqual({ ...decision, researchRef: frame!.researchHash });
    expect(frame!.report).not.toHaveProperty("research");
    expect(frame!.researchHash).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(enginePath, "utf8")).toBe("authoritative engine state");
    input.observations!.positions[0]!.size = 999;
    expect(store.read()[0]!.report.observations!.positions[0]!.size).toBe(20);
  });

  it("deduplicates identical research/config cohorts and includes their definition once per export", () => {
    const { store, path } = setup(), first = report(NOW - 1000), second = { ...report(), research: first.research };
    store.record(first, config); store.record(second, config);
    expect(count(path, "commodity_frames")).toBe(2);
    expect(count(path, "commodity_research")).toBe(1);
    expect(count(path, "commodity_cohorts")).toBe(1);
    const frames = store.read();
    expect(frames[0]!.research).toEqual(first.research);
    expect(frames[1]!.research).toBeUndefined(); expect(frames[1]!.config).toBeUndefined();
    expect(frames[1]!.cohortId).toBe(frames[0]!.cohortId);
    // A filtered export remains self-contained even when the first historical frame is absent.
    expect(store.read({ from: NOW })[0]!.research).toEqual(first.research);
  });

  it("splits configuration changes into separate cohorts while sharing identical research", () => {
    const { store, path } = setup(), input = report();
    store.record(input, config);
    store.record(input, CommodityConfigSchema.parse({ ...config, qWeight: .4 }));
    const frames = store.read();
    expect(frames).toHaveLength(2);
    expect(frames[0]!.configHash).not.toBe(frames[1]!.configHash);
    expect(frames[0]!.cohortId).not.toBe(frames[1]!.cohortId);
    expect(frames[0]!.researchHash).toBe(frames[1]!.researchHash);
    expect(count(path, "commodity_research")).toBe(1);
    expect(count(path, "commodity_cohorts")).toBe(2);
  });

  it("uses semantic hashes independent of object property order and never revises an original frame", () => {
    const { store, path } = setup(), input = report();
    store.record(input, config);
    const reordered = Object.fromEntries(Object.entries(input.research).reverse()) as CommodityReport["research"];
    store.record({ ...input, equity: 9999, research: reordered }, Object.fromEntries(Object.entries(config).reverse()) as typeof config);
    expect(store.read()).toHaveLength(1);
    expect(store.read()[0]!.report.equity).toBe(1000);
    expect(count(path, "commodity_research")).toBe(1);
  });

  it("retains revisions to public research as distinct immutable provenance", () => {
    const { store } = setup(), old = report(NOW - 1000), revised = report();
    store.record(old, config);
    revised.research.outlookDiagnostics = { source: "https://source.example/new-feed", forecastId: "q-2" };
    store.record(revised, config);
    const frames = store.read();
    expect(frames[0]!.researchHash).not.toBe(frames[1]!.researchHash);
    expect(frames[0]!.research).toEqual(old.research);
    expect(frames[1]!.research).toEqual(revised.research);
  });

  it("survives reopening and respects inclusive time windows", () => {
    const { store, path } = setup();
    store.record(report(NOW - 2000), config); store.record(report(NOW - 1000), config); store.record(report(), config); store.close();
    const reopened = new CommodityRecordingStore(path); stores.push(reopened);
    expect(reopened.read({ from: NOW - 1000, until: NOW }).map(f => f.at)).toEqual([NOW - 1000, NOW]);
    expect(reopened.read({ limit: 1 })).toHaveLength(1);
    reopened.close(); reopened.close();
  });

  it("prunes data older than 30 days and garbage-collects orphan research and configurations", () => {
    const { store, path } = setup();
    store.record(report(NOW - 29 * DAY), config);
    vi.setSystemTime(NOW + 2 * DAY);
    expect(store.read()).toEqual([]);
    store.record(report(NOW + 2 * DAY), CommodityConfigSchema.parse({ qWeight: .4 }));
    expect(count(path, "commodity_frames")).toBe(1);
    expect(count(path, "commodity_research")).toBe(1);
    expect(count(path, "commodity_cohorts")).toBe(1);
    expect(store.read()[0]!.at).toBe(NOW + 2 * DAY);
  });

  it("keeps at most 50000 frames and exports no more than 10000", () => {
    const { store, path } = setup(); store.record(report(NOW - 60_000), config);
    const seed = new Database(path);
    try {
      seed.exec(`WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<50000)
        INSERT INTO commodity_frames(at,recorded_at,cohort_id,payload)
        SELECT ${NOW}-50000+n.v, ${NOW}, f.cohort_id, f.payload FROM n CROSS JOIN commodity_frames f WHERE f.id=1;`);
    } finally { seed.close(); }
    store.record(report(), config);
    expect(count(path, "commodity_frames")).toBe(50_000);
    expect(store.read({ limit: 10_000 })).toHaveLength(10_000);
    expect(store.read()[0]!.at).toBeGreaterThan(NOW - 60_000);
    expect(() => store.read({ limit: 10_001 })).toThrow("between 1 and 10000");
  });

  it.each([NaN, Infinity, -1, NOW + 1, NOW + .5])("rejects invalid/future report timestamps %s before writes", at => {
    const { store, path } = setup();
    expect(() => store.record(report(at), config)).toThrow();
    expect(count(path, "commodity_frames")).toBe(0); expect(count(path, "commodity_research")).toBe(0);
  });

  it("rejects invalid observation/receipt times, nonfinite values and invalid configurations atomically", () => {
    const { store, path } = setup();
    const futureResearch = report(); futureResearch.research.receivedAt = NOW + 1;
    const futureBook = report(); futureBook.observations!.books[0]!.ts = NOW + 1;
    const invalidValue = report(); invalidValue.equity = NaN;
    for (const value of [futureResearch, futureBook, invalidValue]) expect(() => store.record(value, config)).toThrow();
    expect(() => store.record(report(NOW - 31 * DAY), config)).toThrow("retention");
    expect(() => store.record(report(), { ...config, grossCapPct: 100 })).toThrow();
    expect(count(path, "commodity_frames")).toBe(0); expect(count(path, "commodity_cohorts")).toBe(0); expect(count(path, "commodity_research")).toBe(0);
  });

  it("rejects oversized and non-JSON payloads instead of silently dropping provenance", () => {
    const { store } = setup(), oversized = report();
    oversized.excluded = [{ reason: "x".repeat(8 * 1024 * 1024 + 1) }];
    expect(() => store.record(oversized, config)).toThrow("bounded size");
    const circular = report(); circular.research.outlookDiagnostics = circular;
    expect(() => store.record(circular, config)).toThrow("circular");
    const invalid = report(); invalid.research.outlookDiagnostics = { value: Infinity };
    expect(() => store.record(invalid, config)).toThrow("nonfinite");
    expect(store.read()).toEqual([]);
  });

  it.each([{ from: NaN }, { until: Infinity }, { until: NOW + 1 }, { from: -1 }, { from: NOW, until: NOW - 1 }, { limit: 0 }, { limit: 1.5 }])("rejects invalid/future export bounds %j", options => {
    expect(() => setup().store.read(options)).toThrow();
  });
});

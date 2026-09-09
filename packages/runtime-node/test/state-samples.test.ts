// packages/runtime-node/test/state-samples.test.ts
// Equity and metric samples in the bot's SQLite file, and the read-only opener
// the CLI uses for a stopped bot.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteStateStore } from "../src/state.js";
import { MarketMakeStateStore } from "../src/market-make-state.js";

const HOUR = 3_600_000;

describe("SqliteStateStore samples", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cassie-samples-"));
    path = join(dir, "bot.sqlite");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("stores and reads equity samples in time order with bounds", () => {
    const store = new SqliteStateStore(path);
    for (const [i, equity] of [100, 101, 99, 103].entries()) {
      store.insertEquitySample({ ts: 1_000 + i * 60_000, equity, cash: 50, unrealizedPnl: equity - 100, realizedPnl: 0, positions: 1, resting: 0 });
    }
    // A repeated timestamp replaces the row instead of failing.
    store.insertEquitySample({ ts: 1_000, equity: 100.5, cash: 50, unrealizedPnl: 0.5, realizedPnl: 0, positions: 1, resting: 0 });
    const all = store.readEquitySamples();
    expect(all.map((r) => r.equity)).toEqual([100.5, 101, 99, 103]);
    expect(store.readEquitySamples({ since: 61_000 }).map((r) => r.equity)).toEqual([101, 99, 103]);
    expect(store.readEquitySamples({ since: 61_000, until: 121_000 }).map((r) => r.equity)).toEqual([101, 99]);
    expect(store.readEquitySamples({ limit: 2 })).toHaveLength(2);
    store.close();
  });

  it("aggregates metric samples by key and by hour, including the unflushed hour boundary", () => {
    const store = new SqliteStateStore(path);
    const t0 = 10 * HOUR + 5 * 60_000;
    store.insertMetricSamples(t0, [
      { key: "polymarket.book", calls: 4, errors: 1, totalMs: 400, maxMs: 200 },
      { key: "http.api.test", calls: 1, errors: 0, totalMs: 20, maxMs: 20 },
    ]);
    store.insertMetricSamples(t0 + 10 * 60_000, [{ key: "polymarket.book", calls: 2, errors: 0, totalMs: 100, maxMs: 90 }]);
    store.insertMetricSamples(t0 + HOUR, [{ key: "polymarket.book", calls: 1, errors: 1, totalMs: 500, maxMs: 500 }]);
    store.insertMetricSamples(t0, []); // no-op

    expect(store.readMetricTotals(0)).toEqual([
      { key: "http.api.test", calls: 1, errors: 0, totalMs: 20, maxMs: 20 },
      { key: "polymarket.book", calls: 7, errors: 2, totalMs: 1000, maxMs: 500 },
    ]);
    expect(store.readMetricTotals(t0 + HOUR)).toEqual([{ key: "polymarket.book", calls: 1, errors: 1, totalMs: 500, maxMs: 500 }]);
    expect(store.readMetricHourly(0)).toEqual([
      { hourTs: 10 * HOUR, calls: 7, errors: 1 },
      { hourTs: 11 * HOUR, calls: 1, errors: 1 },
    ]);
    expect(store.readMetricSamples({ since: t0 + HOUR })).toEqual([
      { ts: t0 + HOUR, key: "polymarket.book", calls: 1, errors: 1, totalMs: 500, maxMs: 500 },
    ]);
    store.close();
  });

  it("prunes old rows and reports counts", () => {
    const store = new SqliteStateStore(path);
    store.insertEquitySample({ ts: 1, equity: 1, cash: 1, unrealizedPnl: 0, realizedPnl: 0, positions: 0, resting: 0 });
    store.insertEquitySample({ ts: 100, equity: 1, cash: 1, unrealizedPnl: 0, realizedPnl: 0, positions: 0, resting: 0 });
    store.insertMetricSamples(1, [{ key: "k", calls: 1, errors: 0, totalMs: 1, maxMs: 1 }]);
    expect(store.pruneSamples(50)).toEqual({ equity: 1, metrics: 1 });
    expect(store.readEquitySamples().map((r) => r.ts)).toEqual([100]);
    store.close();
  });

  it("reopens idempotently and coexists with the market-make store on the same file", () => {
    const a = new SqliteStateStore(path);
    a.insertEquitySample({ ts: 5, equity: 2, cash: 2, unrealizedPnl: 0, realizedPnl: 0, positions: 0, resting: 0 });
    const mm = new MarketMakeStateStore(path);
    mm.close();
    const b = new SqliteStateStore(path);
    expect(b.readEquitySamples()).toHaveLength(1);
    a.close();
    b.close();
  });

  it("opens read-only while a writer holds the file, and returns null for a missing file", async () => {
    expect(SqliteStateStore.openReadOnly(join(dir, "missing.sqlite"))).toBeNull();
    const writer = new SqliteStateStore(path);
    writer.insertEquitySample({ ts: 7, equity: 3, cash: 3, unrealizedPnl: 0, realizedPnl: 0, positions: 0, resting: 0 });
    await writer.appendError({ ts: 8, level: "error", code: "x", message: "boom" });
    const reader = SqliteStateStore.openReadOnly(path);
    expect(reader).not.toBeNull();
    expect(reader!.readonly).toBe(true);
    expect(reader!.readEquitySamples().map((r) => r.ts)).toEqual([7]);
    expect((await reader!.readErrors({ tail: 5 })).map((e) => e.code)).toEqual(["x"]);
    await expect(reader!.set("k", "v")).rejects.toThrow(/readonly/i);
    reader!.close();
    writer.close();
  });

  it("reads a file written by an older runtime as empty samples", () => {
    const legacy = new Database(path);
    legacy.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    legacy.close();
    const reader = SqliteStateStore.openReadOnly(path)!;
    expect(reader.readEquitySamples()).toEqual([]);
    expect(reader.readMetricTotals(0)).toEqual([]);
    expect(reader.readMetricHourly(0)).toEqual([]);
    expect(reader.readMetricSamples({ since: 0 })).toEqual([]);
    reader.close();
  });
});

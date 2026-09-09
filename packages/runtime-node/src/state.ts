// packages/runtime-node/src/state.ts
// StateStore on local disk. One SQLite file per bot: ~/.cassie/state/<botId>.sqlite
// when run from a laptop, /var/lib/cassie/<botId>.sqlite on a droplet.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ErrorRecord, LogQuery, MetricDelta, StateStore } from "@quotient-forecasting/cassie-core";

export interface EquitySampleRow {
  ts: number;
  equity: number;
  cash: number;
  unrealizedPnl: number;
  realizedPnl: number;
  positions: number;
  resting: number;
}

export interface MetricSampleRow {
  ts: number;
  key: string;
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

export interface MetricTotalRow {
  key: string;
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

export interface MetricHourRow {
  hourTs: number;
  calls: number;
  errors: number;
}

const SAMPLE_READ_LIMIT = 100_000;

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

/** A database written by an older runtime has no sample tables; read it as empty. */
function tolerateMissing<T>(fn: () => T, empty: T): T {
  try {
    return fn();
  } catch (error) {
    if (isMissingTable(error)) return empty;
    throw error;
  }
}

export class SqliteStateStore implements StateStore {
  private db: Database.Database;
  readonly readonly: boolean;

  constructor(path: string, opts: { readonly?: boolean } = {}) {
    this.readonly = opts.readonly === true;
    if (this.readonly) {
      // No mkdir, no pragma, no DDL: a reader must leave the writer's file alone.
      this.db = new Database(path, { readonly: true, fileMustExist: true });
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL,
        code TEXT NOT NULL,
        venue TEXT,
        message TEXT NOT NULL,
        context TEXT,
        tick_seq INTEGER
      );
      CREATE TABLE IF NOT EXISTS equity_samples (
        ts INTEGER PRIMARY KEY,
        equity REAL NOT NULL,
        cash REAL NOT NULL,
        unrealized_pnl REAL NOT NULL,
        realized_pnl REAL NOT NULL,
        positions INTEGER NOT NULL,
        resting INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metrics_samples (
        ts INTEGER NOT NULL,
        key TEXT NOT NULL,
        calls INTEGER NOT NULL,
        errors INTEGER NOT NULL,
        total_ms REAL NOT NULL,
        max_ms REAL NOT NULL,
        PRIMARY KEY (ts, key)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS metrics_samples_ts ON metrics_samples (ts);
    `);
  }

  /** Open an existing file for reading only; null when there is no file. */
  static openReadOnly(path: string): SqliteStateStore | null {
    try {
      return new SqliteStateStore(path, { readonly: true });
    } catch (error) {
      if ((error as { code?: string }).code === "SQLITE_CANTOPEN") return null;
      throw error;
    }
  }

  async get(key: string): Promise<string | null> {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
  async delete(key: string): Promise<void> {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }
  async appendError(rec: ErrorRecord): Promise<void> {
    this.db
      .prepare("INSERT INTO errors (ts, level, code, venue, message, context, tick_seq) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(rec.ts, rec.level, rec.code, rec.venue ?? null, rec.message, rec.context ? JSON.stringify(rec.context) : null, rec.tickSeq ?? null);
  }
  async readErrors(q?: LogQuery): Promise<ErrorRecord[]> {
    const tail = Math.min(1000, Math.max(1, q?.tail ?? 100));
    const rows = tolerateMissing(
      () => q?.level
        ? this.db.prepare("SELECT * FROM errors WHERE level = ? ORDER BY id DESC LIMIT ?").all(q.level, tail)
        : this.db.prepare("SELECT * FROM errors ORDER BY id DESC LIMIT ?").all(tail),
      [] as unknown[],
    );
    return (rows as Record<string, unknown>[]).reverse().map((r) => ({
      ts: Number(r.ts),
      level: String(r.level) as ErrorRecord["level"],
      code: String(r.code),
      venue: (r.venue as ErrorRecord["venue"]) ?? undefined,
      message: String(r.message),
      context: r.context ? JSON.parse(String(r.context)) : undefined,
      tickSeq: r.tick_seq != null ? Number(r.tick_seq) : undefined,
    }));
  }

  // --- dashboard samples -----------------------------------------------------

  insertEquitySample(row: EquitySampleRow): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO equity_samples (ts, equity, cash, unrealized_pnl, realized_pnl, positions, resting) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(row.ts, row.equity, row.cash, row.unrealizedPnl, row.realizedPnl, row.positions, row.resting);
  }

  insertMetricSamples(ts: number, deltas: MetricDelta[]): void {
    if (deltas.length === 0) return;
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO metrics_samples (ts, key, calls, errors, total_ms, max_ms) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.db.transaction((rows: MetricDelta[]) => {
      for (const d of rows) insert.run(ts, d.key, d.calls, d.errors, d.totalMs, d.maxMs);
    })(deltas);
  }

  readEquitySamples(q: { since?: number; until?: number; limit?: number } = {}): EquitySampleRow[] {
    const limit = Math.min(SAMPLE_READ_LIMIT, Math.max(1, q.limit ?? SAMPLE_READ_LIMIT));
    const rows = tolerateMissing(
      () => this.db
        .prepare("SELECT * FROM equity_samples WHERE ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT ?")
        .all(q.since ?? 0, q.until ?? Number.MAX_SAFE_INTEGER, limit),
      [] as unknown[],
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      ts: Number(r.ts),
      equity: Number(r.equity),
      cash: Number(r.cash),
      unrealizedPnl: Number(r.unrealized_pnl),
      realizedPnl: Number(r.realized_pnl),
      positions: Number(r.positions),
      resting: Number(r.resting),
    }));
  }

  readMetricTotals(since: number): MetricTotalRow[] {
    const rows = tolerateMissing(
      () => this.db
        .prepare(
          "SELECT key, SUM(calls) AS calls, SUM(errors) AS errors, SUM(total_ms) AS total_ms, MAX(max_ms) AS max_ms FROM metrics_samples WHERE ts >= ? GROUP BY key ORDER BY key",
        )
        .all(since),
      [] as unknown[],
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      key: String(r.key),
      calls: Number(r.calls),
      errors: Number(r.errors),
      totalMs: Number(r.total_ms),
      maxMs: Number(r.max_ms),
    }));
  }

  readMetricHourly(since: number): MetricHourRow[] {
    const rows = tolerateMissing(
      () => this.db
        .prepare(
          "SELECT (CAST(ts / 3600000 AS INTEGER) * 3600000) AS hour_ts, SUM(calls) AS calls, SUM(errors) AS errors FROM metrics_samples WHERE ts >= ? GROUP BY hour_ts ORDER BY hour_ts",
        )
        .all(since),
      [] as unknown[],
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      hourTs: Number(r.hour_ts),
      calls: Number(r.calls),
      errors: Number(r.errors),
    }));
  }

  readMetricSamples(q: { since: number; until?: number }): MetricSampleRow[] {
    const rows = tolerateMissing(
      () => this.db
        .prepare("SELECT * FROM metrics_samples WHERE ts >= ? AND ts <= ? ORDER BY ts ASC, key ASC LIMIT ?")
        .all(q.since, q.until ?? Number.MAX_SAFE_INTEGER, SAMPLE_READ_LIMIT),
      [] as unknown[],
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      ts: Number(r.ts),
      key: String(r.key),
      calls: Number(r.calls),
      errors: Number(r.errors),
      totalMs: Number(r.total_ms),
      maxMs: Number(r.max_ms),
    }));
  }

  pruneSamples(olderThanTs: number): { equity: number; metrics: number } {
    const equity = this.db.prepare("DELETE FROM equity_samples WHERE ts < ?").run(olderThanTs).changes;
    const metrics = this.db.prepare("DELETE FROM metrics_samples WHERE ts < ?").run(olderThanTs).changes;
    return { equity, metrics };
  }

  close(): void {
    this.db.close();
  }
}

// packages/runtime-node/src/state.ts
// StateStore on local disk. One SQLite file per bot: ~/.cassie/state/<botId>.sqlite
// when run from a laptop, /var/lib/cassie/<botId>.sqlite on a droplet.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ErrorRecord, LogQuery, StateStore } from "@quotient-forecasting/cassie-core";

export class SqliteStateStore implements StateStore {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
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
    `);
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
    const rows = q?.level
      ? this.db.prepare("SELECT * FROM errors WHERE level = ? ORDER BY id DESC LIMIT ?").all(q.level, tail)
      : this.db.prepare("SELECT * FROM errors ORDER BY id DESC LIMIT ?").all(tail);
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

  close(): void {
    this.db.close();
  }
}

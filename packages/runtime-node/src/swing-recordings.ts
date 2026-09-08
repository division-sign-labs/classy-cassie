// packages/runtime-node/src/swing-recordings.ts
// Immutable receipt-time snapshots, compressed on disk; never backdated as historical availability.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { SwingSnapshot } from "@quotient-forecasting/strategy-quotient-swing";

export function swingResearchHash(config: Record<string, unknown>): string {
  const { mode: _mode, ...research } = config;
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(research))).digest("hex");
}
export interface SwingPaperReadiness {
  ready: boolean; observations: number; elapsedHours: number;
  usableFraction: number; maxGapMinutes: number; configHash: string; reasons: string[];
}
export class SwingRecordingStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS swing_observations (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, mode TEXT NOT NULL, config_hash TEXT NOT NULL,
      usable INTEGER NOT NULL, session_ids TEXT NOT NULL, payload BLOB NOT NULL,
      UNIQUE(at, mode, config_hash));
      CREATE INDEX IF NOT EXISTS swing_observations_config ON swing_observations(config_hash, mode, at);
      CREATE TABLE IF NOT EXISTS swing_research (
        id INTEGER PRIMARY KEY, received_at INTEGER NOT NULL, config_hash TEXT NOT NULL,
        identity TEXT NOT NULL, payload BLOB NOT NULL, UNIQUE(received_at, config_hash, identity));
      CREATE INDEX IF NOT EXISTS swing_research_config ON swing_research(config_hash, received_at);`);
  }
  recordResearch(receivedAt: number, configHash: string, payload: unknown): void {
    if (!Number.isFinite(receivedAt) || receivedAt < 0 || !configHash) throw new Error("research receipt requires a timestamp and configuration hash");
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) throw new Error("research payload must be JSON serializable");
    const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const kind = typeof value.kind === "string" ? value.kind : "research";
    const identity = JSON.stringify([kind]);
    this.db.prepare("INSERT OR IGNORE INTO swing_research(received_at,config_hash,identity,payload) VALUES(?,?,?,?)")
      .run(receivedAt, configHash, identity, gzipSync(serialized));
  }
  readResearch(configHash: string, from = 0, until = Date.now()): Array<{ receivedAt: number; payload: unknown }> {
    const rows = this.db.prepare("SELECT received_at,payload FROM swing_research WHERE config_hash=? AND received_at>=? AND received_at<=? ORDER BY received_at,id LIMIT 100001")
      .all(configHash, from, until) as Array<{ received_at: number; payload: Buffer }>;
    if (rows.length > 100_000) throw new Error("research replay range exceeds 100,000 observations; select a narrower range");
    return rows.map(r => ({ receivedAt: r.received_at, payload: JSON.parse(gunzipSync(r.payload).toString("utf8")) as unknown }));
  }
  record(snapshot: SwingSnapshot, mode: "paper" | "live", configHash: string, usable: boolean): void {
    // Keep the legacy NOT NULL column inert so existing recordings remain readable without a destructive migration.
    this.db.prepare("INSERT OR IGNORE INTO swing_observations(at,mode,config_hash,usable,session_ids,payload) VALUES(?,?,?,?,'[]',?)")
      .run(snapshot.now, mode, configHash, usable ? 1 : 0, gzipSync(JSON.stringify(snapshot)));
  }
  read(configHash: string, mode: "paper" | "live", from = 0, until = Date.now()): SwingSnapshot[] {
    const rows = this.db.prepare("SELECT payload FROM swing_observations WHERE config_hash=? AND mode=? AND at>=? AND at<=? ORDER BY at LIMIT 100001")
      .all(configHash, mode, from, until) as { payload: Buffer }[];
    if (rows.length > 100_000) throw new Error("replay range exceeds 100,000 observations; select a narrower range");
    return rows.map(r => JSON.parse(gunzipSync(r.payload).toString("utf8")) as SwingSnapshot);
  }
  readiness(configHash: string, now = Date.now()): SwingPaperReadiness {
    const rows = this.db.prepare("SELECT at,usable FROM swing_observations WHERE config_hash=? AND mode='paper' AND at>=? AND at<=? ORDER BY at")
      .all(configHash, now - 7 * 86_400_000, now) as { at: number; usable: number }[];
    const elapsedHours = rows.length > 1 ? (rows[rows.length - 1]!.at - rows[0]!.at) / 3_600_000 : 0;
    const maxGapMinutes = rows.length ? Math.max((now - rows[rows.length - 1]!.at) / 60_000, ...rows.slice(1).map((r, i) => (r.at - rows[i]!.at) / 60_000)) : Infinity;
    const usableFraction = rows.length ? rows.filter(r => r.usable).length / rows.length : 0;
    const reasons = [elapsedHours < 72 && "need at least 72 hours of paper observations",
      usableFraction < .95 && "usable data coverage is below 95%", maxGapMinutes > 10 && "paper observation gap exceeds 10 minutes"].filter((s): s is string => Boolean(s));
    return { ready: reasons.length === 0, observations: rows.length, elapsedHours,
      usableFraction, maxGapMinutes, configHash, reasons };
  }
  close(): void { this.db.close(); }
}

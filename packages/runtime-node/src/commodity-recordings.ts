// packages/runtime-node/src/commodity-recordings.ts
// Observational decisions and account marks. Confirmed fills remain in the engine ledger.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { CommodityConfigSchema, type CommodityConfig, type CommodityReport, type CommodityResearchSnapshot } from "@quotient-forecasting/cassie-core";

const RETENTION_MS = 30 * 86_400_000;
const MAX_FRAMES = 50_000;
const MAX_EXPORT = 10_000;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_RESEARCH_BYTES = 32 * 1024 * 1024;
const MAX_CONFIG_BYTES = 128 * 1024;

type RecordedReport = Omit<CommodityReport, "research"> & { researchRef: string };
export interface CommodityRecordingFrame {
  at: number;
  recordedAt: number;
  cohortId: string;
  configHash: string;
  researchHash: string;
  report: RecordedReport;
  /** Included on the first occurrence of each cohort within this read/export. */
  config?: CommodityConfig;
  /** Exact captured public research, included with the first frame of its cohort. */
  research?: CommodityResearchSnapshot;
}
export interface CommodityRecordingReadOptions { from?: number; until?: number; limit?: number }

function timestamp(value: unknown, name: string, until: number): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > until) throw new Error(`commodity recording ${name} must be a nonnegative integer timestamp no later than its observation`);
}
function canonical(value: unknown, seen = new Set<object>()): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("commodity recording contains a nonfinite number");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (!value || typeof value !== "object") throw new Error("commodity recording must contain JSON values");
  if (seen.has(value)) throw new Error("commodity recording contains a circular reference");
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) result = value.map(item => canonical(item, seen));
  else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("commodity recording requires plain JSON objects");
    result = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item, seen)]));
  }
  seen.delete(value);
  return result;
}
function serialized(value: unknown, maximumBytes: number): string {
  const json = JSON.stringify(canonical(value));
  if (Buffer.byteLength(json, "utf8") > maximumBytes) throw new Error("commodity recording payload exceeds its bounded size");
  return json;
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
function decode<T>(payload: Buffer, maximumBytes: number): T {
  return JSON.parse(gunzipSync(payload, { maxOutputLength: maximumBytes }).toString("utf8")) as T;
}

/** Pass the sidecar filename, conventionally `${statePath}.commodities.sqlite`. */
export class CommodityRecordingStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("auto_vacuum = INCREMENTAL");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS commodity_research (
        research_hash TEXT PRIMARY KEY, received_at INTEGER NOT NULL, payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS commodity_cohorts (
        cohort_id TEXT PRIMARY KEY, config_hash TEXT NOT NULL,
        research_hash TEXT NOT NULL REFERENCES commodity_research(research_hash), config BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS commodity_frames (
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
        cohort_id TEXT NOT NULL REFERENCES commodity_cohorts(cohort_id), payload BLOB NOT NULL,
        UNIQUE(at, cohort_id));
      CREATE INDEX IF NOT EXISTS commodity_frames_at ON commodity_frames(at, id);
      CREATE INDEX IF NOT EXISTS commodity_frames_cohort ON commodity_frames(cohort_id);
      CREATE INDEX IF NOT EXISTS commodity_cohorts_research ON commodity_cohorts(research_hash);
    `);
  }

  record(report: CommodityReport, config: CommodityConfig): void {
    const recordedAt = Date.now();
    timestamp(recordedAt, "receipt time", Number.MAX_SAFE_INTEGER);
    timestamp(report.at, "report time", recordedAt);
    if (report.at < recordedAt - RETENTION_MS) throw new Error("commodity recording report lies outside the 30-day retention window");
    if (!report.research || !Array.isArray(report.research.contracts)) throw new Error("commodity recording has no research snapshot");
    timestamp(report.research.receivedAt, "research receipt time", report.at);
    for (const contract of report.research.contracts) timestamp(contract.forecastAt, "forecast time", report.at);
    for (const candidate of report.candidates) timestamp(candidate.contract.forecastAt, "candidate forecast time", report.at);
    // Scheduled open/close times may be in the future; these are observations of
    // schedules, unlike book and research receipt times which cannot be future.
    const observations = (report as CommodityReport & { observations?: { books: Array<{ ts: number }> } }).observations;
    for (const book of observations?.books ?? []) timestamp(book.ts, "book observation time", recordedAt);
    const checkedConfig = CommodityConfigSchema.parse(config);
    const configJson = serialized(checkedConfig, MAX_CONFIG_BYTES), configHash = hash(configJson);
    const researchJson = serialized(report.research, MAX_RESEARCH_BYTES), researchHash = hash(researchJson);
    const cohortId = hash(`${configHash}:${researchHash}`);
    const { research: _research, ...decision } = report;
    const reportJson = serialized({ ...decision, researchRef: researchHash }, MAX_REPORT_BYTES);
    const write = this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO commodity_research(research_hash,received_at,payload) VALUES(?,?,?)")
        .run(researchHash, report.research.receivedAt, gzipSync(researchJson));
      this.db.prepare("INSERT OR IGNORE INTO commodity_cohorts(cohort_id,config_hash,research_hash,config) VALUES(?,?,?,?)")
        .run(cohortId, configHash, researchHash, gzipSync(configJson));
      // A retry cannot revise the original decision at the same time/cohort.
      this.db.prepare("INSERT OR IGNORE INTO commodity_frames(at,recorded_at,cohort_id,payload) VALUES(?,?,?,?)")
        .run(report.at, recordedAt, cohortId, gzipSync(reportJson));
      this.db.prepare("DELETE FROM commodity_frames WHERE at < ?").run(recordedAt - RETENTION_MS);
      const count = (this.db.prepare("SELECT count(*) AS n FROM commodity_frames").get() as { n: number }).n;
      if (count > MAX_FRAMES) this.db.prepare("DELETE FROM commodity_frames WHERE id IN (SELECT id FROM commodity_frames ORDER BY at,id LIMIT ?)").run(count - MAX_FRAMES);
      this.db.exec("DELETE FROM commodity_cohorts WHERE NOT EXISTS (SELECT 1 FROM commodity_frames WHERE commodity_frames.cohort_id=commodity_cohorts.cohort_id);");
      this.db.exec("DELETE FROM commodity_research WHERE NOT EXISTS (SELECT 1 FROM commodity_cohorts WHERE commodity_cohorts.research_hash=commodity_research.research_hash);");
    });
    write();
    // Deleted observations should free disk pages over time, not grow a permanent
    // history of free pages. This affects only the recording sidecar.
    this.db.pragma("incremental_vacuum(32)");
  }

  /** A bounded chronological slice; each export includes its own cohort definitions. */
  read(options: CommodityRecordingReadOptions = {}): CommodityRecordingFrame[] {
    const now = Date.now(), from = options.from ?? 0, until = options.until ?? now, limit = options.limit ?? 1000;
    timestamp(from, "read start", now); timestamp(until, "read end", now);
    if (from > until) throw new Error("commodity recording read start must not exceed its end");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXPORT) throw new Error("commodity recording export limit must be between 1 and 10000");
    const rows = this.db.prepare(`SELECT f.at,f.recorded_at,f.cohort_id,f.payload,c.config_hash,c.research_hash
      FROM commodity_frames f JOIN commodity_cohorts c ON c.cohort_id=f.cohort_id
      WHERE f.at>=? AND f.at<=? ORDER BY f.at,f.id LIMIT ?`)
      .all(Math.max(from, now - RETENTION_MS), until, limit) as Array<{
        at: number; recorded_at: number; cohort_id: string; payload: Buffer; config_hash: string; research_hash: string;
      }>;
    const emitted = new Set<string>();
    return rows.map(row => {
      const frame: CommodityRecordingFrame = { at: row.at, recordedAt: row.recorded_at, cohortId: row.cohort_id,
        configHash: row.config_hash, researchHash: row.research_hash, report: decode<RecordedReport>(row.payload, MAX_REPORT_BYTES) };
      if (!emitted.has(row.cohort_id)) {
        const definition = this.db.prepare(`SELECT c.config,r.payload FROM commodity_cohorts c JOIN commodity_research r ON r.research_hash=c.research_hash WHERE c.cohort_id=?`)
          .get(row.cohort_id) as { config: Buffer; payload: Buffer };
        frame.config = decode<CommodityConfig>(definition.config, MAX_CONFIG_BYTES);
        frame.research = decode<CommodityResearchSnapshot>(definition.payload, MAX_RESEARCH_BYTES);
        emitted.add(row.cohort_id);
      }
      return frame;
    });
  }

  close(): void { if (this.db.open) this.db.close(); }
}

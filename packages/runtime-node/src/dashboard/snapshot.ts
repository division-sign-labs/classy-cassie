// packages/runtime-node/src/dashboard/snapshot.ts
// Builds the DashboardSnapshot a browser renders, from a live BotService or,
// for a stopped bot, from its SQLite file alone.

import type {
  BotConfig,
  BotPortfolio,
  ErrorRecord,
  HyperliquidInfoSchedulerStats,
  LogLevel,
  MetricCounter,
  MetricDelta,
  MetricsRegistry,
} from "@quotient-forecasting/cassie-core";
import type { RuntimeIdentity } from "../service.js";
import type { EquitySampleRow, MetricHourRow, MetricTotalRow, SqliteStateStore } from "../state.js";
import type { EngineCounters } from "./counters.js";
import type { DashboardSamplerStatus } from "./sampler.js";
import {
  DASHBOARD_RANGES,
  type DashboardRange,
  type DashboardSnapshot,
  type EngineMetrics,
  type EquityPoint,
  type HistorySummary,
  type MetricRow,
} from "./types.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const DEFAULT_MAX_POINTS = 600;
export const DEFAULT_ERRORS_TAIL = 50;

const PLACE_KEYS = /\.(placeOrder|placeOrderWithLifecycle|placePerpStop)$/;
const CANCEL_KEYS = /\.(cancelOrder|cancelOrderChecked|cancelAll)$/;

export function parseDashboardRange(raw: string | null | undefined): DashboardRange {
  if (raw === null || raw === undefined || raw === "") return "24h";
  if ((DASHBOARD_RANGES as readonly string[]).includes(raw)) return raw as DashboardRange;
  throw new Error(`range must be one of ${DASHBOARD_RANGES.join(", ")}`);
}

export function rangeSince(range: DashboardRange, now: number): number | undefined {
  switch (range) {
    case "24h": return now - DAY;
    case "7d": return now - 7 * DAY;
    case "30d": return now - 30 * DAY;
    case "all": return undefined;
  }
}

/** Keep the first and last points and the last point of each time bucket. */
export function downsample(points: EquityPoint[], max = DEFAULT_MAX_POINTS): EquityPoint[] {
  if (points.length <= max || max < 3) return points.slice(0, Math.max(0, points.length <= max ? points.length : max));
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const span = last.ts - first.ts;
  if (span <= 0) return [first, last];
  const buckets = max - 2;
  const width = span / buckets;
  const out: EquityPoint[] = [first];
  let current = -1;
  let candidate: EquityPoint | undefined;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const bucket = Math.min(buckets - 1, Math.floor((p.ts - first.ts) / width));
    if (bucket !== current) {
      if (candidate) out.push(candidate);
      current = bucket;
    }
    candidate = p;
  }
  if (candidate) out.push(candidate);
  out.push(last);
  return out;
}

export function summarizeHistory(points: EquityPoint[], sampleMinutes: number): HistorySummary {
  if (points.length === 0) return { highWater: 0, maxDrawdownPct: 0, changeUsd: 0, changePct: 0, sampleMinutes };
  let peak = Number.NEGATIVE_INFINITY;
  let maxDrawdownPct = 0;
  for (const p of points) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - p.equity) / peak) * 100);
  }
  const first = points[0]!.equity;
  const last = points[points.length - 1]!.equity;
  const changeUsd = last - first;
  return {
    highWater: peak,
    maxDrawdownPct,
    changeUsd,
    changePct: first > 0 ? (changeUsd / first) * 100 : 0,
    sampleMinutes,
  };
}

export function historySection(
  samples: EquitySampleRow[],
  range: DashboardRange,
  sampleMinutes: number,
  maxPoints = DEFAULT_MAX_POINTS,
): DashboardSnapshot["history"] {
  const points: EquityPoint[] = samples.map((s) => ({ ...s }));
  return { range, points: downsample(points, maxPoints), summary: summarizeHistory(points, sampleMinutes) };
}

function toRow(key: string, c: { calls: number; errors: number; totalMs: number; maxMs: number; lastError?: string; lastErrorAt?: number }): MetricRow {
  return {
    key,
    calls: c.calls,
    errors: c.errors,
    avgMs: c.calls > 0 ? c.totalMs / c.calls : 0,
    maxMs: c.maxMs,
    ...(c.lastErrorAt !== undefined ? { lastErrorAt: new Date(c.lastErrorAt).toISOString() } : {}),
    ...(c.lastError !== undefined ? { lastError: c.lastError } : {}),
  };
}

export function sinceStartRows(snapshot: Record<string, MetricCounter>): MetricRow[] {
  return Object.keys(snapshot).sort().map((key) => toRow(key, snapshot[key]!));
}

/** Persisted totals plus the registry's unflushed interval, so the last few minutes count. */
export function last24hRows(
  totals: MetricTotalRow[],
  pending: MetricDelta[],
  cumulative: Record<string, MetricCounter>,
  since: number,
): MetricRow[] {
  const merged = new Map<string, { calls: number; errors: number; totalMs: number; maxMs: number }>();
  for (const t of totals) merged.set(t.key, { calls: t.calls, errors: t.errors, totalMs: t.totalMs, maxMs: t.maxMs });
  for (const d of pending) {
    const m = merged.get(d.key) ?? { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
    m.calls += d.calls;
    m.errors += d.errors;
    m.totalMs += d.totalMs;
    m.maxMs = Math.max(m.maxMs, d.maxMs);
    merged.set(d.key, m);
  }
  return [...merged.keys()].sort().map((key) => {
    const m = merged.get(key)!;
    const c = cumulative[key];
    const recentError = c?.lastErrorAt !== undefined && c.lastErrorAt >= since;
    return toRow(key, { ...m, ...(recentError ? { lastError: c!.lastError, lastErrorAt: c!.lastErrorAt } : {}) });
  });
}

export function hourlyBins(rows: MetricHourRow[], pending: MetricDelta[], now: number): Array<{ hourTs: number; calls: number; errors: number }> {
  const bins = new Map<number, { calls: number; errors: number }>();
  for (const r of rows) bins.set(r.hourTs, { calls: r.calls, errors: r.errors });
  const currentHour = Math.floor(now / HOUR) * HOUR;
  const extra = pending.reduce((acc, d) => ({ calls: acc.calls + d.calls, errors: acc.errors + d.errors }), { calls: 0, errors: 0 });
  if (extra.calls > 0) {
    const b = bins.get(currentHour) ?? { calls: 0, errors: 0 };
    bins.set(currentHour, { calls: b.calls + extra.calls, errors: b.errors + extra.errors });
  }
  return [...bins.keys()].sort((a, b) => a - b).map((hourTs) => ({ hourTs, ...bins.get(hourTs)! }));
}

export function engineMetrics(counters: ReturnType<EngineCounters["snapshot"]>, cumulative: Record<string, MetricCounter>): EngineMetrics {
  let ordersPlaced = 0;
  let ordersCanceled = 0;
  for (const [key, c] of Object.entries(cumulative)) {
    const ok = c.calls - c.errors;
    if (PLACE_KEYS.test(key)) ordersPlaced += ok;
    else if (CANCEL_KEYS.test(key)) ordersCanceled += ok;
  }
  return {
    ticks: counters.ticks,
    tickErrors: counters.tickErrors,
    ordersPlaced,
    ordersCanceled,
    ordersSkipped: counters.alertsByKind["skipped-order"] ?? 0,
    alertsSent: counters.alertsSent,
    alertsFailed: counters.alertsFailed,
    alertsByKind: counters.alertsByKind,
  };
}

function haltFrom(source: unknown): { halted?: boolean; haltReason?: string; lifecycle?: string } {
  if (!source || typeof source !== "object") return {};
  const s = source as Record<string, unknown>;
  const out: { halted?: boolean; haltReason?: string; lifecycle?: string } = {};
  if (typeof s.halted === "boolean") out.halted = s.halted;
  const execution = s.execution && typeof s.execution === "object" ? (s.execution as Record<string, unknown>) : undefined;
  const reason = s.haltReason ?? execution?.haltReason;
  if (typeof reason === "string" && reason) out.haltReason = reason;
  if (typeof s.lifecycle === "string") out.lifecycle = s.lifecycle;
  return out;
}

function iso(ts: number | undefined): string | undefined {
  return ts === undefined ? undefined : new Date(ts).toISOString();
}

/** What the builder needs from a BotService. The service satisfies it structurally; tests pass a fake. */
export interface DashboardServiceView {
  config: BotConfig;
  identity: RuntimeIdentity;
  startedAt: number;
  status(): { active: boolean; lastTickAt?: number; tickIntervalMin: number; marketMake?: unknown };
  paused(): Promise<boolean>;
  portfolio(): Promise<BotPortfolio>;
  logs(level?: LogLevel, tail?: number): Promise<ErrorRecord[]>;
  swingStatus?(): Promise<unknown>;
  signalCheckMinutes(): number | undefined;
  metrics: Pick<MetricsRegistry, "snapshot" | "peekInterval" | "startedAt">;
  counters: Pick<EngineCounters, "snapshot">;
  samplerStatus(): DashboardSamplerStatus;
  equitySamples(q: { since?: number }): EquitySampleRow[];
  metricTotals(since: number): MetricTotalRow[];
  metricHourly(since: number): MetricHourRow[];
  hyperliquidSchedulerStats(): HyperliquidInfoSchedulerStats | undefined;
}

export interface BuildSnapshotOptions {
  range: DashboardRange;
  now?: () => number;
  maxPoints?: number;
  errorsTail?: number;
}

export async function buildDashboardSnapshot(view: DashboardServiceView, opts: BuildSnapshotOptions): Promise<DashboardSnapshot> {
  const now = (opts.now ?? Date.now)();
  const status = view.status();
  const paused = await view.paused().catch(() => false);
  let halt = haltFrom(status.marketMake);
  if (view.config.strategy.id === "quotient-swing" && view.swingStatus) {
    try {
      halt = { ...haltFrom(await view.swingStatus()), ...halt };
    } catch {
      /* the swing status is decoration here; the snapshot still stands */
    }
  }

  let portfolio: BotPortfolio | null = null;
  let portfolioError: string | undefined;
  try {
    portfolio = await view.portfolio();
  } catch (error) {
    portfolioError = (error as Error).message;
  }

  const sampler = view.samplerStatus();
  const since = rangeSince(opts.range, now);
  const history = historySection(view.equitySamples(since === undefined ? {} : { since }), opts.range, sampler.intervalMinutes, opts.maxPoints);

  const cumulative = view.metrics.snapshot();
  const pending = view.metrics.peekInterval();
  const dayAgo = now - DAY;

  const errors = (await view.logs(undefined, opts.errorsTail ?? DEFAULT_ERRORS_TAIL)).slice().reverse();
  const signalCheckMinutes = view.signalCheckMinutes();
  const hl = view.hyperliquidSchedulerStats();

  return {
    schema: 1,
    generatedAt: new Date(now).toISOString(),
    bot: {
      id: view.config.id,
      venue: view.config.venue,
      strategy: view.config.strategy.id,
      runtime: view.identity.runtime,
      version: view.identity.version,
      ...(view.identity.buildId ? { buildId: view.identity.buildId } : {}),
      ...(view.identity.region ? { region: view.identity.region } : {}),
      ...(view.identity.deploymentId ? { deploymentId: view.identity.deploymentId } : {}),
      startedAt: new Date(view.startedAt).toISOString(),
      active: status.active,
      paused,
      ...halt,
      ...(status.lastTickAt !== undefined ? { lastTickAt: iso(status.lastTickAt) } : {}),
      tickIntervalMin: status.tickIntervalMin,
      ...(signalCheckMinutes !== undefined ? { signalCheckMinutes } : {}),
      positionCheckSeconds: status.tickIntervalMin * 60,
    },
    portfolio,
    ...(portfolioError !== undefined ? { portfolioError } : {}),
    orders: portfolio?.openOrders ?? [],
    history,
    metrics: {
      sinceStart: { startedAt: new Date(view.metrics.startedAt).toISOString(), rows: sinceStartRows(cumulative) },
      last24h: {
        rows: last24hRows(view.metricTotals(dayAgo), pending, cumulative, dayAgo),
        hourly: hourlyBins(view.metricHourly(dayAgo), pending, now),
      },
      engine: engineMetrics(view.counters.snapshot(), cumulative),
      ...(hl ? { hyperliquidScheduler: hl } : {}),
      sampler: { ...(sampler.lastSampleAt !== undefined ? { lastSampleAt: iso(sampler.lastSampleAt) } : {}), errors: sampler.errors },
    },
    errors,
  };
}

/** Shares one in-flight build per range so several viewers cost one venue read. */
export class DashboardSnapshotCache {
  private readonly entries = new Map<DashboardRange, { at: number; promise: Promise<DashboardSnapshot> }>();

  constructor(
    private readonly build: (range: DashboardRange) => Promise<DashboardSnapshot>,
    private readonly ttlMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(range: DashboardRange): Promise<DashboardSnapshot> {
    const at = this.now();
    const hit = this.entries.get(range);
    if (hit && at - hit.at < this.ttlMs) return hit.promise;
    const promise = this.build(range);
    this.entries.set(range, { at, promise });
    promise.catch(() => {
      if (this.entries.get(range)?.promise === promise) this.entries.delete(range);
    });
    return promise;
  }
}

export interface OfflineSnapshotInput {
  config: BotConfig;
  store: Pick<SqliteStateStore, "readEquitySamples" | "readMetricTotals" | "readMetricHourly" | "readErrors">;
  range: DashboardRange;
  now?: () => number;
  version?: string;
  maxPoints?: number;
  errorsTail?: number;
}

function inferSampleMinutes(samples: EquitySampleRow[]): number {
  if (samples.length < 2) return 5;
  const a = samples[samples.length - 2]!.ts;
  const b = samples[samples.length - 1]!.ts;
  return Math.max(1, Math.round((b - a) / 60_000));
}

/** A stopped bot: history, persisted metrics, and errors from its SQLite file; no portfolio. */
export async function offlineDashboardSnapshot(input: OfflineSnapshotInput): Promise<DashboardSnapshot> {
  const now = (input.now ?? Date.now)();
  const since = rangeSince(input.range, now);
  const samples = input.store.readEquitySamples(since === undefined ? {} : { since });
  const dayAgo = now - DAY;
  const errors = (await input.store.readErrors({ tail: input.errorsTail ?? DEFAULT_ERRORS_TAIL })).slice().reverse();
  const generatedAt = new Date(now).toISOString();
  return {
    schema: 1,
    generatedAt,
    bot: {
      id: input.config.id,
      venue: input.config.venue,
      strategy: input.config.strategy.id,
      runtime: "local",
      version: input.version ?? "unknown",
      startedAt: generatedAt,
      active: false,
      paused: false,
      tickIntervalMin: input.config.tickIntervalMin,
      positionCheckSeconds: input.config.tickIntervalMin * 60,
    },
    portfolio: null,
    orders: [],
    history: historySection(samples, input.range, inferSampleMinutes(samples), input.maxPoints),
    metrics: {
      sinceStart: { startedAt: generatedAt, rows: [] },
      last24h: { rows: last24hRows(input.store.readMetricTotals(dayAgo), [], {}, dayAgo), hourly: hourlyBins(input.store.readMetricHourly(dayAgo), [], now) },
      engine: { ticks: 0, tickErrors: 0, ordersPlaced: 0, ordersCanceled: 0, ordersSkipped: 0, alertsSent: 0, alertsFailed: 0, alertsByKind: {} },
      sampler: { errors: 0 },
    },
    errors,
  };
}

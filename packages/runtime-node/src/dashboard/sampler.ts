// packages/runtime-node/src/dashboard/sampler.ts
// Records an equity sample and flushes metric deltas on a fixed cadence so the
// dashboard can chart how a bot has gone. Never throws into the trading loop.

import type { BotPortfolio, Logger, MetricsRegistry } from "@quotient-forecasting/cassie-core";
import type { EquitySampleRow, SqliteStateStore } from "../state.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WARN_REPEAT_MS = 30 * MINUTE;

export interface DashboardSamplerDeps {
  store: Pick<SqliteStateStore, "insertEquitySample" | "insertMetricSamples" | "pruneSamples">;
  metrics: Pick<MetricsRegistry, "takeInterval">;
  /** BotService.portfolio, which already serialises against ticks. */
  portfolio: () => Promise<BotPortfolio>;
  log: Logger;
  intervalMs?: number;
  /** One warm-up interval before the first venue read. */
  initialDelayMs?: number;
  retentionMs?: number;
  pruneEveryMs?: number;
  now?: () => number;
}

export interface DashboardSamplerStatus {
  lastSampleAt?: number;
  lastError?: string;
  errors: number;
  intervalMinutes: number;
}

export function dashboardSampleMinutesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CASSIE_DASHBOARD_SAMPLE_MINUTES;
  if (raw === undefined || raw === "") return 5;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error("CASSIE_DASHBOARD_SAMPLE_MINUTES must be a number of minutes from 1 to 1440");
  }
  return minutes;
}

const PERP_VENUES = new Set(["hyperliquid", "lighter"]);

/**
 * Perps: equity is the venue's account value (already marked); cash is what
 * could be withdrawn. Prediction markets: cash is collateral not in positions;
 * equity adds marked positions.
 */
export function equitySampleFromPortfolio(p: BotPortfolio, ts: number): EquitySampleRow {
  const perp = PERP_VENUES.has(p.venue);
  const cash = p.balances.reduce((sum, b) => sum + (perp ? b.available : b.total), 0);
  return {
    ts,
    equity: p.equity,
    cash,
    unrealizedPnl: p.unrealizedPnl,
    realizedPnl: p.realizedPnl,
    positions: p.positions.length,
    resting: p.openOrders.length,
  };
}

export class DashboardSampler {
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly retentionMs: number;
  private readonly pruneEveryMs: number;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private started = false;
  private inflight?: Promise<void>;
  private lastSampleAt?: number;
  private lastError?: string;
  private errorCount = 0;
  private lastPruneAt?: number;
  private lastWarn?: { message: string; at: number };

  constructor(private readonly deps: DashboardSamplerDeps) {
    this.intervalMs = deps.intervalMs ?? 5 * MINUTE;
    this.initialDelayMs = deps.initialDelayMs ?? MINUTE;
    this.retentionMs = deps.retentionMs ?? 180 * DAY;
    this.pruneEveryMs = deps.pruneEveryMs ?? DAY;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(this.initialDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  status(): DashboardSamplerStatus {
    return {
      lastSampleAt: this.lastSampleAt,
      lastError: this.lastError,
      errors: this.errorCount,
      intervalMinutes: this.intervalMs / MINUTE,
    };
  }

  /** Take one sample now. Concurrent callers share the same run. */
  sampleOnce(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.run().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.sampleOnce().finally(() => this.schedule(this.intervalMs));
    }, delayMs);
    this.timer.unref();
  }

  private async run(): Promise<void> {
    const ts = this.now();
    let portfolio: BotPortfolio | undefined;
    try {
      portfolio = await this.deps.portfolio();
    } catch (error) {
      this.fail(`equity sample skipped: ${(error as Error).message}`);
    }
    if (this.stopped) return;
    if (portfolio) {
      try {
        this.deps.store.insertEquitySample(equitySampleFromPortfolio(portfolio, ts));
        this.lastSampleAt = ts;
      } catch (error) {
        this.fail(`equity sample not written: ${(error as Error).message}`);
      }
    }
    try {
      const deltas = this.deps.metrics.takeInterval();
      if (!this.stopped) this.deps.store.insertMetricSamples(ts, deltas);
    } catch (error) {
      this.fail(`metric samples not written: ${(error as Error).message}`);
    }
    if (!this.stopped && (this.lastPruneAt === undefined || ts - this.lastPruneAt >= this.pruneEveryMs)) {
      try {
        this.deps.store.pruneSamples(ts - this.retentionMs);
        this.lastPruneAt = ts;
      } catch (error) {
        this.fail(`sample retention not applied: ${(error as Error).message}`);
      }
    }
  }

  private fail(message: string): void {
    this.errorCount += 1;
    this.lastError = message;
    const at = this.now();
    if (!this.lastWarn || this.lastWarn.message !== message || at - this.lastWarn.at >= WARN_REPEAT_MS) {
      this.deps.log.warn(`dashboard: ${message}`);
      this.lastWarn = { message, at };
    }
  }
}

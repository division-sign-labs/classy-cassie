// packages/runtime-node/src/dashboard/types.ts
// The JSON contract shared by the control socket's /dashboard route, the hosted
// dashboard on a droplet, and the CLI's local dashboard. Anything the browser
// renders comes from these shapes.

import type {
  BotPortfolio,
  ErrorRecord,
  HyperliquidInfoSchedulerStats,
  Order,
  VenueId,
} from "@quotient-forecasting/cassie-core";

export type DashboardRange = "24h" | "7d" | "30d" | "all";

export const DASHBOARD_RANGES: readonly DashboardRange[] = ["24h", "7d", "30d", "all"];

export interface EquityPoint {
  /** Epoch ms. */
  ts: number;
  equity: number;
  cash: number;
  unrealizedPnl: number;
  realizedPnl: number;
  positions: number;
  resting: number;
}

export interface MetricRow {
  /** `polymarket.placeOrder`, `http.api.quotient.social`, … */
  key: string;
  calls: number;
  errors: number;
  avgMs: number;
  maxMs: number;
  lastErrorAt?: string;
  lastError?: string;
}

export interface HistorySummary {
  highWater: number;
  /** Percent, so 2.5 means 2.5%. */
  maxDrawdownPct: number;
  changeUsd: number;
  /** Percent, so 2.5 means 2.5%. */
  changePct: number;
  sampleMinutes: number;
}

export interface EngineMetrics {
  ticks: number;
  tickErrors: number;
  ordersPlaced: number;
  ordersCanceled: number;
  ordersSkipped: number;
  alertsSent: number;
  alertsFailed: number;
  alertsByKind: Record<string, number>;
}

export interface DashboardSnapshot {
  schema: 1;
  /** ISO. */
  generatedAt: string;
  bot: {
    id: string;
    venue: VenueId;
    strategy: string;
    runtime: "droplet" | "local";
    version: string;
    buildId?: string;
    region?: string;
    deploymentId?: string;
    /** ISO; process start. */
    startedAt: string;
    active: boolean;
    paused: boolean;
    halted?: boolean;
    haltReason?: string;
    lifecycle?: string;
    /** ISO. */
    lastTickAt?: string;
    tickIntervalMin: number;
    signalCheckMinutes?: number;
    positionCheckSeconds?: number;
  };
  /** Null when the venue read failed; see portfolioError. */
  portfolio: BotPortfolio | null;
  portfolioError?: string;
  orders: Order[];
  history: {
    range: DashboardRange;
    /** At most 600 points, downsampled by time bucket. */
    points: EquityPoint[];
    summary: HistorySummary;
  };
  metrics: {
    sinceStart: { startedAt: string; rows: MetricRow[] };
    last24h: { rows: MetricRow[]; hourly: Array<{ hourTs: number; calls: number; errors: number }> };
    engine: EngineMetrics;
    hyperliquidScheduler?: HyperliquidInfoSchedulerStats;
    sampler: { lastSampleAt?: string; errors: number };
  };
  /** Newest first, at most 50. */
  errors: ErrorRecord[];
}

export interface DashboardBotEntry {
  id: string;
  source: "droplet" | "local" | "offline";
  host?: string;
  /** ISO. */
  fetchedAt?: string;
  error?: string;
  degraded?: boolean;
  degradedReason?: string;
  /** The source has not answered yet; poll again shortly. */
  pending?: boolean;
  snapshot?: DashboardSnapshot;
}

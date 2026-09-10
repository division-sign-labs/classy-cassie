// packages/cli/src/dashboard/sources.ts
// Where the local dashboard reads each bot from: a droplet over SSH, a bot
// running in another terminal over its unix socket, or a stopped bot's SQLite
// file. Every path returns an entry; nothing here throws into the server.

import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { BotConfig, BotPortfolio, ErrorRecord, Order } from "@quotient-forecasting/cassie-core";
import {
  SqliteStateStore,
  offlineDashboardSnapshot,
  type DashboardBotEntry,
  type DashboardBotSource,
  type DashboardRange,
  type DashboardSnapshot,
} from "@quotient-forecasting/cassie-runtime-node";
import { targetFor } from "../context.js";
import { dirs, loadBotConfig, statePath } from "../paths.js";
import { ControlApiError, controlCallAsync } from "../ssh.js";

export interface SourceDeps {
  loadConfig: (id: string) => BotConfig;
  control: (cfg: BotConfig, path: string) => Promise<unknown>;
  socketPath: (id: string) => string;
  socketGet: (socketPath: string, path: string, timeoutMs: number) => Promise<{ status: number; json: unknown }>;
  statePath: (id: string) => string;
  openReadonlyStore: (path: string) => SqliteStateStore | null;
  now: () => number;
  /** Bot id → runtime version known to predate /dashboard; skips the probe until the version changes. */
  legacy: Map<string, string>;
}

export function socketGet(socketPath: string, path: string, timeoutMs: number): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: "GET", timeout: timeoutMs }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => {
        let json: unknown = text;
        try {
          json = JSON.parse(text);
        } catch {
          /* leave the text */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)));
    req.on("error", reject);
    req.end();
  });
}

export const defaultSourceDeps: SourceDeps = {
  loadConfig: loadBotConfig,
  // A portfolio read prices every position; give a busy bot time to answer.
  control: (cfg, path) => controlCallAsync(targetFor(cfg), cfg.id, "GET", path, undefined, { timeoutMs: 90_000 }),
  socketPath: (id) => join(dirs.run(), `${id}.sock`),
  socketGet,
  statePath,
  openReadonlyStore: (path) => SqliteStateStore.openReadOnly(path),
  now: Date.now,
  legacy: new Map(),
};

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/** A runtime that predates the route answers 404 with the control API's "unknown route" body. */
export function isRouteMissing(error: unknown): boolean {
  if (!(error instanceof ControlApiError)) return false;
  if (error.status === 404) return true;
  const body = error.body as { error?: unknown } | undefined;
  return typeof body?.error === "string" && /^unknown route /.test(body.error);
}

function haltFrom(source: unknown): { halted?: boolean; haltReason?: string; lifecycle?: string } {
  if (!source || typeof source !== "object") return {};
  const s = source as Record<string, unknown>;
  const out: { halted?: boolean; haltReason?: string; lifecycle?: string } = {};
  if (typeof s.halted === "boolean") out.halted = s.halted;
  if (typeof s.haltReason === "string" && s.haltReason) out.haltReason = s.haltReason;
  if (typeof s.lifecycle === "string") out.lifecycle = s.lifecycle;
  return out;
}

export interface DegradedInput {
  cfg: BotConfig;
  runtime: Record<string, unknown>;
  portfolio: BotPortfolio | null;
  portfolioError?: string;
  orders: Order[];
  errors: ErrorRecord[];
  range: DashboardRange;
  now: number;
}

/** Current state only, from the routes every runtime has; no history, no metrics. */
export function degradedSnapshot(input: DegradedInput): DashboardSnapshot {
  const r = input.runtime;
  const generatedAt = new Date(input.now).toISOString();
  const tickIntervalMin = typeof r.tickIntervalMin === "number" ? r.tickIntervalMin : input.cfg.tickIntervalMin;
  return {
    schema: 1,
    generatedAt,
    bot: {
      id: input.cfg.id,
      venue: input.cfg.venue,
      strategy: input.cfg.strategy.id,
      runtime: r.runtime === "local" ? "local" : "droplet",
      version: typeof r.version === "string" ? r.version : "unknown",
      ...(typeof r.buildId === "string" ? { buildId: r.buildId } : {}),
      ...(typeof r.region === "string" ? { region: r.region } : {}),
      ...(typeof r.deploymentId === "string" ? { deploymentId: r.deploymentId } : {}),
      startedAt: generatedAt,
      active: r.active === true,
      paused: r.paused === true,
      ...haltFrom(r.marketMake),
      ...(typeof r.lastTickAt === "number" ? { lastTickAt: new Date(r.lastTickAt).toISOString() } : {}),
      tickIntervalMin,
      positionCheckSeconds: tickIntervalMin * 60,
    },
    portfolio: input.portfolio,
    ...(input.portfolioError ? { portfolioError: input.portfolioError } : {}),
    orders: input.orders,
    history: { range: input.range, points: [], summary: { highWater: 0, maxDrawdownPct: 0, changeUsd: 0, changePct: 0, sampleMinutes: 0 } },
    metrics: {
      sinceStart: { startedAt: generatedAt, rows: [] },
      last24h: { rows: [], hourly: [] },
      engine: { ticks: 0, tickErrors: 0, ordersPlaced: 0, ordersCanceled: 0, ordersSkipped: 0, alertsSent: 0, alertsFailed: 0, alertsByKind: {} },
      sampler: { errors: 0 },
    },
    errors: input.errors.slice().reverse(),
  };
}

async function deployedEntry(cfg: BotConfig, range: DashboardRange, deps: SourceDeps, fetchedAt: string): Promise<DashboardBotEntry> {
  const base = { id: cfg.id, source: "droplet" as const, host: cfg.deployment!.host, fetchedAt };
  const known = deps.legacy.get(cfg.id);
  if (known === undefined) {
    try {
      return { ...base, snapshot: (await deps.control(cfg, `/dashboard?range=${range}`)) as DashboardSnapshot };
    } catch (error) {
      if (!isRouteMissing(error)) return { ...base, error: message(error) };
    }
  }
  try {
    const runtime = (await deps.control(cfg, "/runtime")) as Record<string, unknown>;
    const version = typeof runtime.version === "string" ? runtime.version : "unknown";
    if (known !== undefined && version !== known) {
      // A redeploy moved the runtime; probe the real route again.
      deps.legacy.delete(cfg.id);
      return deployedEntry(cfg, range, deps, fetchedAt);
    }
    deps.legacy.set(cfg.id, version);
    const [portfolio, orders, errors] = await Promise.allSettled([
      deps.control(cfg, "/portfolio") as Promise<BotPortfolio>,
      deps.control(cfg, "/orders") as Promise<Order[]>,
      deps.control(cfg, "/logs?tail=50") as Promise<ErrorRecord[]>,
    ]);
    return {
      ...base,
      degraded: true,
      degradedReason: `runtime ${version} predates the dashboard; redeploy to record history and metrics`,
      snapshot: degradedSnapshot({
        cfg,
        runtime,
        portfolio: portfolio.status === "fulfilled" ? portfolio.value : null,
        ...(portfolio.status === "rejected" ? { portfolioError: message(portfolio.reason) } : {}),
        orders: orders.status === "fulfilled" && Array.isArray(orders.value) ? orders.value : [],
        errors: errors.status === "fulfilled" && Array.isArray(errors.value) ? errors.value : [],
        range,
        now: deps.now(),
      }),
    };
  } catch (error) {
    return { ...base, error: message(error) };
  }
}

async function offlineEntry(cfg: BotConfig, range: DashboardRange, deps: SourceDeps, fetchedAt: string, extra: Partial<DashboardBotEntry> = {}): Promise<DashboardBotEntry> {
  const store = deps.openReadonlyStore(deps.statePath(cfg.id));
  if (!store) return { id: cfg.id, source: "offline", fetchedAt, error: "never run", ...extra };
  try {
    return { id: cfg.id, source: "offline", fetchedAt, snapshot: await offlineDashboardSnapshot({ config: cfg, store, range, now: deps.now }), ...extra };
  } catch (error) {
    return { id: cfg.id, source: "offline", fetchedAt, error: message(error), ...extra };
  } finally {
    store.close();
  }
}

async function localEntry(cfg: BotConfig, socketPath: string, range: DashboardRange, deps: SourceDeps, fetchedAt: string): Promise<DashboardBotEntry | undefined> {
  try {
    if ((await deps.socketGet(socketPath, "/health", 2_000)).status !== 200) return undefined;
  } catch {
    return undefined; // a stale socket file from a crashed run
  }
  try {
    const res = await deps.socketGet(socketPath, `/dashboard?range=${range}`, 15_000);
    if (res.status === 404) {
      return offlineEntry(cfg, range, deps, fetchedAt, { source: "local", degraded: true, degradedReason: "this local runtime predates the dashboard; restart it with the current cassie" });
    }
    if (res.status !== 200) return { id: cfg.id, source: "local", fetchedAt, error: `control API ${res.status}` };
    return { id: cfg.id, source: "local", fetchedAt, snapshot: res.json as DashboardSnapshot };
  } catch (error) {
    return { id: cfg.id, source: "local", fetchedAt, error: message(error) };
  }
}

/** Never throws; every failure becomes an entry with `error`. */
export async function fetchBotEntry(id: string, range: DashboardRange, deps: SourceDeps = defaultSourceDeps): Promise<DashboardBotEntry> {
  const fetchedAt = new Date(deps.now()).toISOString();
  let cfg: BotConfig;
  try {
    cfg = deps.loadConfig(id);
  } catch (error) {
    return { id, source: "offline", fetchedAt, error: message(error) };
  }
  if (cfg.deployment) return deployedEntry(cfg, range, deps, fetchedAt);
  const socket = deps.socketPath(cfg.id);
  if (existsSync(socket)) {
    const local = await localEntry(cfg, socket, range, deps, fetchedAt);
    if (local) return local;
  }
  return offlineEntry(cfg, range, deps, fetchedAt);
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface DashboardSources extends DashboardBotSource {
  readonly refreshSeconds: number;
  start(): void;
  stop(): void;
}

/** What a bot looks like before its source has answered. */
export function pendingEntry(id: string, deps: SourceDeps): DashboardBotEntry {
  try {
    const cfg = deps.loadConfig(id);
    if (cfg.deployment) return { id, source: "droplet", host: cfg.deployment.host, pending: true };
    return { id, source: existsSync(deps.socketPath(cfg.id)) ? "local" : "offline", pending: true };
  } catch {
    return { id, source: "offline", pending: true };
  }
}

/**
 * Cached per bot and range; the loop keeps the default range fresh in the
 * background. `list` answers at once with whatever is cached and starts loads
 * for the rest, so the page shows every bot before the first SSH round trip
 * completes; `get` waits for its bot.
 */
export function createDashboardSources(
  ids: readonly string[],
  opts: { refreshSeconds: number; concurrency?: number; deps?: SourceDeps; fetch?: typeof fetchBotEntry },
): DashboardSources {
  const deps = opts.deps ?? defaultSourceDeps;
  const fetchEntry = opts.fetch ?? fetchBotEntry;
  const concurrency = opts.concurrency ?? 3;
  const freshMs = opts.refreshSeconds * 1000;
  const cache = new Map<string, Map<DashboardRange, { entry: DashboardBotEntry; at: number }>>();
  const inflight = new Map<string, Promise<DashboardBotEntry>>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const load = (id: string, range: DashboardRange): Promise<DashboardBotEntry> => {
    const key = `${id}|${range}`;
    const pending = inflight.get(key);
    if (pending) return pending;
    const promise = fetchEntry(id, range, deps)
      .then((entry) => {
        let byRange = cache.get(id);
        if (!byRange) cache.set(id, (byRange = new Map()));
        byRange.set(range, { entry, at: deps.now() });
        return entry;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };
  const fresh = (id: string, range: DashboardRange): DashboardBotEntry | undefined => {
    const hit = cache.get(id)?.get(range);
    return hit && deps.now() - hit.at < freshMs ? hit.entry : undefined;
  };
  const cycle = async (): Promise<void> => {
    await mapLimit(ids, concurrency, (id) => load(id, "24h"));
    if (!stopped) timer = setTimeout(() => void cycle(), freshMs);
  };

  return {
    refreshSeconds: opts.refreshSeconds,
    async list(range) {
      return ids.map((id) => {
        const hit = cache.get(id)?.get(range);
        if (!hit || deps.now() - hit.at >= freshMs) void load(id, range).catch(() => undefined);
        return hit ? hit.entry : pendingEntry(id, deps);
      });
    },
    async get(id, range) {
      if (!ids.includes(id)) return undefined;
      return fresh(id, range) ?? load(id, range);
    },
    start() {
      if (timer || stopped) return;
      void cycle();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

// packages/core/src/metrics.ts
// In-process call counters for the dashboard: venue adapter methods, outbound
// HTTP by hostname, and anything else a runtime wants to count. Cumulative
// totals feed "since start"; interval deltas are flushed to SQLite by the
// runtime's sampler so "last 24h" survives restarts.

export interface MetricOutcome {
  ok: boolean;
  ms: number;
  error?: string;
}

export interface MetricCounter {
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  lastError?: string;
  lastErrorAt?: number;
}

export interface MetricDelta {
  key: string;
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

interface Slot {
  total: MetricCounter;
  interval: MetricDelta;
}

const ERROR_TEXT_LIMIT = 200;

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > ERROR_TEXT_LIMIT ? `${text.slice(0, ERROR_TEXT_LIMIT - 1)}…` : text;
}

export class MetricsRegistry {
  readonly startedAt: number;
  private readonly slots = new Map<string, Slot>();
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(opts: { now?: () => number; maxKeys?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? 500;
    this.startedAt = this.now();
  }

  record(key: string, outcome: MetricOutcome): void {
    const slot = this.slot(key);
    const ms = Number.isFinite(outcome.ms) && outcome.ms >= 0 ? outcome.ms : 0;
    slot.total.calls += 1;
    slot.total.totalMs += ms;
    if (ms > slot.total.maxMs) slot.total.maxMs = ms;
    slot.interval.calls += 1;
    slot.interval.totalMs += ms;
    if (ms > slot.interval.maxMs) slot.interval.maxMs = ms;
    if (!outcome.ok) {
      slot.total.errors += 1;
      slot.interval.errors += 1;
      slot.total.lastError = outcome.error === undefined ? "error" : errorText(outcome.error);
      slot.total.lastErrorAt = this.now();
    }
  }

  /** Cumulative counters since construction, keys sorted. */
  snapshot(): Record<string, MetricCounter> {
    const out: Record<string, MetricCounter> = {};
    for (const key of [...this.slots.keys()].sort()) out[key] = { ...this.slots.get(key)!.total };
    return out;
  }

  /** Deltas since the previous take; resets the interval accumulators. */
  takeInterval(): MetricDelta[] {
    const deltas = this.peekInterval();
    for (const slot of this.slots.values()) slot.interval = emptyDelta(slot.interval.key);
    return deltas;
  }

  /** Deltas since the previous take, without resetting. */
  peekInterval(): MetricDelta[] {
    const out: MetricDelta[] = [];
    for (const key of [...this.slots.keys()].sort()) {
      const delta = this.slots.get(key)!.interval;
      if (delta.calls > 0) out.push({ ...delta });
    }
    return out;
  }

  /** Tests only. */
  reset(): void {
    this.slots.clear();
  }

  private slot(key: string): Slot {
    let slot = this.slots.get(key);
    if (slot) return slot;
    if (this.slots.size >= this.maxKeys) {
      const overflow = `${key.split(".")[0] ?? "other"}.other`;
      slot = this.slots.get(overflow);
      if (slot) return slot;
      key = overflow;
    }
    slot = { total: { calls: 0, errors: 0, totalMs: 0, maxMs: 0 }, interval: emptyDelta(key) };
    this.slots.set(key, slot);
    return slot;
  }
}

function emptyDelta(key: string): MetricDelta {
  return { key, calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
}

let shared: MetricsRegistry | undefined;

/** Process-wide registry shared by boundFetch and the runtime's adapter wrapper. */
export function defaultMetricsRegistry(): MetricsRegistry {
  shared ??= new MetricsRegistry();
  return shared;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Wrap every method of a venue adapter so each call is counted and timed under
 * `<prefix>.<method>`. Non-function properties and absent optional methods pass
 * through untouched, methods run with `this` bound to the real adapter, and the
 * method is looked up at call time so a reassigned method is still counted.
 */
export function instrumentVenueAdapter<T extends object>(
  adapter: T,
  registry: MetricsRegistry,
  prefix: string = String((adapter as { id?: unknown }).id ?? "venue"),
): T {
  const wrappers = new Map<string, (...args: unknown[]) => unknown>();
  return new Proxy(adapter, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof key !== "string" || key === "constructor" || typeof value !== "function") return value;
      if (Object.hasOwn(Object.prototype, key)) return (value as (...a: unknown[]) => unknown).bind(target);
      let wrapper = wrappers.get(key);
      if (!wrapper) {
        const metric = `${prefix}.${key}`;
        wrapper = function (this: unknown, ...args: unknown[]): unknown {
          const fn: unknown = Reflect.get(target, key, target);
          if (typeof fn !== "function") throw new TypeError(`${metric} is not a function`);
          const t0 = performance.now();
          let result: unknown;
          try {
            result = Reflect.apply(fn, target, args);
          } catch (error) {
            registry.record(metric, { ok: false, ms: performance.now() - t0, error: errorText(error) });
            throw error;
          }
          if (!isThenable(result)) return result;
          return Promise.resolve(result).then(
            (v) => {
              registry.record(metric, { ok: true, ms: performance.now() - t0 });
              return v;
            },
            (error: unknown) => {
              registry.record(metric, { ok: false, ms: performance.now() - t0, error: errorText(error) });
              throw error;
            },
          );
        };
        wrappers.set(key, wrapper);
      }
      return wrapper;
    },
  });
}

// packages/core/src/engine/refusal-log.ts
// One deduped log line per refused action: a silent gate hid a nine-hour outage.
import type { Logger } from "../types.js";

const DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * Records why an executor refused work. A key (market, order, cycle) logs when its
 * message changes or the interval elapses, and logs once more when it resolves.
 */
export class RefusalLog {
  private readonly active = new Map<string, { message: string; loggedAt: number }>();
  constructor(private readonly log: Logger, private readonly now: () => number = Date.now, private readonly intervalMs = DEFAULT_INTERVAL_MS) {}

  refuse(key: string, message: string, data?: Record<string, unknown>): void {
    const now = this.now();
    const current = this.active.get(key);
    if (current && current.message === message && now - current.loggedAt < this.intervalMs) return;
    if (data === undefined) this.log.warn(message); else this.log.warn(message, data);
    this.active.set(key, { message, loggedAt: now });
  }

  resolve(key: string, message?: string): void {
    if (!this.active.delete(key)) return;
    if (message) this.log.info(message);
  }

  /** Keys currently refused; useful for status surfaces. */
  keys(prefix?: string): string[] {
    return [...this.active.keys()].filter(key => prefix === undefined || key.startsWith(prefix));
  }
}

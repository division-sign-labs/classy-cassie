// packages/runtime-node/src/dashboard/counters.ts
// Engine-level counters the metrics registry cannot see: ticks and alerts.

import type { AlertEvent, Alerter } from "@quotient-forecasting/cassie-core";

export class EngineCounters {
  ticks = 0;
  tickErrors = 0;
  alertsSent = 0;
  alertsFailed = 0;
  readonly alertsByKind: Record<string, number> = {};

  snapshot(): { ticks: number; tickErrors: number; alertsSent: number; alertsFailed: number; alertsByKind: Record<string, number> } {
    return {
      ticks: this.ticks,
      tickErrors: this.tickErrors,
      alertsSent: this.alertsSent,
      alertsFailed: this.alertsFailed,
      alertsByKind: { ...this.alertsByKind },
    };
  }
}

/**
 * Counts attempts by kind and deliveries by outcome. Sits inside SafeAlerter,
 * which swallows sink failures, so a failed delivery is still visible here.
 */
export class CountingAlerter implements Alerter {
  constructor(
    private readonly inner: Alerter,
    private readonly counters: EngineCounters,
  ) {}

  async send(event: AlertEvent): Promise<void> {
    this.counters.alertsByKind[event.kind] = (this.counters.alertsByKind[event.kind] ?? 0) + 1;
    try {
      await this.inner.send(event);
      this.counters.alertsSent += 1;
    } catch (error) {
      this.counters.alertsFailed += 1;
      throw error;
    }
  }

  flush(): Promise<unknown> {
    return this.inner.flush?.() ?? Promise.resolve(undefined);
  }
}

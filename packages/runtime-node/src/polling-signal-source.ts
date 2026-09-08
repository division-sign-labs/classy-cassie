// packages/runtime-node/src/polling-signal-source.ts
// Cache live signal snapshots independently from the faster engine/position loop.

import {
  marketForecastFromSignal,
  type ForecastQuery,
  type MarketForecast,
  type Signal,
  type SignalQuery,
  type SignalSource,
} from "@quotient-forecasting/cassie-core";

export const DEFAULT_SIGNAL_POLL_INTERVAL_MIN = 5;

export interface PollingSignalSourceOptions {
  now?: () => number;
  onRefresh?: (count: number, nextRefreshAt: number) => void;
  onForecastRefresh?: (count: number, nextRefreshAt: number) => void;
  /** A refresh failed; `servedFromCache` says whether an older snapshot answered instead. */
  onRefreshFailure?: (error: unknown, servedFromCache: boolean) => void;
}

/** How long a failed refresh waits before the next attempt, so a dead gateway is not hit every tick. */
export const REFRESH_FAILURE_BACKOFF_MS = 60_000;

/**
 * Fetch the complete upstream snapshot no more than once per interval, then
 * answer venue/market queries from that snapshot. Concurrent refreshes share
 * one request, so overlapping engine work cannot double-poll Quotient.
 */
export class PollingSignalSource implements SignalSource {
  readonly #source: SignalSource;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #onRefresh?: PollingSignalSourceOptions["onRefresh"];
  readonly #onForecastRefresh?: PollingSignalSourceOptions["onForecastRefresh"];
  readonly #onRefreshFailure?: PollingSignalSourceOptions["onRefreshFailure"];
  #cached?: { refreshedAt: number; signals: Signal[] };
  #refreshing?: Promise<Signal[]>;
  readonly #forecastCache = new Map<string, { refreshedAt: number; forecast?: MarketForecast }>();
  #forecastRefreshing?: Promise<void>;

  constructor(source: SignalSource, intervalMs: number, opts: PollingSignalSourceOptions = {}) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error("signal poll interval must be greater than zero");
    }
    this.#source = source;
    this.#intervalMs = intervalMs;
    this.#now = opts.now ?? (() => Date.now());
    this.#onRefresh = opts.onRefresh;
    this.#onForecastRefresh = opts.onForecastRefresh;
    this.#onRefreshFailure = opts.onRefreshFailure;
  }

  async latest(query: SignalQuery): Promise<Signal[]> {
    const signals = await this.#snapshot();
    return signals.filter(
      (signal) =>
        (!query.venue || signal.venue === query.venue) &&
        (!query.marketRef || signal.marketRef === query.marketRef),
    );
  }

  refreshedAt(): number | undefined { return this.#cached?.refreshedAt; }

  /**
   * Refresh held-market Q forecasts on the slower signal cadence while the
   * engine continues to re-price positions every tick.
   */
  async forecasts(query: ForecastQuery): Promise<MarketForecast[]> {
    const marketRefs = [...new Set(query.marketRefs.filter(Boolean))];
    if (marketRefs.length === 0) return [];
    const fetchForecasts = this.#source.forecasts?.bind(this.#source);
    if (!fetchForecasts) {
      const wanted = new Set(marketRefs);
      return (await this.latest({ venue: query.venue }))
        .filter((signal) => wanted.has(signal.marketRef))
        .map(marketForecastFromSignal)
        .filter((forecast): forecast is MarketForecast => forecast !== null);
    }

    for (;;) {
      const now = this.#now();
      const stale = marketRefs.filter((marketRef) => {
        const cached = this.#forecastCache.get(forecastKey(query.venue, marketRef));
        return !cached || now - cached.refreshedAt >= this.#intervalMs;
      });
      if (stale.length === 0) break;
      if (this.#forecastRefreshing) {
        await this.#forecastRefreshing;
        continue;
      }

      const refresh = fetchForecasts({ venue: query.venue, marketRefs: stale }).then((forecasts) => {
        const refreshedAt = this.#now();
        const byRef = new Map(forecasts.map((forecast) => [forecast.marketRef, forecast]));
        for (const marketRef of stale) {
          this.#forecastCache.set(forecastKey(query.venue, marketRef), {
            refreshedAt,
            forecast: byRef.get(marketRef),
          });
        }
        this.#onForecastRefresh?.(forecasts.length, refreshedAt + this.#intervalMs);
      }, (error: unknown) => {
        // Quotient is unreachable after the source's own retries. Keep every
        // cached forecast, so exits keep evaluating on the last committed Q,
        // and back the next attempt off. Refs never fetched stay absent.
        const retryAt = this.#now() - this.#intervalMs + REFRESH_FAILURE_BACKOFF_MS;
        let served = false;
        for (const marketRef of stale) {
          const key = forecastKey(query.venue, marketRef);
          const cached = this.#forecastCache.get(key);
          if (cached?.forecast) served = true;
          this.#forecastCache.set(key, { refreshedAt: retryAt, forecast: cached?.forecast });
        }
        this.#onRefreshFailure?.(error, served);
      });
      this.#forecastRefreshing = refresh;
      try {
        await refresh;
      } finally {
        if (this.#forecastRefreshing === refresh) this.#forecastRefreshing = undefined;
      }
    }

    return marketRefs.flatMap((marketRef) => {
      const forecast = this.#forecastCache.get(forecastKey(query.venue, marketRef))?.forecast;
      return forecast ? [forecast] : [];
    });
  }

  async #snapshot(): Promise<Signal[]> {
    const now = this.#now();
    if (this.#cached && now - this.#cached.refreshedAt < this.#intervalMs) {
      return this.#cached.signals;
    }
    if (this.#refreshing) return this.#refreshing;

    const refresh = this.#source.latest({}).then((signals) => {
      const refreshedAt = this.#now();
      const snapshot = [...signals];
      this.#cached = { refreshedAt, signals: snapshot };
      this.#onRefresh?.(snapshot.length, refreshedAt + this.#intervalMs);
      return snapshot;
    }, (error: unknown) => {
      // Serve the previous snapshot through an outage; a bot that has never
      // seen one has nothing to serve and the engine handles the rejection.
      const previous = this.#cached;
      this.#onRefreshFailure?.(error, previous !== undefined);
      if (!previous) throw error;
      this.#cached = { refreshedAt: this.#now() - this.#intervalMs + REFRESH_FAILURE_BACKOFF_MS, signals: previous.signals };
      return previous.signals;
    });
    this.#refreshing = refresh;
    try {
      return await refresh;
    } finally {
      if (this.#refreshing === refresh) this.#refreshing = undefined;
    }
  }
}

function forecastKey(venue: ForecastQuery["venue"], marketRef: string): string {
  return (venue ?? "*") + ":" + marketRef;
}

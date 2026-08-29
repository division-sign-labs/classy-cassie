// packages/runtime-node/test/polling-signal-source.test.ts

import { describe, expect, it, vi } from "vitest";
import type { MarketForecast, Signal, SignalSource } from "@quotient-forecasting/cassie-core";
import { PollingSignalSource } from "../src/polling-signal-source.js";

function signal(over: Partial<Signal> = {}): Signal {
  return {
    id: "signal-1",
    ts: "2026-08-29T18:00:00.000Z",
    venue: "polymarket",
    marketRef: "market-1",
    side: "YES",
    prob: 0.7,
    refPrice: 0.5,
    ttlSec: 10_800,
    ...over,
  };
}

function forecast(over: Partial<MarketForecast> = {}): MarketForecast {
  return {
    id: "forecast-1",
    ts: "2026-08-24T22:06:19.902Z",
    venue: "polymarket",
    marketRef: "market-1",
    probYes: 0.9184779613,
    ...over,
  };
}

describe("PollingSignalSource", () => {
  it("refreshes once per interval and filters the cached snapshot", async () => {
    let now = 1_000;
    const upstream = {
      latest: vi.fn(async () => [signal(), signal({ id: "signal-2", venue: "kalshi", marketRef: "market-2" })]),
    } satisfies SignalSource;
    const refreshed = vi.fn();
    const source = new PollingSignalSource(upstream, 300_000, {
      now: () => now,
      onRefresh: refreshed,
    });

    await expect(source.latest({ venue: "polymarket" })).resolves.toEqual([signal()]);
    now += 299_999;
    await expect(source.latest({ marketRef: "market-2" })).resolves.toMatchObject([{ id: "signal-2" }]);
    expect(upstream.latest).toHaveBeenCalledTimes(1);
    expect(upstream.latest).toHaveBeenCalledWith({});
    expect(refreshed).toHaveBeenCalledWith(2, 301_000);

    now += 1;
    await source.latest({});
    expect(upstream.latest).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent refreshes", async () => {
    let release!: (signals: Signal[]) => void;
    const pending = new Promise<Signal[]>((resolve) => {
      release = resolve;
    });
    const upstream = { latest: vi.fn(() => pending) } satisfies SignalSource;
    const source = new PollingSignalSource(upstream, 300_000);

    const first = source.latest({ venue: "polymarket" });
    const second = source.latest({ marketRef: "market-1" });
    expect(upstream.latest).toHaveBeenCalledTimes(1);
    release([signal()]);
    await expect(Promise.all([first, second])).resolves.toEqual([[signal()], [signal()]]);
  });

  it("retries after a failed refresh", async () => {
    const upstream = {
      latest: vi.fn<SignalSource["latest"]>()
        .mockRejectedValueOnce(new Error("gateway unavailable"))
        .mockResolvedValueOnce([signal()]),
    } satisfies SignalSource;
    const source = new PollingSignalSource(upstream, 300_000);

    await expect(source.latest({})).rejects.toThrow("gateway unavailable");
    await expect(source.latest({})).resolves.toEqual([signal()]);
    expect(upstream.latest).toHaveBeenCalledTimes(2);
  });

  it("caches held-market forecasts independently on the same interval", async () => {
    let now = 1_000;
    const upstream = {
      latest: vi.fn(async () => []),
      forecasts: vi.fn(async () => [forecast()]),
    } satisfies SignalSource;
    const refreshed = vi.fn();
    const source = new PollingSignalSource(upstream, 300_000, {
      now: () => now,
      onForecastRefresh: refreshed,
    });
    const query = { venue: "polymarket" as const, marketRefs: ["market-1"] };

    await expect(source.forecasts(query)).resolves.toEqual([forecast()]);
    now += 299_999;
    await expect(source.forecasts(query)).resolves.toEqual([forecast()]);
    expect(upstream.forecasts).toHaveBeenCalledTimes(1);
    expect(refreshed).toHaveBeenCalledWith(1, 301_000);

    now += 1;
    await source.forecasts(query);
    expect(upstream.forecasts).toHaveBeenCalledTimes(2);
    expect(upstream.latest).not.toHaveBeenCalled();
  });
});

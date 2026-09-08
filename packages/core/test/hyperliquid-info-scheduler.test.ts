// packages/core/test/hyperliquid-info-scheduler.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpRequestError, type InfoClient } from "@nktkas/hyperliquid";
import { HyperliquidInfoDeferredError, hyperliquidInfoResponseWeight, hyperliquidInfoSchedulerStats,
  wrapHyperliquidInfoClient, type HyperliquidInfoSchedulerOptions } from "../src/venues/hyperliquid-info-scheduler.js";

const USER = "0x1111111111111111111111111111111111111111" as const;
const HOUR = 3_600_000;
let scopeId = 0;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function wrap(methods: object, options: HyperliquidInfoSchedulerOptions = {}): InfoClient {
  return wrapHyperliquidInfoClient(methods as InfoClient, { now: Date.now, ...options });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("Hyperliquid documented info weights", () => {
  it.each([["l2Book", 2], ["allMids", 2], ["clearinghouseState", 2], ["orderStatus", 2], ["spotClearinghouseState", 2],
    ["exchangeStatus", 2], ["userRole", 60], ["frontendOpenOrders", 20], ["metaAndAssetCtxs", 20]])("charges %s base weight %s", (method, weight) => {
    expect(hyperliquidInfoResponseWeight(String(method), undefined)).toBe(weight);
  });
  it("includes returned-item costs, rounding partial groups conservatively", () => {
    expect(hyperliquidInfoResponseWeight("candleSnapshot", Array(61).fill(null))).toBe(22);
    expect(hyperliquidInfoResponseWeight("userFillsByTime", Array(21).fill(null))).toBe(22);
    expect(hyperliquidInfoResponseWeight("fundingHistory", Array(40).fill(null))).toBe(22);
    expect(hyperliquidInfoResponseWeight("userTwapSliceFills", { fills: Array(41).fill(null) })).toBe(23);
  });
  it("reserves the requested candle range before sending cold history", async () => {
    const client = wrap({ candleSnapshot: vi.fn(async () => []) });
    await client.candleSnapshot({ coin: "xyz:NVDA", interval: "1h", startTime: 0, endTime: 240 * HOUR });
    expect(hyperliquidInfoSchedulerStats(client)?.weightInWindow).toBe(25);
  });
  it("charges previously unknown response lengths before starting another request", async () => {
    const client = wrap({ userFillsByTime: vi.fn(async () => Array(61).fill({})) });
    await client.userFillsByTime({ user: USER, startTime: 0 });
    expect(hyperliquidInfoSchedulerStats(client)?.weightInWindow).toBe(24);
  });
});

describe("Hyperliquid bounded info scheduling", () => {
  it("coalesces canonical identical in-flight reads, not later reads", async () => {
    const response = deferred<object>(), read = vi.fn(() => response.promise);
    const client = wrap({ clearinghouseState: read });
    const first = client.clearinghouseState({ user: USER, dex: "xyz" });
    const second = client.clearinghouseState({ dex: "xyz", user: USER });
    expect(second).toBe(first);
    await flush(); expect(read).toHaveBeenCalledOnce();
    response.resolve({}); await first; await flush();
    await client.clearinghouseState({ user: USER, dex: "xyz" });
    expect(read).toHaveBeenCalledTimes(2);
    expect(hyperliquidInfoSchedulerStats(client)).toMatchObject({ coalesced: 1, weightInWindow: 4 });
  });
  it("reserves a concurrency slot and moves protective account reads ahead of cold candles", async () => {
    const history = deferred<unknown[]>(), calls: string[] = [];
    const client = wrap({ candleSnapshot: vi.fn(() => { calls.push("history"); return history.promise; }),
      clearinghouseState: vi.fn(async () => { calls.push("account"); return {}; }) });
    const a = client.candleSnapshot({ coin: "xyz:NVDA", interval: "1h", startTime: 0, endTime: HOUR });
    const b = client.candleSnapshot({ coin: "xyz:TSLA", interval: "1h", startTime: 0, endTime: HOUR });
    await client.clearinghouseState({ user: USER });
    expect(calls).toEqual(["history", "account"]);
    expect(hyperliquidInfoSchedulerStats(client)?.backgroundActive).toBe(1);
    history.resolve([]); await Promise.all([a, b]);
    expect(calls).toEqual(["history", "account", "history"]);
  });
  it("prioritizes cold metadata prerequisites for protected account lookup over queued candles", async () => {
    const history = deferred<unknown[]>(), calls: string[] = [];
    const client = wrap({
      candleSnapshot: () => { calls.push("history"); return history.promise; },
      perpDexs: async () => { calls.push("dexes"); return []; },
      meta: async () => { calls.push("meta"); return {}; },
      metaAndAssetCtxs: async () => { calls.push("asset-contexts"); return []; },
      userRateLimit: async () => { calls.push("timer-eligibility"); return {}; },
      clearinghouseState: async () => { calls.push("account"); return {}; },
    });
    const first = client.candleSnapshot({ coin: "xyz:NVDA", interval: "1h", startTime: 0, endTime: HOUR });
    const second = client.candleSnapshot({ coin: "xyz:TSLA", interval: "1h", startTime: 0, endTime: HOUR });
    await client.perpDexs();
    await client.meta({ dex: "xyz" });
    await client.metaAndAssetCtxs({ dex: "xyz" });
    await client.userRateLimit({ user: USER });
    await client.clearinghouseState({ user: USER, dex: "xyz" });
    expect(calls).toEqual(["history", "dexes", "meta", "asset-contexts", "timer-eligibility", "account"]);
    expect(hyperliquidInfoSchedulerStats(client)?.queued).toBe(1);
    history.resolve([]); await Promise.all([first, second]);
    expect(calls.at(-1)).toBe("history");
  });
  it("keeps priority budget available after background capacity is exhausted", async () => {
    const client = wrap({ fundingHistory: vi.fn(async () => []), clearinghouseState: vi.fn(async () => ({})) },
      { maxWeightPerMinute: 100, reservedPriorityWeight: 40 });
    for (const coin of ["a", "b", "c"]) await client.fundingHistory({ coin, startTime: 0 });
    await expect(client.fundingHistory({ coin: "d", startTime: 0 })).rejects.toMatchObject({ reason: "rate-budget" });
    await client.clearinghouseState({ user: USER });
    expect(hyperliquidInfoSchedulerStats(client)?.weightInWindow).toBe(62);
  });
  it("defaults to 400 background weight and 500 additional priority weight", async () => {
    const client = wrap({ fundingHistory: async () => [], userAbstraction: async () => "disabled" });
    for (let i = 0; i < 20; i++) await client.fundingHistory({ coin: String(i), startTime: 0 });
    await expect(client.fundingHistory({ coin: "overflow", startTime: 0 })).rejects.toMatchObject({ reason: "rate-budget" });
    for (let i = 0; i < 25; i++) await client.userAbstraction({ user: USER });
    expect(hyperliquidInfoSchedulerStats(client)?.weightInWindow).toBe(900);
    // A priority read over budget waits for the window rather than failing an execution path outright.
    const overflow = client.userAbstraction({ user: USER }).then(() => "resolved", (error: HyperliquidInfoDeferredError) => error.reason);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await overflow).toBe("queue-expired");
  });
  it("enforces a rolling minute without waiting indefinitely inside a caller", async () => {
    const read = vi.fn(async () => []), client = wrap({ fundingHistory: read }, { maxWeightPerMinute: 40, reservedPriorityWeight: 0 });
    await client.fundingHistory({ coin: "a", startTime: 0 }); await client.fundingHistory({ coin: "b", startTime: 0 });
    await expect(client.fundingHistory({ coin: "c", startTime: 0 })).rejects.toBeInstanceOf(HyperliquidInfoDeferredError);
    await vi.advanceTimersByTimeAsync(59_999);
    await expect(client.fundingHistory({ coin: "d", startTime: 0 })).rejects.toMatchObject({ reason: "rate-budget", retryAfterMs: 1 });
    await vi.advanceTimersByTimeAsync(1); await client.fundingHistory({ coin: "e", startTime: 0 });
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("bounds the queue and lets a protective read displace queued background work", async () => {
    const pending = deferred<unknown[]>();
    const client = wrap({ fundingHistory: () => pending.promise, clearinghouseState: async () => ({}) }, { maxQueueSize: 1 });
    const first = client.fundingHistory({ coin: "a", startTime: 0 });
    const second = client.fundingHistory({ coin: "b", startTime: 0 }).catch(error => error);
    await expect(client.fundingHistory({ coin: "c", startTime: 0 })).rejects.toMatchObject({ reason: "queue-full" });
    await client.clearinghouseState({ user: USER });
    expect(await second).toMatchObject({ reason: "queue-full" });
    expect(hyperliquidInfoSchedulerStats(client)?.queued).toBe(0);
    pending.resolve([]); await first;
  });
  it("expires queued book/account reads in at most ten seconds", async () => {
    const pending = deferred<object>();
    const client = wrap({ clearinghouseState: () => pending.promise, l2Book: async () => ({}) });
    const a = client.clearinghouseState({ user: USER, dex: "a" });
    const b = client.clearinghouseState({ user: USER, dex: "b" });
    const queued = client.l2Book({ coin: "xyz:NVDA" }).catch(error => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await queued).toMatchObject({ reason: "queue-expired" });
    pending.resolve({}); await Promise.all([a, b]);
  });
  it("does not coalesce independent AbortSignals and never dispatches an already aborted read", async () => {
    const read = vi.fn(async () => ({})), client = wrap({ clearinghouseState: read });
    const first = new AbortController(), second = new AbortController();
    await Promise.all([client.clearinghouseState({ user: USER }, first.signal), client.clearinghouseState({ user: USER }, second.signal)]);
    expect(read).toHaveBeenCalledTimes(2);
    first.abort(new Error("canceled"));
    await expect(client.clearinghouseState({ user: USER }, first.signal)).rejects.toThrow("canceled");
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not send an aborted queued read when a concurrency slot opens", async () => {
    const pending = deferred<unknown[]>(), read = vi.fn(() => pending.promise);
    const client = wrap({ fundingHistory: read });
    const first = client.fundingHistory({ coin: "a", startTime: 0 });
    const abort = new AbortController();
    const second = client.fundingHistory({ coin: "b", startTime: 0 }, abort.signal).catch(error => error);
    abort.abort(new Error("canceled")); pending.resolve([]);
    await first; expect(await second).toMatchObject({ message: "canceled" });
    expect(read).toHaveBeenCalledOnce();
  });
  it("supports injected clocks and sleep without real waiting", async () => {
    let now = 0;
    const elapsed = deferred<void>(), pending = deferred<unknown[]>();
    const sleep = vi.fn(() => elapsed.promise);
    const client = wrap({ fundingHistory: () => pending.promise }, { now: () => now, sleep });
    const first = client.fundingHistory({ coin: "a", startTime: 0 });
    const second = client.fundingHistory({ coin: "b", startTime: 0 }).catch(error => error);
    await flush(); expect(sleep).toHaveBeenCalledExactlyOnceWith(10_000);
    now = 10_000; elapsed.resolve(); await flush();
    expect(await second).toMatchObject({ reason: "queue-expired" });
    pending.resolve([]); await first;
  });
  it("passes a failed read through once and keeps later reads usable", async () => {
    const read = vi.fn().mockImplementationOnce(() => { throw new Error("offline"); }).mockResolvedValue({});
    const client = wrap({ clearinghouseState: read });
    await expect(client.clearinghouseState({ user: USER })).rejects.toThrow("offline");
    await client.clearinghouseState({ user: USER });
    expect(read).toHaveBeenCalledTimes(2);
    expect(hyperliquidInfoSchedulerStats(client)?.cooldownRemainingMs).toBe(0);
  });
  it("binds SDK methods to their original instance without scheduling Object methods", async () => {
    const raw = { label: "sdk", async clearinghouseState() { return this.label; } };
    const client = wrap(raw);
    expect(await client.clearinghouseState({ user: USER })).toBe("sdk");
    expect(client.toString()).toBe("[object Object]");
    expect(hyperliquidInfoSchedulerStats(client)?.requests).toBe(1);
  });
  it("shares a scoped budget across clients without merging distinct clients' responses", async () => {
    const scope = `test-shared-${++scopeId}`;
    const a = wrap({ metaAndAssetCtxs: async () => ["a"] }, { scope, maxWeightPerMinute: 40, reservedPriorityWeight: 0 });
    const b = wrap({ metaAndAssetCtxs: async () => ["b"] }, { scope, maxWeightPerMinute: 40, reservedPriorityWeight: 0 });
    expect(await a.metaAndAssetCtxs()).toEqual(["a"]);
    expect(await b.metaAndAssetCtxs()).toEqual(["b"]);
    const overflow = a.metaAndAssetCtxs().then(() => "resolved", (error: HyperliquidInfoDeferredError) => error.reason);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await overflow).toBe("queue-expired");
    expect(hyperliquidInfoSchedulerStats(a)).toEqual(hyperliquidInfoSchedulerStats(b));
  });
  it("does not wrap an existing scheduler twice or accept limits above the bounded envelope", () => {
    const client = wrap({ clearinghouseState: async () => ({}) });
    expect(wrapHyperliquidInfoClient(client)).toBe(client);
    for (const options of [{ maxWeightPerMinute: 1200 }, { maxConcurrency: 3 }, { maxQueueWaitMs: 20_000 }]) {
      expect(() => wrap({}, options)).toThrow("invalid Hyperliquid info scheduler limits");
    }
  });
});

describe("Hyperliquid shared 429 cooldown", () => {
  it("honors Retry-After and never retries the failed SDK read", async () => {
    const error = new HttpRequestError({ response: new Response(null, { status: 429, headers: { "retry-after": "45" } }) });
    const read = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({});
    const client = wrap({ clearinghouseState: read, l2Book: vi.fn(async () => ({})) });
    await expect(client.clearinghouseState({ user: USER })).rejects.toBe(error);
    await expect(client.l2Book({ coin: "xyz:NVDA" })).rejects.toMatchObject({ reason: "cooldown", retryAfterMs: 45_000 });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(read).toHaveBeenCalledOnce();
    await client.clearinghouseState({ user: USER });
    expect(read).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(hyperliquidInfoSchedulerStats(client))).not.toContain(USER);
  });
  it("backs off repeated failures for 30, 60, then 120 seconds", async () => {
    const read = vi.fn(async () => { throw new HttpRequestError({ response: new Response(null, { status: 429 }) }); });
    const client = wrap({ clearinghouseState: read });
    for (const cooldown of [30_000, 60_000, 120_000, 120_000]) {
      await expect(client.clearinghouseState({ user: USER })).rejects.toThrow("429");
      expect(hyperliquidInfoSchedulerStats(client)?.cooldownRemainingMs).toBe(cooldown);
      await vi.advanceTimersByTimeAsync(cooldown);
    }
    expect(read).toHaveBeenCalledTimes(4);
  });
  it("honors HTTP-date Retry-After values and releases queued reads as deferred", async () => {
    const retryAt = new Date(Date.now() + 180_000).toUTCString();
    const scope = `test-shared-${++scopeId}`;
    const error = new HttpRequestError({ response: new Response(null, { status: 429, headers: { "retry-after": retryAt } }) });
    const client = wrap({ fundingHistory: async () => { throw error; } }, { scope });
    const other = wrap({ clearinghouseState: async () => ({}) }, { scope });
    const a = client.fundingHistory({ coin: "a", startTime: 0 }).catch(value => value);
    const b = client.fundingHistory({ coin: "b", startTime: 0 }).catch(value => value);
    expect(await a).toBe(error);
    expect(await b).toMatchObject({ reason: "cooldown", retryAfterMs: 180_000 });
    await expect(other.clearinghouseState({ user: USER })).rejects.toMatchObject({ reason: "cooldown", retryAfterMs: 180_000 });
  });
});

describe("execution-path reads under a full window", () => {
  it("lets a priority read wait for the window to free instead of rejecting it", async () => {
    const activeAssetData = vi.fn(async () => ({ leverage: { type: "isolated", value: 8 } }));
    const client = wrap({ frontendOpenOrders: vi.fn(async () => []), activeAssetData }, { scope: `wait-${scopeId++}` });
    for (let i = 0; i < 45; i++) await client.frontendOpenOrders({ user: USER });
    expect(hyperliquidInfoSchedulerStats(client)?.weightInWindow).toBe(900);
    await vi.advanceTimersByTimeAsync(55_000);
    let settled: "pending" | "resolved" | "rejected" = "pending";
    const call = client.activeAssetData({ user: USER, coin: "xyz:CL" }).then(() => { settled = "resolved"; }, () => { settled = "rejected"; });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(settled).toBe("pending");
    expect(activeAssetData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await call;
    expect(settled).toBe("resolved");
    expect(activeAssetData).toHaveBeenCalledOnce();
    expect(hyperliquidInfoSchedulerStats(client)?.rejected).toBe(0);
  });
  it("still rejects a background read outright when the shared window is above its reserve", async () => {
    const candleSnapshot = vi.fn(async () => []);
    const client = wrap({ frontendOpenOrders: vi.fn(async () => []), candleSnapshot }, { scope: `bg-${scopeId++}` });
    for (let i = 0; i < 25; i++) await client.frontendOpenOrders({ user: USER });
    await expect(client.candleSnapshot({ coin: "xyz:CL", interval: "1h", startTime: 0, endTime: HOUR })).rejects.toBeInstanceOf(HyperliquidInfoDeferredError);
    expect(candleSnapshot).not.toHaveBeenCalled();
  });
  it("expires a priority read that cannot fit before its deadline", async () => {
    const activeAssetData = vi.fn(async () => ({}));
    const client = wrap({ frontendOpenOrders: vi.fn(async () => []), activeAssetData }, { scope: `expire-${scopeId++}` });
    for (let i = 0; i < 45; i++) await client.frontendOpenOrders({ user: USER });
    const call = client.activeAssetData({ user: USER, coin: "xyz:CL" });
    const outcome = call.then(() => "resolved", (error: unknown) => (error as HyperliquidInfoDeferredError).reason);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await outcome).toBe("queue-expired");
    expect(activeAssetData).not.toHaveBeenCalled();
  });
});

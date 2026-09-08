// packages/core/test/quotient-retry.test.ts
// Bounded retry for Quotient reads: three attempts on transient failure, no
// retry on an authorization failure, and the last error surfaces afterwards.

import { describe, expect, it, vi } from "vitest";
import { QuotientApiError, isRetryableQuotientError, withQuotientRetries } from "../src/quotient/retry.js";

const noSleep = async () => {};

describe("withQuotientRetries", () => {
  it("retries a transient failure up to three attempts and then rejects with the last error", async () => {
    const fn = vi.fn(async () => { throw new QuotientApiError(503, "/api/v1/signals", "upstream"); });
    const onRetry = vi.fn();
    await expect(withQuotientRetries(fn, { sleep: noSleep, onRetry })).rejects.toThrow("503");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("returns the first successful attempt", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("fetch failed");
      return "ok";
    });
    await expect(withQuotientRetries(fn, { sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a revoked or out-of-scope key", async () => {
    for (const status of [401, 403]) {
      const fn = vi.fn(async () => { throw new QuotientApiError(status, "/api/v1/signals"); });
      await expect(withQuotientRetries(fn, { sleep: noSleep })).rejects.toMatchObject({ status, unauthorized: true });
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("waits the configured backoff between attempts", async () => {
    const waits: number[] = [];
    const fn = vi.fn(async () => { throw new Error("timeout"); });
    await expect(withQuotientRetries(fn, { sleep: async (ms) => { waits.push(ms); }, delaysMs: [10, 20] })).rejects.toThrow("timeout");
    expect(waits).toEqual([10, 20]);
  });

  it("classifies errors", () => {
    expect(isRetryableQuotientError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableQuotientError(new QuotientApiError(429, "/x"))).toBe(true);
    expect(isRetryableQuotientError(new QuotientApiError(500, "/x"))).toBe(true);
    expect(isRetryableQuotientError(new QuotientApiError(404, "/x"))).toBe(false);
    expect(isRetryableQuotientError(new QuotientApiError(403, "/x"))).toBe(false);
  });
});

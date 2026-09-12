// packages/core/test/venue-transient.test.ts
import { describe, expect, it } from "vitest";
import { VenueRateLimitedError, isRateLimitError, isTransientVenueError, retryAfterMs } from "../src/venues/transient.js";

describe("transient venue error classification", () => {
  it.each([
    ["SDK RateLimitError", Object.assign(new Error("Request to /positions was rate limited"), { name: "RateLimitError", retryAfter: 2 })],
    ["RequestRejectedError 503", Object.assign(new Error("service unavailable"), { name: "RequestRejectedError", status: 503 })],
    ["RequestRejectedError 429", Object.assign(new Error("too many"), { name: "RequestRejectedError", status: 429 })],
    ["RequestRejectedError 408", Object.assign(new Error("request timeout"), { name: "RequestRejectedError", status: 408 })],
    ["TransportError", Object.assign(new Error("connection reset"), { name: "TransportError" })],
    ["TimeoutError", Object.assign(new Error("Request timed out: GET /book"), { name: "TimeoutError" })],
    ["AbortError", Object.assign(new Error("aborted"), { name: "AbortError" })],
    ["ConnectionLostError", Object.assign(new Error("lost"), { name: "ConnectionLostError" })],
    ["executor rpc deadline", new Error("execution market exceeded four seconds")],
    ["executor custom rpc deadline", new Error("portfolio exceeded 8 seconds")],
    ["fetch failed", new TypeError("fetch failed")],
    ["gamma metadata 503", new Error("Polymarket execution market metadata unavailable (503)")],
    ["node code", Object.assign(new Error("boom"), { code: "ECONNRESET" })],
    ["undici code", Object.assign(new Error("boom"), { code: "UND_ERR_CONNECT_TIMEOUT" })],
    ["hyperliquid deferral", Object.assign(new Error("Hyperliquid info deferred: queue-expired; retry after 10s"), { name: "HyperliquidInfoDeferredError", retryable: true, retryAfterMs: 10_000 })],
    ["definitive 4xx with retry hint", Object.assign(new Error("slow down"), { status: 403, retryAfter: 1 })],
    ["nested cause", new Error("wrapper", { cause: Object.assign(new Error("inner"), { status: 502 }) })],
    ["local rate limit", new VenueRateLimitedError("positions", 1500)],
  ])("treats %s as transient", (_label, error) => {
    expect(isTransientVenueError(error)).toBe(true);
  });

  it.each([
    ["stale execution book", new Error("stale execution book")],
    ["post-only rejection", Object.assign(new Error("post-only would cross"), { submissionRejected: true })],
    ["temporary detail outage", new Error("temporary detail outage")],
    ["plain 400", Object.assign(new Error("invalid order"), { name: "RequestRejectedError", status: 400 })],
    ["404 missing order", Object.assign(new Error("order not found"), { name: "RequestRejectedError", status: 404 })],
    ["identity mismatch", new Error("execution token identity changed")],
    ["minimum size", new Error("order size is below the current Polymarket minimum")],
    ["string", "unknown failure"],
    ["undefined", undefined],
  ])("treats %s as definitive", (_label, error) => {
    expect(isTransientVenueError(error)).toBe(false);
  });

  it("recognises explicit rate limits and their retry hints", () => {
    const sdk = Object.assign(new Error("rate limited"), { name: "RateLimitError", retryAfter: 2 });
    expect(isRateLimitError(sdk)).toBe(true);
    expect(retryAfterMs(sdk)).toBe(2_000);
    expect(isRateLimitError(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
    expect(isRateLimitError(new Error("wrapper", { cause: sdk }))).toBe(true);
    expect(isRateLimitError(Object.assign(new Error("x"), { status: 503 }))).toBe(false);
    expect(retryAfterMs(Object.assign(new Error("x"), { retryAfterMs: 750 }))).toBe(750);
    expect(retryAfterMs(new Error("wrapper", { cause: Object.assign(new Error("x"), { retryAfter: 3 }) }))).toBe(3_000);
    expect(retryAfterMs(new Error("nothing"))).toBeUndefined();
    expect(retryAfterMs(Object.assign(new Error("x"), { retryAfter: 0 }))).toBeUndefined();
  });

  it("shapes the local rate-limit error like the SDK's", () => {
    const error = new VenueRateLimitedError("balance-allowance", 4_200);
    expect(error.name).toBe("RateLimitError");
    expect(error.status).toBe(429);
    expect(error.retryAfter).toBe(5);
    expect(error.retryAfterMs).toBe(4_200);
    expect(error.family).toBe("balance-allowance");
    expect(retryAfterMs(error)).toBe(4_200);
    expect(error.message).toContain("balance-allowance");
  });
});

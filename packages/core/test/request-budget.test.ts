// packages/core/test/request-budget.test.ts
import { describe, expect, it } from "vitest";
import { RequestBudget } from "../src/venues/request-budget.js";
import { VenueRateLimitedError } from "../src/venues/transient.js";

function budget(options: { defaultCooldownMs?: number; maxCooldownMs?: number } = {}) {
  let now = 1_000_000;
  const b = new RequestBudget({ now: () => now, ...options });
  return { b, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe("request budget windows", () => {
  it("charges up to capacity and protects the reserve for priority callers", () => {
    const { b } = budget();
    b.window("update", { capacity: 5, windowMs: 10_000, reserve: 2 });
    expect([1, 2, 3].map(() => b.tryAcquire("update"))).toEqual([true, true, true]);
    expect(b.tryAcquire("update")).toBe(false);
    expect(b.tryAcquire("update", { priority: true })).toBe(true);
    expect(b.tryAcquire("update", { priority: true })).toBe(true);
    expect(b.tryAcquire("update", { priority: true })).toBe(false);
    expect(b.stats().update).toMatchObject({ used: 5, capacity: 5, blockedMs: 0 });
  });

  it("frees charges as they leave the sliding window", () => {
    const { b, advance } = budget();
    b.window("update", { capacity: 2, windowMs: 10_000 });
    expect(b.tryAcquire("update")).toBe(true);
    advance(4_000);
    expect(b.tryAcquire("update")).toBe(true);
    expect(b.tryAcquire("update")).toBe(false);
    expect(b.retryInMs("update")).toBe(6_000);
    advance(6_000);
    expect(b.tryAcquire("update")).toBe(true);
    expect(b.tryAcquire("update")).toBe(false);
    advance(4_000);
    expect(b.tryAcquire("update")).toBe(true);
  });

  it("acquire throws a transient rate-limit error carrying the wait", () => {
    const { b } = budget();
    b.window("update", { capacity: 1, windowMs: 10_000 });
    b.acquire("update");
    let caught: unknown;
    try { b.acquire("update"); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(VenueRateLimitedError);
    expect((caught as VenueRateLimitedError).retryAfterMs).toBe(10_000);
    expect((caught as VenueRateLimitedError).family).toBe("update");
  });

  it("families without a window only honour cooldowns", () => {
    const { b } = budget();
    expect(b.tryAcquire("orders")).toBe(true);
    expect(b.tryAcquire("orders")).toBe(true);
    expect(b.blockedFor("orders")).toBe(0);
  });

  it("rejects invalid windows", () => {
    const { b } = budget();
    expect(() => b.window("x", { capacity: 0, windowMs: 1 })).toThrow();
    expect(() => b.window("x", { capacity: 2, windowMs: 1, reserve: 2 })).toThrow();
  });
});

describe("request budget cooldowns", () => {
  it("fails fast while a family is on cooldown and honours the venue's retry hint", async () => {
    const { b, advance } = budget();
    const calls: number[] = [];
    const limited = Object.assign(new Error("rate limited"), { name: "RateLimitError", retryAfter: 2 });
    await expect(b.run("positions", async () => { calls.push(1); throw limited; })).rejects.toBe(limited);
    expect(b.blockedFor("positions")).toBe(5_000);
    await expect(b.run("positions", async () => { calls.push(2); return "unreachable"; })).rejects.toBeInstanceOf(VenueRateLimitedError);
    expect(calls).toEqual([1]);
    expect(b.blockedFor("balances")).toBe(0);
    advance(5_000);
    await expect(b.run("positions", async () => "ok")).resolves.toBe("ok");
  });

  it("uses the larger of the venue hint and the local backoff, doubling per consecutive limit up to the ceiling", () => {
    const { b, advance } = budget({ defaultCooldownMs: 1_000, maxCooldownMs: 4_000 });
    b.noteRateLimited("orders", Object.assign(new Error("x"), { retryAfter: 3 }));
    expect(b.blockedFor("orders")).toBe(3_000);
    advance(3_000);
    b.noteRateLimited("orders");
    expect(b.blockedFor("orders")).toBe(2_000);
    advance(2_000);
    b.noteRateLimited("orders");
    expect(b.blockedFor("orders")).toBe(4_000);
    advance(4_000);
    b.noteRateLimited("orders");
    expect(b.blockedFor("orders")).toBe(4_000);
    // A limit long after the last cooldown starts a fresh streak.
    advance(4_000 + 9_000);
    b.noteRateLimited("orders");
    expect(b.blockedFor("orders")).toBe(1_000);
  });

  it("a limit during an active cooldown extends it without lengthening the streak", () => {
    const { b, advance } = budget({ defaultCooldownMs: 1_000, maxCooldownMs: 8_000 });
    b.noteRateLimited("orders");
    advance(500);
    b.noteRateLimited("orders", Object.assign(new Error("x"), { retryAfter: 2 }));
    expect(b.blockedFor("orders")).toBe(2_000);
    expect(b.stats().orders.streak).toBe(1);
  });

  it("does not note non-rate-limit failures", async () => {
    const { b } = budget();
    await expect(b.run("book", async () => { throw Object.assign(new Error("gone"), { status: 503 }); })).rejects.toThrow("gone");
    expect(b.blockedFor("book")).toBe(0);
  });
});

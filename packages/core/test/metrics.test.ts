// packages/core/test/metrics.test.ts
import { describe, expect, it } from "vitest";
import { MetricsRegistry, boundFetch, instrumentVenueAdapter } from "@quotient-forecasting/cassie-core";

describe("MetricsRegistry", () => {
  it("accumulates totals and interval deltas separately", () => {
    let t = 1_000;
    const registry = new MetricsRegistry({ now: () => t });
    registry.record("polymarket.book", { ok: true, ms: 10 });
    registry.record("polymarket.book", { ok: false, ms: 30, error: "boom" });
    t = 2_000;
    registry.record("http.api.test", { ok: true, ms: 5 });

    expect(registry.snapshot()).toEqual({
      "http.api.test": { calls: 1, errors: 0, totalMs: 5, maxMs: 5 },
      "polymarket.book": { calls: 2, errors: 1, totalMs: 40, maxMs: 30, lastError: "boom", lastErrorAt: 1_000 },
    });

    const first = registry.takeInterval();
    expect(first).toEqual([
      { key: "http.api.test", calls: 1, errors: 0, totalMs: 5, maxMs: 5 },
      { key: "polymarket.book", calls: 2, errors: 1, totalMs: 40, maxMs: 30 },
    ]);
    expect(registry.peekInterval()).toEqual([]);
    registry.record("polymarket.book", { ok: true, ms: 7 });
    expect(registry.peekInterval()).toEqual([{ key: "polymarket.book", calls: 1, errors: 0, totalMs: 7, maxMs: 7 }]);
    expect(registry.snapshot()["polymarket.book"]!.calls).toBe(3);
  });

  it("truncates long errors and treats bad durations as zero", () => {
    const registry = new MetricsRegistry();
    registry.record("k", { ok: false, ms: Number.NaN, error: "x".repeat(400) });
    const counter = registry.snapshot().k!;
    expect(counter.totalMs).toBe(0);
    expect(counter.lastError!.length).toBe(200);
  });

  it("folds keys beyond the cap into <prefix>.other", () => {
    const registry = new MetricsRegistry({ maxKeys: 2 });
    registry.record("venue.a", { ok: true, ms: 1 });
    registry.record("venue.b", { ok: true, ms: 1 });
    registry.record("venue.c", { ok: true, ms: 1 });
    registry.record("venue.d", { ok: false, ms: 1 });
    expect(Object.keys(registry.snapshot())).toEqual(["venue.a", "venue.b", "venue.other"]);
    expect(registry.snapshot()["venue.other"]).toMatchObject({ calls: 2, errors: 1 });
  });
});

class FakeAdapter {
  id = "polymarket";
  verifiedAgainst = "2026-01-01";
  supportsNativeTriggers = false;
  #secret = 41;
  calls: string[] = [];
  get answer(): number {
    return this.#secret + 1;
  }
  normalizeOrderSize(size: number): number {
    return Math.floor(size);
  }
  async book(ref: string): Promise<{ ref: string; self: unknown }> {
    this.calls.push(`book:${ref}`);
    return { ref, self: this };
  }
  async quote(ref: string): Promise<{ ref: string }> {
    const b = await this.book(ref);
    return { ref: b.ref };
  }
  async fails(): Promise<never> {
    throw new Error("venue down");
  }
  throwsSync(): never {
    throw new Error("sync boom");
  }
  fills?: (since: number) => Promise<number[]>;
}

describe("instrumentVenueAdapter", () => {
  it("counts async methods under <id>.<method> and keeps this on the target", async () => {
    const registry = new MetricsRegistry();
    const target = new FakeAdapter();
    const proxy = instrumentVenueAdapter(target, registry);
    const res = await proxy.book("m1");
    expect(res.self).toBe(target);
    await proxy.quote("m2");
    const snap = registry.snapshot();
    // quote() calls this.book() internally on the target, so book is counted once from outside.
    expect(snap["polymarket.book"]!.calls).toBe(1);
    expect(snap["polymarket.quote"]!.calls).toBe(1);
    expect(target.calls).toEqual(["book:m1", "book:m2"]);
  });

  it("records rejections and sync throws, and rethrows", async () => {
    const registry = new MetricsRegistry();
    const proxy = instrumentVenueAdapter(new FakeAdapter(), registry);
    await expect(proxy.fails()).rejects.toThrow("venue down");
    expect(() => proxy.throwsSync()).toThrow("sync boom");
    const snap = registry.snapshot();
    expect(snap["polymarket.fails"]).toMatchObject({ calls: 1, errors: 1, lastError: "venue down" });
    expect(snap["polymarket.throwsSync"]).toMatchObject({ calls: 1, errors: 1, lastError: "sync boom" });
  });

  it("passes through props, getters, private fields, sync results and absent optional methods", () => {
    const registry = new MetricsRegistry();
    const proxy = instrumentVenueAdapter(new FakeAdapter(), registry);
    expect(proxy.id).toBe("polymarket");
    expect(proxy.verifiedAgainst).toBe("2026-01-01");
    expect(proxy.supportsNativeTriggers).toBe(false);
    expect(proxy.answer).toBe(42);
    expect(proxy.normalizeOrderSize(2.9)).toBe(2);
    expect(proxy.fills).toBeUndefined();
    expect("fills" in proxy).toBe(true);
    expect(proxy.fills?.(0)).toBeUndefined();
    expect(registry.snapshot()).toEqual({});
  });

  it("resolves reassigned methods at call time and keeps wrapper identity stable", async () => {
    const registry = new MetricsRegistry();
    const target = new FakeAdapter();
    const proxy = instrumentVenueAdapter(target, registry);
    proxy.fills = async (since: number) => [since];
    const bound = proxy.fills.bind(proxy);
    expect(await bound(7)).toEqual([7]);
    expect(proxy.fills).toBe(proxy.fills);
    expect(proxy.book).toBe(proxy.book);
    expect(registry.snapshot()["polymarket.fills"]!.calls).toBe(1);
  });

  it("uses an explicit prefix when given", async () => {
    const registry = new MetricsRegistry();
    const proxy = instrumentVenueAdapter(new FakeAdapter(), registry, "fixture");
    await proxy.book("x");
    expect(Object.keys(registry.snapshot())).toEqual(["fixture.book"]);
  });
});

describe("boundFetch metrics", () => {
  const okFetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  const badFetch = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
  const downFetch = (async () => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;

  it("counts by hostname only", async () => {
    const registry = new MetricsRegistry();
    await boundFetch(okFetch, registry)("https://api.example.test/v1/secret?token=abc");
    await boundFetch(badFetch, registry)(new URL("https://api.example.test/other"));
    await expect(boundFetch(downFetch, registry)(new Request("https://down.example.test/x"))).rejects.toThrow("ECONNRESET");
    const snap = registry.snapshot();
    expect(Object.keys(snap)).toEqual(["http.api.example.test", "http.down.example.test"]);
    expect(snap["http.api.example.test"]).toMatchObject({ calls: 2, errors: 1, lastError: "HTTP 503" });
    expect(snap["http.down.example.test"]).toMatchObject({ calls: 1, errors: 1, lastError: "ECONNRESET" });
    expect(JSON.stringify(snap)).not.toContain("secret");
  });

  it("stays uncounted when the registry is null", async () => {
    const registry = new MetricsRegistry();
    await boundFetch(okFetch, null)("https://api.example.test/");
    expect(registry.snapshot()).toEqual({});
  });
});

// packages/core/test/signals.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  FixtureSignalSource,
  LiveSignalSource,
  checkLiveSignalAccess,
  isSignalFresh,
  parseBotConfig,
  type Signal,
  type SignalSource,
} from "@quotient-forecasting/cassie-core";
import { signalsFixture } from "./helpers.js";

describe("FixtureSignalSource", () => {
  it("replays the sequenced fixture per tick cursor", async () => {
    const src = new FixtureSignalSource(signalsFixture);
    let sigs = await src.latest({ venue: "fixture" });
    expect(sigs.map((s) => s.id)).toEqual(["sig-entry-yes"]);

    src.advance(); // cursor 1 — still the atTick:0 entry
    sigs = await src.latest({ venue: "fixture" });
    expect(sigs.map((s) => s.id)).toEqual(["sig-entry-yes"]);

    src.advance(); // cursor 2 — the flip
    sigs = await src.latest({ venue: "fixture" });
    expect(sigs.map((s) => s.id)).toEqual(["sig-flip-no"]);
    expect(sigs[0]!.side).toBe("NO");
  });

  it("filters by venue and marketRef", async () => {
    const src = new FixtureSignalSource(signalsFixture);
    expect(await src.latest({ venue: "polymarket" })).toEqual([]);
    expect(await src.latest({ venue: "fixture", marketRef: "not-a-market" })).toEqual([]);
    expect((await src.latest({ venue: "fixture", marketRef: "fx-yes-1" })).length).toBe(1);
  });

  it("re-stamps ts so fixture signals are always fresh", async () => {
    const src = new FixtureSignalSource(signalsFixture);
    const [sig] = await src.latest({ venue: "fixture" });
    expect(isSignalFresh(sig!, Date.now())).toBe(true);
  });
});

describe("isSignalFresh", () => {
  const base: Signal = {
    id: "s",
    ts: new Date(Date.now() - 1_000).toISOString(),
    venue: "fixture",
    marketRef: "m",
    side: "YES",
    refPrice: 0.5,
    ttlSec: 600,
  };
  it("is true within ttl and false past it", () => {
    const now = Date.now();
    expect(isSignalFresh(base, now)).toBe(true);
    expect(isSignalFresh({ ...base, ts: new Date(now - 601_000).toISOString() }, now)).toBe(false);
  });
  it("is false for an unparseable timestamp", () => {
    expect(isSignalFresh({ ...base, ts: "not-a-date" }, Date.now())).toBe(false);
  });
});

describe("signal configuration", () => {
  it("defaults live signal freshness to three hours", () => {
    const cfg = parseBotConfig({ id: "default-freshness", venue: "polymarket" });
    expect(cfg.signals.maxAgeSec).toBe(3 * 60 * 60);
  });

  it("has no configurable source and rejects the old fixture pseudo-source", () => {
    const cfg = parseBotConfig({ id: "live-signals", venue: "polymarket", signals: { source: "live" } });
    expect(cfg.signals).not.toHaveProperty("source");
    expect(() =>
      parseBotConfig({ id: "fixture-signals", venue: "polymarket", signals: { source: "fixture" } }),
    ).toThrow();
    expect(() =>
      parseBotConfig({ id: "fixture-path", venue: "polymarket", signals: { fixturePath: "signals.json" } }),
    ).toThrow();
  });

  it("rejects the fixture test double as a bot venue", () => {
    expect(() => parseBotConfig({ id: "fixture-venue", venue: "fixture" })).toThrow();
  });
});

describe("LiveSignalSource (gateway contract, verified 2026-08-13)", () => {
  const gatewayRow = {
    id: "gw-1",
    side: "YES",
    latest_q: 0.86,
    current_cost_cents: 78,
    entry_spread_pp: 12,
    forecast_updated_at: new Date().toISOString(),
    published_at: new Date().toISOString(),
    is_active: true,
    market: { venue: "polymarket", condition_id: "0xcond1" },
  };
  const clobMarket = {
    tokens: [
      { token_id: "111", outcome: "Yes" },
      { token_id: "222", outcome: "No" },
    ],
  };

  /** Routes gateway vs CLOB token-resolution requests. */
  function routedFetch(rows: unknown[] = [gatewayRow]) {
    return vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/markets/")) return new Response(JSON.stringify(clobMarket), { status: 200 });
      return new Response(JSON.stringify({ signals: rows }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("sends only the API key header — no query params, no account state", async () => {
    const fetchImpl = routedFetch();
    const src = new LiveSignalSource({ baseUrl: "https://gw.example", path: "/api/v1/signals" }, "tok-123", fetchImpl);
    const sigs = await src.latest({ venue: "polymarket" });
    expect(sigs).toHaveLength(1);
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const url = new URL(String(call[0]));
    expect(url.origin + url.pathname).toBe("https://gw.example/api/v1/signals");
    expect([...url.searchParams.keys()]).toEqual([]);
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-quotient-api-key"]).toBe("tok-123");
    expect(headers.authorization).toBeUndefined();
  });

  it("preflights gateway auth without resolving venue markets", async () => {
    const fetchImpl = routedFetch();
    await expect(
      checkLiveSignalAccess({ baseUrl: "https://gw.example", path: "/api/v1/signals" }, "tok-123", fetchImpl),
    ).resolves.toEqual({ count: 1 });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("maps a gateway row: condition → YES token, side-adjusted prob, cents → price", async () => {
    const src = new LiveSignalSource({ baseUrl: "https://gw.example", path: "/s" }, "t", routedFetch());
    const [sig] = await src.latest({});
    expect(sig).toMatchObject({
      id: "gw-1",
      venue: "polymarket",
      marketRef: "111", // YES token resolved from condition_id
      side: "YES",
      prob: 0.86,
      refPrice: 0.78,
      ttlSec: 10_800,
    });
    expect(sig!.spreadPp).toBeCloseTo(8, 5); // |86 − 78|
  });

  it("allows a per-bot freshness override", async () => {
    const src = new LiveSignalSource(
      { baseUrl: "https://gw.example", path: "/s", maxAgeSec: 900 },
      "t",
      routedFetch(),
    );
    const [sig] = await src.latest({});
    expect(sig!.ttlSec).toBe(900);
  });

  it("mirrors prob for NO-side signals", async () => {
    const noRow = { ...gatewayRow, id: "gw-no", side: "NO", latest_q: 0.3, current_cost_cents: 60 };
    const src = new LiveSignalSource({ baseUrl: "https://gw.example", path: "/s" }, "t", routedFetch([noRow]));
    const [sig] = await src.latest({});
    expect(sig!.prob).toBeCloseTo(0.7, 9); // 1 − latest_q
    expect(sig!.refPrice).toBe(0.6);
  });

  it("drops inactive rows and unknown venues", async () => {
    const rows = [
      { ...gatewayRow, id: "dead", is_active: false },
      { ...gatewayRow, id: "kalshi", market: { venue: "kalshi", condition_id: "0xcond1" } },
      gatewayRow,
    ];
    const src = new LiveSignalSource({ baseUrl: "https://gw.example", path: "/s" }, "t", routedFetch(rows));
    expect((await src.latest({})).map((s) => s.id)).toEqual(["gw-1"]);
  });

  it("caches condition→token resolution across calls", async () => {
    const fetchImpl = routedFetch();
    const src = new LiveSignalSource({ baseUrl: "https://gw.example", path: "/s" }, "t", fetchImpl);
    await src.latest({});
    await src.latest({});
    const clobCalls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes("/markets/"),
    );
    expect(clobCalls).toHaveLength(1);
  });

  it("rejects malformed payloads via zod", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ nope: true }), { status: 200 })) as typeof fetch;
    const src = new LiveSignalSource({ baseUrl: "https://x.example", path: "/s" }, "t", fetchImpl);
    await expect(src.latest({})).rejects.toThrow();
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const src = new LiveSignalSource({ baseUrl: "https://x.example", path: "/s" }, "t", fetchImpl);
    await expect(src.latest({})).rejects.toThrow(/signal API 500/);
  });

  it("has no surface that accepts account state (hard rule)", () => {
    const src: SignalSource = new LiveSignalSource({ baseUrl: "https://x.example", path: "/s" }, "t");
    // Compile-time: SignalQuery has only venue/marketRef. Excess properties are rejected.
    // @ts-expect-error — account state must not flow toward the signal API
    void (() => src.latest({ venue: "polymarket", equity: 10_000 }));
    // Runtime: the public surface is exactly `latest`.
    const publicMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(src)).filter((n) => n !== "constructor");
    expect(publicMethods).toEqual(["latest"]);
    expect(src.latest.length).toBe(1);
  });
});

describe("LiveSignalSource kalshi rows", () => {
  it("maps a kalshi row to its ticker without any CLOB resolution call", async () => {
    const kalshiRow = {
      id: "gw-k1",
      side: "NO",
      latest_q: 0.3,
      current_cost_cents: 40,
      forecast_updated_at: new Date().toISOString(),
      is_active: true,
      market: { venue: "kalshi", nativeMarketId: "KXFED-26SEP-T4.00" },
    };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ signals: [kalshiRow] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const src = new LiveSignalSource({ baseUrl: "https://gw.example", path: "/s" }, "t", fetchImpl);
    const sigs = await src.latest({ venue: "kalshi" });
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({
      venue: "kalshi",
      marketRef: "KXFED-26SEP-T4.00",
      side: "NO",
      prob: 0.7, // NO-side expression of latest_q 0.3
      refPrice: 0.4,
    });
    // one gateway call, zero market-resolution calls
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

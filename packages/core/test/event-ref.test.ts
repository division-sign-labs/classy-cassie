// packages/core/test/event-ref.test.ts
// Venue parent-event identity: canonical venue fields, namespaced refs,
// positive-result caching, and soft failure when metadata is unavailable.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FixtureVenue,
  KalshiAdapter,
  PolymarketAdapter,
  VenueUrlsSchema,
} from "@quotient-forecasting/cassie-core";

const urls = VenueUrlsSchema.parse({});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("venue event refs", () => {
  it("resolves and caches the first direct Polymarket Gamma event id", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify([{ events: [{ id: "12345" }, { id: "other" }] }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const adapter = new PolymarketAdapter({ urls });

    await expect(adapter.eventRef("yes-token-1")).resolves.toBe("polymarket:12345");
    await expect(adapter.eventRef("yes-token-1")).resolves.toBe("polymarket:12345");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("https://gamma-api.polymarket.com/markets");
    expect(url.searchParams.get("clob_token_ids")).toBe("yes-token-1");
  });

  it("returns undefined for missing Polymarket event metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ events: [] }]), { status: 200 })));
    const adapter = new PolymarketAdapter({ urls });
    await expect(adapter.eventRef("not-an-event-id")).resolves.toBeUndefined();
  });

  it("resolves and caches Kalshi's explicit event_ticker", async () => {
    const calls: URL[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(new URL(String(input)));
      return new Response(JSON.stringify({ market: { event_ticker: "KXFED-26SEP" } }), { status: 200 });
    }) as typeof fetch;
    const adapter = new KalshiAdapter({ urls }, fetchImpl);

    await expect(adapter.eventRef("KXFED-26SEP-T4.00")).resolves.toBe("kalshi:KXFED-26SEP");
    await expect(adapter.eventRef("KXFED-26SEP-T4.00")).resolves.toBe("kalshi:KXFED-26SEP");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.pathname).toBe("/trade-api/v2/markets/KXFED-26SEP-T4.00");
  });

  it("returns undefined instead of deriving a Kalshi parent from its market ticker", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ market: {} }), { status: 200 })) as typeof fetch;
    const adapter = new KalshiAdapter({ urls }, fetchImpl);
    await expect(adapter.eventRef("KXFED-26SEP-T4.00")).resolves.toBeUndefined();
  });

  it("gives every fixture market a deterministic isolated parent", async () => {
    const adapter = new FixtureVenue({
      collateral: 100,
      markets: {
        "fx-yes-1": { volume24h: 50_000, book: { bids: [[0.49, 10]], asks: [[0.51, 10]] } },
      },
    });
    await expect(adapter.eventRef("fx-yes-1")).resolves.toBe("fixture:fx-yes-1");
  });
});

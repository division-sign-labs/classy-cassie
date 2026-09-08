// packages/runtime-node/test/commodity-data.test.ts
import { describe, expect, it, vi } from "vitest";
import { COMMODITY_ASSETS, CommodityConfigSchema, type CommodityAsset } from "../../core/src/strategies/kalshi-commodities.js";
import { CommodityDataSource, normalizeCommodityContract, normalizeCommodityLinks, COMMODITY_ASSET_KEYS } from "../src/commodity-data.js";

const NOW = Date.parse("2026-09-29T12:00:00Z"), HOUR = 3_600_000;
const config = CommodityConfigSchema.parse({ assets: [...COMMODITY_ASSETS] });
function fixture(asset: CommodityAsset = "gold", strike = asset === "btc" ? 79999.99 : asset === "oil" ? 89.99 : asset === "copper" ? 6.69 : asset === "silver" ? 79.99 : 4530.99) {
  const series = asset === "oil" ? "KXWTI" : asset === "btc" ? "KXBTCD" : `KX${asset.toUpperCase()}MON`;
  const event = `${series}-26SEP3017`, ticker = `${event}-T${strike}`, close = asset === "oil" ? "2026-09-30T18:30:00Z" : "2026-09-30T21:00:00Z";
  const source = asset === "oil" ? { name: "ICE", url: "https://www.theice.com/products/213/WTI-Crude-Futures" }
    : asset === "btc" ? { name: "CF Benchmarks", url: "https://www.cfbenchmarks.com/data/indices/BRTI?ref=x" }
    : { name: `Pyth - ${asset[0]!.toUpperCase()}${asset.slice(1)}`, url: `https://app.pyth.com/explore/${asset === "copper" ? "Commodities.Index.CU" : `Metal.Index.${asset.toUpperCase()}`}%2FUSD?returnUrl=x` };
  const primary = asset === "oil" ? `If the daily settlement price for WTI crude oil(November 2026 contract) on September 30, 2026 is above ${strike} USD/Bbl, then the market resolves to Yes.`
    : asset === "btc" ? `If the simple average of the sixty seconds of CF Benchmarks' Bitcoin Real-Time Index (BRTI) before 5 PM EDT is above ${strike} at 5 PM EDT on Sep 30, 2026, then the market resolves to Yes.`
    : `If the close price of the 1-minute candlestick for ${asset} on September 30, 2026 at 5:00 PM EDT is above ${strike} USD/${asset === "copper" ? "Lbs" : "t.oz"}, then the market resolves to Yes.`;
  const market = { ticker, event_ticker: event, market_type: "binary", status: "active", notional_value_dollars: "1.0000",
    close_time: close, open_time: "2026-09-01T10:00:00Z", expected_expiration_time: asset === "btc" ? "2026-09-30T21:05:00Z" : close,
    expiration_time: "2026-10-07T22:00:00Z", custom_strike: asset === "btc" ? undefined : { strike_date: close, front_month_contract: asset === "oil" ? "WBS 26X-ICE" : "N/A" },
    rules_primary: primary, rules_secondary: asset === "btc" ? "60 RTI prices are collected."
      : "The settlement value is rounded to the nearest 2 decimal places. The close is the end of the immediately preceding one-minute interval.",
    floor_strike: strike, cap_strike: undefined as number | undefined, strike_type: "greater", can_close_early: true,
    yes_bid_dollars: ".3000".replace(/^\./, "0."), yes_ask_dollars: "0.3500", price_level_structure: "linear_cent",
    price_ranges: [{ start: "0.0000", end: "1.0000", step: "0.0100" }], early_close_condition: "" };
  const terms = asset === "oil" ? "COMMODITYSETTLE" : asset === "btc" ? "BTC" : "COMMODITIES";
  const spec = { ticker: series, settlement_sources: [source], contract_terms_url: `https://assets.kalshi.com/contract_terms/${terms}.pdf`,
    fee_type: "quadratic", fee_multiplier: 1, last_updated_ts: "2026-09-01T17:50:00Z", product_metadata: {} };
  const linked = { venue: "kalshi", marketKey: `kalshi:${ticker}`, nativeMarketId: ticker, nativeEventId: event, seriesTicker: series,
    latest_q_probability: .65, forecast_at: new Date(NOW - HOUR).toISOString(), end_date: market.expected_expiration_time,
    has_forecast: true, market_odds: .325, relationships: { assets: [{ relationship: "HAS_MARKET", via: "direct", direction: "incoming", assetKey: COMMODITY_ASSET_KEYS[asset] }] } };
  const wire = { assets: [{ assetKey: COMMODITY_ASSET_KEYS[asset], linked_markets: [linked] }] };
  const link = normalizeCommodityLinks(wire, config.assets).links[0]!;
  return { market: { market }, series: { series: spec }, linked, wire, link };
}
const json = (value: unknown) => new Response(JSON.stringify(value));

describe("commodity settlement research boundary", () => {
  it.each(["oil", "gold", "btc", "copper", "silver"] as const)("binds current %s source and the actual close, not expiry", asset => {
    const f = fixture(asset), c = normalizeCommodityContract(f.link, f.market, f.series, NOW);
    expect(c).toMatchObject({ asset, verified: true, closeAt: Date.parse(f.market.market.close_time), qYes: .65, takerFeeRate: .07, makerFeeRate: 0 });
    expect(typeof c).toBe("object");
  });
  it("rejects a causal link, conflicting ticker, duplicate asset link, or missing Q", () => {
    const f = fixture(); f.linked.relationships.assets[0]!.relationship = "AFFECTS";
    expect(normalizeCommodityLinks(f.wire, config.assets).links).toEqual([]);
    const g = fixture(); g.linked.marketKey = "kalshi:other";
    expect(normalizeCommodityLinks(g.wire, config.assets).links).toEqual([]);
    const h = fixture(); h.wire.assets[0]!.linked_markets.push(structuredClone(h.linked));
    expect(normalizeCommodityLinks(h.wire, config.assets).links).toEqual([]);
    const j = fixture(); j.linked.has_forecast = false;
    expect(normalizeCommodityLinks(j.wire, config.assets).links).toEqual([]);
    const k = fixture(); Object.assign(k.linked, { forecast_status: { state: "new-unknown-status" } });
    expect(normalizeCommodityLinks(k.wire, config.assets).links).toEqual([]);
  });
  it("does not treat a terminal early-close flag as a barrier", () => {
    const f = fixture(); expect(f.market.market.can_close_early).toBe(true);
    expect(normalizeCommodityContract(f.link, f.market, f.series, NOW)).toMatchObject({ verified: true });
    f.market.market.early_close_condition = "This market closes when the price criterion is met.";
    expect(normalizeCommodityContract(f.link, f.market, f.series, NOW)).toBe("path-dependent market excluded");
  });
  it("rejects obsolete futures copper, spoofed feed hosts, and unknown fee schedules", () => {
    const f = fixture("copper"); f.market.market.custom_strike!.front_month_contract = "HG 26Z-COMEX";
    expect(normalizeCommodityContract(f.link, f.market, f.series, NOW)).toBe("metal index candle rule unrecognized");
    const g = fixture(); g.series.series.settlement_sources[0]!.url = "https://app.pyth.com.evil.test/explore/Metal.Index.GOLD%2FUSD";
    expect(normalizeCommodityContract(g.link, g.market, g.series, NOW)).toBe("settlement source or terms changed");
    const h = fixture(); h.series.series.fee_type = "flat";
    expect(normalizeCommodityContract(h.link, h.market, h.series, NOW)).toBe("fee schedule unrecognized");
  });
  it("checks oil contract month instead of assuming all WTI prices match", () => {
    const f = fixture("oil"); f.market.market.custom_strike!.front_month_contract = "WBS 26V-ICE";
    expect(normalizeCommodityContract(f.link, f.market, f.series, NOW)).toBe("oil contract month unverified");
  });
  it("rejects wrong fixing minutes and arbitrary catalog offsets but accepts BTC's documented five minutes", () => {
    const f = fixture(); f.market.market.custom_strike!.strike_date = "2026-09-30T21:01:00Z";
    expect(normalizeCommodityContract(f.link, f.market, f.series, NOW)).toBe("fixing and close disagree");
    const g = fixture("btc"); g.link.endAt += 60_000;
    expect(normalizeCommodityContract(g.link, g.market, g.series, NOW)).toBe("catalog and venue fixing disagree");
    const h = fixture(); h.market.market.rules_primary = h.market.market.rules_primary.replace("5:00 PM", "4:59 PM");
    expect(normalizeCommodityContract(h.link, h.market, h.series, NOW)).toBe("settlement rules or fixing clock unrecognized");
  });
  it.each(["and", "to", "-"])("matches exact range bounds with venue separator %s", separator => {
    const f = fixture("oil"); f.market.market.strike_type = "between"; f.market.market.cap_strike = 90.99;
    f.market.market.rules_primary = f.market.market.rules_primary.replace("above 89.99", `between 89.99${separator === "-" ? "-" : ` ${separator} `}90.99`);
    expect(normalizeCommodityContract(f.link, f.market, f.series, NOW)).toMatchObject({ strikeType: "between", floor: 89.99, cap: 90.99 });
    f.market.market.cap_strike = 99.99;
    expect(normalizeCommodityContract(f.link, f.market, f.series, NOW)).toBe("strike rules disagree with numeric bounds");
  });
  it("requires the forecast to follow source metadata changes", () => {
    const f = fixture(); f.series.series.last_updated_ts = new Date(NOW).toISOString();
    expect(normalizeCommodityContract(f.link, f.market, f.series, NOW)).toBe("forecast predates current series metadata");
  });
});

describe("commodity research transport", () => {
  it("batches five canonical references, caches concurrent reads, and keeps tokens off Kalshi", async () => {
    const f = fixture(), calls: { url: URL; init?: RequestInit }[] = [], usage: unknown[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)); calls.push({ url, init });
      if (url.pathname.endsWith("assets/search")) return json(f.wire);
      if (url.pathname.endsWith("price-outlooks")) return json({ as_of: new Date(NOW).toISOString(), series: [{ asset_key: "commodity:gold", basis_groups: [{ outlook: { median_price: 999999 } }] }] });
      if (url.pathname.includes("/series/")) return json(f.series);
      return json(f.market);
    });
    const source = new CommodityDataSource({ config, baseUrl: "https://quotient.test", token: "test-only", fetchImpl, now: () => NOW, onUsage: u => usage.push(u) });
    const [a, b] = await Promise.all([source.snapshot(), source.snapshot()]);
    expect(a).toEqual(b); expect(a.contracts).toHaveLength(1); expect(a.contracts[0]!.qYes).toBe(.65);
    expect(calls[0]!.url.searchParams.getAll("reference")).toEqual(Object.values(COMMODITY_ASSET_KEYS));
    expect(calls).toHaveLength(4); expect(usage).toHaveLength(2);
    for (const c of calls.filter(c => c.url.hostname !== "quotient.test")) expect(new Headers(c.init?.headers).has("x-quotient-api-key")).toBe(false);
    const signals = await source.latest({}); expect(signals[0]).toMatchObject({ prob: .65, side: "YES", settlementBasis: a.contracts[0]!.settlementBasis, rulesHash: a.contracts[0]!.rulesHash });
    expect(calls).toHaveLength(4);
    a.contracts.length = 0; expect((await source.snapshot()).contracts).toHaveLength(1);
  });
  it("selects six central nearest contracts without ranking by Q edge", async () => {
    const f = fixture(), all = Array.from({ length: 8 }, (_, i) => fixture("gold", 4500 + i));
    all.forEach((g, i) => { g.linked.market_odds = .5 + i * .01; g.linked.latest_q_probability = i === 7 ? .99 : .51; });
    const calls: string[] = [];
    const source = new CommodityDataSource({ config, baseUrl: "https://quotient.test", token: "test-only", now: () => NOW,
      fetchImpl: vi.fn(async input => { const url = new URL(String(input)); calls.push(url.pathname);
        if (url.pathname.endsWith("assets/search")) return json({ assets: [{ assetKey: "commodity:gold", linked_markets: all.map(x => x.linked) }] });
        if (url.pathname.endsWith("price-outlooks")) return json({ series: [] });
        if (url.pathname.includes("/series/")) return json(f.series);
        return json(all.find(x => url.pathname.endsWith(x.linked.nativeMarketId))!.market); }),
    });
    const snapshot = await source.snapshot(); expect(snapshot.contracts).toHaveLength(6);
    expect(snapshot.contracts.some(c => c.qYes === .99)).toBe(false);
    expect(calls.filter(p => p.includes("/markets/"))).toHaveLength(6);
  });
  it("rechecks free venue terms every five minutes while paid Q and outlooks use separate clocks", async () => {
    const f = fixture(); let now = NOW;
    const calls: string[] = [];
    const source = new CommodityDataSource({ config, baseUrl: "https://quotient.test", token: "test-only", now: () => now,
      fetchImpl: vi.fn(async input => { const url = new URL(String(input)); calls.push(url.pathname);
        if (url.pathname.endsWith("assets/search")) return json(f.wire);
        if (url.pathname.endsWith("price-outlooks")) return json({ series: [] });
        if (url.pathname.includes("/series/")) return json(f.series);
        return json(f.market); }),
    });
    await source.snapshot(); now += 300_001; await source.snapshot();
    expect(calls.filter(p => p.endsWith("assets/search"))).toHaveLength(1);
    expect(calls.filter(p => p.endsWith("price-outlooks"))).toHaveLength(1);
    expect(calls.filter(p => p.includes("/series/"))).toHaveLength(2);
    now = NOW + 30 * 60_000 + 1; const next = await source.snapshot();
    expect(calls.filter(p => p.endsWith("assets/search"))).toHaveLength(2);
    expect(calls.filter(p => p.endsWith("price-outlooks"))).toHaveLength(1);
    expect(next.contracts[0]!.forecastAt).toBe(NOW - HOUR);
  });
  it("retains closed metadata without emitting an entry and never uses outlooks as Q fallback", async () => {
    const f = fixture(); let now = NOW, empty = false;
    const source = new CommodityDataSource({ config, baseUrl: "https://quotient.test", token: "test-only", now: () => now,
      fetchImpl: vi.fn(async input => { const url = new URL(String(input));
        if (url.pathname.endsWith("assets/search")) return json(empty ? { assets: [] } : f.wire);
        if (url.pathname.endsWith("price-outlooks")) return json({ series: [{ asset_key: "commodity:gold", outlook: { probability: .99 } }] });
        if (url.pathname.includes("/series/")) return json(f.series);
        return json(f.market); }),
    });
    await source.snapshot(); now = Date.parse(f.market.market.close_time) + 1; empty = true;
    const snapshot = await source.snapshot(); expect(snapshot.contracts[0]).toMatchObject({ verified: false, closeAt: now - 1, qYes: .65 });
    expect(await source.latest({})).toEqual([]);
  });
  it("surfaces an authoritative unsupported feed change as a new rules hash for existing inventory", async () => {
    const f = fixture(); let now = NOW;
    const source = new CommodityDataSource({ config, baseUrl: "https://quotient.test", token: "test-only", now: () => now,
      fetchImpl: vi.fn(async input => { const url = new URL(String(input));
        if (url.pathname.endsWith("assets/search")) return json(f.wire);
        if (url.pathname.endsWith("price-outlooks")) return json({ series: [] });
        if (url.pathname.includes("/series/")) return json(f.series);
        return json(f.market); }),
    });
    const first = await source.snapshot(); now += 300_001;
    f.series.series.settlement_sources[0]!.url = "https://app.pyth.com/explore/Metal.XAU%2FUSD";
    const second = await source.snapshot();
    expect(second.contracts[0]!.verified).toBe(false);
    expect(second.contracts[0]!.rulesHash).not.toBe(first.contracts[0]!.rulesHash);
    expect(second.contracts[0]!.rulesHash.startsWith("unverified:")).toBe(true);
    expect(await source.latest({})).toEqual([]);
  });
  it("fails closed on malformed paid data and honors Retry-After without replaying paid calls", async () => {
    let now = NOW;
    const fn = vi.fn(async () => new Response("not-authorized", { status: 429, headers: { "retry-after": "60" } }));
    const source = new CommodityDataSource({ config, baseUrl: "https://quotient.test", token: "test-only", now: () => now, fetchImpl: fn });
    await expect(source.snapshot()).rejects.toThrow("HTTP 429");
    await expect(source.snapshot()).rejects.toThrow("Retry-After"); expect(fn).toHaveBeenCalledTimes(1);
    now += 60_001; await expect(source.snapshot()).rejects.toThrow("HTTP 429"); expect(fn).toHaveBeenCalledTimes(2);
  });
  it("does not stamp stale cached Q fresh when an essential paid refresh fails", async () => {
    const f = fixture(); let now = NOW, failing = false, assetRequests = 0;
    const source = new CommodityDataSource({ config, baseUrl: "https://quotient.test", token: "test-only", now: () => now,
      fetchImpl: vi.fn(async input => { const url = new URL(String(input));
        if (url.pathname.endsWith("assets/search")) { assetRequests++; return failing ? new Response("down", { status: 503 }) : json(f.wire); }
        if (url.pathname.endsWith("price-outlooks")) return json({ series: [] });
        if (url.pathname.includes("/series/")) return json(f.series);
        return json(f.market); }),
    });
    await source.snapshot(); now += 30 * 60_000 + 1; failing = true;
    await expect(source.snapshot()).rejects.toThrow("HTTP 503");
    expect(source.refreshedAt()).toBe(NOW);
    await expect(source.latest({})).rejects.toThrow("Retry-After");
    expect(assetRequests).toBe(2);
  });
});

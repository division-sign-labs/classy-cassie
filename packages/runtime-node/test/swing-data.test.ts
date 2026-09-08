// packages/runtime-node/test/swing-data.test.ts
import { describe, expect, it, vi } from "vitest";
import { SwingQuotientDataClient, normalizeSwingAssets, normalizeSwingOutlooks, type SwingQuotientUsage } from "../src/swing-data.js";

const NOW = Date.parse("2026-09-04T12:00:00Z"), HOUR = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();
function directory() {
  return { assets: [
    { assetKey: "commodity:wti", name: "WTI", asset_type: "commodity", identifiers: [{ platform: "hyperliquid", kind: "coin", value: "xyz:CL" }] },
    { assetKey: "company:nvda", name: "NVIDIA", asset_type: "company", identifiers: [{ platform: "hyperliquid", kind: "coin", value: "xyz:NVDA" }] },
  ] };
}
function reference() {
  return { provider: "hyperliquid", instrument_id: "xyz:CL", symbol: "xyz:CL", basis_id: "basis:wti",
    mapping_status: "verified", unit: "quote-per-unit", currency: "USD", price_field: "mid", session: "continuous",
    window: "point", timezone: "UTC", value_kind: "observed", freshness: "verified", value: 70, observed_at: iso(NOW - 60_000),
    contract_month: null, roll_rule: null, candle_interval: null, rounding: null };
}
function group(hours = 48) {
  return { basis_id: "basis:wti", target_family_key: "family:wti:point", basis_status: "verified", grounding_status: "actionable",
    resolution_reference: reference(), execution_reference: reference(), provenance: { input_hash: "hash:input" },
    outlook: { outlook_id: `outlook:${hours}`, anchor_at: iso(NOW + hours * HOUR), published_at: iso(NOW - 30_000), observed_at: iso(NOW - 60_000),
      status: "active", freshness_state: "fresh", freshness_reason: null as string | null,
      spot_at_obs: 70, median_price: 71, p10: 65, p25: 68, p75: 74, p90: 78, sigma_total: 0.06, spot_gap_sigma: 0.2362 as number | undefined,
      directional_take: { method: "full_quantile_curve", range_status: "complete", side: "bullish", is_price_signal: false,
        expected_price: 71.5, expected_log_return: 0.02, score_sigma: 0.31 as number | undefined, probability_above_spot: 0.58 as number | undefined },
      audit: { version: "price-outlook-audit/1", q_sources: "garbage" } as unknown } };
}
function wire(hours = [6, 12, 24, 48, 120, 168]) {
  return { contract: "asset-price/1", as_of: iso(NOW), series: [{ asset_key: "commodity:wti", mode: "signal", basis_groups: hours.map(group) }] };
}
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe("swing Quotient identity and outlook normalization", () => {
  it("uses exact directory instruments, excluding crypto, namespace conflicts, and ambiguous mappings", () => {
    const input = directory();
    input.assets.push({ assetKey: "crypto:btc", name: "Bitcoin", asset_type: "company", identifiers: [{ platform: "hyperliquid", kind: "coin", value: "xyz:BTC" }] });
    input.assets.push({ assetKey: "commodity:fake", name: "Fake", asset_type: "company", identifiers: [{ platform: "hyperliquid", kind: "coin", value: "xyz:FAKE" }] });
    expect(normalizeSwingAssets(input).map(a => [a.assetKey, a.marketRef])).toEqual([["commodity:wti", "xyz:CL"], ["company:nvda", "xyz:NVDA"]]);
    input.assets[0]!.identifiers.push({ platform: "hyperliquid", kind: "coin", value: "xyz:OTHER" });
    expect(normalizeSwingAssets(input).map(a => a.assetKey)).toEqual(["company:nvda"]);
  });

  it("retains every >=6h original horizon and exact full-curve moments, not only primary/p50", () => {
    const result = normalizeSwingOutlooks(wire(), normalizeSwingAssets(directory()), NOW);
    expect(result.excluded).toEqual([]);
    expect(result.outlooks.map(o => (o.anchorAt - NOW) / HOUR)).toEqual([6, 12, 24, 48, 120, 168]);
    expect(result.outlooks[0]).toMatchObject({ expectedPrice: 71.5, expectedLogReturn: 0.02, medianPrice: 71, directionalSide: "bullish" });
  });

  it("maps the gap signal, take score, probability, freshness reason and series mode", () => {
    const input = wire([48]);
    input.series[0]!.basis_groups[0]!.outlook.freshness_reason = "pooled_interval_truncated";
    const o = normalizeSwingOutlooks(input, normalizeSwingAssets(directory()), NOW).outlooks[0]!;
    expect(o).toMatchObject({ spotGapSigma: 0.2362, scoreSigma: 0.31, probabilityAboveSpot: 0.58, freshnessReason: "pooled_interval_truncated", mode: "signal" });
    expect(o).not.toHaveProperty("sourceAudit");
    expect(o).not.toHaveProperty("audit");
  });

  it("leaves optional take fields null and ignores an audit object entirely", () => {
    const input = wire([48]);
    const take = input.series[0]!.basis_groups[0]!.outlook.directional_take;
    delete take.score_sigma; take.probability_above_spot = 1.5;
    input.series[0]!.basis_groups[0]!.outlook.audit = null;
    const result = normalizeSwingOutlooks(input, normalizeSwingAssets(directory()), NOW);
    expect(result.excluded).toEqual([]);
    expect(result.outlooks[0]).toMatchObject({ scoreSigma: null, probabilityAboveSpot: null, mode: "signal" });
    const bare = { contract: "asset-price/1", series: [{ asset_key: "commodity:wti", basis_groups: [group(48)] }] };
    expect(normalizeSwingOutlooks(bare, normalizeSwingAssets(directory()), NOW).outlooks[0]!.mode).toBeNull();
  });

  it("requires the gap signal and names the missing field without echoing values", () => {
    const input = wire([48]);
    delete input.series[0]!.basis_groups[0]!.outlook.spot_gap_sigma;
    const result = normalizeSwingOutlooks(input, normalizeSwingAssets(directory()), NOW);
    expect(result.outlooks).toEqual([]);
    expect(result.excluded).toEqual([{ assetKey: "commodity:wti", outlookId: "outlook:48", reason: "missing-full-curve-values: outlook.spot_gap_sigma" }]);
  });

  it("never falls back to deprecated scalar outlook when basis_groups is empty", () => {
    const input = { contract: "asset-price/1", series: [{ asset_key: "commodity:wti", basis_groups: [], outlook: group().outlook }] };
    expect(normalizeSwingOutlooks(input, normalizeSwingAssets(directory()), NOW).outlooks).toEqual([]);
  });

  it.each([
    ["wrong instrument", (g: ReturnType<typeof group>) => { g.execution_reference.instrument_id = "xyz:NVDA"; }],
    ["wrong basis", (g: ReturnType<typeof group>) => { g.execution_reference.basis_id = "basis:other"; }],
    ["settlement estimate", (g: ReturnType<typeof group>) => { g.resolution_reference.value_kind = "estimated"; }],
    ["provider basis", (g: ReturnType<typeof group>) => { g.resolution_reference.provider = "pyth"; }],
    ["candle basis", (g: ReturnType<typeof group>) => { g.execution_reference.window = "close"; }],
    ["invented publication", (g: ReturnType<typeof group>) => { g.outlook.published_at = ""; }],
    ["timezone missing", (g: ReturnType<typeof group>) => { g.outlook.observed_at = "2026-09-04T11:00:00"; }],
    ["future publication", (g: ReturnType<typeof group>) => { g.outlook.published_at = iso(NOW + 1); }],
    ["point-only fallback", (g: ReturnType<typeof group>) => { g.outlook.directional_take.method = "published_percentiles"; }],
    ["missing published direction", (g: ReturnType<typeof group>) => { g.outlook.directional_take.side = ""; }],
  ])("rejects %s without inferred replacement", (_name, mutate) => {
    const input = wire([48]); mutate(input.series[0]!.basis_groups[0]!);
    expect(normalizeSwingOutlooks(input, normalizeSwingAssets(directory()), NOW).outlooks).toEqual([]);
  });

  it("rejects duplicate outlook IDs and leaves clamped range visible for the strategy gate", () => {
    const input = wire([48, 48]);
    expect(normalizeSwingOutlooks(input, normalizeSwingAssets(directory()), NOW).outlooks).toEqual([]);
    input.series[0]!.basis_groups.pop(); input.series[0]!.basis_groups[0]!.outlook.directional_take.range_status = "clamped";
    expect(normalizeSwingOutlooks(input, normalizeSwingAssets(directory()), NOW).outlooks[0]!.rangeStatus).toBe("clamped");
  });

  it("identifies the asset and rejected reference field without echoing its value", () => {
    const input = wire([48]);
    input.series[0]!.basis_groups[0]!.execution_reference.instrument_id = "server-value-not-for-logs";
    const result = normalizeSwingOutlooks(input, normalizeSwingAssets(directory()), NOW);
    expect(result.excluded).toEqual([{ assetKey: "commodity:wti", outlookId: "outlook:48",
      reason: "unverified-execution-basis: execution_reference.instrument_id" }]);
    expect(JSON.stringify(result)).not.toContain("server-value-not-for-logs");
  });
});

describe("bounded cached Quotient calls", () => {
  it("allows 45s for the whole outlook response while retaining 20s for other reads", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const fetchImpl = vi.fn(async (input: string | URL | Request) => jsonResponse(new URL(String(input)).pathname === "/api/v1/assets" ? directory() : wire())) as typeof fetch;
      const client = new SwingQuotientDataClient({ baseUrl: "https://q.example", token: "test-token", fetchImpl, now: () => NOW });
      await client.refresh();
      expect(timeout.mock.calls.map(args => args[0])).toEqual([20_000, 45_000]);
    } finally { timeout.mockRestore(); }
  });
  it("identifies timed-out outlooks, backs off without paid retries, and preserves cached receipt time", async () => {
    let now = NOW, fail = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (fail) throw new DOMException("private transport details", "TimeoutError");
      return jsonResponse(new URL(String(input)).pathname === "/api/v1/assets" ? directory() : wire());
    }) as typeof fetch;
    const client = new SwingQuotientDataClient({ baseUrl: "https://q.example", token: "test-token", fetchImpl, now: () => now });
    await client.refresh(); fail = true; now += HOUR;
    await expect(client.refresh()).rejects.toThrow("Quotient price-outlooks request timed out after 45s");
    await expect(client.refresh()).rejects.toThrow("Retry-After active until");
    expect(fetchImpl).toHaveBeenCalledTimes(3); expect(client.cached()!.receivedAt).toBe(NOW);
    now += 30_000;
    await expect(client.refresh()).rejects.toThrow("timed out after 45s");
    now += 59_999;
    await expect(client.refresh()).rejects.toThrow("Retry-After active until");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it.each([["ECONNRESET", " (ECONNRESET)"], ["private-token", ""]])("only exposes allowlisted transport cause %s", async (code, suffix) => {
    const fetchImpl = vi.fn(async () => { throw new Error("private-token URL and headers", { cause: { code } }); }) as typeof fetch;
    const client = new SwingQuotientDataClient({ baseUrl: "https://q.example", token: "test-token", fetchImpl, now: () => NOW });
    await expect(client.refresh()).rejects.toEqual(new Error(`Quotient assets request unavailable${suffix}`));
    try { await client.refresh(); } catch (error) { expect(String(error)).not.toContain("private-token"); }
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("caps repeated transport backoff at fifteen minutes", async () => {
    let now = NOW;
    const fetchImpl = vi.fn(async () => { throw new DOMException("timeout", "TimeoutError"); }) as typeof fetch;
    const client = new SwingQuotientDataClient({ baseUrl: "https://q.example", token: "test-token", fetchImpl, now: () => now });
    for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
      await expect(client.refresh()).rejects.toThrow("timed out after 20s");
      now += delay - 1;
      await expect(client.refresh()).rejects.toThrow("Retry-After active until");
      now += 1;
    }
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });
  it("classifies body timeouts as transport failures and records the successful paid response", async () => {
    const usage: SwingQuotientUsage[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const response = jsonResponse(new URL(String(input)).pathname === "/api/v1/assets" ? directory() : wire());
      if (new URL(String(input)).pathname === "/api/v1/price-outlooks") response.text = async () => { throw new DOMException("private body", "TimeoutError"); };
      return response;
    }) as typeof fetch;
    const client = new SwingQuotientDataClient({ baseUrl: "https://q.example", token: "test-token", fetchImpl, now: () => NOW, onUsage: v => usage.push(v) });
    await expect(client.refresh()).rejects.toThrow("Quotient price-outlooks request timed out after 45s");
    await expect(client.refresh()).rejects.toThrow("Retry-After active until");
    expect(client.cached()).toBeNull(); expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(usage.map(item => item.usd)).toEqual([0.005, 0.01]);
  });
  it("makes one whole-outlook request, dedupes concurrent refresh, caches directory, and meters without account fields", async () => {
    const urls: URL[] = [], usage: SwingQuotientUsage[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)); urls.push(url);
      expect(init?.headers).toEqual({ "x-quotient-api-key": "test-token", accept: "application/json" });
      expect(init?.body).toBeUndefined(); expect(init?.redirect).toBe("error");
      return jsonResponse(url.pathname === "/api/v1/assets" ? directory() : wire());
    }) as typeof fetch;
    const client = new SwingQuotientDataClient({ baseUrl: "https://q.example", token: "test-token", fetchImpl, now: () => NOW, onUsage: v => usage.push(v) });
    const [a, b] = await Promise.all([client.refresh(), client.refresh()]);
    expect(urls.map(u => u.pathname)).toEqual(["/api/v1/assets", "/api/v1/price-outlooks"]);
    expect(urls[1]!.search).toBe(""); expect(a).toEqual(b);
    a.outlooks.length = 0; expect(client.cached()!.outlooks).toHaveLength(6);
    await client.refresh(); expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(usage.map(v => v.usd)).toEqual([0.005, 0.01, 0.01]);
  });

  it("failed refresh does not freshen cached data or echo server secrets, and respects Retry-After", async () => {
    let now = NOW, fail = false, requests = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requests++;
      if (fail) return new Response("secret-account-header", { status: 429, headers: { "retry-after": "120" } });
      return jsonResponse(new URL(String(input)).pathname === "/api/v1/assets" ? directory() : wire());
    }) as typeof fetch;
    const client = new SwingQuotientDataClient({ baseUrl: "https://q.example", token: "test-token", fetchImpl, now: () => now });
    await client.refresh(); now += HOUR; fail = true;
    await expect(client.refresh()).rejects.toThrow("Quotient price-outlooks HTTP 429");
    await expect(client.refresh()).rejects.toThrow("Retry-After");
    expect(requests).toBe(3); expect(client.cached()!.receivedAt).toBe(NOW);
  });

  it("backs off repeated 429s even without a Retry-After header", async () => {
    let now = NOW;
    const fetchImpl = vi.fn(async () => new Response("not-logged", { status: 429 })) as typeof fetch;
    const client = new SwingQuotientDataClient({ baseUrl: "https://q.example", token: "test-token", fetchImpl, now: () => now });
    await expect(client.refresh()).rejects.toThrow("HTTP 429");
    now += 29_999;
    await expect(client.refresh()).rejects.toThrow("Retry-After active until");
    expect(fetchImpl).toHaveBeenCalledOnce();
    now += 1;
    await expect(client.refresh()).rejects.toThrow("HTTP 429");
    now += 59_999;
    await expect(client.refresh()).rejects.toThrow("Retry-After active until");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now += 1;
    await expect(client.refresh()).rejects.toThrow("HTTP 429");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

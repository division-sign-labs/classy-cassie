// packages/core/test/polymarket-user-agent.test.ts
import { describe, expect, it } from "vitest";
import { POLYMARKET_BROWSER_USER_AGENT, withPolymarketUserAgent } from "../src/venues/polymarket-user-agent.js";

function createRecorder() {
  const calls: Array<{ url: string; userAgent: string | null }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    calls.push({ url, userAgent: headers.get("user-agent") });
    return new Response("{}", { status: 200 });
  };
  return { calls, fetch: withPolymarketUserAgent(impl) };
}

describe("polymarket user agent", () => {
  it("sets a browser User-Agent on the trade endpoint the edge blocks", async () => {
    const { calls, fetch } = createRecorder();
    await fetch("https://clob.polymarket.com/data/trades?after=1789840038");
    expect(calls[0]!.userAgent).toBe(POLYMARKET_BROWSER_USER_AGENT);
  });

  it("covers every polymarket host, including the data and gamma APIs", async () => {
    const { calls, fetch } = createRecorder();
    for (const url of ["https://data-api.polymarket.com/positions", "https://gamma-api.polymarket.com/markets", "https://polymarket.com/api/geoblock"]) {
      await fetch(url);
    }
    expect(calls.map((call) => call.userAgent)).toEqual([
      POLYMARKET_BROWSER_USER_AGENT,
      POLYMARKET_BROWSER_USER_AGENT,
      POLYMARKET_BROWSER_USER_AGENT,
    ]);
  });

  it("leaves other hosts alone", async () => {
    const { calls, fetch } = createRecorder();
    await fetch("https://api.hyperliquid.xyz/info");
    expect(calls[0]!.userAgent).toBeNull();
  });

  it("keeps a User-Agent the caller set", async () => {
    const { calls, fetch } = createRecorder();
    await fetch("https://clob.polymarket.com/data/trades", { headers: { "user-agent": "cassie/1.0" } });
    expect(calls[0]!.userAgent).toBe("cassie/1.0");
  });

  it("reads the url and headers off a Request argument", async () => {
    const { calls, fetch } = createRecorder();
    await fetch(new Request("https://clob.polymarket.com/data/trades"));
    expect(calls[0]!.userAgent).toBe(POLYMARKET_BROWSER_USER_AGENT);
  });

  it("passes a malformed url through rather than throwing", async () => {
    const { calls, fetch } = createRecorder();
    await expect(fetch("not-a-url")).resolves.toBeInstanceOf(Response);
    expect(calls[0]!.userAgent).toBeNull();
  });

  it("is not fooled by a lookalike host", async () => {
    const { calls, fetch } = createRecorder();
    await fetch("https://polymarket.com.evil.test/data/trades");
    expect(calls[0]!.userAgent).toBeNull();
  });
});

// packages/core/src/venues/polymarket-user-agent.ts
// Polymarket's Cloudflare edge rejects non-browser user agents on the
// authenticated trade endpoints (`/trades`, `/data/trades`), answering
// `429 rate limit` before the request reaches the CLOB at all. The response
// carries none of the venue's documented rate-limit headers — no `Retry-After`,
// no `Poly-RateLimit-*` — and its body is a bare `rate limit` string rather
// than the documented JSON error, which is how an edge block is distinguishable
// from the CLOB's own limiter. Verified 2026-09-19: the same request from the
// same address returns 401 with a browser agent and 429 with Node's default.
//
// Backoff cannot clear it, so a blocked `listAccountTrades` latches the
// adapter's `orders` cooldown and starves open-order reads, order TTLs and
// supervision along with it. The agent has to change, not the cadence.
//
// The pinned `@polymarket/client` builds its own requests through the global
// `fetch` and exposes no hook for headers, so the agent is stamped globally and
// scoped by hostname: Polymarket hosts only, and never over a caller's own.

/** Chrome on macOS. Any mainstream browser agent passes; this one is verified against the edge. */
export const POLYMARKET_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function isPolymarketHost(input: Parameters<typeof fetch>[0]): boolean {
  let hostname: string;
  try {
    if (typeof input === "string") hostname = new URL(input).hostname;
    else if (input instanceof URL) hostname = input.hostname;
    else hostname = new URL((input as Request).url).hostname;
  } catch {
    return false;
  }
  return hostname === "polymarket.com" || hostname.endsWith(".polymarket.com");
}

/**
 * Wraps a fetch implementation so requests to Polymarket carry a browser agent.
 * Requests elsewhere, and any request that already sets its own agent, pass
 * through untouched.
 */
export function withPolymarketUserAgent(impl: typeof fetch): typeof fetch {
  return (input, init) => {
    if (!isPolymarketHost(input)) return impl(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.has("user-agent")) return impl(input, init);
    headers.set("user-agent", POLYMARKET_BROWSER_USER_AGENT);
    return impl(input, { ...init, headers });
  };
}

let installed = false;

/**
 * Installs the agent on the global fetch, once per process. Called when a
 * Polymarket adapter is constructed, so a bot on another venue never pays for it.
 */
export function installPolymarketUserAgent(): void {
  if (installed) return;
  installed = true;
  globalThis.fetch = withPolymarketUserAgent(globalThis.fetch);
}

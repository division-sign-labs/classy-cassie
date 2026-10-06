// packages/core/src/venues/polymarket-user-agent.ts
//
// Polymarket's Cloudflare edge answers `429 rate limit` to any non-browser
// User-Agent on `/trades` and `/data/trades`, before the request reaches the
// CLOB, so retrying and backing off never clear it (verified 2026-09-19).
// The pinned `@polymarket/client` builds its requests through the global
// `fetch` and takes no header option, which is why this replaces the global.

/** Any mainstream browser User-Agent passes the check; the exact value does not matter. */
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

export function withPolymarketUserAgent(impl: typeof fetch): typeof fetch {
  return (input, init) => {
    if (!isPolymarketHost(input)) return impl(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.has("user-agent")) return impl(input, init);
    headers.set("user-agent", POLYMARKET_BROWSER_USER_AGENT);
    return impl(input, { ...init, headers });
  };
}

let isInstalled = false;

export function installPolymarketUserAgent(): void {
  if (isInstalled) return;
  isInstalled = true;
  globalThis.fetch = withPolymarketUserAgent(globalThis.fetch);
}

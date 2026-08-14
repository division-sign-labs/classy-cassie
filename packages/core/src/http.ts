// packages/core/src/http.ts
// Fetch injection that survives Cloudflare Workers.
//
// Storing the global `fetch` on an object and calling it back as a method —
// `this.fetchImpl(url)` — invokes it with `this` bound to that object instead
// of the global scope. Node tolerates it; workerd rejects it with
// "Illegal invocation: function called with incorrect `this` reference", which
// surfaced as every strategy tick failing while local runs passed.
//
// https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors

/**
 * Wraps a fetch implementation so it is always called as a plain function.
 * Pass an injected impl for tests; omit it for the platform's fetch.
 */
export function boundFetch(impl?: typeof fetch): typeof fetch {
  const f = impl ?? fetch;
  return (input, init) => f(input, init);
}

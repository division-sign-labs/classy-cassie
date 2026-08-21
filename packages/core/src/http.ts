// packages/core/src/http.ts
// Fetch injection that stays callable across runtimes.
//
// Storing the global `fetch` on an object and calling it back as a method —
// `this.fetchImpl(url)` — invokes it with `this` bound to that object instead
// of the global scope. Node tolerates it; stricter runtimes reject it with
// "Illegal invocation: function called with incorrect `this` reference", which
// once surfaced as every strategy tick failing while local runs passed.

/**
 * Wraps a fetch implementation so it is always called as a plain function.
 * Pass an injected impl for tests; omit it for the platform's fetch.
 */
export function boundFetch(impl?: typeof fetch): typeof fetch {
  const f = impl ?? fetch;
  return (input, init) => f(input, init);
}

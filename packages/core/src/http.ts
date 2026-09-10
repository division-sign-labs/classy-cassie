// packages/core/src/http.ts
// Fetch injection that stays callable across runtimes.
//
// Storing the global `fetch` on an object and calling it back as a method —
// `this.fetchImpl(url)` — invokes it with `this` bound to that object instead
// of the global scope. Node tolerates it; stricter runtimes reject it with
// "Illegal invocation: function called with incorrect `this` reference", which
// once surfaced as every strategy tick failing while local runs passed.

import { defaultMetricsRegistry, type MetricsRegistry } from "./metrics.js";

function hostnameOf(input: Parameters<typeof fetch>[0]): string {
  try {
    if (typeof input === "string") return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    return new URL((input as Request).url).hostname;
  } catch {
    return "invalid";
  }
}

/**
 * Wraps a fetch implementation so it is always called as a plain function.
 * Pass an injected impl for tests; omit it for the platform's fetch.
 * Every call is counted under `http.<hostname>` in the registry (hostname only,
 * never the path or query); pass `null` to leave calls uncounted.
 */
export function boundFetch(impl?: typeof fetch, registry: MetricsRegistry | null = defaultMetricsRegistry()): typeof fetch {
  const f = impl ?? fetch;
  if (!registry) return (input, init) => f(input, init);
  return async (input, init) => {
    const key = `http.${hostnameOf(input)}`;
    const t0 = performance.now();
    try {
      const res = await f(input, init);
      registry.record(key, { ok: res.ok, ms: performance.now() - t0, error: res.ok ? undefined : `HTTP ${res.status}` });
      return res;
    } catch (error) {
      registry.record(key, { ok: false, ms: performance.now() - t0, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
}

// packages/core/test/bound-fetch.test.ts
// Every injected fetch must be called as a plain function, never as a method.
//
// `this.fetchImpl(url)` binds `this` to the calling object. Node ignores it;
// Strict runtimes throw "Illegal invocation: function called with incorrect
// `this` reference" and kills the request. That failed every deployed strategy
// tick while local runs and tests stayed green, so these assert the calling
// convention directly rather than trusting the platform to surface it.

import { describe, expect, it } from "vitest";
import { AresClient, LiveSignalSource, TelegramAlerter, boundFetch } from "@quotient-forecasting/cassie-core";

/**
 * A fetch stand-in that records the `this` it was invoked with. Declared as a
 * non-arrow function so it observes the caller's binding, exactly as the real
 * built-in does.
 */
function spyingFetch(body: unknown = {}, status = 200) {
  const seen: unknown[] = [];
  const impl = function (this: unknown): Promise<Response> {
    seen.push(this);
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    );
  };
  return { impl: impl as unknown as typeof fetch, seen };
}

/** The rule: the receiver must not be the object holding the reference. */
function assertNotMethodCall(seen: unknown[], holder: object) {
  expect(seen.length).toBeGreaterThan(0);
  for (const receiver of seen) {
    expect(receiver).not.toBe(holder);
    // undefined (strict-mode plain call) or globalThis are both fine.
    expect(receiver === undefined || receiver === globalThis).toBe(true);
  }
}

describe("boundFetch", () => {
  it("calls the implementation without a receiver", async () => {
    const { impl, seen } = spyingFetch();
    await boundFetch(impl)("https://example.test");
    assertNotMethodCall(seen, {});
  });

  it("survives being stored on an object and called back", async () => {
    const { impl, seen } = spyingFetch();
    const holder = { f: boundFetch(impl) };
    await holder.f("https://example.test");
    assertNotMethodCall(seen, holder);
  });
});

describe("callers do not invoke fetch as a method", () => {
  it("LiveSignalSource", async () => {
    const { impl, seen } = spyingFetch({ signals: [] });
    const src = new LiveSignalSource(
      { baseUrl: "https://gateway.test", path: "/api/v1/signals" },
      "token",
      impl,
    );
    await src.latest({});
    assertNotMethodCall(seen, src);
  });

  it("AresClient", async () => {
    const { impl, seen } = spyingFetch({ id: "post_1" });
    const client = new AresClient({ apiKey: "k", fetchImpl: impl });
    await client.post({ content: "hi" });
    assertNotMethodCall(seen, client);
  });

  it("TelegramAlerter", async () => {
    const { impl, seen } = spyingFetch({ ok: true });
    const alerter = new TelegramAlerter("token", "chat", impl);
    await alerter.send({ kind: "test", botId: "b", message: "ping" });
    assertNotMethodCall(seen, alerter);
  });
});

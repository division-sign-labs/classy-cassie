// packages/core/test/engine-idempotency.test.ts
// Cloudflare alarms are at-least-once: a retried alarm re-presents the same
// tickId and the engine must no-op instead of double-executing entries (§10).

import { describe, expect, it } from "vitest";
import { StateKeys } from "@quotient/cassie-core";
import { buildFixtureEngine } from "./helpers.js";

describe("engine tick idempotency", () => {
  it("skips a re-presented tickId without double-entering", async () => {
    const { engine, venue, alerter } = buildFixtureEngine();

    const first = await engine.tick({ tickId: 7 });
    expect(first.skipped).toBe(false);
    expect(first.ordersPlaced).toBe(1);
    const posAfterFirst = await venue.positions();
    expect(posAfterFirst[0]!.size).toBe(10);
    const alertCount = alerter.events.length;

    // Forced retry: same tickId.
    const retry = await engine.tick({ tickId: 7 });
    expect(retry.skipped).toBe(true);
    expect(retry.skipReason).toBe("already-completed");
    expect(retry.ordersPlaced).toBe(0);

    // Nothing changed: no double entry, no new alerts.
    const posAfterRetry = await venue.positions();
    expect(posAfterRetry).toHaveLength(1);
    expect(posAfterRetry[0]!.size).toBe(10);
    expect(alerter.events.length).toBe(alertCount);
  });

  it("skips stale (lower) tickIds after a newer one completed", async () => {
    const { engine } = buildFixtureEngine();
    await engine.tick({ tickId: 7 });
    const stale = await engine.tick({ tickId: 6 });
    expect(stale.skipped).toBe(true);
    expect(stale.skipReason).toBe("already-completed");
  });

  it("skips while an identical tick is locked in progress", async () => {
    const { engine, state } = buildFixtureEngine();
    await state.set(StateKeys.tickLock, JSON.stringify({ seq: 1, ts: Date.now() }));
    const res = await engine.tick({ tickId: 1 });
    expect(res.skipped).toBe(true);
    expect(res.skipReason).toBe("in-progress");
  });

  it("skips while paused", async () => {
    const { engine, state, venue } = buildFixtureEngine();
    await state.set(StateKeys.paused, "true");
    const res = await engine.tick();
    expect(res.skipped).toBe(true);
    expect(res.skipReason).toBe("paused");
    expect(await venue.positions()).toHaveLength(0);
  });
});

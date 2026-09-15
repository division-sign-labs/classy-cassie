// packages/core/test/engine-e2e.test.ts
// Offline strategy e2e: entry with visible capacity cap, fill reconciliation,
// then a signal-side flip that is held: exits are the price floor or the deadline.

import { describe, expect, it } from "vitest";
import { StateKeys } from "@quotient-forecasting/cassie-core";
import { buildFixtureEngine } from "./helpers.js";

describe("flip-flat against fixtures (offline e2e)", () => {
  it("enters capped and holds through a signal-side flip", async () => {
    const { engine, venue, alerter, state } = buildFixtureEngine();

    // Tick 1: flat + YES signal (spread 15pp ≥ 10) → entry, size capped by depth.
    const t1 = await engine.tick();
    expect(t1.skipped).toBe(false);
    expect(t1.ordersPlaced).toBe(1);
    const entries = alerter.ofKind("entry");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toMatch(/enter YES/);
    expect(entries[0]!.message).toMatch(/\(size capped\)/);

    let positions = await venue.positions();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ marketRef: "fx-yes-1", side: "YES" });
    // 20% of the 40 shares in-band at limit 0.5656 (1% from the touch).
    expect(positions[0]!.size).toBe(8);
    expect(positions[0]!.avgPrice).toBeCloseTo(0.56, 10);
    const budget = JSON.parse((await state.get(StateKeys.strategyMemory("daily-entry-budget")))!);
    expect(budget.placedUsd).toBeCloseTo(4.5248, 3);

    // Tick 2: same side → hold. Fill from tick 1 is reconciled + alerted now.
    const t2 = await engine.tick();
    expect(t2.ordersPlaced).toBe(0);
    expect(alerter.ofKind("entry")).toHaveLength(1); // no new entry
    const fillsAfterT2 = alerter.ofKind("fill");
    expect(fillsAfterT2).toHaveLength(1);
    expect(fillsAfterT2[0]!.message).toMatch(/fill: BUY 8 fx-yes-1 @ 0.56/);
    positions = await venue.positions();
    expect(positions[0]!.size).toBe(8);

    // Tick 3: the signal moves to NO at 0.70, valuing the held YES at 0.30.
    // The executable YES bid is nowhere near the 90¢ take-profit and the hold
    // deadline is days away, so nothing sells.
    const t3 = await engine.tick();
    expect(t3.ordersPlaced).toBe(0);
    expect(alerter.ofKind("exit")).toHaveLength(0);
    expect(alerter.ofKind("entry")).toHaveLength(1);
    positions = await venue.positions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.side).toBe("YES");
    expect(positions[0]!.size).toBe(8);
    // No error alerts anywhere in the run.
    expect(alerter.ofKind("error")).toHaveLength(0);
  });
});

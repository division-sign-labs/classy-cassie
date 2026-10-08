// packages/core/test/engine-e2e.test.ts
// Offline strategy e2e: entry with visible capacity cap, fill reconciliation,
// then a signal-side flip that sells the position on the next tick.

import { describe, expect, it } from "vitest";
import { StateKeys } from "@quotient-forecasting/cassie-core";
import { buildFixtureEngine } from "./helpers.js";

describe("flip-flat against fixtures (offline e2e)", () => {
  it("enters capped and sells on a signal-side flip", async () => {
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
    // Readable fields: the fixture's market title, the fill, and no P&L on an entry fill.
    expect(entries[0]).toMatchObject({ venue: "fixture", market: { ref: "fx-yes-1" }, trade: { side: "BUY", size: 8 } });
    expect(entries[0]!.pnl).toBeUndefined();
    expect(fillsAfterT2[0]).toMatchObject({ market: { ref: "fx-yes-1" }, trade: { side: "BUY", size: 8, price: 0.56, filled: true } });
    expect(fillsAfterT2[0]!.market?.title).toBeTruthy();
    expect(fillsAfterT2[0]!.pnl).toBeUndefined();
    positions = await venue.positions();
    expect(positions[0]!.size).toBe(8);

    // Tick 3: the signal moves to NO at 0.70, valuing the held YES at 0.30.
    // One flipped forecast sells the position; nothing new is entered.
    const t3 = await engine.tick();
    expect(t3.ordersPlaced).toBe(1);
    const exitAlerts = alerter.ofKind("exit");
    expect(exitAlerts).toHaveLength(1);
    expect(exitAlerts[0]).toMatchObject({ market: { ref: "fx-yes-1" }, trade: { side: "SELL", size: 8 } });
    expect(alerter.ofKind("entry")).toHaveLength(1);
    positions = (await venue.positions()).filter((position) => position.size > 0);
    expect(positions).toHaveLength(0);
    // No error alerts anywhere in the run.
    expect(alerter.ofKind("error")).toHaveLength(0);
  });
});

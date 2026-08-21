// packages/core/test/engine-e2e.test.ts
// Offline convergence e2e (acceptance 6–7): entry with visible capacity cap,
// hold, forecast crosses the price → convergence exit, then a fresh entry on
// the newly signaled side once flat; fills alerted on the following tick.

import { describe, expect, it } from "vitest";
import { StateKeys } from "@quotient-forecasting/cassie-core";
import { buildFixtureEngine } from "./helpers.js";

describe("flip-flat against fixtures (offline e2e)", () => {
  it("enters capped, holds, exits on convergence, re-enters the new side", async () => {
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

    // Tick 3: the signal moves to NO at 0.70, valuing the held YES at 0.30 —
    // the forecast has crossed below the price, so the convergence exit fires.
    // The side change alone is not the trigger, and there is no same-tick
    // re-entry: the market is still occupied until the exit fills.
    const t3 = await engine.tick();
    expect(t3.ordersPlaced).toBe(1);
    const exits = alerter.ofKind("exit");
    expect(exits).toHaveLength(1);
    expect(exits[0]!.message).toMatch(/converged/);
    expect(alerter.ofKind("entry")).toHaveLength(1);
    positions = await venue.positions();
    expect(positions).toHaveLength(0);

    // Tick 4: flat again with the NO signal live (15pp ≥ 10) → fresh NO entry.
    // The tick-3 SELL fill is reconciled + alerted now.
    const t4 = await engine.tick();
    expect(t4.ordersPlaced).toBe(1);
    expect(alerter.ofKind("entry")).toHaveLength(2);
    expect(alerter.ofKind("entry")[1]!.message).toMatch(/enter NO/);
    const fillsAfterT4 = alerter.ofKind("fill");
    expect(fillsAfterT4).toHaveLength(2);
    expect(fillsAfterT4.map((f) => f.message).join("\n")).toMatch(/SELL 8/);

    positions = await venue.positions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.side).toBe("NO");
    // NO entry: mirrored asks give 50 in-band at 0.4646 → 20% = 10 @ 0.46.
    expect(positions[0]!.size).toBe(10);
    expect(positions[0]!.avgPrice).toBeCloseTo(0.46, 10);

    // Tick 5: reconcile the tick-4 BUY fill; NO position holds (24pp of edge).
    const t5 = await engine.tick();
    expect(t5.ordersPlaced).toBe(0);
    const fills = alerter.ofKind("fill");
    expect(fills).toHaveLength(3);
    expect(fills.map((f) => f.message).join("\n")).toMatch(/BUY 10/);
    // No error alerts anywhere in the run.
    expect(alerter.ofKind("error")).toHaveLength(0);
  });
});

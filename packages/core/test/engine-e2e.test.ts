// packages/core/test/engine-e2e.test.ts
// Offline flip e2e (acceptance 6–7): entry with visible capacity cap, hold,
// flip → exit + re-entry, fills alerted on the following tick.

import { describe, expect, it } from "vitest";
import { buildFixtureEngine } from "./helpers.js";

describe("flip-flat against fixtures (offline e2e)", () => {
  it("enters capped, holds, then flips", async () => {
    const { engine, venue, alerter } = buildFixtureEngine();

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
    // 25% of the 40 shares in-band at limit 0.5665.
    expect(positions[0]!.size).toBe(10);
    expect(positions[0]!.avgPrice).toBeCloseTo(0.56, 10);

    // Tick 2: same side → hold. Fill from tick 1 is reconciled + alerted now.
    const t2 = await engine.tick();
    expect(t2.ordersPlaced).toBe(0);
    expect(alerter.ofKind("entry")).toHaveLength(1); // no new entry
    const fillsAfterT2 = alerter.ofKind("fill");
    expect(fillsAfterT2).toHaveLength(1);
    expect(fillsAfterT2[0]!.message).toMatch(/fill: BUY 10 fx-yes-1 @ 0.56/);
    positions = await venue.positions();
    expect(positions[0]!.size).toBe(10);

    // Tick 3: signal flips to NO → exit YES, re-enter NO (both capped paths).
    const t3 = await engine.tick();
    expect(t3.ordersPlaced).toBe(2);
    const exits = alerter.ofKind("exit");
    expect(exits).toHaveLength(1);
    expect(exits[0]!.message).toMatch(/flip/);
    expect(alerter.ofKind("entry")).toHaveLength(2);
    expect(alerter.ofKind("entry")[1]!.message).toMatch(/enter NO/);

    positions = await venue.positions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.side).toBe("NO");
    // NO entry: mirrored asks give 50 in-band at 0.4635 → 25% = 12.5 @ 0.46.
    expect(positions[0]!.size).toBe(12.5);
    expect(positions[0]!.avgPrice).toBeCloseTo(0.46, 10);

    // Tick 4: reconcile alerts for the two tick-3 fills (SELL exit + BUY re-entry).
    await engine.tick();
    const fills = alerter.ofKind("fill");
    expect(fills).toHaveLength(3);
    expect(fills.map((f) => f.message).join("\n")).toMatch(/SELL 10/);
    expect(fills.map((f) => f.message).join("\n")).toMatch(/BUY 12.5/);
    // No error alerts anywhere in the run.
    expect(alerter.ofKind("error")).toHaveLength(0);
  });
});

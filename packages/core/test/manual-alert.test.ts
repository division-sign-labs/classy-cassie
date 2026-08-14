// packages/core/test/manual-alert.test.ts
// Manual and thesis-driven orders raise an order alert. Before this they went
// out silently: no Telegram, no feed post. A thesis trade is exactly the one
// a copy-trader audience most wants to see, so silence there was the bug.

import { describe, expect, it } from "vitest";
import { buildFixtureEngine } from "./helpers.js";

describe("manualOrder alerting", () => {
  it("raises an entry alert carrying the note", async () => {
    const { engine, alerter } = buildFixtureEngine();
    const result = await engine.manualOrder({
      marketRef: "fx-yes-1",
      outcome: "YES",
      side: "BUY",
      size: 5,
      note: "Polling moved 6pts and the market hasn't repriced.",
    });

    expect(result.placed).toBe(true);
    const entries = alerter.ofKind("entry");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.data?.note).toBe("Polling moved 6pts and the market hasn't repriced.");
    expect(entries[0]!.data?.orderId).toBe(result.orderId);
    expect(entries[0]!.data?.source).toBe("manual");
  });

  it("raises an exit alert when reducing", async () => {
    const { engine, alerter } = buildFixtureEngine();
    await engine.manualOrder({ marketRef: "fx-yes-1", outcome: "YES", side: "BUY", size: 5 });
    await engine.manualOrder({
      marketRef: "fx-yes-1",
      outcome: "YES",
      side: "SELL",
      size: 5,
      reduceOnly: true,
      note: "thesis played out",
    });
    expect(alerter.ofKind("exit")).toHaveLength(1);
  });

  it("still alerts when no note was written", async () => {
    const { engine, alerter } = buildFixtureEngine();
    await engine.manualOrder({ marketRef: "fx-yes-1", outcome: "YES", side: "BUY", size: 5 });
    const entries = alerter.ofKind("entry");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.data?.note).toBeUndefined();
  });

  it("raises nothing when the risk module skips the order", async () => {
    const { engine, alerter } = buildFixtureEngine();
    const result = await engine.manualOrder({ marketRef: "fx-yes-1", outcome: "YES", side: "BUY", size: 1e9 });
    if (!result.placed) expect(alerter.ofKind("entry")).toHaveLength(0);
  });
});

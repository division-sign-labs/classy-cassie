// packages/core/test/market-alert-identity.test.ts
import { describe, expect, it, vi } from "vitest";
import { Engine, silentLogger, type Action } from "@quotient-forecasting/cassie-core";
import { buildFixtureEngine } from "./helpers.js";

describe("legacy market alert identity", () => {
  it.each((["YES", "NO"] as const).flatMap(outcome =>
    (["strategy", "manual"] as const).map(source => ({ outcome, source }))))(
    "retains $outcome identity on $source entries, exits and fills after restart", async ({ outcome, source }) => {
      const h = buildFixtureEngine();
      const tokenId = outcome === "YES" ? "fx-yes-1" : "fx-no-1";
      const placeOrder = h.venue.placeOrder.bind(h.venue);
      vi.spyOn(h.venue, "placeOrder").mockImplementation(async (account, intent) => ({
        ...await placeOrder(account, intent), tokenId, conditionId: "condition",
      }));
      let actions: Action[] = [{ kind: "enter", marketRef: "fx-yes-1", side: outcome, notional: 2 }];
      const restart = () => new Engine({ botId: h.config.id, config: h.config, adapter: h.venue, account: h.account,
        strategy: { id: "test", tick: async () => actions }, signals: { latest: async () => [] },
        state: h.state, alerter: h.alerter, log: silentLogger });
      let engine = restart();
      if (source === "manual") {
        await engine.manualOrder({ marketRef: "fx-yes-1", outcome, side: "BUY", size: 3 });
      } else expect((await engine.tick()).ordersPlaced).toBe(1);
      const market = { ref: "fx-yes-1", outcome, tokenId, conditionId: "condition" };
      expect(h.alerter.ofKind("entry")[0]?.market).toMatchObject(market);
      const entryId = h.alerter.ofKind("entry")[0]!.trade!.orderId!;
      if (source === "strategy") {
        expect(JSON.parse((await h.state.get(`orders:decision:${entryId}`))!)).toMatchObject({ tokenId, conditionId: "condition" });
        // The durable decision must work even after the short-lived placement record is removed.
        await h.state.delete(`orders:placed:${entryId}`);
      }
      engine = restart();
      actions = [{ kind: "exit", marketRef: "fx-yes-1", reason: "test exit" }];
      if (source === "manual") {
        await engine.manualOrder({ marketRef: "fx-yes-1", outcome, side: "SELL", size: 3, reduceOnly: true });
      } else expect((await engine.tick()).ordersPlaced).toBe(1);
      expect(h.alerter.ofKind("exit")[0]?.market).toMatchObject(market);
      expect(await h.venue.positions()).toEqual([]);
      actions = [];
      await restart().tick();
      const fills = h.alerter.ofKind("fill");
      expect(fills).toHaveLength(2);
      for (const fill of fills) expect(fill.market).toMatchObject(market);
    },
  );

  it("uses venue fill identity when there is no local order record", async () => {
    const h = buildFixtureEngine();
    vi.spyOn(h.venue, "fills").mockResolvedValue([{ id: "external-fill", orderId: "external-order", marketRef: "fx-yes-1",
      tokenId: "fx-no-1", conditionId: "condition", outcome: "NO", side: "SELL", size: 1, price: 0.7, ts: Date.now() }]);
    await h.engine.tick();
    expect(h.alerter.ofKind("fill")[0]?.market).toMatchObject({ ref: "fx-yes-1", tokenId: "fx-no-1", conditionId: "condition", outcome: "NO" });
  });
});

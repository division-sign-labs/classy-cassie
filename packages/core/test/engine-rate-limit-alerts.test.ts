// packages/core/test/engine-rate-limit-alerts.test.ts
import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "@quotient-forecasting/cassie-core";
import { Engine } from "../src/engine/engine.js";
import { VenueRateLimitedError } from "../src/venues/transient.js";
import { buildFixtureEngine } from "./helpers.js";

function fixture() {
  const { venue, signals, alerter, state, account, config } = buildFixtureEngine();
  let now = Date.parse("2026-09-19T18:00:00Z");
  const strategy = { id: "flip-flat", tick: vi.fn().mockResolvedValue([]) };
  const restart = () => new Engine({ botId: config.id, config, adapter: venue, account,
    strategy, signals, alerter, state, log: silentLogger, now: () => now });
  return { engine: restart(), restart, venue, alerter, state, strategy, config,
    advance: (ms: number) => { now += ms; } };
}

function sdkLimit(cursor: number) {
  return Object.assign(new Error(`Request to https://clob.polymarket.com/data/trades?after=${cursor} was rate limited`),
    { name: "RateLimitError" });
}

describe("rate-limit alert deduplication", () => {
  it("groups SDK and local limits across tick stages and restart, preserving every error", async () => {
    const f = fixture();
    const fills = vi.spyOn(f.venue, "fills").mockRejectedValue(sdkLimit(1789840042));
    const orders = vi.spyOn(f.venue, "openOrders").mockRejectedValue(new VenueRateLimitedError("orders", 30_000));
    expect((await f.engine.tick()).errors).toBe(3);
    expect(f.alerter.ofKind("error")).toHaveLength(1);

    f.advance(5_000);
    fills.mockRejectedValue(sdkLimit(1789840047));
    orders.mockRejectedValue(new VenueRateLimitedError("orders", 25_000));
    expect((await f.restart().tick()).errors).toBe(3);
    expect(f.alerter.ofKind("error")).toHaveLength(1);
    const errors = await f.state.readErrors();
    expect(errors).toHaveLength(6);
    expect(new Set(errors.map(error => error.code))).toEqual(new Set(["reconcile-fills", "order-ttl", "strategy-tick"]));
    expect(errors.at(-1)?.message).toContain("25s");

    f.advance(f.config.alerts.errorDedupMin * 60_000);
    await f.engine.tick();
    expect(f.alerter.ofKind("error")).toHaveLength(2);
  });

  it("continues attempting reads and resumes strategy work after the venue recovers", async () => {
    const f = fixture();
    const orders = vi.spyOn(f.venue, "openOrders").mockRejectedValue(new VenueRateLimitedError("orders", 30_000));
    await f.engine.tick();
    expect(f.strategy.tick).not.toHaveBeenCalled();
    orders.mockResolvedValue([]);
    f.advance(30_000);
    expect((await f.engine.tick()).errors).toBe(0);
    expect(f.strategy.tick).toHaveBeenCalledOnce();
  });

  it("still alerts independently on non-rate-limit errors during a cooldown incident", async () => {
    const f = fixture();
    vi.spyOn(f.venue, "fills").mockRejectedValue(new VenueRateLimitedError("orders", 30_000));
    vi.spyOn(f.venue, "openOrders").mockRejectedValue(new Error("order identity mismatch"));
    await f.engine.tick();
    expect(f.alerter.ofKind("error")).toHaveLength(3);
    expect(f.alerter.ofKind("error").filter(event => event.message.includes("identity mismatch"))).toHaveLength(2);
  });
});

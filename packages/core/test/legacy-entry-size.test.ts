// packages/core/test/legacy-entry-size.test.ts
import { describe, expect, it } from "vitest";
import {
  Engine, FixtureVenue, MemoryStateStore, parseBotConfig, silentLogger,
  type Action, type AlertEvent, type OrderIntent, type PredictionExecutionMarket,
  type Strategy, type StrategyActionResult, type VenueAccount,
} from "@quotient-forecasting/cassie-core";

const account: VenueAccount = { venue: "fixture", address: "fixture" };

class MinimumVenue extends FixtureVenue {
  readonly intents: OrderIntent[] = [];
  readonly outcomes: string[] = [];
  minimumSize = 5;

  constructor() {
    super({ collateral: 1000, markets: {
      market: { volume24h: 50000, book: { bids: [[0.49, 10000]], asks: [[0.51, 10000]] } },
    } });
  }

  normalizeOrderSize(size: number): number { return Math.floor(size * 100) / 100; }

  async executionMarket(marketRef: string, outcome: "YES" | "NO"): Promise<PredictionExecutionMarket> {
    this.outcomes.push(outcome);
    // The actual NO book differs from a synthetic mirror of YES.
    const bid = outcome === "NO" ? 0.68 : 0.49;
    const ask = outcome === "NO" ? 0.69 : 0.51;
    return {
      marketRef, tokenId: `${marketRef}-${outcome}`, conditionId: "condition", outcome,
      tickSize: 0.01, minOrderSize: this.minimumSize, acceptingOrders: true, observedAt: 1000,
      book: { marketRef, bids: [{ price: bid, size: 10000 }], asks: [{ price: ask, size: 10000 }], ts: 1000 },
      quote: { marketRef, bid, ask, mid: (bid + ask) / 2, volume24h: 50000, spreadBps: 400, ts: 1000 },
    };
  }

  override async placeOrder(acct: VenueAccount, intent: OrderIntent) {
    this.intents.push({ ...intent });
    return super.placeOrder(acct, intent);
  }
}

function setup(notional: number, side: "YES" | "NO" = "YES", action: Action = { kind: "enter", marketRef: "market", side, notional, reason: "top-up" }) {
  const venue = new MinimumVenue();
  const results: StrategyActionResult[] = [];
  const alerts: AlertEvent[] = [];
  const warnings: string[] = [];
  let now = 1000;
  const strategy: Strategy = {
    id: "signals",
    tick: async () => [action],
    onActionResult: async (_ctx, _action, result) => { results.push(result); },
  };
  const config = parseBotConfig({
    id: "legacy-size", venue: "polymarket", execution: { mode: "legacy" },
    strategy: { id: "signals", config: {} },
    risk: { minViableNotional: 1, maxOrderNotional: 1000, slippagePct: 3 },
  });
  const engine = new Engine({
    botId: config.id, config, adapter: venue, account, strategy,
    signals: { latest: async () => [] }, state: new MemoryStateStore(),
    alerter: { send: async event => { alerts.push(event); } },
    log: { ...silentLogger, warn: (message: string) => { warnings.push(message); } }, now: () => now,
  });
  return { engine, venue, results, alerts, warnings, advance: (ms: number) => { now += ms; } };
}

describe("legacy prediction entry quantities", () => {
  it("skips a dollar-eligible top-up below the live share minimum without submitting, recording an error, or alerting", async () => {
    const h = setup(1.5);
    expect(await h.engine.tick()).toMatchObject({ ordersPlaced: 0, errors: 0 });
    expect(h.venue.intents).toEqual([]);
    expect(h.results).toEqual([{ placed: false }]);
    expect(h.alerts.filter(alert => alert.kind === "skipped-order")).toEqual([]);
    expect(h.warnings).toEqual([expect.stringContaining("below venue minimum 5")]);
  });

  it("logs a repeated below-minimum top-up every five minutes, not on every tick", async () => {
    const h = setup(1.2);
    for (let i = 0; i < 10; i += 1) {
      await h.engine.tick();
      h.advance(60_000);
    }
    expect(h.venue.intents).toEqual([]);
    expect(h.alerts.filter(alert => alert.kind === "skipped-order")).toEqual([]);
    expect(h.warnings.filter(message => message.includes("below venue minimum 5"))).toHaveLength(2);
  });

  it("holds a position below the share minimum instead of submitting an exit the venue refuses", async () => {
    const h = setup(0, "YES", { kind: "exit", marketRef: "market", reason: "q-flip", urgent: true });
    await h.venue.placeOrder(account, { marketRef: "market", outcome: "YES", side: "BUY", size: 2.34, limitPrice: 0.51, tif: "IOC", clientId: "seed" });
    h.venue.intents.length = 0;
    expect(await h.engine.tick()).toMatchObject({ ordersPlaced: 0, errors: 0 });
    expect(h.venue.intents).toEqual([]);
    expect(h.results).toEqual([{ placed: false }]);
    expect(h.alerts.filter(alert => alert.kind === "skipped-order" || alert.kind === "error")).toEqual([]);
    expect(h.warnings).toEqual([expect.stringContaining("SELL market: size 2.34 is below venue minimum 5")]);
  });

  it("admits the minimum whole lot without rounding a smaller request up", async () => {
    const below = setup(4.999 * 0.5253);
    expect(await below.engine.tick()).toMatchObject({ ordersPlaced: 0, errors: 0 });
    const enough = setup(5.001 * 0.5253);
    expect(await enough.engine.tick()).toMatchObject({ ordersPlaced: 1, errors: 0 });
    expect(enough.venue.intents[0]?.size).toBe(5);
    expect(enough.venue.intents[0]!.size * enough.venue.intents[0]!.limitPrice).toBeLessThanOrEqual(5.001 * 0.5253);
  });

  it("records the normalized quantity actually submitted so reservations do not wait for fractional dust", async () => {
    const h = setup(50.75);
    await h.engine.tick();
    const intent = h.venue.intents[0]!;
    expect(intent.size).toBe(Math.floor((50.75 / intent.limitPrice) * 100) / 100);
    expect(h.results[0]).toMatchObject({ placedSize: intent.size, placedNotional: intent.size * intent.limitPrice });
    expect(intent.size * intent.limitPrice).toBeLessThanOrEqual(50.75);
  });

  it("uses the selected NO token's book and current minimum in legacy execution", async () => {
    const h = setup(50, "NO");
    h.venue.minimumSize = 100;
    expect(await h.engine.tick()).toMatchObject({ ordersPlaced: 0, errors: 0 });
    expect(h.venue.outcomes).toEqual(["NO"]);
    h.venue.minimumSize = 5;
    expect(await h.engine.tick()).toMatchObject({ ordersPlaced: 1, errors: 0 });
    expect(h.venue.intents[0]).toMatchObject({ outcome: "NO", limitPrice: 0.7107 });
  });
});

// packages/core/test/market-exit.test.ts
// A legacy-mode strategy exit on a prediction market sells the whole position
// immediately at any price. A resting limit near a thin top bid can sit unfilled.

import { describe, expect, it } from "vitest";
import {
  Engine,
  FixtureVenue,
  MemoryStateStore,
  parseBotConfig,
  silentLogger,
  type Action,
  type OrderIntent,
  type Strategy,
  type StrategyContext,
  type VenueAccount,
} from "@quotient-forecasting/cassie-core";

const account: VenueAccount = { venue: "fixture", address: "0xF1XTURE" };

class RecordingVenue extends FixtureVenue {
  readonly intents: OrderIntent[] = [];
  override async placeOrder(acct: VenueAccount, intent: OrderIntent) {
    this.intents.push({ ...intent });
    return super.placeOrder(acct, intent);
  }
}

class OneShotStrategy implements Strategy {
  readonly id = "one-shot";
  constructor(private pending: Action[]) {}
  async tick(_ctx: StrategyContext): Promise<Action[]> {
    const actions = this.pending;
    this.pending = [];
    return actions;
  }
}

async function build(exit: Action) {
  // The Fable book on 2026-10-08: a thin 28c bid above deeper 27c depth.
  const venue = new RecordingVenue({
    collateral: 1_000,
    markets: { fable: { volume24h: 50_000, book: { bids: [[0.28, 78.61], [0.27, 242.64]], asks: [[0.29, 390]] } } },
  });
  await venue.placeOrder(account, { marketRef: "fable", outcome: "YES", side: "BUY", size: 96, limitPrice: 0.29, tif: "IOC", clientId: "seed" });
  venue.intents.length = 0;
  const config = parseBotConfig({
    id: "market-exit-test",
    venue: "polymarket",
    strategy: { id: "one-shot", config: {} },
    execution: { mode: "legacy" },
    risk: { slippagePct: 3, depthCapPct: 100, maxOrderNotional: 1_000 },
  });
  const engine = new Engine({
    botId: config.id,
    config,
    adapter: venue,
    account,
    strategy: new OneShotStrategy([exit]),
    signals: { latest: async () => [] },
    alerter: { send: async () => {} },
    state: new MemoryStateStore(),
    log: silentLogger,
    now: () => Date.parse("2026-10-08T17:40:00Z"),
  });
  return { engine, venue };
}

describe("legacy prediction exits", () => {
  it("market-sells the whole position on an urgent strategy exit", async () => {
    const { engine, venue } = await build({ kind: "exit", marketRef: "fable", urgent: true, reason: "q_flip" });

    const tick = await engine.tick();

    expect(tick.errors).toBe(0);
    expect(venue.intents).toEqual([expect.objectContaining({ side: "SELL", outcome: "YES", size: 96, limitPrice: 0.01, tif: "IOC" })]);
    expect(await venue.positions()).toHaveLength(0);
  });

  it("keeps the depth-capped resting limit for a non-urgent exit", async () => {
    const { engine, venue } = await build({ kind: "exit", marketRef: "fable", reason: "operator" });

    await engine.tick();

    expect(venue.intents).toHaveLength(1);
    expect(venue.intents[0]).toMatchObject({ side: "SELL", tif: "GTC" });
    expect(venue.intents[0]!.limitPrice).toBeGreaterThan(0.25);
  });
});

// packages/core/test/entry-notional-cap.test.ts
// Engine-level regressions for entry spend ceilings at the final crossing
// limit and for strategy exits that must remain possible in quiet markets.

import { describe, expect, it } from "vitest";
import {
  Engine,
  FixtureVenue,
  MemoryStateStore,
  parseBotConfig,
  silentLogger,
  type Action,
  type AlertEvent,
  type Alerter,
  type OrderIntent,
  type SignalSource,
  type Strategy,
  type StrategyActionResult,
  type StrategyContext,
  type VenueAccount,
} from "@quotient-forecasting/cassie-core";

const account: VenueAccount = { venue: "fixture", address: "0xF1XTURE" };
const noSignals: SignalSource = { latest: async () => [] };

class RecordingVenue extends FixtureVenue {
  readonly intents: OrderIntent[] = [];

  override async placeOrder(acct: VenueAccount, intent: OrderIntent) {
    this.intents.push({ ...intent });
    return super.placeOrder(acct, intent);
  }
}

class RecordingStrategy implements Strategy {
  readonly id = "entry-notional-test";
  readonly results: StrategyActionResult[] = [];
  private pending: Action[];

  constructor(actions: Action[]) {
    this.pending = actions;
  }

  async tick(_ctx: StrategyContext): Promise<Action[]> {
    const actions = this.pending;
    this.pending = [];
    return actions;
  }

  async onActionResult(
    _ctx: StrategyContext,
    _action: Action,
    result: StrategyActionResult,
  ): Promise<void> {
    this.results.push(result);
  }
}

class RecordingAlerter implements Alerter {
  readonly events: AlertEvent[] = [];

  async send(event: AlertEvent): Promise<void> {
    this.events.push(event);
  }
}

function buildEngine(
  action: Action,
  opts: { volume24h?: number; maxOrderNotional?: number } = {},
) {
  const venue = new RecordingVenue({
    collateral: 1_000,
    markets: {
      "deep-book": {
        volume24h: opts.volume24h ?? 50_000,
        book: {
          bids: [[0.49, 1_000]],
          asks: [
            [0.51, 1_000],
            [0.56, 1_000],
          ],
        },
      },
    },
  });
  const strategy = new RecordingStrategy([action]);
  const alerter = new RecordingAlerter();
  const config = parseBotConfig({
    id: "spend-cap-test",
    venue: "polymarket",
    strategy: { id: strategy.id, config: {} },
    risk: {
      slippagePct: 10,
      depthCapPct: 100,
      minDailyVolume: 10_000,
      minViableNotional: 1,
      maxOrderNotional: opts.maxOrderNotional ?? 1_000,
    },
  });
  const engine = new Engine({
    botId: config.id,
    config,
    adapter: venue,
    account,
    strategy,
    signals: noSignals,
    alerter,
    state: new MemoryStateStore(),
    log: silentLogger,
    now: () => 1_000,
  });
  return { engine, venue, strategy, alerter };
}

describe("engine entry notional ceiling", () => {
  it("caps a BUY at the desired dollars using the final crossing limit", async () => {
    const desiredNotional = 25;
    const { engine, venue, strategy } = buildEngine({
      kind: "enter",
      marketRef: "deep-book",
      side: "YES",
      notional: desiredNotional,
    });

    const tick = await engine.tick();

    expect(tick.ordersPlaced).toBe(1);
    expect(venue.intents).toHaveLength(1);
    const intent = venue.intents[0]!;
    expect(intent.limitPrice).toBe(0.561);
    expect(intent.size).toBeLessThan(desiredNotional / 0.5);
    expect(intent.size * intent.limitPrice).toBeLessThanOrEqual(desiredNotional);
    expect(strategy.results[0]!.placedNotional).toBe(intent.size * intent.limitPrice);
    expect(strategy.results[0]!.placedNotional).toBeLessThanOrEqual(desiredNotional);
  });

  it("enforces maxOrderNotional at the final BUY limit too", async () => {
    const maxOrderNotional = 20;
    const { engine, venue } = buildEngine(
      {
        kind: "enter",
        marketRef: "deep-book",
        side: "YES",
        notional: 100,
      },
      { maxOrderNotional },
    );

    await engine.tick();

    const intent = venue.intents[0]!;
    expect(intent.size * intent.limitPrice).toBeLessThanOrEqual(maxOrderNotional);
  });

  it("re-checks the effective minimum after conservative size flooring", async () => {
    const { engine, venue, strategy, alerter } = buildEngine({
      kind: "enter",
      marketRef: "deep-book",
      side: "YES",
      notional: 10,
      minNotional: 10,
    });

    const tick = await engine.tick();

    expect(tick.ordersPlaced).toBe(0);
    expect(venue.intents).toHaveLength(0);
    expect(strategy.results[0]).toEqual({ placed: false });
    expect(alerter.events.some((event) => event.kind === "skipped-order")).toBe(true);
  });
});

describe("strategy exit volume handling", () => {
  it("allows an exit below minDailyVolume while retaining slippage and depth checks", async () => {
    const { engine, venue } = buildEngine(
      { kind: "exit", marketRef: "deep-book", reason: "converged" },
      { volume24h: 1 },
    );
    await venue.placeOrder(account, {
      marketRef: "deep-book",
      outcome: "YES",
      side: "BUY",
      size: 10,
      limitPrice: 0.51,
      tif: "IOC",
      clientId: "seed-position",
    });
    venue.intents.length = 0;

    const tick = await engine.tick();

    expect(tick.ordersPlaced).toBe(1);
    expect(venue.intents).toHaveLength(1);
    expect(venue.intents[0]).toMatchObject({ side: "SELL", size: 10, limitPrice: 0.441 });
  });

  it("still blocks entries below minDailyVolume", async () => {
    const { engine, venue, alerter } = buildEngine(
      { kind: "enter", marketRef: "deep-book", side: "YES", notional: 25 },
      { volume24h: 1 },
    );

    const tick = await engine.tick();

    expect(tick.ordersPlaced).toBe(0);
    expect(venue.intents).toHaveLength(0);
    expect(alerter.events.some((event) => event.message.includes("minDailyVolume"))).toBe(true);
  });
});

// packages/core/test/exit-minimum-notional.test.ts
// The minimum-notional floor is entry-only: a strategy SELL below it is still
// submitted (slippage and depth checks intact), an entry BUY below it is
// skipped, and a venue-native rejection of genuinely untradeable dust is
// reported under its own error code.

import { describe, expect, it } from "vitest";
import {
  Engine,
  FixtureVenue,
  MemoryStateStore,
  RiskConfigSchema,
  VenueDustRejectionError,
  checkCapacity,
  parseBotConfig,
  silentLogger,
  type Action,
  type AlertEvent,
  type OrderBook,
  type OrderIntent,
  type Quote,
  type Strategy,
  type StrategyContext,
  type VenueAccount,
} from "@quotient-forecasting/cassie-core";

const account: VenueAccount = { venue: "fixture", address: "0xF1XTURE" };
const NOW = Date.parse("2026-09-01T12:00:00Z");

class RecordingVenue extends FixtureVenue {
  readonly intents: OrderIntent[] = [];
  rejectDustSells: "throw" | "ack" | "none" = "none";

  override async placeOrder(acct: VenueAccount, intent: OrderIntent) {
    this.intents.push({ ...intent });
    if (intent.side === "SELL" && intent.size * intent.limitPrice < 5 && this.rejectDustSells !== "none") {
      if (this.rejectDustSells === "throw") throw new Error("order rejected: size below the venue minimum");
      return { orderId: "rejected-1", clientId: intent.clientId, status: "rejected" as const };
    }
    return super.placeOrder(acct, intent);
  }
}

class OneShotStrategy implements Strategy {
  readonly id = "one-shot";
  private pending: Action[];
  constructor(actions: Action[]) {
    this.pending = actions;
  }
  async tick(_ctx: StrategyContext): Promise<Action[]> {
    const actions = this.pending;
    this.pending = [];
    return actions;
  }
}

function build(actions: Action[], minViableNotional: number) {
  const venue = new RecordingVenue({
    collateral: 1_000,
    markets: {
      "small-book": {
        volume24h: 50_000,
        book: { bids: [[0.49, 1_000]], asks: [[0.51, 1_000]] },
      },
    },
  });
  const events: AlertEvent[] = [];
  const state = new MemoryStateStore();
  const config = parseBotConfig({
    id: "min-notional-test",
    venue: "polymarket",
    strategy: { id: "one-shot", config: {} },
    risk: { slippagePct: 10, minDailyVolume: 1_000, minViableNotional, maxOrderNotional: 1_000 },
  });
  const engine = new Engine({
    botId: config.id,
    config,
    adapter: venue,
    account,
    strategy: new OneShotStrategy(actions),
    signals: { latest: async () => [] },
    alerter: { send: async (event) => { events.push(event); } },
    state,
    log: silentLogger,
    now: () => NOW,
  });
  return { engine, venue, events, state };
}

async function seedPosition(venue: RecordingVenue, size: number): Promise<void> {
  await venue.placeOrder(account, {
    marketRef: "small-book",
    outcome: "YES",
    side: "BUY",
    size,
    limitPrice: 0.51,
    tif: "IOC",
    clientId: "seed",
  });
  venue.intents.length = 0;
}

describe("checkCapacity minimum-notional mode", () => {
  const risk = RiskConfigSchema.parse({ slippagePct: 10, minDailyVolume: 0, minViableNotional: 5 });
  const book: OrderBook = { marketRef: "m", bids: [{ price: 0.49, size: 1_000 }], asks: [{ price: 0.51, size: 1_000 }], ts: 0 };
  const quote: Quote = { marketRef: "m", bid: 0.49, ask: 0.51, mid: 0.5, volume24h: 50_000, spreadBps: 400, ts: 0 };

  it("enforces the floor by default", () => {
    const res = checkCapacity({ side: "SELL", desiredSize: 4, refPrice: 0.49, book, quote, risk });
    expect(res.ok).toBe(false);
    expect(res.skipReasons.join()).toMatch(/minimum notional \$5/);
  });

  it("lets an exit through below the floor while keeping slippage and depth checks", () => {
    const res = checkCapacity({ side: "SELL", desiredSize: 4, refPrice: 0.49, book, quote, risk, enforceMinimumNotional: false });
    expect(res.ok).toBe(true);
    expect(res.size).toBe(4);
    expect(res.limitPrice).toBeCloseTo(0.441, 6);
    expect(res.notes.join()).toMatch(/floor not enforced/);
    const empty = checkCapacity({
      side: "SELL",
      desiredSize: 4,
      refPrice: 0.49,
      book: { ...book, bids: [] },
      quote,
      risk,
      enforceMinimumNotional: false,
    });
    expect(empty.ok).toBe(false);
    expect(empty.skipReasons.join()).toMatch(/no depth/);
  });
});

describe("engine exits below the entry floor", () => {
  it("submits a strategy SELL worth less than $5 when the floor is $5", async () => {
    const { engine, venue } = build([{ kind: "exit", marketRef: "small-book", reason: "time_stop" }], 5);
    await seedPosition(venue, 4); // ≈ $2.04 at cost

    const tick = await engine.tick();

    expect(tick.ordersPlaced).toBe(1);
    expect(tick.errors).toBe(0);
    expect(venue.intents).toHaveLength(1);
    expect(venue.intents[0]).toMatchObject({ side: "SELL", size: 4 });
    expect(venue.intents[0]!.size * venue.intents[0]!.limitPrice).toBeLessThan(5);
    expect(await venue.positions()).toHaveLength(0);
  });

  it("still skips an entry BUY below the floor", async () => {
    const { engine, venue, events } = build([{ kind: "enter", marketRef: "small-book", side: "YES", notional: 3 }], 5);

    const tick = await engine.tick();

    expect(tick.ordersPlaced).toBe(0);
    expect(venue.intents).toHaveLength(0);
    expect(events.some((event) => event.kind === "skipped-order" && /minimum notional \$5/.test(event.message))).toBe(true);
  });

  it.each(["throw", "ack"] as const)("reports a venue dust rejection distinctly (%s)", async (mode) => {
    const { engine, venue, events, state } = build([{ kind: "exit", marketRef: "small-book", reason: "time_stop" }], 5);
    await seedPosition(venue, 4);
    venue.rejectDustSells = mode;

    const tick = await engine.tick();

    expect(tick.ordersPlaced).toBe(0);
    expect(tick.errors).toBe(1);
    const errors = await state.readErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "venue-dust-rejected", context: { marketRef: "small-book", side: "SELL", size: 4, minimumNotionalUsd: 5 } });
    expect(errors[0]!.message).toMatch(/venue rejected untradeable dust: SELL 4 small-book \(\$1\.\d\d is below the \$5 entry floor/);
    const alert = events.find((event) => event.kind === "error");
    expect(alert?.message).toMatch(/\[venue-dust-rejected\]/);
    // An ordinary rejected exit above the floor keeps the generic code.
    expect(new VenueDustRejectionError("x", {
      marketRef: "m", side: "SELL", size: 1, limitPrice: 0.5, notionalUsd: 0.5, minimumNotionalUsd: 5, venueMessage: "y",
    }).code).toBe("venue-dust-rejected");
  });

  it("keeps the generic action code for a rejected exit above the floor", async () => {
    class RejectAll extends RecordingVenue {
      override async placeOrder(_acct: VenueAccount, intent: OrderIntent) {
        this.intents.push({ ...intent });
        throw new Error("order rejected: venue incident");
      }
    }
    const venue = new RejectAll({ collateral: 1_000, markets: { "small-book": { volume24h: 50_000, book: { bids: [[0.49, 1_000]], asks: [[0.51, 1_000]] } } } });
    const state = new MemoryStateStore();
    const config = parseBotConfig({
      id: "reject-test",
      venue: "polymarket",
      strategy: { id: "one-shot", config: {} },
      risk: { slippagePct: 10, minDailyVolume: 1_000, minViableNotional: 1 },
    });
    // Seed through the base class so the position exists before the rejecting override applies.
    await FixtureVenue.prototype.placeOrder.call(venue, account, {
      marketRef: "small-book", outcome: "YES", side: "BUY", size: 40, limitPrice: 0.51, tif: "IOC", clientId: "seed",
    });
    const engine = new Engine({
      botId: config.id, config, adapter: venue, account,
      strategy: new OneShotStrategy([{ kind: "exit", marketRef: "small-book" }]),
      signals: { latest: async () => [] }, alerter: { send: async () => undefined }, state, log: silentLogger, now: () => NOW,
    });
    const tick = await engine.tick();
    expect(tick.errors).toBe(1);
    expect((await state.readErrors())[0]).toMatchObject({ code: "action-exit" });
  });
});

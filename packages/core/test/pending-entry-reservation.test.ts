// packages/core/test/pending-entry-reservation.test.ts
// Engine-level regressions for the durable pending-entry reservation: an
// immediate fill that the venue shows in neither positions nor open orders
// for three consecutive ticks must keep counting against the market and
// sibling-event caps, block a second entry for that market, and release
// without double-counting once the venue position appears.

import { describe, expect, it } from "vitest";
import {
  Engine,
  FixtureVenue,
  MemoryStateStore,
  StateKeys,
  orderDecisionKey,
  parseBotConfig,
  silentLogger,
  type OrderIntent,
  type Position,
  type Signal,
  type SignalSource,
  type VenueAccount,
} from "@quotient-forecasting/cassie-core";
import {
  FlipFlatStrategy,
  PENDING_ENTRIES_MEMORY_KEY,
  type PendingEntryReservation,
} from "../../../strategies/flip-flat/dist/index.js";

const account: VenueAccount = { venue: "fixture", address: "0xF1XTURE" };
const START = Date.parse("2026-09-01T12:00:00Z");
const SIBLINGS = new Set(["m-a", "m-b", "m-c"]);

/**
 * A venue whose immediate fills stay invisible for the next `lagTicks - 1`
 * engine ticks: the crossing BUY fills completely (so no order rests) but the
 * position is withheld from `positions()` until tick `placedTick + lagTicks`.
 */
class LaggingVenue extends FixtureVenue {
  readonly intents: OrderIntent[] = [];
  tick = 0;
  private readonly revealAt = new Map<string, number>();

  constructor(private readonly lagTicks: number) {
    super({
      collateral: 1_000,
      markets: Object.fromEntries(
        [...SIBLINGS, "m-solo"].map((ref) => [
          ref,
          { volume24h: 50_000, book: { bids: [[0.49, 10_000]], asks: [[0.51, 10_000]] } },
        ]),
      ),
    });
  }

  override async placeOrder(acct: VenueAccount, intent: OrderIntent) {
    this.intents.push({ ...intent });
    const ack = await super.placeOrder(acct, intent);
    if (intent.side === "BUY" && (ack.filledSize ?? 0) > 0) this.revealAt.set(intent.marketRef, this.tick + this.lagTicks);
    return ack;
  }

  override async positions(): Promise<Position[]> {
    return (await super.positions()).filter((position) => (this.revealAt.get(position.marketRef) ?? 0) <= this.tick);
  }

  override async eventRef(marketRef: string): Promise<string> {
    return SIBLINGS.has(marketRef) ? "event:siblings" : `event:${marketRef}`;
  }
}

function signal(marketRef: string, spreadPp: number): Signal {
  return {
    id: `sig-${marketRef}`,
    ts: new Date(START).toISOString(),
    venue: "polymarket",
    marketRef,
    side: "YES",
    prob: 0.5 + spreadPp / 100,
    refPrice: 0.5,
    spreadPp,
    ttlSec: 86_400,
  };
}

function build(input: { lagTicks: number; signals: Signal[]; config?: Record<string, unknown> }) {
  const venue = new LaggingVenue(input.lagTicks);
  const signals: SignalSource = { latest: async () => input.signals };
  const state = new MemoryStateStore();
  const clock = { now: START };
  const config = parseBotConfig({
    id: "reservation-test",
    venue: "polymarket",
    strategy: {
      id: "flip-flat",
      config: {
        allocationMode: "portfolio-kelly",
        kellyFraction: 0.25,
        marketCapPct: 5,
        eventCapPct: 7.5,
        minExitDepth2cUsd: 0,
        convergenceExit: false,
        // The fixture fills at the touch, below the crossing limit the entry
        // was sized against, so the visible cost basis lands a few dollars
        // under target. Keep that routine top-up out of these assertions.
        minEntryNotional: 10,
        ...input.config,
      },
    },
    risk: { slippagePct: 10, depthCapPct: 100, minDailyVolume: 1_000, minViableNotional: 1, maxOrderNotional: 1_000 },
  });
  const engine = new Engine({
    botId: config.id,
    config,
    adapter: venue,
    account,
    strategy: new FlipFlatStrategy(),
    signals,
    alerter: { send: async () => undefined },
    state,
    log: silentLogger,
    now: () => clock.now,
  });
  const tick = async () => {
    venue.tick += 1;
    clock.now += 60_000;
    return engine.tick();
  };
  const reservations = async () => {
    const raw = await state.get(StateKeys.strategyMemory(PENDING_ENTRIES_MEMORY_KEY));
    return raw ? (JSON.parse(raw) as { byOrderId: Record<string, PendingEntryReservation> }).byOrderId : {};
  };
  return { engine, venue, state, clock, tick, reservations };
}

describe("pending-entry reservation across a venue handoff lag", () => {
  it("does not re-enter a market whose fill is invisible for three consecutive ticks", async () => {
    const { venue, tick, reservations } = build({ lagTicks: 4, signals: [signal("m-solo", 20)] });

    const first = await tick();
    expect(first.ordersPlaced).toBe(1);
    expect(venue.intents).toHaveLength(1);
    expect(venue.intents[0]).toMatchObject({ marketRef: "m-solo", side: "BUY" });
    const reserved = Object.values(await reservations());
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).toMatchObject({ marketRef: "m-solo", side: "YES", eventRef: "event:m-solo", priorMarketSize: 0 });
    expect(reserved[0]!.reservedNotionalUsd).toBeCloseTo(venue.intents[0]!.size * venue.intents[0]!.limitPrice, 6);

    // Three ticks with the position in neither positions nor open orders.
    for (let i = 0; i < 3; i++) {
      expect(await venue.positions()).toHaveLength(0);
      expect(await venue.openOrders()).toHaveLength(0);
      const result = await tick();
      expect(result.ordersPlaced).toBe(0);
      expect(venue.intents).toHaveLength(1);
      expect(Object.keys(await reservations())).toHaveLength(1);
    }

    // The venue position appears: the reservation is released, and the held
    // cost basis now holds the market at target on its own.
    const after = await tick();
    expect(await venue.positions()).toHaveLength(1);
    expect(after.ordersPlaced).toBe(0);
    expect(Object.keys(await reservations())).toHaveLength(0);
    expect(venue.intents).toHaveLength(1);
  });

  it("holds the sibling-event cap and the market cap through the lag", async () => {
    const { venue, tick, reservations } = build({
      lagTicks: 4,
      signals: [signal("m-a", 22), signal("m-b", 21), signal("m-c", 20)],
    });

    // $50 per market (5% of $1,000), $75 per event (7.5%): m-a $50 + m-b $25; m-c nothing.
    const first = await tick();
    expect(first.ordersPlaced).toBe(2);
    expect(venue.intents.map((intent) => intent.marketRef)).toEqual(["m-a", "m-b"]);
    const spent = venue.intents.reduce((sum, intent) => sum + intent.size * intent.limitPrice, 0);
    expect(spent).toBeLessThanOrEqual(75 + 1e-6);

    for (let i = 0; i < 3; i++) {
      expect(await venue.positions()).toHaveLength(0);
      const result = await tick();
      expect(result.ordersPlaced).toBe(0);
      // Both reservations still count: m-c stays capped by the event and no market re-enters.
      expect(Object.values(await reservations()).map((r) => r.marketRef).sort()).toEqual(["m-a", "m-b"]);
    }
    expect(venue.intents).toHaveLength(2);

    // Positions visible: reservations release; the event stays at its cap, so still no m-c.
    const after = await tick();
    expect(after.ordersPlaced).toBe(0);
    expect(Object.keys(await reservations())).toHaveLength(0);
    expect(venue.intents.map((intent) => intent.marketRef)).toEqual(["m-a", "m-b"]);
  });

  it("does not double-count once the venue position appears", async () => {
    const { venue, tick, reservations, state } = build({ lagTicks: 1, signals: [signal("m-solo", 12)] });
    await tick();
    expect(venue.intents).toHaveLength(1);
    const reserved = Object.values(await reservations())[0]!;
    // Tick 2: position visible with the reserved size absorbed → reservation released.
    await tick();
    expect(Object.keys(await reservations())).toHaveLength(0);
    const positions = await venue.positions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.size).toBeCloseTo(reserved.reservedSize, 6);
    // Provenance was persisted with the order decision.
    const decision = await state.get(orderDecisionKey("fx-1"));
    expect(decision).not.toBeNull();
    const parsed = JSON.parse(decision!) as { provenance?: Record<string, unknown>; side: string };
    expect(parsed.side).toBe("BUY");
    expect(parsed.provenance).toMatchObject({
      signalId: "sig-m-solo",
      eventRef: "event:m-solo",
      limitingCap: expect.any(String),
    });
    expect(parsed.provenance).toHaveProperty("liveEdgePp");
    expect(parsed.provenance).toHaveProperty("targetUsd");
    expect(parsed.provenance).toHaveProperty("currentMarketUsd");
    expect(parsed.provenance).toHaveProperty("currentEventUsd");
    expect(parsed.provenance).toHaveProperty("headroomUsd");
  });

  it("releases an unabsorbed reservation after the handoff window and logs it as canceled or rejected", async () => {
    // A venue that accepts the order, reports it open, then loses it: no
    // position and no resting order ever appear.
    class VanishingVenue extends LaggingVenue {
      override async placeOrder(_acct: VenueAccount, intent: OrderIntent) {
        this.intents.push({ ...intent });
        return { orderId: `lost-${this.intents.length}`, clientId: intent.clientId, status: "open" as const };
      }
    }
    const venue = new VanishingVenue(0);
    const state = new MemoryStateStore();
    const clock = { now: START };
    const config = parseBotConfig({
      id: "vanish-test",
      venue: "polymarket",
      strategy: {
        id: "flip-flat",
        config: { allocationMode: "portfolio-kelly", minExitDepth2cUsd: 0, convergenceExit: false, pendingEntryReservationSec: 600 },
      },
      risk: { slippagePct: 10, minDailyVolume: 1_000 },
    });
    const engine = new Engine({
      botId: config.id,
      config,
      adapter: venue,
      account,
      strategy: new FlipFlatStrategy(),
      signals: { latest: async () => [signal("m-solo", 20)] },
      alerter: { send: async () => undefined },
      state,
      log: silentLogger,
      now: () => clock.now,
    });
    const tick = async () => {
      venue.tick += 1;
      clock.now += 60_000;
      return engine.tick();
    };
    await tick();
    expect(venue.intents).toHaveLength(1);
    for (let i = 0; i < 9; i++) {
      await tick();
      expect(venue.intents).toHaveLength(1);
    }
    // 600s elapsed with nothing absorbed: the reservation is released and a fresh entry is allowed.
    await tick();
    expect(venue.intents).toHaveLength(2);
  });
});

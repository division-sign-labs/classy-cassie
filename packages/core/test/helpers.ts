// packages/core/test/helpers.ts
// Shared engine builder for the offline e2e tests: FixtureVenue + fixture
// signals + flip-flat + in-memory state + a recording alerter.

import { readFileSync } from "node:fs";
import {
  Engine,
  FixtureSignalSource,
  FixtureVenue,
  MemoryStateStore,
  parseBotConfig,
  silentLogger,
  type AlertEvent,
  type Alerter,
  type VenueAccount,
} from "@quotient-forecasting/cassie-core";
// Relative dist import: core/test has no dependency edge to the strategy
// package, so the workspace name doesn't resolve from here.
import { FlipFlatStrategy } from "../../../strategies/flip-flat/dist/index.js";

export const signalsFixture = readFileSync(new URL("../../../fixtures/signals.json", import.meta.url), "utf8");
export const booksFixture = readFileSync(new URL("../../../fixtures/books.json", import.meta.url), "utf8");

export class RecordingAlerter implements Alerter {
  events: AlertEvent[] = [];
  async send(event: AlertEvent): Promise<void> {
    this.events.push(event);
  }
  ofKind(kind: AlertEvent["kind"]): AlertEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }
}

export function buildFixtureEngine() {
  const config = parseBotConfig({
    id: "fxbot",
    venue: "polymarket",
    risk: { maxSlippageBps: 300 },
    strategy: { id: "flip-flat", config: { entrySpreadPp: 10, maxPositionNotional: 50 } },
    tickIntervalMin: 5,
  });
  const venue = new FixtureVenue(booksFixture);
  const signals = new FixtureSignalSource(signalsFixture);
  const alerter = new RecordingAlerter();
  const state = new MemoryStateStore();
  const account: VenueAccount = { venue: "fixture", address: "0xF1XTURE" };
  const engine = new Engine({
    botId: "fxbot",
    config,
    adapter: venue,
    account,
    strategy: new FlipFlatStrategy(),
    signals,
    alerter,
    state,
    log: silentLogger,
  });
  return { engine, venue, signals, alerter, state, account, config };
}

// packages/runtime-node/test/market-make-controller.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryStateStore,
  type Fill,
  type Order,
  type OrderIntent,
  type OrderLifecycleHooks,
  type Position,
  type VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import {
  createMarketMakeConfig,
  type MarketMakeConfig,
} from "@quotient-forecasting/strategy-market-make";
import {
  MarketMakeController,
  marketMakeStrategyCapitalUsd,
  type MarketMakeControllerDeps,
  type MarketMakeMetricsProvider,
} from "../src/market-make-controller.js";
import { MarketMakeStateStore } from "../src/market-make-state.js";

const MARKET_KEY = "polymarket:101";
const YES = "yes-token-101";
const NO = "no-token-101";
const CONDITION = "0xcondition101";
const START = 2_000_000_000_000;

const metrics: MarketMakeMetricsProvider = {
  async snapshots(input) {
    return {
      volatility: { rv24Pp: 2, acceleration: 1 },
      stability: { validSince: input.now - 60_000, maxMoveAwayFromQPp: 0 },
    };
  },
};

function testConfig(): MarketMakeConfig {
  return createMarketMakeConfig({
    capital: {
      minimum_free_collateral_usd: 0,
      operational_reserve_usd: 0,
    },
    quotient_feed: {
      daily_api_cost_cap_usd: 0.05,
    },
    eligibility: {
      entry_stability_seconds: 0,
      min_live_depth_usd_within_2c: 0,
      min_volume_24h_usd: 0,
    },
    cassie_overrides: {
      liquidity: {
        minimum_exit_bid_depth_1c_usd: 0,
        minimum_exit_bid_depth_2c_usd: 0,
      },
    },
  });
}

interface FakeVenueControl {
  adapter: VenueAdapter;
  collateralUsd: number;
  orders: Order[];
  fills: Fill[];
  positions: Position[];
  lifecycleStates: string[];
  placeCalls: OrderIntent[];
  cancelCalls: string[];
  heartbeatCalls: number;
  failAfterPrepare: boolean;
  bookTs: number;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  tokenBookCalls: number;
}

function fakeVenue(stateStore: MarketMakeStateStore): FakeVenueControl {
  const control: FakeVenueControl = {
    adapter: undefined as unknown as VenueAdapter,
    collateralUsd: 500,
    orders: [],
    fills: [],
    positions: [],
    lifecycleStates: [],
    placeCalls: [],
    cancelCalls: [],
    heartbeatCalls: 0,
    failAfterPrepare: false,
    bookTs: START,
    yesBid: 0.49,
    yesAsk: 0.5,
    noBid: 0.49,
    noAsk: 0.5,
    tokenBookCalls: 0,
  };
  let orderCounter = 0;
  control.adapter = {
    id: "polymarket",
    verifiedAgainst: "fixture",
    setup: async () => ({ venue: "polymarket", signerAddress: "0x1", funder: "0x2", signatureType: 3 }),
    fundingInstructions: async () => ({ venue: "polymarket", addresses: [], summary: "fixture" }),
    awaitFunding: async () => ({ asset: "pUSD", total: control.collateralUsd, available: control.collateralUsd }),
    balances: async () => [{ asset: "pUSD", total: control.collateralUsd, available: control.collateralUsd }],
    positions: async () => structuredClone(control.positions),
    book: async (marketRef) => ({
      marketRef,
      bids: [{ price: 0.49, size: 10_000 }],
      asks: [{ price: 0.5, size: 10_000 }],
      ts: START,
    }),
    tokenBook: async (tokenId) => {
      control.tokenBookCalls += 1;
      const yes = tokenId === YES;
      return {
        marketRef: tokenId,
        bids: [{ price: yes ? control.yesBid : control.noBid, size: 10_000 }],
        asks: [{ price: yes ? control.yesAsk : control.noAsk, size: 10_000 }],
        ts: control.bookTs,
      };
    },
    quote: async (marketRef) => ({ marketRef, bid: 0.49, ask: 0.5, mid: 0.495, volume24h: 10_000, spreadBps: 202, ts: START }),
    placeOrder: async () => { throw new Error("controller must use lifecycle placement"); },
    placeOrderWithLifecycle: async (_account, intent, hooks: OrderLifecycleHooks) => {
      control.placeCalls.push(structuredClone(intent));
      control.lifecycleStates.push(stateStore.getOrder(intent.clientId)?.status ?? "missing-before-adapter");
      await hooks.onPrepared({
        preparedHash: `prepared-${intent.clientId}`,
        tokenId: intent.tokenId!,
        conditionId: intent.conditionId,
        outcome: intent.outcome,
      });
      control.lifecycleStates.push(stateStore.getOrder(intent.clientId)?.status ?? "missing-after-prepare");
      if (control.failAfterPrepare) throw new Error("fixture acknowledgement timeout");
      const id = `venue-${++orderCounter}`;
      control.orders.push({
        id,
        clientId: intent.clientId,
        marketRef: intent.marketRef,
        tokenId: intent.tokenId,
        conditionId: intent.conditionId,
        outcome: intent.outcome,
        side: intent.side,
        size: intent.size,
        filledSize: 0,
        price: intent.limitPrice,
        tif: intent.tif,
        status: "open",
        createdAt: START,
      });
      return { orderId: id, clientId: intent.clientId, status: "open", tokenId: intent.tokenId };
    },
    cancelOrder: async (_account, id) => {
      control.cancelCalls.push(id);
      control.orders = control.orders.filter((order) => order.id !== id);
    },
    cancelAll: async () => {
      control.orders = [];
    },
    openOrders: async () => structuredClone(control.orders),
    fills: async (_account, sinceTs) => structuredClone(control.fills.filter((fill) => fill.ts >= sinceTs)),
    heartbeat: async () => {
      control.heartbeatCalls += 1;
    },
  } as VenueAdapter;
  return control;
}

function quotient(now: () => number, active = true) {
  const calls = { active: 0, exact: [] as string[][] };
  return {
    calls,
    client: {
      spentUsd: 0,
      async activeSignals() {
        calls.active += 1;
        if (!active) return [];
        const at = new Date(now()).toISOString();
        return [{
          signalId: "signal-101",
          marketKey: MARKET_KEY,
          nativeMarketId: "101",
          conditionId: CONDITION,
          publishedAt: at,
          forecastAt: at,
          entryQYes: 0.71,
          entryMarketYes: 0.495,
          qYes: 0.71,
          publishedSide: "YES" as const,
          isActive: true,
          forecastStatus: { state: "sideways" as const, drawdownRiskElevated: false },
        }];
      },
      async exactForecasts(keys: string[]) {
        calls.exact.push([...keys]);
        const at = new Date(now()).toISOString();
        return keys.map((marketKey) => ({
          marketKey,
          qYes: 0.71,
          forecastAt: at,
          forecastStatus: { state: "sideways" as const, drawdownRiskElevated: false },
        }));
      },
    },
  };
}

function catalog(now: () => number) {
  return {
    async market(marketKey: string, nativeMarketId: string, conditionId: string) {
      return {
        marketKey,
        nativeMarketId,
        conditionId,
        marketRef: YES,
        eventId: "polymarket:event-1",
        category: "Economics",
        yesTokenId: YES,
        noTokenId: NO,
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        orderbookEnabled: true,
        endsAt: now() + 7 * 24 * 60 * 60 * 1_000,
        volume24hUsd: 10_000,
        tickSize: 0.01,
        minOrderSize: 1,
      };
    },
  };
}

describe("MarketMakeController", () => {
  let dir: string;
  let path: string;
  let stateStore: MarketMakeStateStore;
  let snapshotStore: MemoryStateStore;
  let clock: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cassie-mm-controller-"));
    path = join(dir, "bot.sqlite");
    stateStore = new MarketMakeStateStore(path);
    snapshotStore = new MemoryStateStore();
    clock = START;
  });

  afterEach(() => {
    stateStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function build(
    control: FakeVenueControl,
    q = quotient(() => clock),
    overrides: Partial<MarketMakeControllerDeps> = {},
  ): { controller: MarketMakeController; q: ReturnType<typeof quotient> } {
    const controller = new MarketMakeController({
      config: testConfig(),
      stateStore,
      snapshotStore,
      venue: control.adapter,
      account: { venue: "polymarket", signerAddress: "0x1", funder: "0x2", signatureType: 3 },
      quotient: q.client,
      catalog: catalog(() => clock),
      ...overrides,
    }, {
      deploymentId: "deployment-a",
      now: () => clock,
      autoSchedule: false,
      enableSubscriptions: false,
      metricsProvider: metrics,
    });
    return { controller, q };
  }

  async function applyReconcile(controller: MarketMakeController) {
    const preview = await controller.reconcile({ apply: false });
    return controller.reconcile({ apply: true, expectedProposalHash: preview.proposalHash });
  }

  it("rejects any non-Polymarket adapter before reading or trading", () => {
    const control = fakeVenue(stateStore);
    const wrong = { ...control.adapter, id: "kalshi" as const } as VenueAdapter;
    expect(() => build(control, undefined, { venue: wrong })).toThrow(/Polymarket-only/);
  });

  it("derives sizing from repeatedly observed funded capital without a configured bankroll step", async () => {
    const control = fakeVenue(stateStore);
    control.collateralUsd = 2_000;
    const { controller } = build(control);

    const started = await controller.start();
    expect(started).toMatchObject({
      bankrollMode: "live",
      bankrollObserved: true,
      strategyCapitalUsd: 2_000,
      // A single non-atomic REST observation cannot raise live limits above
      // the immutable reference baseline.
      effectiveBankrollUsd: 500,
    });
    await applyReconcile(controller);
    expect(controller.status()).toMatchObject({
      strategyCapitalUsd: 2_000,
      effectiveBankrollUsd: 2_000,
      bankrollReferenceUsd: 500,
      bankrollScale: 4,
    });

    await controller.resume();
    expect(control.placeCalls).toHaveLength(1);
    expect(control.placeCalls[0]!.size * control.placeCalls[0]!.limitPrice).toBeCloseTo(25);
    // The resting BUY is already reserved elsewhere and must not be added to
    // the funded-capital denominator while its cash remains unspent.
    await controller.reconcile({ apply: false });
    expect(controller.status().strategyCapitalUsd).toBeCloseTo(2_000);
    await controller.shutdown();
  });

  it("requires repeated clean snapshots for increases, blocks uncertain increases, and applies decreases immediately", async () => {
    const control = fakeVenue(stateStore);
    const { controller } = build(control);
    await controller.start();
    await applyReconcile(controller);
    expect(controller.status().effectiveBankrollUsd).toBeCloseTo(500);

    control.collateralUsd = 1_000;
    await controller.reconcile({ apply: false });
    expect(controller.status()).toMatchObject({ strategyCapitalUsd: 1_000, effectiveBankrollUsd: 500 });
    const reviewedIncrease = await controller.reconcile({ apply: false });
    // Report-only observations may establish stability, but cannot authorize
    // a larger trading budget on their own.
    expect(controller.status().effectiveBankrollUsd).toBeCloseTo(500);
    await controller.reconcile({ apply: true, expectedProposalHash: reviewedIncrease.proposalHash });
    expect(controller.status().effectiveBankrollUsd).toBeCloseTo(1_000);

    control.collateralUsd = 400;
    await controller.reconcile({ apply: false });
    expect(controller.status().effectiveBankrollUsd).toBeCloseTo(400);

    control.collateralUsd = 800;
    control.orders.push({
      id: "external-unknown",
      marketRef: YES,
      tokenId: YES,
      conditionId: CONDITION,
      outcome: "YES",
      side: "BUY",
      size: 2,
      filledSize: 0,
      price: 0.5,
      tif: "GTC",
      status: "open",
      createdAt: clock,
    });
    await controller.reconcile({ apply: false });
    await controller.reconcile({ apply: false });
    expect(controller.status()).toMatchObject({ strategyCapitalUsd: 800, effectiveBankrollUsd: 400 });
    await controller.shutdown();
  });

  it("pauses and cancels continuous adds so a funded increase can reach a clean refresh window", async () => {
    const control = fakeVenue(stateStore);
    const { controller } = build(control);
    await controller.start();
    await applyReconcile(controller);
    await controller.resume();
    expect(control.orders).toHaveLength(1);

    control.collateralUsd = 1_000;
    clock += 1_000;
    control.bookTs = clock;
    await controller.tick();
    expect(controller.status()).toMatchObject({
      effectiveBankrollUsd: 500,
      bankrollRefreshPending: true,
      bankrollEntryReady: true,
    });
    expect(control.orders).toHaveLength(0);

    clock += 5 * 60_000 + 1;
    control.bookTs = clock;
    await applyReconcile(controller);
    expect(controller.status()).toMatchObject({
      strategyCapitalUsd: 1_000,
      effectiveBankrollUsd: 1_000,
      bankrollRefreshPending: false,
      bankrollEntryReady: true,
    });
    await controller.shutdown();
  });

  it("honors an optional live bankroll ceiling after funding is observed", async () => {
    const control = fakeVenue(stateStore);
    control.collateralUsd = 2_000;
    const config = testConfig();
    config.cassie_overrides.bankroll.maximum_sizing_bankroll_usd = 600;
    const { controller } = build(control, undefined, { config });

    await controller.start();
    await applyReconcile(controller);
    expect(controller.status()).toMatchObject({
      bankrollMode: "live",
      strategyCapitalUsd: 2_000,
      effectiveBankrollUsd: 600,
      bankrollCeilingUsd: 600,
      bankrollScale: 1.2,
    });
    await controller.resume();
    expect(control.placeCalls[0]!.size * control.placeCalls[0]!.limitPrice).toBeCloseTo(7.5);
    await controller.shutdown();
  });

  it("keeps fixed mode literal, caps entries by actual cash, and cancels adds below its reserve floor", async () => {
    const control = fakeVenue(stateStore);
    control.collateralUsd = 20;
    const config = testConfig();
    config.cassie_overrides.bankroll.mode = "fixed";
    config.capital.minimum_free_collateral_usd = 10;
    config.capital.operational_reserve_usd = 5;
    const { controller } = build(control, undefined, { config });

    await controller.start();
    await applyReconcile(controller);
    expect(controller.status()).toMatchObject({
      bankrollMode: "fixed",
      strategyCapitalUsd: 20,
      effectiveBankrollUsd: 500,
      bankrollScale: 1,
    });
    await controller.resume();
    expect(control.placeCalls).toHaveLength(1);
    expect(control.placeCalls[0]!.size * control.placeCalls[0]!.limitPrice).toBeCloseTo(5);

    control.collateralUsd = 10;
    clock += 1_000;
    control.bookTs = clock;
    await controller.tick();
    expect(control.cancelCalls).toContain("venue-1");
    expect(control.orders).toHaveLength(0);
    await controller.shutdown();
  });

  it("uses cost-basis capital exactly once and fails closed on malformed authoritative positions", () => {
    const position: Position = {
      marketRef: YES,
      tokenId: YES,
      conditionId: CONDITION,
      outcome: "YES",
      side: "YES",
      size: 50,
      avgPrice: 0.5,
      currentPrice: 0.1,
    };
    expect(marketMakeStrategyCapitalUsd(1_975, [position])).toBeCloseTo(2_000);
    expect(marketMakeStrategyCapitalUsd(1_975, [{ ...position, currentPrice: 0.9 }])).toBeCloseTo(2_000);
    expect(() => marketMakeStrategyCapitalUsd(1_975, [position, position])).toThrow(/duplicate token/);
    expect(() => marketMakeStrategyCapitalUsd(1_975, [{ ...position, avgPrice: Number.NaN }])).toThrow(/average price/);
    expect(() => marketMakeStrategyCapitalUsd(Number.NaN, [])).toThrow(/collateral/);
  });

  it("restarts with live entry sizing closed until fresh repeated bankroll snapshots establish capital", async () => {
    const control = fakeVenue(stateStore);
    control.collateralUsd = 100;
    let controller = build(control, quotient(() => clock, false)).controller;
    await controller.start();
    await applyReconcile(controller);
    await controller.resume();
    expect(control.placeCalls).toHaveLength(0);
    await controller.shutdown();

    // A runtime snapshot is allowed to restore strategy inputs and activation.
    // The first authoritative sub-reference observation is an immediate
    // decrease; potentially stale upward authorization is never restored.
    controller = build(control, quotient(() => clock, true)).controller;
    clock += 24 * 60 * 60 * 1_000 + 1_000;
    await controller.start();
    expect(controller.status()).toMatchObject({
      activationCurrent: true,
      strategyCapitalUsd: 100,
      effectiveBankrollUsd: 100,
    });
    expect(control.placeCalls).toHaveLength(0);

    clock += testConfig().quotient_feed.active_poll_seconds * 1_000 + 1;
    control.bookTs = clock;
    await controller.tick();
    expect(controller.status().effectiveBankrollUsd).toBeCloseTo(100);
    expect(control.placeCalls).toHaveLength(1);
    expect(control.placeCalls[0]!.size * control.placeCalls[0]!.limitPrice).toBeCloseTo(1.25);
    await controller.shutdown();
  });

  it("restores proven high-bankroll loss supervision without restoring entry authorization", async () => {
    const control = fakeVenue(stateStore);
    control.collateralUsd = 10_000;
    let controller = build(control).controller;
    await controller.start();
    await applyReconcile(controller);
    await controller.resume();

    const entry = control.orders[0]!;
    const entryCost = entry.size * entry.price;
    control.orders = [];
    control.collateralUsd = 10_000 - entryCost;
    control.positions = [{
      marketRef: YES,
      tokenId: YES,
      conditionId: CONDITION,
      outcome: "YES",
      side: "YES",
      size: entry.size,
      avgPrice: entry.price,
    }];
    control.fills = [{
      id: "high-bankroll-fill",
      orderId: entry.id,
      makerOrderId: entry.id,
      marketRef: YES,
      tokenId: YES,
      conditionId: CONDITION,
      outcome: "YES",
      side: "BUY",
      size: entry.size,
      matchedAmountDelta: entry.size,
      price: entry.price,
      ts: clock,
    }];
    await applyReconcile(controller);
    control.fills = [];
    await controller.shutdown();

    // This mark loses more than the $500 template's $8 market limit, but far
    // less than the proven $10k account's scaled $160 limit. Restart must use
    // the latter for supervision while keeping new entries closed.
    clock += 61_000;
    control.bookTs = clock;
    control.yesBid = 0.35;
    control.yesAsk = 0.36;
    control.noBid = 0.64;
    control.noAsk = 0.65;
    controller = build(control).controller;
    await controller.start();

    expect(controller.status()).toMatchObject({
      lifecycle: "ACTIVE",
      effectiveBankrollUsd: 10_000,
      bankrollEntryReady: false,
      lossLatched: false,
    });
    expect(controller.stateSnapshot().loss.marketLossUsd[MARKET_KEY]).toBeGreaterThan(8);
    expect(control.placeCalls.filter((order) => order.side === "BUY")).toHaveLength(1);
    await controller.shutdown();
  });

  it("cancels resting inventory adds when live capital falls to zero while preserving exit supervision", async () => {
    const control = fakeVenue(stateStore);
    const { controller } = build(control);
    await controller.start();
    await applyReconcile(controller);
    await controller.resume();
    expect(control.orders).toHaveLength(1);
    expect(control.orders[0]!.side).toBe("BUY");

    control.collateralUsd = 0;
    clock += 1_000;
    control.bookTs = clock;
    await controller.tick();

    expect(controller.status().effectiveBankrollUsd).toBe(0);
    expect(control.cancelCalls).toContain("venue-1");
    expect(control.orders).toHaveLength(0);
    expect(stateStore.listOrders()[0]).toMatchObject({ status: "CANCELED", reservedCashUsd: 0 });
    await controller.shutdown();
  });

  it("starts preview-only, applies reviewed reconciliation, and reserves before SDK signing/POST on explicit resume", async () => {
    const control = fakeVenue(stateStore);
    const { controller } = build(control);

    const started = await controller.start();
    expect(started.halted).toBe(true);
    expect(started).toMatchObject({ lifecycle: "HALTED", activationCurrent: false, counts: expect.any(Object), loss: expect.any(Object) });
    expect(started.persistence.lastReconciliation).toBeUndefined();
    expect(control.placeCalls).toHaveLength(0);

    clock += 1_000;
    await applyReconcile(controller);
    const active = await controller.resume();
    expect(active.halted).toBe(false);
    expect(active.persistence.activationCurrent).toBe(true);
    expect(control.placeCalls).toHaveLength(1);
    expect(control.placeCalls[0]).toMatchObject({
      marketRef: YES,
      tokenId: YES,
      outcome: "YES",
      side: "BUY",
      tif: "GTC",
      postOnly: true,
    });
    expect(control.lifecycleStates).toEqual(["RESERVED", "SUBMITTING"]);
    const persisted = stateStore.listOrders()[0];
    expect(persisted).toMatchObject({
      status: "OPEN",
      signedOrderHash: expect.stringContaining("prepared-mm:"),
      venueOrderId: "venue-1",
    });
    expect(control.heartbeatCalls).toBeGreaterThan(0);
    await controller.shutdown();
  });

  it("reduces refreshed Gamma metadata before the same poll's Quotient signal", async () => {
    const control = fakeVenue(stateStore);
    const { controller } = build(control);
    const processEvent = vi.spyOn(
      controller as unknown as { processEvent(event: { type: string }): Promise<unknown> },
      "processEvent",
    );

    await controller.start();
    await applyReconcile(controller);
    clock += testConfig().market_catalog.gamma_refresh_seconds * 1_000 + 1;
    control.bookTs = clock;
    processEvent.mockClear();
    await controller.resume();

    const decisionEvents = processEvent.mock.calls
      .map(([event]) => event.type)
      .filter((type) => type === "catalog" || type === "signal");
    expect(decisionEvents.slice(0, 2)).toEqual(["catalog", "signal"]);
    await controller.shutdown();
  });

  it("reduces Gamma refreshes for a resting-only market even when Q discovery is budget-gated", async () => {
    const control = fakeVenue(stateStore);
    const config = testConfig();
    config.quotient_feed.daily_api_cost_cap_usd = 0.02;
    const baseCatalog = catalog(() => clock);
    let eventId = "polymarket:event-before-refresh";
    const { controller } = build(control, undefined, {
      config,
      catalog: {
        async market(marketKey, nativeMarketId, conditionId) {
          return {
            ...await baseCatalog.market(marketKey, nativeMarketId, conditionId),
            eventId,
          };
        },
      },
    });

    await controller.start();
    await applyReconcile(controller);
    await controller.resume();
    expect(control.orders).toHaveLength(1);

    eventId = "polymarket:event-after-refresh";
    clock += config.market_catalog.gamma_refresh_seconds * 1_000 + 1;
    control.bookTs = clock;
    const processEvent = vi.spyOn(
      controller as unknown as { processEvent(event: { type: string }): Promise<unknown> },
      "processEvent",
    );
    await controller.tick();

    const decisionEvents = processEvent.mock.calls
      .map(([event]) => event.type)
      .filter((type) => type === "catalog" || type === "signal");
    expect(decisionEvents[0]).toBe("catalog");
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.catalog?.eventId).toBe(eventId);
    await controller.shutdown();
  });

  it("keeps prepared-but-unacknowledged orders UNKNOWN without immediate retry", async () => {
    const control = fakeVenue(stateStore);
    control.failAfterPrepare = true;
    const { controller } = build(control);
    await controller.start();
    clock += 1_000;
    await applyReconcile(controller);
    await controller.resume();

    expect(control.placeCalls).toHaveLength(1);
    expect(stateStore.listOrders()).toHaveLength(1);
    expect(stateStore.listOrders()[0]).toMatchObject({
      status: "UNKNOWN",
      reservedCashUsd: expect.any(Number),
      lastError: "fixture acknowledgement timeout",
    });
    expect(Object.values(controller.stateSnapshot().markets[MARKET_KEY]?.orders ?? {})[0]).toMatchObject({ status: "UNKNOWN" });
    await controller.shutdown();
  });

  it("restores reducer anchors/orders and exact-lookups held markets missing from discovery", async () => {
    const control = fakeVenue(stateStore);
    const firstQ = quotient(() => clock);
    let controller = build(control, firstQ).controller;
    await controller.start();
    clock += 1_000;
    await applyReconcile(controller);
    await controller.resume();
    const placed = control.orders[0]!;
    control.orders = [];
    control.positions = [{
      marketRef: YES,
      tokenId: YES,
      conditionId: CONDITION,
      outcome: "YES",
      side: "YES",
      size: 2,
      avgPrice: placed.price,
    }];
    control.fills = [{
      id: "trade-1",
      orderId: placed.id,
      makerOrderId: placed.id,
      marketRef: YES,
      tokenId: YES,
      conditionId: CONDITION,
      outcome: "YES",
      side: "BUY",
      size: 2,
      matchedAmountDelta: 2,
      price: placed.price,
      ts: clock,
    }];
    await applyReconcile(controller);
    const before = controller.stateSnapshot().markets[MARKET_KEY]!.inventory!;
    expect(before.anchorQSide).toBeCloseTo(0.71);
    await controller.shutdown();

    stateStore.close();
    stateStore = new MarketMakeStateStore(path);
    const secondQ = quotient(() => clock, false);
    controller = build(control, secondQ).controller;
    clock += 15 * 60 * 1_000;
    await controller.start();

    const after = controller.stateSnapshot().markets[MARKET_KEY]!.inventory!;
    expect(after.anchorQSide).toBe(before.anchorQSide);
    expect(after.anchorFillPrice).toBe(before.anchorFillPrice);
    expect(after.firstFillAt).toBe(before.firstFillAt);
    expect(secondQ.calls.exact).toContainEqual([MARKET_KEY]);
    expect(stateStore.listInventoryCycles(true)[0]).toMatchObject({
      anchorQProbability: 0.71,
      anchorExecutionPrice: before.anchorFillPrice,
    });
    await controller.shutdown();
  });

  it("halts idempotently and dry-run never mutates or submits", async () => {
    const control = fakeVenue(stateStore);
    const { controller, q } = build(control);
    await controller.start();
    clock += 1_000;
    await applyReconcile(controller);
    await controller.resume();
    const placements = control.placeCalls.length;
    const before = controller.stateSnapshot();
    const persistedBefore = await snapshotStore.get("market-make:reducer-state:v1");
    const qCallsBefore = q.calls.active;
    await controller.dryRun();
    expect(control.placeCalls).toHaveLength(placements);
    expect(controller.stateSnapshot()).toEqual(before);
    const persistedAfter = await snapshotStore.get("market-make:reducer-state:v1");
    const beforePayload = JSON.parse(persistedBefore!) as Record<string, unknown>;
    const afterPayload = JSON.parse(persistedAfter!) as Record<string, unknown>;
    expect(afterPayload.state).toEqual(beforePayload.state);
    expect(afterPayload.lastEventSeq).toBe(beforePayload.lastEventSeq);
    expect(afterPayload.quotientSpendUsd).toBe(Number(beforePayload.quotientSpendUsd) + 0.01);
    expect(q.calls.active).toBe(qCallsBefore + 1);

    clock += 1_000;
    await controller.halt();
    clock += 1_000;
    await controller.halt();
    expect(control.cancelCalls).toEqual(["venue-1"]);
    expect(controller.status()).toMatchObject({ halted: true, persistence: { lifecycle: "HALTED" } });
    await controller.shutdown();
  });

  it("detects adverse CLOB shocks from supervised books and cancels resting entries", async () => {
    const control = fakeVenue(stateStore);
    const { controller } = build(control);
    await controller.start();
    clock += 1_000;
    control.bookTs = clock;
    await applyReconcile(controller);
    await controller.resume();
    expect(control.orders).toHaveLength(1);

    clock += 61_000;
    control.bookTs = clock;
    control.yesBid = 0.35;
    control.yesAsk = 0.36;
    control.noBid = 0.64;
    control.noAsk = 0.65;
    await controller.tick();

    expect(stateStore.readEvents(500).some((event) => event.type === "shock")).toBe(true);
    expect(control.cancelCalls).toContain("venue-1");
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.shockPausedUntil).toBeGreaterThan(clock);
    await controller.shutdown();
  });

  it("marks held inventory at executable bids, latches market loss, and starts a bounded exit", async () => {
    const control = fakeVenue(stateStore);
    const config = testConfig();
    config.loss_limits.max_marked_loss_per_market_usd = 0.1;
    config.loss_limits.max_rolling_24h_loss_usd = 1_000;
    config.loss_limits.max_strategy_drawdown_usd = 1_000;
    const { controller } = build(control, undefined, { config });
    await controller.start();
    clock += 1_000;
    control.bookTs = clock;
    await applyReconcile(controller);
    await controller.resume();
    const entry = control.orders[0]!;
    control.orders = [];
    control.positions = [{
      marketRef: YES,
      tokenId: YES,
      conditionId: CONDITION,
      outcome: "YES",
      side: "YES",
      size: 2,
      avgPrice: entry.price,
    }];
    control.fills = [{
      id: "loss-fill",
      orderId: entry.id,
      makerOrderId: entry.id,
      marketRef: YES,
      tokenId: YES,
      conditionId: CONDITION,
      outcome: "YES",
      side: "BUY",
      size: 2,
      matchedAmountDelta: 2,
      price: entry.price,
      ts: clock,
    }];
    await applyReconcile(controller);

    clock += 61_000;
    control.bookTs = clock;
    control.yesBid = 0.1;
    control.yesAsk = 0.11;
    control.noBid = 0.89;
    control.noAsk = 0.9;
    await controller.tick();

    expect(controller.status()).toMatchObject({ lifecycle: "RISK_EXIT_ONLY", lossLatched: true });
    expect(controller.stateSnapshot().loss.marketLossUsd[MARKET_KEY]).toBeGreaterThan(0.1);
    expect(control.placeCalls).toEqual(expect.arrayContaining([expect.objectContaining({ side: "SELL" })]));
    expect((await snapshotStore.readErrors()).some((row) => row.code === "MM_LOSS_LATCHED")).toBe(true);
    await expect(controller.resume({ acknowledgeLossReset: true })).rejects.toThrow(
      /current marked market loss still breaches limits/,
    );
    await controller.shutdown();
  });

  it("rebases both durable and in-memory loss history after an acknowledged cash withdrawal", async () => {
    const control = fakeVenue(stateStore);
    const { controller } = build(control, quotient(() => clock, false));
    await controller.start();
    await applyReconcile(controller);
    await controller.resume();

    clock += 61_000;
    control.bookTs = clock;
    await controller.tick();
    expect(controller.status().loss.highWaterUsd).toBeCloseTo(500);

    control.collateralUsd = 100;
    clock += 61_000;
    control.bookTs = clock;
    await controller.tick();
    expect(controller.status()).toMatchObject({ lifecycle: "RISK_EXIT_ONLY", lossLatched: true });

    await controller.resume({ acknowledgeLossReset: true });
    clock += 61_000;
    control.bookTs = clock;
    await controller.tick();
    expect(controller.status()).toMatchObject({ lifecycle: "ACTIVE", lossLatched: false });
    expect(controller.status().loss).toMatchObject({
      rolling24hLossUsd: 0,
      drawdownUsd: 0,
      highWaterUsd: 100,
    });
    await controller.shutdown();
  });

  it("rebases a reviewed flat withdrawal even when it stayed below the loss latch", async () => {
    const control = fakeVenue(stateStore);
    const { controller } = build(control, quotient(() => clock, false));
    await controller.start();
    await applyReconcile(controller);
    await controller.resume();

    clock += 61_000;
    control.bookTs = clock;
    await controller.tick();
    expect(controller.status().loss.highWaterUsd).toBeCloseTo(500);

    await controller.halt();
    control.collateralUsd = 490;
    clock += 61_000;
    control.bookTs = clock;
    await controller.tick();
    expect(controller.status()).toMatchObject({ lifecycle: "HALTED", lossLatched: false });
    expect(controller.status().loss).toMatchObject({
      rolling24hLossUsd: 10,
      drawdownUsd: 10,
      highWaterUsd: 500,
    });

    await controller.resume({ acknowledgeLossReset: true });
    clock += 61_000;
    control.bookTs = clock;
    await controller.tick();
    expect(controller.status()).toMatchObject({ lifecycle: "ACTIVE", lossLatched: false });
    expect(controller.status().loss).toMatchObject({
      rolling24hLossUsd: 0,
      drawdownUsd: 0,
      highWaterUsd: 490,
    });
    await controller.shutdown();
  });

  it("persists the UTC-day Quotient cap and keeps supervising books without polling Q", async () => {
    const control = fakeVenue(stateStore);
    const config = testConfig();
    config.quotient_feed.daily_api_cost_cap_usd = 0.01;
    const firstQ = quotient(() => clock);
    let controller = build(control, firstQ, { config }).controller;
    await controller.start();
    await applyReconcile(controller);
    expect(firstQ.calls.active).toBe(1);
    const booksAfterStart = control.tokenBookCalls;

    clock += 15_000;
    control.bookTs = clock;
    await controller.tick();
    expect(firstQ.calls.active).toBe(1);
    expect(control.tokenBookCalls).toBeGreaterThan(booksAfterStart);

    clock += config.quotient_feed.idle_poll_seconds * 1_000;
    control.bookTs = clock;
    await controller.tick();
    expect(firstQ.calls.active).toBe(1);
    expect(controller.status().quotientDailySpendUsd).toBeCloseTo(0.01);
    await controller.shutdown();

    stateStore.close();
    stateStore = new MarketMakeStateStore(path);
    const secondQ = quotient(() => clock);
    controller = build(control, secondQ, { config }).controller;
    clock += config.quotient_feed.idle_poll_seconds * 1_000;
    control.bookTs = clock;
    await controller.start();
    expect(secondQ.calls.active).toBe(0);
    expect(controller.status().quotientDailySpendUsd).toBeCloseTo(0.01);
    await controller.shutdown();
  });
});

// packages/runtime-node/test/market-make-controller-adversarial.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryStateStore,
  type Fill,
  type Order,
  type OrderAck,
  type OrderIntent,
  type OrderLifecycleHooks,
  type Position,
  type RealtimeSubscription,
  type VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import {
  createMarketMakeConfig,
  type MarketMakeConfig,
} from "@quotient-forecasting/strategy-market-make";
import {
  MarketMakeController,
  type MarketMakeControllerDeps,
  type MarketMakeMetricsProvider,
  type MarketMakeControllerOptions,
} from "../src/market-make-controller.js";
import { MarketMakeStateStore } from "../src/market-make-state.js";

const MARKET_KEY = "polymarket:adversarial-101";
const YES = "yes-token-adversarial-101";
const NO = "no-token-adversarial-101";
const CONDITION = "0xadversarial101";
const START = 2_000_000_000_000;
const EPSILON = 1e-9;
const FILL_SETTLEMENT_WINDOW_MS = 5 * 60 * 1_000;

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
      daily_api_cost_cap_usd: 1,
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
    global_kill_switches: {
      unresolved_inventory_mismatch_cycles: 2,
    },
  });
}

class ControlledSubscription implements RealtimeSubscription<unknown> {
  private queued: Array<IteratorResult<unknown>> = [];
  private waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  closeCalls = 0;

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async () => {
        const queued = this.queued.shift();
        if (queued) return queued;
        return new Promise<IteratorResult<unknown>>((resolve) => this.waiters.push(resolve));
      },
    };
  }

  push(value: unknown): void {
    const result: IteratorResult<unknown> = { done: false, value };
    const waiter = this.waiters.shift();
    if (waiter) waiter(result);
    else this.queued.push(result);
  }

  endUnexpectedly(): void {
    const result: IteratorResult<unknown> = { done: true, value: undefined };
    const waiter = this.waiters.shift();
    if (waiter) waiter(result);
    else this.queued.push(result);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.endUnexpectedly();
  }
}

interface VenueControl {
  adapter: VenueAdapter;
  collateralUsd: number;
  orders: Order[];
  fills: Fill[];
  positions: Position[];
  placeCalls: OrderIntent[];
  cancelCalls: string[];
  cancelAllCalls: number;
  redeemCalls: number;
  positionCalls: number;
  heartbeatCalls: number;
  heartbeatFailuresRemaining: number;
  fillSinceCalls: number[];
  acknowledgement: OrderAck["status"];
  failAfterPrepare: boolean;
  alwaysFailCancel: boolean;
  cancelAllFails: boolean;
  redeemFailuresRemaining: number;
  removePositionOnRedeem: boolean;
  failPositionReadAt?: number;
  /** While set, every positions read throws this message. */
  positionReadFailure?: string;
  marketSubscribeFailuresRemaining: number;
  marketSubscriptions: ControlledSubscription[];
  userSubscriptions: ControlledSubscription[];
  bookTs: number;
  tokenBookCalls: string[];
  /** When it returns an error, that book read throws instead of returning. */
  tokenBookThrow?: (tokenId: string, callIndex: number) => Error | undefined;
  tokenBookOverride?: (tokenId: string, callIndex: number) => {
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
    ts: number;
  };
}

function fakeVenue(stateStore: MarketMakeStateStore): VenueControl {
  const control: VenueControl = {
    adapter: undefined as unknown as VenueAdapter,
    collateralUsd: 500,
    orders: [],
    fills: [],
    positions: [],
    placeCalls: [],
    cancelCalls: [],
    cancelAllCalls: 0,
    redeemCalls: 0,
    positionCalls: 0,
    heartbeatCalls: 0,
    heartbeatFailuresRemaining: 0,
    fillSinceCalls: [],
    acknowledgement: "open",
    failAfterPrepare: false,
    alwaysFailCancel: false,
    cancelAllFails: false,
    redeemFailuresRemaining: 0,
    removePositionOnRedeem: false,
    marketSubscribeFailuresRemaining: 0,
    marketSubscriptions: [],
    userSubscriptions: [],
    bookTs: START,
    tokenBookCalls: [],
  };
  let orderCounter = 0;
  control.adapter = {
    id: "polymarket",
    verifiedAgainst: "adversarial-fixture",
    setup: async () => ({ venue: "polymarket", signerAddress: "0x1", funder: "0x2", signatureType: 3 }),
    fundingInstructions: async () => ({ venue: "polymarket", addresses: [], summary: "fixture" }),
    awaitFunding: async () => ({ asset: "pUSD", total: control.collateralUsd, available: control.collateralUsd }),
    balances: async () => [{ asset: "pUSD", total: control.collateralUsd, available: control.collateralUsd }],
    positions: async () => {
      control.positionCalls += 1;
      if (control.positionCalls === control.failPositionReadAt) {
        throw new Error("fixture position preflight failed");
      }
      if (control.positionReadFailure !== undefined) throw new Error(control.positionReadFailure);
      return structuredClone(control.positions);
    },
    book: async (marketRef) => ({
      marketRef,
      bids: [{ price: 0.49, size: 10_000 }],
      asks: [{ price: 0.5, size: 10_000 }],
      ts: control.bookTs,
    }),
    tokenBook: async (tokenId) => {
      const callIndex = control.tokenBookCalls.length;
      control.tokenBookCalls.push(tokenId);
      const thrown = control.tokenBookThrow?.(tokenId, callIndex);
      if (thrown) throw thrown;
      const overridden = control.tokenBookOverride?.(tokenId, callIndex);
      return {
        marketRef: tokenId,
        bids: overridden?.bids ?? [{ price: 0.49, size: 10_000 }],
        asks: overridden?.asks ?? [{ price: 0.5, size: 10_000 }],
        ts: overridden?.ts ?? control.bookTs,
      };
    },
    quote: async (marketRef) => ({
      marketRef,
      bid: 0.49,
      ask: 0.5,
      mid: 0.495,
      volume24h: 10_000,
      spreadBps: 202,
      ts: control.bookTs,
    }),
    placeOrder: async () => {
      throw new Error("controller must use lifecycle placement");
    },
    placeOrderWithLifecycle: async (_account, intent, hooks: OrderLifecycleHooks) => {
      control.placeCalls.push(structuredClone(intent));
      await hooks.onPrepared({
        preparedHash: `prepared-${intent.clientId}`,
        tokenId: intent.tokenId!,
        conditionId: intent.conditionId,
        outcome: intent.outcome,
      });
      if (control.failAfterPrepare) throw new Error("fixture acknowledgement timeout");
      const id = `venue-${++orderCounter}`;
      if (control.acknowledgement === "open" || control.acknowledgement === "partial") {
        control.orders.push({
          id,
          clientId: intent.clientId,
          marketRef: intent.marketRef,
          tokenId: intent.tokenId,
          conditionId: intent.conditionId,
          outcome: intent.outcome,
          side: intent.side,
          size: intent.size,
          filledSize: control.acknowledgement === "partial" ? intent.size / 2 : 0,
          price: intent.limitPrice,
          tif: intent.tif,
          status: control.acknowledgement,
          createdAt: START,
        });
      }
      return {
        orderId: id,
        clientId: intent.clientId,
        status: control.acknowledgement,
        tokenId: intent.tokenId,
        ...(control.acknowledgement === "filled"
          ? { filledSize: intent.size, avgFillPrice: intent.limitPrice }
          : {}),
      };
    },
    cancelOrder: async (_account, id) => {
      control.cancelCalls.push(id);
      if (control.alwaysFailCancel) throw new Error("fixture cancel failed");
      control.orders = control.orders.filter((order) => order.id !== id);
    },
    cancelAll: async () => {
      control.cancelAllCalls += 1;
      if (control.cancelAllFails) throw new Error("fixture cancel-all failed");
      control.orders = [];
    },
    openOrders: async () => structuredClone(control.orders),
    fills: async (_account, sinceTs) => {
      control.fillSinceCalls.push(sinceTs);
      return structuredClone(control.fills.filter((fill) => fill.ts >= sinceTs));
    },
    heartbeat: async () => {
      control.heartbeatCalls += 1;
      if (control.heartbeatFailuresRemaining > 0) {
        control.heartbeatFailuresRemaining -= 1;
        throw new Error("fixture heartbeat failed");
      }
    },
    subscribeMarketData: async () => {
      if (control.marketSubscribeFailuresRemaining > 0) {
        control.marketSubscribeFailuresRemaining -= 1;
        throw new Error("fixture market subscription failed");
      }
      const subscription = new ControlledSubscription();
      control.marketSubscriptions.push(subscription);
      return subscription;
    },
    subscribeUserData: async () => {
      const subscription = new ControlledSubscription();
      control.userSubscriptions.push(subscription);
      return subscription;
    },
    redeem: async (_account, position) => {
      control.redeemCalls += 1;
      if (control.redeemFailuresRemaining > 0) {
        control.redeemFailuresRemaining -= 1;
        throw new Error("fixture redemption failed");
      }
      if (control.removePositionOnRedeem) {
        control.positions = control.positions.filter((candidate) =>
          candidate.tokenId !== position.tokenId || candidate.marketRef !== position.marketRef);
      }
    },
  } as VenueAdapter;
  return control;
}

function quotient(now: () => number) {
  return {
    spentUsd: 0,
    async activeSignals() {
      const at = new Date(now()).toISOString();
      return [{
        signalId: "signal-adversarial-101",
        marketKey: MARKET_KEY,
        nativeMarketId: "adversarial-101",
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
      const at = new Date(now()).toISOString();
      return keys.map((marketKey) => ({
        marketKey,
        qYes: 0.71,
        forecastAt: at,
        forecastStatus: { state: "sideways" as const, drawdownRiskElevated: false },
      }));
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
        eventId: "polymarket:event-adversarial",
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

function position(size: number, avgPrice: number, redeemable = false): Position {
  return {
    marketRef: YES,
    tokenId: YES,
    conditionId: CONDITION,
    outcome: "YES",
    side: "YES",
    size,
    avgPrice,
    ...(redeemable ? { redeemable: true } : {}),
  };
}

function authoritativeBuyFill(order: OrderIntent, orderId: string, size: number, ts: number, id: string): Fill {
  return {
    id,
    orderId,
    makerOrderId: orderId,
    marketRef: YES,
    tokenId: YES,
    conditionId: CONDITION,
    outcome: "YES",
    side: "BUY",
    size,
    matchedAmountDelta: size,
    price: order.limitPrice,
    ts,
  };
}

function delayedSellFill(order: OrderIntent, orderId: string, size: number, ts: number, id: string): Fill {
  return {
    id,
    orderId,
    makerOrderId: orderId,
    marketRef: YES,
    tokenId: YES,
    conditionId: CONDITION,
    outcome: "YES",
    side: "SELL",
    size,
    matchedAmountDelta: size,
    price: order.limitPrice,
    ts,
  };
}

describe("MarketMakeController adversarial lifecycle safety", () => {
  let dir: string;
  let path: string;
  let stateStore: MarketMakeStateStore;
  let snapshotStore: MemoryStateStore;
  let clock: number;
  let controllers: MarketMakeController[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cassie-mm-controller-adversarial-"));
    path = join(dir, "bot.sqlite");
    stateStore = new MarketMakeStateStore(path);
    snapshotStore = new MemoryStateStore();
    clock = START;
    controllers = [];
  });

  afterEach(async () => {
    await Promise.allSettled(controllers.map((controller) => controller.shutdown()));
    stateStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function build(
    control: VenueControl,
    overrides: Partial<MarketMakeControllerDeps> = {},
    optionOverrides: Partial<MarketMakeControllerOptions> = {},
  ): MarketMakeController {
    const controller = new MarketMakeController({
      config: testConfig(),
      stateStore,
      snapshotStore,
      venue: control.adapter,
      account: { venue: "polymarket", signerAddress: "0x1", funder: "0x2", signatureType: 3 },
      quotient: quotient(() => clock),
      catalog: catalog(() => clock),
      ...overrides,
    }, {
      deploymentId: "deployment-adversarial",
      now: () => clock,
      autoSchedule: false,
      enableSubscriptions: false,
      metricsProvider: metrics,
      ...optionOverrides,
    });
    controllers.push(controller);
    return controller;
  }

  async function startAndPlace(controller: MarketMakeController, control: VenueControl): Promise<OrderIntent> {
    await controller.start();
    clock += 1_000;
    control.bookTs = clock;
    const preview = await controller.reconcile();
    await controller.reconcile({ apply: true, expectedProposalHash: preview.proposalHash });
    await controller.resume();
    expect(control.placeCalls).toHaveLength(1);
    return control.placeCalls[0]!;
  }

  async function fillOpenEntry(
    controller: MarketMakeController,
    control: VenueControl,
  ): Promise<{ intent: OrderIntent; venueOrderId: string }> {
    const intent = await startAndPlace(controller, control);
    const venueOrderId = control.orders[0]!.id;
    control.orders = [];
    control.positions = [position(intent.size, intent.limitPrice)];
    control.fills = [authoritativeBuyFill(intent, venueOrderId, intent.size, clock, "trade-entry")];
    clock += 1_000;
    control.bookTs = clock;
    const result = await applyReconcile(controller);
    expect(result.fills).toBe(1);
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.inventory?.freeQuantity).toBeCloseTo(intent.size);
    return { intent, venueOrderId };
  }

  async function applyReconcile(controller: MarketMakeController) {
    const preview = await controller.reconcile({ apply: false });
    return controller.reconcile({ apply: true, expectedProposalHash: preview.proposalHash });
  }

  it("does not turn a cumulative filled acknowledgement into synthetic inventory or count the later trade twice", async () => {
    const control = fakeVenue(stateStore);
    control.acknowledgement = "filled";
    const controller = build(control);

    const intent = await startAndPlace(controller, control);
    const storedBeforeTrade = stateStore.getOrder(intent.clientId)!;
    expect(["UNKNOWN", "CANCEL_PENDING"]).toContain(storedBeforeTrade.status);
    expect(storedBeforeTrade.filledQuantity).toBe(0);
    expect(storedBeforeTrade.reservedCashUsd).toBeGreaterThan(0);
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.inventory).toBeUndefined();

    const venueOrderId = storedBeforeTrade.venueOrderId!;
    control.positions = [position(intent.size, intent.limitPrice)];
    control.fills = [authoritativeBuyFill(intent, venueOrderId, intent.size, clock, "trade-authoritative")];
    clock += 1_000;
    control.bookTs = clock;
    const first = await applyReconcile(controller);
    const second = await applyReconcile(controller);

    expect(first.fills).toBe(1);
    expect(second.fills).toBe(0);
    expect(stateStore.getOrder(intent.clientId)).toMatchObject({
      status: "FILLED",
      filledQuantity: intent.size,
      reservedCashUsd: 0,
    });
    expect(stateStore.listInventoryCycles(true)[0]?.quantity).toBeCloseTo(intent.size);
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.inventory?.freeQuantity).toBeCloseTo(intent.size);
    const persisted = stateStore.exportSnapshot();
    expect((persisted.mm_fills as unknown[])).toHaveLength(1);
    expect(Object.keys(controller.stateSnapshot().processedFillIds)).toHaveLength(1);
  });

  it("re-reads a bounded fill overlap so a late older trade is neither missed nor duplicated", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    const intent = await startAndPlace(controller, control);
    const venueOrderId = control.orders[0]!.id;
    const half = intent.size / 2;
    const laterTradeAt = clock + 10 * 60_000;
    const olderLateTradeAt = laterTradeAt - 4 * 60_000;

    control.orders[0] = { ...control.orders[0]!, status: "partial", filledSize: half };
    control.positions = [position(half, intent.limitPrice)];
    control.fills = [authoritativeBuyFill(intent, venueOrderId, half, laterTradeAt, "trade-published-first")];
    clock = laterTradeAt;
    control.bookTs = clock;
    const first = await applyReconcile(controller);
    expect(first.fills).toBe(1);

    control.orders = [];
    control.positions = [position(intent.size, intent.limitPrice)];
    control.fills.push(authoritativeBuyFill(intent, venueOrderId, half, olderLateTradeAt, "trade-published-late"));
    clock += 1_000;
    control.bookTs = clock;
    const second = await applyReconcile(controller);

    expect(control.fillSinceCalls.at(-1)).toBeLessThanOrEqual(olderLateTradeAt);
    expect(second.fills).toBe(1);
    expect(stateStore.listInventoryCycles(true)[0]?.quantity).toBeCloseTo(intent.size);
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.inventory?.freeQuantity).toBeCloseTo(intent.size);
    expect((stateStore.exportSnapshot().mm_fills as unknown[])).toHaveLength(2);
  });

  it("halts on the first inventory mismatch, performs no top-up, and only corrects after repeat evidence cannot be a late fill", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    const { intent } = await fillOpenEntry(controller, control);
    const correctedQuantity = intent.size * 0.6;
    const placementsBeforeMismatch = control.placeCalls.length;

    control.positions = [position(correctedQuantity, intent.limitPrice)];
    clock += 1_000;
    control.bookTs = clock;
    await controller.tick();

    expect(controller.status().halted).toBe(true);
    expect(control.placeCalls.filter((call) => call.side === "BUY")).toHaveLength(placementsBeforeMismatch);
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.inventory?.freeQuantity).toBeCloseTo(intent.size);
    expect(stateStore.listInventoryCycles(true)[0]?.quantity).toBeCloseTo(intent.size);

    // The conservative halt can create a bounded SELL. Until that order is
    // absent and the fill-overlap window expires, it can explain a lower
    // venue balance and the controller must not manufacture a correction.
    control.orders = [];
    clock += 5 * 60_000 + 1;
    control.bookTs = clock;
    await controller.tick();

    expect(controller.status().halted).toBe(true);
    expect(controller.status().lifecycle).not.toBe("ACTIVE");
    expect(control.placeCalls.filter((call) => call.side === "BUY")).toHaveLength(placementsBeforeMismatch);
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.inventory?.freeQuantity).toBeCloseTo(correctedQuantity);
    expect(stateStore.listInventoryCycles(true)[0]?.quantity).toBeCloseTo(correctedQuantity);
  });

  it("recovers an undiscovered held market by exact Gamma identity and adopts it only after repeated snapshots", async () => {
    const control = fakeVenue(stateStore);
    const heldQuantity = 8;
    control.positions = [position(heldQuantity, 0.42)];
    const recoveryCalls: Array<{ conditionId?: string; clobTokenId?: string }> = [];
    const exactCalls: string[][] = [];
    const baseCatalog = catalog(() => clock);
    const recoveredCatalog = await baseCatalog.market(MARKET_KEY, "adversarial-101", CONDITION);
    const controller = build(control, {
      quotient: {
        spentUsd: 0,
        async activeSignals() {
          return [];
        },
        async exactForecasts(keys: string[]) {
          exactCalls.push([...keys]);
          const at = new Date(clock).toISOString();
          return keys.map((marketKey) => ({
            marketKey,
            qYes: 0.71,
            forecastAt: at,
            forecastStatus: { state: "sideways" as const, drawdownRiskElevated: false },
          }));
        },
      },
      catalog: {
        market: baseCatalog.market,
        async recover(identity) {
          recoveryCalls.push({ ...identity });
          return {
            marketKey: MARKET_KEY,
            nativeMarketId: "adversarial-101",
            catalog: recoveredCatalog,
          };
        },
      },
    });

    await controller.start();
    expect(recoveryCalls).toEqual([]);
    const preview = await controller.reconcile({ apply: false });
    await controller.reconcile({ apply: true, expectedProposalHash: preview.proposalHash });
    expect(recoveryCalls).toEqual([{ conditionId: CONDITION, clobTokenId: YES }]);
    expect(stateStore.listInventoryCycles(true)).toHaveLength(0);
    expect(control.placeCalls.filter((call) => call.side === "BUY")).toHaveLength(0);

    clock += 1_000;
    control.bookTs = clock;
    await controller.tick();
    expect(exactCalls).toContainEqual([MARKET_KEY]);
    expect(stateStore.listInventoryCycles(true)).toHaveLength(0);

    clock += 1_000;
    control.bookTs = clock;
    await controller.tick();

    expect(recoveryCalls).toHaveLength(1);
    expect(controller.status().halted).toBe(true);
    expect(controller.status().lifecycle).not.toBe("ACTIVE");
    expect(control.placeCalls.filter((call) => call.side === "BUY")).toHaveLength(0);
    expect(stateStore.listInventoryCycles(true)[0]).toMatchObject({
      marketKey: MARKET_KEY,
      tokenId: YES,
      outcome: "YES",
      status: "RESIDUAL",
      quantity: heldQuantity,
    });
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.inventory).toMatchObject({
      tokenId: YES,
      outcome: "YES",
      freeQuantity: heldQuantity,
    });
  });

  it("keeps an absent UNKNOWN order reserved through cancel-all and releases it only after a later clean snapshot", async () => {
    const control = fakeVenue(stateStore);
    control.failAfterPrepare = true;
    const controller = build(control);
    const intent = await startAndPlace(controller, control);

    expect(stateStore.getOrder(intent.clientId)).toMatchObject({
      status: "UNKNOWN",
      reservedCashUsd: expect.any(Number),
    });
    const reserved = stateStore.getOrder(intent.clientId)!.reservedCashUsd;
    expect(reserved).toBeGreaterThan(0);

    clock += 1_000;
    await applyReconcile(controller);
    expect(stateStore.getOrder(intent.clientId)).toMatchObject({ status: "CANCEL_PENDING", reservedCashUsd: reserved });
    expect(control.cancelAllCalls).toBe(0);

    clock += 1_000;
    await applyReconcile(controller);
    expect(control.cancelAllCalls).toBe(1);
    expect(stateStore.getOrder(intent.clientId)).toMatchObject({ status: "CANCEL_PENDING", reservedCashUsd: reserved });

    clock += 1_000;
    await applyReconcile(controller);
    expect(stateStore.getOrder(intent.clientId)).toMatchObject({ status: "CANCELED", reservedCashUsd: 0 });
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.orders[intent.clientId]?.status).toBe("CANCELED");
  });

  it("retries CANCEL_PENDING orders and escalates repeated cancel failures to cancel-all without releasing risk early", async () => {
    const control = fakeVenue(stateStore);
    control.alwaysFailCancel = true;
    control.cancelAllFails = true;
    const controller = build(control);
    const intent = await startAndPlace(controller, control);

    clock += 1_000;
    await controller.halt();
    expect(stateStore.getOrder(intent.clientId)?.status).toBe("CANCEL_PENDING");
    const reserved = stateStore.getOrder(intent.clientId)!.reservedCashUsd;
    expect(reserved).toBeGreaterThan(EPSILON);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      clock += 1_000;
      await applyReconcile(controller);
    }

    expect(control.cancelCalls.length).toBeGreaterThan(4);
    expect(control.cancelAllCalls).toBe(1);
    expect(stateStore.getOrder(intent.clientId)).toMatchObject({
      status: "CANCEL_PENDING",
      reservedCashUsd: reserved,
    });
    expect(controller.status().lifecycle).toBe("DATA_DEGRADED");
    expect(controller.status().halted).toBe(true);
    const heartbeatBefore = control.heartbeatCalls;
    await (controller as unknown as { heartbeatOnce(): Promise<void> }).heartbeatOnce();
    expect(control.heartbeatCalls).toBe(heartbeatBefore + 1);
  });

  it("globally pauses new entries after three consecutive venue rejections", async () => {
    const control = fakeVenue(stateStore);
    control.acknowledgement = "rejected";
    const controller = build(control);
    await startAndPlace(controller, control);
    expect(controller.stateSnapshot().consecutiveOrderRejections).toBe(1);

    clock += 1_000;
    control.bookTs = clock;
    await controller.tick();

    const paused = controller.stateSnapshot();
    expect(paused.consecutiveOrderRejections).toBe(3);
    expect(control.placeCalls).toHaveLength(3);
    expect(paused.globalEntryPausedUntil).toBe(
      clock + testConfig().loss_limits.three_consecutive_order_rejections_global_pause_seconds * 1_000,
    );
    expect((await snapshotStore.readErrors()).filter((row) => row.code === "MM_ORDER_REJECTION_PAUSE")).toHaveLength(1);

    clock += 1_000;
    control.bookTs = clock;
    await controller.tick();
    expect(control.placeCalls).toHaveLength(3);
  });

  it("retries a definitely pre-submission redemption failure and clears only after zero-position verification", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    const { intent } = await fillOpenEntry(controller, control);
    control.positions = [position(intent.size, intent.limitPrice, true)];
    // The tick's reconciliation reads positions first. Fail the separate
    // executeRedemption preflight, before any external submission can occur.
    control.failPositionReadAt = control.positionCalls + 2;
    control.removePositionOnRedeem = true;

    clock += 1_000;
    control.bookTs = clock;
    await controller.tick();
    expect(control.redeemCalls).toBe(0);
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.inventory?.freeQuantity).toBeCloseTo(intent.size);
    expect(stateStore.listInventoryCycles(true)[0]?.quantity).toBeCloseTo(intent.size);

    clock += 60_001;
    control.bookTs = clock;
    await controller.tick();

    expect(control.redeemCalls).toBe(1);
    expect(control.positions).toHaveLength(0);
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.inventory).toBeDefined();

    clock += 60_001;
    control.bookTs = clock;
    await controller.tick();
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.inventory).toBeUndefined();
    expect(stateStore.listInventoryCycles(true)).toHaveLength(0);
  });

  it("never blindly resubmits a redemption whose external call returned an ambiguous error", async () => {
    const control = fakeVenue(stateStore);
    let controller = build(control);
    const { intent } = await fillOpenEntry(controller, control);
    control.positions = [position(intent.size, intent.limitPrice, true)];
    control.redeemFailuresRemaining = 1;

    clock += 1_000;
    control.bookTs = clock;
    await controller.tick();
    expect(control.redeemCalls).toBe(1);
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.redemption?.status).toBe("submitted");
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.inventory).toBeDefined();
    expect((await snapshotStore.readErrors()).some((row) => row.code === "MM_REDEMPTION_UNCERTAIN")).toBe(true);

    clock += 60_001;
    control.bookTs = clock;
    await controller.tick();
    expect(control.redeemCalls).toBe(1);
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.inventory).toBeDefined();

    control.positions = [];
    clock += 60_001;
    control.bookTs = clock;
    await controller.tick();
    expect(control.redeemCalls).toBe(1);
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.inventory).toBeDefined();

    await controller.shutdown();
    clock += 60_001;
    control.bookTs = clock;
    controller = build(control);
    await controller.start();

    expect(control.redeemCalls).toBe(1);
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.inventory).toBeUndefined();
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.redemption?.status).toBe("confirmed");
    expect(stateStore.listInventoryCycles(true)).toHaveLength(0);
  });

  it("requires both websocket subscription methods when realtime supervision is enabled", () => {
    const control = fakeVenue(stateStore);
    const incomplete = { ...control.adapter, subscribeUserData: undefined } as VenueAdapter;
    expect(() => build(control, { venue: incomplete }, { enableSubscriptions: true })).toThrow(
      /requires both market-data and user-data subscriptions/,
    );
  });

  it("cleans up a partial startup and runs the complete initialization on retry", async () => {
    const control = fakeVenue(stateStore);
    control.marketSubscribeFailuresRemaining = 1;
    const controller = build(control, {}, { enableSubscriptions: true });

    await expect(controller.start()).rejects.toThrow(/market subscription failed/);
    expect(controller.status().started).toBe(false);
    expect(control.userSubscriptions).toHaveLength(1);
    expect(control.userSubscriptions[0]!.closeCalls).toBe(1);

    const retried = await controller.start();
    expect(retried.started).toBe(true);
    expect(control.userSubscriptions).toHaveLength(2);
    expect(control.marketSubscriptions).toHaveLength(1);
  });

  it("invalidates withdrawal quiescence on every new preview until an applied reconcile succeeds", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    await controller.start();
    await applyReconcile(controller);
    expect(controller.status()).toMatchObject({
      settlementQuiescent: true,
      settlementQuiescentAt: clock,
    });

    control.fills = [{
      id: "late-preview-fill",
      marketRef: YES,
      tokenId: YES,
      conditionId: CONDITION,
      outcome: "YES",
      side: "BUY",
      size: 1,
      price: 0.5,
      ts: clock,
    }];
    await controller.reconcile({ apply: false });
    expect(controller.status().settlementQuiescent).toBe(false);
  });

  it("invalidates withdrawal quiescence as soon as an opaque user wake arrives", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control, {}, { enableSubscriptions: true });
    await controller.start();
    await applyReconcile(controller);
    expect(controller.status().settlementQuiescent).toBe(true);

    control.failPositionReadAt = control.positionCalls + 1;
    control.userSubscriptions[0]!.push({ type: "opaque-account-change" });
    await vi.waitFor(() => expect(controller.status().settlementQuiescent).toBe(false));
  });

  it("does not republish quiescence when a user wake lands during reconciliation", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control, {}, { enableSubscriptions: true });
    await controller.start();
    await applyReconcile(controller);
    expect(controller.status().settlementQuiescent).toBe(true);

    const preview = await controller.reconcile({ apply: false });
    let releaseFills!: () => void;
    let markFillsEntered!: () => void;
    const fillsEntered = new Promise<void>((resolve) => {
      markFillsEntered = resolve;
    });
    const fillsReleased = new Promise<void>((resolve) => {
      releaseFills = resolve;
    });
    const originalFills = control.adapter.fills.bind(control.adapter);
    control.adapter.fills = async (account, sinceTs) => {
      markFillsEntered();
      await fillsReleased;
      return originalFills(account, sinceTs);
    };
    const queueWake = vi.spyOn(
      controller as unknown as { queueWake(reason: string): void },
      "queueWake",
    ).mockImplementation(() => undefined);

    const applying = controller.reconcile({
      apply: true,
      expectedProposalHash: preview.proposalHash,
    });
    await fillsEntered;
    control.userSubscriptions[0]!.push({ type: "opaque-mid-reconcile-account-change" });
    await vi.waitFor(() => expect(queueWake).toHaveBeenCalledOnce());
    releaseFills();
    await applying;

    expect(controller.status().settlementQuiescent).toBe(false);
  });

  it("scales a clean no-order deposit automatically and persists reproducible sizing identity", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    await controller.start();
    await applyReconcile(controller);
    expect(controller.status().effectiveBankrollUsd).toBeCloseTo(500);

    control.collateralUsd = 1_000;
    await applyReconcile(controller);
    const status = controller.status();
    expect(status).toMatchObject({
      bankrollObserved: true,
      strategyCapitalUsd: 1_000,
      effectiveBankrollUsd: 1_000,
      bankrollScale: 2,
    });
    expect(status.effectiveConfigHash).not.toBe(status.configHash);

    const persisted = (stateStore.exportSnapshot().mm_decisions as Array<{
      config_hash: string;
      decision_json: string;
    }>).map((row) => ({ ...row, decision: JSON.parse(row.decision_json) as {
      sizing?: Record<string, unknown>;
    } }));
    const scaled = persisted.findLast((row) => row.decision.sizing?.effectiveBankrollUsd === 1_000);
    expect(scaled).toBeDefined();
    expect(scaled?.config_hash).toBe(controller.configHash);
    expect(scaled?.decision.sizing).toMatchObject({
      policyConfigHash: controller.configHash,
      effectiveConfigHash: status.effectiveConfigHash,
      bankrollMode: "live",
      bankrollObserved: true,
      strategyCapitalUsd: 1_000,
      effectiveBankrollUsd: 1_000,
      bankrollReferenceUsd: 500,
      bankrollScale: 2,
    });
  });

  it("does not raise limits when a BUY position appears before its collateral debit settles", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    const { intent } = await fillOpenEntry(controller, control);

    // Cash still reads $500 while the freshly filled shares already appear.
    // Repeat the now internally-consistent snapshot: recency alone must keep
    // the transient double-count from authorizing a larger sizing base.
    await applyReconcile(controller);
    expect(controller.status()).toMatchObject({
      strategyCapitalUsd: 500 + intent.size * intent.limitPrice,
      effectiveBankrollUsd: 500,
      bankrollScale: 1,
    });
  });

  it("does not raise limits when SELL cash appears before venue inventory shrinks", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    const { intent } = await fillOpenEntry(controller, control);
    const entryCost = intent.size * intent.limitPrice;
    control.collateralUsd = 500 - entryCost;
    clock += FILL_SETTLEMENT_WINDOW_MS + 1;
    control.bookTs = clock;
    await applyReconcile(controller);
    expect(controller.status().strategyCapitalUsd).toBeCloseTo(500);

    await controller.halt({ liquidate: true });
    const sell = control.placeCalls.findLast((order) => order.side === "SELL")!;
    const venueSell = control.orders.find((order) => order.side === "SELL")!;
    expect(sell).toBeDefined();
    expect(venueSell).toBeDefined();

    // Sale proceeds are visible, but the position endpoint still shows the
    // pre-sale quantity. The recent fill and durable order settlement must
    // prevent that temporary double-count from increasing policy limits.
    control.collateralUsd += sell.size * sell.limitPrice;
    control.orders = [];
    control.fills.push(delayedSellFill(sell, venueSell.id, sell.size, clock, "trade-sell-cash-first"));
    await applyReconcile(controller);
    expect(controller.status().strategyCapitalUsd).toBeGreaterThan(500);
    expect(controller.status()).toMatchObject({ effectiveBankrollUsd: 500, bankrollScale: 1 });
  });

  it("keeps a recently terminal SELL quarantined when proceeds lead the position and fill indexes", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    const { intent } = await fillOpenEntry(controller, control);
    const entryCost = intent.size * intent.limitPrice;
    control.collateralUsd = 500 - entryCost;
    control.fills = [];
    clock += FILL_SETTLEMENT_WINDOW_MS + 1;
    control.bookTs = clock;
    await applyReconcile(controller);
    expect(controller.status().strategyCapitalUsd).toBeCloseTo(500);

    await controller.halt({ liquidate: true });
    const sell = control.placeCalls.findLast((order) => order.side === "SELL")!;
    expect(sell).toBeDefined();

    // The order disappears and proceeds arrive, but neither the stale
    // position endpoint nor the trade index reflects its fill. Drive the
    // absence protocol through terminal cancellation, then repeat the same
    // inflated economic snapshot. Recent durable lifecycle evidence must
    // continue blocking the apparent bankroll increase.
    control.collateralUsd += sell.size * sell.limitPrice;
    control.orders = [];
    control.fills = [];
    const reconcileOnly = () => (controller as unknown as {
      reconcileInternal(apply: boolean): Promise<unknown>;
    }).reconcileInternal(true);
    await reconcileOnly();
    clock += 1;
    await reconcileOnly();
    clock += 1;
    await reconcileOnly();
    expect(stateStore.listOrders({ activeOnly: true })).toHaveLength(0);
    expect(stateStore.listOrders().findLast((order) => order.side === "SELL")?.status).toBe("CANCELED");

    clock += 1;
    await reconcileOnly();
    clock += 1;
    await reconcileOnly();
    expect(controller.status().strategyCapitalUsd).toBeGreaterThan(500);
    expect(controller.status()).toMatchObject({ effectiveBankrollUsd: 500, bankrollScale: 1 });
  });

  it("hash-binds collateral changes even when reconciliation proposals stay identical", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    await controller.start();

    const preview = await controller.reconcile({ apply: false });
    control.collateralUsd = 499;
    await expect(controller.reconcile({
      apply: true,
      expectedProposalHash: preview.proposalHash,
    })).rejects.toThrow(/proposal changed since preview/);

    const changed = await controller.reconcile({ apply: false });
    expect(changed.proposalHash).not.toBe(preview.proposalHash);
    expect(changed.proposals).toEqual(preview.proposals);
  });

  it("hash-binds managed position cost but ignores read time and volatile position marks", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    const { intent } = await fillOpenEntry(controller, control);
    control.collateralUsd = 500 - intent.size * intent.limitPrice;
    control.positions[0] = {
      ...control.positions[0]!,
      currentPrice: 0.2,
      unrealizedPnl: -2,
      realizedPnl: 1,
      label: "first mark",
    };
    clock += FILL_SETTLEMENT_WINDOW_MS + 1;
    control.bookTs = clock;

    const preview = await controller.reconcile({ apply: false });
    clock += 1_000;
    control.positions[0] = {
      ...control.positions[0]!,
      currentPrice: 0.9,
      unrealizedPnl: 5,
      realizedPnl: -3,
      label: "different mark",
    };
    const markOnly = await controller.reconcile({ apply: false });
    expect(markOnly.proposalHash).toBe(preview.proposalHash);

    control.positions[0] = {
      ...control.positions[0]!,
      avgPrice: control.positions[0]!.avgPrice + 0.01,
    };
    await expect(controller.reconcile({
      apply: true,
      expectedProposalHash: markOnly.proposalHash,
    })).rejects.toThrow(/proposal changed since preview/);
    const changed = await controller.reconcile({ apply: false });
    expect(changed.proposalHash).not.toBe(markOnly.proposalHash);
    expect(changed.proposals).toEqual(markOnly.proposals);
  });

  it("hash-binds known order changes that do not enter unknown-order proposals", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    await startAndPlace(controller, control);

    const preview = await controller.reconcile({ apply: false });
    expect(preview.proposals.unknownOrdersToCancel).toEqual([]);
    control.orders[0] = { ...control.orders[0]!, filledSize: 0.25 };
    await expect(controller.reconcile({
      apply: true,
      expectedProposalHash: preview.proposalHash,
    })).rejects.toThrow(/proposal changed since preview/);
    const changed = await controller.reconcile({ apply: false });
    expect(changed.proposalHash).not.toBe(preview.proposalHash);
    expect(changed.proposals).toEqual(preview.proposals);
  });

  it("hash-binds fill-only changes that do not alter cancellation or inventory proposals", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    await controller.start();

    const preview = await controller.reconcile({ apply: false });
    control.fills = [{
      id: "external-fill-only-change",
      marketRef: YES,
      tokenId: YES,
      conditionId: CONDITION,
      outcome: "YES",
      side: "BUY",
      size: 1,
      price: 0.5,
      ts: clock,
      fee: 0.01,
    }];
    await expect(controller.reconcile({
      apply: true,
      expectedProposalHash: preview.proposalHash,
    })).rejects.toThrow(/proposal changed since preview/);
    const changed = await controller.reconcile({ apply: false });
    expect(changed.proposalHash).not.toBe(preview.proposalHash);
    expect(changed.proposals).toEqual(preview.proposals);
  });

  it("previews exact known-market UNKNOWN cancellations and hash-binds apply without touching startup orders", async () => {
    const control = fakeVenue(stateStore);
    control.orders = [{
      id: "external-known-order",
      marketRef: YES,
      tokenId: YES,
      conditionId: CONDITION,
      outcome: "YES",
      side: "BUY",
      size: 4,
      filledSize: 0,
      price: 0.45,
      tif: "GTC",
      status: "open",
      createdAt: clock,
    }];
    const controller = build(control);

    await controller.start();
    expect(control.cancelCalls).toEqual([]);
    expect(controller.status().persistence.lastReconciliation).toBeUndefined();

    const preview = await controller.reconcile({ apply: false });
    expect(preview.unknownOrders).toBe(1);
    expect(preview.proposals.unknownOrdersToCancel).toEqual([expect.objectContaining({
      venueOrderId: "external-known-order",
      marketKey: MARKET_KEY,
      tokenId: YES,
      remainingQuantity: 4,
    })]);
    await expect(controller.reconcile({ apply: true })).rejects.toThrow(/requires the proposal hash/);
    expect(control.cancelCalls).toEqual([]);

    control.orders[0] = { ...control.orders[0]!, size: 5 };
    const durableBeforeStaleApply = stateStore.exportSnapshot();
    await expect(controller.reconcile({
      apply: true,
      expectedProposalHash: preview.proposalHash,
    })).rejects.toThrow(/proposal changed since preview/);
    expect(control.cancelCalls).toEqual([]);
    expect(stateStore.exportSnapshot()).toEqual(durableBeforeStaleApply);

    const refreshed = await controller.reconcile({ apply: false });
    const applied = await controller.reconcile({
      apply: true,
      expectedProposalHash: refreshed.proposalHash,
    });
    expect(applied.proposalHash).toBe(refreshed.proposalHash);
    expect(applied.unknownOrders).toBe(1);
    expect(applied.canceledUnknownOrders).toBe(1);
    expect(control.cancelCalls).toEqual(["external-known-order"]);
  });

  it("persists held-position catalog recovery failures for operator review", async () => {
    const control = fakeVenue(stateStore);
    control.positions = [position(3, 0.4)];
    const baseCatalog = catalog(() => clock);
    const controller = build(control, {
      quotient: {
        spentUsd: 0,
        async activeSignals() { return []; },
        async exactForecasts() { return []; },
      },
      catalog: {
        market: baseCatalog.market,
        async recover() { throw new Error("fixture Gamma outage"); },
      },
    });
    await controller.start();
    const preview = await controller.reconcile({ apply: false });
    await controller.reconcile({ apply: true, expectedProposalHash: preview.proposalHash });

    expect((await snapshotStore.readErrors()).some((row) => row.code === "MM_CATALOG_RECOVERY_FAILED")).toBe(true);
  });

  it("keeps an acknowledged order out of UNKNOWN when the first post-ACK heartbeat fails", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    await controller.start();
    await applyReconcile(controller);
    control.heartbeatFailuresRemaining = 1;

    await controller.resume();

    const order = stateStore.listOrders()[0]!;
    expect(order.venueOrderId).toBe("venue-1");
    expect(order.status).not.toBe("UNKNOWN");
    expect(order.status).toBe("CANCEL_PENDING");
    expect(controller.status().lifecycle).toBe("DATA_DEGRADED");
  });

  it("rejects a stale entry intent when the live best-bid level collapses before submission", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    await controller.start();
    clock += 1_000;
    control.bookTs = clock;
    await applyReconcile(controller);

    // The reducer first sees enough size at the best bid to request its normal
    // ticket. The pre-submit re-read then sees that best level collapse while
    // deeper 1c/2c liquidity remains ample, isolating the quote-model cap from
    // the broader participation limits.
    control.tokenBookCalls = [];
    control.tokenBookOverride = (tokenId, callIndex) => {
      if (tokenId === YES && callIndex >= 2) {
        return {
          bids: [
            { price: 0.49, size: 10 },
            { price: 0.48, size: 10_000 },
          ],
          asks: [{ price: 0.5, size: 10_000 }],
          ts: control.bookTs,
        };
      }
      return {
        bids: [{ price: 0.49, size: 10_000 }],
        asks: [{ price: 0.5, size: 10_000 }],
        ts: control.bookTs,
      };
    };

    await controller.resume();

    expect(control.placeCalls).toHaveLength(0);
    const rejectedEntries = stateStore.listOrders().filter((order) => order.purpose === "ADD");
    expect(rejectedEntries.length).toBeGreaterThan(0);
    expect(rejectedEntries).toEqual(rejectedEntries.map((order) => expect.objectContaining({
      status: "REJECTED",
      lastError: "entry exceeds refreshed quote-model liquidity cap",
    })));
  });

  it("reapplies the source 2c quote cap to the live pre-submit book", async () => {
    const control = fakeVenue(stateStore);
    const sourceCapConfig = createMarketMakeConfig({
      capital: {
        minimum_free_collateral_usd: 0,
        operational_reserve_usd: 0,
      },
      quotient_feed: {
        daily_api_cost_cap_usd: 1,
      },
      eligibility: {
        entry_stability_seconds: 0,
        min_live_depth_usd_within_2c: 0,
        min_volume_24h_usd: 0,
      },
      quote_model: {
        size_cap_fraction_of_depth_within_2c: 0.01,
        size_cap_fraction_of_best_level: 1,
      },
      cassie_overrides: {
        liquidity: {
          minimum_exit_bid_depth_1c_usd: 0,
          minimum_exit_bid_depth_2c_usd: 0,
          max_order_fraction_of_exit_bid_depth_1c: 1,
          max_order_fraction_of_exit_bid_depth_2c: 1,
          max_market_fraction_of_exit_bid_depth_1c: 1,
          max_market_fraction_of_exit_bid_depth_2c: 1,
        },
      },
    });
    const controller = build(control, { config: sourceCapConfig });
    await controller.start();
    clock += 1_000;
    control.bookTs = clock;
    await applyReconcile(controller);

    control.tokenBookCalls = [];
    control.tokenBookOverride = (tokenId, callIndex) => {
      const selectedLiveRead = tokenId === YES && callIndex >= 2;
      return {
        bids: [{ price: 0.49, size: selectedLiveRead ? 1_000 : 10_000 }],
        asks: [{ price: 0.5, size: 10_000 }],
        ts: control.bookTs,
      };
    };

    await controller.resume();

    expect(control.placeCalls).toHaveLength(0);
    expect(stateStore.listOrders().filter((order) => order.purpose === "ADD")).toEqual(
      expect.arrayContaining([expect.objectContaining({
        status: "REJECTED",
        lastError: "entry exceeds refreshed quote-model liquidity cap",
      })]),
    );
  });

  it("latches RISK_EXIT_ONLY and cancels each resting add once after a late BUY breaches hard caps", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    await startAndPlace(controller, control);
    const restingVenueOrderId = control.orders[0]!.id;

    await (controller as unknown as {
      processEvent(event: {
        type: "fill";
        ts: number;
        fillId: string;
        orderId: string;
        marketKey: string;
        tokenId: string;
        outcome: "YES";
        side: "BUY";
        size: number;
        price: number;
      }): Promise<unknown>;
    }).processEvent({
      type: "fill",
      ts: clock + 1,
      fillId: "late-buy-over-hard-cap",
      orderId: "previously-canceled-entry",
      marketKey: MARKET_KEY,
      tokenId: YES,
      outcome: "YES",
      side: "BUY",
      size: 1_000,
      price: 0.49,
    });

    expect(controller.status()).toMatchObject({
      lifecycle: "RISK_EXIT_ONLY",
      halted: true,
    });
    expect(control.cancelCalls.filter((orderId) => orderId === restingVenueOrderId)).toHaveLength(1);
    expect((await snapshotStore.readErrors()).filter((row) =>
      row.code === "MM_POST_FILL_HARD_CAP_BREACH")).toHaveLength(1);
  });

  it("preserves EXIT_BLOCKED precedence when a later BUY fill also breaches a hard cap", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    await startAndPlace(controller, control);
    stateStore.setExitOnlyLifecycle("EXIT_BLOCKED", "fixture terminal exit", clock);

    await (controller as unknown as {
      processEvent(event: {
        type: "fill";
        ts: number;
        fillId: string;
        orderId: string;
        marketKey: string;
        tokenId: string;
        outcome: "YES";
        side: "BUY";
        size: number;
        price: number;
      }): Promise<unknown>;
    }).processEvent({
      type: "fill",
      ts: clock + 1,
      fillId: "late-buy-while-exit-blocked",
      orderId: "previously-canceled-entry",
      marketKey: MARKET_KEY,
      tokenId: YES,
      outcome: "YES",
      side: "BUY",
      size: 1_000,
      price: 0.49,
    });

    expect(controller.status()).toMatchObject({ lifecycle: "EXIT_BLOCKED", halted: true });
  });

  it("latches and cancels immediately on websocket failure even while a Quotient tick is hung", async () => {
    const control = fakeVenue(stateStore);
    const base = quotient(() => clock);
    let hang = false;
    let release!: (rows: Awaited<ReturnType<typeof base.activeSignals>>) => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const controller = build(control, {
      quotient: {
        spentUsd: 0,
        async activeSignals() {
          if (!hang) return base.activeSignals();
          entered();
          return new Promise((resolve) => { release = resolve; });
        },
        exactForecasts: base.exactForecasts,
      },
    }, { enableSubscriptions: true });
    await controller.start();
    await applyReconcile(controller);
    await controller.resume();
    expect(control.orders).toHaveLength(1);

    clock += 60 * 60 * 1_000;
    control.bookTs = clock;
    hang = true;
    const tick = controller.tick();
    await enteredPromise;
    control.marketSubscriptions[0]!.endUnexpectedly();

    await vi.waitFor(() => {
      expect(controller.status().lifecycle).toBe("DATA_DEGRADED");
      expect(control.cancelAllCalls).toBeGreaterThan(0);
    });
    expect(control.marketSubscriptions).toHaveLength(2);
    hang = false;
    release([]);
    await tick;

    await expect(controller.resume()).rejects.toThrow(/post-reconnect message/);
    clock += 1;
    control.bookTs = clock;
    control.marketSubscriptions[1]!.push({ opaque: "wake" });
    await vi.waitFor(() => {
      const reason = (controller as unknown as { streamRecoveryBlockReason(): string | undefined })
        .streamRecoveryBlockReason();
      expect(reason).toBeUndefined();
    });
    await controller.resume();
    expect(controller.status().lifecycle).toBe("ACTIVE");
  });

  it("resumes a quiet account after a user websocket reconnect without waiting for a user message", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control, {}, { enableSubscriptions: true });
    await controller.start();
    await applyReconcile(controller);
    await controller.resume();
    expect(controller.status().lifecycle).toBe("ACTIVE");

    control.userSubscriptions[0]!.endUnexpectedly();
    await vi.waitFor(() => {
      expect(controller.status().lifecycle).toBe("DATA_DEGRADED");
      expect(control.userSubscriptions).toHaveLength(2);
    });

    // The user channel pushes only on account activity, so a quiet account
    // never sees a post-reconnect message. The fresh subscription followed by
    // an authoritative reconciliation is the recovery proof instead.
    clock += 1_000;
    control.bookTs = clock;
    await controller.resume();
    expect(controller.status().lifecycle).toBe("ACTIVE");
  });

  it("does not degrade a quiet account for websocket silence while REST reads stay healthy", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control, {}, { enableSubscriptions: true });
    await controller.start();
    await applyReconcile(controller);
    await controller.resume();
    expect(control.orders).toHaveLength(1);
    const cancelAllBefore = control.cancelAllCalls;

    // Past both stale thresholds (20s market, 10s user) with no stream
    // message at all. A resting order that nobody trades against produces
    // exactly this silence; the tick's own REST reads prove liveness.
    clock += 30_000;
    control.bookTs = clock;
    await controller.tick();
    expect(controller.status().lifecycle).toBe("ACTIVE");
    expect(control.orders).toHaveLength(1);
    expect(control.cancelAllCalls).toBe(cancelAllBefore);
  });

  it("tolerates a transient positions rate limit and degrades only once reads stay broken", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control, {}, { enableSubscriptions: true });
    await controller.start();
    await applyReconcile(controller);
    await controller.resume();
    expect(control.orders).toHaveLength(1);
    const cancelAllBefore = control.cancelAllCalls;

    control.positionReadFailure =
      "Request to https://data-api.polymarket.com/positions?user=0xabc&limit=20&offset=0 was rate limited";
    clock += 15_000;
    control.bookTs = clock;
    await expect(controller.tick()).resolves.toMatchObject({ fills: 0, actions: 0 });
    expect(controller.status().lifecycle).toBe("ACTIVE");
    expect(control.orders).toHaveLength(1);
    expect(control.cancelAllCalls).toBe(cancelAllBefore);

    // A market wake hitting the same limit is absorbed the same way.
    control.marketSubscriptions[0]!.push({ opaque: "book" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controller.status().lifecycle).toBe("ACTIVE");

    // Reads still failing past the five-minute tolerance window: degrade as before.
    clock += 6 * 60_000;
    control.bookTs = clock;
    await expect(controller.tick()).rejects.toThrow(/rate limited/);
    expect(controller.status().lifecycle).toBe("DATA_DEGRADED");
  });

  it("coalesces market websocket messages into book re-reads without re-reading account state", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control, {}, { enableSubscriptions: true });
    await controller.start();
    await applyReconcile(controller);
    await controller.resume();
    expect(control.orders).toHaveLength(1);
    const positionCallsBefore = control.positionCalls;
    const bookCallsBefore = control.tokenBookCalls.length;

    for (let index = 0; index < 5; index += 1) control.marketSubscriptions[0]!.push({ opaque: `book-${index}` });
    await vi.waitFor(() => {
      expect(control.tokenBookCalls.length).toBeGreaterThan(bookCallsBefore);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // One supervised market: one YES and one NO book per wake, one wake for
    // the burst (a trailing wake, if any, waits out the coalescing window).
    expect(control.tokenBookCalls.length - bookCallsBefore).toBe(2);
    expect(control.positionCalls).toBe(positionCallsBefore);
  });

  it("ignores market websocket messages while flat", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control, {}, { enableSubscriptions: true });
    await startAndPlace(controller, control);
    clock += 1_000;
    control.bookTs = clock;
    await controller.halt();
    for (let attempt = 0; attempt < 3 && control.orders.length > 0; attempt += 1) {
      clock += 1_000;
      control.bookTs = clock;
      await controller.tick();
    }
    expect(control.orders).toHaveLength(0);
    clock += 1_000;
    control.bookTs = clock;
    await controller.tick();
    expect((controller as unknown as { supervisedBookKeys(): Set<string> }).supervisedBookKeys().size).toBe(0);
    const positionCallsBefore = control.positionCalls;
    const bookCallsBefore = control.tokenBookCalls.length;

    for (let index = 0; index < 5; index += 1) control.marketSubscriptions[0]!.push({ opaque: `idle-${index}` });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(control.positionCalls).toBe(positionCallsBefore);
    expect(control.tokenBookCalls.length).toBe(bookCallsBefore);
  });

  it("does not degrade when replacing the expected market subscription", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control, {}, { enableSubscriptions: true });
    await controller.start();
    await applyReconcile(controller);
    await controller.resume();
    const first = control.marketSubscriptions[0]!;

    const internals = controller as unknown as {
      marketSubscriptionKey: string;
      refreshMarketSubscription(): Promise<void>;
    };
    internals.marketSubscriptionKey = "force-expected-replacement";
    await internals.refreshMarketSubscription();
    await Promise.resolve();

    expect(first.closeCalls).toBe(1);
    expect(control.marketSubscriptions).toHaveLength(2);
    expect(controller.status().lifecycle).toBe("ACTIVE");
  });

  it("persists every repeated incident while an alerter failure remains non-fatal and outbound-deduped", async () => {
    const control = fakeVenue(stateStore);
    let alertCalls = 0;
    const controller = build(control, {
      alerter: {
        async send() {
          alertCalls += 1;
          throw new Error("fixture alert outage");
        },
      },
    });
    await controller.start();
    const operational = controller as unknown as {
      operationalError(code: string, message: string): Promise<void>;
    };

    await expect(operational.operationalError("MM_TEST_REPEAT", "same incident")).resolves.toBeUndefined();
    await expect(operational.operationalError("MM_TEST_REPEAT", "same incident")).resolves.toBeUndefined();

    expect((await snapshotStore.readErrors()).filter((row) => row.code === "MM_TEST_REPEAT")).toHaveLength(2);
    expect(alertCalls).toBe(1);
  });

  it("latches EXIT_BLOCKED across ordinary halt and only explicit liquidate opens another bounded retry", async () => {
    const control = fakeVenue(stateStore);
    const config = testConfig();
    config.exit_policy.urgent_exit_max_attempts = 1;
    const controller = build(control, { config });
    await fillOpenEntry(controller, control);
    control.acknowledgement = "rejected";

    clock += 1_000;
    control.bookTs = clock;
    await controller.halt({ liquidate: true });
    expect(controller.status().lifecycle).toBe("EXIT_BLOCKED");
    const firstSellCount = control.placeCalls.filter((order) => order.side === "SELL").length;
    expect(firstSellCount).toBe(1);

    await controller.halt();
    expect(controller.status().lifecycle).toBe("EXIT_BLOCKED");

    clock += 1_000;
    control.bookTs = clock;
    await controller.halt({ liquidate: true });
    expect(control.placeCalls.filter((order) => order.side === "SELL").length).toBe(firstSellCount + 1);
  });

  it("does not double-decrement inventory when an older SELL fill indexes after authoritative repair", async () => {
    const control = fakeVenue(stateStore);
    const controller = build(control);
    const { intent } = await fillOpenEntry(controller, control);
    const originalQuantity = intent.size;

    clock += 1_000;
    control.bookTs = clock;
    await controller.halt({ liquidate: true });
    const sell = control.placeCalls.findLast((order) => order.side === "SELL")!;
    const sellOrder = control.orders.find((order) => order.side === "SELL")!;
    const correctedQuantity = originalQuantity - sell.size;
    expect(correctedQuantity).toBeGreaterThanOrEqual(0);

    // The venue position already reflects the sell, but its trade endpoint is
    // delayed and the now-absent order looks canceled for several snapshots.
    control.orders = [];
    control.positions = correctedQuantity > EPSILON
      ? [position(correctedQuantity, intent.limitPrice)]
      : [];
    clock += 1_000;
    control.bookTs = clock;
    await controller.tick();

    clock += 5 * 60_000 + 1;
    control.bookTs = clock;
    await controller.tick();
    expect(controller.stateSnapshot().markets[MARKET_KEY]?.inventory?.freeQuantity ?? 0).toBeCloseTo(correctedQuantity);
    expect(stateStore.listInventoryCycles(true)[0]?.quantity ?? 0).toBeCloseTo(correctedQuantity);

    const indexedAt = clock - 1_000;
    control.fills.push(delayedSellFill(sell, sellOrder.id, sell.size, indexedAt, "trade-sell-indexed-late"));
    clock += 1_000;
    control.bookTs = clock;
    await controller.tick();

    expect(controller.stateSnapshot().markets[MARKET_KEY]?.inventory?.freeQuantity ?? 0).toBeCloseTo(correctedQuantity);
    expect(stateStore.listInventoryCycles(true)[0]?.quantity ?? 0).toBeCloseTo(correctedQuantity);
    expect((stateStore.exportSnapshot().mm_fills as unknown[])).toHaveLength(1);
  });

  describe("a transient book read does not degrade the deployment", () => {
    /** The SDK's client-side deadline, verbatim: it carries no status or code. */
    function timeoutError(tokenId: string): Error {
      const error = new Error(`Request timed out: GET https://clob.polymarket.com/book?token_id=${tokenId}`);
      error.name = "TimeoutError";
      return error;
    }

    it("retries a timed-out book in place and keeps quoting", async () => {
      const control = fakeVenue(stateStore);
      const controller = build(control);
      await controller.start();
      await applyReconcile(controller);
      await controller.resume();
      expect(controller.status().lifecycle).toBe("ACTIVE");

      // The first read of the YES book times out; the retry succeeds. One slow
      // book must not discard the rest of its concurrent batch.
      let thrown = 0;
      control.tokenBookThrow = (tokenId) => {
        if (tokenId === YES && thrown === 0) {
          thrown += 1;
          return timeoutError(tokenId);
        }
        return undefined;
      };
      clock += 1_000;
      control.bookTs = clock;
      await controller.tick();

      expect(thrown).toBe(1);
      expect(controller.status().lifecycle).toBe("ACTIVE");
      expect(controller.status().halted).toBe(false);
      expect(control.cancelAllCalls).toBe(0);
    });

    it("skips the tick when the timeout outlasts its retries, without degrading", async () => {
      const control = fakeVenue(stateStore);
      const controller = build(control);
      await controller.start();
      await applyReconcile(controller);
      await controller.resume();

      control.tokenBookThrow = (tokenId) => (tokenId === YES ? timeoutError(tokenId) : undefined);
      clock += 1_000;
      control.bookTs = clock;
      await controller.tick();

      // An authoritative snapshot succeeded inside the tolerance window, so the
      // next cadence retries rather than the deployment halting.
      expect(controller.status().lifecycle).toBe("ACTIVE");
      expect(controller.status().halted).toBe(false);
      expect(control.cancelAllCalls).toBe(0);

      // Recovery needs no operator step.
      control.tokenBookThrow = undefined;
      clock += 1_000;
      control.bookTs = clock;
      await controller.tick();
      expect(controller.status().lifecycle).toBe("ACTIVE");
    });

    it("still degrades once the venue has been unreadable past the tolerance window", async () => {
      const control = fakeVenue(stateStore);
      const controller = build(control);
      await controller.start();
      await applyReconcile(controller);
      await controller.resume();

      control.tokenBookThrow = (tokenId) => (tokenId === YES ? timeoutError(tokenId) : undefined);
      clock += 6 * 60 * 1_000;
      control.bookTs = clock;
      await expect(controller.tick()).rejects.toThrow(/timed out/);
      expect(controller.status().lifecycle).toBe("DATA_DEGRADED");
    });

    it("degrades immediately on a book error that is not transient", async () => {
      const control = fakeVenue(stateStore);
      const controller = build(control);
      await controller.start();
      await applyReconcile(controller);
      await controller.resume();

      control.tokenBookThrow = (tokenId) =>
        tokenId === YES ? new Error("unauthorized: bad api credentials") : undefined;
      clock += 1_000;
      control.bookTs = clock;
      await expect(controller.tick()).rejects.toThrow(/unauthorized/);
      expect(controller.status().lifecycle).toBe("DATA_DEGRADED");
    });
  });
});

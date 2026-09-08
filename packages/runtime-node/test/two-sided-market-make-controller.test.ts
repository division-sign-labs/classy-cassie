// packages/runtime-node/test/two-sided-market-make-controller.test.ts

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryStateStore, normalizePolymarketOrderSize,
  type Fill, type Order, type OrderIntent, type PolymarketMarketCatalog, type Position, type VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import { createTwoSidedMarketMakeConfig, type MarketMakeConfig } from "@quotient-forecasting/strategy-market-make";
import { TwoSidedMarketMakeController, type TwoSidedMarketMakeControllerDeps } from "../src/two-sided-market-make-controller.js";

const START = 2_000_000_000_000;
const controllers: TwoSidedMarketMakeController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.shutdown();
  vi.useRealTimers();
});

function fixture(overrides: { config?: MarketMakeConfig; state?: MemoryStateStore; deploymentId?: string; fixed?: boolean } = {}) {
  let clock = START;
  const state = overrides.state ?? new MemoryStateStore();
  const markets: PolymarketMarketCatalog[] = Array.from({ length: 6 }, (_, index) => ({
    marketKey: `polymarket:${index}`, nativeMarketId: String(index), conditionId: `condition-${index}`,
    marketRef: `yes-${index}`, question: `Market ${index}?`, eventId: `event-${index}`, category: "Politics",
    yesTokenId: `yes-${index}`, noTokenId: `no-${index}`, active: true, closed: false, archived: false,
    acceptingOrders: true, orderbookEnabled: true, endsAt: START + 10 * 24 * 60 * 60_000,
    volume24hUsd: 100_000, tickSize: 0.01, minOrderSize: 5,
  }));
  const control = {
    cash: 500, orders: [] as Order[], positions: [] as Position[], fills: [] as Fill[],
    placed: [] as OrderIntent[], canceled: [] as string[], cancelAll: 0, heartbeat: 0,
    failAfterPrepare: false, failHeartbeat: false, acknowledged: "open" as "open" | "filled",
    bid: 0.49, ask: 0.51, depth: 100_000,
    bookFailure: undefined as Error | undefined,
    positionsFailure: undefined as Error | undefined,
    positionReads: 0, orderReads: 0,
    exactTokens: new Map<string, number>(),
    beforePrepared: undefined as (() => Promise<void>) | undefined,
  };
  const config = overrides.config ?? createTwoSidedMarketMakeConfig({
    capital: { base_order_notional_usd: 15, max_order_notional_usd: 20, minimum_free_collateral_usd: 0, operational_reserve_usd: 0, max_total_inventory_and_pending_entry_cost_usd: 200, hard_market_cost_usd: 60, max_active_markets: 3, max_live_orders: 6 },
    portfolio_risk: { max_event_cost_usd: 100, max_category_family_cost_usd: 200, max_manual_correlation_group_cost_usd: 100, max_open_markets_per_event: 1 },
    two_sided: { target_markets: 3, minimum_volume_24h_usd: 100, minimum_depth_usd: 10, minimum_rest_seconds: 30, maximum_unpaired_notional_usd: 60 },
  });
  if (overrides.fixed) config.cassie_overrides.bankroll.mode = "fixed";
  const venue = {
    id: "polymarket", verifiedAgainst: "test",
    balances: async () => [{ asset: "pUSD", total: control.cash, available: control.cash }],
    positions: async () => { control.positionReads += 1; if (control.positionsFailure) throw control.positionsFailure; return structuredClone(control.positions); },
    openOrders: async () => { control.orderReads += 1; return structuredClone(control.orders); },
    fills: async (_account: unknown, since: number) => structuredClone(control.fills.filter((fill) => fill.ts >= since)),
    tokenBalance: async (_account: unknown, tokenId: string) => control.exactTokens.get(tokenId) ?? control.positions.find((row) => row.tokenId === tokenId)?.size ?? 0,
    normalizeOrderSize: normalizePolymarketOrderSize,
    tokenBook: async (tokenId: string) => {
      if (control.bookFailure) throw control.bookFailure;
      return { marketRef: tokenId, bids: [{ price: control.bid, size: control.depth }], asks: [{ price: control.ask, size: control.depth }], ts: clock };
    },
    placeOrderWithLifecycle: async (_account: unknown, intent: OrderIntent, hooks: { onPrepared(meta: { preparedHash: string; tokenId: string; conditionId?: string; outcome?: "YES" | "NO" }): Promise<void> }) => {
      expect(JSON.parse((await state.get("market-make:two-sided:v1"))!).orders[intent.clientId].status).toBe("RESERVED");
      await control.beforePrepared?.();
      await hooks.onPrepared({ preparedHash: `signed:${intent.clientId}`, tokenId: intent.tokenId!, conditionId: intent.conditionId, outcome: intent.outcome });
      const durable = JSON.parse((await state.get("market-make:two-sided:v1"))!).orders[intent.clientId];
      expect(durable.status).toBe("SIGNED");
      expect(durable.size).toBe(normalizePolymarketOrderSize(intent.size));
      if (control.failAfterPrepare) throw new Error("acknowledgement connection lost");
      control.placed.push(structuredClone(intent));
      const id = `venue-${control.placed.length}`;
      if (control.acknowledged === "open") control.orders.push({
        id, marketRef: intent.marketRef, tokenId: intent.tokenId, conditionId: intent.conditionId, outcome: intent.outcome,
        side: intent.side, size: normalizePolymarketOrderSize(intent.size), filledSize: 0, price: intent.limitPrice,
        tif: "GTC", status: "open", createdAt: clock,
      });
      return { orderId: id, status: control.acknowledged, tokenId: intent.tokenId, filledSize: control.acknowledged === "filled" ? intent.size : undefined };
    },
    cancelOrder: async (_account: unknown, id: string) => { control.canceled.push(id); control.orders = control.orders.filter((row) => row.id !== id); },
    cancelAll: async () => { control.cancelAll += 1; control.orders = []; },
    heartbeat: async () => { control.heartbeat += 1; if (control.failHeartbeat) throw new Error("heartbeat failed"); },
  } as unknown as VenueAdapter;
  const deps: TwoSidedMarketMakeControllerDeps = {
    config, stateStore: state, venue, account: { venue: "polymarket", signerAddress: "0x1", funder: "0x2", signatureType: 3 },
    catalog: {
      activeMarkets: async () => structuredClone(markets),
      market: async (marketKey) => structuredClone(markets.find((market) => market.marketKey === marketKey)!),
      recover: async ({ clobTokenId }) => { const catalog = markets.find((row) => row.yesTokenId === clobTokenId || row.noTokenId === clobTokenId)!; return { marketKey: catalog.marketKey, nativeMarketId: catalog.nativeMarketId, catalog }; },
    },
  };
  const controller = new TwoSidedMarketMakeController(deps, { deploymentId: overrides.deploymentId ?? "deployment-one", now: () => clock, autoSchedule: false, enableSubscriptions: false });
  controllers.push(controller);
  const advance = (ms: number) => { clock += ms; };
  const approve = async () => { const proposal = await controller.reconcile(); await controller.reconcile({ apply: true, expectedProposalHash: proposal.proposalHash }); };
  const start = async () => { await controller.start(); await approve(); await controller.resume(); };
  const addFill = (order: Order, size: number, id = `fill:${order.id}`) => {
    const position = control.positions.find((row) => row.tokenId === order.tokenId);
    if (order.side === "BUY") {
      if (position) position.size += size;
      else control.positions.push({ marketRef: order.marketRef, tokenId: order.tokenId, conditionId: order.conditionId, outcome: order.outcome, side: order.outcome!, size, avgPrice: order.price });
      control.cash -= size * order.price;
    } else { if (position) position.size -= size; control.cash += size * order.price; }
    control.fills.push({ id, orderId: order.id, makerOrderId: order.id, marketRef: order.marketRef, tokenId: order.tokenId, conditionId: order.conditionId, outcome: order.outcome, side: order.side, size, matchedAmountDelta: size, price: order.price, ts: clock });
    const resting = control.orders.find((row) => row.id === order.id);
    if (resting) resting.filledSize += size;
    control.orders = control.orders.filter((row) => row.size - row.filledSize > 1e-8);
  };
  return { controller, control, state, config, markets, advance, approve, start, addFill, venue };
}

describe("TwoSidedMarketMakeController", () => {
  it("polls routine accounts once per minute and shares the public index across fill wakes", async () => {
    const f = fixture(); await f.start();
    const positions = f.control.positionReads;
    const orders = f.control.orderReads;
    for (let i = 0; i < 3; i += 1) { f.advance(15_000); await f.controller.tick({ scheduled: true }); }
    expect(f.control.positionReads).toBe(positions);
    expect(f.control.orderReads).toBe(orders);
    const yes = f.control.orders.find((row) => row.tokenId === "yes-0")!;
    f.addFill(yes, 5);
    await f.controller.tick(); // User-stream account notification.
    expect(f.controller.stateSnapshot().inventory["yes-0"]?.quantity).toBe(5);
    expect(f.control.positionReads).toBe(positions);
    expect(f.control.orderReads).toBe(orders + 1);
    f.advance(15_000); await f.controller.tick();
    expect(f.control.positionReads).toBe(positions + 1);
    expect(f.controller.status().accountPollSeconds).toBe(60);
  });

  it("keeps book wakes responsive without coupling account reads to five-second quote age", async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.start();
    const positions = f.control.positionReads;
    const orders = f.control.orderReads;
    const wake = () => (f.controller as unknown as { wake(kind: "market"): void }).wake("market");
    for (let i = 0; i < 5; i += 1) {
      f.advance(10_000); wake(); await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(f.control.positionReads).toBe(positions);
    expect(f.control.orderReads).toBe(orders);
    expect(f.controller.status().lifecycle).toBe("ACTIVE");
  });

  it("backs off the SDK rate-limit error exponentially, ignores wakes, and recovers with late fills intact", async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.start();
    const yes = structuredClone(f.control.orders.find((row) => row.tokenId === "yes-0")!);
    f.control.positionsFailure = Object.assign(new Error("Request to /positions was rate limited"), { name: "RateLimitError" });
    f.advance(60_000); await expect(f.controller.tick()).resolves.toBeDefined();
    expect(f.controller.status()).toMatchObject({ started: true, lifecycle: "DATA_DEGRADED", venueRetry: { failures: 1, nextAttemptAt: START + 120_000 } });
    expect(f.control.cancelAll).toBe(1);
    const reads = f.control.positionReads;
    const orders = f.control.orderReads;
    const heartbeat = f.control.heartbeat;
    for (let i = 0; i < 10; i += 1) {
      (f.controller as unknown as { wake(kind: "user"): void }).wake("user");
      f.advance(5_000); await f.controller.tick(); await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(f.control.positionReads).toBe(reads);
    expect(f.control.orderReads).toBe(orders);
    expect(f.control.heartbeat).toBe(heartbeat);
    f.advance(10_000); await f.controller.tick();
    expect(f.controller.status().venueRetry).toMatchObject({ failures: 2, nextAttemptAt: START + 240_000 });
    expect(f.control.cancelAll).toBe(1);
    f.control.positionsFailure = undefined;
    f.addFill(yes, 5, "late-fill-during-outage");
    f.advance(120_000); await f.controller.tick();
    expect(f.controller.stateSnapshot().inventory["yes-0"]?.quantity).toBe(5);
    expect(f.controller.status().lifecycle).toBe("DATA_DEGRADED"); // First absence observation.
    f.advance(60_000); await f.controller.tick();
    expect(f.controller.status()).toMatchObject({ lifecycle: "ACTIVE", venueRetry: undefined });
    expect(f.controller.stateSnapshot().inventory["yes-0"]?.quantity).toBe(5);
    expect(f.control.placed.some((row) => row.side === "SELL" && row.tokenId === "yes-0")).toBe(true);
  });

  it("caps exponential waits at five minutes and honors a longer SDK Retry-After in seconds", async () => {
    const f = fixture(); await f.start();
    f.control.positionsFailure = Object.assign(new Error("busy"), { name: "RateLimitError" });
    f.advance(60_000);
    let at = START + 60_000;
    for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
      await f.controller.tick();
      expect(f.controller.status().venueRetry?.nextAttemptAt).toBe(at + delay);
      f.advance(delay); at += delay;
    }
    f.control.positionsFailure = Object.assign(new Error("busy"), { name: "RateLimitError", retryAfter: 900 });
    await f.controller.tick();
    expect(f.controller.status().venueRetry?.nextAttemptAt).toBe(at + 900_000);
  });

  it("applies the same cooldown to book and cancellation throttling", async () => {
    const f = fixture(); await f.start();
    f.control.bookFailure = Object.assign(new Error("slow down"), { name: "RateLimitError" });
    await f.controller.tick();
    expect(f.controller.status()).toMatchObject({ lifecycle: "DATA_DEGRADED", venueRetry: { failures: 1 } });
    const g = fixture(); await g.start();
    g.venue.cancelOrder = async () => { throw Object.assign(new Error("busy"), { status: 429, retryAfter: 120 }); };
    g.control.bid = .47; g.control.ask = .49; g.advance(60_000);
    await g.controller.tick();
    expect(g.controller.status()).toMatchObject({ lifecycle: "DATA_DEGRADED", venueRetry: { nextAttemptAt: START + 180_000 } });
    expect(g.controller.status().availability.collateralReservedUsd).toBeGreaterThan(0);
    // Cleanup uses a working cancellation endpoint, just as recovery would.
    g.venue.cancelOrder = async () => undefined;
  });

  it("does not let a throttled read-only preview alter live recovery or cancel orders", async () => {
    const f = fixture(); await f.start();
    const before = f.controller.stateSnapshot();
    f.control.positionsFailure = Object.assign(new Error("busy"), { name: "RateLimitError" });
    await expect(f.controller.dryRun()).rejects.toThrow("busy");
    expect(f.controller.stateSnapshot()).toEqual(before);
    expect(f.control.cancelAll).toBe(0);
  });

  it("does not use recovery to clear an operator halt or a loss stop", async () => {
    const f = fixture(); await f.start();
    f.advance(60_000);
    f.control.positionsFailure = Object.assign(new Error("busy"), { status: 503 });
    await f.controller.tick();
    await f.controller.halt();
    f.control.positionsFailure = undefined;
    f.advance(60_000); await f.controller.tick(); f.advance(60_000); await f.controller.tick();
    expect(f.controller.status()).toMatchObject({ lifecycle: "HALTED", haltReason: "operator halt" });
    expect(f.controller.stateSnapshot().recoverablePause).toBe(false);
    await f.controller.resume();
    f.control.positionsFailure = Object.assign(new Error("busy"), { status: 503 });
    f.advance(60_000); await f.controller.tick();
    await f.controller.shutdown();
    const state = f.controller.stateSnapshot(); state.lossLatched = true;
    await f.state.set("market-make:two-sided:v1", JSON.stringify(state));
    const restarted = fixture({ state: f.state }); restarted.advance(300_000);
    await restarted.controller.start(); await restarted.controller.tick();
    expect(restarted.controller.status()).toMatchObject({ lifecycle: "RISK_EXIT_ONLY", halted: true, lossLatched: true });
  });

  it("retains startup and restart retry state without making requests during the cooldown", async () => {
    const f = fixture(); await f.start();
    f.control.positionsFailure = Object.assign(new Error("busy"), { name: "RateLimitError", retryAfter: 120 });
    f.advance(60_000); await f.controller.tick(); await f.controller.shutdown();
    const restarted = fixture({ state: f.state }); restarted.advance(90_000);
    await restarted.controller.start();
    expect(restarted.control.positionReads).toBe(0);
    expect(restarted.controller.status()).toMatchObject({ started: true, lifecycle: "DATA_DEGRADED", venueRetry: { failures: 1, nextAttemptAt: START + 180_000 } });
    const fresh = fixture();
    fresh.control.positionsFailure = Object.assign(new Error("busy"), { status: 503 });
    await fresh.controller.start();
    expect(fresh.controller.status().started).toBe(true);
    fresh.control.positionsFailure = undefined;
    fresh.advance(60_000); await fresh.controller.tick();
    expect(fresh.controller.status().halted).toBe(true); // A new deployment still needs approval.
  });

  it("recovers transport failures but keeps invalid credentials and ambiguous submissions blocked", async () => {
    const f = fixture(); await f.start(); f.advance(60_000);
    f.control.positionsFailure = Object.assign(new Error("upstream unavailable"), { name: "TransportError" });
    await f.controller.tick();
    expect(f.controller.status().lifecycle).toBe("DATA_DEGRADED");
    f.advance(60_000);
    f.control.positionsFailure = Object.assign(new Error("unauthorized"), { status: 401 });
    await expect(f.controller.tick()).rejects.toThrow("unauthorized");
    expect(f.controller.stateSnapshot().recoverablePause).toBe(false);
    f.control.positionsFailure = undefined; f.advance(60_000); await f.controller.tick();
    expect(f.controller.status().halted).toBe(true);
    const ambiguous = fixture(); ambiguous.control.failAfterPrepare = true;
    await ambiguous.start();
    ambiguous.advance(60_000); await ambiguous.controller.tick();
    expect(ambiguous.controller.status()).toMatchObject({ halted: true, counts: { unknownOrders: 1 } });
    expect(ambiguous.controller.stateSnapshot().recoverablePause).toBe(false);
  });

  it("starts halted without Quotient, requires reviewed activation, then maintains six durable two-sided quotes", async () => {
    const f = fixture();
    await f.controller.start();
    expect(f.controller.status().halted).toBe(true);
    await expect(f.controller.resume()).rejects.toThrow(/review and apply/);
    expect(f.control.placed).toEqual([]);
    await f.approve();
    await f.controller.resume();
    expect(f.control.placed).toHaveLength(6);
    expect(new Set(f.control.placed.map((row) => row.conditionId)).size).toBe(3);
    for (const condition of new Set(f.control.placed.map((row) => row.conditionId))) {
      const pair = f.control.placed.filter((row) => row.conditionId === condition);
      expect(new Set(pair.map((row) => row.outcome))).toEqual(new Set(["YES", "NO"]));
      expect(pair[0]?.size).toBe(pair[1]?.size);
      expect(pair.every((row) => row.postOnly && row.tif === "GTC")).toBe(true);
    }
    for (let attempt = 0; attempt < 4; attempt += 1) { f.advance(1_000); await f.controller.tick(); }
    expect(f.control.canceled).toEqual([]);
    expect(f.controller.status()).toMatchObject({ lifecycle: "ACTIVE", liveOrders: 6 });
  });

  it("shares dry-run and live paired cash limits without persisting the preview", async () => {
    const f = fixture({ fixed: true });
    f.control.cash = 16;
    await f.controller.start();
    const before = await f.state.get("market-make:two-sided:v1");
    const preview = await f.controller.dryRun();
    expect(await f.state.get("market-make:two-sided:v1")).toBe(before);
    expect(f.control.placed).toEqual([]);
    const total = preview.actions.reduce((sum, row) => sum + row.size * row.limitPrice, 0);
    expect(preview.actions).toHaveLength(2);
    expect(total).toBeLessThanOrEqual(16);
    for (const key of new Set(preview.actions.map((row) => row.marketKey))) {
      const pair = preview.actions.filter((row) => row.marketKey === key);
      expect(pair).toHaveLength(2);
      expect(pair[0]?.size).toBe(pair[1]?.size);
    }
  });

  it("selects distinct events and continues discovery after ineligible candidates", async () => {
    const f = fixture();
    f.markets[0]!.volume24hUsd = 0;
    f.markets[2]!.eventId = f.markets[1]!.eventId;
    await f.start();
    expect(new Set(f.control.placed.map((row) => row.conditionId))).toEqual(new Set(["condition-1", "condition-3", "condition-4"]));
  });

  it("does not cancel stable quotes each account refresh and respects minimum rest before meaningful repricing", async () => {
    const f = fixture();
    await f.start();
    f.control.bid = 0.47;
    f.control.ask = 0.49;
    f.advance(10_000);
    await f.controller.tick();
    expect(f.control.canceled).toEqual([]);
    f.advance(21_000);
    await f.controller.tick();
    expect(f.control.canceled.length).toBeGreaterThan(0);
  });

  it("accepts both YES and NO fills and releases only settled cancellations before changing quote routes", async () => {
    const f = fixture();
    await f.start();
    const pair = f.control.orders.filter((row) => row.conditionId === "condition-0");
    f.advance(1_000);
    f.addFill(pair[0]!, 5);
    f.addFill(pair[1]!, 5);
    await f.controller.tick();
    const state = f.controller.stateSnapshot();
    expect(state.inventory["yes-0"]?.quantity).toBe(5);
    expect(state.inventory["no-0"]?.quantity).toBe(5);
    expect(f.control.placed.filter((row) => row.side === "SELL")).toHaveLength(0);
    f.advance(6_000);
    await f.controller.tick();
    f.advance(1_000);
    await f.controller.tick();
    expect(f.control.placed.filter((row) => row.side === "SELL").length).toBeGreaterThan(0);
    expect(f.controller.status().lossLatched).toBe(false);
    await f.controller.tick();
    expect(f.controller.stateSnapshot().inventory["yes-0"]?.quantity).toBe(5);
  });

  it("holds matched-but-unconfirmed shares instead of inventing a fill or replacement", async () => {
    const f = fixture();
    await f.start();
    f.control.orders[0]!.filledSize = 5;
    f.advance(1_000);
    await f.controller.tick();
    expect(f.controller.status().lastReconciliation?.ok).toBe(false);
    expect(f.controller.stateSnapshot().inventory).toEqual({});
    expect(f.control.placed).toHaveLength(6);
    expect(f.controller.status().availability.collateralReservedUsd).toBeGreaterThan(0);
  });

  it("retains a fully matched acknowledgement until its fill and balance appear", async () => {
    const f = fixture();
    f.control.acknowledged = "filled";
    await f.start();
    expect(f.control.placed).toHaveLength(1);
    for (let attempt = 0; attempt < 3; attempt += 1) { f.advance(10_000); await f.controller.tick(); }
    expect(f.control.placed).toHaveLength(1);
    expect(f.controller.status().lastReconciliation?.ok).toBe(false);
  });

  it("requires exact sellable token balance and never oversells a delayed Data API balance", async () => {
    const f = fixture();
    await f.start();
    const yes = f.control.orders.find((row) => row.tokenId === "yes-0")!;
    f.advance(1_000); f.addFill(yes, 10); await f.controller.tick();
    f.control.exactTokens.set("yes-0", 3);
    f.advance(6_000); await f.controller.tick(); f.advance(1_000); await f.controller.tick();
    expect(f.control.placed.filter((row) => row.side === "SELL" && row.tokenId === "yes-0")).toEqual([]);
  });

  it("rejects foreign live orders on resume even when previously halted", async () => {
    const f = fixture();
    await f.controller.start(); await f.approve();
    f.control.orders.push({ id: "foreign", marketRef: "yes-0", tokenId: "yes-0", conditionId: "condition-0", outcome: "YES", side: "BUY", size: 5, filledSize: 0, price: 0.49, status: "open" });
    await expect(f.controller.resume()).rejects.toThrow(/unowned venue orders/);
    expect(f.control.placed).toEqual([]);
  });

  it("does not permit reviewed adoption while the controller is quoting", async () => {
    const f = fixture(); await f.start();
    const preview = await f.controller.reconcile();
    await expect(f.controller.reconcile({ apply: true, expectedProposalHash: preview.proposalHash })).rejects.toThrow(/halt two-sided/);
  });

  it("persists ambiguous preparation, cancels exposure, and never retries the POST blindly", async () => {
    const f = fixture(); f.control.failAfterPrepare = true;
    await f.start();
    expect(f.controller.status().halted).toBe(true);
    expect(f.control.cancelAll).toBeGreaterThan(0);
    expect(Object.values(f.controller.stateSnapshot().orders)[0]).toMatchObject({ status: "UNKNOWN", preparedHash: expect.any(String) });
    f.advance(60_000); await f.controller.tick();
    expect(f.control.placed).toEqual([]);
    await expect(f.controller.resume()).rejects.toThrow(/unresolved/);
  });

  it("does not rewrite an acknowledged order as UNKNOWN after heartbeat failure", async () => {
    const f = fixture(); f.control.failHeartbeat = true;
    await f.start();
    expect(f.control.placed).toHaveLength(1);
    expect(Object.values(f.controller.stateSnapshot().orders)[0]).toMatchObject({ status: "CANCEL_PENDING", venueId: "venue-1" });
  });

  it("aborts signing-to-POST when emergency safety revokes activation", async () => {
    const f = fixture();
    f.control.beforePrepared = async () => {
      await (f.controller as unknown as { failClosed(reason: string): Promise<void> }).failClosed("fixture emergency");
    };
    await f.start();
    expect(f.control.placed).toEqual([]);
    expect(Object.values(f.controller.stateSnapshot().orders)[0]?.status).toBe("REJECTED");
  });

  it("restores approved same-identity activation but invalidates it when deployment changes", async () => {
    const f = fixture(); await f.start(); await f.controller.shutdown();
    f.advance(10_000);
    const restarted = fixture({ state: f.state });
    restarted.advance(20_000);
    await restarted.controller.start();
    expect(restarted.controller.status().halted).toBe(false);
    const changed = fixture({ state: f.state, deploymentId: "replacement" });
    await changed.controller.start();
    expect(changed.controller.status().halted).toBe(true);
    await expect(changed.controller.resume()).rejects.toThrow(/review and apply/);
  });

  it("reduces rather than enlarges risk immediately when cash falls", async () => {
    const f = fixture(); await f.start();
    f.control.cash = 10;
    f.advance(1_000); await f.controller.tick();
    expect(f.control.canceled.length).toBeGreaterThan(0);
    expect(f.control.placed).toHaveLength(6);
  });

  it("journals MATCHED through CONFIRMED once and queries old incomplete receipts beyond five minutes", async () => {
    const f = fixture(); await f.start();
    const order = f.control.orders[0]!;
    f.advance(1_000);
    const pending: Fill = { id: "delayed-settlement", orderId: order.id, makerOrderId: order.id, marketRef: order.marketRef, tokenId: order.tokenId, conditionId: order.conditionId, outcome: order.outcome, side: "BUY", size: 5, matchedAmountDelta: 5, price: order.price, ts: START + 1_000, settlementStatus: "MATCHED" };
    const sinceValues: number[] = [];
    f.venue.tradeSettlements = async (_account, since) => { sinceValues.push(since); return structuredClone(f.control.fills.filter((fill) => fill.ts >= since)); };
    f.control.fills.push(pending);
    f.control.orders[0]!.filledSize = 5;
    await f.controller.tick();
    expect(f.controller.stateSnapshot().inventory).toEqual({});
    expect(f.controller.status().lastReconciliation?.ok).toBe(false);
    f.advance(10 * 60_000);
    f.control.fills[0]!.settlementStatus = "CONFIRMED";
    f.control.positions.push({ marketRef: order.marketRef, tokenId: order.tokenId, conditionId: order.conditionId, outcome: order.outcome, side: order.outcome!, size: 5, avgPrice: order.price });
    f.control.cash -= 5 * order.price;
    await f.controller.tick(); await f.controller.tick();
    expect(sinceValues.at(-1)).toBeLessThanOrEqual(pending.ts);
    expect(f.controller.stateSnapshot().inventory[order.tokenId!]?.quantity).toBe(5);
    expect(Object.values(f.controller.stateSnapshot().settlements ?? {}).filter((row) => row.status === "MATCHED")).toEqual([]);
  });

  it("a FAILED match releases its settlement hold without phantom inventory, including repeated failed history after a rematch", async () => {
    const f = fixture(); await f.start();
    const order = structuredClone(f.control.orders[0]!);
    f.venue.tradeSettlements = async () => structuredClone(f.control.fills);
    const failed: Fill = { id: "failed-trade", orderId: order.id, makerOrderId: order.id, marketRef: order.marketRef, tokenId: order.tokenId, conditionId: order.conditionId, outcome: order.outcome, side: "BUY", size: 4, matchedAmountDelta: 4, price: order.price, ts: START, settlementStatus: "MATCHED" };
    f.control.fills.push(failed);
    f.control.orders[0]!.filledSize = 4;
    await f.controller.tick();
    expect(f.controller.status().lastReconciliation?.ok).toBe(false);
    f.control.fills[0]!.settlementStatus = "FAILED";
    f.control.orders[0]!.filledSize = 0;
    await f.controller.tick();
    expect(f.controller.stateSnapshot().inventory).toEqual({});
    f.advance(1_000);
    f.addFill(order, order.size, "successful-rematch");
    f.control.fills.at(-1)!.settlementStatus = "CONFIRMED";
    await f.controller.tick(); await f.controller.tick();
    expect(f.controller.stateSnapshot().inventory[order.tokenId!]?.quantity).toBe(order.size);
    expect(f.controller.status().halted).toBe(false);
  });

  it("rejects settlement economic changes and immediately cancels unsafe exposure", async () => {
    const f = fixture(); await f.start();
    const order = f.control.orders[0]!;
    f.venue.tradeSettlements = async () => structuredClone(f.control.fills);
    f.control.fills.push({ id: "changed-terms", orderId: order.id, makerOrderId: order.id, marketRef: order.marketRef, tokenId: order.tokenId, conditionId: order.conditionId, outcome: order.outcome, side: "BUY", size: 5, price: order.price, ts: START, settlementStatus: "MATCHED" });
    await f.controller.tick();
    f.control.fills[0]!.size = 6;
    f.control.fills[0]!.settlementStatus = "CONFIRMED";
    await expect(f.controller.tick()).rejects.toThrow(/settlement terms changed/);
    expect(f.controller.status().halted).toBe(true);
    expect(f.control.cancelAll).toBeGreaterThan(0);
  });

  it("keeps heartbeat safety changes isolated from an in-flight dry-run preview", async () => {
    const f = fixture(); await f.start();
    const originalBook = f.venue.tokenBook!;
    let fired = false;
    f.venue.tokenBook = async (token) => {
      if (!fired) { fired = true; await (f.controller as unknown as { failClosed(reason: string): Promise<void> }).failClosed("heartbeat stopped during preview"); }
      return originalBook(token);
    };
    await f.controller.dryRun();
    expect(f.controller.status()).toMatchObject({ halted: true, haltReason: "heartbeat stopped during preview" });
    const saved = JSON.parse((await f.state.get("market-make:two-sided:v1"))!);
    expect(saved.active).toBe(false);
    expect(Object.keys(saved.orders).some((id) => id.startsWith("preview:"))).toBe(false);
  });

  it("persists passive reduction intent after a loss latch and continues exits on later ticks", async () => {
    const f = fixture(); await f.start();
    const order = f.control.orders.find((row) => row.tokenId === "yes-0")!;
    f.advance(1_000); f.addFill(order, order.size); await f.controller.tick();
    f.control.bid = 0.1; f.control.ask = 0.12;
    f.advance(1_000); await f.controller.tick();
    expect(f.controller.stateSnapshot()).toMatchObject({ lossLatched: true, active: false, reduceOnly: true });
    f.advance(6_000); await f.controller.tick(); f.advance(1_000); await f.controller.tick();
    expect(f.control.placed.some((row) => row.side === "SELL" && row.tokenId === "yes-0")).toBe(true);
  });

  it("checkpoints only trading-related market identities rather than rejected discovery candidates", async () => {
    const f = fixture(); await f.start();
    expect(Object.keys(f.controller.stateSnapshot().markets)).toHaveLength(3);
    expect(JSON.stringify(f.controller.stateSnapshot())).not.toContain("Market 5?");
  });

  it("automatically restores authorized quoting after a transient heartbeat outage settles", async () => {
    const f = fixture(); f.control.failHeartbeat = true;
    await f.start();
    expect(f.controller.stateSnapshot()).toMatchObject({ active: false, recoverablePause: true });
    f.control.failHeartbeat = false;
    f.advance(6_000); await f.controller.tick();
    expect(f.controller.status().halted).toBe(true);
    f.advance(1_000); await f.controller.tick();
    expect(f.controller.status()).toMatchObject({ lifecycle: "ACTIVE", liveOrders: 6 });
    await f.controller.halt();
    f.advance(6_000); await f.controller.tick(); f.advance(1_000); await f.controller.tick();
    expect(f.controller.status().halted).toBe(true);
    expect(f.controller.stateSnapshot().recoverablePause).toBe(false);
  });

  it("uses exact authenticated holdings to exit a confirmed fill while the public positions index is empty", async () => {
    const f = fixture(); await f.start();
    const order = f.control.orders.find((row) => row.tokenId === "yes-0")!;
    f.advance(1_000); f.addFill(order, 10);
    f.control.positions = [];
    f.control.exactTokens.set("yes-0", 10);
    await f.controller.tick();
    expect(f.controller.stateSnapshot().inventory["yes-0"]?.quantity).toBe(10);
    expect(f.controller.status().lastReconciliation?.ok).toBe(true);
    f.advance(6_000); await f.controller.tick(); f.advance(1_000); await f.controller.tick();
    expect(f.control.placed.some((row) => row.side === "SELL" && row.tokenId === "yes-0")).toBe(true);
  });

  it("does not create phantom NAV gains or loss stops when confirmed fills lead the cash endpoint", async () => {
    const f = fixture(); await f.start();
    const order = f.control.orders.find((row) => row.tokenId === "yes-0")!;
    f.advance(1_000); f.addFill(order, 10);
    const settledCash = f.control.cash;
    f.control.cash = 500;
    await f.controller.tick();
    expect(f.controller.stateSnapshot()).toMatchObject({ confirmedCollateralUsd: settledCash, collateralUnsettled: true });
    expect(f.controller.status().availability.collateralTotalUsd).toBeCloseTo(settledCash);
    expect(f.controller.status().lastReconciliation?.ok).toBe(false);
    expect(f.controller.status().loss.highWaterUsd).toBeLessThanOrEqual(500);
    expect(f.controller.status().loss.markedPnlUsd).toBeLessThanOrEqual(0);
    f.control.cash = settledCash + 0.000001;
    f.advance(6_000); await f.controller.tick();
    expect(f.controller.stateSnapshot().collateralUnsettled).toBe(false);
    expect(f.controller.status().lossLatched).toBe(false);
    expect(f.controller.status().loss.highWaterUsd).toBeLessThanOrEqual(500.000001);
  });

  it("does not deduct a fill twice when cash and token balances arrive before the fill feed", async () => {
    const f = fixture(); await f.start();
    const order = f.control.orders.find((row) => row.tokenId === "yes-0")!;
    f.advance(1_000); f.addFill(order, 10);
    const delayed = f.control.fills.splice(0);
    await f.controller.tick();
    expect(f.controller.stateSnapshot()).toMatchObject({ confirmedCollateralUsd: 500, collateralUnsettled: true });
    f.control.fills.push(...delayed);
    f.advance(1_000); await f.controller.tick();
    expect(f.controller.stateSnapshot().confirmedCollateralUsd).toBeCloseTo(f.control.cash);
    expect(f.controller.stateSnapshot().collateralUnsettled).toBe(false);
    expect(f.controller.status().lossLatched).toBe(false);
  });

  it("does not turn an operator halt into liquidation when held inventory resolves", async () => {
    const f = fixture(); await f.start();
    const order = structuredClone(f.control.orders.find((row) => row.tokenId === "yes-0")!);
    f.advance(1_000); f.addFill(order, 10);
    await f.controller.tick();
    await f.controller.halt();
    const placedAtHalt = f.control.placed.length;
    for (const position of f.control.positions) position.redeemable = true;
    f.advance(60_000); await f.controller.tick();
    f.advance(1_000); await f.controller.tick();
    expect(f.controller.stateSnapshot().redemptions?.["condition-0"]?.operatorRequired).toBe(true);
    expect(f.controller.stateSnapshot().reduceOnly).toBe(false);
    expect(f.controller.status().halted).toBe(true);
    expect(f.control.placed).toHaveLength(placedAtHalt);
  });

  it("durably marks resolved inventory for local redemption without widening runtime authority or retrying transactions", async () => {
    const f = fixture(); await f.start();
    const redeem = vi.fn(async () => { throw new Error("runtime does not carry a relayer credential"); });
    f.venue.redeem = redeem;
    const pair = structuredClone(f.control.orders.filter((row) => row.conditionId === "condition-0"));
    f.advance(60_000);
    for (const order of pair) f.addFill(order, order.size);
    for (const position of f.control.positions) position.redeemable = true;
    await f.controller.tick();
    const marker = f.controller.stateSnapshot().redemptions?.["condition-0"];
    expect(marker).toMatchObject({ status: "UNKNOWN", operatorRequired: true, tokenIds: ["yes-0", "no-0"] });
    expect(f.controller.status()).toMatchObject({ halted: true, activationCurrent: false });
    expect(f.controller.stateSnapshot().recoverablePause).toBe(false);
    const durable = JSON.parse((await f.state.get("market-make:two-sided:v1"))!);
    expect(durable.redemptions["condition-0"].operatorRequired).toBe(true);
    f.advance(6_000); await f.controller.tick(); f.advance(1_000); await f.controller.tick();
    expect(redeem).not.toHaveBeenCalled();
    await expect(f.controller.resume()).rejects.toThrow(/redemption/);
    // A local authorized redemption is adopted only through an exact reviewed
    // reconciliation, not an unattended retry or a transient empty index.
    f.control.positions = [];
    f.control.cash += pair[0]!.size;
    await f.approve();
    expect(f.controller.stateSnapshot().redemptions?.["condition-0"]).toMatchObject({ status: "CONFIRMED", operatorRequired: false });
    expect(f.controller.status().halted).toBe(true);
    expect(redeem).not.toHaveBeenCalled();
  });
});

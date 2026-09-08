// packages/runtime-node/test/adaptive-market-make-controller.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryStateStore, normalizePolymarketOrderSize,
  type Fill, type MarketMakeExactForecast, type MarketMakeSignalRow, type Order, type OrderIntent,
  type PolymarketMarketCatalog, type Position, type VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import { createAdaptiveMarketMakeConfig, createTwoSidedMarketMakeConfig, type MarketMakeConfig } from "@quotient-forecasting/strategy-market-make";
import { TwoSidedMarketMakeController, type TwoSidedMarketMakeControllerDeps } from "../src/two-sided-market-make-controller.js";

const START = 2_000_000_000_000;
const CHECKPOINT = "market-make:two-sided:v1";
const controllers: TwoSidedMarketMakeController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.shutdown();
  vi.restoreAllMocks();
});

function fixture(options: { count?: number; config?: MarketMakeConfig; qYes?: number; qAgeHours?: number } = {}) {
  let clock = START;
  const state = new MemoryStateStore();
  const markets: PolymarketMarketCatalog[] = Array.from({ length: options.count ?? 3 }, (_, index) => ({
    marketKey: `polymarket:${index}`, nativeMarketId: String(index), conditionId: `condition-${index}`,
    marketRef: `yes-${index}`, question: `Adaptive market ${index}?`, eventId: `event-${index}`, category: "Politics",
    yesTokenId: `yes-${index}`, noTokenId: `no-${index}`, active: true, closed: false, archived: false,
    acceptingOrders: true, orderbookEnabled: true, endsAt: START + 30 * 86_400_000,
    volume24hUsd: 100_000, tickSize: .01, minOrderSize: 5,
  }));
  const config = options.config ?? createAdaptiveMarketMakeConfig({
    capital: { base_order_notional_usd: 15, max_order_notional_usd: 20, minimum_free_collateral_usd: 0,
      operational_reserve_usd: 0, max_total_inventory_and_pending_entry_cost_usd: 200,
      hard_market_cost_usd: 60, max_active_markets: 3, max_live_orders: 6 },
    portfolio_risk: { max_event_cost_usd: 100, max_category_family_cost_usd: 200,
      max_manual_correlation_group_cost_usd: 100, max_open_markets_per_event: 1 },
    two_sided: { target_markets: 3, minimum_volume_24h_usd: 100, minimum_depth_usd: 10,
      minimum_rest_seconds: 30, maximum_unpaired_notional_usd: 60 },
  });
  config.cassie_overrides.bankroll.mode = "fixed";
  const control = {
    cash: 500, orders: [] as Order[], positions: [] as Position[], fills: [] as Fill[],
    placed: [] as OrderIntent[], prepared: [] as OrderIntent[], canceled: [] as string[], cancelAll: 0,
    qYes: options.qYes ?? .5, forecastAt: START - (options.qAgeHours ?? 24) * 3_600_000,
    qVersion: "forecast-v1", warning: false, qFailure: undefined as Error | undefined,
    omitQ: false, wrongIdentity: false, bid: .48, ask: .52, prepareDelayMs: 0,
  };
  const exactForecasts = vi.fn(async (keys: string[]): Promise<MarketMakeExactForecast[]> => {
    if (control.qFailure) throw control.qFailure;
    if (control.omitQ) return [];
    return keys.map((key) => ({
      marketKey: control.wrongIdentity ? "polymarket:unexpected" : key,
      qYes: control.qYes, forecastAt: new Date(control.forecastAt).toISOString(), forecastId: control.qVersion,
      forecastStatus: { state: control.warning ? "warning" : "sideways", drawdownRiskElevated: control.warning },
    }));
  });
  const venue = {
    id: "polymarket", verifiedAgainst: "test",
    balances: async () => [{ asset: "pUSD", total: control.cash, available: control.cash }],
    positions: async () => structuredClone(control.positions),
    openOrders: async () => structuredClone(control.orders),
    fills: async (_account: unknown, since: number) => structuredClone(control.fills.filter((fill) => fill.ts >= since)),
    tokenBalance: async (_account: unknown, tokenId: string) => control.positions.find((row) => row.tokenId === tokenId)?.size ?? 0,
    normalizeOrderSize: normalizePolymarketOrderSize,
    tokenBook: async (tokenId: string) => ({ marketRef: tokenId, bids: [{ price: control.bid, size: 100_000 }], asks: [{ price: control.ask, size: 100_000 }], ts: clock }),
    placeOrderWithLifecycle: async (_account: unknown, intent: OrderIntent, hooks: { onPrepared(meta: { preparedHash: string; tokenId: string; conditionId?: string; outcome?: "YES" | "NO" }): Promise<void> }) => {
      expect(JSON.parse((await state.get(CHECKPOINT))!).orders[intent.clientId].status).toBe("RESERVED");
      control.prepared.push(structuredClone(intent));
      clock += control.prepareDelayMs;
      await hooks.onPrepared({ preparedHash: `signed:${intent.clientId}`, tokenId: intent.tokenId!, conditionId: intent.conditionId, outcome: intent.outcome });
      control.placed.push(structuredClone(intent));
      const id = `venue-${control.placed.length}`;
      control.orders.push({ id, marketRef: intent.marketRef, tokenId: intent.tokenId,
        conditionId: intent.conditionId, outcome: intent.outcome, side: intent.side,
        size: normalizePolymarketOrderSize(intent.size), filledSize: 0, price: intent.limitPrice,
        tif: "GTC", status: "open", createdAt: clock });
      return { orderId: id, status: "open", tokenId: intent.tokenId };
    },
    cancelOrder: async (_account: unknown, id: string) => { control.canceled.push(id); control.orders = control.orders.filter((row) => row.id !== id); },
    cancelAll: async () => { control.cancelAll += 1; control.orders = []; },
    heartbeat: async () => {},
  } as unknown as VenueAdapter;
  const deps: TwoSidedMarketMakeControllerDeps = {
    config, stateStore: state, venue,
    account: { venue: "polymarket", signerAddress: "0x1", funder: "0x2", signatureType: 3 },
    quotient: { exactForecasts, activeSignals: vi.fn(async () => []), spentUsd: 0 },
    catalog: {
      activeMarkets: async () => structuredClone(markets),
      market: async (key) => structuredClone(markets.find((market) => market.marketKey === key)!),
      recover: async ({ clobTokenId }) => { const catalog = markets.find((row) => row.yesTokenId === clobTokenId || row.noTokenId === clobTokenId)!; return { marketKey: catalog.marketKey, nativeMarketId: catalog.nativeMarketId, catalog }; },
    },
  };
  const controller = new TwoSidedMarketMakeController(deps, { deploymentId: "adaptive-test", now: () => clock, autoSchedule: false, enableSubscriptions: false });
  controllers.push(controller);
  const advance = (ms: number) => { clock += ms; };
  const approve = async () => { const proposal = await controller.reconcile(); await controller.reconcile({ apply: true, expectedProposalHash: proposal.proposalHash }); };
  const start = async () => { await controller.start(); await approve(); await controller.resume(); };
  const fill = (order: Order, size: number) => {
    control.positions.push({ marketRef: order.marketRef, tokenId: order.tokenId, conditionId: order.conditionId,
      outcome: order.outcome, side: order.outcome!, size, avgPrice: order.price });
    control.cash -= size * order.price;
    control.fills.push({ id: `fill:${order.id}`, orderId: order.id, makerOrderId: order.id,
      marketRef: order.marketRef, tokenId: order.tokenId, conditionId: order.conditionId,
      outcome: order.outcome, side: "BUY", size, matchedAmountDelta: size, price: order.price, ts: clock });
    const resting = control.orders.find((row) => row.id === order.id)!;
    resting.filledSize += size;
    control.orders = control.orders.filter((row) => row.size - row.filledSize > 1e-8);
  };
  return { controller, control, config, state, markets, exactForecasts, deps, venue, advance, approve, start, fill };
}

const terms = (rows: Array<{ tokenId?: string; outcome?: string; side: string; size: number; limitPrice: number }>) => rows.map(({ tokenId, outcome, side, size, limitPrice }) => ({ tokenId, outcome, side, size: normalizePolymarketOrderSize(size), limitPrice }));

function held(f: ReturnType<typeof fixture>, yes: number, no: number, averageCost = .48) {
  const market = f.markets[0]!;
  for (const [outcome, size, tokenId] of [["YES", yes, market.yesTokenId], ["NO", no, market.noTokenId]] as const) {
    if (size > 0) f.control.positions.push({ marketRef: tokenId, tokenId, conditionId: market.conditionId,
      outcome, side: outcome, size, avgPrice: averageCost });
  }
}

function publishedSignal(market: PolymarketMarketCatalog): MarketMakeSignalRow {
  return {
    signalId: `signal:${market.marketKey}`, marketKey: market.marketKey, nativeMarketId: market.nativeMarketId,
    conditionId: market.conditionId, publishedAt: new Date(START - 3_600_000).toISOString(),
    forecastAt: new Date(START - 3_600_000).toISOString(), entryQYes: .5, entryMarketYes: .5,
    qYes: .5, publishedSide: "YES", isActive: true, forecastStatus: { state: "sideways", drawdownRiskElevated: false },
  };
}

describe("adaptive market-maker controller", () => {
  it("keeps live-Q dry-run orderless and does not persist checkpoint or forecast cache", async () => {
    const f = fixture();
    await f.controller.start();
    const before = await f.state.get(CHECKPOINT);
    const writes = vi.spyOn(f.state, "set");
    const preview = await f.controller.dryRun();
    expect(preview.actions.length).toBeGreaterThan(0);
    expect(f.exactForecasts).toHaveBeenCalled();
    expect(f.control.placed).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
    expect(await f.state.get(CHECKPOINT)).toBe(before);
  });

  it("uses a24-hour-old daily Q and preserves Q-adjusted terms through actual preparation", async () => {
    const f = fixture({ qYes: .60 });
    await f.controller.start(); await f.approve();
    const preview = await f.controller.dryRun();
    expect(preview.actions.length).toBeGreaterThan(0);
    expect(preview.actions.some((row) => row.limitPrice !== .48)).toBe(true);
    await f.controller.resume();
    expect(terms(f.control.placed)).toEqual(terms(preview.actions));
    expect(terms(f.control.prepared)).toEqual(terms(f.control.placed));
    expect(f.control.placed.every((row) => row.postOnly && row.tif === "GTC")).toBe(true);
  });

  it("aborts known-before-POST when SDK preparation outlasts fresh books and can quote again without unhalting", async () => {
    const f = fixture({ count: 1, qAgeHours: 12 });
    f.control.prepareDelayMs = 6_000;
    await f.start();
    expect(f.control.prepared.length).toBeGreaterThan(0);
    expect(f.control.placed).toEqual([]);
    expect(f.control.orders).toEqual([]);
    expect(Object.values(f.controller.stateSnapshot().orders).every((row) => row.status === "REJECTED" && !row.venueId)).toBe(true);
    expect(f.controller.status().halted).toBe(false);
    f.control.prepareDelayMs = 0;
    f.advance(1_000); await f.controller.tick();
    expect(f.control.placed).toHaveLength(2);
    expect(Object.values(f.controller.stateSnapshot().orders).some((row) => row.status === "UNKNOWN")).toBe(false);
  });

  it("revalidates Q expiry during SDK preparation even while the captured books remain fresh", async () => {
    const f = fixture({ count: 1 });
    f.control.forecastAt = START - 36 * 3_600_000 + 1_000;
    f.control.prepareDelayMs = 2_000;
    await f.start();
    expect(f.control.prepared).toHaveLength(1);
    expect(f.control.placed).toEqual([]);
    expect(f.control.orders).toEqual([]);
    expect(Object.values(f.controller.stateSnapshot().orders)).toEqual([
      expect.objectContaining({ status: "REJECTED", error: expect.stringContaining("current forecast") }),
    ]);
    expect(f.controller.status().halted).toBe(false);
    expect(f.controller.stateSnapshot().collateralUsd).toBe(500);
  });

  it("also aborts if the durable SIGNED write outlasts book freshness without leaving an ambiguous receipt", async () => {
    const f = fixture({ count: 1, qAgeHours: 12 });
    const original = f.state.set.bind(f.state);
    vi.spyOn(f.state, "set").mockImplementation(async (key, value) => {
      await original(key, value);
      if (key === CHECKPOINT && Object.values(JSON.parse(value).orders).some((row) => (row as { status: string }).status === "SIGNED")) f.advance(6_000);
    });
    await f.start();
    expect(f.control.prepared.length).toBeGreaterThan(0);
    expect(f.control.placed).toEqual([]);
    expect(Object.values(f.controller.stateSnapshot().orders).every((row) => row.status === "REJECTED" && row.preparedHash)).toBe(true);
    expect(f.controller.status().halted).toBe(false);
  });

  it.each(["stale", "future", "identity", "probability"] as const)("blocks new BUYs for invalid Q: %s", async (kind) => {
    const f = fixture();
    if (kind === "stale") f.control.forecastAt = START - 30 * 86_400_000;
    if (kind === "future") f.control.forecastAt = START + 86_400_000;
    if (kind === "identity") f.control.wrongIdentity = true;
    if (kind === "probability") f.control.qYes = 52;
    await f.start();
    expect(f.control.placed.filter((row) => row.side === "BUY")).toEqual([]);
    expect(f.controller.status().lossLatched).toBe(false);
  });

  it("batches a liquidity-first shortlist in groups of ten and reuses successful cache", async () => {
    const f = fixture({ count: 25 });
    await f.start();
    // A live cycle loads at most one batch so Q HTTP latency cannot monopolize
    // order supervision. Unqueried candidates are hydrated on subsequent ticks.
    for (let i = 0; i < 2; i++) { f.advance(1_000); await f.controller.tick(); }
    const initial = f.exactForecasts.mock.calls.map(([keys]) => keys);
    expect(initial.map((keys) => keys.length)).toEqual([10, 10, 5]);
    expect(new Set(initial.flat()).size).toBe(25);
    for (let i = 0; i < 4; i++) { f.advance(15_000); await f.controller.tick(); }
    expect(f.exactForecasts).toHaveBeenCalledTimes(3);
  });

  it.each(["failure", "missing"] as const)("retains last-good Q without changing its publication time after a %s refresh", async (mode) => {
    const f = fixture({ qAgeHours: 12 });
    await f.start();
    const before = structuredClone(f.controller.stateSnapshot().forecasts?.["polymarket:0"]);
    expect(before?.value?.forecastAt).toBe(f.control.forecastAt);
    if (mode === "failure") f.control.qFailure = new Error("forecast unavailable");
    else f.control.omitQ = true;
    f.advance(901_000); await f.controller.tick();
    const after = f.controller.stateSnapshot().forecasts?.["polymarket:0"];
    expect(after?.value).toEqual(before?.value);
    expect(after?.fetchedAt).toBe(before?.fetchedAt);
    expect(f.controller.status().halted).toBe(false);
    const calls = f.exactForecasts.mock.calls.length;
    f.advance(1_000); await f.controller.tick();
    expect(f.exactForecasts).toHaveBeenCalledTimes(calls);
  });

  it("keeps a net-reducing inventory SELL supervised through forecast HTTP failure", async () => {
    const f = fixture({ qAgeHours: 12 });
    await f.start();
    const buy = f.control.orders.find((row) => row.tokenId === "yes-0")!;
    expect(buy).toBeDefined();
    f.advance(1_000); f.fill(buy, 10); await f.controller.tick();
    f.advance(6_000); await f.controller.tick();
    f.advance(1_000); await f.controller.tick();
    const sell = f.control.orders.find((row) => row.tokenId === "yes-0" && row.side === "SELL");
    expect(sell).toBeDefined();
    const cancelAll = f.control.cancelAll;
    f.control.qFailure = new Error("forecast service timeout");
    f.advance(901_000); await f.controller.tick();
    expect(f.controller.status().halted).toBe(false);
    expect(f.control.cancelAll).toBe(cancelAll);
    expect(f.control.canceled).not.toContain(sell!.id);
    expect(f.control.orders.some((row) => row.id === sell!.id)).toBe(true);
  });

  it("allows only a genuinely net-reducing SELL when a newer Q warns against additions", async () => {
    const config = createAdaptiveMarketMakeConfig({ two_sided: { adaptive: { forecast_refresh_seconds: 1 } } });
    const f = fixture({ config, qAgeHours: 12 });
    await f.start();
    const buy = f.control.orders.find((row) => row.tokenId === "yes-0")!;
    f.advance(1_000); f.fill(buy, 10); await f.controller.tick();
    f.control.warning = true;
    f.control.forecastAt = START + 1_000;
    const placed = f.control.placed.length;
    f.advance(6_000); await f.controller.tick();
    f.advance(1_000); await f.controller.tick();
    const newOrders = f.control.placed.slice(placed);
    expect(newOrders.some((row) => row.side === "SELL" && row.tokenId === "yes-0")).toBe(true);
    expect(newOrders.every((row) => row.side === "SELL" && row.tokenId === "yes-0" && row.size <= 10)).toBe(true);
    expect(f.controller.status().lossLatched).toBe(false);
  });

  it("cancels an unsafe Q-adjusted quote before the ordinary thirty-second rest expires", async () => {
    const config = createAdaptiveMarketMakeConfig({ two_sided: { adaptive: { forecast_refresh_seconds: 1 } } });
    const f = fixture({ config, qAgeHours: 12 });
    await f.start();
    const oldIds = f.control.orders.map((row) => row.id);
    expect(oldIds.length).toBeGreaterThan(0);
    f.control.qYes = .70;
    f.control.forecastAt = START + 1_000;
    f.control.qVersion = "forecast-v2";
    f.advance(2_000); await f.controller.tick();
    expect(f.control.canceled.some((id) => oldIds.includes(id))).toBe(true);
    expect(f.controller.status().lossLatched).toBe(false);
  });

  it("does not call Quotient for an ordinary two-sided controller", async () => {
    const f = fixture({ config: createTwoSidedMarketMakeConfig() });
    await f.start();
    expect(f.exactForecasts).not.toHaveBeenCalled();
    expect(f.control.placed.length).toBeGreaterThan(0);
  });

  it("continues bounded SELL recycling of a balanced complete set after the one-hour inventory age", async () => {
    const f = fixture({ count: 1, qAgeHours: 12 });
    held(f, 10, 10);
    await f.controller.start(); await f.approve();
    f.advance(3_601_000);
    const preview = await f.controller.dryRun();
    expect(preview.actions.map((row) => [row.side, row.outcome]).sort()).toEqual([["SELL", "NO"], ["SELL", "YES"]]);
    await f.controller.resume();
    expect(terms(f.control.placed)).toEqual(terms(preview.actions));
    expect(f.control.placed.every((row) => row.size <= 10 && row.size * row.limitPrice <= f.config.capital.max_order_notional_usd)).toBe(true);
    expect(f.controller.status().lossLatched).toBe(false);
  });

  it.each(["YES", "NO"] as const)("at 24 hours only reduces unmatched %s shares without breaking the ten-share complete set", async (outcome) => {
    const f = fixture({ count: 1, qAgeHours: 12 });
    held(f, outcome === "YES" ? 20 : 10, outcome === "NO" ? 20 : 10);
    await f.controller.start(); await f.approve();
    f.advance(86_400_000);
    f.control.forecastAt = START + 86_400_000;
    await f.controller.resume();
    expect(f.control.placed).toHaveLength(1);
    expect(f.control.placed[0]).toMatchObject({ side: "SELL", outcome });
    expect(f.control.placed[0]!.size).toBeLessThanOrEqual(10);
    expect(f.controller.status().lossLatched).toBe(false);
  });

  it("records entry Q at submission and holds supported surplus past one and six hours", async () => {
    const f = fixture({ count: 1, qYes: .7, qAgeHours: 0 });
    await f.start();
    const buy = f.control.orders.find((row) => row.tokenId === "yes-0" && row.side === "BUY")!;
    expect(buy).toBeDefined();
    f.advance(1_000); f.fill(buy, 10); await f.controller.tick();
    const original = f.controller.stateSnapshot().inventory["yes-0"]!;
    expect(original).toMatchObject({ firstHeldAt: START + 1_000, qBacked: true });
    expect(original.initialEdgePp).toBeCloseTo((.7 - buy.price) * 100);
    for (const hours of [1, 5, 17]) {
      f.advance(hours * 3_600_000); await f.controller.tick();
      expect(f.controller.stateSnapshot().inventory["yes-0"]).toMatchObject(original);
      expect(f.control.orders.some((row) => row.side === "SELL" && row.tokenId === "yes-0")).toBe(false);
      expect(f.controller.status().lossLatched).toBe(false);
    }
  });

  it("latches convergence exits and preserves the exit decision in orderless previews", async () => {
    const f = fixture({ count: 1, qYes: .7, qAgeHours: 0 });
    held(f, 10, 0);
    await f.start();
    expect(f.controller.stateSnapshot().inventory["yes-0"]?.qBacked).toBe(true);
    f.control.qYes = .52;
    f.control.forecastAt = START + 901_000;
    f.advance(901_000); await f.controller.tick();
    f.advance(6_000); await f.controller.tick();
    expect(f.controller.stateSnapshot().inventory["yes-0"]?.exitReason).toBe("adaptive-inventory-converged");
    expect(f.control.orders.some((row) => row.side === "SELL" && row.tokenId === "yes-0")).toBe(true);
    expect(f.control.orders.some((row) => row.side === "BUY")).toBe(false);
    await f.controller.halt();
    f.advance(6_000); await f.controller.tick();
    f.control.qYes = .7;
    f.control.forecastAt += 902_000;
    f.advance(902_000);
    await f.controller.tick();
    const before = await f.state.get(CHECKPOINT);
    const preview = await f.controller.dryRun();
    expect(preview.actions).toHaveLength(1);
    expect(preview.actions[0]).toMatchObject({ side: "SELL", tokenId: "yes-0" });
    expect(await f.state.get(CHECKPOINT)).toBe(before);
    await f.controller.resume();
    expect(f.control.orders.every((row) => row.side === "SELL" && row.tokenId === "yes-0")).toBe(true);
  });

  it("keeps the original holding deadline through reviewed reconciliation and restart", async () => {
    const f = fixture({ count: 1, qYes: .7, qAgeHours: 0 });
    held(f, 10, 0);
    await f.start();
    const original = f.controller.stateSnapshot().inventory["yes-0"]!;
    await f.controller.halt();
    f.advance(6 * 3_600_000); await f.controller.tick();
    await f.approve();
    expect(f.controller.stateSnapshot().inventory["yes-0"]).toMatchObject(original);
    await f.controller.shutdown();
    const restarted = new TwoSidedMarketMakeController(f.deps, { deploymentId: "adaptive-test-restart", now: () => START + 86_400_000, autoSchedule: false, enableSubscriptions: false });
    controllers.push(restarted);
    f.advance(18 * 3_600_000);
    f.control.forecastAt = START + 86_400_000;
    await restarted.start();
    const proposal = await restarted.reconcile();
    await restarted.reconcile({ apply: true, expectedProposalHash: proposal.proposalHash });
    expect(restarted.stateSnapshot().inventory["yes-0"]).toMatchObject(original);
    await restarted.resume();
    expect(restarted.stateSnapshot().inventory["yes-0"]?.exitReason).toBe("adaptive-inventory-hold-ceiling");
    expect(f.control.orders).toHaveLength(1);
    expect(f.control.orders[0]).toMatchObject({ side: "SELL", tokenId: "yes-0" });
  });

  it("does not restart the holding clock or entry gap on a later partial BUY fill", async () => {
    const f = fixture({ count: 1, qYes: .7, qAgeHours: 0 });
    await f.start();
    const buy = f.control.orders.find((row) => row.tokenId === "yes-0" && row.side === "BUY")!;
    f.advance(1_000); f.fill(buy, 5); await f.controller.tick();
    const original = f.controller.stateSnapshot().inventory["yes-0"]!;
    f.advance(6_000); await f.controller.tick();
    f.advance(3_594_000); await f.controller.tick();
    const topUp = f.control.orders.find((row) => row.tokenId === "yes-0" && row.side === "BUY")!;
    expect(topUp).toBeDefined();
    f.control.positions[0]!.size += 5;
    f.control.cash -= 5 * topUp.price;
    f.control.fills.push({ ...f.control.fills[0]!, id: "top-up-fill", orderId: topUp.id, makerOrderId: topUp.id, price: topUp.price, ts: START + 3_601_000 });
    topUp.filledSize += 5;
    await f.controller.tick();
    expect(f.controller.stateSnapshot().inventory["yes-0"]).toMatchObject({ firstHeldAt: original.firstHeldAt, initialEdgePp: original.initialEdgePp, qBacked: true, quantity: 10 });
  });

  it.each([false, true])("repairs a legacy reconciliation clock reset from one fully accounted BUY (first fill available: %s)", async (keepFirstFill) => {
    const f = fixture({ count: 1, qYes: .7, qAgeHours: 0 });
    await f.start();
    const buy = f.control.orders.find((row) => row.tokenId === "yes-0" && row.side === "BUY")!;
    f.advance(1_000); f.fill(buy, 10); await f.controller.tick();
    await f.controller.halt();
    f.advance(6_000); await f.controller.tick();
    f.advance(6_000); await f.controller.tick();
    await f.controller.shutdown();
    const legacy = f.controller.stateSnapshot();
    legacy.inventory["yes-0"]!.firstHeldAt = START + 6 * 3_600_000;
    const receipt = Object.values(legacy.orders).find((row) => row.venueId === buy.id)!;
    if (!keepFirstFill) delete receipt.firstFillAt;
    await f.state.set(CHECKPOINT, JSON.stringify(legacy));
    f.advance(6 * 3_600_000 - 13_000);
    const restarted = new TwoSidedMarketMakeController(f.deps, { deploymentId: "repaired-clock", now: () => START + 6 * 3_600_000, autoSchedule: false, enableSubscriptions: false });
    controllers.push(restarted);
    await restarted.start();
    const proposal = await restarted.reconcile();
    await restarted.reconcile({ apply: true, expectedProposalHash: proposal.proposalHash });
    expect(restarted.stateSnapshot().inventory["yes-0"]?.firstHeldAt).toBe(keepFirstFill ? START + 1_000 : receipt.createdAt);
    expect(restarted.stateSnapshot().inventory["yes-0"]?.quantity).toBe(10);
  });

  it("preserves a neutral complete set during an explicit reduce-only halt", async () => {
    const f = fixture({ count: 1, qAgeHours: 12 });
    held(f, 10, 10);
    await f.start();
    expect(f.control.orders.map((row) => row.side)).toEqual(["SELL", "SELL"]);
    const placed = f.control.placed.length;
    await f.controller.halt({ liquidate: true });
    f.advance(6_000); await f.controller.tick();
    f.advance(1_000); await f.controller.tick();
    expect(f.controller.stateSnapshot().reduceOnly).toBe(true);
    expect(f.control.placed.slice(placed)).toEqual([]);
    expect(f.control.orders).toEqual([]);
    expect(Object.values(f.controller.stateSnapshot().inventory).map((row) => row.quantity)).toEqual([10, 10]);
  });

  it("does not split a neutral complete set after a marked loss latches", async () => {
    const config = createAdaptiveMarketMakeConfig({ loss_limits: { max_marked_loss_per_market_usd: 1 } });
    const f = fixture({ count: 1, config, qAgeHours: 12 });
    // The reviewed acquisition cost exceeds executable bids, causing a real
    // marked-loss calculation rather than directly setting the internal latch.
    held(f, 10, 10, .6);
    await f.start();
    expect(f.controller.status().lossLatched).toBe(true);
    f.advance(1_000); await f.controller.tick();
    expect(f.control.placed).toEqual([]);
    expect(f.control.orders).toEqual([]);
    expect(Object.values(f.controller.stateSnapshot().inventory).map((row) => row.quantity)).toEqual([10, 10]);
  });

  it("does not break a neutral complete set when no usable Q has been returned", async () => {
    const f = fixture({ count: 1 });
    held(f, 10, 10);
    f.control.omitQ = true;
    await f.start();
    f.advance(3_601_000); await f.controller.tick();
    expect(f.controller.stateSnapshot().forecasts?.["polymarket:0"]?.value).toBeUndefined();
    expect(f.controller.status().lossLatched).toBe(false);
    expect(f.control.placed).toEqual([]);
    expect(Object.values(f.controller.stateSnapshot().inventory).map((row) => row.quantity)).toEqual([10, 10]);
  });

  it("admits an identity-matched published-signal market absent from the Gamma discovery page", async () => {
    const f = fixture({ count: 1 });
    const market = f.markets[0]!;
    const signal = publishedSignal(market);
    f.deps.catalog.activeMarkets = vi.fn(async () => []);
    const lookup = vi.spyOn(f.deps.catalog, "market");
    vi.mocked(f.deps.quotient!.activeSignals).mockResolvedValue([signal]);
    await f.start();
    expect(lookup).toHaveBeenCalledWith(market.marketKey, market.nativeMarketId, market.conditionId);
    expect(f.control.placed.map((row) => [row.side, row.outcome]).sort()).toEqual([["BUY", "NO"], ["BUY", "YES"]]);
    expect(f.controller.stateSnapshot().forecasts?.[market.marketKey]?.value).toMatchObject({ marketKey: market.marketKey, qYes: signal.qYes, forecastAt: Date.parse(signal.forecastAt) });
    expect(f.exactForecasts).not.toHaveBeenCalled();
  });

  it("does not seed a valid-looking Q when the published signal condition conflicts with Gamma", async () => {
    const f = fixture({ count: 1 });
    const market = f.markets[0]!;
    vi.mocked(f.deps.quotient!.activeSignals).mockResolvedValue([{ ...publishedSignal(market), conditionId: "different-condition" }]);
    f.control.omitQ = true;
    await f.start();
    expect(f.exactForecasts).toHaveBeenCalledWith([market.marketKey]);
    expect(f.controller.stateSnapshot().forecasts?.[market.marketKey]?.value).toBeUndefined();
    expect(f.control.placed).toEqual([]);
  });
});

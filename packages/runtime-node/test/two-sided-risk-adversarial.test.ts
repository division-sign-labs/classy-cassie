// packages/runtime-node/test/two-sided-risk-adversarial.test.ts
// Independent public-API probes of cash, paired quotes, and resting-order risk limits.
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryStateStore,
  type Fill,
  type Order,
  type OrderBook,
  type OrderIntent,
  type OrderLifecycleHooks,
  type PolymarketMarketCatalog,
  type Position,
  type VenueAccount,
  type VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import { createTwoSidedMarketMakeConfig, type DeepPartial, type MarketMakeConfig } from "@quotient-forecasting/strategy-market-make";
import { TwoSidedMarketMakeController } from "../src/two-sided-market-make-controller.js";

const START = Date.parse("2026-09-04T22:00:00Z");
const KEY = "market-make:two-sided:v1";
const account: VenueAccount = { venue: "polymarket", signerAddress: "test-signer", funder: "test-wallet", signatureType: 3 };
const controllers: TwoSidedMarketMakeController[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.shutdown()));
});

function market(id: string, eventId = `event-${id}`): PolymarketMarketCatalog {
  return {
    marketKey: `polymarket:${id}`, nativeMarketId: id, conditionId: `condition-${id}`, marketRef: `yes-${id}`,
    question: `Test market ${id}`, eventId, category: "Politics", yesTokenId: `yes-${id}`, noTokenId: `no-${id}`,
    active: true, closed: false, archived: false, acceptingOrders: true, orderbookEnabled: true,
    endsAt: START + 7 * 86_400_000, volume24hUsd: 10_000, tickSize: 0.01, minOrderSize: 5,
  };
}

function fixture(options: { cash?: number; markets?: PolymarketMarketCatalog[]; positions?: Position[]; config?: DeepPartial<MarketMakeConfig> } = {}) {
  let now = START;
  let cash = options.cash ?? 500;
  let externalDepthUsd = 1_000;
  const markets = options.markets ?? [market("1"), market("2"), market("3")];
  const positions = structuredClone(options.positions ?? []);
  const open = new Map<string, Order>();
  const fills: Fill[] = [];
  const submitted: Array<OrderIntent & { orderId: string }> = [];
  const canceled: string[] = [];
  const preparedWasDurable: boolean[] = [];
  const state = new MemoryStateStore();
  const config = createTwoSidedMarketMakeConfig({
    capital: {
      base_order_notional_usd: 30, max_order_notional_usd: 40, hard_market_cost_usd: 120,
      max_active_markets: 3, max_live_orders: 6, minimum_free_collateral_usd: 0, operational_reserve_usd: 0,
      ...options.config?.capital,
    },
    portfolio_risk: {
      max_event_cost_usd: 120, max_category_family_cost_usd: 500, max_manual_correlation_group_cost_usd: 500,
      ...options.config?.portfolio_risk,
    },
    cassie_overrides: { bankroll: { mode: "fixed", maximum_sizing_bankroll_usd: null } },
    two_sided: { target_markets: 3, ...options.config?.two_sided },
  });
  const tokenBook = async (tokenId: string): Promise<OrderBook> => {
    const bids = [{ price: 0.49, size: externalDepthUsd / 0.49 }];
    const asks = [{ price: 0.51, size: 2_000 }];
    // Venue books contain our own resting quotes, just like a real public CLOB.
    for (const order of open.values()) {
      if (order.tokenId !== tokenId) continue;
      const levels = order.side === "BUY" ? bids : asks;
      const level = levels.find((row) => row.price === order.price);
      if (level) level.size += order.size - order.filledSize;
      else levels.push({ price: order.price, size: order.size - order.filledSize });
    }
    return { marketRef: tokenId, bids, asks, ts: now };
  };
  const venue = {
    id: "polymarket",
    verifiedAgainst: "2026-09-04",
    balances: async () => [{ asset: "pUSD", total: cash, available: cash }],
    positions: async () => structuredClone(positions),
    openOrders: async () => structuredClone([...open.values()]),
    fills: async () => structuredClone(fills),
    tradeSettlements: async () => structuredClone(fills),
    tokenBook,
    tokenBalance: async (_account: VenueAccount, tokenId: string) => positions.find((row) => row.tokenId === tokenId)?.size ?? 0,
    normalizeOrderSize: (size: number) => Math.floor((size + 1e-9) * 100) / 100,
    placeOrderWithLifecycle: async (_account: VenueAccount, intent: OrderIntent, hooks: OrderLifecycleHooks) => {
      await hooks.onPrepared({ preparedHash: `prepared:${intent.clientId}`, tokenId: intent.tokenId!, conditionId: intent.conditionId, outcome: intent.outcome });
      const checkpoint = JSON.parse((await state.get(KEY))!);
      preparedWasDurable.push(checkpoint.orders[intent.clientId]?.status === "SIGNED");
      const orderId = `venue-${submitted.length + 1}`;
      submitted.push({ ...structuredClone(intent), orderId });
      open.set(orderId, {
        id: orderId, clientId: intent.clientId, marketRef: intent.marketRef, tokenId: intent.tokenId,
        conditionId: intent.conditionId, outcome: intent.outcome, side: intent.side, size: intent.size,
        filledSize: 0, price: intent.limitPrice, tif: intent.tif, status: "open", createdAt: now,
      });
      return { orderId, status: "open" as const, tokenId: intent.tokenId };
    },
    cancelOrder: async (_account: VenueAccount, id: string) => { canceled.push(id); open.delete(id); },
    cancelAll: async () => { canceled.push(...open.keys()); open.clear(); },
  } as unknown as VenueAdapter;
  const catalog = {
    activeMarkets: async () => structuredClone(markets),
    market: async (key: string) => {
      const found = markets.find((row) => row.marketKey === key);
      if (!found) throw new Error(`missing test market ${key}`);
      return structuredClone(found);
    },
    recover: async (identity: { conditionId?: string; clobTokenId?: string }) => {
      const found = markets.find((row) => row.conditionId === identity.conditionId || row.yesTokenId === identity.clobTokenId || row.noTokenId === identity.clobTokenId);
      return found ? { marketKey: found.marketKey, nativeMarketId: found.nativeMarketId, catalog: structuredClone(found) } : undefined;
    },
  };
  const controller = new TwoSidedMarketMakeController({ config, venue, account, catalog, stateStore: state }, {
    deploymentId: "adversarial-deployment", now: () => now, autoSchedule: false, enableSubscriptions: false,
  });
  controllers.push(controller);
  const prepare = async () => {
    await controller.start();
    const report = await controller.reconcile();
    await controller.reconcile({ apply: true, expectedProposalHash: report.proposalHash });
  };
  return {
    controller, state, submitted, canceled, preparedWasDurable, open, prepare,
    advance: (milliseconds: number) => { now += milliseconds; },
    setCash: (value: number) => { cash = value; },
    setExternalDepth: (value: number) => { externalDepthUsd = value; },
  };
}

function pairs<T extends { marketRef: string; size: number }>(orders: T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const order of orders) result.set(order.marketRef, [...result.get(order.marketRef) ?? [], order]);
  return result;
}

describe("independent two-sided runtime risk probes", () => {
  it("quotes three distinct events, obeying event, category-family, and market-count caps", async () => {
    const f = fixture({
      markets: [market("1", "same-event"), market("2", "same-event"), { ...market("3"), category: "Legal" }, { ...market("4"), category: "Business" }, market("5")],
      config: { portfolio_risk: { max_event_cost_usd: 20, max_category_family_cost_usd: 30 } },
    });
    await f.prepare();
    await f.controller.resume();
    expect(f.submitted).toHaveLength(6);
    expect([...pairs(f.submitted).keys()]).toEqual(["yes-1", "yes-3", "yes-4"]);
    for (const pair of pairs(f.submitted).values()) {
      expect(pair).toHaveLength(2);
      expect(pair[0]!.size).toBe(pair[1]!.size);
      expect(pair.reduce((total, order) => total + order.size * order.limitPrice, 0)).toBeLessThanOrEqual(20 + 1e-8);
    }
    const domesticCost = f.submitted.filter((order) => ["yes-1", "yes-3"].includes(order.marketRef))
      .reduce((total, order) => total + order.size * order.limitPrice, 0);
    expect(domesticCost).toBeLessThanOrEqual(30 + 1e-8);
    expect(f.submitted.every((order) => order.postOnly && order.tif === "GTC")).toBe(true);
    expect(f.preparedWasDurable).toEqual(Array(6).fill(true));
  });

  it("keeps cash-limited legs matched and makes dry run bounded, nonmutating, and equal to live placement", async () => {
    const f = fixture({ cash: 100 });
    await f.prepare();
    const checkpoint = await f.state.get(KEY);
    const state = f.controller.stateSnapshot();
    const preview = await f.controller.dryRun();
    expect(await f.state.get(KEY)).toBe(checkpoint);
    expect(f.controller.stateSnapshot()).toEqual(state);
    expect(f.submitted).toEqual([]);
    expect(f.canceled).toEqual([]);
    expect(preview.actions.length).toBeLessThanOrEqual(6);
    const quotedCash = preview.actions.reduce((total, order) => total + order.size * order.limitPrice, 0);
    expect(quotedCash).toBeLessThanOrEqual(100 + 1e-8);
    expect(quotedCash).toBeGreaterThan(95);
    for (const pair of pairs(preview.actions).values()) {
      expect(pair).toHaveLength(2);
      expect(pair[0]!.size).toBe(pair[1]!.size);
    }
    await f.controller.resume();
    const terms = (order: OrderIntent) => [order.marketRef, order.outcome, order.side, order.size, order.limitPrice];
    expect(f.submitted.map(terms)).toEqual(preview.actions.map(terms));
    const occupiedPreview = await f.controller.dryRun();
    expect(occupiedPreview.actions).toEqual([]);
  });

  it("cancels oversized resting orders immediately when depth shrinks during minimum rest", async () => {
    const f = fixture({ markets: [market("1")], config: { two_sided: { target_markets: 1, minimum_depth_usd: 0 } } });
    await f.prepare();
    await f.controller.resume();
    const original = f.submitted.map((row) => row.orderId);
    expect(original).toHaveLength(2);
    f.setExternalDepth(200);
    f.advance(1_000);
    await f.controller.tick();
    expect(new Set(f.canceled)).toEqual(new Set(original));
    expect(f.submitted).toHaveLength(2);
  });

  it("does not let the bot's own resting BUY satisfy the minimum exit depth", async () => {
    const f = fixture({ markets: [market("1")], config: { two_sided: { target_markets: 1 } } });
    await f.prepare();
    await f.controller.resume();
    const original = f.submitted.map((row) => row.orderId);
    // External $280 plus our ~$30 passes $300 only if our own order is counted.
    f.setExternalDepth(280);
    f.advance(1_000);
    await f.controller.tick();
    expect(new Set(f.canceled)).toEqual(new Set(original));
    expect(f.submitted).toHaveLength(2);
  });

  it("keeps reducing aged inventory while canceling and refusing new inventory bids", async () => {
    const one = market("1");
    const f = fixture({
      markets: [one], config: { two_sided: { target_markets: 1, maximum_inventory_age_seconds: 60 } },
      positions: [{ marketRef: one.marketRef, tokenId: one.yesTokenId, conditionId: one.conditionId, outcome: "YES", side: "YES", size: 40, avgPrice: 0.49, currentPrice: 0.5 }],
    });
    await f.prepare();
    await f.controller.resume();
    const sell = f.submitted.find((order) => order.side === "SELL");
    const buy = f.submitted.find((order) => order.side === "BUY");
    expect(sell).toBeDefined();
    expect(buy).toBeDefined();
    f.advance(61_000);
    await f.controller.tick();
    expect(f.canceled).toContain(buy!.orderId);
    expect(f.canceled).not.toContain(sell!.orderId);
    expect(f.open.has(sell!.orderId)).toBe(true);
    expect(f.submitted.filter((order) => order.side === "BUY")).toHaveLength(1);
  });
});

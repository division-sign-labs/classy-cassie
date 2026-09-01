// strategies/market-make/test/strategy.test.ts
import { describe, expect, it } from "vitest";
import {
  MARKET_MAKE_PRESET,
  MARKET_MAKE_SOURCE_SHA256,
  MarketMakeReplayBundleSchema,
  allocateCandidates,
  buildEntryQuote,
  candidateCapReasons,
  createInitialMarketMakeState,
  createMarketMakeConfig,
  evaluateExit,
  evaluateShock,
  freeSellQuantity,
  gateCandidate,
  liquidityParticipationCaps,
  marketCommittedUsd,
  effectiveMarketMakeBankrollUsd,
  marketMakeConfigForBankroll,
  marketMakeConfigHash,
  normalizeCandidate,
  normalizePublishedSignal,
  portfolioExposure,
  replayMarketMake,
  reduceMarketMake,
  type InventoryCycle,
  type MarketCatalogSnapshot,
  type MarketMakeConfig,
  type MarketMakeState,
  type NormalizedCandidate,
  type NormalizedMarketMakeEvent,
  type NormalizedSignal,
  type PublishedSignalInput,
  type TokenBook,
  type TrackedOrder,
} from "../src/index.js";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const config: MarketMakeConfig = createMarketMakeConfig();

function book(tokenId: string, mid = 0.5, spreadPp = 2, ts = NOW): TokenBook {
  const half = spreadPp / 200;
  const bid = mid - half;
  const ask = mid + half;
  return {
    tokenId,
    bids: [
      { price: bid, size: 1_100 / bid },
      { price: bid - 0.01, size: 1_600 / (bid - 0.01) },
    ],
    asks: [{ price: ask, size: 10_000 }],
    ts,
  };
}

function rawSignal(latestQ: number, overrides: Partial<PublishedSignalInput> = {}): PublishedSignalInput {
  return {
    id: "sig-1",
    marketKey: "polymarket:1",
    nativeMarketId: "1",
    conditionId: "condition-1",
    publishedAt: NOW - 60_000,
    entryQ: latestQ * 100,
    entryPm: 50,
    latestQ,
    qAsOf: NOW - 60_000,
    active: true,
    livePriced: true,
    suppressionReason: null,
    retiredReason: null,
    ...overrides,
  };
}

function signal(latestQ: number, overrides: Partial<PublishedSignalInput> = {}): NormalizedSignal {
  return normalizePublishedSignal(rawSignal(latestQ, overrides));
}

function catalog(category = "Geopolitics", overrides: Partial<MarketCatalogSnapshot> = {}): MarketCatalogSnapshot {
  return {
    marketKey: "polymarket:1",
    nativeMarketId: "1",
    conditionId: "condition-1",
    marketRef: "yes-token",
    eventId: "event-1",
    category,
    yesTokenId: "yes-token",
    noTokenId: "no-token",
    active: true,
    closed: false,
    archived: false,
    acceptingOrders: true,
    orderbookEnabled: true,
    endsAt: NOW + 3 * 86_400_000,
    volume24hUsd: 25_000,
    tickSize: 0.01,
    minOrderSize: 1,
    ...overrides,
  };
}

function candidate(latestQ: number, opts: { spreadPp?: number; category?: string; signal?: Partial<PublishedSignalInput>; market?: Partial<MarketCatalogSnapshot>; yesMid?: number; noMid?: number } = {}): { candidate: NormalizedCandidate; yesBook: TokenBook; noBook: TokenBook } {
  const yesBook = book("yes-token", opts.yesMid ?? 0.5, opts.spreadPp ?? 2);
  const noBook = book("no-token", opts.noMid ?? 0.5, opts.spreadPp ?? 2);
  return {
    candidate: normalizeCandidate({
      signal: signal(latestQ, opts.signal),
      market: catalog(opts.category, opts.market),
      yesBook,
      noBook,
      volatility: { rv24Pp: 3, acceleration: 1 },
      stability: { validSince: NOW - 30_000, maxMoveAwayFromQPp: 1.99 },
    }, config),
    yesBook,
    noBook,
  };
}

function gates(latestQ: number, opts: Parameters<typeof candidate>[1] = {}) {
  const built = candidate(latestQ, opts);
  return gateCandidate(built.candidate, built.yesBook, built.noBook, { now: NOW }, config);
}

function inventory(outcome: "YES" | "NO" = "YES", overrides: Partial<InventoryCycle> = {}): InventoryCycle {
  return {
    marketKey: "polymarket:1",
    marketRef: "yes-token",
    conditionId: "condition-1",
    tokenId: outcome === "YES" ? "yes-token" : "no-token",
    outcome,
    freeQuantity: 25,
    reservedSellQuantity: 0,
    avgCost: 0.5,
    cashPaidUsd: 12.5,
    cashReceivedUsd: 0,
    firstFillAt: NOW,
    anchorQAsOf: NOW,
    anchorQSide: 0.8,
    anchorFillPrice: 0.5,
    initialEdgePp: 30,
    renewalUsed: false,
    urgentAttempts: 0,
    ...overrides,
  };
}

function trackedSell(orderId: string, overrides: Partial<TrackedOrder> = {}): TrackedOrder {
  return {
    orderId,
    clientId: orderId,
    marketKey: "polymarket:1",
    marketRef: "yes-token",
    conditionId: "condition-1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "SELL",
    size: 10,
    filledSize: 0,
    price: 0.49,
    tif: "FAK",
    postOnly: false,
    purpose: "urgent-exit",
    status: "LIVE",
    createdAt: NOW,
    ...overrides,
  };
}

function trackedBuy(orderId: string, overrides: Partial<TrackedOrder> = {}): TrackedOrder {
  return {
    orderId,
    clientId: orderId,
    marketKey: "polymarket:1",
    marketRef: "yes-token",
    conditionId: "condition-1",
    tokenId: "yes-token",
    outcome: "YES",
    side: "BUY",
    size: 25,
    filledSize: 0,
    price: 0.5,
    tif: "GTC",
    postOnly: true,
    purpose: "entry",
    status: "LIVE",
    createdAt: NOW,
    ...overrides,
  };
}

function stateWithSellReservations(): MarketMakeState {
  const state = createInitialMarketMakeState(config);
  state.markets["polymarket:1"] = {
    marketKey: "polymarket:1",
    inventory: inventory("YES", { freeQuantity: 40, reservedSellQuantity: 20 }),
    orders: {
      "sell-1": trackedSell("sell-1"),
      "sell-2": trackedSell("sell-2"),
    },
    inventoryIncreasingFillsByUtcDay: {},
    shockPausedUntil: 0,
  };
  return state;
}

function exitAt(hours: number, latestQ: number, inv = inventory(), signalOverrides: Partial<PublishedSignalInput> = {}) {
  const now = NOW + hours * 3_600_000;
  return evaluateExit({
    inventory: inv,
    signal: signal(latestQ, { qAsOf: now - 1_000, ...signalOverrides }),
    selectedBook: book(inv.tokenId, 0.5, 2, now),
    now,
  }, config);
}

function readyEvents(latestQ = 0.7): NormalizedMarketMakeEvent[] {
  return [
    { type: "catalog", ts: NOW, market: catalog() },
    { type: "signal", ts: NOW, signal: rawSignal(latestQ) },
    { type: "book", ts: NOW, marketKey: "polymarket:1", outcome: "YES", book: book("yes-token") },
    { type: "book", ts: NOW, marketKey: "polymarket:1", outcome: "NO", book: book("no-token") },
    { type: "volatility", ts: NOW, marketKey: "polymarket:1", volatility: { rv24Pp: 3, acceleration: 1 } },
    { type: "stability", ts: NOW, marketKey: "polymarket:1", stability: { validSince: NOW - 30_000, maxMoveAwayFromQPp: 0 } },
  ];
}

function reduceAll(events: NormalizedMarketMakeEvent[], activeConfig = config): { state: MarketMakeState; actions: ReturnType<typeof reduceMarketMake>["actions"] } {
  let state = createInitialMarketMakeState(activeConfig);
  const actions: ReturnType<typeof reduceMarketMake>["actions"] = [];
  for (const event of events) {
    const result = reduceMarketMake(state, event, activeConfig);
    state = result.state;
    actions.push(...result.actions);
  }
  return { state, actions };
}

describe("frozen config and units", () => {
  it("resolves the immutable source with directional renewal and liquidity overrides", () => {
    expect(MARKET_MAKE_SOURCE_SHA256).toHaveLength(64);
    expect(MARKET_MAKE_PRESET.cassie_overrides.renewal_min_edge_pp).toEqual({ NO: 10, YES: 20 });
    expect(MARKET_MAKE_PRESET.cassie_overrides.liquidity.minimum_exit_bid_depth_1c_usd).toBe(1_000);
    expect(MARKET_MAKE_PRESET.cassie_overrides.bankroll).toEqual({
      mode: "live",
      maximum_sizing_bankroll_usd: null,
    });
    expect(marketMakeConfigHash(config)).toBe(marketMakeConfigHash(createMarketMakeConfig()));
  });

  it("rejects 0..100 data in a 0..1 field", () => {
    expect(() => normalizePublishedSignal({ ...signal(0.6), entryQ: 60, latestQ: 60 })).toThrow(/unit error.*latestQ/);
    expect(() => normalizePublishedSignal({ ...signal(0.6), entryQ: 101 })).toThrow(/unit error.*entryQ/);
  });

  it("enforces the 30pp hard Q-market sanity ceiling in complete configs", () => {
    expect(() => createMarketMakeConfig({ eligibility: { q_market_edge_max_pp: 30.01 } })).toThrow(/30pp hard sanity ceiling/);
    expect(() => createMarketMakeConfig({ direction_policy: { NO: { maximum_edge_pp: 30.01 } } })).toThrow(/30pp hard sanity ceiling/);
    expect(() => createMarketMakeConfig({ direction_policy: { YES: { maximum_edge_pp: 30.01 } } })).toThrow(/30pp hard sanity ceiling/);
    expect(createMarketMakeConfig().eligibility.q_market_edge_max_pp).toBe(30);
  });

  it("uses funded strategy capital by default and honors an optional ceiling", () => {
    expect(effectiveMarketMakeBankrollUsd(config, 10_000)).toBe(10_000);
    const capped = createMarketMakeConfig({
      cassie_overrides: {
        bankroll: { mode: "live", maximum_sizing_bankroll_usd: 2_000 },
      },
    });
    expect(effectiveMarketMakeBankrollUsd(capped, 10_000)).toBe(2_000);
    expect(effectiveMarketMakeBankrollUsd(capped, 750)).toBe(750);
  });

  it("scales every dollar risk limit from the reference bankroll", () => {
    const scaled = marketMakeConfigForBankroll(config, 10_000);
    expect(scaled.capital.sizing_bankroll_usd).toBe(10_000);
    expect(scaled.capital.max_total_inventory_and_pending_entry_cost_usd).toBe(7_000);
    expect(scaled.capital.minimum_free_collateral_usd).toBe(2_000);
    expect(scaled.capital.operational_reserve_usd).toBe(1_000);
    expect(scaled.capital.base_order_notional_usd).toBe(250);
    expect(scaled.capital.max_order_notional_usd).toBe(400);
    expect(scaled.capital.hard_market_cost_usd).toBe(1_000);
    expect(scaled.direction_policy.NO.target_market_cost_usd).toBe(800);
    expect(scaled.direction_policy.YES.target_market_cost_usd).toBe(400);
    expect(scaled.portfolio_risk.max_event_cost_usd).toBe(1_200);
    expect(scaled.portfolio_risk.max_category_family_cost_usd).toBe(2_400);
    expect(scaled.portfolio_risk.max_manual_correlation_group_cost_usd).toBe(1_600);
    expect(scaled.loss_limits.max_marked_loss_per_market_usd).toBe(160);
    expect(scaled.loss_limits.max_rolling_24h_loss_usd).toBe(400);
    expect(scaled.loss_limits.max_strategy_drawdown_usd).toBe(800);
    expect(marketMakeConfigForBankroll(config, 0.01).capital.sizing_bankroll_usd).toBe(0.01);
    expect(marketMakeConfigForBankroll(config, 123.45).capital.base_order_notional_usd).toBeCloseTo(3.08625);
  });

  it("preserves literal limits in fixed mode", () => {
    const fixed = createMarketMakeConfig({
      cassie_overrides: { bankroll: { mode: "fixed", maximum_sizing_bankroll_usd: null } },
    });
    expect(effectiveMarketMakeBankrollUsd(fixed, 10_000)).toBe(500);
    expect(() => createMarketMakeConfig({
      cassie_overrides: { bankroll: { mode: "fixed", maximum_sizing_bankroll_usd: 1_000 } },
    })).toThrow(/ceiling applies only in live bankroll mode/);
  });

  it("accepts legacy redemption events and bounds public transaction references", () => {
    const base = {
      schemaVersion: "cassie-market-make-replay/1" as const,
      generatedAt: new Date(NOW).toISOString(),
      source: "schema-test",
    };
    expect(MarketMakeReplayBundleSchema.parse({
      ...base,
      events: [{ type: "redemption", ts: NOW, marketKey: "m", status: "confirmed" }],
    }).events).toHaveLength(1);
    expect(() => MarketMakeReplayBundleSchema.parse({
      ...base,
      events: [{ type: "redemption", ts: NOW, marketKey: "m", status: "submitted", reference: "tx\nsecret" }],
    })).toThrow(/printable ASCII/);
  });
});

describe("entry boundary gates", () => {
  it("passes NO 10.00pp and rejects 9.99pp", () => {
    expect(gates(0.4).passed).toBe(true);
    expect(gates(0.4001).reasons).toContain("edge-below-direction-min");
  });

  it("passes YES 20.00pp and rejects 19.99pp", () => {
    expect(gates(0.7).passed).toBe(true);
    expect(gates(0.6999).reasons).toContain("edge-below-direction-min");
  });

  it("passes 30.00pp and rejects 30.01pp", () => {
    expect(gates(0.8).passed).toBe(true);
    expect(gates(0.8001).reasons).toContain("edge-above-direction-max");
  });

  it("passes a 4.00pp token spread and rejects 4.01pp", () => {
    expect(gates(0.7, { spreadPp: 4 }).passed).toBe(true);
    expect(gates(0.7, { spreadPp: 4.01 }).reasons).toContain("book-spread-operational");
    expect(gates(0.7, { spreadPp: 30.01 }).reasons).toContain("book-spread-hard-sanity");
  });

  it("requires strict stability and fresh Q/CLOB data", () => {
    const atTwo = candidate(0.7);
    atTwo.candidate.stability.maxMoveAwayFromQPp = 2;
    expect(gateCandidate(atTwo.candidate, atTwo.yesBook, atTwo.noBook, { now: NOW }, config).reasons).toContain("entry-moved-away-from-q");
    expect(gates(0.7, { signal: { qAsOf: NOW - 21_600_001 } }).reasons).toContain("q-stale");
    expect(gates(0.7, { signal: { qAsOf: NOW }, yesMid: 0.5101, noMid: 0.5101 }).reasons).toContain("yes-no-complement-error");
    const mapped = candidate(0.7);
    mapped.yesBook.tokenId = "wrong-token";
    expect(gateCandidate(mapped.candidate, mapped.yesBook, mapped.noBook, { now: NOW }, config).reasons).toContain("token-mapping-mismatch");
  });

  it("is economically symmetric under YES/NO plus q -> 1-q before size multiplier", () => {
    const bullish = candidate(0.7).candidate;
    const bearish = candidate(0.3).candidate;
    expect(bullish.side).toBe("YES");
    expect(bearish.side).toBe("NO");
    expect(bearish.qSide).toBeCloseTo(bullish.qSide);
    expect(bearish.liveEdgePp).toBeCloseTo(bullish.liveEdgePp);
  });

  it("does not let a reward bypass a failed edge gate", () => {
    const rewarded = candidate(0.6, { market: { rewardRateUsd: 1_000_000 } });
    const result = gateCandidate(rewarded.candidate, rewarded.yesBook, rewarded.noBook, { now: NOW }, config);
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain("edge-below-direction-min");
  });
});

describe("liquidity participation and quote formulas", () => {
  it("sets $20 order and $40 market caps at the minimum depths", () => {
    const caps = liquidityParticipationCaps(1_000, 2_500, 100, 100, config);
    expect(caps.orderCapUsd).toBe(20);
    expect(caps.marketCapUsd).toBe(40);
  });

  it("requires at least $20k/$50k depth to support a $400 order", () => {
    expect(liquidityParticipationCaps(20_000, 50_000, 500, 1_000, config).orderCapUsd).toBe(400);
    expect(liquidityParticipationCaps(19_999, 50_000, 500, 1_000, config).orderCapUsd).toBeLessThan(400);
    expect(liquidityParticipationCaps(20_000, 49_999, 500, 1_000, config).orderCapUsd).toBeLessThan(400);
  });

  it("cancels a scaled resting entry when refreshed depth no longer supports it", () => {
    const scaled = createMarketMakeConfig({
      capital: {
        initial_bankroll_usd: 10_000,
        sizing_bankroll_usd: 10_000,
        max_total_inventory_and_pending_entry_cost_usd: 7_000,
        minimum_free_collateral_usd: 2_000,
        operational_reserve_usd: 1_000,
        base_order_notional_usd: 250,
        max_order_notional_usd: 400,
        hard_market_cost_usd: 1_000,
      },
      direction_policy: {
        NO: { target_market_cost_usd: 800 },
        YES: { target_market_cost_usd: 400 },
      },
      portfolio_risk: {
        max_event_cost_usd: 1_200,
        max_category_family_cost_usd: 2_400,
        max_manual_correlation_group_cost_usd: 1_600,
      },
    });
    const deepBook = (tokenId: string): TokenBook => ({
      tokenId,
      bids: [
        { price: 0.49, size: 20_000 / 0.49 },
        { price: 0.47, size: 30_000 / 0.47 },
      ],
      asks: [{ price: 0.51, size: 100_000 }],
      ts: NOW,
    });
    const events = readyEvents().map((event): NormalizedMarketMakeEvent =>
      event.type === "book" ? { ...event, book: deepBook(event.book.tokenId) } : event);
    const ready = reduceAll(events, scaled);
    const entry = ready.actions.find((action) => action.kind === "place" && action.purpose === "entry");
    if (!entry || entry.kind !== "place") throw new Error("expected scaled entry");
    expect(entry.size * entry.limitPrice).toBeCloseTo(125);

    const thinButEligible: TokenBook = {
      tokenId: "yes-token",
      bids: [
        { price: 0.49, size: 1_000 / 0.49 },
        { price: 0.47, size: 1_500 / 0.47 },
      ],
      asks: [{ price: 0.51, size: 100_000 }],
      ts: NOW + 1_000,
    };
    const refreshed = reduceMarketMake(ready.state, {
      type: "book",
      ts: NOW + 1_000,
      marketKey: entry.marketKey,
      outcome: "YES",
      book: thinButEligible,
    }, scaled);
    expect(refreshed.actions).toContainEqual(expect.objectContaining({
      kind: "cancel",
      orderId: entry.clientId,
      reason: expect.stringContaining("refreshed 1c/2c order participation cap"),
    }));
  });

  it("applies beta, center-shift, competitive, and edge caps deterministically", () => {
    const built = candidate(0.7).candidate;
    const quote = buildEntryQuote(built, {
      globalRemainingUsd: 350,
      marketCommittedUsd: 0,
      eventRemainingUsd: 60,
      familyRemainingUsd: 120,
      correlationRemainingUsd: 80,
    }, config);
    expect(quote?.price).toBeCloseTo(0.5);
    expect(quote?.requestedUsd).toBeCloseTo(6.25);
    expect(quote?.notionalUsd).toBeCloseTo(6.25);
  });

  it("never sells more than free unreserved inventory", () => {
    expect(freeSellQuantity(10, 4, 20)).toBe(6);
    expect(freeSellQuantity(3, 4, 20)).toBe(0);
  });
});

describe("allocation", () => {
  it("selects missing families first, then fills by NO/edge priority", () => {
    const international = candidate(0.2, { category: "Geopolitics", market: { marketKey: "m-int", nativeMarketId: "int", conditionId: "c-int", marketRef: "r-int", eventId: "e-int", yesTokenId: "yes-token", noTokenId: "no-token" }, signal: { marketKey: "m-int", nativeMarketId: "int", conditionId: "c-int" } }).candidate;
    const domestic = candidate(0.2, { category: "Legal", market: { marketKey: "m-dom", nativeMarketId: "dom", conditionId: "c-dom", marketRef: "r-dom", eventId: "e-dom", yesTokenId: "yes-token", noTokenId: "no-token" }, signal: { marketKey: "m-dom", nativeMarketId: "dom", conditionId: "c-dom" } }).candidate;
    const culture = candidate(0.7, { category: "Sports", market: { marketKey: "m-cult", nativeMarketId: "cult", conditionId: "c-cult", marketRef: "r-cult", eventId: "e-cult", yesTokenId: "yes-token", noTokenId: "no-token" }, signal: { marketKey: "m-cult", nativeMarketId: "cult", conditionId: "c-cult" } }).candidate;
    const chosen = allocateCandidates([international, domestic, culture], new Set(), 2, config);
    expect(new Set(chosen.map((row) => row.categoryFamily)).size).toBe(2);
    expect(chosen[0]?.side).toBe("NO");
  });
});

describe("exit state machine", () => {
  it("does not exit at six hours and exits at 24h without a qualifying renewal", () => {
    expect(exitAt(6, 0.8).urgency).toBe("none");
    expect(exitAt(24, 0.65).urgency).toBe("normal");
  });

  it("renews once at direction-specific edge thresholds and never past 36h", () => {
    const yesRenewal = exitAt(24, 0.7);
    expect(yesRenewal.renewal?.extensionUntil).toBe(NOW + 36 * 3_600_000);
    expect(exitAt(24, 0.6999).renewal).toBeUndefined();
    const noInv = inventory("NO", { anchorQSide: 0.6, initialEdgePp: 10 });
    expect(exitAt(24, 0.4, noInv).renewal).toBeDefined();
    expect(exitAt(36, 0.8).urgency).toBe("urgent");
  });

  it("exits on convergence, captured first-fill gap, staleness, and Q flip/fade", () => {
    expect(exitAt(1, 0.55).urgency).toBe("normal");
    expect(exitAt(1, 0.575).capturedFraction).toBeGreaterThanOrEqual(0.75);
    expect(exitAt(18, 0.8, inventory(), { qAsOf: NOW }).reason).toMatch(/stale/);
    expect(exitAt(1, 0.4).urgency).toBe("urgent");
    expect(exitAt(1, 0.8, inventory(), { retiredReason: "fading_q" }).urgency).toBe("urgent");
  });
});

describe("shared reducer invariants", () => {
  it("updates a repeated signal in one market without proposing a second entry", () => {
    const ready = reduceAll(readyEvents());
    expect(ready.actions.filter((action) => action.kind === "place" && action.purpose === "entry")).toHaveLength(1);
    const repeated = reduceMarketMake(ready.state, { type: "signal", ts: NOW + 1_000, signal: rawSignal(0.71, { id: "sig-2", qAsOf: NOW + 1_000 }) }, config);
    expect(Object.keys(repeated.state.markets)).toEqual(["polymarket:1"]);
    expect(repeated.actions.filter((action) => action.kind === "place" && action.purpose === "entry")).toHaveLength(0);
  });

  it("anchors convergence to first actual fill and never resets it on a later Q", () => {
    const ready = reduceAll(readyEvents());
    const entry = ready.actions.find((action) => action.kind === "place" && action.purpose === "entry");
    if (!entry || entry.kind !== "place") throw new Error("expected entry");
    const filled = reduceMarketMake(ready.state, {
      type: "fill", ts: NOW + 1_000, fillId: "fill-1", orderId: entry.clientId, marketKey: entry.marketKey,
      tokenId: entry.tokenId, outcome: entry.outcome, side: "BUY", size: entry.size, price: 0.49,
    }, config);
    const anchor = filled.state.markets[entry.marketKey]?.inventory;
    expect(anchor?.anchorFillPrice).toBe(0.49);
    expect(anchor?.anchorQSide).toBe(0.7);
    expect(anchor?.initialEdgePp).toBeCloseTo(21);
    const updated = reduceMarketMake(filled.state, { type: "signal", ts: NOW + 2_000, signal: rawSignal(0.72, { id: "sig-2", qAsOf: NOW + 2_000 }) }, config);
    expect(updated.state.markets[entry.marketKey]?.inventory?.anchorQSide).toBe(0.7);
  });

  it("requires a newer stable same-side Q before topping up inventory", () => {
    const ready = reduceAll(readyEvents());
    const entry = ready.actions.find((action) => action.kind === "place" && action.purpose === "entry");
    if (!entry || entry.kind !== "place") throw new Error("expected entry");
    const filled = reduceMarketMake(ready.state, {
      type: "fill", ts: NOW + 1_000, fillId: "fill-top-up", orderId: entry.clientId, marketKey: entry.marketKey,
      tokenId: entry.tokenId, outcome: entry.outcome, side: "BUY", size: entry.size, price: entry.limitPrice,
    }, config);

    const sameQ = reduceMarketMake(filled.state, { type: "timer", ts: NOW + 31_000 }, config);
    expect(sameQ.actions.some((action) => action.kind === "place" && action.purpose === "entry")).toBe(false);
    expect(sameQ.decisions.some((decision) => decision.reasons.includes("awaiting-newer-same-side-q"))).toBe(true);

    const refreshed = reduceMarketMake(sameQ.state, {
      type: "signal",
      ts: NOW + 32_000,
      signal: rawSignal(0.72, { id: "sig-new", qAsOf: NOW + 32_000 }),
    }, config);
    expect(refreshed.actions.some((action) => action.kind === "place" && action.purpose === "entry")).toBe(false);
    expect(refreshed.state.markets[entry.marketKey]?.stability).toBeUndefined();

    const freshYes = reduceMarketMake(refreshed.state, {
      type: "book",
      ts: NOW + 62_000,
      marketKey: entry.marketKey,
      outcome: "YES",
      book: book("yes-token", 0.5, 2, NOW + 62_000),
    }, config);
    const freshBooks = reduceMarketMake(freshYes.state, {
      type: "book",
      ts: NOW + 62_000,
      marketKey: entry.marketKey,
      outcome: "NO",
      book: book("no-token", 0.5, 2, NOW + 62_000),
    }, config);
    const stable = reduceMarketMake(freshBooks.state, {
      type: "stability",
      ts: NOW + 63_000,
      marketKey: entry.marketKey,
      stability: { validSince: NOW + 32_000, maxMoveAwayFromQPp: 0 },
    }, config);
    expect(stable.actions.some((action) => action.kind === "place" && action.purpose === "entry")).toBe(true);
  });

  it("never adds inventory after an exit cycle has started", () => {
    const ready = reduceAll(readyEvents());
    const entry = ready.actions.find((action) => action.kind === "place" && action.purpose === "entry");
    if (!entry || entry.kind !== "place") throw new Error("expected entry");
    const filled = reduceMarketMake(ready.state, {
      type: "fill",
      ts: NOW + 1_000,
      fillId: "fill-before-exit",
      orderId: entry.clientId,
      marketKey: entry.marketKey,
      tokenId: entry.tokenId,
      outcome: entry.outcome,
      side: "BUY",
      size: entry.size,
      price: entry.limitPrice,
    }, config);
    const market = filled.state.markets[entry.marketKey]!;
    market.signal = signal(0.72, { id: "sig-after-exit", qAsOf: NOW + 32_000 });
    market.yesBook = book("yes-token", 0.5, 2, NOW + 63_000);
    market.noBook = book("no-token", 0.5, 2, NOW + 63_000);
    market.inventory = {
      ...market.inventory!,
      reservedSellQuantity: 5,
      exitStartedAt: NOW + 2_000,
      exitUrgency: "normal",
    };
    market.orders["exit-1"] = trackedSell("exit-1", {
      size: 5,
      price: 0.51,
      tif: "GTC",
      postOnly: true,
      purpose: "normal-exit",
      status: "LIVE",
      createdAt: NOW + 2_000,
    });

    const stable = reduceMarketMake(filled.state, {
      type: "stability",
      ts: NOW + 63_000,
      marketKey: entry.marketKey,
      stability: { validSince: NOW + 32_000, maxMoveAwayFromQPp: 0 },
    }, config);
    expect(stable.actions.some((action) => action.kind === "place" && action.side === "BUY")).toBe(false);
    expect(stable.decisions).toContainEqual(expect.objectContaining({
      marketKey: entry.marketKey,
      decision: "entry-rejected",
      reasons: expect.arrayContaining(["inventory-exit-in-progress"]),
    }));
  });

  it("deduplicates fills and keeps cancel-pending entry exposure reserved", () => {
    const ready = reduceAll(readyEvents());
    const entry = ready.actions.find((action) => action.kind === "place" && action.purpose === "entry");
    if (!entry || entry.kind !== "place") throw new Error("expected entry");
    const partialEvent: NormalizedMarketMakeEvent = {
      type: "fill", ts: NOW + 1_000, fillId: "fill-partial", orderId: entry.clientId, marketKey: entry.marketKey,
      tokenId: entry.tokenId, outcome: entry.outcome, side: "BUY", size: entry.size / 2, price: entry.limitPrice,
    };
    const once = reduceMarketMake(ready.state, partialEvent, config);
    const twice = reduceMarketMake(once.state, partialEvent, config);
    expect(twice.state.markets[entry.marketKey]?.inventory?.freeQuantity).toBeCloseTo(entry.size / 2);
    expect(once.state.markets[entry.marketKey]?.orders[entry.clientId]?.status).toBe("CANCEL_PENDING");
    expect(marketCommittedUsd(once.state.markets[entry.marketKey]!)).toBeCloseTo(entry.size * entry.limitPrice);
  });

  it("accepts a fill racing a cancel and keeps the terminal order filled", () => {
    const ready = reduceAll(readyEvents());
    const entry = ready.actions.find((action) => action.kind === "place" && action.purpose === "entry");
    if (!entry || entry.kind !== "place") throw new Error("expected entry");
    const half = entry.size / 2;
    const partial = reduceMarketMake(ready.state, {
      type: "fill", ts: NOW + 1_000, fillId: "race-1", orderId: entry.clientId, marketKey: entry.marketKey,
      tokenId: entry.tokenId, outcome: entry.outcome, side: "BUY", size: half, price: entry.limitPrice,
    }, config);
    const raced = reduceMarketMake(partial.state, {
      type: "fill", ts: NOW + 2_000, fillId: "race-2", orderId: entry.clientId, marketKey: entry.marketKey,
      tokenId: entry.tokenId, outcome: entry.outcome, side: "BUY", size: half, price: entry.limitPrice,
    }, config);
    const canceled = reduceMarketMake(raced.state, { type: "cancel-confirmed", ts: NOW + 3_000, marketKey: entry.marketKey, orderId: entry.clientId }, config);
    expect(canceled.state.markets[entry.marketKey]?.inventory?.freeQuantity).toBeCloseTo(entry.size);
    expect(canceled.state.markets[entry.marketKey]?.orders[entry.clientId]?.status).toBe("FILLED");
  });

  it("does not immediately replace rejected or canceled entry orders", () => {
    const ready = reduceAll(readyEvents());
    const entry = ready.actions.find((action) => action.kind === "place" && action.purpose === "entry");
    if (!entry || entry.kind !== "place") throw new Error("expected entry");

    const rejected = reduceMarketMake(ready.state, {
      type: "order",
      ts: NOW + 1_000,
      marketKey: entry.marketKey,
      order: {
        ...ready.state.markets[entry.marketKey]!.orders[entry.clientId]!,
        status: "REJECTED",
      },
    }, config);
    expect(rejected.actions.some((action) => action.kind === "place" && action.purpose === "entry")).toBe(false);

    const canceled = reduceMarketMake(ready.state, {
      type: "cancel-confirmed",
      ts: NOW + 2_000,
      marketKey: entry.marketKey,
      orderId: entry.clientId,
    }, config);
    expect(canceled.actions.some((action) => action.kind === "place" && action.purpose === "entry")).toBe(false);
  });

  it("treats a catalog refresh as cancellation-only until another entry input event", () => {
    const ready = reduceAll(readyEvents());
    const entry = ready.actions.find((action) => action.kind === "place" && action.purpose === "entry");
    if (!entry || entry.kind !== "place") throw new Error("expected entry");
    const canceled = reduceMarketMake(ready.state, {
      type: "cancel-confirmed",
      ts: NOW + 500,
      marketKey: entry.marketKey,
      orderId: entry.clientId,
    }, config);
    const refreshed = reduceMarketMake(canceled.state, {
      type: "catalog",
      ts: NOW + 1_000,
      market: catalog(),
    }, config);
    expect(refreshed.actions.some((action) => action.kind === "place" && action.purpose === "entry")).toBe(false);
    expect(refreshed.decisions).toContainEqual(expect.objectContaining({
      marketKey: entry.marketKey,
      decision: "entry-deferred",
      reasons: ["catalog-refresh-cancellation-only"],
    }));
  });

  it("cancels a resting entry as soon as Q or the selected quote is stale", () => {
    const ready = reduceAll(readyEvents());
    const stale = reduceMarketMake(ready.state, { type: "timer", ts: NOW + 6_000 }, config);
    expect(stale.actions.some((action) => action.kind === "cancel" && action.reason.includes("stale"))).toBe(true);
    expect(stale.actions.some((action) => action.kind === "place" && action.side === "BUY")).toBe(false);
  });

  it("subtracts its own resting bid before rechecking external liquidity", () => {
    const ready = reduceAll(readyEvents());
    const entry = ready.actions.find((action) => action.kind === "place" && action.purpose === "entry");
    if (!entry || entry.kind !== "place") throw new Error("expected entry");
    const tracked = ready.state.markets[entry.marketKey]!.orders[entry.clientId]!;
    const acknowledged = reduceMarketMake(ready.state, {
      type: "order",
      ts: NOW + 500,
      marketKey: entry.marketKey,
      order: { ...tracked, status: "LIVE" },
    }, config);
    const withOwnBid: TokenBook = {
      tokenId: entry.tokenId,
      bids: [
        { price: entry.limitPrice, size: entry.size },
        { price: 0.49, size: 1_100 / 0.49 },
        { price: 0.47, size: 1_600 / 0.47 },
      ],
      asks: [{ price: 0.51, size: 10_000 }],
      ts: NOW + 1_000,
    };
    const refreshed = reduceMarketMake(acknowledged.state, {
      type: "book",
      ts: NOW + 1_000,
      marketKey: entry.marketKey,
      outcome: entry.outcome,
      book: withOwnBid,
    }, config);
    expect(refreshed.actions).not.toContainEqual(expect.objectContaining({
      kind: "cancel",
      orderId: entry.clientId,
    }));
    expect(refreshed.decisions).toContainEqual(expect.objectContaining({
      marketKey: entry.marketKey,
      decision: "entry-resting",
    }));
  });

  it("includes cancel-pending entries in event and family caps", () => {
    const ready = reduceAll(readyEvents());
    const shocked = reduceMarketMake(ready.state, { type: "shock", ts: NOW + 1_000, marketKey: "polymarket:1", adverse: true, reason: "test" }, config);
    const tight = createMarketMakeConfig({ portfolio_risk: { max_event_cost_usd: 6, max_category_family_cost_usd: 6 } });
    const exposure = portfolioExposure(shocked.state, tight);
    expect(exposure.totalUsd).toBeGreaterThan(0);
    const second = candidate(0.2, {
      category: "Geopolitics",
      market: { marketKey: "polymarket:2", nativeMarketId: "2", conditionId: "condition-2", marketRef: "yes-2", eventId: "event-1", yesTokenId: "yes-token", noTokenId: "no-token" },
      signal: { marketKey: "polymarket:2", nativeMarketId: "2", conditionId: "condition-2" },
    }).candidate;
    const reasons = candidateCapReasons(second, exposure, tight);
    expect(reasons).toContain("one-market-per-event");
    expect(reasons).toContain("category-family-cap");
  });

  it("honors a configured two-market-per-event limit instead of hard-coding one", () => {
    const ready = reduceAll(readyEvents());
    const twoPerEvent = createMarketMakeConfig({ portfolio_risk: { max_open_markets_per_event: 2 } });
    const exposure = portfolioExposure(ready.state, twoPerEvent);
    const second = candidate(0.2, {
      market: {
        marketKey: "polymarket:2",
        nativeMarketId: "2",
        conditionId: "condition-2",
        marketRef: "yes-2",
        eventId: "event-1",
      },
      signal: { marketKey: "polymarket:2", nativeMarketId: "2", conditionId: "condition-2" },
    }).candidate;
    expect(candidateCapReasons(second, exposure, twoPerEvent)).not.toContain("max-open-markets-per-event");
  });

  it("blocks a top-up when refreshed metadata puts existing markets over the event-count cap", () => {
    const ready = reduceAll(readyEvents());
    ready.state.markets["polymarket:2"] = {
      marketKey: "polymarket:2",
      catalog: catalog("Legal", {
        marketKey: "polymarket:2",
        nativeMarketId: "2",
        conditionId: "condition-2",
        marketRef: "yes-2",
        eventId: "event-1",
        yesTokenId: "yes-2",
        noTokenId: "no-2",
      }),
      inventory: inventory("YES", {
        marketKey: "polymarket:2",
        marketRef: "yes-2",
        conditionId: "condition-2",
        tokenId: "yes-2",
      }),
      orders: {},
      inventoryIncreasingFillsByUtcDay: {},
      shockPausedUntil: 0,
    };
    const exposure = portfolioExposure(ready.state, config);
    expect(exposure.eventMarketCounts["event-1"]).toBe(2);
    expect(candidateCapReasons(candidate(0.7).candidate, exposure, config)).toContain("one-market-per-event");
  });

  it("cancels resting adds when refreshed Gamma metadata moves them over an event cap", () => {
    const ready = reduceAll(readyEvents());
    const first = ready.state.markets["polymarket:1"]!;
    const firstOrder = Object.values(first.orders)[0]!;
    const secondOrder = trackedBuy("second-entry", {
      marketKey: "polymarket:2",
      marketRef: "yes-2",
      conditionId: "condition-2",
      tokenId: "yes-2",
      size: firstOrder.size,
      price: firstOrder.price,
      qAsOfAtPlacement: firstOrder.qAsOfAtPlacement,
      qSideAtPlacement: firstOrder.qSideAtPlacement,
      bestBidAtPlacement: firstOrder.bestBidAtPlacement,
      status: "PLANNED",
    });
    ready.state.markets["polymarket:2"] = {
      ...structuredClone(first),
      marketKey: "polymarket:2",
      signal: { ...first.signal!, id: "sig-2", marketKey: "polymarket:2", nativeMarketId: "2", conditionId: "condition-2" },
      catalog: catalog("Legal", {
        marketKey: "polymarket:2",
        nativeMarketId: "2",
        conditionId: "condition-2",
        marketRef: "yes-2",
        eventId: "event-2",
        yesTokenId: "yes-2",
        noTokenId: "no-2",
      }),
      yesBook: { ...first.yesBook!, tokenId: "yes-2" },
      noBook: { ...first.noBook!, tokenId: "no-2" },
      orders: { "second-entry": secondOrder },
    };

    const reclassified = reduceMarketMake(ready.state, {
      type: "catalog",
      ts: NOW + 1_000,
      market: catalog("Legal", {
        marketKey: "polymarket:2",
        nativeMarketId: "2",
        conditionId: "condition-2",
        marketRef: "yes-2",
        eventId: "event-1",
        yesTokenId: "yes-2",
        noTokenId: "no-2",
      }),
    }, config);
    expect(reclassified.actions).toContainEqual(expect.objectContaining({
      kind: "cancel",
      orderId: "second-entry",
      reason: expect.stringContaining("event market count exceeds cap"),
    }));
  });

  it("cancels every other add when a delayed canceled-order fill breaches a hard cap", () => {
    const tight = createMarketMakeConfig({
      capital: { max_total_inventory_and_pending_entry_cost_usd: 20 },
    });
    const state = createInitialMarketMakeState(tight);
    state.markets["polymarket:1"] = {
      marketKey: "polymarket:1",
      catalog: catalog(),
      orders: {
        late: trackedBuy("late", { status: "CANCELED", size: 20 }),
      },
      inventoryIncreasingFillsByUtcDay: {},
      shockPausedUntil: 0,
    };
    state.markets["polymarket:2"] = {
      marketKey: "polymarket:2",
      catalog: catalog("Legal", {
        marketKey: "polymarket:2",
        nativeMarketId: "2",
        conditionId: "condition-2",
        marketRef: "yes-2",
        eventId: "event-2",
        yesTokenId: "yes-2",
        noTokenId: "no-2",
      }),
      orders: {
        other: trackedBuy("other", {
          marketKey: "polymarket:2",
          marketRef: "yes-2",
          conditionId: "condition-2",
          tokenId: "yes-2",
        }),
      },
      inventoryIncreasingFillsByUtcDay: {},
      shockPausedUntil: 0,
    };

    const filled = reduceMarketMake(state, {
      type: "fill",
      ts: NOW + 1_000,
      fillId: "late-after-cancel",
      orderId: "late",
      marketKey: "polymarket:1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "BUY",
      size: 20,
      price: 0.5,
    }, tight);
    expect(filled.state.markets["polymarket:2"]?.orders.other?.status).toBe("CANCEL_PENDING");
    expect(filled.state.halted).toBe(true);
    expect(filled.actions).toContainEqual(expect.objectContaining({
      kind: "cancel",
      orderId: "other",
      reason: expect.stringContaining("post-fill hard-cap breach"),
    }));
    expect(filled.decisions).toContainEqual(expect.objectContaining({
      decision: "post-fill-hard-cap-breach",
      reasons: expect.arrayContaining(["deployment-cap"]),
    }));
  });

  it("a shock cancels adds and never increases inventory", () => {
    const ready = reduceAll(readyEvents());
    const before = ready.state.markets["polymarket:1"]?.inventory?.freeQuantity ?? 0;
    const shocked = reduceMarketMake(ready.state, { type: "shock", ts: NOW + 1_000, marketKey: "polymarket:1", adverse: true, reason: "5m adverse move" }, config);
    expect(shocked.actions.some((action) => action.kind === "cancel")).toBe(true);
    expect(shocked.actions.some((action) => action.kind === "place" && action.side === "BUY")).toBe(false);
    expect(shocked.state.markets["polymarket:1"]?.inventory?.freeQuantity ?? 0).toBe(before);
    expect(evaluateShock({ move60sPp: 5, move5mPp: 0, move15mPp: 0, spreadMultipleVs5mMedian: 1, depthDropFraction60s: 0, adverse: false }, config).shocked).toBe(true);
  });

  it("three distinct correlated shocks start the configured global entry pause", () => {
    let state = createInitialMarketMakeState(config);
    for (const [index, marketKey] of ["m1", "m2", "m3"].entries()) {
      state = reduceMarketMake(state, { type: "shock", ts: NOW + index * 1_000, marketKey, adverse: true, reason: "correlated" }, config).state;
    }
    expect(state.globalEntryPausedUntil).toBe(NOW + 2_000 + 600_000);
  });

  it("a reward event cannot create or enlarge an order", () => {
    const ready = reduceAll(readyEvents());
    const rewarded = reduceMarketMake(ready.state, { type: "reward", ts: NOW + 1_000, marketKey: "polymarket:1", amountUsd: 1_000_000 }, config);
    expect(rewarded.actions.filter((action) => action.kind === "place")).toHaveLength(0);
  });
});

describe("terminal sell reservation accounting", () => {
  it("preserves settlement telemetry across redemption states and clears inventory only on confirmation", () => {
    const state = createInitialMarketMakeState(config);
    state.markets["polymarket:1"] = {
      marketKey: "polymarket:1",
      inventory: inventory(),
      orders: {},
      inventoryIncreasingFillsByUtcDay: {},
      shockPausedUntil: 0,
    };
    const submitted = reduceMarketMake(state, {
      type: "redemption",
      ts: NOW,
      marketKey: "polymarket:1",
      status: "submitted",
      quantity: 25,
      payoutUsd: 25,
      reference: "0xsettled",
    }, config);
    expect(submitted.state.markets["polymarket:1"]?.inventory).toBeDefined();
    expect(submitted.state.markets["polymarket:1"]?.redemption).toMatchObject({
      status: "submitted",
      attempts: 1,
      quantity: 25,
      payoutUsd: 25,
      reference: "0xsettled",
    });

    const failed = reduceMarketMake(submitted.state, {
      type: "redemption",
      ts: NOW + 1_000,
      marketKey: "polymarket:1",
      status: "failed",
      error: "pre-submit failure",
    }, config);
    expect(failed.state.markets["polymarket:1"]?.inventory).toBeDefined();
    expect(failed.state.markets["polymarket:1"]?.redemption).toMatchObject({
      status: "failed",
      quantity: 25,
      payoutUsd: 25,
      reference: "0xsettled",
    });

    const confirmed = reduceMarketMake(failed.state, {
      type: "redemption",
      ts: NOW + 2_000,
      marketKey: "polymarket:1",
      status: "confirmed",
    }, config);
    expect(confirmed.state.markets["polymarket:1"]?.inventory).toBeUndefined();
    expect(confirmed.state.markets["polymarket:1"]?.redemption).toMatchObject({
      status: "confirmed",
      quantity: 25,
      payoutUsd: 25,
      reference: "0xsettled",
    });
  });

  it.each(["CANCELED", "REJECTED", "FILLED"] as const)(
    "releases a %s order's remainder once and keeps terminal feedback monotonic",
    (terminalStatus) => {
      const state = stateWithSellReservations();
      const original = state.markets["polymarket:1"]!.orders["sell-1"]!;
      const terminalOrder: TrackedOrder = {
        ...original,
        status: terminalStatus,
        filledSize: terminalStatus === "FILLED" ? original.size : original.filledSize,
      };
      const once = reduceMarketMake(state, {
        type: "order",
        ts: NOW + 1_000,
        marketKey: "polymarket:1",
        order: terminalOrder,
      }, config);
      expect(once.state.markets["polymarket:1"]?.inventory?.reservedSellQuantity).toBe(10);

      const duplicate = reduceMarketMake(once.state, {
        type: "order",
        ts: NOW + 2_000,
        marketKey: "polymarket:1",
        order: terminalOrder,
      }, config);
      expect(duplicate.state.markets["polymarket:1"]?.inventory?.reservedSellQuantity).toBe(10);

      const staleLive = reduceMarketMake(duplicate.state, {
        type: "order",
        ts: NOW + 3_000,
        marketKey: "polymarket:1",
        order: original,
      }, config);
      expect(staleLive.state.markets["polymarket:1"]?.orders["sell-1"]?.status).toBe(terminalStatus);
      const terminalAgain = reduceMarketMake(staleLive.state, {
        type: "order",
        ts: NOW + 4_000,
        marketKey: "polymarket:1",
        order: terminalOrder,
      }, config);
      expect(terminalAgain.state.markets["polymarket:1"]?.inventory?.reservedSellQuantity).toBe(10);
    },
  );

  it("releases only the unfilled remainder after a partial fill and ignores duplicate cancels", () => {
    const state = stateWithSellReservations();
    const partial = reduceMarketMake(state, {
      type: "fill",
      ts: NOW + 1_000,
      fillId: "sell-partial",
      orderId: "sell-1",
      marketKey: "polymarket:1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "SELL",
      size: 4,
      price: 0.49,
    }, config);
    expect(partial.state.markets["polymarket:1"]?.inventory?.freeQuantity).toBe(36);
    expect(partial.state.markets["polymarket:1"]?.inventory?.reservedSellQuantity).toBe(16);

    const canceled = reduceMarketMake(partial.state, {
      type: "cancel-confirmed",
      ts: NOW + 2_000,
      marketKey: "polymarket:1",
      orderId: "sell-1",
    }, config);
    expect(canceled.state.markets["polymarket:1"]?.inventory?.reservedSellQuantity).toBe(10);
    const duplicate = reduceMarketMake(canceled.state, {
      type: "cancel-confirmed",
      ts: NOW + 3_000,
      marketKey: "polymarket:1",
      orderId: "sell-1",
    }, config);
    expect(duplicate.state.markets["polymarket:1"]?.inventory?.reservedSellQuantity).toBe(10);
  });

  it("does not consume another FAK's reservation when a late fill races a rejection", () => {
    const state = stateWithSellReservations();
    const rejectedOrder: TrackedOrder = {
      ...state.markets["polymarket:1"]!.orders["sell-1"]!,
      status: "REJECTED",
    };
    const rejected = reduceMarketMake(state, {
      type: "order",
      ts: NOW + 1_000,
      marketKey: "polymarket:1",
      order: rejectedOrder,
    }, config);
    expect(rejected.state.markets["polymarket:1"]?.inventory?.reservedSellQuantity).toBe(10);

    const racedFill = reduceMarketMake(rejected.state, {
      type: "fill",
      ts: NOW + 2_000,
      fillId: "late-fak-fill",
      orderId: "sell-1",
      marketKey: "polymarket:1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "SELL",
      size: 4,
      price: 0.49,
    }, config);
    expect(racedFill.state.markets["polymarket:1"]?.inventory?.freeQuantity).toBe(36);
    expect(racedFill.state.markets["polymarket:1"]?.inventory?.reservedSellQuantity).toBe(10);
    expect(racedFill.state.markets["polymarket:1"]?.orders["sell-1"]?.status).toBe("REJECTED");

    const duplicateReject = reduceMarketMake(racedFill.state, {
      type: "order",
      ts: NOW + 3_000,
      marketKey: "polymarket:1",
      order: rejectedOrder,
    }, config);
    expect(duplicateReject.state.markets["polymarket:1"]?.inventory?.reservedSellQuantity).toBe(10);
    expect(duplicateReject.state.markets["polymarket:1"]?.orders["sell-1"]?.filledSize).toBe(4);
  });

  it("defers a rejected FAK replacement until a decision-driving event", () => {
    const state = createInitialMarketMakeState(config);
    const working = trackedSell("urgent-fak");
    state.markets["polymarket:1"] = {
      marketKey: "polymarket:1",
      signal: signal(0.4),
      catalog: catalog(),
      yesBook: book("yes-token"),
      noBook: book("no-token"),
      inventory: inventory("YES", {
        freeQuantity: 10,
        reservedSellQuantity: 10,
        exitStartedAt: NOW - 61_000,
        exitUrgency: "urgent",
        urgentAttempts: 1,
      }),
      orders: { "urgent-fak": working },
      inventoryIncreasingFillsByUtcDay: {},
      shockPausedUntil: 0,
    };

    const rejected = reduceMarketMake(state, {
      type: "order",
      ts: NOW + 1_000,
      marketKey: "polymarket:1",
      order: { ...working, status: "REJECTED" },
    }, config);
    expect(rejected.actions.filter((action) => action.kind === "place")).toHaveLength(0);
    expect(rejected.state.markets["polymarket:1"]?.inventory?.reservedSellQuantity).toBe(0);

    const retried = reduceMarketMake(rejected.state, { type: "timer", ts: NOW + 2_000 }, config);
    const replacement = retried.actions.find((action) => action.kind === "place");
    expect(replacement).toMatchObject({ kind: "place", tif: "FAK", purpose: "urgent-exit" });
    expect(retried.state.markets["polymarket:1"]?.inventory?.reservedSellQuantity).toBe(10);
  });
});

describe("chronological replay", () => {
  it("shares the reducer and labels queue versus optimistic touch assumptions", () => {
    const events = [
      ...readyEvents(),
      { type: "book" as const, ts: NOW + 1_000, marketKey: "polymarket:1", outcome: "YES" as const, book: book("yes-token", 0.49, 2, NOW + 1_000) },
    ];
    const bundle = {
      schemaVersion: "cassie-market-make-replay/1" as const,
      generatedAt: new Date(NOW).toISOString(),
      source: "unit-fixture",
      events,
    };
    const queue = replayMarketMake(bundle, config, { fillModel: "queue" });
    const touch = replayMarketMake(bundle, config, { fillModel: "touch" });
    expect(queue.eventsProcessed).toBe(events.length);
    expect(queue.actionsByKind.place).toBeGreaterThan(0);
    expect(queue.caveats[0]).toMatch(/explicit recorded fill/);
    expect(touch.finalState.markets["polymarket:1"]?.inventory?.freeQuantity).toBeGreaterThan(0);
    expect(touch.caveats[0]).toMatch(/optimistic/);
  });
});

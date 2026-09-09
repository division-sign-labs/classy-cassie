// packages/core/test/hyperliquid-perps.test.ts
import { describe, expect, it, vi } from "vitest";
import type { ExchangeClient, InfoClient } from "@nktkas/hyperliquid";
import { ApiRequestError } from "@nktkas/hyperliquid/api/exchange";
import { VenueUrlsSchema } from "../src/config.js";
import { HyperliquidAdapter, HyperliquidOrderNotSubmittedError, HyperliquidOrderRejectedError, formatSize, toCloid } from "../src/venues/hyperliquid.js";
import { formatBoundedHlPrice, hyperliquidAssetId, hyperliquidDexCashFlow, hyperliquidFeeRates } from "../src/venues/hyperliquid-perps.js";
import { HyperliquidInfoDeferredError, hyperliquidInfoSchedulerStats, wrapHyperliquidInfoClient } from "../src/venues/hyperliquid-info-scheduler.js";
import type { OrderIntent, VenueAccount } from "../src/types.js";

const NOW = Date.UTC(2026, 8, 4, 12, 30);
const USER = "0x1111111111111111111111111111111111111111";
const ACCOUNT: VenueAccount = { venue: "hyperliquid", masterAddress: USER };
const OTHER = "0x2222222222222222222222222222222222222222";

function universe(name = "xyz:AAPL", extra: Record<string, unknown> = {}) {
  return { name, szDecimals: 3, maxLeverage: 20, marginTableId: 20, deployerFeeScale: "1.0", growthMode: "enabled", ...extra };
}
function context(extra: Record<string, unknown> = {}) {
  return { dayNtlVlm: "10000000", markPx: "100", midPx: "100", oraclePx: "99.9", funding: "0.00000625", openInterest: "100000", ...extra };
}
function metadata() {
  return { collateralToken: 0, universe: [universe()], marginTables: [[20, { description: "", marginTiers: [{ lowerBound: "0", maxLeverage: 20 }] }]] };
}
function position(extra: Record<string, unknown> = {}) {
  return { type: "oneWay", position: { coin: "xyz:AAPL", szi: "2", entryPx: "95", positionValue: "200", unrealizedPnl: "10", leverage: { type: "isolated", value: 10, rawUsd: "-180" }, marginUsed: "30", liquidationPx: "87", ...extra } };
}
function state(extra: Record<string, unknown> = {}) {
  return { time: NOW, marginSummary: { accountValue: "1010", totalMarginUsed: "30", totalNtlPos: "200", totalRawUsd: "1000" }, withdrawable: "980", assetPositions: [position()], ...extra };
}
function order(extra: Record<string, unknown> = {}) {
  return { oid: 42, coin: "xyz:AAPL", cloid: toCloid("stop-one"), side: "A", limitPx: "85.5", origSz: "2", sz: "2", timestamp: NOW - 86_400_000, isTrigger: true, isPositionTpsl: true, triggerPx: "90", orderType: "Stop Market", reduceOnly: true, ...extra };
}
function fixture(options: { scoped?: boolean } = {}) {
  let now = NOW;
  const info = {
    perpDexs: vi.fn().mockResolvedValue([null, { name: "other" }, { name: "xyz" }]),
    metaAndAssetCtxs: vi.fn().mockResolvedValue([metadata(), [context()]]),
    userAbstraction: vi.fn().mockResolvedValue("disabled"),
    clearinghouseState: vi.fn().mockResolvedValue(state()),
    frontendOpenOrders: vi.fn().mockResolvedValue([]),
    l2Book: vi.fn().mockImplementation(async () => ({ coin: "xyz:AAPL", time: now - 100, levels: [[{ px: "99.9", sz: "1000" }], [{ px: "100.1", sz: "1000" }]] })),
    candleSnapshot: vi.fn().mockImplementation(async ({ coin, interval }) => {
      const step = interval === "1d" ? 86_400_000 : interval === "4h" ? 14_400_000 : 3_600_000;
      const ts = Math.floor(now / step) * step;
      return [0, 2, 1].map((i) => ({ s: coin, i: interval, t: ts - i * step, T: ts + (1 - i) * step - 1, o: "100", h: "101", l: "99", c: "100", v: "10" }));
    }),
    fundingHistory: vi.fn().mockResolvedValue([{ coin: "xyz:AAPL", time: NOW - 3_600_000, fundingRate: "-0.00001", premium: "0" }]),
    userFees: vi.fn().mockResolvedValue({ userCrossRate: "0.00045", userAddRate: "0.00015", activeReferralDiscount: "0" }),
    userRateLimit: vi.fn().mockResolvedValue({ cumVlm: "0", nRequestsUsed: 0, nRequestsCap: 10000, nRequestsSurplus: 0 }),
    userNonFundingLedgerUpdates: vi.fn().mockResolvedValue([]),
    activeAssetData: vi.fn().mockResolvedValue({ user: USER, coin: "xyz:AAPL", leverage: { type: "isolated", value: 10 } }),
    orderStatus: vi.fn().mockResolvedValue({ status: "unknownOid" }),
    userFillsByTime: vi.fn().mockResolvedValue([]),
  };
  const exchange = {
    order: vi.fn().mockResolvedValue({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 42 } }] } } }),
    updateLeverage: vi.fn().mockResolvedValue({ status: "ok" }),
    scheduleCancel: vi.fn().mockResolvedValue({ status: "ok" }),
    cancel: vi.fn().mockResolvedValue({ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } }),
  };
  const adapter = new HyperliquidAdapter({ urls: VenueUrlsSchema.parse({}), ...(options.scoped === false ? {} : { perpDex: "xyz" }) }, {
    info: info as unknown as InfoClient, exchange: exchange as unknown as ExchangeClient, now: () => now, actionGapMs: 0,
  });
  return { adapter, info, exchange, setTime: (ts: number) => { now = ts; } };
}
const intent: OrderIntent = { marketRef: "xyz:AAPL", side: "BUY", size: 2.12349, limitPrice: 100.129, tif: "GTC", clientId: "entry-one", postOnly: true };

describe("Hyperliquid order rejection receipts", () => {
  const reason = "Post only order would have immediately matched, bbo was 4395.5@4395.6. asset=110003";
  const receipt = (statuses: unknown[]) => ({ status: "ok", response: { type: "order", data: { statuses } } });

  it.each(["sdk-error", "raw-response"])("recognizes a definite post-only rejection from %s", async (source) => {
    const { adapter, exchange } = fixture();
    const response = receipt([{ error: reason }]);
    if (source === "sdk-error") exchange.order.mockRejectedValueOnce(new ApiRequestError(response, `order 0: ${reason}`));
    else exchange.order.mockResolvedValueOnce(response);
    await expect(adapter.placeOrder(ACCOUNT, { ...intent, reduceOnly: true })).rejects.toBeInstanceOf(HyperliquidOrderRejectedError);
    expect(exchange.order).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error(reason),
    new ApiRequestError({ status: "err", response: "nonce already used" }),
    new ApiRequestError(receipt([{ error: reason }, { resting: { oid: 7 } }])),
    new ApiRequestError(receipt([{ error: reason, filled: { oid: 7, totalSz: "1", avgPx: "100" } }])),
    new ApiRequestError({ status: "ok", response: { type: "cancel", data: { statuses: [{ error: reason }] } } }),
    new ApiRequestError(receipt([{ error: "" }])),
  ])("preserves ambiguous or mismatched failures %#", async (error) => {
    const { adapter, exchange } = fixture();
    exchange.order.mockRejectedValueOnce(error);
    await expect(adapter.placeOrder(ACCOUNT, intent)).rejects.toBe(error);
  });

  it("does not classify a failed trigger as a rejected entry after the entry was accepted", async () => {
    const { adapter, exchange } = fixture();
    const error = new ApiRequestError(receipt([{ error: "Invalid TP/SL price." }]));
    exchange.order.mockResolvedValueOnce(receipt([{ resting: { oid: 42 } }])).mockRejectedValueOnce(error);
    await expect(adapter.placeOrder(ACCOUNT, { ...intent, triggers: { stopPx: 90 } })).rejects.toBe(error);
    expect(exchange.order).toHaveBeenCalledTimes(2);
  });

  it("refuses an unexpected response count instead of accepting the first status", async () => {
    const { adapter, exchange } = fixture();
    exchange.order.mockResolvedValueOnce(receipt([{ resting: { oid: 42 } }, { resting: { oid: 43 } }]));
    await expect(adapter.placeOrder(ACCOUNT, intent)).rejects.toThrow("status count mismatch");
  });

  it("certifies a local read-budget deferral before submission and allows a later attempt", async () => {
    const { adapter, exchange, info } = fixture();
    info.userAbstraction.mockRejectedValueOnce(new HyperliquidInfoDeferredError("rate-budget", 1000));
    await expect(adapter.placeOrder(ACCOUNT, intent)).rejects.toBeInstanceOf(HyperliquidOrderNotSubmittedError);
    expect(exchange.order).not.toHaveBeenCalled();
    await expect(adapter.placeOrder(ACCOUNT, intent)).resolves.toMatchObject({ status: "open" });
    expect(exchange.order).toHaveBeenCalledTimes(1);
  });

  it("does not infer non-submission from a deferred read thrown after the exchange call starts", async () => {
    const { adapter, exchange } = fixture();
    const error = new HyperliquidInfoDeferredError("rate-budget", 1000);
    exchange.order.mockRejectedValueOnce(error);
    await expect(adapter.placeOrder(ACCOUNT, intent)).rejects.toBe(error);
  });
});

describe("Hyperliquid HIP-3 contracts", () => {
  it("resolves DEX indices rather than treating a HIP-3 asset like a native perp", async () => {
    const { adapter, info, exchange } = fixture();
    const instruments = await adapter.perpInstruments();
    expect(instruments[0]).toMatchObject({ assetId: 120000, marketRef: "xyz:AAPL", collateralToken: 0, maintenanceMarginRate: 0.025 });
    await adapter.placeOrder(ACCOUNT, intent);
    expect(info.metaAndAssetCtxs).toHaveBeenCalledWith({ dex: "xyz" });
    expect(exchange.order).toHaveBeenCalledWith({ grouping: "na", orders: [{ a: 120000, b: true, p: "100.12", s: "2.123", r: false, c: toCloid(intent.clientId), t: { limit: { tif: "Alo" } } }] });
    expect(hyperliquidAssetId(0, 4)).toBe(4);
    expect(hyperliquidAssetId(1, 4)).toBe(110004);
  });

  it("keeps Standard DEX account equity separate from gross position notional", async () => {
    const { adapter, info } = fixture();
    info.frontendOpenOrders.mockResolvedValue([order()]);
    const snapshot = await adapter.perpAccountSnapshot(ACCOUNT);
    expect(snapshot).toMatchObject({ equity: 1010, grossNotional: 200, availableCollateral: 980, marginUsed: 30, dex: "xyz", abstraction: "standard" });
    expect(snapshot.positions[0]).toMatchObject({ side: "LONG", currentPrice: 100, leverage: 10, marginMode: "isolated", marginUsed: 30, liquidationPrice: 87 });
    expect(snapshot.openOrders[0]).toMatchObject({ isTrigger: true, isPositionTpsl: true, reduceOnly: true, triggerPrice: 90, triggerKind: "sl", price: 85.5 });
    expect(info.clearinghouseState).toHaveBeenCalledWith({ user: USER, dex: "xyz" });
    expect(info.frontendOpenOrders).toHaveBeenCalledWith({ user: USER, dex: "xyz" });
  });

  it.each(["unifiedAccount", "portfolioMargin", "default", "dexAbstraction"])("rejects unverified accounting mode %s before any entry", async (mode) => {
    const { adapter, info, exchange } = fixture();
    info.userAbstraction.mockResolvedValue(mode);
    await expect(adapter.perpAccountSnapshot(ACCOUNT)).rejects.toThrow("Standard account mode");
    await expect(adapter.placeOrder(ACCOUNT, intent)).rejects.toThrow("Standard account mode");
    expect(exchange.order).not.toHaveBeenCalled();
  });

  it("reports default-mode funding and trading balances without authorizing entries", async () => {
    const { adapter, info, exchange } = fixture();
    info.userAbstraction.mockResolvedValue("default");
    info.clearinghouseState.mockImplementation(async (request: { dex?: string }) => state({
      marginSummary: { accountValue: request.dex ? "0" : "600.064501" },
      withdrawable: request.dex ? "0" : "600.064501", assetPositions: [],
    }));
    await expect(adapter.balances(ACCOUNT)).resolves.toEqual([{ asset: "USDC", total: 0, available: 0 }]);
    await expect(adapter.portfolioScope(ACCOUNT)).resolves.toEqual({
      dex: "xyz", accountMode: "default", fundingBalance: 600.064501, fundingAvailable: 600.064501,
    });
    await expect(adapter.placeOrder(ACCOUNT, intent)).rejects.toThrow("Standard account mode");
    expect(exchange.order).not.toHaveBeenCalled();
  });

  it.each([1, 10, 20, 50])("resolves omitted built-in flat margin table %s", async (leverage) => {
    const { adapter, info } = fixture();
    info.metaAndAssetCtxs.mockResolvedValue([{
      ...metadata(), universe: [universe("xyz:AAPL", { marginTableId: leverage, maxLeverage: leverage })],
      marginTables: [],
    }, [context()]]);
    expect((await adapter.perpInstruments())[0]?.marginTiers).toEqual([
      { lowerBound: 0, maxLeverage: leverage, maintenanceMarginRate: 1 / (2 * leverage) },
    ]);
  });

  it("rejects missing custom margin tables before requesting books or history", async () => {
    const { adapter, info } = fixture();
    info.metaAndAssetCtxs.mockResolvedValue([{
      ...metadata(), universe: [universe("xyz:AAPL", { marginTableId: 99 })], marginTables: [],
    }, [context()]]);
    await expect(adapter.perpMarketSnapshot(ACCOUNT, "xyz:AAPL")).rejects.toThrow("missing Hyperliquid margin table");
    expect(info.l2Book).not.toHaveBeenCalled();
    expect(info.candleSnapshot).not.toHaveBeenCalled();
  });

  it("fails closed on collateral, DEX identity, missing margin tiers and invalid fees", async () => {
    const wrongCollateral = fixture();
    wrongCollateral.info.metaAndAssetCtxs.mockResolvedValue([{ ...metadata(), collateralToken: 360 }, [context()]]);
    await expect(wrongCollateral.adapter.perpAccountSnapshot(ACCOUNT)).rejects.toThrow("USDC collateral");
    const wrongIdentity = fixture();
    wrongIdentity.info.metaAndAssetCtxs.mockResolvedValue([{ ...metadata(), universe: [universe("other:AAPL")] }, [context()]]);
    await expect(wrongIdentity.adapter.perpInstruments()).rejects.toThrow("identity mismatch");
    const missingTier = fixture();
    missingTier.info.metaAndAssetCtxs.mockResolvedValue([{ ...metadata(), universe: [universe("xyz:AAPL", { marginTableId: 99 })], marginTables: [] }, [context()]]);
    await expect(missingTier.adapter.perpInstruments()).rejects.toThrow("margin table");
    const missingFee = fixture();
    missingFee.info.metaAndAssetCtxs.mockResolvedValue([{ ...metadata(), universe: [universe("xyz:AAPL", { deployerFeeScale: undefined })] }, [context()]]);
    await expect(missingFee.adapter.perpInstruments()).rejects.toThrow("deployer fee scale");
    await expect(fixture().adapter.placeOrder(ACCOUNT, { ...intent, marketRef: "other:AAPL" })).rejects.toThrow("outside configured DEX");
  });

  it("uses actual growth fees and the current funding rate from a book plus shared cached reads", async () => {
    const { adapter, info } = fixture();
    const snap = await adapter.perpMarketSnapshot(ACCOUNT, "xyz:AAPL");
    expect(snap.makerFeeRate).toBeCloseTo(0.00003);
    expect(snap.takerFeeRate).toBeCloseTo(0.00009);
    expect(snap.fundingRateHourly).toBe(0.00000625);
    expect(snap).not.toHaveProperty("fundingHistory");
    expect(snap).not.toHaveProperty("candles1h");
    expect(info.fundingHistory).not.toHaveBeenCalled();
    expect(info.candleSnapshot).not.toHaveBeenCalled();
    expect(snap.book.ts).toBe(NOW);
    expect(snap.book.venueTs).toBe(NOW - 100);
    expect(snap.markPrice).toBe(100);
    expect(snap.oraclePrice).toBe(99.9);
    await adapter.perpMarketSnapshot(ACCOUNT, "xyz:AAPL");
    expect(info.l2Book).toHaveBeenCalledTimes(2);
    expect(info.userFees).toHaveBeenCalledTimes(1);
    expect(hyperliquidFeeRates({ maker: 0.00015, taker: 0.00045, referralDiscount: 0, dexIndex: 1, deployerFeeScale: 1, growthMode: false }).taker).toBe(0.0009);
  });

  it("keeps cold market snapshots for sixteen xyz coins inside the background read budget", async () => {
    const coins = ["AAPL", "NVDA", "INTC", "META", "TSLA", "ORCL", "HOOD", "PLTR", "GOLD", "SILVER", "COPPER", "WTI", "NATGAS", "PLATINUM", "PALLADIUM", "CORN"].map(c => `xyz:${c}`);
    const raw = {
      perpDexs: vi.fn().mockResolvedValue([null, { name: "other" }, { name: "xyz" }]),
      metaAndAssetCtxs: vi.fn().mockResolvedValue([{ ...metadata(), universe: coins.map(c => universe(c)) }, coins.map(() => context())]),
      userAbstraction: vi.fn().mockResolvedValue("disabled"),
      l2Book: vi.fn().mockImplementation(async ({ coin }: { coin: string }) => ({ coin, time: NOW - 100, levels: [[{ px: "99.9", sz: "1000" }], [{ px: "100.1", sz: "1000" }]] })),
      candleSnapshot: vi.fn().mockResolvedValue([]),
      fundingHistory: vi.fn().mockResolvedValue([]),
      userFees: vi.fn().mockResolvedValue({ userCrossRate: "0.00045", userAddRate: "0.00015", activeReferralDiscount: "0" }),
    };
    const info = wrapHyperliquidInfoClient(raw as unknown as InfoClient, { now: () => NOW, scope: "cold-snapshot-budget-test" });
    const adapter = new HyperliquidAdapter({ urls: VenueUrlsSchema.parse({}), perpDex: "xyz" }, {
      info, exchange: {} as unknown as ExchangeClient, now: () => NOW, actionGapMs: 0,
    });
    for (const coin of coins) {
      const snap = await adapter.perpMarketSnapshot(ACCOUNT, coin);
      expect(snap.instrument.marketRef).toBe(coin);
    }
    expect(raw.candleSnapshot).not.toHaveBeenCalled();
    expect(raw.fundingHistory).not.toHaveBeenCalled();
    expect(raw.l2Book).toHaveBeenCalledTimes(16);
    const stats = hyperliquidInfoSchedulerStats(info);
    expect(stats?.rejected ?? 0).toBe(0);
    expect(stats?.weightInWindow).toBeLessThanOrEqual(100);
  });

  it("rejects dust after rounding without preventing an exact reduce-only close", async () => {
    const { adapter, exchange } = fixture();
    await expect(adapter.placeOrder(ACCOUNT, { ...intent, size: 0.0999 })).rejects.toThrow("$10 venue minimum");
    expect(exchange.order).not.toHaveBeenCalled();
    await adapter.placeOrder(ACCOUNT, { ...intent, size: 0.0999, reduceOnly: true, postOnly: false, tif: "IOC" });
    expect(exchange.order.mock.calls[0]![0].orders[0]).toMatchObject({ s: "0.099", r: true, t: { limit: { tif: "Ioc" } } });
    // A resting take-profit is a plain reduce-only Gtc limit: no trigger, no post-only, no entry floor.
    await adapter.placeOrder(ACCOUNT, { ...intent, size: 0.0999, reduceOnly: true, postOnly: false, tif: "GTC", purpose: "target" });
    expect(exchange.order.mock.calls[1]![0].orders[0]).toMatchObject({ s: "0.099", r: true, t: { limit: { tif: "Gtc" } } });
    expect(Number(formatBoundedHlPrice(100.121, 3, "SELL"))).toBeGreaterThanOrEqual(100.121);
    expect(Number(formatBoundedHlPrice(100.129, 3, "BUY"))).toBeLessThanOrEqual(100.129);
  });

  it("rejects an old or mismatched venue book even when the HTTP response arrived now", async () => {
    const { adapter, info } = fixture();
    info.l2Book.mockResolvedValue({ coin: "xyz:AAPL", time: NOW - 31_000, levels: [[{ px: "99", sz: "1" }], [{ px: "101", sz: "1" }]] });
    await expect(adapter.perpMarketSnapshot(ACCOUNT, "xyz:AAPL")).rejects.toThrow("stale venue book");
    info.l2Book.mockResolvedValue({ coin: "other:AAPL", time: NOW, levels: [[], []] });
    await expect(adapter.book("xyz:AAPL")).rejects.toThrow("book identity");
    info.clearinghouseState.mockResolvedValue(state({ time: NOW - 61_000 }));
    await expect(adapter.perpAccountSnapshot(ACCOUNT)).rejects.toThrow("account state is stale");
  });

  it("preserves exact valid lot sizes while truncating decimal and scientific-notation dust", () => {
    expect(formatSize(1.005, 3)).toBe("1.005");
    expect(formatSize(1.0059, 3)).toBe("1.005");
    expect(formatSize(1e-7, 6)).toBe("0");
    expect(formatSize(1.25e-5, 6)).toBe("0.000012");
    expect(formatSize(1e21, 3)).toBe("1000000000000000000000");
  });

  it("reuses completed candles until each timeframe's next boundary", async () => {
    const { adapter, info, setTime } = fixture();
    const load = () => Promise.all([adapter.candles("xyz:AAPL", "1h", 240), adapter.candles("xyz:AAPL", "4h", 180), adapter.candles("xyz:AAPL", "1d", 90)]);
    const [first] = await load();
    expect(info.candleSnapshot).toHaveBeenCalledTimes(3);
    for (const [request] of info.candleSnapshot.mock.calls) {
      const step = request.interval === "1h" ? 3_600_000 : request.interval === "4h" ? 14_400_000 : 86_400_000;
      expect(request.endTime).toBe(Math.floor(NOW / step) * step);
    }
    await load();
    setTime(Date.UTC(2026, 8, 4, 12, 59, 59));
    await load();
    expect(info.candleSnapshot).toHaveBeenCalledTimes(3);
    setTime(Date.UTC(2026, 8, 4, 13));
    const [next] = await load();
    expect(info.candleSnapshot).toHaveBeenCalledTimes(4);
    expect(info.candleSnapshot.mock.calls.filter(([r]) => r.interval === "4h")).toHaveLength(1);
    expect(info.candleSnapshot.mock.calls.filter(([r]) => r.interval === "1d")).toHaveLength(1);
    expect(next.at(-1)!.ts).toBe(first.at(-1)!.ts + 3_600_000);
    expect(next.every(c => c.ts + 3_600_000 <= Date.UTC(2026, 8, 4, 13))).toBe(true);
    expect(next.some(c => c.ts === Date.UTC(2026, 8, 4, 13))).toBe(false);
  });

  it("deduplicates concurrent candle loads and retries failures without caching an error", async () => {
    const { adapter, info } = fixture();
    const original = info.candleSnapshot.getMockImplementation()!;
    let release!: () => void;
    info.candleSnapshot.mockImplementationOnce(async request => {
      await new Promise<void>(resolve => { release = resolve; }); return original(request);
    });
    const reads = [adapter.candles("xyz:AAPL", "1h", 240), adapter.candles("xyz:AAPL", "1h", 240)];
    expect(info.candleSnapshot).toHaveBeenCalledTimes(1);
    release();
    const [a, b] = await Promise.all(reads);
    expect(a).toEqual(b);
    expect(info.candleSnapshot).toHaveBeenCalledTimes(1);
    a[0]!.close = 999;
    expect((await adapter.candles("xyz:AAPL", "1h", 240))[0]!.close).toBe(100);
    info.candleSnapshot.mockRejectedValueOnce(new Error("read timeout"));
    const failed = await Promise.allSettled([adapter.candles("xyz:AAPL", "4h", 180), adapter.candles("xyz:AAPL", "4h", 180)]);
    expect(failed.every(r => r.status === "rejected")).toBe(true);
    expect(info.candleSnapshot).toHaveBeenCalledTimes(2);
    expect(await adapter.candles("xyz:AAPL", "4h", 180)).toHaveLength(2);
    expect(info.candleSnapshot).toHaveBeenCalledTimes(3);
  });

  it("retries delayed publication of a newly closed candle instead of freezing it for an hour", async () => {
    const { adapter, info, setTime } = fixture();
    const original = info.candleSnapshot.getMockImplementation()!;
    const lastClosed = Date.UTC(2026, 8, 4, 11);
    info.candleSnapshot.mockImplementationOnce(async request => (await original(request)).filter((c: { t: number }) => c.t !== lastClosed));
    expect((await adapter.candles("xyz:AAPL", "1h", 240)).at(-1)!.ts).toBe(lastClosed - 3_600_000);
    setTime(NOW + 5_000); await adapter.candles("xyz:AAPL", "1h", 240);
    expect(info.candleSnapshot).toHaveBeenCalledTimes(1);
    setTime(NOW + 15_000);
    expect((await adapter.candles("xyz:AAPL", "1h", 240)).at(-1)!.ts).toBe(lastClosed);
    expect(info.candleSnapshot).toHaveBeenCalledTimes(2);
  });

  it("caps the shared SDK info/exchange transport at a ten-second request timeout", () => {
    const { adapter } = fixture();
    expect((adapter as unknown as { transport: { timeout: number } }).transport.timeout).toBe(10_000);
  });
});

describe("Hyperliquid protection and execution", () => {
  it("places independent position protection for an actual partial fill, never the unfilled remainder", async () => {
    const { adapter, info, exchange } = fixture();
    info.clearinghouseState.mockResolvedValue(state({ assetPositions: [position({ szi: "0.75", positionValue: "75" })] }));
    await adapter.placePerpStop(ACCOUNT, { marketRef: "xyz:AAPL", positionSide: "LONG", size: 2, stopPx: 90, slippagePct: 2, clientId: "stop-one" });
    expect(exchange.order).toHaveBeenCalledWith({ grouping: "positionTpsl", orders: [{ a: 120000, b: false, p: "88.2", s: "0.75", r: true, c: toCloid("stop-one"), t: { trigger: { isMarket: true, triggerPx: "90", tpsl: "sl" } } }] });
  });

  it("handles short stop direction and surfaces stop rejection or already-crossed protection", async () => {
    const { adapter, info, exchange } = fixture();
    info.clearinghouseState.mockResolvedValue(state({ assetPositions: [position({ szi: "-2" })] }));
    await adapter.placePerpStop(ACCOUNT, { marketRef: "xyz:AAPL", positionSide: "SHORT", size: 2, stopPx: 110, slippagePct: 2, clientId: "stop-short" });
    expect(exchange.order.mock.calls[0]![0].orders[0]).toMatchObject({ b: true, p: "112.2", r: true, t: { trigger: { triggerPx: "110" } } });
    await expect(adapter.placePerpStop(ACCOUNT, { marketRef: "xyz:AAPL", positionSide: "SHORT", size: 2, stopPx: 90, slippagePct: 2, clientId: "bad-stop" })).rejects.toThrow("already crossed");
    exchange.order.mockResolvedValue({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Invalid TP/SL price." }] } } });
    await expect(adapter.placePerpStop(ACCOUNT, { marketRef: "xyz:AAPL", positionSide: "SHORT", size: 2, stopPx: 110, slippagePct: 2, clientId: "rejected-stop" })).rejects.toThrow("Invalid TP/SL");
  });

  it("verifies isolated leverage and never changes it on existing exposure", async () => {
    const { adapter, info, exchange } = fixture();
    info.clearinghouseState.mockResolvedValue(state({ assetPositions: [] }));
    info.activeAssetData.mockResolvedValueOnce({ user: USER, coin: "xyz:AAPL", leverage: { type: "cross", value: 20 } });
    await adapter.configurePerpLeverage(ACCOUNT, { marketRef: "xyz:AAPL", leverage: 10, marginMode: "isolated" });
    expect(exchange.updateLeverage).toHaveBeenCalledWith({ asset: 120000, isCross: false, leverage: 10 });
    info.clearinghouseState.mockResolvedValue(state());
    await expect(adapter.configurePerpLeverage(ACCOUNT, { marketRef: "xyz:AAPL", leverage: 20, marginMode: "isolated" })).rejects.toThrow("existing strategy position");
    await expect(adapter.configurePerpLeverage(ACCOUNT, { marketRef: "xyz:AAPL", leverage: 21, marginMode: "isolated" })).rejects.toThrow("20x/venue ceiling");
    expect(exchange.updateLeverage).toHaveBeenCalledTimes(1);
  });

  it("fails when the venue does not apply requested leverage", async () => {
    const { adapter, info } = fixture();
    info.clearinghouseState.mockResolvedValue(state({ assetPositions: [] }));
    info.activeAssetData.mockResolvedValue({ user: USER, coin: "xyz:AAPL", leverage: { type: "cross", value: 20 } });
    await expect(adapter.configurePerpLeverage(ACCOUNT, { marketRef: "xyz:AAPL", leverage: 10, marginMode: "isolated" })).rejects.toThrow("did not confirm");
  });

  it("resolves an ambiguous IOC by CLOID and actual fills without assuming the requested size filled", async () => {
    const { adapter, info } = fixture();
    info.orderStatus.mockResolvedValue({ status: "order", order: { order: order({ cloid: toCloid("entry-one"), origSz: "2", sz: "0", isTrigger: false, reduceOnly: false }), status: "filled", statusTimestamp: NOW } });
    const fill = { oid: 42, tid: 77, coin: "xyz:AAPL", sz: "0.75", px: "100", time: NOW };
    info.userFillsByTime.mockResolvedValue([fill, fill]);
    expect(await adapter.lookupPerpOrder(ACCOUNT, "entry-one")).toMatchObject({ found: true, ack: { filledSize: 0.75, avgFillPrice: 100 }, order: { filledSize: 0.75 } });
    expect(info.orderStatus).toHaveBeenCalledWith({ user: USER, oid: toCloid("entry-one") });
    info.orderStatus.mockResolvedValue({ status: "unknownOid" });
    expect(await adapter.lookupPerpOrder(ACCOUNT, "entry-one")).toEqual({ found: false, definitive: false });
    expect(toCloid(toCloid("entry-one"))).toBe(toCloid("entry-one"));
  });

  it("disarms cancel-all and cannot rearm it on the scoped strategy heartbeat", async () => {
    const { adapter, exchange } = fixture();
    await adapter.disarmScheduledCancel(ACCOUNT);
    await adapter.disarmScheduledCancel(ACCOUNT);
    await adapter.heartbeat(ACCOUNT);
    expect(exchange.scheduleCancel).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(["0", "5000.25"])("supports timer-ineligible accounts with cumulative volume %s without arming a timer", async volume => {
    const { adapter, info, exchange } = fixture();
    const message = `Cannot set scheduled cancel time until enough volume traded. Required: $1000000. Traded: $${volume}.`;
    exchange.scheduleCancel.mockRejectedValue(new ApiRequestError({ status: "err", response: message }, message));
    info.userRateLimit.mockResolvedValue({ cumVlm: volume, nRequestsUsed: 1, nRequestsCap: 10000, nRequestsSurplus: 0 });
    await adapter.disarmScheduledCancel(ACCOUNT);
    await adapter.disarmScheduledCancel(ACCOUNT);
    await adapter.heartbeat(ACCOUNT);
    expect(exchange.scheduleCancel).toHaveBeenCalledExactlyOnceWith();
    expect(info.userRateLimit).toHaveBeenCalledExactlyOnceWith({ user: USER });
  });

  it.each(["1000000", "1000001", "NaN", "-1", ""])("rejects timer eligibility without a valid below-threshold volume: %s", async volume => {
    const { adapter, info, exchange } = fixture();
    const message = "Cannot set scheduled cancel time until enough volume traded. Required: $1000000. Traded: $0.";
    const error = new ApiRequestError({ status: "err", response: message }, message);
    exchange.scheduleCancel.mockRejectedValue(error);
    info.userRateLimit.mockResolvedValue({ cumVlm: volume, nRequestsUsed: 1, nRequestsCap: 10000, nRequestsSurplus: 0 });
    await expect(adapter.disarmScheduledCancel(ACCOUNT)).rejects.toBe(error);
  });

  it("does not confuse transport errors or unknown acknowledgements with timer ineligibility", async () => {
    const { adapter, info, exchange } = fixture();
    const error = new Error("Cannot set scheduled cancel time until enough volume traded. Required: $1000000. Traded: $0.");
    exchange.scheduleCancel.mockRejectedValueOnce(error);
    await expect(adapter.disarmScheduledCancel(ACCOUNT)).rejects.toBe(error);
    expect(info.userRateLimit).not.toHaveBeenCalled();
    await adapter.disarmScheduledCancel(ACCOUNT);
    expect(exchange.scheduleCancel).toHaveBeenCalledTimes(2);
  });

  it("keeps timer disarming unconfirmed if the volume read fails", async () => {
    const { adapter, info, exchange } = fixture();
    const message = "Cannot set scheduled cancel time until enough volume traded. Required: $1000000. Traded: $0.";
    exchange.scheduleCancel.mockRejectedValue(new ApiRequestError({ status: "err", response: message }, message));
    info.userRateLimit.mockRejectedValue(new Error("read unavailable"));
    await expect(adapter.disarmScheduledCancel(ACCOUNT)).rejects.toThrow("read unavailable");
    expect(exchange.scheduleCancel).toHaveBeenCalledOnce();
  });

  it("resolves string trigger acknowledgements to real venue IDs and cancels by CLOID", async () => {
    const { adapter, info, exchange } = fixture();
    exchange.order.mockResolvedValue({ status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger"] } } });
    info.orderStatus.mockResolvedValue({ status: "order", order: { order: order(), status: "open", statusTimestamp: NOW } });
    const ack = await adapter.placePerpStop(ACCOUNT, { marketRef: "xyz:AAPL", positionSide: "LONG", size: 2, stopPx: 90, slippagePct: 2, clientId: "stop-one" });
    expect(ack.orderId).toBe("42");
    info.frontendOpenOrders.mockResolvedValue([order()]);
    await adapter.cancelOrder(ACCOUNT, toCloid("stop-one"));
    expect(exchange.cancel).toHaveBeenCalledWith({ cancels: [{ a: 120000, o: 42 }] });
  });

  it("keeps a waitingForTrigger acknowledgement under its client id when the order index lags", async () => {
    const { adapter, info, exchange } = fixture();
    info.clearinghouseState.mockResolvedValue(state({ assetPositions: [position({ szi: "2", positionValue: "200" })] }));
    exchange.order.mockResolvedValue({ status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger"] } } });
    info.orderStatus.mockResolvedValue({ status: "unknownOid" });
    vi.useFakeTimers();
    try {
      const pending = adapter.placePerpStop(ACCOUNT, { marketRef: "xyz:AAPL", positionSide: "LONG", size: 2, stopPx: 90, slippagePct: 2, clientId: "stop-one" });
      await vi.advanceTimersByTimeAsync(3_000);
      const ack = await pending;
      expect(ack).toMatchObject({ orderId: toCloid("stop-one"), clientId: "stop-one", status: "open" });
      expect(info.orderStatus).toHaveBeenCalledTimes(6);
      expect(exchange.order).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("does not release unknown reservations when fills lag or history is truncated", async () => {
    const { adapter, info } = fixture();
    info.orderStatus.mockResolvedValue({ status: "order", order: { order: order({ cloid: toCloid("entry-one"), isTrigger: false }), status: "filled", statusTimestamp: NOW } });
    expect(await adapter.lookupPerpOrder(ACCOUNT, "entry-one")).toEqual({ found: false, definitive: false });
    info.userFillsByTime.mockResolvedValue(Array.from({ length: 2000 }, () => ({ oid: 42, tid: 77, coin: "xyz:AAPL", sz: "1", px: "100" })));
    expect(await adapter.lookupPerpOrder(ACCOUNT, "entry-one")).toEqual({ found: false, definitive: false });
  });
});

describe("Hyperliquid DEX cash flows", () => {
  const send = { type: "send", user: USER, destination: USER, sourceDex: "", destinationDex: "xyz", token: "USDC", amount: "100" };
  it("distinguishes funding capital from trading/funding and ignores transfers outside the selected DEX", async () => {
    const { adapter, info } = fixture();
    info.userNonFundingLedgerUpdates.mockResolvedValue([
      { time: NOW - 4, hash: "0x1", delta: send },
      { time: NOW - 3, hash: "0x2", delta: { ...send, sourceDex: "xyz", destinationDex: "spot", amount: "25" } },
      { time: NOW - 2, hash: "0x3", delta: { type: "deposit", usdc: "1000" } },
      { time: NOW - 1, hash: "0x4", delta: { type: "liquidation", liquidatedNtlPos: "1000" } },
    ]);
    const result = await adapter.perpCashFlows(ACCOUNT, NOW - 1000);
    expect(result.complete).toBe(true);
    expect(result.flows.map((f) => f.amount)).toEqual([100, -25]);
    expect(hyperliquidDexCashFlow({ ...send, sourceDex: "xyz" }, USER, "xyz")).toBe(0);
    expect(hyperliquidDexCashFlow({ ...send, user: OTHER, destination: OTHER }, USER, "xyz")).toBeUndefined();
  });

  it("preserves same-millisecond transfers and reports an unpageable boundary as incomplete", async () => {
    const { adapter, info } = fixture();
    const rows = Array.from({ length: 500 }, (_, i) => ({ time: NOW - 1, hash: `hash-${i}`, delta: send }));
    info.userNonFundingLedgerUpdates.mockResolvedValue(rows);
    const result = await adapter.perpCashFlows(ACCOUNT, NOW - 100);
    expect(result.complete).toBe(false);
    expect(result.flows).toHaveLength(500);
    expect(info.userNonFundingLedgerUpdates).toHaveBeenCalledTimes(2);
    expect(info.userNonFundingLedgerUpdates.mock.calls[1]![0].startTime).toBe(NOW - 1);
  });

  it("does not certify unknown cash flows or abstraction changes as complete", async () => {
    const { adapter, info } = fixture();
    info.userNonFundingLedgerUpdates.mockResolvedValue([
      { time: NOW - 2, hash: "0x1", delta: send },
      { time: NOW - 1, hash: "0x2", delta: { type: "futureTransfer", amount: "500" } },
    ]);
    expect(await adapter.perpCashFlows(ACCOUNT, NOW - 100)).toMatchObject({ complete: false, flows: [{ amount: 100 }] });
    info.userNonFundingLedgerUpdates.mockResolvedValue([{ time: NOW - 1, hash: "0x3", delta: { type: "activateDexAbstraction", dex: "xyz", amount: "500", token: "USDC" } }]);
    expect(await adapter.perpCashFlows(ACCOUNT, NOW - 100)).toMatchObject({ complete: false });
  });
});

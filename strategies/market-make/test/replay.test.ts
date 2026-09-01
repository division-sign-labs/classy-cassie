// strategies/market-make/test/replay.test.ts
import { describe, expect, it } from "vitest";
import {
  createMarketMakeConfig,
  marketMakeConfigHash,
  replayMarketMake,
  type MarketCatalogSnapshot,
  type MarketMakeReplayBundle,
  type NormalizedMarketMakeEvent,
  type PublishedSignalInput,
  type TokenBook,
} from "../src/index.js";

const START = Date.parse("2026-08-31T12:00:00.000Z");

function book(tokenId: string, mid: number, ts: number): TokenBook {
  const bid = mid - 0.01;
  const ask = mid + 0.01;
  return {
    tokenId,
    bids: [
      { price: bid, size: 3_000 / bid },
      { price: bid - 0.01, size: 2_000 / (bid - 0.01) },
    ],
    asks: [{ price: ask, size: 10_000 }],
    ts,
  };
}

function catalog(): MarketCatalogSnapshot {
  return {
    marketKey: "polymarket:1",
    nativeMarketId: "1",
    conditionId: "condition-1",
    marketRef: "yes-token",
    eventId: "event-1",
    category: "Geopolitics",
    yesTokenId: "yes-token",
    noTokenId: "no-token",
    active: true,
    closed: false,
    archived: false,
    acceptingOrders: true,
    orderbookEnabled: true,
    endsAt: START + 3 * 86_400_000,
    volume24hUsd: 25_000,
    tickSize: 0.01,
    minOrderSize: 1,
  };
}

function signal(): PublishedSignalInput {
  return {
    id: "sig-1",
    marketKey: "polymarket:1",
    nativeMarketId: "1",
    conditionId: "condition-1",
    publishedAt: START - 60_000,
    entryQ: 70,
    entryPm: 50,
    latestQ: 0.7,
    qAsOf: START - 60_000,
    active: true,
    livePriced: true,
  };
}

function readyEvents(): NormalizedMarketMakeEvent[] {
  return [
    { type: "catalog", ts: START, market: catalog() },
    { type: "signal", ts: START, signal: signal() },
    { type: "book", ts: START, marketKey: "polymarket:1", outcome: "YES", book: book("yes-token", 0.5, START) },
    { type: "book", ts: START, marketKey: "polymarket:1", outcome: "NO", book: book("no-token", 0.5, START) },
    { type: "volatility", ts: START, marketKey: "polymarket:1", volatility: { rv24Pp: 3, acceleration: 1 } },
    { type: "stability", ts: START, marketKey: "polymarket:1", stability: { validSince: START - 30_000, maxMoveAwayFromQPp: 0 } },
  ];
}

function bundle(events: NormalizedMarketMakeEvent[]): MarketMakeReplayBundle {
  return {
    schemaVersion: "cassie-market-make-replay/1",
    generatedAt: new Date(START).toISOString(),
    source: "replay-telemetry-test",
    events,
  };
}

describe("market-make replay acceptance metrics", () => {
  it("reports fill rate, fee-inclusive P&L, duration, capital, markouts, and cuts", () => {
    const replayConfig = createMarketMakeConfig({ telemetry: { markout_horizons_seconds: [300] } });
    const buyFill: NormalizedMarketMakeEvent = {
      type: "fill",
      ts: START,
      fillId: "fill-buy",
      orderId: "mm:1:polymarket:1:entry",
      marketKey: "polymarket:1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "BUY",
      size: 10,
      price: 0.5,
      feeUsd: 0.1,
    };
    const report = replayMarketMake(bundle([
      ...readyEvents(),
      buyFill,
      { ...buyFill, ts: START + 1, price: 0.99 },
      { type: "book", ts: START + 300_000, marketKey: "polymarket:1", outcome: "YES", book: book("yes-token", 0.6, START + 300_000) },
      {
        type: "fill",
        ts: START + 600_000,
        fillId: "fill-sell",
        orderId: "external-sell",
        marketKey: "polymarket:1",
        tokenId: "yes-token",
        outcome: "YES",
        side: "SELL",
        size: 4,
        price: 0.6,
        feeUsd: 0.04,
      },
      { type: "reward", ts: START + 600_000, marketKey: "polymarket:1", amountUsd: 0.2 },
      { type: "book", ts: START + 900_000, marketKey: "polymarket:1", outcome: "YES", book: book("yes-token", 0.55, START + 900_000) },
    ]), replayConfig, { fillModel: "queue" });

    expect(report.configHash).toBe(marketMakeConfigHash(replayConfig));
    expect(report.bankrollBasis).toEqual({
      basis: "configured-reference",
      policyMode: "live",
      sizingBankrollUsd: 500,
      maximumSizingBankrollUsd: null,
    });
    expect(report.eventsProcessed).toBe(12);
    expect(report.metrics.fills).toMatchObject({
      inputFillEvents: 3,
      explicitEffectiveFillEvents: 2,
      modeledEffectiveFillEvents: 0,
      ignoredOrDuplicateInputFillEvents: 1,
      effectiveFillEvents: 2,
      filledOrders: 2,
      filledEntryOrders: 1,
    });
    expect(report.metrics.fills.proposedEntryOrderFillRate).toMatchObject({ numerator: 1, denominator: 1, rate: 1 });
    expect(report.metrics.pnl.fees).toMatchObject({ reportedUsd: 0.14, totalUsd: 0.14, fillsWithReportedFee: 2 });
    expect(report.metrics.pnl.realizedGross.valueUsd).toBeCloseTo(0.4);
    expect(report.metrics.pnl.realizedNetAfterFees.valueUsd).toBeCloseTo(0.32);
    expect(report.metrics.pnl.unrealizedGrossAtExecutableBid.valueUsd).toBeCloseTo(0.24);
    expect(report.metrics.pnl.unrealizedNetAfterFeesAtExecutableBid.valueUsd).toBeCloseTo(0.18);
    expect(report.metrics.pnl.rewardsUsd).toBeCloseTo(0.2);
    expect(report.metrics.pnl.netAfterFeesAndRewards.valueUsd).toBeCloseTo(0.7);

    expect(report.metrics.inventoryDuration).toMatchObject({ cycles: 1, closedCycles: 0, openCycles: 1, averageSeconds: 900 });
    expect(report.metrics.capitalUtilization).toMatchObject({
      basis: "inventory-cost-plus-pending-entry",
      deploymentLimitUsd: 350,
      observationSeconds: 900,
    });
    expect(report.metrics.capitalUtilization.peakDeployedUsd).toBeGreaterThan(0);
    expect(report.metrics.capitalUtilization.averageDeployedUsd).toBeGreaterThan(0);

    expect(report.metrics.markouts[0]).toMatchObject({
      horizonSeconds: 300,
      eligibleFillCount: 2,
      observedFillCount: 2,
      meanObservationLagSeconds: 0,
    });
    expect(report.metrics.markouts[0]?.meanPp).toBeCloseTo(7.5);
    expect(report.metrics.cuts.byDirection.YES.pnl.netAfterFeesAndRewards.valueUsd).toBeCloseTo(0.7);
    expect(report.metrics.cuts.byDirection.NO.effectiveFillEvents).toBe(0);
    expect(report.metrics.cuts.byCategory.Geopolitics?.effectiveFillEvents).toBe(2);
    expect(report.metrics.cuts.byCategoryFamily.international?.effectiveFillEvents).toBe(2);
    expect(report.metrics.cuts.byEvent["event-1"]?.pnl.netAfterFeesAndRewards.valueUsd).toBeCloseTo(0.7);
  });

  it("keeps unavailable fees, terminal marks, rates, and markouts explicitly null", () => {
    const report = replayMarketMake(bundle([
      { type: "catalog", ts: START, market: catalog() },
      {
        type: "fill",
        ts: START,
        fillId: "unpriced-buy",
        orderId: "external-buy",
        marketKey: "polymarket:1",
        tokenId: "yes-token",
        outcome: "YES",
        side: "BUY",
        size: 2,
        price: 0.5,
      },
      { type: "timer", ts: START + 300_000 },
    ]), createMarketMakeConfig({ telemetry: { markout_horizons_seconds: [300] } }), { fillModel: "queue" });

    expect(report.metrics.fills.proposedEntryOrderFillRate).toMatchObject({ denominator: 0, rate: null });
    expect(report.metrics.pnl.fees).toMatchObject({ reportedUsd: 0, totalUsd: null, fillsWithReportedFee: 0 });
    expect(report.metrics.pnl.unrealizedGrossAtExecutableBid).toMatchObject({ valueUsd: null, observedUsd: 0, complete: false });
    expect(report.metrics.pnl.unrealizedNetAfterFeesAtExecutableBid.valueUsd).toBeNull();
    expect(report.metrics.pnl.netAfterFeesAndRewards.valueUsd).toBeNull();
    expect(report.metrics.markouts[0]).toMatchObject({ eligibleFillCount: 1, observedFillCount: 0, meanPp: null });
    expect(report.metrics.markouts[0]?.coverage).toMatchObject({ numerator: 0, denominator: 1, rate: 0 });
  });

  it("reports zero-duration capital averages and empty markout denominators as unavailable", () => {
    const report = replayMarketMake(bundle([]), createMarketMakeConfig({ telemetry: { markout_horizons_seconds: [300] } }), { fillModel: "queue" });

    expect(report.metrics.capitalUtilization).toMatchObject({
      observationSeconds: 0,
      peakDeployedUsd: 0,
      averageDeployedUsd: null,
      averageFractionOfDeploymentLimit: null,
    });
    expect(report.metrics.markouts[0]).toMatchObject({ eligibleFillCount: 0, observedFillCount: 0, meanPp: null });
    expect(report.metrics.markouts[0]?.coverage).toMatchObject({ denominator: 0, rate: null });
  });

  it("accounts confirmed redemption proceeds, realized P&L, and cycle duration", () => {
    const report = replayMarketMake(bundle([
      { type: "catalog", ts: START, market: catalog() },
      {
        type: "fill",
        ts: START,
        fillId: "redeemed-buy",
        orderId: "external-buy",
        marketKey: "polymarket:1",
        tokenId: "yes-token",
        outcome: "YES",
        side: "BUY",
        size: 10,
        price: 0.4,
        feeUsd: 0.1,
      },
      {
        type: "redemption",
        ts: START + 3_599_000,
        marketKey: "polymarket:1",
        status: "submitted",
        quantity: 10,
        payoutUsd: 10,
        reference: "0xabc123",
      },
      { type: "redemption", ts: START + 3_600_000, marketKey: "polymarket:1", status: "confirmed" },
    ]), createMarketMakeConfig(), { fillModel: "queue" });

    expect(report.metrics.pnl.redemptions).toMatchObject({
      confirmedRedemptions: 1,
      redemptionsWithReportedPayout: 1,
      accountedQuantity: 10,
      unmatchedQuantity: 0,
    });
    expect(report.metrics.pnl.redemptions.payoutCoverage).toMatchObject({ numerator: 1, denominator: 1, rate: 1 });
    expect(report.metrics.pnl.redemptions.proceeds).toMatchObject({ valueUsd: 10, observedUsd: 10, complete: true });
    expect(report.metrics.pnl.realizedGross.valueUsd).toBeCloseTo(6);
    expect(report.metrics.pnl.realizedNetAfterFees.valueUsd).toBeCloseTo(5.9);
    expect(report.metrics.pnl.netAfterFeesAndRewards.valueUsd).toBeCloseTo(5.9);
    expect(report.metrics.pnl.openInventoryPositions).toBe(0);
    expect(report.metrics.inventoryDuration).toMatchObject({
      cycles: 1,
      closedCycles: 1,
      openCycles: 0,
      averageSeconds: 3_600,
    });
    expect(report.finalState.markets["polymarket:1"]?.inventory).toBeUndefined();
    expect(report.finalState.markets["polymarket:1"]?.redemption).toMatchObject({
      status: "confirmed",
      quantity: 10,
      payoutUsd: 10,
      reference: "0xabc123",
    });
  });

  it("closes the cycle but keeps realized and net P&L null when payout is unavailable", () => {
    const report = replayMarketMake(bundle([
      { type: "catalog", ts: START, market: catalog() },
      {
        type: "fill",
        ts: START,
        fillId: "legacy-redeemed-buy",
        orderId: "external-buy",
        marketKey: "polymarket:1",
        tokenId: "yes-token",
        outcome: "YES",
        side: "BUY",
        size: 10,
        price: 0.4,
        feeUsd: 0,
      },
      { type: "redemption", ts: START + 3_600_000, marketKey: "polymarket:1", status: "confirmed" },
    ]), createMarketMakeConfig(), { fillModel: "queue" });

    expect(report.metrics.pnl.redemptions.payoutCoverage).toMatchObject({ numerator: 0, denominator: 1, rate: 0 });
    expect(report.metrics.pnl.redemptions.proceeds).toMatchObject({ valueUsd: null, observedUsd: 0, complete: false });
    expect(report.metrics.pnl.redemptions.proceeds.unavailableReason).toMatch(/omits payoutUsd/);
    expect(report.metrics.pnl.realizedGross).toMatchObject({ valueUsd: null, observedUsd: 0, complete: false });
    expect(report.metrics.pnl.realizedNetAfterFees.valueUsd).toBeNull();
    expect(report.metrics.pnl.netAfterFeesAndRewards.valueUsd).toBeNull();
    expect(report.metrics.pnl.openInventoryPositions).toBe(0);
    expect(report.metrics.inventoryDuration).toMatchObject({ cycles: 1, closedCycles: 1, openCycles: 0, averageSeconds: 3_600 });
  });

  it("treats a reported zero payout as a complete losing settlement", () => {
    const report = replayMarketMake(bundle([
      {
        type: "fill",
        ts: START,
        fillId: "losing-buy",
        orderId: "external-buy",
        marketKey: "polymarket:1",
        tokenId: "yes-token",
        outcome: "YES",
        side: "BUY",
        size: 1,
        price: 0.4,
        feeUsd: 0,
      },
      {
        type: "redemption",
        ts: START + 1_000,
        marketKey: "polymarket:1",
        status: "confirmed",
        quantity: 1,
        payoutUsd: 0,
      },
    ]), createMarketMakeConfig(), { fillModel: "queue" });

    expect(report.metrics.pnl.redemptions.proceeds).toMatchObject({ valueUsd: 0, complete: true });
    expect(report.metrics.pnl.realizedGross.valueUsd).toBeCloseTo(-0.4);
    expect(report.metrics.pnl.netAfterFeesAndRewards.valueUsd).toBeCloseTo(-0.4);
  });

  it("uses an adopted venue cost basis for gross settlement P&L while leaving unknown historical fees null", () => {
    const report = replayMarketMake(bundle([
      { type: "catalog", ts: START, market: catalog() },
      {
        type: "inventory-reconciled",
        ts: START,
        marketKey: "polymarket:1",
        tokenId: "yes-token",
        outcome: "YES",
        quantity: 5,
        costBasisUsd: 2,
        reason: "fresh-runtime venue adoption",
      },
      {
        type: "redemption",
        ts: START + 59_000,
        marketKey: "polymarket:1",
        status: "submitted",
        quantity: 5,
        payoutUsd: 5,
      },
      { type: "redemption", ts: START + 60_000, marketKey: "polymarket:1", status: "confirmed" },
    ]), createMarketMakeConfig(), { fillModel: "queue" });

    expect(report.metrics.pnl.redemptions.proceeds.valueUsd).toBe(5);
    expect(report.metrics.pnl.realizedGross.valueUsd).toBeCloseTo(3);
    expect(report.metrics.pnl.realizedNetAfterFees.valueUsd).toBeNull();
    expect(report.metrics.pnl.netAfterFeesAndRewards.valueUsd).toBeNull();
    expect(report.metrics.inventoryDuration).toMatchObject({ cycles: 1, closedCycles: 1, averageSeconds: 60 });
  });
});

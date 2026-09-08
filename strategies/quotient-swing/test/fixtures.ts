// strategies/quotient-swing/test/fixtures.ts
import type { SwingMarketSnapshot, SwingOutlook, SwingSnapshot } from "../src/types.js";
import { HOUR } from "../src/math.js";

export const NOW = Date.parse("2026-09-07T16:00:00Z");
export function outlook(overrides: Partial<SwingOutlook> = {}): SwingOutlook {
  const spot = overrides.spotAtObservation ?? 100, median = overrides.medianPrice ?? 107, sigma = overrides.sigmaTotal ?? 0.10;
  return { id: "outlook-1", assetKey: "company:nvda", marketRef: "xyz:NVDA", basisId: "hl-nvda", targetFamilyKey: "hl-close",
    anchorAt: NOW + 72 * HOUR, publishedAt: NOW - 30 * 60_000, observedAt: NOW - 30 * 60_000,
    status: "active", freshnessState: "fresh", freshnessReason: null, mode: "signal", basisVerified: true, provider: "hyperliquid",
    priceField: "mid", window: "point", candleInterval: null, groundingStatus: "actionable", rangeStatus: "complete",
    method: "full_quantile_curve", spotAtObservation: spot, expectedPrice: 108, expectedLogReturn: Math.log(1.08),
    directionalSide: "bullish", medianPrice: median, p10: 90, p25: 98, p75: 115, p90: 125, sigmaTotal: sigma,
    spotGapSigma: Math.log(median / spot) / sigma, scoreSigma: 0.68, probabilityAboveSpot: 0.75, ...overrides };
}

export function market(overrides: Partial<SwingMarketSnapshot> = {}): SwingMarketSnapshot {
  return { assetKey: "company:nvda", marketRef: "xyz:NVDA", assetClass: "equity", active: true, isolatedSupported: true,
    maxLeverage: 20, maintenanceMarginRate: 0.025, sizeDecimals: 3, minNotional: 10, priceTick: 0.01,
    book: { marketRef: "xyz:NVDA", ts: NOW, bids: [{ price: 99.99, size: 1000 }], asks: [{ price: 100.01, size: 1000 }] },
    markPrice: 100, oraclePrice: 100, volume24hUsd: 1_000_000,
    fundingHourly: 0.000001, fundingObservedAt: NOW,
    makerFeeRate: 0.0002, takerFeeRate: 0.0005, outlooks: [outlook()], ...overrides };
}

export function goldMarket(overrides: Partial<SwingMarketSnapshot> = {}, outlookOverrides: Partial<SwingOutlook> = {}): SwingMarketSnapshot {
  return market({ assetKey: "commodity:gold", marketRef: "xyz:GOLD", assetClass: "commodity",
    book: { marketRef: "xyz:GOLD", ts: NOW, bids: [{ price: 99.99, size: 1000 }], asks: [{ price: 100.01, size: 1000 }] },
    outlooks: [outlook({ id: "gold-1", assetKey: "commodity:gold", marketRef: "xyz:GOLD", basisId: "hl-gold", ...outlookOverrides })],
    ...overrides });
}

export function snapshot(overrides: Partial<SwingSnapshot> = {}): SwingSnapshot {
  return { now: NOW, nav: 1000, netCashFlow: 0, availableMarginUsd: 1000,
    coveredAssetKeys: ["company:nvda", "commodity:gold"], markets: [market()], positions: [], openOrders: [], accountObservedAt: NOW,
    accountReconciled: true, ...overrides };
}

export function advance(s: SwingSnapshot, minutes: number, mid = 100): SwingSnapshot {
  const now = s.now + minutes * 60_000;
  return { ...s, now, accountObservedAt: now, markets: s.markets.map(m => ({ ...m, markPrice: mid, oraclePrice: mid,
    book: { ...m.book, ts: now, bids: [{ price: mid - 0.01, size: 1000 }], asks: [{ price: mid + 0.01, size: 1000 }] }, fundingObservedAt: now })) };
}

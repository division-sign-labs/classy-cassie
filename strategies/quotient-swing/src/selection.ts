// strategies/quotient-swing/src/selection.ts
// Eligible outlooks become candidates ranked by realizable edge after costs.
import type { QuotientSwingConfig } from "./schema.js";
import type { SwingCandidate, SwingMarketSnapshot, SwingOutlook, SwingSide, SwingSnapshot } from "./types.js";
import { HOUR, finitePositive, fundingReserve, quotePrice, sigmaStop, signOf } from "./math.js";

export function exactHyperliquidBasis(o: SwingOutlook, market: SwingMarketSnapshot): boolean {
  return o.assetKey === market.assetKey && o.marketRef === market.marketRef && o.provider === "hyperliquid"
    && o.basisVerified && o.groundingStatus === "actionable" && o.priceField === "mid"
    && o.window === "point" && o.candleInterval === null && !!o.basisId && !!o.targetFamilyKey;
}

/** Every exact-basis outlook whose anchor lies inside the configured entry window, nearest first. */
export function eligibleHorizons(market: SwingMarketSnapshot, now: number, config: QuotientSwingConfig): SwingOutlook[] {
  return market.outlooks.filter(o => exactHyperliquidBasis(o, market)
    && o.anchorAt - now >= config.minHorizonHours * HOUR && o.anchorAt - now <= config.maxHorizonHours * HOUR)
    .sort((a, b) => a.anchorAt - b.anchorAt || b.publishedAt - a.publishedAt || a.id.localeCompare(b.id));
}

/** Validity of a published curve; used for entries and for keeping a held forecast current. */
export function forecastProblem(o: SwingOutlook, now: number, config: QuotientSwingConfig): string | undefined {
  if (o.status !== "active" || !config.freshnessStates.includes(o.freshnessState)) return "outlook_not_fresh";
  if (o.publishedAt > now || o.observedAt > now || now - o.publishedAt > config.maxPublicationAgeHours * HOUR
    || now - o.observedAt > config.maxPublicationAgeHours * HOUR) return "outlook_publication_age";
  if (o.rangeStatus === "unknown" || o.method !== "full_quantile_curve") return "incomplete_curve";
  const prices = [o.p10, o.p25, o.medianPrice, o.p75, o.p90];
  if (!prices.every(finitePositive) || prices.some((p, i) => i > 0 && p < prices[i - 1]!)) return "invalid_quantiles";
  if (![o.spotAtObservation, o.expectedPrice, o.sigmaTotal].every(finitePositive)
    || !Number.isFinite(o.expectedLogReturn) || !Number.isFinite(o.spotGapSigma)) return "invalid_distribution";
  return undefined;
}

/** Direction and signal-size requirements that apply to a new entry only. */
export function entryProblem(o: SwingOutlook, config: QuotientSwingConfig): string | undefined {
  if (o.directionalSide !== "bullish" && o.directionalSide !== "bearish") return "neutral_horizon";
  const gap = Math.abs(o.spotGapSigma);
  if (gap < config.minGapSigma) return "gap_below_min";
  if (gap > config.maxGapSigma) return "gap_above_max";
  if (Math.sign(o.spotGapSigma) !== (o.directionalSide === "bullish" ? 1 : -1)) return "gap_side_mismatch";
  return undefined;
}

export function outlookSide(o: SwingOutlook): SwingSide | undefined {
  return o.directionalSide === "bullish" ? "LONG" : o.directionalSide === "bearish" ? "SHORT" : undefined;
}

export function marketProblem(m: SwingMarketSnapshot, now: number, config: QuotientSwingConfig): string | undefined {
  const supported = m.assetClass === "crypto"
    ? (m.assetKey === "crypto:btc" && m.marketRef === "BTC") || (m.assetKey === "crypto:eth" && m.marketRef === "ETH")
    : m.marketRef.startsWith("xyz:");
  if (!m.active || !m.isolatedSupported || !supported) return "instrument_unavailable";
  const bid = m.book.bids[0]?.price, ask = m.book.asks[0]?.price;
  if (!bid || !ask || !finitePositive(bid) || !finitePositive(ask) || ask <= bid || !finitePositive(m.priceTick)
    || m.book.bids.some((l, i, xs) => !finitePositive(l.price) || !finitePositive(l.size) || (i > 0 && l.price > xs[i - 1]!.price))
    || m.book.asks.some((l, i, xs) => !finitePositive(l.price) || !finitePositive(l.size) || (i > 0 && l.price < xs[i - 1]!.price))) return "invalid_book";
  if (m.book.ts > now || now - m.book.ts > config.maxBookAgeSec * 1000) return "stale_book";
  const mid = (ask + bid) / 2;
  if (!Number.isFinite(m.volume24hUsd) || m.volume24hUsd < config.minVolume24hUsd) return "volume";
  if ((ask - bid) / mid * 10_000 > config.maxSpreadBps) return "spread";
  if (![m.markPrice, m.oraclePrice].every(finitePositive) || Math.abs(m.markPrice / m.oraclePrice - 1) > config.maxOracleGapFraction) return "oracle_gap";
  if (!Number.isFinite(m.fundingHourly) || m.fundingObservedAt > now || now - m.fundingObservedAt > config.maxFundingAgeMin * 60_000) return "funding_unavailable";
  if (![m.makerFeeRate, m.takerFeeRate].every(n => Number.isFinite(n) && n >= 0)) return "fees_unavailable";
  return undefined;
}

/** Entry, stop, target and cost geometry for one outlook at the current book, or a rejection reason. */
export function candidateFor(o: SwingOutlook, m: SwingMarketSnapshot, now: number, cfg: QuotientSwingConfig): SwingCandidate | string {
  const bad = forecastProblem(o, now, cfg) ?? entryProblem(o, cfg);
  if (bad) return bad;
  const side = outlookSide(o)!, d = signOf(side);
  const bid = m.book.bids[0]!.price, ask = m.book.asks[0]!.price, mid = (bid + ask) / 2, slip = cfg.maxSlippageBps / 10_000;
  const entryPrice = quotePrice(side === "LONG" ? ask * (1 + slip) : bid * (1 - slip), m.priceTick, side, false);
  if (!finitePositive(entryPrice)) return "invalid_book";
  if (d * (o.medianPrice - entryPrice) <= 0) return "median_crossed";
  const targetPrice = quotePrice(o.medianPrice, m.priceTick, side, true);
  const remainingHours = (o.anchorAt - now) / HOUR, horizonHours = (o.anchorAt - o.observedAt) / HOUR;
  const stopPrice = quotePrice(sigmaStop(entryPrice, side, o.sigmaTotal, remainingHours, horizonHours, cfg.stopSigmaMultiple), m.priceTick, side, true);
  const stopFraction = d * (entryPrice - stopPrice) / entryPrice;
  if (!finitePositive(stopPrice) || !finitePositive(stopFraction)) return "invalid_stop";
  const funding = fundingReserve(m.fundingHourly, side, remainingHours, cfg.fundingReserveMultiple);
  const cost = 2 * m.takerFeeRate + (ask - bid) / mid + 2 * slip + funding;
  const netEdge = d * Math.log(targetPrice / entryPrice) - cost;
  if (!(netEdge > 0)) return "edge_inside_costs";
  return { marketRef: m.marketRef, assetKey: m.assetKey, assetClass: m.assetClass, side, outlook: o, entryPrice,
    minNotional: Math.max(cfg.minOrderNotional, m.minNotional), stopPrice, targetPrice, stopFraction,
    gapSigma: o.spotGapSigma, netEdge, rank: netEdge, costFraction: cost, fundingFraction: funding,
    remainingHours, horizonHours, themes: [m.assetClass] };
}

/** The best-ranked eligible horizon for a market, or the nearest horizon's rejection reason. */
export function buildCandidate(m: SwingMarketSnapshot, snapshot: SwingSnapshot, cfg: QuotientSwingConfig): SwingCandidate | string {
  const now = snapshot.now;
  if (!snapshot.coveredAssetKeys.includes(m.assetKey)) return "asset_not_covered";
  const marketFailure = marketProblem(m, now, cfg);
  if (marketFailure) return marketFailure;
  const horizons = eligibleHorizons(m, now, cfg);
  if (!horizons.length) return "no_24_120_hour_horizon";
  let best: SwingCandidate | undefined, firstReason: string | undefined;
  for (const o of horizons) {
    const result = candidateFor(o, m, now, cfg);
    if (typeof result === "string") { firstReason ??= result; continue; }
    if (!best || result.rank > best.rank + 1e-12) best = result;
  }
  return best ?? firstReason!;
}

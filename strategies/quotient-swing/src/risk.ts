// strategies/quotient-swing/src/risk.ts
// Stop-defined exposure budgets and conservative isolated margin allocation from live NAV.
import type { QuotientSwingConfig } from "./schema.js";
import type { SwingCandidate, SwingEntryRecord, SwingMarketSnapshot, SwingSnapshot } from "./types.js";
import { clamp, floorSize, liquidationDistance, signOf } from "./math.js";

export interface SwingAllocation { notional: number; size: number; leverage: number; marginUsd: number; liquidationPrice: number; stopRiskUsd: number }

/**
 * `slots` counts the positions the unused margin budget still has to cover this tick, this one included.
 * Each takes an equal share, so utilization approaches `totalMarginPct` whatever the candidate count,
 * and `singleMarginPct` caps any one of them.
 */
export function allocateSwing(c: SwingCandidate, m: SwingMarketSnapshot, s: SwingSnapshot, entries: SwingEntryRecord[], cfg: QuotientSwingConfig, drawdown: number, slots = 1): SwingAllocation | string {
  const riskFraction = (cfg.riskBasePct + (cfg.riskMaxPct - cfg.riskBasePct)
    * clamp((c.netEdge - cfg.riskBaseEdge) / (cfg.riskMaxEdge - cfg.riskBaseEdge), 0, 1)) / 100;
  const drawdownMultiplier = drawdown >= cfg.drawdownReduceFraction ? 0.5 : 1;
  const perUnitRisk = c.stopFraction + c.costFraction;
  const gross = entries.reduce((sum, e) => sum + e.reservedNotional, 0);
  const stopRisk = entries.reduce((sum, e) => sum + e.stopRiskUsd, 0);
  const marginUsed = entries.reduce((sum, e) => sum + e.marginUsd, 0);
  let maximum = Math.min(s.nav * riskFraction * drawdownMultiplier / perUnitRisk,
    s.nav * cfg.singleNotionalNav, s.nav * cfg.grossNotionalNav - gross,
    (s.nav * cfg.totalStopRiskPct / 100 - stopRisk) / perUnitRisk);
  const exitLevels = c.side === "LONG" ? m.book.bids : m.book.asks;
  const exitBest = exitLevels[0]?.price;
  const depth = exitBest === undefined ? 0 : exitLevels.filter(l => Math.abs(l.price / exitBest - 1) <= cfg.exitDepthBps / 10_000)
    .reduce((sum, l) => sum + l.price * l.size, 0);
  maximum = Math.min(maximum, depth / cfg.minDepthMultiple);
  const share = (s.nav * cfg.totalMarginPct / 100 - marginUsed) / Math.max(1, Math.floor(slots));
  const marginCap = Math.min(s.nav * cfg.singleMarginPct / 100, share,
    Math.max(0, s.availableMarginUsd - entries.filter(e => e.status !== "held").reduce((sum, e) => sum + e.marginUsd, 0)));
  if (maximum <= 0 || marginCap <= 0) return "portfolio_capacity";
  let best: SwingAllocation | undefined;
  for (let leverage = 1; leverage <= Math.min(cfg.maxLeverage, m.maxLeverage); leverage++) {
    const cappedNotional = Math.min(maximum, marginCap / (1 / leverage + c.fundingFraction));
    const tier = m.marginTiers?.filter(t => cappedNotional >= t.lowerBound).sort((a, b) => b.lowerBound - a.lowerBound)[0];
    if (tier && leverage > tier.maxLeverage) continue;
    const maintenance = tier?.maintenanceMarginRate ?? m.maintenanceMarginRate;
    const distance = liquidationDistance(c.side, leverage, maintenance) - c.fundingFraction / (1 - signOf(c.side) * maintenance);
    if (distance < cfg.liquidationStopMultiple * c.stopFraction + cfg.emergencyGapFraction) continue;
    const size = floorSize(cappedNotional / c.entryPrice, m.sizeDecimals), notional = size * c.entryPrice;
    const allocation = { notional, size, leverage, marginUsd: notional * (1 / leverage + c.fundingFraction),
      liquidationPrice: c.entryPrice * (1 - signOf(c.side) * distance), stopRiskUsd: notional * perUnitRisk };
    if (!best || notional > best.notional + 1e-8) best = allocation;
  }
  if (!best || best.notional < Math.max(cfg.minOrderNotional, m.minNotional) || best.size <= 0) return "margin_or_liquidation_capacity";
  return best;
}

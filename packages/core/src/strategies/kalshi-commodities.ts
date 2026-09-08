// packages/core/src/strategies/kalshi-commodities.ts
// Exact-contract Q decisions. Market reads are injected; orders go through Engine.
import { z } from "zod";
import type { Action, OrderBook, Position, SignalSource, Strategy, StrategyContext } from "../types.js";
import { mirrorBookForNo } from "../engine/mirror.js";

export const COMMODITY_ASSETS = ["oil", "gold", "btc", "copper", "silver"] as const;
export type CommodityAsset = typeof COMMODITY_ASSETS[number];
export const CommodityConfigSchema = z.object({
  assets: z.array(z.enum(COMMODITY_ASSETS)).min(1).max(5).default(["oil"]),
  signalPollIntervalMin: z.number().min(1).max(60).default(5),
  forecastPollIntervalMin: z.number().min(5).max(120).default(30),
  outlookPollIntervalMin: z.number().min(30).max(1440).default(360),
  maxForecastAgeHours: z.number().positive().max(24).default(6),
  minHoursToClose: z.number().min(1).max(72).default(2),
  maxDaysToClose: z.number().min(1).max(14).default(14),
  minPrice: z.number().min(.05).max(.45).default(.1),
  maxPrice: z.number().min(.55).max(.95).default(.9),
  maxSpread: z.number().positive().max(.1).default(.05),
  rawMinEdgePp: z.number().min(0).max(25).default(5),
  maxEntrySpreadPp: z.number().positive().max(30).default(25),
  qWeight: z.number().positive().max(.75).default(.5),
  uncertaintyPp: z.number().nonnegative().max(10).default(1),
  entrySpreadPp: z.number().min(1).max(10).default(2),
  kellyFraction: z.number().positive().max(.25).default(.15),
  marketCapPct: z.number().positive().max(5).default(2.5),
  eventCapPct: z.number().positive().max(5).default(2.5),
  assetCapPct: z.number().positive().max(10).default(2.5),
  grossCapPct: z.number().positive().max(25).default(10),
  themeCapPct: z.number().positive().max(15).default(5),
  directionCapPct: z.number().positive().max(15).default(6),
  minExitDepth2cUsd: z.number().min(20).default(50),
  depthParticipationPct: z.number().positive().max(10).default(2),
  minEntryNotional: z.number().min(1).default(1),
  maxDrawdownPct: z.number().positive().max(20).default(8),
  dailyLossPct: z.number().positive().max(10).default(3),
  entryStyle: z.enum(["marketable", "adaptive"]).default("marketable"),
  entryDeadlineSec: z.number().min(10).max(120).default(20),
  exitPassiveSec: z.number().min(0).max(120).default(20),
  allocationMode: z.literal("portfolio-kelly").default("portfolio-kelly"),
}).strict().superRefine((c, ctx) => {
  if (new Set(c.assets).size !== c.assets.length) ctx.addIssue({ code: "custom", message: "assets must be unique" });
  if (c.rawMinEdgePp >= c.maxEntrySpreadPp) ctx.addIssue({ code: "custom", message: "raw edge minimum must be below maximum" });
  if (c.minHoursToClose >= c.maxDaysToClose * 24) ctx.addIssue({ code: "custom", message: "close horizon is empty" });
});
export type CommodityConfig = z.output<typeof CommodityConfigSchema>;

export interface CommodityContract {
  asset: CommodityAsset;
  marketRef: string;
  eventRef: string;
  series: string;
  closeAt: number;
  openAt: number;
  /** Includes instrument, window and feed regime; immutable for an admitted position. */
  settlementBasis: string;
  rulesHash: string;
  verified: boolean;
  rejectionReason?: string;
  strikeType: "greater" | "less" | "between";
  floor?: number;
  cap?: number;
  qYes: number;
  forecastAt: number;
  forecastId: string;
  /** Standard quadratic coefficient after applying current series multiplier. */
  takerFeeRate: number;
  makerFeeRate: number;
}
export interface CommodityResearchSnapshot {
  receivedAt: number;
  contracts: CommodityContract[];
  excluded: Array<{ marketRef?: string; reason: string }>;
  /** Price outlooks are derived from overlapping Q sources; telemetry, never another vote. */
  outlookDiagnostics?: unknown;
}
export interface CommodityResearchSource extends SignalSource {
  snapshot(): Promise<CommodityResearchSnapshot>;
}
export interface CommodityCandidate {
  contract: CommodityContract;
  side: "YES" | "NO";
  direction: "up" | "down" | "range";
  bid: number;
  ask: number;
  rawQ: number;
  qHeld: number;
  feePerContract: number;
  netEdge: number;
  score: number;
  depthUsd: number;
  maxNotional: number;
}
export interface CommodityReport {
  at: number;
  equity: number;
  drawdownPct: number;
  halted: boolean;
  candidates: CommodityCandidate[];
  excluded: Array<{ marketRef?: string; reason: string }>;
  actions: Action[];
  research: CommodityResearchSnapshot;
  /** Private local observations, retained for forward evaluation; never sent to Quotient. */
  observations?: { books: OrderBook[]; positions: Position[]; cash: number };
}
interface HoldingEvidence { asset: CommodityAsset; eventRef: string; direction: CommodityCandidate["direction"]; settlementBasis: string; rulesHash: string; firstSeenAt: number; qEntry: number }
interface Ledger { highWater: number; day: string; dayStart: number; halted: boolean; holdings: Record<string, HoldingEvidence> }
export const COMMODITY_REPORT_KEY = "kalshi-commodities:report";
export const COMMODITY_LEDGER_KEY = "kalshi-commodities:ledger";
const DAY = 86_400_000;
const EPS = 1e-8;
const themes: Record<CommodityAsset, string> = { oil: "cyclical", copper: "cyclical", btc: "monetary", gold: "monetary", silver: "monetary" };
const finite = (v: number): boolean => Number.isFinite(v);
const active = (status: string): boolean => ["active", "canceling", "blocked"].includes(status);

/** Conservative reserve above the current centicent fee grid, including fragmented fills. */
export function commodityFee(rate: number, price: number): number { return rate * price * (1 - price) + .01; }
export function commodityDirection(c: CommodityContract, side: "YES" | "NO"): CommodityCandidate["direction"] {
  if (c.strikeType === "between") return "range";
  return (c.strikeType === "greater") === (side === "YES") ? "up" : "down";
}
export function commodityCandidate(c: CommodityContract, yesBook: OrderBook, config: CommodityConfig, now: number): CommodityCandidate | string {
  if (!c.verified || !c.settlementBasis || !c.rulesHash || !c.eventRef) return c.rejectionReason ?? "settlement source unverified";
  if (!config.assets.includes(c.asset)) return "asset disabled";
  if (!finite(c.qYes) || c.qYes <= 0 || c.qYes >= 1 || !finite(c.forecastAt) || c.forecastAt > now
    || now - c.forecastAt > config.maxForecastAgeHours * 3_600_000) return "forecast stale or invalid";
  if (!finite(c.openAt) || c.openAt > now || !finite(c.closeAt) || c.closeAt - now < config.minHoursToClose * 3_600_000
    || c.closeAt - now > config.maxDaysToClose * DAY) return "outside entry horizon";
  if (![c.takerFeeRate, c.makerFeeRate].every(v => finite(v) && v >= 0 && v <= .5)) return "fee schedule unavailable";
  if (!finite(yesBook.ts) || now - yesBook.ts > 10_000 || yesBook.ts > now + 1000 || !yesBook.bids.length || !yesBook.asks.length
    || [...yesBook.bids, ...yesBook.asks].some(l => !finite(l.price) || !finite(l.size) || l.price <= 0 || l.price >= 1 || l.size <= 0)) return "book stale or incomplete";
  const yesBid = yesBook.bids[0]!.price, yesAsk = yesBook.asks[0]!.price;
  if (yesBid >= yesAsk || yesAsk - yesBid > config.maxSpread + EPS) return "spread too wide or crossed";
  const mid = (yesBid + yesAsk) / 2;
  const side = c.qYes > mid ? "YES" : "NO";
  const book = side === "YES" ? yesBook : mirrorBookForNo(yesBook);
  const bid = book.bids[0]!.price, ask = book.asks[0]!.price, rawQ = side === "YES" ? c.qYes : 1 - c.qYes;
  if (ask < config.minPrice || ask > config.maxPrice) return "entry price outside band";
  const rawEdge = rawQ - ask;
  if (rawEdge + EPS < config.rawMinEdgePp / 100 || rawEdge > config.maxEntrySpreadPp / 100 + EPS) return "raw executable edge outside band";
  const qHeld = (bid + ask) / 2 + config.qWeight * (rawQ - (bid + ask) / 2) - config.uncertaintyPp / 100;
  // Reserve a taker fee at entry and a possible taker exit near fair value.
  const feePerContract = commodityFee(c.takerFeeRate, ask) + commodityFee(c.takerFeeRate, qHeld);
  const netEdge = qHeld - ask - feePerContract;
  if (netEdge + EPS < config.entrySpreadPp / 100) return "insufficient edge after shrinkage, uncertainty and fees";
  const depthUsd = book.bids.filter(l => l.price >= bid - .02 - EPS).reduce((s, l) => s + l.price * l.size, 0);
  if (depthUsd < config.minExitDepth2cUsd) return "insufficient exit depth";
  // Entry clips must fit the displayed ask as well as a small fraction of exit depth.
  const maxNotional = Math.min(depthUsd * config.depthParticipationPct / 100, book.asks[0]!.size * ask * config.depthParticipationPct / 100);
  const variance = Math.max(.01, qHeld * (1 - qHeld));
  const score = netEdge / Math.sqrt(variance) / Math.sqrt(Math.max(1, (c.closeAt - now) / DAY));
  return { contract: c, side, direction: commodityDirection(c, side), bid, ask, rawQ, qHeld, feePerContract, netEdge, score, depthUsd, maxNotional };
}

/** One settlement exposure per underlying; overlapping ladder strikes receive no diversification credit. */
export class KalshiCommoditiesStrategy implements Strategy {
  readonly id = "kalshi-commodities";
  async tick(ctx: StrategyContext): Promise<Action[]> {
    if (ctx.venueId !== "kalshi") throw new Error("kalshi-commodities requires Kalshi");
    const config = CommodityConfigSchema.parse(ctx.config);
    let now = ctx.now();
    const source = ctx.signals as CommodityResearchSource;
    if (typeof source.snapshot !== "function") throw new Error("kalshi-commodities requires its settlement-aware research source");
    let research: CommodityResearchSnapshot;
    try { research = await source.snapshot(); }
    catch { research = { receivedAt: 0, contracts: [], excluded: [{ reason: "research unavailable; additions disabled" }] }; }
    now = ctx.now();
    const excluded = [...research.excluded];
    const freshResearch = research.receivedAt <= now && now - research.receivedAt <= config.signalPollIntervalMin * 60_000 + 30_000;
    const refs = [...new Set([...research.contracts.map(c => c.marketRef), ...ctx.positions.map(p => p.marketRef)])];
    const books = new Map<string, OrderBook>();
    // Bounded groups avoid a single failed market suppressing supervision elsewhere.
    for (let i = 0; i < refs.length; i += 4) {
      const batch = refs.slice(i, i + 4);
      const results = await Promise.allSettled(batch.map(ref => ctx.venue.book(ref)));
      results.forEach((r, n) => { if (r.status === "fulfilled") books.set(batch[n]!, r.value); else excluded.push({ marketRef: batch[n], reason: "book unavailable" }); });
    }
    const balances = await ctx.venue.balances();
    now = ctx.now();
    const cash = balances.reduce((s, b) => s + b.total, 0);
    let inventoryValue = 0, valuationsComplete = true;
    for (const p of ctx.positions) {
      const b = books.get(p.marketRef), selected = b && (p.side === "NO" ? mirrorBookForNo(b) : b);
      const bid = selected?.bids[0]?.price;
      if (bid === undefined || !b || now - b.ts > 10_000 || b.ts > now + 1000) { valuationsComplete = false; inventoryValue += p.size * p.avgPrice; }
      else inventoryValue += p.size * bid;
    }
    const equity = cash + inventoryValue;
    if (!finite(equity) || equity <= 0) return [];
    const day = new Date(now).toISOString().slice(0, 10);
    const ledger = await ctx.memory.get<Ledger>(COMMODITY_LEDGER_KEY) ?? { highWater: equity, day, dayStart: equity, halted: false, holdings: {} };
    if (valuationsComplete) ledger.highWater = Math.max(ledger.highWater, equity);
    if (ledger.day !== day && valuationsComplete) { ledger.day = day; ledger.dayStart = equity; }
    const drawdownPct = Math.max(0, 1 - equity / ledger.highWater) * 100;
    if (valuationsComplete && (drawdownPct >= config.maxDrawdownPct || (1 - equity / ledger.dayStart) * 100 >= config.dailyLossPct)) ledger.halted = true;
    const contracts = new Map(research.contracts.map(c => [c.marketRef, c]));
    const actions: Action[] = [];
    const exposure = { gross: 0, assets: new Map<string, number>(), themes: new Map<string, number>(), directions: new Map<string, number>() };
    const occupiedAssets = new Set<CommodityAsset>();
    let unknownExposure = false;
    const addExposure = (asset: CommodityAsset, direction: string, cost: number): void => {
      exposure.gross += cost;
      for (const [map, key] of [[exposure.assets, asset], [exposure.themes, themes[asset]], [exposure.directions, direction]] as const) map.set(key, (map.get(key) ?? 0) + cost);
      occupiedAssets.add(asset);
    };
    for (const p of ctx.positions.filter(p => p.size > EPS)) {
      const c = contracts.get(p.marketRef), previous = ledger.holdings[p.marketRef];
      const evidence = previous ?? (c ? { asset: c.asset, eventRef: c.eventRef, direction: commodityDirection(c, p.side === "NO" ? "NO" : "YES"), settlementBasis: c.settlementBasis,
        rulesHash: c.rulesHash, firstSeenAt: now, qEntry: p.side === "NO" ? 1 - c.qYes : c.qYes } : undefined);
      if (!evidence) { unknownExposure = true; continue; }
      ledger.holdings[p.marketRef] = evidence;
      addExposure(evidence.asset, evidence.direction, p.size * p.avgPrice);
      const b = books.get(p.marketRef), selected = b && (p.side === "NO" ? mirrorBookForNo(b) : b), bid = selected?.bids[0]?.price;
      if (!b || bid === undefined || now - b.ts > 10_000 || b.ts > now + 1000) continue;
      // Terminal contracts stay through settlement. Missing Q alone is not a liquidation signal.
      if (c && now >= c.closeAt) continue;
      let reason: string | undefined;
      if (ledger.halted) reason = "commodity drawdown stop";
      else if (c && (c.settlementBasis !== evidence.settlementBasis || c.rulesHash !== evidence.rulesHash)) reason = "settlement terms changed";
      else if (c?.verified && freshResearch && now >= c.forecastAt && now - c.forecastAt <= config.maxForecastAgeHours * 3_600_000) {
        const q = p.side === "NO" ? 1 - c.qYes : c.qYes;
        if (q <= evidence.qEntry - .15 && q < bid - .03) reason = "forecast invalidated";
        else if (bid >= q && bid - p.avgPrice > commodityFee(c.takerFeeRate, bid) + .02) reason = "profitable convergence";
      }
      if (reason) actions.push({ kind: "exit", marketRef: p.marketRef, urgent: reason !== "profitable convergence", reason,
        limitPrice: Math.max(.01, Math.ceil((bid - .03) * 100) / 100), provenance: { asset: evidence.asset, settlementBasis: evidence.settlementBasis } });
    }
    // Fill-lag receipts and active parents reserve the underlying even before positions appear.
    for (const p of ctx.execution?.parents ?? []) {
      if (!active(p.status) && !(p.side === "BUY" && p.filledSize > 0 && now - (p.lastFillAt ?? p.admittedAt) < 300_000)) continue;
      const c = contracts.get(p.marketRef), asset = c?.asset ?? p.provenance?.asset as CommodityAsset | undefined;
      if (!asset || !COMMODITY_ASSETS.includes(asset)) { unknownExposure = true; continue; }
      occupiedAssets.add(asset);
      if (p.side !== "BUY") continue;
      const direction = c ? commodityDirection(c, p.outcome) : String(p.provenance?.direction ?? "range");
      const visible = ctx.positions.find(position => position.marketRef === p.marketRef);
      const invisibleFilled = Math.max(0, p.filledSize - (visible?.size ?? 0)) * (p.filledSize > 0 ? p.filledNotionalUsd / p.filledSize : 0);
      addExposure(asset, direction, p.reservedNotionalUsd + invisibleFilled);
    }
    const ownedOrders = new Set((ctx.execution?.parents ?? []).flatMap(p => p.childOrderIds));
    if (ctx.openOrders.some(o => !ownedOrders.has(o.id))) unknownExposure = true;
    if (ledger.halted || !freshResearch || !valuationsComplete || unknownExposure) {
      for (const parent of ctx.execution?.parents ?? []) if (active(parent.status) && parent.side === "BUY") {
        actions.unshift({ kind: "cancel", marketRef: parent.marketRef, orderId: parent.childOrderIds[0] ?? "", reason: "commodity additions halted or research/account evidence incomplete" });
      }
    }
    const candidates: CommodityCandidate[] = [];
    for (const c of research.contracts) {
      const b = books.get(c.marketRef); if (!b) continue;
      const candidate = commodityCandidate(c, b, config, ctx.now());
      if (typeof candidate === "string") excluded.push({ marketRef: c.marketRef, reason: candidate }); else candidates.push(candidate);
    }
    candidates.sort((a, b) => b.score - a.score || a.contract.marketRef.localeCompare(b.contract.marketRef));
    if (!freshResearch) excluded.push({ reason: "research snapshot stale" });
    if (!valuationsComplete) excluded.push({ reason: "inventory valuation incomplete" });
    if (unknownExposure) excluded.push({ reason: "unclassified account exposure or external orders" });
    if (ledger.halted) excluded.push({ reason: "drawdown stop latched; review and explicitly reset before new entries" });
    if (freshResearch && valuationsComplete && !unknownExposure && !ledger.halted && !ctx.execution?.blocked) {
      for (const candidate of candidates) {
        const { contract: c, direction } = candidate;
        if (occupiedAssets.has(c.asset)) continue;
        // Robust fractional Kelly and positive correlation stress both reduce size.
        const correlated = (exposure.themes.get(themes[c.asset]) ?? 0) / equity;
        const riskPenalty = 1 + 20 * correlated + 10 * exposure.gross / equity;
        const kelly = config.kellyFraction * candidate.netEdge / Math.max(.05, 1 - candidate.ask) / riskPenalty;
        const headroom = Math.min(config.grossCapPct / 100 * equity - exposure.gross,
          config.assetCapPct / 100 * equity - (exposure.assets.get(c.asset) ?? 0),
          config.themeCapPct / 100 * equity - (exposure.themes.get(themes[c.asset]) ?? 0),
          config.directionCapPct / 100 * equity - (exposure.directions.get(direction) ?? 0));
        const feeFraction = candidate.feePerContract / candidate.ask;
        const notional = Math.floor(Math.min(equity * kelly, equity * Math.min(config.marketCapPct, config.eventCapPct) / 100,
          headroom, candidate.maxNotional, cash - exposure.gross) / (1 + feeFraction) * 100) / 100;
        if (notional < config.minEntryNotional) { excluded.push({ marketRef: c.marketRef, reason: "risk or liquidity capacity below minimum" }); continue; }
        addExposure(c.asset, direction, notional * (1 + feeFraction));
        // Hold price fixed at the observed ask. Adaptive mode gets no extra chasing allowance.
        actions.push({ kind: "enter", marketRef: c.marketRef, side: candidate.side, notional, minNotional: config.minEntryNotional,
          limitPrice: candidate.ask, reason: "diversified exact-contract commodity edge",
          provenance: { asset: c.asset, direction, settlementBasis: c.settlementBasis, rulesHash: c.rulesHash, rawQ: candidate.rawQ,
            qHeld: candidate.qHeld - candidate.feePerContract, signalId: c.forecastId, signalTs: new Date(c.forecastAt).toISOString(),
            liveEdgePp: candidate.netEdge * 100, closeAt: c.closeAt, takerFeeRate: c.takerFeeRate, entryStyle: config.entryStyle } });
        ledger.holdings[c.marketRef] = { asset: c.asset, direction, eventRef: c.eventRef, settlementBasis: c.settlementBasis,
          rulesHash: c.rulesHash, firstSeenAt: now, qEntry: candidate.rawQ };
      }
    }
    const report: CommodityReport = { at: now, equity, drawdownPct, halted: ledger.halted, candidates, excluded, actions, research,
      observations: { books: [...books.values()], positions: structuredClone(ctx.positions), cash } };
    await ctx.memory.set(COMMODITY_LEDGER_KEY, ledger);
    await ctx.memory.set(COMMODITY_REPORT_KEY, report);
    return actions;
  }
}

// packages/core/test/kalshi-commodities.test.ts
import { describe, expect, it } from "vitest";
import { CommodityConfigSchema, KalshiCommoditiesStrategy, commodityCandidate, commodityFee, COMMODITY_ASSETS, COMMODITY_LEDGER_KEY, COMMODITY_REPORT_KEY, type CommodityContract, type CommodityReport, type CommodityResearchSnapshot } from "../src/strategies/kalshi-commodities.js";
import type { OrderBook, StrategyContext } from "../src/types.js";

const NOW = Date.UTC(2026, 8, 5, 12);
const contract = (changes: Partial<CommodityContract> = {}): CommodityContract => ({ asset: "gold", marketRef: "gold-a", eventRef: "event-gold", series: "KXGOLD", closeAt: NOW + 86_400_000,
  openAt: NOW - 86_400_000, settlementBasis: "COMEX GC 13:30 ET settlement", rulesHash: "hash-a", verified: true, strikeType: "greater", floor: 4000,
  qYes: .73, forecastAt: NOW - 60_000, forecastId: "forecast-1", takerFeeRate: .07, makerFeeRate: .0175, ...changes });
const book = (changes: Partial<OrderBook> = {}): OrderBook => ({ marketRef: "gold-a", ts: NOW, bids: [{ price: .49, size: 10_000 }], asks: [{ price: .51, size: 10_000 }], ...changes });
type Parent = NonNullable<StrategyContext["execution"]>["parents"][number];
function parent(changes: Partial<Parent> = {}): Parent {
  return { id: "p1", marketRef: "gold-a", tokenId: "kalshi:gold-a:YES", conditionId: "kalshi:gold-a", outcome: "YES", side: "BUY", status: "active", admittedAt: NOW - 60_000,
    deadlineAt: NOW + 60_000, filledSize: 0, filledNotionalUsd: 0, feeUsd: 0, reservedNotionalUsd: 10, reservedSize: 20, remainingSize: 20,
    priorMarketSize: 0, childOrderIds: ["o1"], reason: "entry", urgent: false, provenance: { asset: "gold", direction: "up" }, ...changes };
}
function harness(changes: Record<string, unknown> = {}) {
  const memory = new Map<string, unknown>(), books = new Map<string, OrderBook>();
  let cash = 1000;
  const snapshot: CommodityResearchSnapshot = { receivedAt: NOW, contracts: [contract()], excluded: [] };
  const ctx: StrategyContext = { botId: "commodities-test", venueId: "kalshi", config: { assets: [...COMMODITY_ASSETS], ...changes }, now: () => NOW, equity: cash,
    positions: [], openOrders: [], execution: { parents: [], blocked: false, entryCooldowns: {}, dailySpentUsd: {} },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    memory: { get: async <T>(key: string) => memory.get(key) as T | undefined, set: async (key, value) => { memory.set(key, structuredClone(value)); } },
    signals: { latest: async () => [], snapshot: async () => snapshot } as StrategyContext["signals"],
    venue: { balances: async () => [{ asset: "USD", total: cash, available: cash }], positions: async () => ctx.positions, openOrders: async () => ctx.openOrders, fills: async () => [],
      book: async ref => books.get(ref) ?? book({ marketRef: ref }), quote: async () => { throw new Error("unused"); } },
  };
  const strategy = new KalshiCommoditiesStrategy();
  return { ctx, memory, snapshot, books, strategy, cash: (value: number) => { cash = value; }, report: () => memory.get(COMMODITY_REPORT_KEY) as CommodityReport };
}

describe("commodity exact-contract decisions", () => {
  it("uses one shrunk forecast and reserves entry plus exit fees", () => {
    const c = contract(), cfg = CommodityConfigSchema.parse({ assets: ["gold"] });
    const candidate = commodityCandidate(c, book(), cfg, NOW);
    expect(typeof candidate).toBe("object");
    if (typeof candidate === "string") return;
    expect(candidate.qHeld).toBeCloseTo(.605);
    expect(candidate.feePerContract).toBeCloseTo(commodityFee(.07, .51) + commodityFee(.07, .605));
    expect(candidate.netEdge).toBeCloseTo(.605 - .51 - candidate.feePerContract);
    expect(commodityCandidate(contract({ qYes: .61 }), book(), cfg, NOW)).toMatch(/insufficient edge/);
  });

  it.each([
    [{ verified: false }, {}, /unverified/], [{ forecastAt: NOW - 7 * 3_600_000 }, {}, /stale/],
    [{ settlementBasis: "" }, {}, /unverified/], [{ takerFeeRate: NaN }, {}, /fee/],
    [{ closeAt: NOW + 3_600_000 }, {}, /horizon/], [{}, { ts: NOW - 11_000 }, /stale/],
    [{}, { bids: [{ price: .51, size: 10_000 }] }, /spread/], [{}, { bids: [{ price: .49, size: 1 }] }, /depth/],
  ])("rejects invalid or uneconomic evidence %j", (c, b, reason) => {
    expect(commodityCandidate(contract(c), book(b), CommodityConfigSchema.parse({ assets: ["gold"] }), NOW)).toMatch(reason);
  });

  it("mirrors NO odds, depth and direction in the selected outcome", () => {
    const result = commodityCandidate(contract({ qYes: .27 }), book(), CommodityConfigSchema.parse({ assets: ["gold"] }), NOW);
    expect(result).toMatchObject({ side: "NO", bid: .49, ask: .51, rawQ: .73, direction: "down" });
    expect(commodityCandidate(contract({ strikeType: "between" }), book(), CommodityConfigSchema.parse({ assets: ["gold"] }), NOW)).toMatchObject({ direction: "range" });
  });

  it("does not treat price-outlook telemetry as an independent alpha vote", async () => {
    const h = harness(), first = await h.strategy.tick(h.ctx);
    h.snapshot.outlookDiagnostics = { gold: { direction: "collapse", impliedProbability: .001, confidence: 1 }, oil: { direction: "rally", confidence: 1 } };
    expect(await h.strategy.tick(h.ctx)).toEqual(first);
  });

  it("allocates across assets while counting overlapping gold strikes once", async () => {
    const h = harness();
    h.snapshot.contracts = [contract(), contract({ marketRef: "gold-b", qYes: .72 }), contract({ asset: "oil", marketRef: "oil-a", eventRef: "event-oil" }),
      contract({ asset: "btc", marketRef: "btc-a", eventRef: "event-btc", qYes: .27 }), contract({ asset: "copper", marketRef: "copper-a", eventRef: "event-copper", qYes: .27 })];
    const entries = (await h.strategy.tick(h.ctx)).filter(a => a.kind === "enter");
    expect(entries).toHaveLength(4);
    expect(entries.filter(a => a.provenance?.asset === "gold")).toHaveLength(1);
    expect(entries.reduce((sum, a) => sum + a.notional, 0)).toBeLessThanOrEqual(100);
  });

  it("starts with only oil and preserves the asset cap when no assets are configured", async () => {
    const h = harness(); h.ctx.config = {};
    h.snapshot.contracts = COMMODITY_ASSETS.map(asset => contract({ asset, marketRef: `${asset}-a`, eventRef: `event-${asset}` }));
    const entries = (await h.strategy.tick(h.ctx)).filter(a => a.kind === "enter");
    expect(entries.map(a => a.marketRef)).toEqual(["oil-a"]);
    expect(entries[0]!.notional).toBeLessThanOrEqual(25);
    expect(h.report().excluded.filter(r => r.reason === "asset disabled")).toHaveLength(4);
  });

  it("reserves forecast fees inside gross portfolio limits", async () => {
    const h = harness({ grossCapPct: .5 });
    h.snapshot.contracts.push(contract({ asset: "oil", marketRef: "oil-a", eventRef: "event-oil" }));
    const entries = (await h.strategy.tick(h.ctx)).filter(a => a.kind === "enter");
    const report = h.report();
    const commitment = entries.reduce((sum, a) => { const c = report.candidates.find(c => c.contract.marketRef === a.marketRef)!; return sum + a.notional * (1 + c.feePerContract / c.ask); }, 0);
    expect(commitment).toBeLessThanOrEqual(5);
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(["BUY", "SELL"] as const)("blocks a second strike while a %s execution owns that underlying", async side => {
    const h = harness();
    h.snapshot.contracts = [contract({ marketRef: "gold-b" })];
    h.ctx.execution!.parents = [parent({ side, reservedNotionalUsd: side === "BUY" ? 10 : 0 })];
    expect((await h.strategy.tick(h.ctx)).filter(a => a.kind === "enter")).toEqual([]);
  });

  it("counts partial fills and outstanding orders once, and holds the asset during delayed inventory", async () => {
    const h = harness();
    h.ctx.positions = [{ marketRef: "gold-a", side: "YES", size: 10, avgPrice: .5 }];
    h.ctx.execution!.parents = [parent({ filledSize: 20, filledNotionalUsd: 10, reservedNotionalUsd: 10 })];
    h.snapshot.contracts.push(contract({ marketRef: "gold-b" }), contract({ asset: "oil", marketRef: "oil-a", eventRef: "event-oil" }));
    const entries = (await h.strategy.tick(h.ctx)).filter(a => a.kind === "enter");
    expect(entries.map(a => a.marketRef)).toEqual(["oil-a"]);
    h.ctx.positions = [];
    h.ctx.execution!.parents = [parent({ status: "completed", filledSize: 20, filledNotionalUsd: 10, lastFillAt: NOW - 1000, reservedNotionalUsd: 0 })];
    expect((await h.strategy.tick(h.ctx)).filter(a => a.kind === "enter").map(a => a.marketRef)).toEqual(["oil-a"]);
  });

  it("disables additions for stale research, unclassified positions, external orders and blocked execution", async () => {
    const stale = harness(); stale.snapshot.receivedAt = NOW - 400_000;
    const unknown = harness(); unknown.ctx.positions = [{ marketRef: "foreign", side: "YES", size: 1, avgPrice: .5 }];
    const external = harness(); external.ctx.openOrders = [{ id: "foreign", marketRef: "gold-a", side: "BUY", size: 1, filledSize: 0, price: .5, status: "open" }];
    const blocked = harness(); blocked.ctx.execution!.blocked = true;
    for (const h of [stale, unknown, external, blocked]) expect((await h.strategy.tick(h.ctx)).filter(a => a.kind === "enter")).toEqual([]);
  });

  it("preserves held settlement evidence across strategy recreation and exits after rules change", async () => {
    const h = harness(); h.ctx.positions = [{ marketRef: "gold-a", side: "YES", size: 5, avgPrice: .5 }];
    await h.strategy.tick(h.ctx);
    h.snapshot.contracts[0]!.rulesHash = "new-rules";
    const actions = await new KalshiCommoditiesStrategy().tick(h.ctx);
    expect(actions).toContainEqual(expect.objectContaining({ kind: "exit", marketRef: "gold-a", urgent: true, reason: "settlement terms changed" }));
  });

  it("holds through missing Q and closed settlement without inventing an exit", async () => {
    const h = harness(); h.ctx.positions = [{ marketRef: "gold-a", side: "YES", size: 5, avgPrice: .5 }];
    await h.strategy.tick(h.ctx); h.snapshot.contracts = [];
    expect((await h.strategy.tick(h.ctx)).filter(a => a.kind === "exit")).toEqual([]);
    h.snapshot.contracts = [contract({ closeAt: NOW - 1000, rulesHash: "closed-hash" })];
    expect((await h.strategy.tick(h.ctx)).filter(a => a.kind === "exit")).toEqual([]);
  });

  it("latches drawdown, cancels outstanding additions and cannot reset on a new strategy instance", async () => {
    const h = harness(); await h.strategy.tick(h.ctx);
    h.ctx.execution!.parents = [parent()]; h.cash(900);
    const actions = await h.strategy.tick(h.ctx);
    expect(h.report().halted).toBe(true);
    expect(actions).toContainEqual(expect.objectContaining({ kind: "cancel", marketRef: "gold-a" }));
    h.cash(1000); await new KalshiCommoditiesStrategy().tick(h.ctx);
    expect(h.report().halted).toBe(true);
    expect(h.memory.has(COMMODITY_LEDGER_KEY)).toBe(true);
  });

  it("preserves valid subcent ask bounds for marketable limits", async () => {
    const h = harness(); h.books.set("gold-a", book({ asks: [{ price: .515, size: 10_000 }] }));
    expect(await h.strategy.tick(h.ctx)).toContainEqual(expect.objectContaining({ kind: "enter", limitPrice: .515 }));
  });
});

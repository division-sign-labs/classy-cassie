// packages/core/src/venues/fixture.ts
// Paper venue driven by a books fixture (fixtures/books.json). Powers the
// offline e2e (§7, acceptance 6–7): thin fixture books make capacity capping
// visible, and fills/positions are simulated in memory.

import { z } from "zod";
import type {
  AwaitFundingOpts,
  Balance,
  BookLevel,
  Candle,
  CandleInterval,
  Fill,
  FundingInstructions,
  Order,
  OrderAck,
  OrderBook,
  OrderIntent,
  Position,
  PositionSide,
  Quote,
  SetupContext,
  VenueAccount,
  VenueAdapter,
} from "../types.js";
import { mirrorBookForNo } from "../engine/mirror.js";

const LevelSchema = z.tuple([z.number(), z.number()]);
export const BooksFixtureSchema = z.object({
  collateral: z.number().default(1000),
  markets: z.record(
    z.string(),
    z.object({
      name: z.string().optional(),
      volume24h: z.number().default(50_000),
      book: z.object({ bids: z.array(LevelSchema), asks: z.array(LevelSchema) }),
      candles: z
        .array(z.object({ ts: z.number(), open: z.number(), high: z.number(), low: z.number(), close: z.number() }))
        .optional(),
      fundingRate8h: z.number().optional(),
    }),
  ),
});
export type BooksFixture = z.output<typeof BooksFixtureSchema>;

interface SimPosition {
  side: PositionSide;
  size: number;
  avgPrice: number;
}

export class FixtureVenue implements VenueAdapter {
  readonly id = "fixture" as const;
  readonly verifiedAgainst = "n/a (offline fixture)";
  readonly supportsNativeTriggers = false;

  private collateral: number;
  private readonly fixture: BooksFixture;
  private readonly positionsByRef = new Map<string, SimPosition>();
  private readonly restingOrders = new Map<string, Order & { outcome?: "YES" | "NO"; placedAt: number }>();
  private readonly fillLog: Fill[] = [];
  private lastFillTs = 0;
  private orderCounter = 0;
  private readonly now: () => number;

  constructor(fixtureJson: string | BooksFixture, now: () => number = () => Date.now()) {
    this.fixture = typeof fixtureJson === "string" ? BooksFixtureSchema.parse(JSON.parse(fixtureJson)) : fixtureJson;
    this.collateral = this.fixture.collateral;
    this.now = now;
  }

  private market(ref: string) {
    const m = this.fixture.markets[ref];
    if (!m) throw new Error(`fixture has no market ${ref}`);
    return m;
  }

  async setup(_ctx: SetupContext): Promise<VenueAccount> {
    return { venue: "fixture", address: "0xF1XTURE" };
  }

  async fundingInstructions(): Promise<FundingInstructions> {
    return {
      venue: "fixture",
      addresses: [{ chain: "none", address: "0xF1XTURE", asset: "USD", minimum: 0 }],
      summary: "Fixture venue is pre-funded in memory; nothing to send.",
    };
  }

  async awaitFunding(_acct: VenueAccount, _opts?: AwaitFundingOpts): Promise<Balance> {
    return { asset: "USD", total: this.collateral, available: this.collateral };
  }

  async balances(): Promise<Balance[]> {
    return [{ asset: "USD", total: this.collateral, available: this.collateral }];
  }

  async positions(): Promise<Position[]> {
    return [...this.positionsByRef.entries()]
      .filter(([, p]) => p.size > 1e-9)
      .map(([marketRef, p]) => ({
        marketRef,
        side: p.side,
        size: p.size,
        avgPrice: p.avgPrice,
        label: this.fixture.markets[marketRef]?.name,
      }));
  }

  async book(marketRef: string): Promise<OrderBook> {
    const m = this.market(marketRef);
    const toLevels = (ls: [number, number][]): BookLevel[] => ls.map(([price, size]) => ({ price, size }));
    return { marketRef, bids: toLevels(m.book.bids), asks: toLevels(m.book.asks), ts: this.now() };
  }

  async quote(marketRef: string): Promise<Quote> {
    const b = await this.book(marketRef);
    const bid = b.bids[0]?.price ?? 0;
    const ask = b.asks[0]?.price ?? 1;
    const mid = (bid + ask) / 2;
    return {
      marketRef,
      bid,
      ask,
      mid,
      volume24h: this.market(marketRef).volume24h,
      spreadBps: mid > 0 ? ((ask - bid) / mid) * 10_000 : 0,
      ts: this.now(),
    };
  }

  async eventRef(marketRef: string): Promise<string> {
    return `fixture:${marketRef}`;
  }

  async candles(marketRef: string, _interval: CandleInterval, lookback: number): Promise<Candle[]> {
    const m = this.market(marketRef);
    if (m.candles) return m.candles;
    // Synthesize flat candles around mid so ATR-based flows run offline.
    const q = await this.quote(marketRef);
    const out: Candle[] = [];
    for (let i = 0; i < lookback + 5; i++) {
      const wiggle = q.mid * 0.01;
      out.push({ ts: this.now() - (lookback + 5 - i) * 3_600_000, open: q.mid, high: q.mid + wiggle, low: q.mid - wiggle, close: q.mid });
    }
    return out;
  }

  async fundingRate(_marketRef: string): Promise<number> {
    return 0.0001;
  }

  async placeOrder(_acct: VenueAccount, intent: OrderIntent): Promise<OrderAck> {
    const id = `fx-${++this.orderCounter}`;
    let book = await this.book(intent.marketRef);
    if (intent.outcome === "NO") book = mirrorBookForNo(book);

    // Walk the book: fill whatever crosses the limit, rest the remainder (GTC).
    const levels = intent.side === "BUY" ? book.asks : book.bids;
    let remaining = intent.size;
    let filledNotional = 0;
    let filledSize = 0;
    for (const lvl of levels) {
      const crosses = intent.side === "BUY" ? lvl.price <= intent.limitPrice : lvl.price >= intent.limitPrice;
      if (!crosses || remaining <= 1e-9) break;
      const take = Math.min(remaining, lvl.size);
      filledSize += take;
      filledNotional += take * lvl.price;
      remaining -= take;
    }

    if (filledSize > 0) {
      const avg = filledNotional / filledSize;
      this.applyFill(intent, filledSize, avg);
      // Strictly monotonic ts: the engine's fill cursor is `last ts + 1`, so a
      // fill sharing a millisecond with the previous tick's would never surface.
      this.lastFillTs = Math.max(this.now(), this.lastFillTs + 1);
      this.fillLog.push({
        id: `fill-${id}`,
        orderId: id,
        marketRef: intent.marketRef,
        side: intent.side,
        size: filledSize,
        price: avg,
        ts: this.lastFillTs,
      });
    }
    if (remaining > 1e-9 && (intent.tif === "GTC" || intent.tif === "GTD")) {
      this.restingOrders.set(id, {
        id,
        clientId: intent.clientId,
        marketRef: intent.marketRef,
        outcome: intent.outcome,
        side: intent.side,
        size: intent.size,
        filledSize,
        price: intent.limitPrice,
        tif: intent.tif,
        status: filledSize > 0 ? "partial" : "open",
        createdAt: this.now(),
        placedAt: this.now(),
      });
    }
    const status = remaining <= 1e-9 ? "filled" : filledSize > 0 ? "partial" : intent.tif === "GTC" || intent.tif === "GTD" ? "open" : "canceled";
    return { orderId: id, clientId: intent.clientId, status, filledSize, avgFillPrice: filledSize > 0 ? filledNotional / filledSize : undefined };
  }

  private applyFill(intent: OrderIntent, size: number, price: number): void {
    const posSide: PositionSide = intent.outcome ?? (intent.side === "BUY" ? "LONG" : "SHORT");
    const existing = this.positionsByRef.get(intent.marketRef);
    const opening =
      !existing ||
      (intent.outcome !== undefined ? intent.side === "BUY" && existing.side === posSide : existing.side === posSide);

    if (intent.outcome !== undefined) {
      // Prediction market: BUY adds to the outcome position, SELL reduces it.
      if (intent.side === "BUY") {
        this.collateral -= size * price;
        if (existing && existing.side === (intent.outcome as PositionSide)) {
          const newSize = existing.size + size;
          existing.avgPrice = (existing.avgPrice * existing.size + price * size) / newSize;
          existing.size = newSize;
        } else {
          this.positionsByRef.set(intent.marketRef, { side: intent.outcome, size, avgPrice: price });
        }
      } else {
        this.collateral += size * price;
        if (existing) {
          existing.size = Math.max(0, existing.size - size);
          if (existing.size <= 1e-9) this.positionsByRef.delete(intent.marketRef);
        }
      }
      return;
    }

    // Perps-style: signed position per market.
    if (opening) {
      if (existing) {
        const newSize = existing.size + size;
        existing.avgPrice = (existing.avgPrice * existing.size + price * size) / newSize;
        existing.size = newSize;
      } else {
        this.positionsByRef.set(intent.marketRef, { side: posSide, size, avgPrice: price });
      }
    } else if (existing) {
      const closed = Math.min(existing.size, size);
      const pnl = (existing.side === "LONG" ? price - existing.avgPrice : existing.avgPrice - price) * closed;
      this.collateral += pnl;
      existing.size -= closed;
      if (existing.size <= 1e-9) this.positionsByRef.delete(intent.marketRef);
    }
  }

  async cancelOrder(_acct: VenueAccount, id: string): Promise<void> {
    this.restingOrders.delete(id);
  }

  async cancelAll(): Promise<void> {
    this.restingOrders.clear();
  }

  async openOrders(): Promise<Order[]> {
    return [...this.restingOrders.values()];
  }

  async fills(_acct: VenueAccount, sinceTs: number): Promise<Fill[]> {
    return this.fillLog.filter((f) => f.ts >= sinceTs);
  }

  async redeem(_acct: VenueAccount, position: Position): Promise<undefined> {
    // Fixture resolution: winner redeems at 1.0.
    this.collateral += position.size * 1.0;
    this.positionsByRef.delete(position.marketRef);
    return undefined;
  }
}

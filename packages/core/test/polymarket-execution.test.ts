// packages/core/test/polymarket-execution.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { VenueUrlsSchema, type OrderIntent, type VenueAccount } from "@quotient-forecasting/cassie-core";
import { PolymarketAdapter } from "../src/venues/polymarket.js";
import { UnexpectedResponseError } from "@polymarket/client";
import { z } from "zod";

const account: VenueAccount = { venue: "polymarket", signerAddress: "0x1", funder: "0x2", signatureType: 3 };
const tokens = [{ tokenId: "yes", outcome: "Yes" }, { tokenId: "no", outcome: "No" }];
const rawBook = (tokenId = "yes", tickSize = 0.01) => ({
  tokenId, conditionId: "condition", tickSize, minOrderSize: "1", timestamp: "1",
  bids: [{ price: "0.42", size: "100" }, { price: "0.48", size: "20" }],
  asks: [{ price: "0.56", size: "100" }, { price: "0.52", size: "20" }],
});

function adapterWith(client: Record<string, unknown>, book = rawBook()) {
  // Obsolete options must never reactivate per-order attribution.
  const opts = { urls: VenueUrlsSchema.parse({}), builderCode: "obsolete" };
  const adapter = new PolymarketAdapter(opts);
  const internals = adapter as unknown as {
    secure: () => Promise<unknown>;
    pub: () => unknown;
    tokenFor: (market: string, side?: string) => Promise<string>;
    marketInfoForToken: () => Promise<unknown>;
    tokenForIntent: () => Promise<unknown>;
    conditionalAllowanceSynced: Set<string>;
  };
  internals.secure = async () => client;
  internals.pub = () => ({ fetchOrderBook: vi.fn(async () => book) });
  internals.tokenFor = async (_market, outcome) => outcome === "NO" ? "no" : "yes";
  internals.marketInfoForToken = async () => ({ conditionId: "condition", info: { tickSize: 0.1, tokens } });
  internals.tokenForIntent = async () => ({ tokenId: book.tokenId, conditionId: "condition", info: { tickSize: 0.1, tokens } });
  internals.conditionalAllowanceSynced.add(book.tokenId);
  return adapter;
}

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return { marketRef: "yes", side: "BUY", outcome: "YES", size: 10, limitPrice: 0.5, tif: "GTC", postOnly: true, clientId: "child", ...overrides };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Polymarket execution metadata", () => {
  it("reads fresh exact NO constraints and prices from one book rather than cached YES data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [{ acceptingOrders: true, volume24hr: 5000 }] })));
    const book = rawBook("no", 0.0025);
    const adapter = adapterWith({}, book);
    const result = await adapter.executionMarket("yes", "NO");
    expect(result).toMatchObject({ marketRef: "yes", tokenId: "no", outcome: "NO", tickSize: 0.0025, minOrderSize: 1, acceptingOrders: true });
    expect(result.quote).toMatchObject({ bid: 0.48, ask: 0.52, mid: 0.5, volume24h: 5000 });
    expect(result.book.bids[0]?.price).toBe(0.48);
    book.tickSize = 0.001;
    expect((await adapter.executionMarket("yes", "NO")).tickSize).toBe(0.001);
  });

  it("fails closed on a sibling book or missing trading constraints", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [{ acceptingOrders: true }] })));
    await expect(adapterWith({}, rawBook("yes")).executionMarket("yes", "NO")).rejects.toThrow("identity");
    await expect(adapterWith({}, { ...rawBook("no"), minOrderSize: "NaN" }).executionMarket("yes", "NO")).rejects.toThrow("constraints");
  });

  it("preserves book observation time when Gamma returns twenty seconds later", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let releaseGamma!: () => void;
    const gammaReady = new Promise<void>(resolve => { releaseGamma = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await gammaReady;
      return { ok: true, json: async () => [{ acceptingOrders: true }] };
    }));
    let markBookRead!: () => void;
    const bookRead = new Promise<void>(resolve => { markBookRead = resolve; });
    const adapter = adapterWith({});
    (adapter as unknown as { pub: () => unknown }).pub = () => ({ fetchOrderBook: async () => { markBookRead(); return rawBook(); } });
    const pending = adapter.executionMarket("yes", "YES");
    await bookRead;
    await Promise.resolve();
    now += 20000;
    releaseGamma();
    const result = await pending;
    expect(result.book.ts).toBe(1000);
    expect(result.quote.ts).toBe(1000);
    expect(result.observedAt).toBe(1000);
    expect(now - result.book.ts).toBe(20000);
  });

  it("retains an executable bid when the token has no asks", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [{ acceptingOrders: true }] })));
    const result = await adapterWith({}, { ...rawBook(), asks: [] }).executionMarket("yes", "YES");
    expect(result.book.bids[0]?.price).toBe(.48);
    expect(result.book.asks).toEqual([]);
  });
});

describe("Polymarket submission bounds and certainty", () => {
  it.each([ ["BUY", 0.5025], ["SELL", 0.505] ] as const)("preserves %s bounds across a fresh fractional tick", async (side, price) => {
    const createLimitOrder = vi.fn(async () => ({ sdkSigned: true }));
    const postOrder = vi.fn(async () => ({ ok: true, orderId: "order", status: "live" }));
    const onPrepared = vi.fn(async () => {});
    await adapterWith({ createLimitOrder, postOrder }, rawBook("yes", 0.0025)).placeOrderWithLifecycle(account,
      intent({ side, limitPrice: 0.503, size: 10.257 }), { onPrepared });
    expect(createLimitOrder).toHaveBeenCalledWith(expect.objectContaining({ price }));
    expect(createLimitOrder.mock.calls[0]?.[0]).not.toHaveProperty("builderCode");
    expect(onPrepared).toHaveBeenCalledWith(expect.objectContaining({ limitPrice: price, size: 10.25 }));
  });

  it.each(["BUY", "SELL"] as const)("omits attribution from bounded FAK %s orders", async (side) => {
    const createMarketOrder = vi.fn(async () => ({ sdkSigned: true }));
    const postOrder = vi.fn(async () => ({ ok: true, orderId: "order", status: "matched" }));
    await adapterWith({ createMarketOrder, postOrder }).placeOrder(account, intent({ side, tif: "FAK", postOnly: false }));
    expect(createMarketOrder.mock.calls[0]?.[0]).not.toHaveProperty("builderCode");
  });

  it("rejects stale minimum quantities before signing", async () => {
    const createLimitOrder = vi.fn();
    await expect(adapterWith({ createLimitOrder }, { ...rawBook(), minOrderSize: "15" }).placeOrder(account, intent())).rejects.toThrow("minimum");
    expect(createLimitOrder).not.toHaveBeenCalled();
  });

  it("persists preparation before explicit post-only rejection and distinguishes uncertain responses", async () => {
    const events: string[] = [];
    const adapter = adapterWith({ createLimitOrder: async () => ({ sdkSigned: true }), postOrder: async () => {
      events.push("post"); return { ok: false, code: "INVALID_POST_ONLY_ORDER", message: "post-only order crosses" };
    } });
    await expect(adapter.placeOrderWithLifecycle(account, intent(), { onPrepared: async () => { events.push("prepared"); } }))
      .rejects.toMatchObject({ submissionRejected: true, postOnlyRejected: true });
    expect(events).toEqual(["prepared", "post"]);
    const lost = new Error("connection lost after POST");
    await expect(adapterWith({ createLimitOrder: async () => ({}), postOrder: async () => { throw lost; } }).placeOrder(account, intent()))
      .rejects.toBe(lost);
    expect(lost).not.toHaveProperty("submissionRejected");
    await expect(adapterWith({ createLimitOrder: async () => ({}), postOrder: async () => ({ ok: true }) }).placeOrder(account, intent()))
      .rejects.not.toHaveProperty("submissionRejected");
  });
});

describe("Polymarket authenticated reconciliation", () => {
  it("recognizes the pinned SDK's 200/null response without swallowing other invalid payloads", async () => {
    const schema = z.object({ id: z.string() });
    for (const payload of [null, [], "unavailable", { id: 1 }]) {
      const cause = schema.safeParse(payload).error!;
      const error = new UnexpectedResponseError("invalid response", { cause });
      const read = adapterWith({ fetchOrder: async () => { throw error; } }).executionOrder(account, "order");
      if (payload === null) await expect(read).resolves.toBeNull();
      else await expect(read).rejects.toBe(error);
    }
  });
  it.each([["LIVE", "open"], ["MATCHED", "matched"], ["CANCELED", "canceled"], ["ORDER_STATUS_CANCELED_MARKET_RESOLVED", "canceled"], ["EXPIRED", "expired"], ["UNRECOGNIZED", "unknown"]])
  ("normalizes %s while preserving cumulative matches", async (venueStatus, status) => {
    const adapter = adapterWith({ fetchOrder: async () => ({ id: "order", originalSize: "10", sizeMatched: "3.25", status: venueStatus }) });
    expect(await adapter.executionOrder(account, "order")).toMatchObject({ orderId: "order", status, size: 10, matchedSize: 3.25 });
  });

  it("treats authenticated 404 as missing and refuses invalid quantities", async () => {
    const adapter = adapterWith({ fetchOrder: async () => { throw { name: "RequestRejectedError", status: 404 }; } });
    expect(await adapter.executionOrder(account, "order")).toBeNull();
    await expect(adapterWith({ fetchOrder: async () => ({ id: "order", originalSize: "10", sizeMatched: "12", status: "CANCELED" }) }).executionOrder(account, "order"))
      .rejects.toThrow("quantities");
  });

  it("does not promote already-matched or unacknowledged cancellation to success", async () => {
    const adapter = adapterWith({ cancelOrder: async () => ({ canceled: [], notCanceled: { order: "order already matched" } }) });
    expect(await adapter.cancelOrderChecked(account, "order")).toEqual({ status: "not-canceled", reason: "order already matched" });
    await expect(adapter.cancelOrder(account, "order")).rejects.toThrow("unconfirmed");
    expect(await adapterWith({ cancelOrder: async () => ({ canceled: ["order"], notCanceled: {} }) }).cancelOrderChecked(account, "order"))
      .toEqual({ status: "canceled" });
    await expect(adapterWith({ cancelOrder: async () => ({ canceled: [], notCanceled: {} }) }).cancelOrder(account, "order"))
      .rejects.toThrow("unconfirmed");
  });
});

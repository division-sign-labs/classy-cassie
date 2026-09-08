// packages/core/test/polymarket-order-size.test.ts

import { describe, expect, it, vi } from "vitest";
import { PolymarketAdapter, VenueUrlsSchema, normalizePolymarketOrderSize } from "@quotient-forecasting/cassie-core";

describe("Polymarket executable order quantity", () => {
  it.each([
    [10.257231115384615, 10.25],
    [11.765647455882352, 11.76],
    [5.40583802027027, 5.4],
    [6.3497145, 6.34],
    [1.15, 1.15],
    [4.64, 4.64],
    [1.1499999999999997, 1.14],
    [1e-7, 0],
    [0, 0],
  ])("normalizes %s to %s without changing it a second time", (size, expected) => {
    expect(normalizePolymarketOrderSize(size)).toBe(expected);
    expect(normalizePolymarketOrderSize(expected)).toBe(expected);
    expect(expected).toBeLessThanOrEqual(size);
  });

  it.each([NaN, Infinity, -1])("rejects invalid size %s", (size) => {
    expect(() => normalizePolymarketOrderSize(size)).toThrow("invalid Polymarket order size");
  });

  it("signs exactly the normalized quantity the controller reserved", async () => {
    const adapter = new PolymarketAdapter({ urls: VenueUrlsSchema.parse({}) });
    const signed = { test: "SDK-created payload" };
    const createLimitOrder = vi.fn(async () => signed);
    const postOrder = vi.fn(async () => ({ ok: true, orderId: "order-1", status: "live" }));
    const internal = adapter as unknown as {
      secure: () => Promise<unknown>;
      tokenForIntent: () => Promise<unknown>;
      pub: () => unknown;
    };
    internal.secure = async () => ({ createLimitOrder, postOrder });
    internal.tokenForIntent = async () => ({ tokenId: "yes-token", conditionId: "condition", info: { tickSize: 0.01 } });
    internal.pub = () => ({ fetchOrderBook: async () => ({ tokenId: "yes-token", conditionId: "condition", tickSize: 0.01, minOrderSize: "1" }) });
    const size = adapter.normalizeOrderSize(1.159);
    const onPrepared = vi.fn(async () => {});
    await adapter.placeOrderWithLifecycle({ venue: "polymarket", signerAddress: "0x1", funder: "0x2", signatureType: 3 }, {
      marketRef: "yes-token", clientId: "test-1", outcome: "YES", side: "BUY", size,
      limitPrice: 0.5, tif: "GTC", postOnly: true,
    }, { onPrepared });
    expect(size).toBe(1.15);
    expect(createLimitOrder).toHaveBeenCalledWith(expect.objectContaining({ size: 1.15 }));
    expect(onPrepared).toHaveBeenCalledOnce();
    expect(postOrder).toHaveBeenCalledWith(signed);
  });
});

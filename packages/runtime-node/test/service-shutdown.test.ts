// packages/runtime-node/test/service-shutdown.test.ts
// Strict market-make shutdown cancellation must be independently confirmed by
// the venue's authoritative open-orders view.

import { describe, expect, it, vi } from "vitest";
import type { Order, VenueAccount } from "@quotient-forecasting/cassie-core";
import { cancelAndVerifyMarketMakeOrders } from "../src/service.js";

const account: VenueAccount = {
  venue: "polymarket",
  signerAddress: "0x0000000000000000000000000000000000000001",
  funder: "0x0000000000000000000000000000000000000002",
  signatureType: 3,
};

function openOrder(id: string): Order {
  return {
    id,
    marketRef: "yes-token",
    side: "BUY",
    size: 10,
    filledSize: 0,
    price: 0.4,
    status: "open",
  };
}

describe("market-make service shutdown cancellation", () => {
  it("returns a verified structured result only after cancel and an empty authoritative read", async () => {
    const cancelAll = vi.fn().mockResolvedValue(undefined);
    const openOrders = vi.fn().mockResolvedValue([]);

    await expect(cancelAndVerifyMarketMakeOrders({ cancelAll, openOrders }, account)).resolves.toEqual({
      method: "market-make-venue",
      requested: true,
      completed: true,
      verifiedOpenOrders: true,
      remainingOpenOrders: 0,
    });
    expect(cancelAll).toHaveBeenCalledOnce();
    expect(openOrders).toHaveBeenCalledOnce();
  });

  it("does not swallow cancelAll failure and still performs the authoritative read", async () => {
    const cancelAll = vi.fn().mockRejectedValue(new Error("venue cancellation unavailable"));
    const openOrders = vi.fn().mockResolvedValue([]);

    await expect(cancelAndVerifyMarketMakeOrders({ cancelAll, openOrders }, account)).rejects.toThrow(
      /cancelAll failed: venue cancellation unavailable/,
    );
    expect(openOrders).toHaveBeenCalledOnce();
  });

  it("fails when any venue order remains after a successful cancelAll", async () => {
    const cancelAll = vi.fn().mockResolvedValue(undefined);
    const openOrders = vi.fn().mockResolvedValue([openOrder("still-open")]);

    await expect(cancelAndVerifyMarketMakeOrders({ cancelAll, openOrders }, account)).rejects.toThrow(
      /found 1 resting order/,
    );
  });
});

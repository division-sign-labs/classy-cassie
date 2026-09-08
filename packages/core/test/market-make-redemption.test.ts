// packages/core/test/market-make-redemption.test.ts
// Polymarket resolution metadata used by the market-make settlement lifecycle.

import { describe, expect, it, vi } from "vitest";
import {
  parseBotConfig,
  type Position,
} from "@quotient-forecasting/cassie-core";
import { PolymarketAdapter } from "../src/venues/polymarket.js";

const YES_TOKEN = "7132104519000000000000000000000000000000000000000000000000000001";
const NO_TOKEN = "7132104519000000000000000000000000000000000000000000000000000002";

const account = {
  venue: "polymarket" as const,
  signerAddress: "0x0000000000000000000000000000000000000001",
  funder: "0x0000000000000000000000000000000000000002",
  signatureType: 3,
};

function adapterWithSecureClient(client: unknown): PolymarketAdapter {
  const adapter = new PolymarketAdapter({
    urls: parseBotConfig({ id: "redemption-test", venue: "polymarket" }).venueUrls,
    creds: {
      venue: "polymarket",
      signerPk: "0x00",
      funder: account.funder,
      signatureType: 3,
      l2: { apiKey: "k", secret: "s", passphrase: "p" },
    },
  });
  const inner = adapter as unknown as {
    secure: () => Promise<unknown>;
    marketInfoForToken: (tokenId: string) => Promise<unknown>;
  };
  inner.secure = async () => client;
  inner.marketInfoForToken = async () => ({
    conditionId: "0xCONDITION",
    info: {
      tickSize: "0.01",
      tokens: [
        { tokenId: YES_TOKEN, outcome: "Yes" },
        { tokenId: NO_TOKEN, outcome: "No" },
      ],
    },
  });
  return adapter;
}

describe("Polymarket market-make redemption metadata", () => {
  it("maps a finite venue curPrice into held-outcome currentPrice, including zero", async () => {
    const adapter = adapterWithSecureClient({
      async *listPositions() {
        yield {
          items: [
            { tokenId: YES_TOKEN, size: "2", avgPrice: "0.4", curPrice: "1", redeemable: true },
            { tokenId: NO_TOKEN, size: "4", avgPrice: "0.3", curPrice: "0", redeemable: true },
          ],
        };
      },
    });

    const positions = await adapter.positions(account);
    expect(positions).toHaveLength(2);
    expect(positions[0]).toMatchObject({
      marketRef: YES_TOKEN,
      tokenId: YES_TOKEN,
      conditionId: "0xCONDITION",
      outcome: "YES",
      currentPrice: 1,
      unrealizedPnl: 1.2,
    });
    expect(positions[1]).toMatchObject({
      marketRef: YES_TOKEN,
      tokenId: NO_TOKEN,
      outcome: "NO",
      currentPrice: 0,
      unrealizedPnl: -1.2,
    });
  });

  it("returns only the SDK's public settled transaction identifiers", async () => {
    const adapter = adapterWithSecureClient({
      redeemPositions: async () => ({
        wait: async () => ({ transactionHash: "0xabc123", transactionId: "relay-123" }),
      }),
    });
    const position: Position = {
      marketRef: YES_TOKEN,
      tokenId: YES_TOKEN,
      conditionId: "0xCONDITION",
      outcome: "YES",
      side: "YES",
      size: 2,
      avgPrice: 0.4,
      currentPrice: 1,
      redeemable: true,
    };

    await expect(adapter.redeem(account, position)).resolves.toEqual({
      transactionHash: "0xabc123",
      transactionId: "relay-123",
    });
  });

  it.each(["YES", "NO"] as const)("delegates %s inventory to one market-type-aware condition redemption for both outcomes", async (outcome) => {
    const wait = vi.fn().mockResolvedValue({ transactionHash: "0xredeem", transactionId: null });
    const redeemPositions = vi.fn().mockResolvedValue({ wait });
    const adapter = adapterWithSecureClient({ redeemPositions });
    const position: Position = {
      marketRef: YES_TOKEN, tokenId: outcome === "YES" ? YES_TOKEN : NO_TOKEN, conditionId: "0xcondition",
      outcome, side: outcome, size: 2, avgPrice: 0.4, redeemable: true,
    };
    await expect(adapter.redeem(account, position)).resolves.toEqual({ transactionHash: "0xredeem" });
    expect(redeemPositions).toHaveBeenCalledExactlyOnceWith({ conditionId: "0xCONDITION" });
    expect(wait).toHaveBeenCalledOnce();
    // Passing a token, amount, adapter address, or index-set implementation
    // here would bypass the pinned client's market-aware position workflow.
    expect(Object.keys(redeemPositions.mock.calls[0]![0])).toEqual(["conditionId"]);
  });

  it("rejects a mismatched condition before submitting a redemption", async () => {
    const redeemPositions = vi.fn();
    const adapter = adapterWithSecureClient({ redeemPositions });
    await expect(adapter.redeem(account, {
      marketRef: YES_TOKEN, conditionId: "0xWRONG", outcome: "YES", side: "YES", size: 2, avgPrice: 0.4,
    })).rejects.toThrow(/condition does not match/);
    expect(redeemPositions).not.toHaveBeenCalled();
  });

  it("propagates an ambiguous submission failure without automatically resubmitting", async () => {
    const failure = new Error("submission connection lost");
    const redeemPositions = vi.fn().mockRejectedValue(failure);
    const adapter = adapterWithSecureClient({ redeemPositions });
    await expect(adapter.redeem(account, {
      marketRef: YES_TOKEN, outcome: "YES", side: "YES", size: 2, avgPrice: 0.4,
    })).rejects.toBe(failure);
    expect(redeemPositions).toHaveBeenCalledOnce();
  });

  it("propagates a confirmation failure without treating it as proof that submission failed", async () => {
    const failure = new Error("transaction confirmation timed out");
    const wait = vi.fn().mockRejectedValue(failure);
    const redeemPositions = vi.fn().mockResolvedValue({ wait });
    const adapter = adapterWithSecureClient({ redeemPositions });
    await expect(adapter.redeem(account, {
      marketRef: YES_TOKEN, outcome: "YES", side: "YES", size: 2, avgPrice: 0.4,
    })).rejects.toBe(failure);
    expect(redeemPositions).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
  });
});

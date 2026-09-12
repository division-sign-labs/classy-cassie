// packages/core/test/polymarket-token-balance.test.ts
// Balance-allowance refreshes stay inside the venue's 50-per-10-s limit, account
// reads inside one pass share a request, and an explicit 429 puts a family on cooldown.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolymarketAdapter } from "../src/venues/polymarket.js";
import { VenueRateLimitedError } from "../src/venues/transient.js";
import { VenueUrlsSchema } from "../src/config.js";
import type { VenueAccount } from "../src/types.js";

const sdk = vi.hoisted(() => ({ balanceAllowance: vi.fn(), updateBalanceAllowance: vi.fn() }));
vi.mock("@polymarket/client/actions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@polymarket/client/actions")>(),
  fetchBalanceAllowance: sdk.balanceAllowance,
  updateBalanceAllowance: sdk.updateBalanceAllowance,
}));

const account: VenueAccount = {
  venue: "polymarket", signerAddress: "0x1111111111111111111111111111111111111111",
  funder: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", signatureType: 3,
};
const START = Date.parse("2026-09-09T12:00:00.000Z");

function pages<T>(...items: T[][]) {
  return {
    [Symbol.asyncIterator]: async function* () { for (const page of items) yield { items: page }; },
    firstPage: async () => ({ items: items[0] ?? [] }),
  };
}

function fixture(rows: Record<string, unknown>[] = []) {
  const client = { listPositions: vi.fn(() => pages(rows)) };
  const adapter = new PolymarketAdapter({ urls: VenueUrlsSchema.parse({}) });
  (adapter as unknown as { secure: () => Promise<unknown> }).secure = async () => client;
  return { adapter, client };
}

const rateLimited = (retryAfter = 2) => Object.assign(new Error("Request was rate limited"), { name: "RateLimitError", retryAfter });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  sdk.balanceAllowance.mockReset().mockResolvedValue({ balance: "5000000", allowances: {} });
  sdk.updateBalanceAllowance.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

describe("token balance refresh throttle", () => {
  it("re-syncs on the first read, reuses the sync for thirty seconds, then re-syncs", async () => {
    const { adapter } = fixture();
    await expect(adapter.tokenBalance(account, "yes")).resolves.toBe(5);
    expect(sdk.updateBalanceAllowance).toHaveBeenCalledTimes(1);
    vi.setSystemTime(START + 10_000);
    await adapter.tokenBalance(account, "yes");
    expect(sdk.updateBalanceAllowance).toHaveBeenCalledTimes(1);
    expect(sdk.balanceAllowance).toHaveBeenCalledTimes(2);
    vi.setSystemTime(START + 30_000);
    await adapter.tokenBalance(account, "yes");
    expect(sdk.updateBalanceAllowance).toHaveBeenCalledTimes(2);
  });

  it("a failed re-sync still throws and is attempted again on the next read", async () => {
    const { adapter } = fixture();
    sdk.updateBalanceAllowance.mockRejectedValueOnce(new Error("refresh unavailable"));
    await expect(adapter.tokenBalance(account, "yes")).rejects.toThrow(/refresh unavailable/);
    expect(sdk.balanceAllowance).not.toHaveBeenCalled();
    await expect(adapter.tokenBalance(account, "yes")).resolves.toBe(5);
    expect(sdk.updateBalanceAllowance).toHaveBeenCalledTimes(2);
  });

  it("refresh: true always re-syncs and invalidation forces the next opportunistic read to re-sync", async () => {
    const { adapter } = fixture();
    await adapter.tokenBalance(account, "yes");
    vi.setSystemTime(START + 1_000);
    await adapter.tokenBalance(account, "yes", { refresh: true });
    expect(sdk.updateBalanceAllowance).toHaveBeenCalledTimes(2);
    vi.setSystemTime(START + 2_000);
    await adapter.tokenBalance(account, "yes");
    expect(sdk.updateBalanceAllowance).toHaveBeenCalledTimes(2);
    adapter.invalidateTokenBalance("yes");
    await adapter.tokenBalance(account, "yes");
    expect(sdk.updateBalanceAllowance).toHaveBeenCalledTimes(3);
  });

  it("opportunistic refreshes stop at the reserve; forced refreshes use it, then fail fast until the window frees", async () => {
    const { adapter } = fixture();
    await adapter.tokenBalance(account, "stale");
    vi.setSystemTime(START + 31_000);
    for (let index = 0; index < 30; index++) await adapter.tokenBalance(account, `token-${index}`);
    expect(sdk.updateBalanceAllowance).toHaveBeenCalledTimes(31);
    // The window holds 30 charges: an opportunistic re-sync is skipped, the read still succeeds.
    await expect(adapter.tokenBalance(account, "stale")).resolves.toBe(5);
    expect(sdk.updateBalanceAllowance).toHaveBeenCalledTimes(31);
    // Priority callers may use the reserve (10 more), then are refused with a transient error.
    for (let index = 0; index < 10; index++) await adapter.tokenBalance(account, "stale", { refresh: true });
    expect(sdk.updateBalanceAllowance).toHaveBeenCalledTimes(41);
    const before = sdk.balanceAllowance.mock.calls.length;
    let caught: unknown;
    try { await adapter.tokenBalance(account, "stale", { refresh: true }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(VenueRateLimitedError);
    expect((caught as VenueRateLimitedError).retryAfterMs).toBeGreaterThan(0);
    expect((caught as VenueRateLimitedError).retryAfterMs).toBeLessThanOrEqual(10_000);
    expect(sdk.balanceAllowance.mock.calls.length).toBe(before);
    vi.setSystemTime(START + 31_000 + 10_000);
    await expect(adapter.tokenBalance(account, "stale", { refresh: true })).resolves.toBe(5);
  });

  it("a venue 429 on the balance family fails fast until its cooldown passes", async () => {
    const { adapter } = fixture();
    sdk.updateBalanceAllowance.mockRejectedValueOnce(rateLimited(2));
    await expect(adapter.tokenBalance(account, "yes")).rejects.toMatchObject({ name: "RateLimitError" });
    await expect(adapter.tokenBalance(account, "yes")).rejects.toBeInstanceOf(VenueRateLimitedError);
    await expect(adapter.balances(account)).rejects.toBeInstanceOf(VenueRateLimitedError);
    expect(sdk.updateBalanceAllowance).toHaveBeenCalledTimes(1);
    expect(sdk.balanceAllowance).not.toHaveBeenCalled();
    vi.setSystemTime(START + 5_000);
    await expect(adapter.tokenBalance(account, "yes")).resolves.toBe(5);
  });
});

describe("account read memo", () => {
  const row = { tokenId: "yes", conditionId: "condition-1", outcome: "Yes", oppositeOutcome: "No", oppositeTokenId: "no",
    size: "17.7171", avgPrice: "0.42", curPrice: "0.5", redeemable: false, title: "Market" };

  it("reads all positions in one request and shares it across concurrent and recent callers", async () => {
    const { adapter, client } = fixture([row]);
    const [first, second] = await Promise.all([adapter.positions(account), adapter.positions(account)]);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ marketRef: "yes", tokenId: "yes", outcome: "YES", size: 17.7171, avgPrice: .42 });
    expect(second).toBe(first);
    expect(client.listPositions).toHaveBeenCalledTimes(1);
    expect(client.listPositions).toHaveBeenCalledWith({ sizeThreshold: 0, pageSize: 500 });
    vi.setSystemTime(START + 2_000);
    await adapter.positions(account);
    expect(client.listPositions).toHaveBeenCalledTimes(1);
    vi.setSystemTime(START + 3_500);
    await adapter.positions(account);
    expect(client.listPositions).toHaveBeenCalledTimes(2);
  });

  it("does not memoize a failed read and keeps families independent", async () => {
    const { adapter, client } = fixture([row]);
    client.listPositions.mockImplementationOnce(() => { throw rateLimited(1); });
    await expect(adapter.positions(account)).rejects.toMatchObject({ name: "RateLimitError" });
    await expect(adapter.positions(account)).rejects.toBeInstanceOf(VenueRateLimitedError);
    expect(client.listPositions).toHaveBeenCalledTimes(1);
    await expect(adapter.balances(account)).resolves.toEqual([{ asset: "pUSD", total: 5, available: 5 }]);
    vi.setSystemTime(START + 5_000);
    await expect(adapter.positions(account)).resolves.toHaveLength(1);
  });

  it("shares the collateral read within the memo window", async () => {
    const { adapter } = fixture();
    await Promise.all([adapter.balances(account), adapter.balances(account)]);
    expect(sdk.balanceAllowance).toHaveBeenCalledTimes(1);
    vi.setSystemTime(START + 3_001);
    await adapter.balances(account);
    expect(sdk.balanceAllowance).toHaveBeenCalledTimes(2);
  });
});

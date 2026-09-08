// packages/cli/test/polymarket-gasless.test.ts
import { describe, expect, it, vi } from "vitest";
import { parseBotConfig, parsePolymarketGaslessAuth, QUOTIENT_POLYMARKET_GASLESS_AUTH } from "@quotient-forecasting/cassie-core";
import { resolvePolymarketGaslessAuth } from "../src/polymarket-gasless.js";

const auth = { kind: "builder", key: "test-key", secret: "test-secret", passphrase: "test-passphrase" };
const cfg = parseBotConfig({ id: "poly", venue: "polymarket", strategy: { id: "signals" } });

describe("directional Polymarket gasless authorization", () => {
  it("uses the shared operator default without unlocking a bot-specific credential", async () => {
    const botSecret = vi.fn();
    await expect(resolvePolymarketGaslessAuth(cfg, { defaultAuth: () => JSON.stringify(auth), botSecret })).resolves.toEqual(auth);
    expect(botSecret).not.toHaveBeenCalled();
  });
  it("falls back to the saved bot relayer credential", async () => {
    const relayer = { kind: "relayer", key: "test-relayer", address: "0x" + "1".repeat(40) };
    const botSecret = vi.fn().mockResolvedValue(JSON.stringify(relayer));
    await expect(resolvePolymarketGaslessAuth(cfg, { defaultAuth: () => null, botSecret })).resolves.toEqual(relayer);
    expect(botSecret).toHaveBeenCalledWith("poly", "polymarket-gasless");
  });
  it.each(["signals", "flip-flat", "agent"])("uses bundled authorization for %s without local setup credentials", async strategy => {
    const resolved = await resolvePolymarketGaslessAuth(parseBotConfig({ id: "poly", venue: "polymarket", strategy: { id: strategy } }),
      { defaultAuth: () => null, botSecret: async () => null });
    expect(resolved === QUOTIENT_POLYMARKET_GASLESS_AUTH).toBe(true);
  });
  it.each(["hyperliquid", "kalshi"] as const)("does not resolve gasless secrets for %s", async venue => {
    const defaultAuth = vi.fn(); const botSecret = vi.fn();
    await expect(resolvePolymarketGaslessAuth(parseBotConfig({ id: "other", venue }), { defaultAuth, botSecret })).resolves.toBeUndefined();
    expect(defaultAuth).not.toHaveBeenCalled(); expect(botSecret).not.toHaveBeenCalled();
  });
  it.each(["not-json-test-secret", JSON.stringify({ ...auth, secret: "" }), JSON.stringify({ ...auth, surprise: "test-secret" })])("does not echo invalid secrets", raw => {
    expect(() => parsePolymarketGaslessAuth(raw)).toThrow("invalid Polymarket Builder/Relayer credential");
  });
});

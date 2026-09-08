// packages/core/test/polymarket-gasless-client.test.ts
import { describe, expect, it, vi } from "vitest";
import { createSecureClient, relayerApiKey } from "@polymarket/client";
import { builderApiKey } from "@polymarket/client/node";
import { PolymarketAdapter } from "../src/venues/polymarket.js";
import { parseBotConfig } from "@quotient-forecasting/cassie-core";

vi.mock("@polymarket/client", async original => ({ ...await original<typeof import("@polymarket/client")>(),
  createSecureClient: vi.fn(async () => ({})), relayerApiKey: vi.fn(() => ({ type: "relayer-test" })) }));
vi.mock("@polymarket/client/node", () => ({ builderApiKey: vi.fn(() => ({ type: "builder-test" })) }));
vi.mock("@polymarket/client/viem", () => ({ privateKey: () => ({ signer: "test" }) }));

describe("Polymarket redemption client authorization", () => {
  it.each([
    { kind: "builder" as const, key: "fake-key", secret: "fake-secret", passphrase: "fake-passphrase" },
    { kind: "relayer" as const, key: "fake-key", address: "0x" + "1".repeat(40) },
  ])("constructs the SDK client with $kind service auth and the existing venue identity", async auth => {
    vi.clearAllMocks();
    const adapter = new PolymarketAdapter({ urls: parseBotConfig({ id: "test", venue: "polymarket" }).venueUrls,
      polymarketGaslessAuth: auth, creds: { venue: "polymarket", signerPk: "unused-test-key", funder: "0xwallet", signatureType: 3,
        l2: { apiKey: "l2-key", secret: "l2-secret", passphrase: "l2-passphrase" } } });
    await (adapter as unknown as { secure(): Promise<unknown> }).secure();
    expect(createSecureClient).toHaveBeenCalledWith(expect.objectContaining({ wallet: "0xwallet",
      apiKey: { type: `${auth.kind}-test` }, credentials: { key: "l2-key", secret: "l2-secret", passphrase: "l2-passphrase" } }));
    if (auth.kind === "builder") expect(builderApiKey).toHaveBeenCalledWith({ key: auth.key, secret: auth.secret, passphrase: auth.passphrase });
    else expect(relayerApiKey).toHaveBeenCalledWith({ key: auth.key, address: auth.address });
  });
});

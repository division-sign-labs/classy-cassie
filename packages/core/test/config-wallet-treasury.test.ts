// packages/core/test/config-wallet-treasury.test.ts

import { describe, expect, it } from "vitest";
import { parseBotConfig, serializeBotConfig } from "@quotient-forecasting/cassie-core";

const BOT_ADDRESS = "0x1111111111111111111111111111111111111111";
const ACCOUNT_ADDRESS = "0x2222222222222222222222222222222222222222";

function treasury(eoa = true) {
  return {
    provider: "splits",
    organizationId: "org_123",
    organizationName: "Quotient",
    accountId: "account_123",
    accountAddress: ACCOUNT_ADDRESS,
    accountName: "cassie bot-1",
    signers: {
      passkeyIds: ["passkey_1"],
      ...(eoa ? { eoa: { id: "signer_1", address: BOT_ADDRESS } } : {}),
    },
    threshold: 1,
  } as const;
}

describe("wallet and Splits treasury config", () => {
  it("keeps old configs backward-compatible as local-origin wallets", () => {
    const config = parseBotConfig({ id: "old-bot", venue: "hyperliquid" });
    expect(config.wallet).toEqual({ origin: "local" });
  });

  it("round-trips local wallet and account-scoped Splits metadata", () => {
    const parsed = parseBotConfig({
      id: "bot-1",
      venue: "hyperliquid",
      wallet: { origin: "local", address: BOT_ADDRESS },
      treasury: treasury(),
    });
    expect(parseBotConfig(JSON.parse(serializeBotConfig(parsed)))).toEqual(parsed);
  });

  it("rejects removed Container wallet provenance", () => {
    expect(() =>
      parseBotConfig({
        id: "bot-1",
        venue: "hyperliquid",
        wallet: { origin: "container", address: BOT_ADDRESS },
      }),
    ).toThrow();
  });

  it("rejects secret-looking or otherwise unknown treasury fields", () => {
    expect(() =>
      parseBotConfig({
        id: "bot-1",
        venue: "hyperliquid",
        wallet: { address: BOT_ADDRESS },
        treasury: { ...treasury(), apiKey: "must-not-persist" },
      }),
    ).toThrow();
  });

  it("rejects impossible thresholds and a signer that does not match the bot wallet", () => {
    expect(() =>
      parseBotConfig({
        id: "bot-1",
        venue: "hyperliquid",
        wallet: { address: BOT_ADDRESS },
        treasury: { ...treasury(), threshold: 3 },
      }),
    ).toThrow(/threshold 3 exceeds 2/);

    expect(() =>
      parseBotConfig({
        id: "bot-1",
        venue: "hyperliquid",
        wallet: { address: "0x3333333333333333333333333333333333333333" },
        treasury: treasury(),
      }),
    ).toThrow(/must match/);
  });

  it("rejects duplicate treasury passkey ids", () => {
    expect(() =>
      parseBotConfig({
        id: "bot-1",
        venue: "hyperliquid",
        treasury: {
          ...treasury(false),
          signers: { passkeyIds: ["passkey_1", "passkey_1"] },
        },
      }),
    ).toThrow(/unique/);
  });

  it("forbids sharing the deployed Polymarket signer with Splits", () => {
    expect(() =>
      parseBotConfig({
        id: "bot-1",
        venue: "polymarket",
        wallet: { address: BOT_ADDRESS },
        treasury: treasury(),
      }),
    ).toThrow(/cannot also control/);

    expect(
      parseBotConfig({
        id: "bot-1",
        venue: "polymarket",
        wallet: { address: BOT_ADDRESS },
        treasury: treasury(false),
      }).treasury?.signers,
    ).toEqual({ passkeyIds: ["passkey_1"] });
  });

  it("rejects a venue account that belongs to another venue or wallet", () => {
    expect(() =>
      parseBotConfig({
        id: "bot-1",
        venue: "hyperliquid",
        wallet: { address: BOT_ADDRESS },
        account: { venue: "lighter", l1Address: BOT_ADDRESS },
      }),
    ).toThrow(/does not match bot venue/);
    expect(() =>
      parseBotConfig({
        id: "bot-1",
        venue: "hyperliquid",
        wallet: { address: BOT_ADDRESS },
        account: { venue: "hyperliquid", masterAddress: "0x4444444444444444444444444444444444444444" },
      }),
    ).toThrow(/does not match this bot's wallet/);
  });
});

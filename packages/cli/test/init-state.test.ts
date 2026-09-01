// packages/cli/test/init-state.test.ts

import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearInitState, initStatePath, loadInitState, parseInitState, saveInitState } from "../src/init-state.js";
import { requireSafeStrategyTransition } from "../src/commands/init.js";

const originalHome = process.env.CASSIE_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.CASSIE_HOME;
  else process.env.CASSIE_HOME = originalHome;
});

describe("init state", () => {
  it("persists only non-secret resumable state with mode 0600", () => {
    process.env.CASSIE_HOME = mkdtempSync(join(tmpdir(), "cassie-init-"));
    const state = {
      version: 1 as const,
      botId: "bot-1",
      venue: "hyperliquid" as const,
      createdAt: "2026-08-14T00:00:00.000Z",
      wallet: { origin: "local" as const, address: "0x1111111111111111111111111111111111111111" },
    };
    const path = saveInitState(state);
    expect(path).toBe(initStatePath("bot-1"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadInitState("bot-1")).toEqual(state);
    expect(readFileSync(path, "utf8")).not.toMatch(/privateKey|passphrase|apiKey|token/i);
    expect(clearInitState("bot-1")).toBe(true);
    expect(loadInitState("bot-1")).toBeNull();
  });

  it("rejects secret fields and corrupt or cross-bot journals", () => {
    const base = {
      version: 1 as const,
      botId: "bot-1",
      venue: "hyperliquid" as const,
      createdAt: "2026-08-14T00:00:00.000Z",
    };
    expect(() => parseInitState({ ...base, privateKey: "0xsecret" })).toThrow(/secrets are forbidden/);
    expect(() => parseInitState(base, "bot-2")).toThrow(/belongs to bot-1/);
    expect(() => parseInitState({ ...base, version: 2 })).toThrow(/version/);
    expect(() => initStatePath("../escape")).toThrow(/bot id/);
  });

  it("strictly validates a pending Splits signer plan", () => {
    const base = {
      version: 1 as const,
      botId: "bot-1",
      venue: "hyperliquid" as const,
      createdAt: "2026-08-14T00:00:00.000Z",
      wallet: { origin: "local" as const, address: "0x1111111111111111111111111111111111111111" },
      pendingTreasury: {
        phase: "planned" as const,
        organizationId: "org-1",
        accountName: "cassie-bot-1",
        passkeyIds: ["passkey-1"],
        threshold: 1,
      },
    };
    expect(parseInitState(base).pendingTreasury).toEqual(base.pendingTreasury);
    expect(() =>
      parseInitState({
        ...base,
        pendingTreasury: { ...base.pendingTreasury, passkeyIds: ["passkey-1", "passkey-1"] },
      }),
    ).toThrow(/passkeyIds/);
    expect(() =>
      parseInitState({
        ...base,
        pendingTreasury: { ...base.pendingTreasury, threshold: 2 },
      }),
    ).toThrow(/threshold/);
    expect(() =>
      parseInitState({
        ...base,
        pendingTreasury: { ...base.pendingTreasury, surpriseSigner: "passkey-evil" },
      }),
    ).toThrow(/exact account plan/);
  });
});

describe("kalshi init journal", () => {
  it("round-trips a kalshi checkpoint; keyId passes the secret-name guard", () => {
    process.env.CASSIE_HOME = mkdtempSync(join(tmpdir(), "cassie-init-"));
    const state = {
      version: 1 as const,
      botId: "bot-k",
      venue: "kalshi" as const,
      createdAt: "2026-08-22T00:00:00.000Z",
      wallet: { origin: "local" as const, address: "0x1111111111111111111111111111111111111111" },
      account: { venue: "kalshi" as const, keyId: "0b7e4a1c-1111-2222-3333-444455556666" },
    };
    const path = saveInitState(state);
    expect(loadInitState("bot-k")).toEqual(state);
    expect(readFileSync(path, "utf8")).not.toMatch(/privateKey|passphrase|api[-_]?key(?!Id)/i);
    clearInitState("bot-k");
  });
});

describe("market-make strategy transition", () => {
  it("keeps an existing market-maker bound to its durable bot id", () => {
    expect(() => requireSafeStrategyTransition("market-make", "signals")).toThrow(/cannot switch.*in place/);
    expect(() => requireSafeStrategyTransition("market-make", "agent")).toThrow(/separate bot id/);
    expect(() => requireSafeStrategyTransition("market-make", "market-make")).not.toThrow();
    expect(() => requireSafeStrategyTransition("signals", "market-make")).not.toThrow();
  });
});

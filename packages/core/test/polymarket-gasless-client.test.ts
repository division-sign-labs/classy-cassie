// packages/core/test/polymarket-gasless-client.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSecureClient, relayerApiKey } from "@polymarket/client";
import { builderApiKey } from "@polymarket/client/node";
import { GASLESS_AUTH_ROLE, PolymarketAdapter } from "../src/venues/polymarket.js";
import { QUOTIENT_POLYMARKET_GASLESS_AUTH } from "../src/polymarket/gasless-auth.js";
import { parseBotConfig, type SetupContext } from "@quotient-forecasting/cassie-core";

vi.mock("@polymarket/client", async original => ({ ...await original<typeof import("@polymarket/client")>(),
  createSecureClient: vi.fn(async () => ({})), relayerApiKey: vi.fn(() => ({ type: "relayer-test" })) }));
vi.mock("@polymarket/client/node", () => ({ builderApiKey: vi.fn(() => ({ type: "builder-test" })) }));
vi.mock("@polymarket/client/viem", () => ({ privateKey: () => ({ signer: "test" }) }));

const serviceAuth = [
  { kind: "builder" as const, key: "fake-key", secret: "fake-secret", passphrase: "fake-passphrase" },
  { kind: "relayer" as const, key: "fake-key", address: "0x" + "1".repeat(40) },
];

describe("Polymarket account authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSecureClient).mockResolvedValue({
      account: { signer: "0xsigner", wallet: "0xwallet" },
      credentials: { key: "l2-key", secret: "l2-secret", passphrase: "l2-passphrase" },
    } as never);
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ blocked: false, country: "test" }) })));
  });
  afterEach(() => vi.unstubAllGlobals());

  function setup(path = "create", savedAuth: string | null = null, botAuth: string | null = null) {
    const adapter = new PolymarketAdapter({ urls: parseBotConfig({ id: "test", venue: "polymarket" }).venueUrls });
    const approvals = vi.fn(async () => {});
    (adapter as unknown as { ensureTradingApprovals(): Promise<void> }).ensureTradingApprovals = approvals;
    const ctx: SetupContext = {
      botId: "test", select: vi.fn(async () => path),
      ask: vi.fn(async () => "0xwallet"), confirm: vi.fn(async () => true), print: vi.fn(),
      poll: vi.fn(), getSecret: vi.fn(async role => role === "master" ? "unused-test-key" : botAuth),
      putSecret: vi.fn(), getOperatorDefault: vi.fn(async () => savedAuth),
    };
    return { adapter, ctx, approvals };
  }

  it.each(["create", "connect"])("uses the bundled credential for %s on an install with no saved authorization", async path => {
    const { adapter, ctx, approvals } = setup(path);
    await expect(adapter.setup(ctx)).resolves.toMatchObject({ venue: "polymarket", funder: "0xwallet" });
    expect(ctx.select).toHaveBeenCalledExactlyOnceWith("Polymarket account", expect.any(Array));
    if (path === "create") expect(ctx.ask).not.toHaveBeenCalled();
    else expect(ctx.ask).toHaveBeenCalledExactlyOnceWith("Wallet address (polymarket.com profile)");
    expect(ctx.confirm).not.toHaveBeenCalled();
    expect(approvals).toHaveBeenCalledOnce();
    const { kind, ...credential } = QUOTIENT_POLYMARKET_GASLESS_AUTH;
    const authorize = kind === "builder" ? builderApiKey : relayerApiKey;
    expect(authorize).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(authorize).mock.calls[0]?.[0]) === JSON.stringify(credential)).toBe(true);
    const stored = vi.mocked(ctx.putSecret).mock.calls.find(([role]) => role === GASLESS_AUTH_ROLE);
    expect(stored?.[1] === JSON.stringify(QUOTIENT_POLYMARKET_GASLESS_AUTH)).toBe(true);
    expect(stored?.[2]).toEqual({ runtimeEligible: false });
    expect(createSecureClient).toHaveBeenCalledWith(expect.objectContaining({ apiKey: { type: `${kind}-test` } }));
  });

  it("uses the bundled credential with a text-only host and no defaults provider", async () => {
    const { adapter, ctx } = setup();
    delete ctx.select;
    delete ctx.getOperatorDefault;
    vi.mocked(ctx.ask).mockResolvedValue("create");
    await adapter.setup(ctx);
    expect(ctx.ask).toHaveBeenCalledExactlyOnceWith("Account (create/connect)", { default: "create" });
    expect(createSecureClient).toHaveBeenCalledWith(expect.objectContaining({ apiKey: { type: `${QUOTIENT_POLYMARKET_GASLESS_AUTH.kind}-test` } }));
  });

  it.each(serviceAuth)("creates accounts with the saved $kind credential and no auth prompts", async auth => {
    const { adapter, ctx, approvals } = setup("create", JSON.stringify(auth));
    await expect(adapter.setup(ctx)).resolves.toMatchObject({ venue: "polymarket", funder: "0xwallet" });
    expect(ctx.select).toHaveBeenCalledTimes(1);
    expect(ctx.select).toHaveBeenCalledWith("Polymarket account", expect.any(Array));
    expect(ctx.ask).not.toHaveBeenCalled();
    expect(ctx.confirm).not.toHaveBeenCalled();
    expect(ctx.getSecret).not.toHaveBeenCalledWith(GASLESS_AUTH_ROLE);
    expect(createSecureClient).toHaveBeenCalledWith(expect.objectContaining({ apiKey: { type: `${auth.kind}-test` } }));
    expect(ctx.putSecret).toHaveBeenCalledWith(GASLESS_AUTH_ROLE, JSON.stringify(auth), { runtimeEligible: false });
    expect(approvals).toHaveBeenCalledOnce();
    expect(ctx.print).not.toHaveBeenCalledWith(expect.stringContaining("fake-key"));
  });

  it.each(serviceAuth)("connects existing accounts with the saved $kind credential", async auth => {
    const { adapter, ctx } = setup("connect", JSON.stringify(auth));
    await adapter.setup(ctx);
    expect(ctx.select).toHaveBeenCalledTimes(1);
    expect(ctx.ask).toHaveBeenCalledExactlyOnceWith("Wallet address (polymarket.com profile)");
    expect(ctx.confirm).not.toHaveBeenCalled();
    expect(createSecureClient).toHaveBeenCalledWith(expect.objectContaining({ wallet: "0xwallet", apiKey: { type: `${auth.kind}-test` } }));
  });

  it("reuses the bot credential when there is no shared default", async () => {
    const auth = serviceAuth[1]!;
    const { adapter, ctx } = setup("create", null, JSON.stringify(auth));
    await adapter.setup(ctx);
    expect(ctx.getSecret).toHaveBeenCalledWith(GASLESS_AUTH_ROLE);
    expect(ctx.ask).not.toHaveBeenCalled();
    expect(ctx.select).toHaveBeenCalledTimes(1);
    expect(relayerApiKey).toHaveBeenCalledWith({ key: auth.key, address: auth.address });
  });

  it("uses the saved default through the text-only account prompt", async () => {
    const { adapter, ctx } = setup("create", JSON.stringify(serviceAuth[0]));
    delete ctx.select;
    vi.mocked(ctx.ask).mockResolvedValue("create");
    await adapter.setup(ctx);
    expect(ctx.ask).toHaveBeenCalledExactlyOnceWith("Account (create/connect)", { default: "create" });
  });

  it("rejects an invalid saved credential before creating an account without exposing its value", async () => {
    const { adapter, ctx } = setup("create", "invalid-test-secret");
    await expect(adapter.setup(ctx)).rejects.toThrow("invalid Polymarket Builder/Relayer credential");
    expect(createSecureClient).not.toHaveBeenCalled();
    expect(ctx.ask).not.toHaveBeenCalled();
    expect(ctx.putSecret).not.toHaveBeenCalled();
  });
});

describe("Polymarket redemption client authorization", () => {
  it("uses bundled authorization when a runtime has only its trading credentials", async () => {
    vi.clearAllMocks();
    const adapter = new PolymarketAdapter({ urls: parseBotConfig({ id: "test", venue: "polymarket" }).venueUrls,
      creds: { venue: "polymarket", signerPk: "unused-test-key", funder: "0xwallet", signatureType: 3,
        l2: { apiKey: "l2-key", secret: "l2-secret", passphrase: "l2-passphrase" } } });
    await (adapter as unknown as { secure(): Promise<unknown> }).secure();
    const { kind, ...credential } = QUOTIENT_POLYMARKET_GASLESS_AUTH;
    const authorize = kind === "builder" ? builderApiKey : relayerApiKey;
    expect(JSON.stringify(vi.mocked(authorize).mock.calls[0]?.[0]) === JSON.stringify(credential)).toBe(true);
    expect(createSecureClient).toHaveBeenCalledWith(expect.objectContaining({ wallet: "0xwallet", apiKey: { type: `${kind}-test` },
      credentials: { key: "l2-key", secret: "l2-secret", passphrase: "l2-passphrase" } }));
  });

  it.each(serviceAuth)("constructs the SDK client with $kind service auth and the existing venue identity", async auth => {
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

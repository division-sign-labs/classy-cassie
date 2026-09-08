// packages/cli/test/account-flow-copy.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(), confirm: vi.fn(), getPassphrase: vi.fn(), adapterFor: vi.fn(),
  loadBotConfig: vi.fn(), saveBotConfig: vi.fn(), generateEoa: vi.fn(), checkLiveSignalAccess: vi.fn(),
  discoverQuotientToken: vi.fn(), installCassieSkill: vi.fn(),
  keys: { entryMeta: vi.fn(), exists: vi.fn(), putEntry: vi.fn(), list: vi.fn(), verifyPassphrase: vi.fn() },
}));
vi.mock("@quotient-forecasting/cassie-core", async (original) => ({
  ...await original<typeof import("@quotient-forecasting/cassie-core")>(),
  generateEoa: mocks.generateEoa,
  checkLiveSignalAccess: mocks.checkLiveSignalAccess,
}));
vi.mock("../src/context.js", () => ({
  ask: mocks.ask, confirm: mocks.confirm, getPassphrase: mocks.getPassphrase,
  keystore: () => mocks.keys, adapterFor: mocks.adapterFor,
  makeSetupContext: () => ({}), requireAccount: (cfg: { account: unknown }) => cfg.account,
  controlFetch: vi.fn(), isDeployed: () => false,
}));
vi.mock("../src/paths.js", () => ({
  loadBotConfig: mocks.loadBotConfig, saveBotConfig: mocks.saveBotConfig, dirs: { run: () => "/test-only" },
}));
vi.mock("../src/quotient-token.js", () => ({ discoverQuotientToken: mocks.discoverQuotientToken }));
vi.mock("@quotient-forecasting/cassie-skill", () => ({ installCassieSkill: mocks.installCassieSkill }));

import { parseBotConfig } from "@quotient-forecasting/cassie-core";
import { walletCreate, walletList } from "../src/commands/wallet.js";
import { runFund } from "../src/commands/fund.js";
import { createWithdrawHandler } from "../src/commands/withdraw.js";
import { configureSignalsKey } from "../src/commands/signals-key.js";
import { installSkill } from "../src/commands/skill.js";

const ADDRESS = `0x${"1".repeat(40)}`;
const TOKEN = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const CONFIG = parseBotConfig({
  id: "copy-bot", venue: "hyperliquid", account: { venue: "hyperliquid", masterAddress: ADDRESS },
  strategy: { id: "signals", config: {} },
});
function lines(): string[] { return vi.mocked(console.log).mock.calls.flatMap(call => call.map(String)); }

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  mocks.loadBotConfig.mockReturnValue(CONFIG);
  mocks.getPassphrase.mockResolvedValue("test-passphrase");
  mocks.generateEoa.mockReturnValue({ address: ADDRESS, privateKey: "test-only-private-key" });
});
afterEach(() => vi.restoreAllMocks());

describe("account flow copy", () => {
  it("prints a wallet address alone without exposing the generated key", async () => {
    await walletCreate("copy-bot");
    expect(lines()).toEqual(["Wallet created: copy-bot", ADDRESS]);
    expect(lines().join("\n")).not.toContain("test-only-private-key");
  });

  it("keeps wallet-list addresses separate from key roles and scope", async () => {
    mocks.keys.list.mockReturnValue([{ botId: "copy-bot", entries: [{ name: "master", address: ADDRESS, runtimeEligible: false }] }]);
    await walletList();
    expect(lines().filter(line => line.includes(ADDRESS))).toEqual([ADDRESS]);
    expect(lines().some(line => line.includes("local-only"))).toBe(true);
  });

  it("leaves a single credited receipt to venue-owned funding flows", async () => {
    const runFundingFlow = vi.fn(async () => { console.log("Deposit credited."); return CONFIG.account; });
    mocks.adapterFor.mockResolvedValue({ runFundingFlow });
    await runFund("copy-bot", {});
    expect(lines()).toEqual(["Deposit credited."]);
    expect(mocks.saveBotConfig).toHaveBeenCalledOnce();
  });

  it("preserves the mechanical Splits token argument without decorative gas or contract instructions", async () => {
    mocks.loadBotConfig.mockReturnValue(parseBotConfig({ ...CONFIG, treasury: {
      provider: "splits", organizationId: "org", accountId: "treasury", accountAddress: ADDRESS,
      accountName: "copy-bot", signers: { passkeyIds: ["passkey"] }, threshold: 1,
    } }));
    mocks.ask.mockResolvedValueOnce("20").mockResolvedValueOnce("");
    mocks.adapterFor.mockResolvedValue({
      fundingInstructions: async () => ({ addresses: [{ chain: "arbitrum", address: ADDRESS, asset: "USDC", minimum: 5 }] }),
      runFundingFlow: async () => CONFIG.account,
    });
    await runFund("copy-bot", { from: "splits" });
    const commands = lines().filter(line => line.startsWith("splits "));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(TOKEN);
    expect(lines().filter(line => line.includes(TOKEN))).toEqual(commands);
    expect(lines().join("\n")).not.toMatch(/\$2|ETH/);
  });

  it("prints generic deposit addresses alone and retains the credited balance", async () => {
    mocks.adapterFor.mockResolvedValue({
      fundingInstructions: async () => ({ summary: "Deposit", addresses: [{ chain: "arbitrum", address: ADDRESS, asset: "USDC", minimum: 5, note: "Native USDC only." }] }),
      awaitFunding: async () => ({ total: 20, asset: "USDC" }),
    });
    await runFund("copy-bot", {});
    expect(lines().filter(line => line.includes(ADDRESS))).toEqual([ADDRESS]);
    expect(lines().filter(line => line.includes("credited"))).toHaveLength(1);
  });

  it("keeps the withdrawal destination copyable and requires transfer consent", async () => {
    const withdraw = vi.fn();
    const confirm = vi.fn().mockResolvedValue(false);
    const handler = createWithdrawHandler({ adapterFor: async () => ({ withdraw }) as never, confirm });
    await handler("copy-bot", "20", { to: ADDRESS });
    expect(lines().filter(line => line.includes(ADDRESS))).toEqual([ADDRESS]);
    expect(lines()).toContain("Destination: Arbitrum");
    expect(confirm).toHaveBeenCalledWith("Send withdrawal?", false);
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("prints the verified API URL and deployment command without prose suffixes", async () => {
    mocks.checkLiveSignalAccess.mockResolvedValue({ count: 12 });
    await configureSignalsKey("copy-bot", "test-only-api-key", {});
    expect(lines().filter(line => line.includes(CONFIG.signals.baseUrl))).toEqual([CONFIG.signals.baseUrl]);
    expect(lines().filter(line => line.includes("cassie deploy"))).toEqual(["cassie deploy copy-bot"]);
    expect(lines().join("\n")).not.toContain("test-only-api-key");
  });

  it("prints skill installation paths separately from status", () => {
    mocks.installCassieSkill.mockReturnValue(["/test-only/skills/cassie"]);
    installSkill();
    expect(lines()).toEqual(["Cassie skill installed.", "/test-only/skills/cassie", "Restart your agent session to load the skill."]);
  });
});

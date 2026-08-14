// packages/cli/test/splits-init.test.ts

import { describe, expect, it } from "vitest";
import { createSplitsTreasury, type SplitsInitUi } from "../src/splits-init.js";
import { SplitsCli, type SplitsCommandResult, type SplitsCommandRunner } from "../src/splits.js";
import type { PendingSplitsAccount } from "../src/init-state.js";

const BOT = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";
const CREATED = "2026-08-14T00:00:00.000Z";

function ok(data: unknown): SplitsCommandResult {
  return { stdout: JSON.stringify({ data }), stderr: "", exitCode: 0 };
}

function fakeUi(selections: string[], confirmations: boolean[] = [true, true]): SplitsInitUi & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    async confirm() {
      return confirmations.shift() ?? true;
    },
    async select() {
      const next = selections.shift();
      if (!next) throw new Error("test selection queue exhausted");
      return next;
    },
    print(message) {
      lines.push(message);
    },
  };
}

function queue(values: SplitsCommandResult[]): { runner: SplitsCommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner(args) {
      calls.push([...args]);
      const value = values.shift();
      if (!value) throw new Error("test command queue exhausted");
      return value;
    },
  };
}

const org = { orgId: "org-1", orgName: "Acme", keyName: "owner key", scopes: ["owner"], accountCount: 2 };
const member = { userId: "user-1", email: "me@example.com", role: "OWNER", displayName: "Me", createdAt: CREATED };
const passkey = { id: "passkey-1", name: "MacBook", createdAt: CREATED, isArchived: false };
const account = { id: "account-1", name: "cassie-bot-1", address: ACCOUNT, type: "smart_account", role: "OWNER", isArchived: false, createdAt: CREATED };
const accountSigners = {
  threshold: 1,
  passkeySigners: [{ id: "passkey-1", name: "MacBook", isArchived: false, createdAt: CREATED, userId: "user-1", userEmail: "me@example.com", userDisplayName: "Me" }],
  eoaSigners: [],
};

describe("Splits init orchestration", () => {
  it("creates a passkey-only account and checkpoints before the external write", async () => {
    const { runner, calls } = queue([ok(org), ok([member]), ok([passkey]), ok([]), ok(account), ok(accountSigners)]);
    const events: string[] = [];
    const result = await createSplitsTreasury({
      botId: "bot-1",
      venue: "polymarket",
      walletAddress: BOT,
      cli: new SplitsCli(async (args) => {
        if (args[0] === "accounts" && args[1] === "create") events.push("create");
        return runner(args);
      }),
      ui: fakeUi(["user-1", "passkey-1"]),
      checkpointPending(pending) {
        events.push(`checkpoint:${pending.phase}`);
        expect(pending.eoa).toBeUndefined();
      },
    });

    expect(events).toEqual(["checkpoint:planned", "checkpoint:create-attempted", "create"]);
    expect(result).toMatchObject({ organizationId: "org-1", accountAddress: ACCOUNT, threshold: 1 });
    expect(result.signers).toEqual({ passkeyIds: ["passkey-1"] });
    expect(calls.some((args) => args.includes("register-signer"))).toBe(false);
  });

  it("reconciles a checkpointed matching account without creating another", async () => {
    const { runner, calls } = queue([ok(org), ok([member]), ok([passkey]), ok([account]), ok(accountSigners)]);
    const result = await createSplitsTreasury({
      botId: "bot-1",
      venue: "hyperliquid",
      walletAddress: BOT,
      pending: {
        phase: "create-attempted",
        organizationId: "org-1",
        organizationName: "Acme",
        accountName: "cassie-bot-1",
        passkeyIds: ["passkey-1"],
        threshold: 1,
      },
      cli: new SplitsCli(runner),
      ui: fakeUi([]),
      checkpointPending() {
        throw new Error("must not checkpoint again");
      },
    });

    expect(result.accountId).toBe("account-1");
    expect(calls.some((args) => args[0] === "accounts" && args[1] === "create")).toBe(false);
  });

  it("blocks a same-name account with a different signer set", async () => {
    const mismatched = { ...accountSigners, passkeySigners: [{ ...accountSigners.passkeySigners[0]!, id: "other" }] };
    const { runner } = queue([ok(org), ok([member]), ok([passkey]), ok([account]), ok(mismatched)]);
    await expect(
      createSplitsTreasury({
        botId: "bot-1",
        venue: "hyperliquid",
        walletAddress: BOT,
        pending: {
          phase: "create-attempted",
          organizationId: "org-1",
          accountName: "cassie-bot-1",
          passkeyIds: ["passkey-1"],
          threshold: 1,
        },
        cli: new SplitsCli(runner),
        ui: fakeUi([]),
        checkpointPending() {},
      }),
    ).rejects.toThrow(/different signer set/);
  });

  it("never silently reissues an ambiguous create on resume", async () => {
    const failedCreate: SplitsCommandResult = {
      stdout: "",
      stderr: "request timed out",
      exitCode: 1,
    };
    const first = queue([
      ok(org),
      ok([member]),
      ok([passkey]),
      ok([]),
      failedCreate,
      ok([]),
      ok([]),
      ok([]),
      ok([]),
      ok([]),
      ok([]),
    ]);
    let checkpointed: PendingSplitsAccount | undefined;
    await expect(
      createSplitsTreasury({
        botId: "bot-1",
        venue: "polymarket",
        walletAddress: BOT,
        cli: new SplitsCli(first.runner),
        ui: fakeUi(["user-1", "passkey-1"]),
        checkpointPending(pending) {
          checkpointed = pending;
        },
        wait: async () => {},
      }),
    ).rejects.toThrow(/ambiguous outcome/);
    expect(checkpointed?.phase).toBe("create-attempted");
    expect(first.calls.filter((args) => args[0] === "accounts" && args[1] === "create")).toHaveLength(1);

    const resumed = queue([ok(org), ok([member]), ok([passkey]), ok([])]);
    await expect(
      createSplitsTreasury({
        botId: "bot-1",
        venue: "polymarket",
        walletAddress: BOT,
        pending: checkpointed!,
        cli: new SplitsCli(resumed.runner),
        ui: fakeUi([], [true, false]),
        checkpointPending() {},
        wait: async () => {},
      }),
    ).rejects.toThrow(/no retry was sent/);
    expect(resumed.calls.some((args) => args[0] === "accounts" && args[1] === "create")).toBe(false);
  });
});

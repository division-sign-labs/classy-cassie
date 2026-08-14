// packages/cli/test/splits.test.ts

import { afterEach, describe, expect, it } from "vitest";
import {
  SplitsCli,
  SplitsCliError,
  type SplitsCommandResult,
  type SplitsCommandRunner,
} from "../src/splits.js";

const ACCOUNT_ADDRESS = "0x1111111111111111111111111111111111111111";
const EOA_ADDRESS = "0x2222222222222222222222222222222222222222";
const CREATED_AT = "2026-08-14T12:00:00.000Z";
const originalApiKey = process.env.SPLITS_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.SPLITS_API_KEY;
  else process.env.SPLITS_API_KEY = originalApiKey;
});

function success(body: unknown): SplitsCommandResult {
  return { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
}

function queuedRunner(responses: SplitsCommandResult[]): {
  runner: SplitsCommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: SplitsCommandRunner = (args) => {
    calls.push([...args]);
    const response = responses.shift();
    if (!response) throw new Error("test runner exhausted");
    return response;
  };
  return { runner, calls };
}

describe("SplitsCli read operations", () => {
  it("uses the official JSON commands and parses their typed responses", async () => {
    const account = {
      id: "account-1",
      name: null,
      address: ACCOUNT_ADDRESS,
      type: "smart_account",
      role: null,
      isArchived: false,
      createdAt: CREATED_AT,
    };
    const { runner, calls } = queuedRunner([
      success({
        data: {
          orgId: "org-1",
          orgName: null,
          keyName: "Cassie setup",
          scopes: ["owner"],
          accountCount: 3,
          apiKeySource: "config",
        },
      }),
      success({
        data: [
          {
            userId: "user-1",
            email: "operator@example.com",
            role: "owner",
            displayName: null,
            createdAt: CREATED_AT,
          },
        ],
      }),
      success({
        data: [{ id: "passkey-1", name: null, createdAt: CREATED_AT, isArchived: false }],
      }),
      success({ data: [account] }),
      success({
        data: {
          threshold: 2,
          passkeySigners: [
            {
              id: "passkey-1",
              name: "Laptop",
              isArchived: false,
              createdAt: CREATED_AT,
              userId: "user-1",
              userEmail: "operator@example.com",
              userDisplayName: null,
            },
          ],
          eoaSigners: [
            {
              id: "eoa-1",
              address: EOA_ADDRESS,
              name: null,
              email: null,
              userId: null,
              createdAt: CREATED_AT,
              lastVerifiedAt: null,
            },
          ],
        },
      }),
    ]);
    const splits = new SplitsCli(runner);

    await expect(splits.whoAmI()).resolves.toEqual({
      orgId: "org-1",
      orgName: null,
      keyName: "Cassie setup",
      scopes: ["owner"],
      accountCount: 3,
    });
    await expect(splits.listMembers()).resolves.toEqual([
      {
        userId: "user-1",
        email: "operator@example.com",
        role: "owner",
        displayName: null,
        createdAt: CREATED_AT,
      },
    ]);
    await expect(splits.listMemberSigners("user-1")).resolves.toEqual([
      { id: "passkey-1", name: null, createdAt: CREATED_AT, isArchived: false },
    ]);
    await expect(splits.listAccounts()).resolves.toEqual([account]);
    await expect(splits.getAccountSigners(ACCOUNT_ADDRESS)).resolves.toMatchObject({
      threshold: 2,
      passkeySigners: [{ id: "passkey-1", userId: "user-1" }],
      eoaSigners: [{ id: "eoa-1", address: EOA_ADDRESS }],
    });

    expect(calls).toEqual([
      ["auth", "whoami", "--format", "json"],
      ["members", "list", "--format", "json"],
      ["members", "signers", "user-1", "--format", "json"],
      ["accounts", "list", "--format", "json"],
      ["accounts", "signers", ACCOUNT_ADDRESS, "--format", "json"],
    ]);
  });
});

describe("SplitsCli account creation", () => {
  it("registers an EOA then creates a directly scoped account with exact kebab-case flags", async () => {
    const { runner, calls } = queuedRunner([
      success({ data: { id: "eoa-1", address: EOA_ADDRESS, name: "Cassie signer" } }),
      success({
        data: {
          id: "account-1",
          name: "Cassie Ops & Research",
          address: ACCOUNT_ADDRESS,
          type: "smart_account",
          role: "owner",
          isArchived: false,
          createdAt: CREATED_AT,
        },
      }),
    ]);
    const splits = new SplitsCli(runner);

    await expect(splits.registerEoaSigner(EOA_ADDRESS, " Cassie signer ")).resolves.toEqual({
      id: "eoa-1",
      address: EOA_ADDRESS,
      name: "Cassie signer",
    });
    await expect(
      splits.createAccount({
        name: " Cassie Ops & Research ",
        passkeyIds: ["passkey-1", "passkey-1"],
        eoaSignerIds: ["eoa-1"],
        threshold: 2,
      }),
    ).resolves.toMatchObject({ id: "account-1", address: ACCOUNT_ADDRESS });

    expect(calls).toEqual([
      [
        "auth",
        "register-signer",
        EOA_ADDRESS,
        "--name",
        "Cassie signer",
        "--format",
        "json",
      ],
      [
        "accounts",
        "create",
        "--name",
        "Cassie Ops & Research",
        "--passkey-ids",
        "passkey-1",
        "--eoa-signer-ids",
        "eoa-1",
        "--threshold",
        "2",
        "--format",
        "json",
      ],
    ]);
  });

  it("omits the optional signer name instead of inventing one", async () => {
    const { runner, calls } = queuedRunner([
      success({ data: { id: "eoa-1", address: EOA_ADDRESS, name: null } }),
    ]);

    await new SplitsCli(runner).registerEoaSigner(EOA_ADDRESS);

    expect(calls).toEqual([
      ["auth", "register-signer", EOA_ADDRESS, "--format", "json"],
    ]);
  });

  it("rejects empty signer sets and impossible thresholds before invoking Splits", async () => {
    let callCount = 0;
    const splits = new SplitsCli(() => {
      callCount += 1;
      return success({});
    });

    await expect(
      splits.createAccount({ name: "Cassie", threshold: 1 }),
    ).rejects.toMatchObject({ kind: "invalid-input" });
    await expect(
      splits.createAccount({ name: "Cassie", passkeyIds: ["passkey-1"], threshold: 2 }),
    ).rejects.toMatchObject({ kind: "invalid-input" });
    await expect(splits.getAccountSigners("not-an-address")).rejects.toMatchObject({
      kind: "invalid-input",
    });
    expect(callCount).toBe(0);
  });
});

describe("SplitsCli diagnostics", () => {
  it("explains how to install the pinned CLI when the executable is missing", async () => {
    const splits = new SplitsCli(() => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      errorCode: "ENOENT",
      errorMessage: "spawnSync splits ENOENT",
    }));

    const error = await splits.whoAmI().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SplitsCliError);
    expect(error).toMatchObject({ kind: "not-installed" });
    expect((error as Error).message).toContain("@splits/splits-cli@0.2.11");
    expect((error as Error).message).toContain("splits auth login");
  });

  it("turns authentication failures into safe setup guidance and redacts key material", async () => {
    process.env.SPLITS_API_KEY = "sk_read_exact_secret_123456";
    const privateValue = `0x${"a".repeat(64)}`;
    const legacyHexKey = "b".repeat(64);
    const splits = new SplitsCli(() => ({
      stdout: "",
      stderr: `401 Unauthorized SPLITS_API_KEY=sk_read_exact_secret_123456 private=${privateValue} legacy=${legacyHexKey}`,
      exitCode: 1,
    }));

    const error = await splits.whoAmI().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "not-authenticated" });
    expect((error as Error).message).toContain("splits auth login");
    expect((error as Error).message).not.toContain("sk_read_exact_secret_123456");
    expect((error as Error).message).not.toContain(privateValue);
    expect((error as Error).message).not.toContain(legacyHexKey);
  });

  it("redacts malformed output and points to the supported CLI version", async () => {
    process.env.SPLITS_API_KEY = "legacy-secret-value";
    const splits = new SplitsCli(() => ({
      stdout: "not-json apiKey=legacy-secret-value",
      stderr: "",
      exitCode: 0,
    }));

    const error = await splits.listMembers().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "invalid-output" });
    expect((error as Error).message).toContain("@splits/splits-cli@0.2.11");
    expect((error as Error).message).not.toContain("legacy-secret-value");
    expect((error as Error).message).toContain("[redacted]");
  });

  it("rejects structurally incomplete JSON instead of trusting it", async () => {
    const splits = new SplitsCli(() => success({ data: { orgId: "org-1" } }));

    await expect(splits.whoAmI()).rejects.toMatchObject({ kind: "invalid-output" });
  });
});

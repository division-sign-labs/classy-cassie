// packages/cli/test/quotient-token.test.ts

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBotConfig } from "@quotient-forecasting/cassie-core";
import { saveBotConfig } from "../src/paths.js";
import {
  discoverQuotientToken,
  localEnvPath,
  localEnvQuotientToken,
  pinsKeyToKeystore,
  resolveQuotientToken,
} from "../src/quotient-token.js";

// The keystore entry, not the passphrase prompt, is what these tests are about.
const stored = { value: null as string | null };
vi.mock("../src/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/context.js")>()),
  getKeystoreSecret: async () => stored.value,
}));

const roots: string[] = [];
const originalToken = process.env.QUOTIENT_API_TOKEN;
const originalKey = process.env.QUOTIENT_API_KEY;
const originalHome = process.env.CASSIE_HOME;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  stored.value = null;
  if (originalToken === undefined) delete process.env.QUOTIENT_API_TOKEN;
  else process.env.QUOTIENT_API_TOKEN = originalToken;
  if (originalKey === undefined) delete process.env.QUOTIENT_API_KEY;
  else process.env.QUOTIENT_API_KEY = originalKey;
  if (originalHome === undefined) delete process.env.CASSIE_HOME;
  else process.env.CASSIE_HOME = originalHome;
});

/** A bot on disk under a throwaway CASSIE_HOME. */
function bot(botId: string, keySource: "auto" | "keystore"): void {
  const root = tempRoot();
  process.env.CASSIE_HOME = root;
  saveBotConfig(
    parseBotConfig({
      id: botId,
      venue: "polymarket",
      strategy: { id: "signals", config: {} },
      signals: { keySource },
    }),
  );
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cassie-token-test-"));
  roots.push(root);
  return root;
}

describe("Quotient token resolution", () => {
  it("finds the nearest .local.env while running in a nested directory", () => {
    const root = tempRoot();
    const nested = join(root, "packages", "cli");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".local.env"), "QUOTIENT_API_KEY=from-local-file\n");

    expect(localEnvPath(nested)).toBe(join(root, ".local.env"));
    expect(localEnvQuotientToken(nested)).toMatchObject({
      token: "from-local-file",
      source: "local-env",
      origin: `${join(root, ".local.env")} (QUOTIENT_API_KEY)`,
    });
  });

  it("prefers QUOTIENT_API_TOKEN over QUOTIENT_API_KEY inside .local.env", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, ".local.env"),
      "QUOTIENT_API_KEY=older-alias\nexport QUOTIENT_API_TOKEN=preferred-token # comment\n",
    );

    expect(localEnvQuotientToken(root)?.token).toBe("preferred-token");
  });

  it("lets a pinned bot keep its own key while a shared .local.env serves the rest", async () => {
    process.env.QUOTIENT_API_TOKEN = "shared-directory-key";
    stored.value = "this-bots-own-key";

    bot("pinned-bot", "keystore");
    expect(pinsKeyToKeystore("pinned-bot")).toBe(true);
    expect(await resolveQuotientToken("pinned-bot")).toMatchObject({
      token: "this-bots-own-key",
      source: "keystore",
    });

    // The unpinned bot still resolves from the shared working directory, which
    // is whatever .local.env or export this machine has, never its own entry.
    bot("shared-bot", "auto");
    expect(pinsKeyToKeystore("shared-bot")).toBe(false);
    const shared = await resolveQuotientToken("shared-bot");
    expect(shared?.source).toMatch(/^(local-env|env)$/);
    expect(shared?.token).not.toBe("this-bots-own-key");
  });

  it("refuses to fall back when a pinned bot has no stored key", async () => {
    process.env.QUOTIENT_API_TOKEN = "shared-directory-key";
    bot("pinned-bot", "keystore");
    await expect(resolveQuotientToken("pinned-bot")).rejects.toThrow(/no quotient-token entry is stored/);
  });

  it("treats a bot with no config as unpinned", () => {
    process.env.CASSIE_HOME = tempRoot();
    expect(pinsKeyToKeystore("never-created")).toBe(false);
  });

  it("lets project .local.env override a stale ambient export", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".local.env"), "QUOTIENT_API_KEY=from-local-file\n");
    process.env.QUOTIENT_API_TOKEN = "explicit-export";
    delete process.env.QUOTIENT_API_KEY;

    expect(discoverQuotientToken(root)).toEqual({
      token: "from-local-file",
      source: "local-env",
      origin: `${join(root, ".local.env")} (QUOTIENT_API_KEY)`,
    });
  });
});

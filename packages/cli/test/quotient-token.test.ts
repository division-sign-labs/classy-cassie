// packages/cli/test/quotient-token.test.ts

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverQuotientToken, localEnvPath, localEnvQuotientToken } from "../src/quotient-token.js";

const roots: string[] = [];
const originalToken = process.env.QUOTIENT_API_TOKEN;
const originalKey = process.env.QUOTIENT_API_KEY;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalToken === undefined) delete process.env.QUOTIENT_API_TOKEN;
  else process.env.QUOTIENT_API_TOKEN = originalToken;
  if (originalKey === undefined) delete process.env.QUOTIENT_API_KEY;
  else process.env.QUOTIENT_API_KEY = originalKey;
});

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

// packages/cli/test/ares-config.test.ts

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAresApiKey, discoverAresBuilderCode } from "../src/ares-config.js";

const BUILDER = "0xaca2b0761a55c278c8f145a3ec9ec8ccdea292610a4b4be5f2a6618139091c12";
const roots: string[] = [];
const originalKey = process.env.ARES_API_KEY;
const originalBuilder = process.env.ARES_BUILDER_CODE;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalKey === undefined) delete process.env.ARES_API_KEY;
  else process.env.ARES_API_KEY = originalKey;
  if (originalBuilder === undefined) delete process.env.ARES_BUILDER_CODE;
  else process.env.ARES_BUILDER_CODE = originalBuilder;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cassie-ares-test-"));
  roots.push(root);
  return root;
}

describe("Ares config resolution", () => {
  it("reads only the requested Ares values from the nearest .local.env", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, ".local.env"),
      `TESTER_PK=do-not-load\nARES_API_KEY=ares_sk_live_local\nARES_BUILDER_CODE=${BUILDER}\n`,
    );

    expect(discoverAresApiKey(root)).toEqual({
      value: "ares_sk_live_local",
      origin: `${join(root, ".local.env")} (ARES_API_KEY)`,
    });
    expect(discoverAresBuilderCode(root)?.value).toBe(BUILDER);
    expect(process.env.TESTER_PK).not.toBe("do-not-load");
  });

  it("lets project .local.env override stale ambient Ares exports", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".local.env"), `ARES_API_KEY=ares_sk_live_local\nARES_BUILDER_CODE=${BUILDER}\n`);
    process.env.ARES_API_KEY = "ares_sk_live_stale";
    process.env.ARES_BUILDER_CODE = `0x${"1".repeat(64)}`;

    expect(discoverAresApiKey(root)?.value).toBe("ares_sk_live_local");
    expect(discoverAresBuilderCode(root)?.value).toBe(BUILDER);
  });

  it("rejects malformed builder codes before they reach a bot config", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".local.env"), "ARES_BUILDER_CODE=0xshort\n");
    expect(() => discoverAresBuilderCode(root)).toThrow(/64 hex/);
  });
});

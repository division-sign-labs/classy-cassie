// packages/cli/test/child-env.test.ts

import { afterEach, describe, expect, it } from "vitest";
import { restrictedChildEnv } from "../src/child-env.js";

const originalPassphrase = process.env.CASSIE_PASSPHRASE;
const originalSplitsKey = process.env.SPLITS_API_KEY;

afterEach(() => {
  if (originalPassphrase === undefined) delete process.env.CASSIE_PASSPHRASE;
  else process.env.CASSIE_PASSPHRASE = originalPassphrase;
  if (originalSplitsKey === undefined) delete process.env.SPLITS_API_KEY;
  else process.env.SPLITS_API_KEY = originalSplitsKey;
});

describe("restrictedChildEnv", () => {
  it("passes only system and service-specific variables", () => {
    process.env.CASSIE_PASSPHRASE = "must-not-cross";
    process.env.SPLITS_API_KEY = "needed-by-splits";
    const env = restrictedChildEnv(["SPLITS_"]);
    expect(env.SPLITS_API_KEY).toBe("needed-by-splits");
    expect(env.CASSIE_PASSPHRASE).toBeUndefined();
    expect(env.PATH ?? env.Path).toBeDefined();
  });
});

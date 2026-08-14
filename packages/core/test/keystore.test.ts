// packages/core/test/keystore.test.ts
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keystore, WrongPassphraseError, decryptSecret, encryptSecret } from "@quotient-forecasting/cassie-core";

describe("encryptSecret/decryptSecret", () => {
  it("round-trips a secret", () => {
    const blob = encryptSecret("0xdeadbeef-secret", "hunter2 correct horse");
    expect(blob.kdf).toBe("scrypt");
    expect(decryptSecret(blob, "hunter2 correct horse")).toBe("0xdeadbeef-secret");
  });

  it("throws WrongPassphraseError on a wrong passphrase", () => {
    const blob = encryptSecret("top secret", "right");
    expect(() => decryptSecret(blob, "wrong")).toThrow(WrongPassphraseError);
  });

  it("produces unique salts/ivs per encryption", () => {
    const a = encryptSecret("same", "pass");
    const b = encryptSecret("same", "pass");
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });
});

describe("Keystore", () => {
  it("putEntry/getEntry round-trips exactly (export semantics)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cassie-ks-"));
    const ks = new Keystore(dir);
    const pk = "0x55f5000000000000000000000000000000000000000000000000000000000abc";
    ks.putEntry("bot-1", "master", pk, "passphrase-1", { address: "0xAbCd", runtimeEligible: false });
    expect(ks.getEntry("bot-1", "master", "passphrase-1")).toBe(pk);
  });

  it("stores the keystore file with mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "cassie-ks-"));
    const ks = new Keystore(dir);
    ks.putEntry("bot-2", "master", "sekrit", "pp");
    const mode = statSync(join(dir, "bot-2.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("persists runtimeEligible and address metadata, lists entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "cassie-ks-"));
    const ks = new Keystore(dir);
    ks.putEntry("bot-3", "master", "m", "pp", { address: "0x1111", runtimeEligible: false });
    ks.putEntry("bot-3", "agent", "a", "pp", { address: "0x2222", runtimeEligible: true });
    const listed = ks.list();
    expect(listed).toHaveLength(1);
    const entries = listed[0]!.entries;
    expect(entries.find((e) => e.name === "master")).toMatchObject({ address: "0x1111", runtimeEligible: false });
    expect(entries.find((e) => e.name === "agent")).toMatchObject({ address: "0x2222", runtimeEligible: true });
    expect(ks.entryMeta("bot-3", "agent")?.runtimeEligible).toBe(true);
  });

  it("returns null for missing bots/entries and wrong passphrase throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "cassie-ks-"));
    const ks = new Keystore(dir);
    expect(ks.getEntry("nope", "master", "pp")).toBeNull();
    ks.putEntry("bot-4", "master", "m", "pp");
    expect(ks.getEntry("bot-4", "other", "pp")).toBeNull();
    expect(() => ks.getEntry("bot-4", "master", "wrong")).toThrow(WrongPassphraseError);
  });

  it("re-import into a fresh keystore instance reads the same secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "cassie-ks-"));
    new Keystore(dir).putEntry("bot-5", "master", "exported-key", "pp");
    // Fresh instance simulates a fresh install pointed at the same file.
    expect(new Keystore(dir).getEntry("bot-5", "master", "pp")).toBe("exported-key");
  });
});

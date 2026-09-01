// packages/core/test/keystore.test.ts
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

  it("atomically replaces files without leaving temporary files", () => {
    const dir = mkdtempSync(join(tmpdir(), "cassie-ks-"));
    const ks = new Keystore(dir);
    ks.putEntry("bot-6", "master", "master-value", "pp");
    ks.putEntry("bot-6", "agent", "agent-value", "pp");

    expect(ks.getEntry("bot-6", "master", "pp")).toBe("master-value");
    expect(ks.getEntry("bot-6", "agent", "pp")).toBe("agent-value");
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(statSync(join(dir, "bot-6.json")).mode & 0o777).toBe(0o600);
  });

  it("rejects bot ids that could escape the keystore directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "cassie-ks-"));
    const ks = new Keystore(dir);
    expect(() => ks.putEntry("../outside", "master", "value", "pp")).toThrow(/bot id/);
    expect(() => ks.load("also/invalid")).toThrow(/bot id/);
  });

  it("verifies every existing entry before a caller adds another", () => {
    const dir = mkdtempSync(join(tmpdir(), "cassie-ks-"));
    const ks = new Keystore(dir);
    ks.putEntry("bot-7", "master", "value", "right");
    expect(ks.verifyPassphrase("bot-7", "right")).toBe(true);
    expect(() => ks.verifyPassphrase("bot-7", "wrong")).toThrow(WrongPassphraseError);
    expect(ks.verifyPassphrase("missing", "anything")).toBe(false);
  });

  it("changes the passphrase for every entry while preserving file and entry metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "cassie-ks-"));
    const ks = new Keystore(dir);
    ks.putEntry("bot-8", "master", "master-value", "old-passphrase", {
      address: "0x1111",
      runtimeEligible: false,
    });
    ks.putEntry("bot-8", "agent", "agent-value", "old-passphrase", {
      address: "0x2222",
      runtimeEligible: true,
    });
    const before = ks.load("bot-8")!;

    ks.changePassphrase("bot-8", "old-passphrase", "new-passphrase");

    const after = ks.load("bot-8")!;
    expect(after.version).toBe(before.version);
    expect(after.botId).toBe(before.botId);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.entries.master?.address).toBe("0x1111");
    expect(after.entries.master?.runtimeEligible).toBe(false);
    expect(after.entries.agent?.address).toBe("0x2222");
    expect(after.entries.agent?.runtimeEligible).toBe(true);
    expect(after.entries.master?.enc.salt).not.toBe(before.entries.master?.enc.salt);
    expect(after.entries.master?.enc.iv).not.toBe(before.entries.master?.enc.iv);
    expect(after.entries.agent?.enc.salt).not.toBe(before.entries.agent?.enc.salt);
    expect(after.entries.agent?.enc.iv).not.toBe(before.entries.agent?.enc.iv);
    expect(ks.getEntry("bot-8", "master", "new-passphrase")).toBe("master-value");
    expect(ks.getEntry("bot-8", "agent", "new-passphrase")).toBe("agent-value");
    expect(() => ks.getEntry("bot-8", "master", "old-passphrase")).toThrow(WrongPassphraseError);
    expect(statSync(join(dir, "bot-8.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves the keystore bytes unchanged when the old passphrase is wrong", () => {
    const dir = mkdtempSync(join(tmpdir(), "cassie-ks-"));
    const path = join(dir, "bot-9.json");
    const ks = new Keystore(dir);
    ks.putEntry("bot-9", "master", "master-value", "right-passphrase");
    ks.putEntry("bot-9", "agent", "agent-value", "right-passphrase", { runtimeEligible: true });
    const before = readFileSync(path);

    expect(() => ks.changePassphrase("bot-9", "wrong-passphrase", "new-passphrase")).toThrow(
      WrongPassphraseError,
    );

    expect(readFileSync(path)).toEqual(before);
    expect(ks.getEntry("bot-9", "master", "right-passphrase")).toBe("master-value");
    expect(ks.getEntry("bot-9", "agent", "right-passphrase")).toBe("agent-value");
  });

  it("authenticates all entries before rotating any of them", () => {
    const dir = mkdtempSync(join(tmpdir(), "cassie-ks-"));
    const path = join(dir, "bot-10.json");
    const ks = new Keystore(dir);
    ks.putEntry("bot-10", "master", "master-value", "old-passphrase");
    // Simulate a partially corrupted/mixed-passphrase file. The first entry
    // decrypts, but the later failure must still leave the whole file intact.
    ks.putEntry("bot-10", "agent", "agent-value", "different-passphrase", { runtimeEligible: true });
    const before = readFileSync(path);

    expect(() => ks.changePassphrase("bot-10", "old-passphrase", "new-passphrase")).toThrow(
      WrongPassphraseError,
    );

    expect(readFileSync(path)).toEqual(before);
    expect(ks.getEntry("bot-10", "master", "old-passphrase")).toBe("master-value");
    expect(ks.getEntry("bot-10", "agent", "different-passphrase")).toBe("agent-value");
  });

  it("rejects missing or empty keystores and an empty new passphrase without writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cassie-ks-"));
    const ks = new Keystore(dir);
    expect(() => ks.changePassphrase("missing", "old", "new")).toThrow(/no keystore/);

    ks.putEntry("bot-11", "master", "value", "old-passphrase");
    const populatedPath = join(dir, "bot-11.json");
    const populatedBefore = readFileSync(populatedPath);
    expect(() => ks.changePassphrase("bot-11", "old-passphrase", "")).toThrow(/new keystore passphrase is required/);
    expect(readFileSync(populatedPath)).toEqual(populatedBefore);

    const emptyPath = join(dir, "bot-12.json");
    writeFileSync(
      emptyPath,
      JSON.stringify({ version: 1, botId: "bot-12", createdAt: "2026-08-31T00:00:00.000Z", entries: {} }) + "\n",
      { mode: 0o600 },
    );
    const emptyBefore = readFileSync(emptyPath);
    expect(() => ks.changePassphrase("bot-12", "old", "new")).toThrow(/has no entries/);
    expect(readFileSync(emptyPath)).toEqual(emptyBefore);
  });
});

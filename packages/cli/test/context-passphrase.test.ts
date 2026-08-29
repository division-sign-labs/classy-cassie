// packages/cli/test/context-passphrase.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prompts from "prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCachedPassphrase, getPassphrase, keystore } from "../src/context.js";
import { systemPassphraseStore } from "../src/passphrase-store.js";

vi.mock("prompts", () => ({ default: vi.fn() }));

const originalCwd = process.cwd();
const originalHome = process.env.CASSIE_HOME;
const originalPassphrase = process.env.CASSIE_PASSPHRASE;
const originalIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cassie-passphrase-"));
  process.chdir(root);
  process.env.CASSIE_HOME = join(root, "home");
  delete process.env.CASSIE_PASSPHRASE;
  clearCachedPassphrase();
  vi.mocked(prompts).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearCachedPassphrase();
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.CASSIE_HOME;
  else process.env.CASSIE_HOME = originalHome;
  if (originalPassphrase === undefined) delete process.env.CASSIE_PASSPHRASE;
  else process.env.CASSIE_PASSPHRASE = originalPassphrase;
  if (originalIsTty) Object.defineProperty(process.stdin, "isTTY", originalIsTty);
  else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
  rmSync(root, { recursive: true, force: true });
});

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
}

describe("getPassphrase", () => {
  it("keeps CASSIE_PASSPHRASE as an explicit override", async () => {
    process.env.CASSIE_PASSPHRASE = "from-env";
    const get = vi.spyOn(systemPassphraseStore, "get").mockResolvedValue("from-store");

    expect(await getPassphrase("bot-1")).toBe("from-env");
    expect(get).not.toHaveBeenCalled();
  });

  it("reads a remembered passphrase without a prompt", async () => {
    vi.spyOn(systemPassphraseStore, "isSupported").mockReturnValue(true);
    vi.spyOn(systemPassphraseStore, "get").mockResolvedValue("from-store");

    expect(await getPassphrase("bot-1")).toBe("from-store");
    expect(prompts).not.toHaveBeenCalled();
  });

  it("offers native storage after a confirmed first passphrase", async () => {
    setTty(true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(systemPassphraseStore, "isSupported").mockReturnValue(true);
    vi.spyOn(systemPassphraseStore, "get").mockResolvedValue(undefined);
    vi.spyOn(systemPassphraseStore, "isAvailable").mockResolvedValue(true);
    const set = vi.spyOn(systemPassphraseStore, "set").mockResolvedValue();
    vi.mocked(prompts)
      .mockResolvedValueOnce({ pass: "new-passphrase" })
      .mockResolvedValueOnce({ again: "new-passphrase" })
      .mockResolvedValueOnce({ remember: true });

    expect(await getPassphrase("bot-1", true)).toBe("new-passphrase");
    expect(set).toHaveBeenCalledWith("bot-1", "new-passphrase");
  });

  it("gives non-interactive callers an actionable error", async () => {
    setTty(false);
    vi.spyOn(systemPassphraseStore, "isSupported").mockReturnValue(false);

    await expect(getPassphrase("bot-1")).rejects.toThrow(
      "Run `cassie passphrase remember bot-1` once, or set CASSIE_PASSPHRASE",
    );
  });

  it("preserves a saved passphrase when decryption could also indicate corruption", async () => {
    setTty(false);
    keystore().putEntry("bot-1", "master", "secret", "correct", { runtimeEligible: false });
    vi.spyOn(systemPassphraseStore, "isSupported").mockReturnValue(true);
    vi.spyOn(systemPassphraseStore, "get").mockResolvedValue("wrong");
    const remove = vi.spyOn(systemPassphraseStore, "delete").mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(getPassphrase("bot-1")).rejects.toThrow(/saved passphrase.*did not unlock/);
    expect(remove).not.toHaveBeenCalled();
  });
});

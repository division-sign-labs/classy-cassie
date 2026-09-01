// packages/cli/test/passphrase-change.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  changeKeystorePassphrase: vi.fn(),
  clearCachedPassphrase: vi.fn(),
  getPassphrase: vi.fn(),
  keystoreExists: vi.fn(),
  resolveLocalValue: vi.fn(),
  storeGet: vi.fn(),
  storeIsSupported: vi.fn(),
  storeLabel: vi.fn(),
  storeSet: vi.fn(),
}));

vi.mock("../src/context.js", () => ({
  ask: mocks.ask,
  clearCachedPassphrase: mocks.clearCachedPassphrase,
  getPassphrase: mocks.getPassphrase,
  keystore: () => ({
    exists: mocks.keystoreExists,
    changePassphrase: mocks.changeKeystorePassphrase,
  }),
}));

vi.mock("../src/local-env.js", () => ({ resolveLocalValue: mocks.resolveLocalValue }));

vi.mock("../src/passphrase-store.js", () => ({
  systemPassphraseStore: {
    get: mocks.storeGet,
    isSupported: mocks.storeIsSupported,
    label: mocks.storeLabel,
    set: mocks.storeSet,
  },
}));

import { changePassphrase } from "../src/commands/passphrase.js";

function printed(): string {
  return [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls].flat().join("\n");
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.keystoreExists.mockReturnValue(true);
  mocks.getPassphrase.mockResolvedValue("current-passphrase");
  mocks.ask.mockResolvedValueOnce("new-passphrase").mockResolvedValueOnce("new-passphrase");
  mocks.storeIsSupported.mockReturnValue(false);
  mocks.storeLabel.mockReturnValue("test credential store");
  mocks.resolveLocalValue.mockReturnValue(null);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("changePassphrase", () => {
  it("rotates once from hidden prompts, clears the stale cache, and prints no secret", async () => {
    await changePassphrase("bot-1");

    expect(mocks.getPassphrase).toHaveBeenCalledOnce();
    expect(mocks.getPassphrase).toHaveBeenCalledWith("bot-1");
    expect(mocks.ask).toHaveBeenNthCalledWith(1, "New keystore passphrase", { secret: true });
    expect(mocks.ask).toHaveBeenNthCalledWith(2, "Confirm new keystore passphrase", { secret: true });
    expect(mocks.changeKeystorePassphrase).toHaveBeenCalledOnce();
    expect(mocks.changeKeystorePassphrase).toHaveBeenCalledWith(
      "bot-1",
      "current-passphrase",
      "new-passphrase",
    );
    expect(mocks.clearCachedPassphrase).toHaveBeenCalledWith("bot-1");
    expect(mocks.changeKeystorePassphrase.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clearCachedPassphrase.mock.invocationCallOrder[0]!,
    );

    const output = printed();
    expect(output).toContain('Changed the keystore passphrase for bot "bot-1".');
    expect(output).toContain("Running deployments are unaffected");
    expect(output).not.toContain("current-passphrase");
    expect(output).not.toContain("new-passphrase");
  });

  it.each([
    { name: "blank", next: "   ", confirmation: "   ", message: "new keystore passphrase is required" },
    { name: "mismatched", next: "new-passphrase", confirmation: "different", message: "do not match" },
    {
      name: "unchanged",
      next: "current-passphrase",
      confirmation: "current-passphrase",
      message: "must differ from the current passphrase",
    },
  ])("rejects a $name replacement before mutation", async ({ next, confirmation, message }) => {
    mocks.ask.mockReset().mockResolvedValueOnce(next).mockResolvedValueOnce(confirmation);

    await expect(changePassphrase("bot-1")).rejects.toThrow(message);

    expect(mocks.ask).toHaveBeenCalledTimes(2);
    expect(mocks.changeKeystorePassphrase).not.toHaveBeenCalled();
    expect(mocks.clearCachedPassphrase).not.toHaveBeenCalled();
    expect(mocks.storeSet).not.toHaveBeenCalled();
  });

  it("rejects a missing keystore before resolving or prompting for any secret", async () => {
    mocks.keystoreExists.mockReturnValue(false);

    await expect(changePassphrase("missing-bot")).rejects.toThrow('no keystore for bot "missing-bot"');

    expect(mocks.resolveLocalValue).not.toHaveBeenCalled();
    expect(mocks.getPassphrase).not.toHaveBeenCalled();
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.changeKeystorePassphrase).not.toHaveBeenCalled();
  });

  it("delegates current-passphrase resolution failures without touching the keystore", async () => {
    mocks.getPassphrase.mockRejectedValue(new Error("saved passphrase did not unlock the keystore"));

    await expect(changePassphrase("bot-1")).rejects.toThrow("saved passphrase did not unlock the keystore");

    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.changeKeystorePassphrase).not.toHaveBeenCalled();
    expect(mocks.clearCachedPassphrase).not.toHaveBeenCalled();
  });

  it("delegates a wrong current passphrase to the atomic keystore rotation", async () => {
    mocks.changeKeystorePassphrase.mockImplementation(() => {
      throw new Error("wrong passphrase (or corrupted keystore)");
    });

    await expect(changePassphrase("bot-1")).rejects.toThrow("wrong passphrase (or corrupted keystore)");

    expect(mocks.changeKeystorePassphrase).toHaveBeenCalledOnce();
    expect(mocks.clearCachedPassphrase).not.toHaveBeenCalled();
    expect(mocks.storeSet).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("updates an existing native credential-store entry after rotation", async () => {
    mocks.storeIsSupported.mockReturnValue(true);
    mocks.storeGet.mockResolvedValue("saved-current-passphrase");

    await changePassphrase("bot-1");

    expect(mocks.storeSet).toHaveBeenCalledOnce();
    expect(mocks.storeSet).toHaveBeenCalledWith("bot-1", "new-passphrase");
    expect(mocks.changeKeystorePassphrase.mock.invocationCallOrder[0]).toBeLessThan(mocks.storeSet.mock.invocationCallOrder[0]!);
  });

  it("updates a store entry accepted while the current passphrase is being resolved", async () => {
    let rememberedDuringResolution = false;
    mocks.storeIsSupported.mockReturnValue(true);
    mocks.getPassphrase.mockImplementation(async () => {
      rememberedDuringResolution = true;
      return "current-passphrase";
    });
    mocks.storeGet.mockImplementation(async () =>
      rememberedDuringResolution ? "saved-current-passphrase" : undefined,
    );

    await changePassphrase("bot-1");

    expect(mocks.storeSet).toHaveBeenCalledWith("bot-1", "new-passphrase");
  });

  it("does not opt into native storage when no entry existed", async () => {
    mocks.storeIsSupported.mockReturnValue(true);
    mocks.storeGet.mockResolvedValue(undefined);

    await changePassphrase("bot-1");

    expect(mocks.storeSet).not.toHaveBeenCalled();
  });

  it("warns clearly when an existing saved entry cannot be updated without failing the rotation", async () => {
    mocks.storeIsSupported.mockReturnValue(true);
    mocks.storeGet.mockResolvedValue("saved-current-passphrase");
    mocks.storeSet.mockRejectedValue(new Error("keychain is locked"));

    await expect(changePassphrase("bot-1")).resolves.toBeUndefined();

    expect(mocks.changeKeystorePassphrase).toHaveBeenCalledOnce();
    expect(mocks.clearCachedPassphrase).toHaveBeenCalledWith("bot-1");
    const warning = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(warning).toContain("the keystore passphrase was changed");
    expect(warning).toContain("saved test credential store entry could not be updated");
    expect(warning).toContain("keychain is locked");
    expect(warning).toContain("cassie passphrase remember bot-1");
  });

  it("names an explicit override that must be updated or removed without printing its value", async () => {
    mocks.resolveLocalValue.mockReturnValue({
      value: "override-secret",
      source: "local-env",
      origin: "/repo/.local.env (CASSIE_PASSPHRASE)",
      name: "CASSIE_PASSPHRASE",
    });

    await changePassphrase("bot-1");

    const warning = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(warning).toContain("/repo/.local.env (CASSIE_PASSPHRASE)");
    expect(warning).toContain("Update or remove that override");
    expect(warning).not.toContain("override-secret");
  });
});

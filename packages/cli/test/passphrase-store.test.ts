// packages/cli/test/passphrase-store.test.ts

import { describe, expect, it, vi } from "vitest";
import { SystemPassphraseStore } from "../src/passphrase-store.js";

function fakeStore(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}, home = "/operator/.cassie") {
  const values = new Map<string, string>();
  const load = vi.fn(async () => ({
    Entry: class {
      private readonly key: string;

      constructor(service: string, account: string) {
        this.key = `${service}:${account}`;
      }

      getPassword(): string | undefined {
        return values.get(this.key);
      }

      setPassword(password: string): void {
        values.set(this.key, password);
      }

      deletePassword(): boolean {
        return values.delete(this.key);
      }
    },
  }));
  return { store: new SystemPassphraseStore({ platform, env, home: () => home, load }), load, values };
}

describe("SystemPassphraseStore", () => {
  it("stores separate passphrases per bot and Cassie home", async () => {
    const first = fakeStore("darwin");
    await first.store.set("bot-1", "one");
    await first.store.set("bot-2", "two");

    expect(await first.store.get("bot-1")).toBe("one");
    expect(await first.store.get("bot-2")).toBe("two");
    expect(await first.store.delete("bot-1")).toBe(true);
    expect(await first.store.get("bot-1")).toBeUndefined();
    expect(first.store.account("bot-1")).not.toBe(fakeStore("darwin", {}, "/other/.cassie").store.account("bot-1"));
  });

  it("uses the native store names", () => {
    expect(fakeStore("darwin").store.label()).toBe("macOS Keychain");
    expect(fakeStore("win32").store.label()).toBe("Windows Credential Manager");
    expect(fakeStore("linux", { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus" }).store.label()).toBe(
      "Linux Secret Service",
    );
  });

  it("does not treat the ephemeral Linux kernel keyring as persistent storage", async () => {
    const { store, load } = fakeStore("linux");
    expect(store.isSupported()).toBe(false);
    expect(await store.isAvailable("bot-1")).toBe(false);
    expect(load).not.toHaveBeenCalled();
    await expect(store.get("bot-1")).rejects.toThrow(/desktop D-Bus session/);
  });
});

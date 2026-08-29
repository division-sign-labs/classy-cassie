// packages/cli/src/passphrase-store.ts
// Per-bot keystore passphrases in the operator's native credential store.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { dirs } from "./paths.js";

const SERVICE = "social.quotient.cassie";
const BOT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

interface NativeEntry {
  getPassword(): string | null | undefined;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

interface NativeKeyring {
  Entry: new (service: string, username: string) => NativeEntry;
}

export interface SystemPassphraseStoreOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: () => string;
  load?: () => Promise<NativeKeyring>;
}

export class SystemPassphraseStore {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: () => string;
  private readonly load: () => Promise<NativeKeyring>;

  constructor(options: SystemPassphraseStoreOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.home = options.home ?? dirs.home;
    this.load = options.load ?? (async () => import("@napi-rs/keyring"));
  }

  label(): string {
    switch (this.platform) {
      case "darwin":
        return "macOS Keychain";
      case "win32":
        return "Windows Credential Manager";
      case "linux":
        return "Linux Secret Service";
      default:
        return "system credential store";
    }
  }

  /** Linux persistence requires a desktop Secret Service, not kernel keyutils. */
  isSupported(): boolean {
    return (
      this.platform === "darwin" ||
      this.platform === "win32" ||
      (this.platform === "linux" && Boolean(this.env.DBUS_SESSION_BUS_ADDRESS))
    );
  }

  async isAvailable(botId: string): Promise<boolean> {
    if (!this.isSupported()) return false;
    this.account(botId);
    try {
      await this.entry(botId);
      return true;
    } catch {
      return false;
    }
  }

  async get(botId: string): Promise<string | undefined> {
    return (await this.entry(botId)).getPassword() ?? undefined;
  }

  async set(botId: string, passphrase: string): Promise<void> {
    (await this.entry(botId)).setPassword(passphrase);
  }

  async delete(botId: string): Promise<boolean> {
    return (await this.entry(botId)).deletePassword();
  }

  account(botId: string): string {
    if (!BOT_ID_RE.test(botId)) throw new Error("invalid bot id for credential storage");
    const homeId = createHash("sha256").update(resolve(this.home())).digest("hex").slice(0, 16);
    return `keystore:${botId}:${homeId}`;
  }

  private async entry(botId: string): Promise<NativeEntry> {
    if (!this.isSupported()) {
      const detail =
        this.platform === "linux"
          ? "Linux Secret Service needs a desktop D-Bus session"
          : `credential storage is not supported on ${this.platform}`;
      throw new Error(detail);
    }
    const { Entry } = await this.load();
    return new Entry(SERVICE, this.account(botId));
  }
}

export const systemPassphraseStore = new SystemPassphraseStore();

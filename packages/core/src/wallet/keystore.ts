// packages/core/src/wallet/keystore.ts
// Local keystore: per-bot file of named secret entries, AES-256-GCM with a
// scrypt-derived key from an operator passphrase. Node-only (uses node:crypto
// and node:fs). The deployed runtime never sees it — only the credentials
// `cassie deploy` extracts from it cross to the droplet.

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface EncryptedBlob {
  kdf: "scrypt";
  n: number;
  r: number;
  p: number;
  salt: string; // hex
  iv: string; // hex
  ct: string; // hex
  tag: string; // hex
}

export interface KeystoreEntry {
  /** Public address, when the secret is an EVM private key. */
  address?: string;
  /** Whether this secret may be pushed to a deployed runtime (§4, §11). */
  runtimeEligible: boolean;
  enc: EncryptedBlob;
}

export interface KeystoreFile {
  version: 1;
  botId: string;
  createdAt: string;
  entries: Record<string, KeystoreEntry>;
}

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const BOT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export class WrongPassphraseError extends Error {
  constructor() {
    super("wrong passphrase (or corrupted keystore)");
    this.name = "WrongPassphraseError";
  }
}

export function encryptSecret(plaintext: string, passphrase: string): EncryptedBlob {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  // maxmem: scrypt needs 128·N·r bytes (32 MiB at these params), which is
  // exactly Node's default ceiling — give it headroom.
  const key = scryptSync(passphrase, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    kdf: "scrypt",
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    ct: ct.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  };
}

export function decryptSecret(blob: EncryptedBlob, passphrase: string): string {
  const key = scryptSync(passphrase, Buffer.from(blob.salt, "hex"), 32, {
    N: blob.n,
    r: blob.r,
    p: blob.p,
    maxmem: Math.max(128 * 1024 * 1024, 256 * blob.n * blob.r),
  });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
  decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(blob.ct, "hex")), decipher.final()]).toString("utf8");
  } catch {
    throw new WrongPassphraseError();
  }
}

export class Keystore {
  constructor(private readonly keysDir: string) {}

  private pathFor(botId: string): string {
    if (!BOT_ID_RE.test(botId)) {
      throw new Error("bot id must be lowercase alphanumerics/dashes, start with an alphanumeric, and be at most 32 characters");
    }
    return join(this.keysDir, `${botId}.json`);
  }

  exists(botId: string): boolean {
    return existsSync(this.pathFor(botId));
  }

  load(botId: string): KeystoreFile | null {
    const p = this.pathFor(botId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as KeystoreFile;
  }

  private save(file: KeystoreFile): void {
    mkdirSync(this.keysDir, { recursive: true, mode: 0o700 });
    const p = this.pathFor(file.botId);
    const temporary = join(this.keysDir, `.${file.botId}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(file, null, 2) + "\n", "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, p);
      chmodSync(p, 0o600);
      // Make the rename durable before callers rely on the newly stored key.
      // Node cannot open directory handles on Windows; NTFS rename semantics
      // are the platform fallback there.
      if (process.platform !== "win32") {
        const directoryDescriptor = openSync(this.keysDir, "r");
        try {
          fsyncSync(directoryDescriptor);
        } finally {
          closeSync(directoryDescriptor);
        }
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) rmSync(temporary);
    }
  }

  list(): { botId: string; entries: { name: string; address?: string; runtimeEligible: boolean }[] }[] {
    if (!existsSync(this.keysDir)) return [];
    return readdirSync(this.keysDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const file = JSON.parse(readFileSync(join(this.keysDir, f), "utf8")) as KeystoreFile;
        return {
          botId: file.botId,
          entries: Object.entries(file.entries).map(([name, e]) => ({
            name,
            address: e.address,
            runtimeEligible: e.runtimeEligible,
          })),
        };
      });
  }

  putEntry(
    botId: string,
    name: string,
    secret: string,
    passphrase: string,
    meta: { address?: string; runtimeEligible?: boolean } = {},
  ): void {
    const file: KeystoreFile = this.load(botId) ?? {
      version: 1,
      botId,
      createdAt: new Date().toISOString(),
      entries: {},
    };
    file.entries[name] = {
      address: meta.address,
      runtimeEligible: meta.runtimeEligible ?? false,
      enc: encryptSecret(secret, passphrase),
    };
    this.save(file);
  }

  getEntry(botId: string, name: string, passphrase: string): string | null {
    const file = this.load(botId);
    const entry = file?.entries[name];
    if (!entry) return null;
    return decryptSecret(entry.enc, passphrase);
  }

  entryMeta(botId: string, name: string): KeystoreEntry | null {
    return this.load(botId)?.entries[name] ?? null;
  }

  /** Fail before adding entries under a passphrase different from the file. */
  verifyPassphrase(botId: string, passphrase: string): boolean {
    const file = this.load(botId);
    if (!file) return false;
    for (const entry of Object.values(file.entries)) decryptSecret(entry.enc, passphrase);
    return true;
  }

}

/**
 * Conventional entry names. Master/L1 entries are marked local-only; the
 * current Polymarket adapter is a documented exception that explicitly reads
 * its signer into RuntimeCreds, so it must not be reused for Splits authority.
 */
export const KeyRoles = {
  master: "master", // Polymarket signer EOA / HL master / Lighter L1
  agent: "agent", // HL agent key (runtime-eligible)
  lighterApi: "lighter-api", // Lighter API private key (runtime-eligible)
  polymarketL2: "polymarket-l2", // CLOB L2 creds JSON (runtime-eligible)
  telegramToken: "telegram-token", // bot token (runtime-eligible)
  quotientToken: "quotient-token", // signal API token (runtime-eligible)
  aresApiKey: "ares-api-key", // Ares feed key, ares_sk_live_… (runtime-eligible)
  kalshiApi: "kalshi-api", // Kalshi RSA private key, single-line base64 PKCS#8 DER (runtime-eligible)
  surplusApiKey: "surplus-api-key", // Surplus Intelligence LLM key, inf_… (runtime-eligible)
} as const;

// packages/runtime-container/src/bootstrap-wallet.ts

import {
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { generateEoa } from "@quotient-forecasting/cassie-core";

export const WALLET_BOOTSTRAP_VERSION = 1 as const;
export const WALLET_BOOTSTRAP_NO_STORE_HEADERS = Object.freeze({
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
});

export interface WalletBootstrapRequest {
  version: typeof WALLET_BOOTSTRAP_VERSION;
  botId: string;
  sessionId: string;
  publicKeySpki: string;
  publicKeyFingerprint: string;
  challenge: string;
}

/** The only wallet material that may leave the bootstrap container. */
export interface WalletBootstrapEnvelope {
  version: typeof WALLET_BOOTSTRAP_VERSION;
  botId: string;
  sessionId: string;
  publicKeyFingerprint: string;
  address: string;
  ciphertext: string;
  digest: string;
}

/**
 * Compact names keep the complete JSON payload below RSA-3072 OAEP's
 * 318-byte SHA-256 plaintext limit. All request bindings are still present:
 * v=version, b=bot id, s=session, f=key fingerprint, c=challenge,
 * a=address, k=private key, x=one-use acknowledgement secret.
 */
interface SealedWalletPayload {
  v: typeof WALLET_BOOTSTRAP_VERSION;
  b: string;
  s: string;
  f: string;
  c: string;
  a: string;
  k: string;
  x: string;
}

const BOT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const SHA256_RE = /^sha256:[A-Za-z0-9_-]{43}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const RESPONSE_KEYS = [
  "address",
  "botId",
  "ciphertext",
  "digest",
  "publicKeyFingerprint",
  "sessionId",
  "version",
] as const;
const REQUEST_KEYS = [
  "botId",
  "challenge",
  "publicKeyFingerprint",
  "publicKeySpki",
  "sessionId",
  "version",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function decodeBase64Url(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`invalid ${label}`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) throw new Error(`invalid ${label}`);
  return decoded;
}

function sha256(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}`;
}

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestLabel(request: WalletBootstrapRequest): Buffer {
  return Buffer.from(
    JSON.stringify([
      "cassie-wallet-bootstrap",
      request.version,
      request.botId,
      request.sessionId,
      request.publicKeyFingerprint,
      request.challenge,
    ]),
  );
}

function publicKeyFromRequest(request: WalletBootstrapRequest): KeyObject {
  const spki = decodeBase64Url(request.publicKeySpki, "bootstrap public key");
  let key: KeyObject;
  try {
    key = createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    throw new Error("invalid bootstrap public key");
  }
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 3072) {
    throw new Error("bootstrap public key must be RSA-3072");
  }
  const canonicalSpki = key.export({ format: "der", type: "spki" });
  if (spki.length !== canonicalSpki.length || !timingSafeEqual(spki, canonicalSpki)) {
    throw new Error("bootstrap public key is not canonical DER");
  }
  if (!equalText(sha256(spki), request.publicKeyFingerprint)) {
    throw new Error("bootstrap public-key fingerprint mismatch");
  }
  return key;
}

export function parseWalletBootstrapRequest(value: unknown): WalletBootstrapRequest {
  if (!isRecord(value) || !hasExactKeys(value, REQUEST_KEYS)) throw new Error("invalid wallet bootstrap request");
  if (value.version !== WALLET_BOOTSTRAP_VERSION) throw new Error("unsupported wallet bootstrap version");
  if (typeof value.botId !== "string" || !BOT_ID_RE.test(value.botId)) throw new Error("invalid bootstrap bot id");
  if (typeof value.sessionId !== "string" || !TOKEN_RE.test(value.sessionId)) {
    throw new Error("invalid bootstrap session id");
  }
  if (typeof value.challenge !== "string" || !TOKEN_RE.test(value.challenge)) {
    throw new Error("invalid bootstrap challenge");
  }
  if (typeof value.publicKeyFingerprint !== "string" || !SHA256_RE.test(value.publicKeyFingerprint)) {
    throw new Error("invalid bootstrap public-key fingerprint");
  }
  if (typeof value.publicKeySpki !== "string") throw new Error("invalid bootstrap public key");

  const request: WalletBootstrapRequest = {
    version: value.version,
    botId: value.botId,
    sessionId: value.sessionId,
    publicKeySpki: value.publicKeySpki,
    publicKeyFingerprint: value.publicKeyFingerprint,
    challenge: value.challenge,
  };
  publicKeyFromRequest(request);
  return request;
}

/** Public verifier used by the control plane to authorize one-use consumption. */
export function walletBootstrapAckDigest(ackSecret: string): string {
  if (!TOKEN_RE.test(ackSecret)) throw new Error("invalid acknowledgement secret");
  return sha256(JSON.stringify(["cassie-wallet-bootstrap-ack", WALLET_BOOTSTRAP_VERSION, ackSecret]));
}

/**
 * Generate a fresh EOA in this process and immediately seal it to the CLI's
 * ephemeral RSA recipient. The returned object contains no plaintext secret.
 */
export function createWalletBootstrapEnvelope(input: unknown): WalletBootstrapEnvelope {
  const request = parseWalletBootstrapRequest(input);
  const recipient = publicKeyFromRequest(request);
  const wallet = generateEoa();
  const ackSecret = randomBytes(16).toString("base64url");
  const payload: SealedWalletPayload = {
    v: WALLET_BOOTSTRAP_VERSION,
    b: request.botId,
    s: request.sessionId,
    f: request.publicKeyFingerprint,
    c: request.challenge,
    a: wallet.address,
    k: wallet.privateKey,
    x: ackSecret,
  };
  const plaintext = Buffer.from(JSON.stringify(payload));
  let ciphertext: string;
  try {
    // RSA-3072 with OAEP/SHA-256 permits at most 318 plaintext bytes.
    if (plaintext.length > 318) throw new Error("wallet bootstrap payload exceeds RSA-OAEP limit");
    ciphertext = publicEncrypt(
      {
        key: recipient,
        oaepHash: "sha256",
        oaepLabel: requestLabel(request),
      },
      plaintext,
    ).toString("base64url");
  } finally {
    plaintext.fill(0);
  }

  const unsigned: Omit<WalletBootstrapEnvelope, "digest"> = {
    version: WALLET_BOOTSTRAP_VERSION,
    botId: request.botId,
    sessionId: request.sessionId,
    publicKeyFingerprint: request.publicKeyFingerprint,
    address: wallet.address,
    ciphertext,
  };
  const envelope: WalletBootstrapEnvelope = { ...unsigned, digest: walletBootstrapAckDigest(ackSecret) };
  if (!hasExactKeys(envelope, RESPONSE_KEYS) || !EVM_ADDRESS_RE.test(envelope.address)) {
    throw new Error("failed to create wallet bootstrap envelope");
  }
  return envelope;
}

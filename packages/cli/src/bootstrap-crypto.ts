// packages/cli/src/bootstrap-crypto.ts

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { addressFromPk } from "@quotient-forecasting/cassie-core";

export const WALLET_BOOTSTRAP_VERSION = 1 as const;

export interface WalletBootstrapRequest {
  readonly version: typeof WALLET_BOOTSTRAP_VERSION;
  readonly botId: string;
  readonly sessionId: string;
  readonly publicKeySpki: string;
  readonly publicKeyFingerprint: string;
  readonly challenge: string;
}

export interface WalletBootstrapEnvelope {
  version: typeof WALLET_BOOTSTRAP_VERSION;
  botId: string;
  sessionId: string;
  publicKeyFingerprint: string;
  address: string;
  ciphertext: string;
  digest: string;
}

/** Keep this object in memory only; never serialize or send `privateKey`. */
export interface WalletBootstrapSession {
  readonly request: WalletBootstrapRequest;
  readonly privateKey: KeyObject;
}

export interface DecryptedBootstrapWallet {
  botId: string;
  sessionId: string;
  address: string;
  privateKey: string;
  ackSecret: string;
}

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
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const ENVELOPE_KEYS = [
  "address",
  "botId",
  "ciphertext",
  "digest",
  "publicKeyFingerprint",
  "sessionId",
  "version",
] as const;
const PAYLOAD_KEYS = ["a", "b", "c", "f", "k", "s", "v", "x"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
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

/** Compute the public verifier for the encrypted one-use acknowledgement. */
export function walletBootstrapAckDigest(ackSecret: string): string {
  if (!TOKEN_RE.test(ackSecret)) throw new Error("invalid acknowledgement secret");
  return sha256(JSON.stringify(["cassie-wallet-bootstrap-ack", WALLET_BOOTSTRAP_VERSION, ackSecret]));
}

function parseEnvelope(value: unknown): WalletBootstrapEnvelope {
  if (!isRecord(value) || !hasExactKeys(value, ENVELOPE_KEYS)) throw new Error("invalid wallet bootstrap envelope");
  if (value.version !== WALLET_BOOTSTRAP_VERSION) throw new Error("unsupported wallet bootstrap version");
  if (typeof value.botId !== "string" || !BOT_ID_RE.test(value.botId)) throw new Error("invalid envelope bot id");
  if (typeof value.sessionId !== "string" || !TOKEN_RE.test(value.sessionId)) {
    throw new Error("invalid envelope session id");
  }
  if (typeof value.publicKeyFingerprint !== "string" || !SHA256_RE.test(value.publicKeyFingerprint)) {
    throw new Error("invalid envelope public-key fingerprint");
  }
  if (typeof value.address !== "string" || !EVM_ADDRESS_RE.test(value.address)) {
    throw new Error("invalid envelope address");
  }
  if (typeof value.ciphertext !== "string") throw new Error("invalid envelope ciphertext");
  const ciphertext = decodeBase64Url(value.ciphertext, "envelope ciphertext");
  if (ciphertext.length !== 384) throw new Error("invalid envelope ciphertext length");
  if (typeof value.digest !== "string" || !SHA256_RE.test(value.digest)) throw new Error("invalid envelope digest");
  return {
    version: value.version,
    botId: value.botId,
    sessionId: value.sessionId,
    publicKeyFingerprint: value.publicKeyFingerprint,
    address: value.address,
    ciphertext: value.ciphertext,
    digest: value.digest,
  };
}

function parsePayload(value: unknown): SealedWalletPayload {
  if (!isRecord(value) || !hasExactKeys(value, PAYLOAD_KEYS)) throw new Error("invalid decrypted wallet payload");
  if (value.v !== WALLET_BOOTSTRAP_VERSION) throw new Error("unsupported decrypted wallet version");
  if (typeof value.b !== "string" || !BOT_ID_RE.test(value.b)) throw new Error("invalid decrypted bot id");
  if (typeof value.s !== "string" || !TOKEN_RE.test(value.s)) throw new Error("invalid decrypted session id");
  if (typeof value.f !== "string" || !SHA256_RE.test(value.f)) {
    throw new Error("invalid decrypted public-key fingerprint");
  }
  if (typeof value.c !== "string" || !TOKEN_RE.test(value.c)) throw new Error("invalid decrypted challenge");
  if (typeof value.a !== "string" || !EVM_ADDRESS_RE.test(value.a)) throw new Error("invalid decrypted address");
  if (typeof value.k !== "string" || !PRIVATE_KEY_RE.test(value.k)) throw new Error("invalid decrypted private key");
  if (typeof value.x !== "string" || !TOKEN_RE.test(value.x)) throw new Error("invalid acknowledgement secret");
  return {
    v: value.v,
    b: value.b,
    s: value.s,
    f: value.f,
    c: value.c,
    a: value.a,
    k: value.k,
    x: value.x,
  };
}

/** Create the single-use RSA recipient and request sent to the container. */
export function createWalletBootstrapSession(botId: string): WalletBootstrapSession {
  if (!BOT_ID_RE.test(botId)) throw new Error("invalid bootstrap bot id");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicExponent: 0x10001,
  });
  const publicKeySpki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const request: WalletBootstrapRequest = Object.freeze({
    version: WALLET_BOOTSTRAP_VERSION,
    botId,
    sessionId: randomBytes(16).toString("base64url"),
    publicKeySpki,
    publicKeyFingerprint: sha256(Buffer.from(publicKeySpki, "base64url")),
    challenge: randomBytes(16).toString("base64url"),
  });
  return Object.freeze({
    request,
    privateKey,
  });
}

/** Serialize only for encrypted storage in Cassie's local keystore. */
export function exportWalletBootstrapPrivateKey(session: WalletBootstrapSession): string {
  return session.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

/** Restore an interrupted ceremony from an encrypted local keystore entry. */
export function restoreWalletBootstrapSession(
  request: WalletBootstrapRequest,
  privateKeyPem: string,
): WalletBootstrapSession {
  if (!BOT_ID_RE.test(request.botId) || request.version !== WALLET_BOOTSTRAP_VERSION) {
    throw new Error("invalid stored bootstrap request");
  }
  if (!TOKEN_RE.test(request.sessionId) || !TOKEN_RE.test(request.challenge) || !SHA256_RE.test(request.publicKeyFingerprint)) {
    throw new Error("invalid stored bootstrap request bindings");
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    throw new Error("invalid stored bootstrap recipient private key");
  }
  if (privateKey.asymmetricKeyType !== "rsa" || privateKey.asymmetricKeyDetails?.modulusLength !== 3072) {
    throw new Error("invalid stored bootstrap recipient private key");
  }
  const publicKeySpki = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64url");
  if (!equalText(publicKeySpki, request.publicKeySpki) || !equalText(sha256(Buffer.from(publicKeySpki, "base64url")), request.publicKeyFingerprint)) {
    throw new Error("stored bootstrap recipient does not match the checkpoint");
  }
  return Object.freeze({ request: Object.freeze({ ...request }), privateKey });
}

/**
 * Verify every public and encrypted binding before returning key material to
 * the caller for immediate storage in Cassie's encrypted local keystore.
 */
export function decryptWalletBootstrapEnvelope(
  input: unknown,
  session: WalletBootstrapSession,
): DecryptedBootstrapWallet {
  const envelope = parseEnvelope(input);
  const request = session.request;
  if (
    envelope.botId !== request.botId ||
    envelope.sessionId !== request.sessionId ||
    !equalText(envelope.publicKeyFingerprint, request.publicKeyFingerprint)
  ) {
    throw new Error("wallet bootstrap response does not match this session");
  }
  if (session.privateKey.asymmetricKeyType !== "rsa" || session.privateKey.asymmetricKeyDetails?.modulusLength !== 3072) {
    throw new Error("invalid bootstrap recipient private key");
  }

  let plaintext: Buffer;
  try {
    plaintext = privateDecrypt(
      {
        key: session.privateKey,
        oaepHash: "sha256",
        oaepLabel: requestLabel(request),
      },
      decodeBase64Url(envelope.ciphertext, "envelope ciphertext"),
    );
  } catch {
    throw new Error("wallet bootstrap decryption failed");
  }

  let payload: SealedWalletPayload;
  try {
    payload = parsePayload(JSON.parse(plaintext.toString("utf8")) as unknown);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("invalid decrypted wallet payload");
  } finally {
    plaintext.fill(0);
  }

  if (
    payload.b !== request.botId ||
    payload.s !== request.sessionId ||
    !equalText(payload.f, request.publicKeyFingerprint) ||
    !equalText(payload.c, request.challenge) ||
    payload.a.toLowerCase() !== envelope.address.toLowerCase()
  ) {
    throw new Error("decrypted wallet payload binding mismatch");
  }
  const derivedAddress = addressFromPk(payload.k);
  if (derivedAddress.toLowerCase() !== payload.a.toLowerCase()) {
    throw new Error("decrypted wallet address does not match its private key");
  }
  if (!equalText(envelope.digest, walletBootstrapAckDigest(payload.x))) {
    throw new Error("wallet bootstrap acknowledgement digest mismatch");
  }

  return {
    botId: payload.b,
    sessionId: payload.s,
    address: derivedAddress,
    privateKey: payload.k,
    ackSecret: payload.x,
  };
}

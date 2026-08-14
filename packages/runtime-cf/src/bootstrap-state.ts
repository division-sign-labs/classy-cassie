// packages/runtime-cf/src/bootstrap-state.ts

/**
 * Durable, one-use wallet-bootstrap state. This module deliberately has no
 * Cloudflare runtime imports so BotAgent can apply a transition before writing
 * the returned plain object to Durable Object storage.
 */

export const BOOTSTRAP_STATE_VERSION = 1 as const;

export interface BootstrapBinding {
  readonly botId: string;
  readonly sessionId: string;
  readonly publicKeyFingerprint: string;
  readonly challenge: string;
}

/** Public material produced by the bootstrap container; no plaintext key. */
export interface EncryptedWalletBootstrapEnvelope {
  readonly version: typeof BOOTSTRAP_STATE_VERSION;
  readonly botId: string;
  readonly sessionId: string;
  readonly publicKeyFingerprint: string;
  readonly address: string;
  readonly ciphertext: string;
  readonly digest: string;
}

export interface EmptyBootstrapState {
  readonly version: typeof BOOTSTRAP_STATE_VERSION;
  readonly status: "empty";
}

export interface EnvelopeReadyBootstrapState extends BootstrapBinding {
  readonly version: typeof BOOTSTRAP_STATE_VERSION;
  readonly status: "envelope-ready";
  readonly envelope: EncryptedWalletBootstrapEnvelope;
}

export interface AcknowledgedBootstrapState extends BootstrapBinding {
  readonly version: typeof BOOTSTRAP_STATE_VERSION;
  readonly status: "acknowledged";
  readonly address: string;
}

export type BootstrapState =
  | EmptyBootstrapState
  | EnvelopeReadyBootstrapState
  | AcknowledgedBootstrapState;

export type BootstrapPublicStatus = BootstrapState;

export interface BootstrapCreateInput extends BootstrapBinding {
  readonly envelope: EncryptedWalletBootstrapEnvelope;
}

export interface BootstrapAcknowledgementInput extends BootstrapBinding {
  readonly ackToken: string;
}

export interface BootstrapTransition<TState extends BootstrapState = BootstrapState> {
  readonly state: TState;
  readonly changed: boolean;
}

export type BootstrapTransitionErrorCode =
  | "bootstrap-conflict"
  | "bootstrap-gone"
  | "bootstrap-not-ready"
  | "bootstrap-acknowledgement-rejected";

export class BootstrapTransitionError extends Error {
  readonly code: BootstrapTransitionErrorCode;
  readonly status: 403 | 409 | 410;

  constructor(code: BootstrapTransitionErrorCode, status: 403 | 409 | 410, message: string) {
    super(message);
    this.name = "BootstrapTransitionError";
    this.code = code;
    this.status = status;
  }
}

export class BootstrapParseError extends Error {
  readonly code = "invalid-bootstrap-state" as const;
  readonly status = 400 as const;

  constructor(message: string) {
    super(message);
    this.name = "BootstrapParseError";
  }
}

const EMPTY_STATE: EmptyBootstrapState = Object.freeze({
  version: BOOTSTRAP_STATE_VERSION,
  status: "empty",
});

const BOT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const SHA256_RE = /^sha256:[A-Za-z0-9_-]{43}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CIPHERTEXT_RE = /^[A-Za-z0-9_-]{512}$/;

const BINDING_KEYS = ["botId", "challenge", "publicKeyFingerprint", "sessionId"] as const;
const CREATE_KEYS = [
  "botId",
  "challenge",
  "envelope",
  "publicKeyFingerprint",
  "sessionId",
] as const;
const ACKNOWLEDGEMENT_KEYS = [
  "ackToken",
  "botId",
  "challenge",
  "publicKeyFingerprint",
  "sessionId",
] as const;
const ENVELOPE_KEYS = [
  "address",
  "botId",
  "ciphertext",
  "digest",
  "publicKeyFingerprint",
  "sessionId",
  "version",
] as const;
const EMPTY_STATE_KEYS = ["status", "version"] as const;
const READY_STATE_KEYS = [
  "botId",
  "challenge",
  "envelope",
  "publicKeyFingerprint",
  "sessionId",
  "status",
  "version",
] as const;
const ACKNOWLEDGED_STATE_KEYS = [
  "address",
  "botId",
  "challenge",
  "publicKeyFingerprint",
  "sessionId",
  "status",
  "version",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalid(label: string): never {
  throw new BootstrapParseError(`invalid ${label}`);
}

function decodeCanonicalBase64Url(value: string, label: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return invalid(label);
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return invalid(label);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) return invalid(label);
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function parseToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !TOKEN_RE.test(value)) return invalid(label);
  if (decodeCanonicalBase64Url(value, label).byteLength !== 16) return invalid(label);
  return value;
}

function parseSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) return invalid(label);
  const encoded = value.slice("sha256:".length);
  if (decodeCanonicalBase64Url(encoded, label).byteLength !== 32) return invalid(label);
  return value;
}

function parseAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) return invalid(label);
  return value;
}

function parseBindingFields(value: Record<string, unknown>): BootstrapBinding {
  if (typeof value.botId !== "string" || !BOT_ID_RE.test(value.botId)) return invalid("bootstrap bot id");
  return {
    botId: value.botId,
    sessionId: parseToken(value.sessionId, "bootstrap session id"),
    publicKeyFingerprint: parseSha256(value.publicKeyFingerprint, "bootstrap public-key fingerprint"),
    challenge: parseToken(value.challenge, "bootstrap challenge"),
  };
}

export function emptyBootstrapState(): EmptyBootstrapState {
  return EMPTY_STATE;
}

export function parseBootstrapBinding(value: unknown): BootstrapBinding {
  if (!isRecord(value) || !hasExactKeys(value, BINDING_KEYS)) return invalid("bootstrap binding");
  return parseBindingFields(value);
}

export function parseEncryptedWalletBootstrapEnvelope(value: unknown): EncryptedWalletBootstrapEnvelope {
  if (!isRecord(value) || !hasExactKeys(value, ENVELOPE_KEYS)) return invalid("wallet bootstrap envelope");
  if (value.version !== BOOTSTRAP_STATE_VERSION) return invalid("wallet bootstrap envelope version");
  if (typeof value.botId !== "string" || !BOT_ID_RE.test(value.botId)) return invalid("envelope bot id");
  if (typeof value.ciphertext !== "string" || !CIPHERTEXT_RE.test(value.ciphertext)) {
    return invalid("envelope ciphertext");
  }
  if (decodeCanonicalBase64Url(value.ciphertext, "envelope ciphertext").byteLength !== 384) {
    return invalid("envelope ciphertext");
  }
  return {
    version: value.version,
    botId: value.botId,
    sessionId: parseToken(value.sessionId, "envelope session id"),
    publicKeyFingerprint: parseSha256(value.publicKeyFingerprint, "envelope public-key fingerprint"),
    address: parseAddress(value.address, "envelope address"),
    ciphertext: value.ciphertext,
    digest: parseSha256(value.digest, "envelope digest"),
  };
}

export function parseBootstrapCreateInput(value: unknown): BootstrapCreateInput {
  if (!isRecord(value) || !hasExactKeys(value, CREATE_KEYS)) return invalid("bootstrap create input");
  const binding = parseBindingFields(value);
  const envelope = parseEncryptedWalletBootstrapEnvelope(value.envelope);
  if (
    envelope.botId !== binding.botId ||
    envelope.sessionId !== binding.sessionId ||
    !equalText(envelope.publicKeyFingerprint, binding.publicKeyFingerprint)
  ) {
    return invalid("bootstrap envelope binding");
  }
  return {
    ...binding,
    envelope,
  };
}

export function parseBootstrapAcknowledgementInput(value: unknown): BootstrapAcknowledgementInput {
  if (!isRecord(value) || !hasExactKeys(value, ACKNOWLEDGEMENT_KEYS)) {
    return invalid("bootstrap acknowledgement input");
  }
  return {
    ...parseBindingFields(value),
    ackToken: parseToken(value.ackToken, "bootstrap acknowledgement token"),
  };
}

/** `undefined`/`null` are an unused storage slot and therefore the empty state. */
export function parseBootstrapState(value: unknown): BootstrapState {
  if (value === undefined || value === null) return emptyBootstrapState();
  if (!isRecord(value) || value.version !== BOOTSTRAP_STATE_VERSION || typeof value.status !== "string") {
    return invalid("bootstrap state");
  }
  if (value.status === "empty") {
    if (!hasExactKeys(value, EMPTY_STATE_KEYS)) return invalid("empty bootstrap state");
    return emptyBootstrapState();
  }
  if (value.status === "envelope-ready") {
    if (!hasExactKeys(value, READY_STATE_KEYS)) return invalid("ready bootstrap state");
    const binding = parseBindingFields(value);
    const envelope = parseEncryptedWalletBootstrapEnvelope(value.envelope);
    if (
      envelope.botId !== binding.botId ||
      envelope.sessionId !== binding.sessionId ||
      !equalText(envelope.publicKeyFingerprint, binding.publicKeyFingerprint)
    ) {
      return invalid("ready bootstrap envelope binding");
    }
    return {
      version: BOOTSTRAP_STATE_VERSION,
      status: "envelope-ready",
      ...binding,
      envelope,
    };
  }
  if (value.status === "acknowledged") {
    if (!hasExactKeys(value, ACKNOWLEDGED_STATE_KEYS)) return invalid("acknowledged bootstrap state");
    return {
      version: BOOTSTRAP_STATE_VERSION,
      status: "acknowledged",
      ...parseBindingFields(value),
      address: parseAddress(value.address, "acknowledged wallet address"),
    };
  }
  return invalid("bootstrap state status");
}

function sameBinding(left: BootstrapBinding, right: BootstrapBinding): boolean {
  return (
    left.botId === right.botId &&
    left.sessionId === right.sessionId &&
    equalText(left.publicKeyFingerprint, right.publicKeyFingerprint) &&
    equalText(left.challenge, right.challenge)
  );
}

function equalText(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;

  // workerd provides this Web Crypto extension. Keep the fixed-work fallback
  // for Node-based unit tests, whose SubtleCrypto does not expose it.
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(leftBytes, rightBytes);
  }
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index++) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `sha256:${encodeBase64Url(bytes)}`;
}

export async function digestBootstrapAcknowledgement(ackToken: string): Promise<string> {
  const parsed = parseToken(ackToken, "bootstrap acknowledgement token");
  return sha256(JSON.stringify(["cassie-wallet-bootstrap-ack", BOOTSTRAP_STATE_VERSION, parsed]));
}

function gone(): never {
  throw new BootstrapTransitionError("bootstrap-gone", 410, "wallet bootstrap envelope has been consumed");
}

/**
 * Store the first sealed envelope. A retry with the exact same public binding
 * returns the already-stored envelope and can never replace it with new data.
 */
export async function createBootstrapState(
  currentValue: unknown,
  inputValue: unknown,
): Promise<BootstrapTransition<EnvelopeReadyBootstrapState>> {
  const current = parseBootstrapState(currentValue);
  if (current.status === "acknowledged") return gone();
  const input = parseBootstrapCreateInput(inputValue);

  if (current.status === "envelope-ready") {
    if (!sameBinding(current, input)) {
      throw new BootstrapTransitionError(
        "bootstrap-conflict",
        409,
        "a different wallet bootstrap session is already active",
      );
    }
    return { state: current, changed: false };
  }

  return {
    state: {
      version: BOOTSTRAP_STATE_VERSION,
      status: "envelope-ready",
      botId: input.botId,
      sessionId: input.sessionId,
      publicKeyFingerprint: input.publicKeyFingerprint,
      challenge: input.challenge,
      envelope: input.envelope,
    },
    changed: true,
  };
}

/** Consume an envelope only after proving possession of its encrypted token. */
export async function acknowledgeBootstrapState(
  currentValue: unknown,
  inputValue: unknown,
): Promise<BootstrapTransition<AcknowledgedBootstrapState>> {
  const current = parseBootstrapState(currentValue);
  if (current.status === "acknowledged") return gone();
  const input = parseBootstrapAcknowledgementInput(inputValue);
  if (current.status === "empty") {
    throw new BootstrapTransitionError("bootstrap-not-ready", 409, "wallet bootstrap envelope is not ready");
  }
  if (!sameBinding(current, input)) {
    throw new BootstrapTransitionError(
      "bootstrap-conflict",
      409,
      "wallet bootstrap acknowledgement does not match the active session",
    );
  }
  const presentedDigest = await digestBootstrapAcknowledgement(input.ackToken);
  if (!equalText(presentedDigest, current.envelope.digest)) {
    throw new BootstrapTransitionError(
      "bootstrap-acknowledgement-rejected",
      403,
      "wallet bootstrap acknowledgement was rejected",
    );
  }
  return {
    state: {
      version: BOOTSTRAP_STATE_VERSION,
      status: "acknowledged",
      botId: current.botId,
      sessionId: current.sessionId,
      publicKeyFingerprint: current.publicKeyFingerprint,
      challenge: current.challenge,
      address: current.envelope.address,
    },
    changed: true,
  };
}

/** Drop an unconsumed envelope so a CLI process that lost its key can retry. */
export function abortBootstrapState(
  currentValue: unknown,
  bindingValue: unknown,
): BootstrapTransition<EmptyBootstrapState> {
  const current = parseBootstrapState(currentValue);
  if (current.status === "acknowledged") return gone();
  const binding = parseBootstrapBinding(bindingValue);
  if (current.status === "empty") return { state: emptyBootstrapState(), changed: false };
  if (!sameBinding(current, binding)) {
    throw new BootstrapTransitionError(
      "bootstrap-conflict",
      409,
      "wallet bootstrap abort does not match the active session",
    );
  }
  return { state: emptyBootstrapState(), changed: true };
}

/** Return the public state. It never contains the plaintext acknowledgement token. */
export function bootstrapPublicStatus(currentValue: unknown): BootstrapPublicStatus {
  return parseBootstrapState(currentValue);
}

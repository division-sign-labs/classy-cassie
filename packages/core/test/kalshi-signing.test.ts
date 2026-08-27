// packages/core/test/kalshi-signing.test.ts
// Kalshi request signing is hand-rolled (no official TS SDK — see the AGENTS.md
// carve-out), so these tests pin the scheme: the signed-string format via a
// fixed-key known vector, PSS parameters via self-verification, and the
// PEM → single-line base64 PKCS#8 DER normalization the deploy path relies on.

import { constants, createPrivateKey, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeKalshiPrivateKey,
  kalshiSigningPayload,
  normalizeKalshiPrivateKey,
  signKalshiRequest,
} from "@quotient-forecasting/cassie-core";

// A throwaway 2048-bit RSA key generated for this test file only. Pinning the
// key pins the known-vector signature deterministically? No — PSS salts are
// random, so instead the vector pins the *payload string* and the verify step
// pins the parameters. Both must hold for a signature Kalshi would accept.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

describe("kalshi signing payload", () => {
  it("concatenates timestampMs + METHOD + path with the API prefix and no query", () => {
    expect(kalshiSigningPayload("1755859200000", "get", "/trade-api/v2/portfolio/balance")).toBe(
      "1755859200000GET/trade-api/v2/portfolio/balance",
    );
  });

  it("known vector: the exact payload string cannot drift", () => {
    // If this assertion changes, deployed bots stop authenticating — treat any
    // edit here as a venue-contract change, not a refactor.
    const payload = kalshiSigningPayload("1700000000123", "POST", "/trade-api/v2/portfolio/orders");
    expect(payload).toBe("1700000000123POST/trade-api/v2/portfolio/orders");
  });
});

describe("kalshi RSA-PSS signature", () => {
  it("verifies under PSS with salt length = digest length", () => {
    const sig = signKalshiRequest(privateKey, "1700000000123", "GET", "/trade-api/v2/portfolio/balance");
    const ok = cryptoVerify(
      "sha256",
      Buffer.from("1700000000123GET/trade-api/v2/portfolio/balance", "utf8"),
      { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
      Buffer.from(sig, "base64"),
    );
    expect(ok).toBe(true);
  });

  it("does not verify under PKCS#1 v1.5 (the parameters are load-bearing)", () => {
    const sig = signKalshiRequest(privateKey, "1700000000123", "GET", "/trade-api/v2/portfolio/balance");
    const ok = cryptoVerify(
      "sha256",
      Buffer.from("1700000000123GET/trade-api/v2/portfolio/balance", "utf8"),
      { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(sig, "base64"),
    );
    expect(ok).toBe(false);
  });
});

describe("kalshi private key normalization", () => {
  it("round-trips a multi-line PKCS#8 PEM to one newline-free base64 line", () => {
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(pem).toContain("\n");
    const b64 = normalizeKalshiPrivateKey(pem);
    expect(b64).not.toMatch(/[\r\n]/);
    const reimported = decodeKalshiPrivateKey(b64);
    expect(reimported.export({ format: "der", type: "pkcs8" }).equals(privateKey.export({ format: "der", type: "pkcs8" }))).toBe(true);
  });

  it("accepts a PKCS#1 PEM and still emits PKCS#8 DER base64", () => {
    const pkcs1 = privateKey.export({ format: "pem", type: "pkcs1" }).toString();
    const b64 = normalizeKalshiPrivateKey(pkcs1);
    expect(b64).not.toMatch(/[\r\n]/);
    expect(() => decodeKalshiPrivateKey(b64)).not.toThrow();
  });

  it("accepts an already-normalized base64 line unchanged in meaning", () => {
    const b64 = normalizeKalshiPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    expect(normalizeKalshiPrivateKey(b64)).toBe(b64);
  });

  it("rejects an encrypted PEM with a message naming the cause", () => {
    const encrypted = privateKey
      .export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "hunter2" })
      .toString();
    expect(() => normalizeKalshiPrivateKey(encrypted)).toThrow(/passphrase-encrypted|not a valid RSA/);
  });

  it("rejects garbage input", () => {
    expect(() => normalizeKalshiPrivateKey("not a key")).toThrow(/kalshi private key/);
  });
});

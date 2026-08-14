// packages/cli/test/bootstrap-crypto.test.ts

import { createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { addressFromPk, generateEoa } from "@quotient-forecasting/cassie-core";
import { describe, expect, it } from "vitest";
import {
  createWalletBootstrapSession,
  decryptWalletBootstrapEnvelope,
  exportWalletBootstrapPrivateKey,
  restoreWalletBootstrapSession,
  walletBootstrapAckDigest,
  type WalletBootstrapEnvelope,
  type WalletBootstrapSession,
} from "../src/bootstrap-crypto.js";
import { createWalletBootstrapEnvelope } from "../../runtime-container/src/bootstrap-wallet.js";
import { digestBootstrapAcknowledgement } from "../../runtime-cf/src/bootstrap-state.js";

function changeBase64UrlByte(value: string): string {
  const bytes = Buffer.from(value, "base64url");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString("base64url");
}

function forgeEnvelopeWithMismatchedAddress(session: WalletBootstrapSession): WalletBootstrapEnvelope {
  const wallet = generateEoa();
  const wrongAddress = generateEoa().address;
  const ackSecret = randomBytes(16).toString("base64url");
  const payload = {
    v: 1,
    b: session.request.botId,
    s: session.request.sessionId,
    f: session.request.publicKeyFingerprint,
    c: session.request.challenge,
    a: wrongAddress,
    k: wallet.privateKey,
    x: ackSecret,
  };
  const oaepLabel = Buffer.from(
    JSON.stringify([
      "cassie-wallet-bootstrap",
      session.request.version,
      session.request.botId,
      session.request.sessionId,
      session.request.publicKeyFingerprint,
      session.request.challenge,
    ]),
  );
  const ciphertext = publicEncrypt(
    {
      key: createPublicKey({
        key: Buffer.from(session.request.publicKeySpki, "base64url"),
        format: "der",
        type: "spki",
      }),
      oaepHash: "sha256",
      oaepLabel,
    },
    Buffer.from(JSON.stringify(payload)),
  ).toString("base64url");
  const unsigned = {
    version: 1 as const,
    botId: session.request.botId,
    sessionId: session.request.sessionId,
    publicKeyFingerprint: session.request.publicKeyFingerprint,
    address: wrongAddress,
    ciphertext,
  };
  return { ...unsigned, digest: walletBootstrapAckDigest(ackSecret) };
}

describe("one-use container wallet bootstrap crypto", () => {
  it("round-trips a generated EOA and exposes no plaintext secret in the envelope", () => {
    const session = createWalletBootstrapSession("bot-1");
    const envelope = createWalletBootstrapEnvelope(session.request);
    const wallet = decryptWalletBootstrapEnvelope(envelope, session);
    const serialized = JSON.stringify(envelope);

    expect(wallet.botId).toBe("bot-1");
    expect(wallet.sessionId).toBe(session.request.sessionId);
    expect(addressFromPk(wallet.privateKey)).toBe(wallet.address);
    expect(wallet.ackSecret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(serialized).not.toContain(wallet.privateKey);
    expect(serialized).not.toContain(wallet.ackSecret);
    expect(Object.keys(envelope).sort()).toEqual([
      "address",
      "botId",
      "ciphertext",
      "digest",
      "publicKeyFingerprint",
      "sessionId",
      "version",
    ]);
  });

  it("uses the exact acknowledgement verifier accepted by the Durable Object", async () => {
    const session = createWalletBootstrapSession("bot-1");
    const envelope = createWalletBootstrapEnvelope(session.request);
    const wallet = decryptWalletBootstrapEnvelope(envelope, session);

    await expect(digestBootstrapAcknowledgement(wallet.ackSecret)).resolves.toBe(envelope.digest);
  });

  it("supports the maximum config-valid 32-character bot id within one RSA-OAEP block", () => {
    const botId = "b".repeat(32);
    const session = createWalletBootstrapSession(botId);
    const wallet = decryptWalletBootstrapEnvelope(createWalletBootstrapEnvelope(session.request), session);

    expect(wallet.botId).toBe(botId);
  });

  it("resumes from a wrapping key that was stored encrypted by the caller", () => {
    const original = createWalletBootstrapSession("bot-1");
    const restored = restoreWalletBootstrapSession(
      original.request,
      exportWalletBootstrapPrivateKey(original),
    );
    const wallet = decryptWalletBootstrapEnvelope(createWalletBootstrapEnvelope(original.request), restored);

    expect(wallet.address).toBe(addressFromPk(wallet.privateKey));
    expect(() =>
      restoreWalletBootstrapSession(
        { ...original.request, challenge: "AAAAAAAAAAAAAAAAAAAAAA" },
        exportWalletBootstrapPrivateKey(original),
      ),
    ).not.toThrow();
    expect(() =>
      restoreWalletBootstrapSession(
        { ...original.request, publicKeySpki: createWalletBootstrapSession("bot-1").request.publicKeySpki },
        exportWalletBootstrapPrivateKey(original),
      ),
    ).toThrow(/does not match/);
  });

  it("cannot be opened with a different recipient private key", () => {
    const intended = createWalletBootstrapSession("bot-1");
    const other = createWalletBootstrapSession("bot-1");
    const envelope = createWalletBootstrapEnvelope(intended.request);
    const wrongRecipient: WalletBootstrapSession = {
      request: intended.request,
      privateKey: other.privateKey,
    };

    expect(() => decryptWalletBootstrapEnvelope(envelope, wrongRecipient)).toThrow(/decryption failed/);
  });

  it("rejects a tampered ciphertext", () => {
    const session = createWalletBootstrapSession("bot-1");
    const envelope = createWalletBootstrapEnvelope(session.request);
    const tampered: WalletBootstrapEnvelope = {
      ...envelope,
      ciphertext: changeBase64UrlByte(envelope.ciphertext),
    };

    expect(() => decryptWalletBootstrapEnvelope(tampered, session)).toThrow(/decryption failed/);
  });

  it("rejects a tampered acknowledgement digest", () => {
    const session = createWalletBootstrapSession("bot-1");
    const envelope = createWalletBootstrapEnvelope(session.request);
    const tampered: WalletBootstrapEnvelope = {
      ...envelope,
      digest: `sha256:${"A".repeat(43)}`,
    };

    expect(() => decryptWalletBootstrapEnvelope(tampered, session)).toThrow(/acknowledgement digest mismatch/);
  });

  it.each([
    ["bot", { botId: "bot-2" }],
    ["session", { sessionId: "AAAAAAAAAAAAAAAAAAAAAA" }],
  ])("rejects a %s binding mismatch", (_label, requestChange) => {
    const session = createWalletBootstrapSession("bot-1");
    const envelope = createWalletBootstrapEnvelope(session.request);
    const mismatched: WalletBootstrapSession = {
      ...session,
      request: { ...session.request, ...requestChange },
    };

    expect(() => decryptWalletBootstrapEnvelope(envelope, mismatched)).toThrow(/does not match this session/);
  });

  it("derives the address from the private key and rejects a forged claimed address", () => {
    const session = createWalletBootstrapSession("bot-1");
    const forged = forgeEnvelopeWithMismatchedAddress(session);

    expect(() => decryptWalletBootstrapEnvelope(forged, session)).toThrow(/does not match its private key/);
  });
});

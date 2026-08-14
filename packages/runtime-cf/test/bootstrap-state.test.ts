// packages/runtime-cf/test/bootstrap-state.test.ts

import { describe, expect, it } from "vitest";
import {
  abortBootstrapState,
  acknowledgeBootstrapState,
  bootstrapPublicStatus,
  BootstrapParseError,
  BootstrapTransitionError,
  createBootstrapState,
  digestBootstrapAcknowledgement,
  emptyBootstrapState,
  parseBootstrapState,
  type BootstrapBinding,
  type BootstrapCreateInput,
  type EncryptedWalletBootstrapEnvelope,
} from "../src/bootstrap-state.js";

const SESSION_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const OTHER_SESSION_ID = "AQEBAQEBAQEBAQEBAQEBAQ";
const CHALLENGE = "AgICAgICAgICAgICAgICAg";
const OTHER_CHALLENGE = "AwMDAwMDAwMDAwMDAwMDAw";
const ACK_TOKEN = "BAQEBAQEBAQEBAQEBAQEBA";
const WRONG_ACK_TOKEN = "BQUFBQUFBQUFBQUFBQUFBQ";
const FINGERPRINT = `sha256:${"A".repeat(43)}`;
const OTHER_FINGERPRINT = "sha256:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER_ADDRESS = "0x2222222222222222222222222222222222222222";

const binding: BootstrapBinding = {
  botId: "bot-1",
  sessionId: SESSION_ID,
  publicKeyFingerprint: FINGERPRINT,
  challenge: CHALLENGE,
};

async function envelope(
  overrides: Partial<EncryptedWalletBootstrapEnvelope> = {},
  ackToken = ACK_TOKEN,
): Promise<EncryptedWalletBootstrapEnvelope> {
  return {
    version: 1 as const,
    botId: binding.botId,
    sessionId: binding.sessionId,
    publicKeyFingerprint: binding.publicKeyFingerprint,
    address: ADDRESS,
    ciphertext: "A".repeat(512),
    ...overrides,
    digest: overrides.digest ?? (await digestBootstrapAcknowledgement(ackToken)),
  };
}

async function createInput(
  overrides: Partial<BootstrapCreateInput> = {},
): Promise<BootstrapCreateInput> {
  return {
    ...binding,
    envelope: await envelope(),
    ...overrides,
  };
}

function expectTransitionError(error: unknown, code: string, status: number): boolean {
  expect(error).toBeInstanceOf(BootstrapTransitionError);
  expect(error).toMatchObject({ code, status });
  return true;
}

describe("wallet bootstrap state parsing", () => {
  it("uses the container protocol's domain-separated acknowledgement digest", async () => {
    await expect(digestBootstrapAcknowledgement(ACK_TOKEN)).resolves.toBe(
      "sha256:gR5r6eJGnhG_iVog3Z2i0MFWQLNSo2j-mFyKvvPwRn4",
    );
  });

  it("treats an unused storage slot as empty and round-trips strict states", async () => {
    expect(parseBootstrapState(undefined)).toEqual(emptyBootstrapState());
    expect(parseBootstrapState(null)).toEqual(emptyBootstrapState());

    const ready = (await createBootstrapState(undefined, await createInput())).state;
    expect(parseBootstrapState(structuredClone(ready))).toEqual(ready);
  });

  it("rejects unknown, secret-bearing, and malformed persisted fields", async () => {
    const ready = (await createBootstrapState(undefined, await createInput())).state;
    expect(() => parseBootstrapState({ ...ready, ackSecret: ACK_TOKEN })).toThrow(BootstrapParseError);
    expect(() => parseBootstrapState({ ...ready, privateKey: `0x${"1".repeat(64)}` })).toThrow(
      BootstrapParseError,
    );
    expect(() => parseBootstrapState({ ...ready, challenge: "not-base64url" })).toThrow(
      /bootstrap challenge/,
    );
    expect(() => parseBootstrapState({ version: 2, status: "empty" })).toThrow(/bootstrap state/);
  });
});

describe("wallet bootstrap creation", () => {
  it("moves empty to envelope-ready while exposing only public material", async () => {
    const input = await createInput();
    const result = await createBootstrapState(undefined, input);
    const status = bootstrapPublicStatus(result.state);

    expect(result.changed).toBe(true);
    expect(result.state).toMatchObject({ status: "envelope-ready", ...binding, envelope: input.envelope });
    expect(status).toMatchObject({ status: "envelope-ready", ...binding, envelope: input.envelope });
    expect(status).not.toHaveProperty("ackToken");
    expect(JSON.stringify(status)).not.toContain(ACK_TOKEN);
    expect(JSON.stringify(result.state)).not.toMatch(/ackSecret|privateKey/);
  });

  it("is idempotent for the same full binding and never replaces the first envelope", async () => {
    const first = (await createBootstrapState(undefined, await createInput())).state;
    const replacementEnvelope = await envelope(
      { address: OTHER_ADDRESS, ciphertext: "A".repeat(511) + "Q" },
      WRONG_ACK_TOKEN,
    );
    const retry = await createBootstrapState(
      first,
      await createInput({
        envelope: replacementEnvelope,
      }),
    );

    expect(retry).toEqual({ state: first, changed: false });
    expect(retry.state.envelope.address).toBe(ADDRESS);
  });

  it.each([
    ["bot", { botId: "bot-2" }],
    ["session", { sessionId: OTHER_SESSION_ID }],
    ["public key", { publicKeyFingerprint: OTHER_FINGERPRINT }],
    ["challenge", { challenge: OTHER_CHALLENGE }],
  ])("rejects a different %s binding with conflict", async (_label, change) => {
    const first = (await createBootstrapState(undefined, await createInput())).state;
    const nextBinding = { ...binding, ...change };
    const nextEnvelope = await envelope({
      botId: nextBinding.botId,
      sessionId: nextBinding.sessionId,
      publicKeyFingerprint: nextBinding.publicKeyFingerprint,
    });
    const next = await createInput({ ...nextBinding, envelope: nextEnvelope });

    await expect(createBootstrapState(first, next)).rejects.toSatisfy((error: unknown) =>
      expectTransitionError(error, "bootstrap-conflict", 409),
    );
  });

  it("rejects an envelope with an unknown field instead of persisting it", async () => {
    const input = await createInput();
    const malformed = {
      ...input,
      envelope: { ...input.envelope, ackSecret: ACK_TOKEN },
    };
    await expect(createBootstrapState(undefined, malformed)).rejects.toThrow(/wallet bootstrap envelope/);
  });
});

describe("wallet bootstrap acknowledgement and retirement", () => {
  it("requires the encrypted acknowledgement token, consumes once, and erases sealed state", async () => {
    const ready = (await createBootstrapState(undefined, await createInput())).state;
    const result = await acknowledgeBootstrapState(ready, { ...binding, ackToken: ACK_TOKEN });

    expect(result).toEqual({
      changed: true,
      state: {
        version: 1,
        status: "acknowledged",
        ...binding,
        address: ADDRESS,
      },
    });
    expect(result.state).not.toHaveProperty("envelope");
    expect(result.state).not.toHaveProperty("ackToken");
    expect(bootstrapPublicStatus(result.state)).toEqual(result.state);
  });

  it("rejects a wrong token without ever storing the token", async () => {
    const ready = (await createBootstrapState(undefined, await createInput())).state;
    await expect(
      acknowledgeBootstrapState(ready, { ...binding, ackToken: WRONG_ACK_TOKEN }),
    ).rejects.toSatisfy((error: unknown) =>
      expectTransitionError(error, "bootstrap-acknowledgement-rejected", 403),
    );
    expect(JSON.stringify(bootstrapPublicStatus(ready))).not.toContain(ACK_TOKEN);
  });

  it("rejects acknowledgement before creation and against another binding", async () => {
    await expect(
      acknowledgeBootstrapState(undefined, { ...binding, ackToken: ACK_TOKEN }),
    ).rejects.toSatisfy((error: unknown) => expectTransitionError(error, "bootstrap-not-ready", 409));

    const ready = (await createBootstrapState(undefined, await createInput())).state;
    await expect(
      acknowledgeBootstrapState(ready, { ...binding, challenge: OTHER_CHALLENGE, ackToken: ACK_TOKEN }),
    ).rejects.toSatisfy((error: unknown) => expectTransitionError(error, "bootstrap-conflict", 409));
  });

  it("can abort an unconsumed session and then start another", async () => {
    const ready = (await createBootstrapState(undefined, await createInput())).state;
    expect(abortBootstrapState(ready, binding)).toEqual({ state: emptyBootstrapState(), changed: true });

    const nextBinding = { ...binding, sessionId: OTHER_SESSION_ID };
    const next = await createInput({
      ...nextBinding,
      envelope: await envelope({ sessionId: OTHER_SESSION_ID }),
    });
    await expect(createBootstrapState(emptyBootstrapState(), next)).resolves.toMatchObject({
      changed: true,
      state: { status: "envelope-ready", sessionId: OTHER_SESSION_ID },
    });
  });

  it("returns gone for every mutation after acknowledgement, even before parsing a new payload", async () => {
    const ready = (await createBootstrapState(undefined, await createInput())).state;
    const consumed = (await acknowledgeBootstrapState(ready, { ...binding, ackToken: ACK_TOKEN })).state;

    await expect(createBootstrapState(consumed, { invalid: true })).rejects.toSatisfy((error: unknown) =>
      expectTransitionError(error, "bootstrap-gone", 410),
    );
    await expect(acknowledgeBootstrapState(consumed, { invalid: true })).rejects.toSatisfy((error: unknown) =>
      expectTransitionError(error, "bootstrap-gone", 410),
    );
    expect(() => abortBootstrapState(consumed, { invalid: true })).toThrowError(
      expect.objectContaining({ code: "bootstrap-gone", status: 410 }),
    );
  });
});

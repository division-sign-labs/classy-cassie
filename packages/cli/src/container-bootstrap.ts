// packages/cli/src/container-bootstrap.ts
// One-use Cloudflare Container wallet generation for Hyperliquid. The remote
// deployment sees only a wrapping public key and persists ciphertext only.

import { randomBytes } from "node:crypto";
import pc from "picocolors";
import { addressFromPk, KeyRoles, type BotConfig } from "@quotient-forecasting/cassie-core";
import {
  createWalletBootstrapSession,
  decryptWalletBootstrapEnvelope,
  exportWalletBootstrapPrivateKey,
  restoreWalletBootstrapSession,
  type WalletBootstrapEnvelope,
  type WalletBootstrapSession,
} from "./bootstrap-crypto.js";
import { ensureCloudflareReady, registerWorkersDevSubdomain } from "./cloudflare.js";
import { confirm, getPassphrase, keystore } from "./context.js";
import { loadInitState, saveInitState, type InitState } from "./init-state.js";
import { materializeWorkerWranglerProject, runWrangler } from "./wrangler.js";
import { ensureDockerRunning, isMissingSubdomainError, runtimeCfProject } from "./commands/deploy.js";

export interface ContainerBootstrapInput {
  botId: string;
  venue: BotConfig["venue"];
  state: InitState;
  checkpoint(state: InitState): void;
}

interface BootstrapStatus {
  version: 1;
  status: "empty" | "envelope-ready" | "acknowledged";
  botId?: string;
  sessionId?: string;
  publicKeyFingerprint?: string;
  challenge?: string;
  address?: string;
  envelope?: WalletBootstrapEnvelope;
}

function withBootstrap(state: InitState, bootstrap: NonNullable<InitState["bootstrap"]>): InitState {
  return { ...state, bootstrap };
}

function withoutBootstrap(state: InitState): InitState {
  const { bootstrap: _completedBootstrap, ...rest } = state;
  return rest;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`bootstrap Worker returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }
}

async function bootstrapFetch(
  controlUrl: string,
  botId: string,
  token: string,
  action: string,
  method: "GET" | "POST",
  body?: unknown,
  attempts = 24,
): Promise<Response> {
  let lastError: unknown;
  let announced = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`${controlUrl}/bots/${botId}/bootstrap/${action}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "cache-control": "no-store",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if ([401, 500, 503].includes(response.status) && attempt < attempts - 1) {
        lastError = new Error(`${response.status}: ${(await response.clone().text()).slice(0, 200)}`);
      } else {
        if (announced) console.log("");
        return response;
      }
    } catch (error) {
      lastError = error;
    }
    if (!announced) {
      process.stdout.write(pc.dim("waiting for the one-use bootstrap Worker"));
      announced = true;
    }
    process.stdout.write(pc.dim("."));
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (announced) console.log("");
  throw new Error(`could not reach the bootstrap Worker: ${String(lastError)}`);
}

function binding(session: WalletBootstrapSession): {
  botId: string;
  sessionId: string;
  publicKeyFingerprint: string;
  challenge: string;
} {
  return {
    botId: session.request.botId,
    sessionId: session.request.sessionId,
    publicKeyFingerprint: session.request.publicKeyFingerprint,
    challenge: session.request.challenge,
  };
}

function assertStatusBinding(status: BootstrapStatus, session: WalletBootstrapSession): void {
  if (status.status === "empty") return;
  const expected = binding(session);
  if (
    status.botId !== expected.botId ||
    status.sessionId !== expected.sessionId ||
    status.publicKeyFingerprint !== expected.publicKeyFingerprint ||
    status.challenge !== expected.challenge
  ) {
    throw new Error("bootstrap Worker state belongs to a different session; refusing to replace it");
  }
}

async function readStatus(controlUrl: string, botId: string, token: string): Promise<BootstrapStatus> {
  const response = await bootstrapFetch(controlUrl, botId, token, "status", "GET");
  const body = await responseJson(response);
  if (!response.ok) throw new Error(`bootstrap status failed (${response.status}): ${JSON.stringify(body).slice(0, 300)}`);
  return body as unknown as BootstrapStatus;
}

async function purgeRemoteBootstrap(
  controlUrl: string,
  botId: string,
  token: string,
  session: WalletBootstrapSession,
): Promise<void> {
  const response = await bootstrapFetch(controlUrl, botId, token, "purge", "POST", binding(session));
  const body = await responseJson(response);
  if (!response.ok || body.status !== "purged") {
    throw new Error(`bootstrap ciphertext purge failed (${response.status}): ${JSON.stringify(body).slice(0, 300)}`);
  }
}

function loadOrCreateSession(input: ContainerBootstrapInput, passphrase: string): {
  state: InitState;
  session: WalletBootstrapSession;
  token: string;
} {
  const store = keystore();
  if (input.state.bootstrap) {
    const wrappingPem = store.getEntry(input.botId, KeyRoles.bootstrapWrap, passphrase);
    const token = store.getEntry(input.botId, KeyRoles.bootstrapToken, passphrase);
    if (!wrappingPem || !token) {
      throw new Error(
        "the container-wallet checkpoint exists but its encrypted one-use recovery material is missing; run `cassie wallet abort-bootstrap " +
          input.botId +
          "` if no master key was imported",
      );
    }
    return {
      state: input.state,
      session: restoreWalletBootstrapSession(input.state.bootstrap.request, wrappingPem),
      token,
    };
  }

  const session = createWalletBootstrapSession(input.botId);
  const token = randomBytes(32).toString("base64url");
  store.putEntry(input.botId, KeyRoles.bootstrapWrap, exportWalletBootstrapPrivateKey(session), passphrase, {
    runtimeEligible: false,
  });
  store.putEntry(input.botId, KeyRoles.bootstrapToken, token, passphrase, { runtimeEligible: false });
  const sessionSuffix = session.request.sessionId.replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 8);
  const state = withBootstrap(input.state, {
    workerName: `cassie-bootstrap-${input.botId}-${sessionSuffix}`,
    request: session.request,
    phase: "planned",
  });
  input.checkpoint(state);
  return { state, session, token };
}

/**
 * Generate a master EOA inside a dedicated deployed Container, import and
 * verify it locally, consume the remote ciphertext, then delete the Worker.
 */
export async function bootstrapContainerWallet(input: ContainerBootstrapInput): Promise<{
  origin: "container";
  address: string;
}> {
  if (input.venue !== "hyperliquid") {
    throw new Error(
      input.venue === "polymarket"
        ? "container-first is disabled for Polymarket until its deployed raw signer is replaced with a delegated trading key"
        : "container-first is unavailable for Lighter because its Cloudflare runtime is not wired",
    );
  }
  const store = keystore();
  const existingFile = store.load(input.botId);
  const passphrase = await getPassphrase(!existingFile || Object.keys(existingFile.entries).length === 0);
  if (existingFile) store.verifyPassphrase(input.botId, passphrase);
  let { state, session, token } = loadOrCreateSession(input, passphrase);
  let checkpoint = state.bootstrap!;
  const project = runtimeCfProject();
  const { accountId } = await ensureCloudflareReady(project.cwd);
  ensureDockerRunning();

  if (checkpoint.phase === "planned") {
    console.log(pc.bold(`deploying one-use wallet generator ${checkpoint.workerName} in EEUR`));
    const materialized = materializeWorkerWranglerProject(project, checkpoint.workerName);
    try {
      let deployment = runWrangler(
        ["deploy", "--name", checkpoint.workerName, "--containers-rollout=immediate"],
        materialized.project,
      );
      if (!deployment.ok && isMissingSubdomainError(deployment.out)) {
        if (
          !(await registerWorkersDevSubdomain(
            materialized.project.cwd,
            checkpoint.workerName,
            accountId,
            materialized.project.config,
          ))
        ) {
          throw new Error("bootstrap stopped: no workers.dev subdomain is configured");
        }
        deployment = runWrangler(
          ["deploy", "--name", checkpoint.workerName, "--containers-rollout=immediate"],
          materialized.project,
        );
      }
      process.stdout.write(deployment.out);
      if (!deployment.ok) throw new Error(`bootstrap deploy failed:\n${deployment.out.slice(-800)}`);
      const match = deployment.out.match(/https:\/\/[^\s]+\.workers\.dev/);
      if (!match) throw new Error("could not find the bootstrap workers.dev URL in Wrangler output");

      for (const [name, value] of [
        ["BOOTSTRAP_TOKEN", token],
        ["BOOTSTRAP_BOT_ID", input.botId],
        ["BOOTSTRAP_SESSION_ID", session.request.sessionId],
      ] as const) {
        const result = runWrangler(
          ["secret", "put", name, "--name", checkpoint.workerName],
          materialized.project,
          value,
        );
        if (!result.ok) throw new Error(`bootstrap secret ${name} failed:\n${result.out.slice(-500)}`);
      }
      checkpoint = { ...checkpoint, controlUrl: match[0], phase: "deployed" };
      state = withBootstrap(state, checkpoint);
      input.checkpoint(state);
    } finally {
      materialized.dispose();
    }
  }

  if (!checkpoint.controlUrl) throw new Error("bootstrap checkpoint has no control URL");
  const controlUrl = checkpoint.controlUrl;
  if ((checkpoint.phase === "acknowledged" || checkpoint.phase === "purged") && state.wallet?.address) {
    const acknowledgedAddress = state.wallet.address;
    const master = keystore().getEntry(input.botId, KeyRoles.master, passphrase);
    if (!master || addressFromPk(master).toLowerCase() !== acknowledgedAddress.toLowerCase()) {
      throw new Error("acknowledged bootstrap checkpoint has no matching verified local master key");
    }
    if (checkpoint.phase === "acknowledged") {
      await purgeRemoteBootstrap(controlUrl, input.botId, token, session);
      checkpoint = { ...checkpoint, phase: "purged" };
      state = withBootstrap(state, checkpoint);
      input.checkpoint(state);
    }
    const removed = runWrangler(["delete", checkpoint.workerName, "--force"], project);
    if (!removed.ok && !/not found|does not exist/i.test(removed.out)) {
      throw new Error(`bootstrap Worker cleanup failed:\n${removed.out.slice(-600)}`);
    }
    const completed = withoutBootstrap(state);
    input.checkpoint(completed);
    keystore().removeEntry(input.botId, KeyRoles.bootstrapWrap);
    keystore().removeEntry(input.botId, KeyRoles.bootstrapToken);
    return { origin: "container", address: acknowledgedAddress };
  }
  let status = await readStatus(controlUrl, input.botId, token);
  assertStatusBinding(status, session);

  let decrypted:
    | ReturnType<typeof decryptWalletBootstrapEnvelope>
    | undefined;
  if (status.status !== "acknowledged") {
    const generated = await bootstrapFetch(
      controlUrl,
      input.botId,
      token,
      "wallet",
      "POST",
      session.request,
    );
    const body = await responseJson(generated);
    if (!generated.ok) {
      throw new Error(`container wallet generation failed (${generated.status}): ${JSON.stringify(body).slice(0, 300)}`);
    }
    status = body as unknown as BootstrapStatus;
    assertStatusBinding(status, session);
    if (status.status !== "envelope-ready" || !status.envelope) {
      throw new Error(`bootstrap Worker returned unexpected state ${String(status.status)}`);
    }
    checkpoint = { ...checkpoint, phase: "envelope-ready" };
    state = withBootstrap(state, checkpoint);
    input.checkpoint(state);
    decrypted = decryptWalletBootstrapEnvelope(status.envelope, session);

    const store = keystore();
    const existing = store.getEntry(input.botId, KeyRoles.master, passphrase);
    if (existing && addressFromPk(existing).toLowerCase() !== decrypted.address.toLowerCase()) {
      throw new Error("the bot already has a different master key; refusing to overwrite it");
    }
    if (!existing) {
      store.putEntry(input.botId, KeyRoles.master, decrypted.privateKey, passphrase, {
        address: decrypted.address,
        runtimeEligible: false,
      });
    }
    const reloaded = store.getEntry(input.botId, KeyRoles.master, passphrase);
    if (!reloaded || addressFromPk(reloaded).toLowerCase() !== decrypted.address.toLowerCase()) {
      throw new Error("local master-key durability verification failed; remote envelope was not consumed");
    }
    checkpoint = { ...checkpoint, phase: "master-stored" };
    state = { ...withBootstrap(state, checkpoint), wallet: { origin: "container", address: decrypted.address } };
    input.checkpoint(state);

    const acknowledged = await bootstrapFetch(
      controlUrl,
      input.botId,
      token,
      "ack",
      "POST",
      { ...binding(session), ackToken: decrypted.ackSecret },
    );
    const acknowledgedBody = await responseJson(acknowledged);
    if (!acknowledged.ok) {
      throw new Error(`bootstrap acknowledgement failed (${acknowledged.status}): ${JSON.stringify(acknowledgedBody).slice(0, 300)}`);
    }
    status = acknowledgedBody as unknown as BootstrapStatus;
  }

  assertStatusBinding(status, session);
  if (status.status !== "acknowledged" || !status.address) {
    throw new Error("bootstrap envelope was not acknowledged and retired");
  }
  const master = keystore().getEntry(input.botId, KeyRoles.master, passphrase);
  if (!master || addressFromPk(master).toLowerCase() !== status.address.toLowerCase()) {
    throw new Error("remote bootstrap is acknowledged but the verified local master key is unavailable");
  }
  checkpoint = { ...checkpoint, phase: "acknowledged" };
  state = { ...withBootstrap(state, checkpoint), wallet: { origin: "container", address: status.address } };
  input.checkpoint(state);

  await purgeRemoteBootstrap(controlUrl, input.botId, token, session);
  checkpoint = { ...checkpoint, phase: "purged" };
  state = withBootstrap(state, checkpoint);
  input.checkpoint(state);

  const removed = runWrangler(["delete", checkpoint.workerName, "--force"], project);
  if (!removed.ok && !/not found|does not exist/i.test(removed.out)) {
    throw new Error(
      `wallet is safe locally and remote ciphertext is consumed, but bootstrap Worker cleanup failed:\n${removed.out.slice(-600)}`,
    );
  }
  state = withoutBootstrap(state);
  input.checkpoint(state);
  keystore().removeEntry(input.botId, KeyRoles.bootstrapWrap);
  keystore().removeEntry(input.botId, KeyRoles.bootstrapToken);
  console.log(pc.green(`container-generated wallet exported, verified, and bootstrap Worker deleted: ${status.address}`));
  return { origin: "container", address: status.address };
}

/** Explicit recovery for a ceremony that never imported a master key. */
export async function abortContainerWalletBootstrap(botId: string): Promise<void> {
  const state = loadInitState(botId);
  if (!state?.bootstrap) throw new Error(`bot "${botId}" has no incomplete container-wallet bootstrap`);
  if (state.wallet?.address || keystore().entryMeta(botId, KeyRoles.master)) {
    throw new Error(
      "a master key may already have been imported; rerun `cassie init` so it can verify and consume the remote envelope instead of aborting",
    );
  }
  const checkpoint = state.bootstrap;
  console.log(pc.yellow(`This deletes the unused bootstrap Worker ${checkpoint.workerName}.`));
  console.log(pc.dim("No wallet from this ceremony may have been funded or attached to a venue/Splits account."));
  if (!(await confirm("Delete it and reset wallet setup?", false))) return;

  const project = runtimeCfProject();
  await ensureCloudflareReady(project.cwd);
  if (checkpoint.phase !== "planned") {
    if (!checkpoint.controlUrl) throw new Error("deployed bootstrap checkpoint has no control URL");
    const passphrase = await getPassphrase();
    const wrappingPem = keystore().getEntry(botId, KeyRoles.bootstrapWrap, passphrase);
    const token = keystore().getEntry(botId, KeyRoles.bootstrapToken, passphrase);
    if (!wrappingPem || !token) {
      throw new Error("bootstrap recovery material is missing; refusing to orphan the remote encrypted envelope");
    }
    const session = restoreWalletBootstrapSession(checkpoint.request, wrappingPem);
    const aborted = await bootstrapFetch(
      checkpoint.controlUrl,
      botId,
      token,
      "abort",
      "POST",
      binding(session),
    );
    const body = await responseJson(aborted);
    if (!aborted.ok || body.status !== "empty") {
      throw new Error(`bootstrap remote abort failed (${aborted.status}): ${JSON.stringify(body).slice(0, 300)}`);
    }
  }
  const removed = runWrangler(["delete", checkpoint.workerName, "--force"], project);
  if (!removed.ok && !/not found|does not exist/i.test(removed.out)) {
    throw new Error(`bootstrap Worker deletion failed:\n${removed.out.slice(-600)}`);
  }
  const reset = withoutBootstrap(state);
  saveInitState(reset);
  keystore().removeEntry(botId, KeyRoles.bootstrapWrap);
  keystore().removeEntry(botId, KeyRoles.bootstrapToken);
  console.log(pc.green("unused container-wallet bootstrap deleted; rerun `cassie init` to start again"));
}

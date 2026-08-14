// packages/cli/src/init-state.ts
// Non-secret, resumable checkpoints for `cassie init`. External account
// creation is never retried from memory alone.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseBotConfig, type BotConfig, type SplitsTreasury } from "@quotient-forecasting/cassie-core";
import { atomicWritePrivateFile, cassieHome, safeBotId } from "./paths.js";
import type { WalletBootstrapRequest } from "./bootstrap-crypto.js";

export type InitVenue = BotConfig["venue"];

export interface PendingSplitsAccount {
  phase: "planned" | "create-attempted";
  organizationId: string;
  organizationName?: string | null;
  accountName: string;
  passkeyIds: string[];
  eoa?: { id: string; address: string };
  threshold: number;
}

export interface BootstrapCheckpoint {
  workerName: string;
  request: WalletBootstrapRequest;
  controlUrl?: string;
  phase: "planned" | "deployed" | "envelope-ready" | "master-stored" | "acknowledged" | "purged";
}

export interface InitState {
  version: 1;
  botId: string;
  venue: InitVenue;
  createdAt: string;
  wallet?: BotConfig["wallet"];
  bootstrap?: BootstrapCheckpoint;
  pendingTreasury?: PendingSplitsAccount;
  treasury?: SplitsTreasury;
  account?: BotConfig["account"];
}

export function initStatePath(botId: string): string {
  return join(cassieHome(), "setup", `${safeBotId(botId)}.json`);
}

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const SHA256_RE = /^sha256:[A-Za-z0-9_-]{43}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BOOTSTRAP_PHASES = ["planned", "deployed", "envelope-ready", "master-stored", "acknowledged", "purged"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("-") &&
    !value.includes(",") &&
    !/[\r\n\0]/.test(value)
  );
}

function validateBootstrapRequest(value: unknown, botId: string): WalletBootstrapRequest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "botId", "sessionId", "publicKeySpki", "publicKeyFingerprint", "challenge"]) ||
    Object.keys(value).length !== 6 ||
    value.version !== 1 ||
    value.botId !== botId ||
    typeof value.sessionId !== "string" ||
    !TOKEN_RE.test(value.sessionId) ||
    typeof value.challenge !== "string" ||
    !TOKEN_RE.test(value.challenge) ||
    typeof value.publicKeyFingerprint !== "string" ||
    !SHA256_RE.test(value.publicKeyFingerprint) ||
    typeof value.publicKeySpki !== "string" ||
    value.publicKeySpki.length < 400 ||
    value.publicKeySpki.length > 1_000 ||
    !/^[A-Za-z0-9_-]+$/.test(value.publicKeySpki)
  ) {
    throw new Error("init journal bootstrap request is invalid");
  }
  return value as unknown as WalletBootstrapRequest;
}

function validateBootstrap(value: unknown, botId: string, venue: InitVenue): BootstrapCheckpoint | undefined {
  if (value === undefined) return undefined;
  if (venue !== "hyperliquid" || !isRecord(value)) throw new Error("init journal bootstrap checkpoint is invalid");
  if (
    !hasOnlyKeys(value, ["workerName", "request", "controlUrl", "phase"]) ||
    typeof value.workerName !== "string" ||
    !BOOTSTRAP_PHASES.includes(value.phase as (typeof BOOTSTRAP_PHASES)[number])
  ) {
    throw new Error("init journal bootstrap checkpoint is invalid");
  }
  const request = validateBootstrapRequest(value.request, botId);
  const suffix = request.sessionId.replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 8);
  const expectedWorker = `cassie-bootstrap-${botId}-${suffix}`;
  if (value.workerName !== expectedWorker) throw new Error("init journal bootstrap Worker does not match its session");

  const needsUrl = value.phase !== "planned";
  if (needsUrl !== (typeof value.controlUrl === "string")) {
    throw new Error(`init journal bootstrap phase ${String(value.phase)} has an invalid control URL`);
  }
  if (typeof value.controlUrl === "string") {
    let url: URL;
    try {
      url = new URL(value.controlUrl);
    } catch {
      throw new Error("init journal bootstrap control URL is invalid");
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      !url.hostname.endsWith(".workers.dev") ||
      url.hostname.split(".")[0] !== expectedWorker
    ) {
      throw new Error("init journal bootstrap control URL is not the expected workers.dev deployment");
    }
  }
  return {
    workerName: expectedWorker,
    request,
    phase: value.phase as BootstrapCheckpoint["phase"],
    ...(typeof value.controlUrl === "string" ? { controlUrl: value.controlUrl } : {}),
  };
}

function assertNoSecretFields(value: unknown, path = "setup"): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(private|secret|passphrase|api[-_]?key|token)/i.test(key)) {
      throw new Error(`${path}.${key}: secrets are forbidden in the init journal`);
    }
    assertNoSecretFields(child, `${path}.${key}`);
  }
}

function validatePending(
  value: unknown,
  botId: string,
  venue: InitVenue,
  wallet: BotConfig["wallet"] | undefined,
): PendingSplitsAccount | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["phase", "organizationId", "organizationName", "accountName", "passkeyIds", "eoa", "threshold"])
  ) {
    throw new Error("pendingTreasury must be an exact account plan");
  }
  const pending = value;
  if (pending.phase !== "planned" && pending.phase !== "create-attempted") {
    throw new Error("pendingTreasury.phase is invalid");
  }
  if (!validOpaqueId(pending.organizationId)) throw new Error("pendingTreasury.organizationId is required");
  if (
    pending.organizationName !== undefined &&
    pending.organizationName !== null &&
    (typeof pending.organizationName !== "string" || pending.organizationName.length === 0)
  ) {
    throw new Error("pendingTreasury.organizationName is invalid");
  }
  if (pending.accountName !== `cassie-${botId}`) throw new Error("pendingTreasury.accountName does not match the bot id");
  if (
    !Array.isArray(pending.passkeyIds) ||
    pending.passkeyIds.length === 0 ||
    pending.passkeyIds.some((id) => !validOpaqueId(id)) ||
    new Set(pending.passkeyIds).size !== pending.passkeyIds.length
  ) {
    throw new Error("pendingTreasury.passkeyIds must contain signer ids");
  }
  let eoa: PendingSplitsAccount["eoa"];
  if (pending.eoa !== undefined) {
    if (
      venue === "polymarket" ||
      !isRecord(pending.eoa) ||
      !hasOnlyKeys(pending.eoa, ["id", "address"]) ||
      Object.keys(pending.eoa).length !== 2 ||
      !validOpaqueId(pending.eoa.id) ||
      typeof pending.eoa.address !== "string" ||
      !EVM_ADDRESS_RE.test(pending.eoa.address) ||
      !wallet?.address ||
      pending.eoa.address.toLowerCase() !== wallet.address.toLowerCase()
    ) {
      throw new Error("pendingTreasury.eoa is invalid for this bot wallet");
    }
    eoa = { id: pending.eoa.id, address: pending.eoa.address };
  }
  const signerCount = pending.passkeyIds.length + (eoa ? 1 : 0);
  if (!Number.isSafeInteger(pending.threshold) || Number(pending.threshold) <= 0 || Number(pending.threshold) > signerCount) {
    throw new Error("pendingTreasury.threshold is invalid for its signer set");
  }
  return {
    phase: pending.phase,
    organizationId: pending.organizationId,
    ...(pending.organizationName !== undefined ? { organizationName: pending.organizationName as string | null } : {}),
    accountName: pending.accountName,
    passkeyIds: [...pending.passkeyIds] as string[],
    ...(eoa ? { eoa } : {}),
    threshold: pending.threshold as number,
  };
}

export function parseInitState(value: unknown, expectedBotId?: string): InitState {
  if (!value || typeof value !== "object") throw new Error("init journal must be an object");
  assertNoSecretFields(value);
  const raw = value as Record<string, unknown>;
  if (!hasOnlyKeys(raw, ["version", "botId", "venue", "createdAt", "wallet", "bootstrap", "pendingTreasury", "treasury", "account"])) {
    throw new Error("init journal contains unknown fields");
  }
  if (raw.version !== 1) throw new Error("unsupported init journal version");
  if (typeof raw.botId !== "string") throw new Error("init journal botId is required");
  safeBotId(raw.botId);
  if (expectedBotId && raw.botId !== expectedBotId) throw new Error(`init journal belongs to ${raw.botId}, not ${expectedBotId}`);
  if (!(["polymarket", "hyperliquid", "lighter"] as unknown[]).includes(raw.venue)) {
    throw new Error("init journal venue is invalid");
  }
  if (typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) {
    throw new Error("init journal createdAt is invalid");
  }

  const venue = raw.venue as InitVenue;
  const parsed = parseBotConfig({
    id: raw.botId,
    venue,
    ...(raw.wallet === undefined ? {} : { wallet: raw.wallet }),
    ...(raw.treasury === undefined ? {} : { treasury: raw.treasury }),
    ...(raw.account === undefined ? {} : { account: raw.account }),
  });
  const bootstrap = validateBootstrap(raw.bootstrap, parsed.id, venue);
  if (
    bootstrap &&
    (bootstrap.phase === "master-stored" || bootstrap.phase === "acknowledged" || bootstrap.phase === "purged") &&
    (parsed.wallet.origin !== "container" || !parsed.wallet.address)
  ) {
    throw new Error(`init journal bootstrap phase ${bootstrap.phase} requires its verified container wallet`);
  }
  const pendingTreasury = validatePending(
    raw.pendingTreasury,
    parsed.id,
    venue,
    raw.wallet === undefined ? undefined : parsed.wallet,
  );
  return {
    version: 1,
    botId: parsed.id,
    venue,
    createdAt: raw.createdAt,
    ...(raw.wallet === undefined ? {} : { wallet: parsed.wallet }),
    ...(bootstrap ? { bootstrap } : {}),
    ...(pendingTreasury ? { pendingTreasury } : {}),
    ...(raw.treasury === undefined ? {} : { treasury: parsed.treasury! }),
    ...(raw.account === undefined ? {} : { account: parsed.account! }),
  };
}

export function loadInitState(botId: string): InitState | null {
  const path = initStatePath(botId);
  if (!existsSync(path)) return null;
  try {
    return parseInitState(JSON.parse(readFileSync(path, "utf8")), botId);
  } catch (error) {
    throw new Error(`cannot resume ${path}: ${(error as Error).message}`);
  }
}

export function saveInitState(state: InitState): string {
  const parsed = parseInitState(state, state.botId);
  const path = initStatePath(state.botId);
  atomicWritePrivateFile(path, JSON.stringify(parsed, null, 2) + "\n");
  return path;
}

export function clearInitState(botId: string): boolean {
  const path = initStatePath(botId);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

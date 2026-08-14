// packages/cli/src/splits.ts
// Typed, non-interactive adapter for the operator-authenticated Splits CLI.

import { spawnSync } from "node:child_process";
import { restrictedChildEnv } from "./child-env.js";

export const SPLITS_CLI_VERSION = "0.2.11";
export const SPLITS_CLI_INSTALL_COMMAND =
  `npm install --global @splits/splits-cli@${SPLITS_CLI_VERSION}`;

const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;

export interface SplitsCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Receives arguments after the `splits` executable. Implementations must not
 * invoke a shell or interpolate these values into a command string.
 */
export type SplitsCommandRunner = (
  args: readonly string[],
) => SplitsCommandResult | Promise<SplitsCommandResult>;

/** Production runner. Authentication stays in the Splits CLI's own config/env. */
export const runSplitsCommand: SplitsCommandRunner = (args) => {
  const result = spawnSync("splits", [...args], {
    encoding: "utf8",
    env: restrictedChildEnv(["SPLITS_"]),
    maxBuffer: OUTPUT_LIMIT_BYTES,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
    ...(result.error
      ? {
          errorCode: (result.error as NodeJS.ErrnoException).code,
          errorMessage: result.error.message,
        }
      : {}),
  };
};

export type SplitsCliErrorKind =
  | "not-installed"
  | "not-authenticated"
  | "not-authorized"
  | "command-failed"
  | "invalid-input"
  | "invalid-output";

export class SplitsCliError extends Error {
  readonly kind: SplitsCliErrorKind;
  readonly exitCode?: number;

  constructor(kind: SplitsCliErrorKind, message: string, exitCode?: number) {
    super(message);
    this.name = "SplitsCliError";
    this.kind = kind;
    this.exitCode = exitCode;
  }
}

export interface SplitsOrganization {
  orgId: string;
  orgName: string | null;
  keyName: string;
  scopes: string[];
  accountCount: number;
}

export interface SplitsMember {
  userId: string;
  email: string | null;
  role: string;
  displayName: string | null;
  createdAt: string;
}

export interface SplitsPasskeySigner {
  id: string;
  name: string | null;
  createdAt: string;
  isArchived: boolean;
}

export interface SplitsEoaSigner {
  id: string;
  address: string;
  name: string | null;
}

export interface SplitsAccount {
  id: string;
  name: string | null;
  address: string;
  type: string;
  role: string | null;
  isArchived: boolean;
  createdAt: string;
}

export interface SplitsAccountPasskeySigner {
  id: string;
  name: string;
  isArchived: boolean;
  createdAt: string;
  userId: string;
  userEmail: string;
  userDisplayName: string | null;
}

export interface SplitsAccountEoaSigner {
  id: string;
  address: string;
  name: string | null;
  email: string | null;
  userId: string | null;
  createdAt: string;
  lastVerifiedAt: string | null;
}

export interface SplitsAccountSigners {
  threshold: number;
  passkeySigners: SplitsAccountPasskeySigner[];
  eoaSigners: SplitsAccountEoaSigner[];
}

export interface CreateSplitsAccountInput {
  name: string;
  passkeyIds?: readonly string[];
  eoaSignerIds?: readonly string[];
  threshold: number;
}

interface JsonObject {
  [key: string]: unknown;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function invalidInput(message: string): never {
  throw new SplitsCliError("invalid-input", message);
}

function cleanId(value: string, label: string): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.startsWith("-") || cleaned.includes(",") || /[\r\n\0]/.test(cleaned)) {
    invalidInput(`${label} must be one non-empty signer id`);
  }
  return cleaned;
}

function uniqueIds(values: readonly string[] | undefined, label: string): string[] {
  return [...new Set((values ?? []).map((value) => cleanId(value, label)))];
}

function commandLabel(args: readonly string[]): string {
  // Only fixed command words are passed here; values are deliberately omitted
  // from errors so account names and addresses cannot accidentally become logs.
  return args.slice(0, 2).join(" ");
}

function redact(text: string): string {
  let safe = text;
  const configuredKey = process.env.SPLITS_API_KEY;
  if (configuredKey) safe = safe.split(configuredKey).join("[redacted]");

  return safe
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/\bsk_[A-Za-z0-9_-]{6,}\b/g, "[redacted]")
    .replace(
      /((?:splits[_-]?api[_-]?key|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      "$1[redacted]",
    )
    .replace(/\b(?:0x)?[0-9a-fA-F]{64}\b/g, "[redacted-private-value]");
}

function excerpt(result: SplitsCommandResult): string {
  const detail = [result.stderr, result.stdout, result.errorMessage]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n")
    .trim();
  if (!detail) return "";
  const safe = redact(detail).replace(/\s+/g, " ").trim();
  return safe.length > 500 ? `${safe.slice(0, 500)}…` : safe;
}

function commandFailure(args: readonly string[], result: SplitsCommandResult): never {
  const label = commandLabel(args);
  const detail = excerpt(result);
  const normalized = detail.toLowerCase();
  const exitCode = result.exitCode ?? undefined;

  if (result.errorCode === "ENOENT") {
    throw new SplitsCliError(
      "not-installed",
      `Splits CLI ${SPLITS_CLI_VERSION} is not installed or is not on PATH. Run \`${SPLITS_CLI_INSTALL_COMMAND}\`, then authenticate with \`splits auth login\`.`,
    );
  }

  if (
    normalized.includes("no-api-key") ||
    normalized.includes("no api key") ||
    normalized.includes("not authenticated") ||
    normalized.includes("unauthorized") ||
    /(?:^|\D)401(?:\D|$)/.test(normalized)
  ) {
    throw new SplitsCliError(
      "not-authenticated",
      "Splits CLI is not authenticated. Get a Teams API key, then run `splits auth login` or set SPLITS_API_KEY before retrying.",
      exitCode,
    );
  }

  if (
    normalized.includes("owner-scoped") ||
    normalized.includes("insufficient scope") ||
    normalized.includes("forbidden") ||
    /(?:^|\D)403(?:\D|$)/.test(normalized)
  ) {
    throw new SplitsCliError(
      "not-authorized",
      "The authenticated Splits API key cannot perform this action. Use an owner-scoped Teams API key and confirm it with `splits auth whoami`.",
      exitCode,
    );
  }

  const suffix = detail ? `: ${detail}` : "";
  throw new SplitsCliError(
    "command-failed",
    `\`splits ${label}\` failed${exitCode === undefined ? "" : ` (exit ${exitCode})`}${suffix}`,
    exitCode,
  );
}

function objectValue(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SplitsCliError("invalid-output", `Splits CLI returned invalid ${context}.`);
  }
  return value as JsonObject;
}

function stringValue(object: JsonObject, key: string, context: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new SplitsCliError("invalid-output", `Splits CLI returned invalid ${context}: missing ${key}.`);
  }
  return value;
}

function nullableStringValue(object: JsonObject, key: string, context: string): string | null {
  const value = object[key];
  if (value !== null && typeof value !== "string") {
    throw new SplitsCliError("invalid-output", `Splits CLI returned invalid ${context}: missing ${key}.`);
  }
  return value;
}

function booleanValue(object: JsonObject, key: string, context: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") {
    throw new SplitsCliError("invalid-output", `Splits CLI returned invalid ${context}: missing ${key}.`);
  }
  return value;
}

function envelopeData(value: unknown, context: string): unknown {
  const envelope = objectValue(value, `${context} response`);
  if (!("data" in envelope)) {
    throw new SplitsCliError("invalid-output", `Splits CLI returned invalid ${context}: missing data.`);
  }
  return envelope.data;
}

function parseOrganization(value: unknown): SplitsOrganization {
  const data = objectValue(envelopeData(value, "organization response"), "organization data");
  const scopes = data.scopes;
  const accountCount = data.accountCount;
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) {
    throw new SplitsCliError("invalid-output", "Splits CLI returned invalid organization data: missing scopes.");
  }
  if (!Number.isInteger(accountCount) || (accountCount as number) < 0) {
    throw new SplitsCliError(
      "invalid-output",
      "Splits CLI returned invalid organization data: missing accountCount.",
    );
  }
  return {
    orgId: stringValue(data, "orgId", "organization data"),
    orgName: nullableStringValue(data, "orgName", "organization data"),
    keyName: stringValue(data, "keyName", "organization data"),
    scopes: [...scopes] as string[],
    accountCount: accountCount as number,
  };
}

function parseMembers(value: unknown): SplitsMember[] {
  const data = envelopeData(value, "members response");
  if (!Array.isArray(data)) {
    throw new SplitsCliError("invalid-output", "Splits CLI returned invalid members data.");
  }
  return data.map((item) => {
    const member = objectValue(item, "member");
    return {
      userId: stringValue(member, "userId", "member"),
      email: nullableStringValue(member, "email", "member"),
      role: stringValue(member, "role", "member"),
      displayName: nullableStringValue(member, "displayName", "member"),
      createdAt: stringValue(member, "createdAt", "member"),
    };
  });
}

function parsePasskeySigners(value: unknown): SplitsPasskeySigner[] {
  const data = envelopeData(value, "member signers response");
  if (!Array.isArray(data)) {
    throw new SplitsCliError("invalid-output", "Splits CLI returned invalid member signers data.");
  }
  return data.map((item) => {
    const signer = objectValue(item, "passkey signer");
    return {
      id: stringValue(signer, "id", "passkey signer"),
      name: nullableStringValue(signer, "name", "passkey signer"),
      createdAt: stringValue(signer, "createdAt", "passkey signer"),
      isArchived: booleanValue(signer, "isArchived", "passkey signer"),
    };
  });
}

function parseEoaSigner(value: unknown): SplitsEoaSigner {
  const data = objectValue(envelopeData(value, "EOA signer response"), "EOA signer data");
  const address = stringValue(data, "address", "EOA signer data");
  if (!EVM_ADDRESS.test(address)) {
    throw new SplitsCliError("invalid-output", "Splits CLI returned an invalid EOA signer address.");
  }
  return {
    id: stringValue(data, "id", "EOA signer data"),
    address,
    name: nullableStringValue(data, "name", "EOA signer data"),
  };
}

function parseAccount(value: unknown): SplitsAccount {
  const data = objectValue(envelopeData(value, "account response"), "account data");
  const address = stringValue(data, "address", "account data");
  if (!EVM_ADDRESS.test(address)) {
    throw new SplitsCliError("invalid-output", "Splits CLI returned an invalid account address.");
  }
  return {
    id: stringValue(data, "id", "account data"),
    name: nullableStringValue(data, "name", "account data"),
    address,
    type: stringValue(data, "type", "account data"),
    role: nullableStringValue(data, "role", "account data"),
    isArchived: booleanValue(data, "isArchived", "account data"),
    createdAt: stringValue(data, "createdAt", "account data"),
  };
}

function parseAccounts(value: unknown): SplitsAccount[] {
  const data = envelopeData(value, "accounts response");
  if (!Array.isArray(data)) {
    throw new SplitsCliError("invalid-output", "Splits CLI returned invalid accounts data.");
  }
  return data.map((account) => parseAccount({ data: account }));
}

function parseAccountSigners(value: unknown): SplitsAccountSigners {
  const data = objectValue(envelopeData(value, "account signers response"), "account signers data");
  const threshold = data.threshold;
  if (!Number.isInteger(threshold) || (threshold as number) < 1) {
    throw new SplitsCliError(
      "invalid-output",
      "Splits CLI returned invalid account signers data: missing threshold.",
    );
  }
  if (!Array.isArray(data.passkeySigners) || !Array.isArray(data.eoaSigners)) {
    throw new SplitsCliError(
      "invalid-output",
      "Splits CLI returned invalid account signers data: missing signer arrays.",
    );
  }

  const passkeySigners = data.passkeySigners.map((item) => {
    const signer = objectValue(item, "account passkey signer");
    return {
      id: stringValue(signer, "id", "account passkey signer"),
      name: stringValue(signer, "name", "account passkey signer"),
      isArchived: booleanValue(signer, "isArchived", "account passkey signer"),
      createdAt: stringValue(signer, "createdAt", "account passkey signer"),
      userId: stringValue(signer, "userId", "account passkey signer"),
      userEmail: stringValue(signer, "userEmail", "account passkey signer"),
      userDisplayName: nullableStringValue(signer, "userDisplayName", "account passkey signer"),
    };
  });

  const eoaSigners = data.eoaSigners.map((item) => {
    const signer = objectValue(item, "account EOA signer");
    const address = stringValue(signer, "address", "account EOA signer");
    if (!EVM_ADDRESS.test(address)) {
      throw new SplitsCliError("invalid-output", "Splits CLI returned an invalid account EOA signer address.");
    }
    return {
      id: stringValue(signer, "id", "account EOA signer"),
      address,
      name: nullableStringValue(signer, "name", "account EOA signer"),
      email: nullableStringValue(signer, "email", "account EOA signer"),
      userId: nullableStringValue(signer, "userId", "account EOA signer"),
      createdAt: stringValue(signer, "createdAt", "account EOA signer"),
      lastVerifiedAt: nullableStringValue(signer, "lastVerifiedAt", "account EOA signer"),
    };
  });

  return { threshold: threshold as number, passkeySigners, eoaSigners };
}

export class SplitsCli {
  readonly #runner: SplitsCommandRunner;

  constructor(runner: SplitsCommandRunner = runSplitsCommand) {
    this.#runner = runner;
  }

  async #jsonCommand(args: readonly string[]): Promise<unknown> {
    let result: SplitsCommandResult;
    try {
      result = await this.#runner(args);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      result = {
        stdout: "",
        stderr: "",
        exitCode: null,
        errorCode: err?.code,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }

    if (result.exitCode !== 0 || result.errorCode) commandFailure(args, result);

    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      const detail = excerpt(result);
      const suffix = detail ? ` Received: ${detail}` : "";
      throw new SplitsCliError(
        "invalid-output",
        `Splits CLI returned non-JSON output for \`splits ${commandLabel(args)}\`. Install @splits/splits-cli@${SPLITS_CLI_VERSION} and retry.${suffix}`,
      );
    }
  }

  async whoAmI(): Promise<SplitsOrganization> {
    return parseOrganization(await this.#jsonCommand(["auth", "whoami", "--format", "json"]));
  }

  async listMembers(): Promise<SplitsMember[]> {
    return parseMembers(await this.#jsonCommand(["members", "list", "--format", "json"]));
  }

  async listMemberSigners(userId: string): Promise<SplitsPasskeySigner[]> {
    const id = cleanId(userId, "member user id");
    return parsePasskeySigners(
      await this.#jsonCommand(["members", "signers", id, "--format", "json"]),
    );
  }

  /** List active org accounts so callers can reconcile an ambiguous create. */
  async listAccounts(): Promise<SplitsAccount[]> {
    return parseAccounts(await this.#jsonCommand(["accounts", "list", "--format", "json"]));
  }

  async getAccountSigners(address: string): Promise<SplitsAccountSigners> {
    if (!EVM_ADDRESS.test(address)) invalidInput("Splits account address must be a 20-byte 0x address");
    return parseAccountSigners(
      await this.#jsonCommand(["accounts", "signers", address, "--format", "json"]),
    );
  }

  async registerEoaSigner(address: string, name?: string): Promise<SplitsEoaSigner> {
    if (!EVM_ADDRESS.test(address)) invalidInput("Splits EOA signer address must be a 20-byte 0x address");
    const args = ["auth", "register-signer", address];
    if (name !== undefined) {
      const normalizedName = name.trim();
      if (!normalizedName || normalizedName.length > 200) {
        invalidInput("Splits EOA signer name must contain 1-200 characters");
      }
      args.push("--name", normalizedName);
    }
    args.push("--format", "json");
    return parseEoaSigner(await this.#jsonCommand(args));
  }

  async createAccount(input: CreateSplitsAccountInput): Promise<SplitsAccount> {
    const name = input.name.trim();
    if (!name || name.length > 255) invalidInput("Splits account name must contain 1-255 characters");

    const passkeyIds = uniqueIds(input.passkeyIds, "passkey id");
    const eoaSignerIds = uniqueIds(input.eoaSignerIds, "EOA signer id");
    const signerCount = passkeyIds.length + eoaSignerIds.length;
    if (signerCount === 0) invalidInput("A Splits account needs at least one signer");
    if (!Number.isInteger(input.threshold) || input.threshold < 1 || input.threshold > signerCount) {
      invalidInput(`Splits account threshold must be an integer from 1 to ${signerCount}`);
    }

    const args = ["accounts", "create", "--name", name];
    if (passkeyIds.length > 0) args.push("--passkey-ids", passkeyIds.join(","));
    if (eoaSignerIds.length > 0) args.push("--eoa-signer-ids", eoaSignerIds.join(","));
    args.push("--threshold", String(input.threshold), "--format", "json");

    return parseAccount(await this.#jsonCommand(args));
  }
}

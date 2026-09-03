// packages/cli/src/ssh.ts
// SSH is the only way in to a deployed bot: no open port, no bearer token, no
// TLS. The key lives at ~/.cassie/ssh/id_ed25519 (0600) and host keys are
// pinned to ~/.cassie/ssh/known_hosts on first contact.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dirs } from "./paths.js";
import { restrictedChildEnv } from "./child-env.js";

export function sshDir(): string {
  return join(dirs.home(), "ssh");
}
export function keyPath(): string {
  return join(sshDir(), "id_ed25519");
}
export function knownHostsPath(): string {
  return join(sshDir(), "known_hosts");
}

export interface Target {
  host: string;
  user: string;
}

/** Generate the deploy key once. Every bot on this machine shares it. */
export function ensureKeypair(): { publicKey: string; path: string } {
  mkdirSync(sshDir(), { recursive: true, mode: 0o700 });
  const path = keyPath();
  if (!existsSync(path)) {
    const result = spawnSync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-C", "cassie", "-f", path],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status !== 0) {
      throw new Error(`ssh-keygen failed: ${(result.stderr || result.stdout || "").trim().slice(0, 300)}`);
    }
  }
  return { publicKey: readFileSync(`${path}.pub`, "utf8").trim(), path };
}

/**
 * Record the host's key before the first real connection. Every later call runs
 * with StrictHostKeyChecking=yes against this file, so a swapped host key fails
 * loudly instead of prompting.
 *
 * DigitalOcean reports a droplet `active` before sshd is listening, so this
 * polls: a keyscan against a booting droplet returns nothing, not an error.
 */
export async function pinHostKey(host: string, attempts = 40, intervalMs = 3_000): Promise<void> {
  mkdirSync(sshDir(), { recursive: true, mode: 0o700 });
  const path = knownHostsPath();
  if (existsSync(path) && readFileSync(path, "utf8").includes(`${host} `)) return;
  for (let i = 0; i < attempts; i++) {
    const result = spawnSync("ssh-keyscan", ["-t", "ed25519", "-T", "10", host], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keys = (result.stdout ?? "").split("\n").filter((line) => line.startsWith(host));
    if (keys.length > 0) {
      appendFileSync(path, `${keys.join("\n")}\n`, { mode: 0o600 });
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`could not read the host key for ${host} after ${attempts} tries; the droplet never started sshd`);
}

export function forgetHostKey(host: string): void {
  const path = knownHostsPath();
  if (!host || !existsSync(path)) return;
  spawnSync("ssh-keygen", ["-R", host, "-f", path], { stdio: "ignore" });
}

export function sshArgs(target: Target, extra: string[] = []): string[] {
  return [
    "-i", keyPath(),
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHostsPath()}`,
    "-o", "ConnectTimeout=10",
    "-o", "BatchMode=yes",
    ...extra,
    `${target.user}@${target.host}`,
  ];
}

export interface ExecResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run one command on the droplet. `stdin` never appears in argv or the process list. */
export function sshExec(
  target: Target,
  command: string,
  stdin?: string,
  options: { maxBufferBytes?: number } = {},
): ExecResult {
  const result = spawnSync("ssh", [...sshArgs(target), "--", command], {
    encoding: "utf8",
    input: stdin,
    stdio: ["pipe", "pipe", "pipe"],
    env: restrictedChildEnv(["SSH_"]),
    maxBuffer: options.maxBufferBytes ?? 32 * 1024 * 1024,
  });
  // A spawn-level failure (ENOBUFS when output exceeds maxBuffer, a missing
  // binary, a signal) leaves status null and stderr empty; surface it so the
  // caller reports the real cause instead of a slice of truncated stdout.
  const spawnFailure = result.error ? `ssh failed: ${result.error.message}` : "";
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: [result.stderr ?? "", spawnFailure].filter(Boolean).join("\n"),
  };
}

export function sshExecOrThrow(target: Target, command: string, stdin?: string): string {
  const result = sshExec(target, command, stdin);
  if (!result.ok) {
    throw new Error(`ssh ${target.user}@${target.host}: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
  }
  return result.stdout;
}

/** Hand the terminal over: `cassie ssh`, and `cassie logs --follow`. */
export function sshInteractive(target: Target, command?: string): Promise<number> {
  const args = sshArgs(target, ["-t", "-o", "BatchMode=no"]);
  if (command) args.push("--", command);
  return new Promise((resolve) => {
    const child = spawn("ssh", args, { stdio: "inherit", env: restrictedChildEnv(["SSH_"]) });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export function controlSocketPath(botId: string): string {
  return `/run/cassie/${botId}.sock`;
}

/**
 * Call the bot's control API through its unix socket. curl runs on the droplet;
 * the request body arrives on stdin so it stays out of the command line.
 */
/** A non-2xx from the control API, carrying the parsed body when there is one. */
export class ControlApiError extends Error {
  constructor(
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ControlApiError";
  }
}

export function controlCall(
  target: Target,
  botId: string,
  method: "GET" | "POST",
  path: string,
  body?: string,
): unknown {
  const socket = controlSocketPath(botId);
  const parts = [
    "curl", "--silent", "--show-error", "--fail-with-body",
    "--unix-socket", socket,
    "-X", method,
    "-H", "'content-type: application/json'",
  ];
  if (body !== undefined) parts.push("--data-binary", "@-");
  parts.push(`'http://localhost${path.startsWith("/") ? path : `/${path}`}'`);

  // A dry-run or status body over dozens of markets can run to tens of MB.
  const result = sshExec(target, parts.join(" "), body, { maxBufferBytes: 256 * 1024 * 1024 });
  const text = result.stdout.trim();
  if (!result.ok) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const detail = /ssh failed:/.test(result.stderr) ? result.stderr.trim() : (text || result.stderr.trim());
    throw new ControlApiError(`control API: ${detail.slice(0, 400) || `curl exited ${result.code}`}`, parsed);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

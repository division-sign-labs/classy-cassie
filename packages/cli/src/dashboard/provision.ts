// packages/cli/src/dashboard/provision.ts
// What `cassie deploy` does for the hosted dashboard: a self-signed certificate
// on the droplet, the password hash in its own file, one ufw rule, three env
// lines. Everything here is a pure string or a small decision; the SSH calls
// live in deploy.ts. No command ever carries the password or its hash; the hash
// travels as stdin of the auth-file write.

import { hashDashboardPassword } from "@quotient-forecasting/cassie-runtime-node";
import type { BotConfig, DashboardConfig } from "@quotient-forecasting/cassie-core";
import { ask } from "../context.js";
import { resolveLocalValue, type ResolvedLocalValue } from "../local-env.js";

export const DEFAULT_DASHBOARD_PORT = 8443;
export const TLS_DIR = "/etc/cassie/tls";
export const MIN_PASSWORD_LENGTH = 8;

/** Same rule as paths.ts; repeated here so this module stays free of filesystem imports. */
function safeBotId(botId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(botId)) throw new Error("bot id must be lowercase alphanumerics/dashes, start with an alphanumeric, and be at most 32 characters");
  return botId;
}

export function authFilePath(botId: string): string {
  return `/etc/cassie/${safeBotId(botId)}.dashboard.json`;
}

export function dashboardAuthFile(passwordHash: string): string {
  return `${JSON.stringify({ passwordHash })}\n`;
}

export function dashboardUrl(host: string, port: number): string {
  return `https://${host}:${port}`;
}

export function assertIpv4(host: string): string {
  const octets = host.split(".");
  if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o) || Number(o) > 255)) {
    throw new Error(`dashboard host must be an IPv4 address, got ${JSON.stringify(host)}`);
  }
  return host;
}

function assertPort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`dashboard port must be an integer from 1024 to 65535, got ${String(port)}`);
  return port;
}

/** Idempotent. The certificate is generated once per droplet and reused on redeploy. */
export function dashboardProvisionCommands(botId: string, host: string, port: number, opts: { previousPort?: number } = {}): string[] {
  const id = safeBotId(botId);
  assertIpv4(host);
  assertPort(port);
  const commands = [
    `install -d -m 0750 -o cassie -g cassie ${TLS_DIR}`,
    `test -s ${TLS_DIR}/cert.pem && test -s ${TLS_DIR}/key.pem || openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 -subj '/CN=cassie-${id}' -addext 'subjectAltName=IP:${host}' -keyout ${TLS_DIR}/key.pem -out ${TLS_DIR}/cert.pem 2>/dev/null`,
    `chown cassie:cassie ${TLS_DIR}/key.pem ${TLS_DIR}/cert.pem && chmod 0600 ${TLS_DIR}/key.pem && chmod 0644 ${TLS_DIR}/cert.pem`,
  ];
  if (opts.previousPort !== undefined && opts.previousPort !== port) commands.push(`ufw delete allow ${assertPort(opts.previousPort)}/tcp || true`);
  commands.push(`ufw allow ${port}/tcp`);
  return commands;
}

/** Close the port and drop the hash; the certificate stays for a later enable. */
export function dashboardDisableCommands(botId: string, port: number): string[] {
  return [`ufw delete allow ${assertPort(port)}/tcp || true`, `rm -f ${authFilePath(botId)}`];
}

export function dashboardOn(cfg: BotConfig): boolean {
  const d = cfg.dashboard;
  return d !== undefined && d.enabled !== false && typeof d.passwordHash === "string" && d.passwordHash.length > 0;
}

export function dashboardEnvLines(cfg: BotConfig): [string, string][] {
  if (!dashboardOn(cfg)) return [];
  return [
    ["CASSIE_DASHBOARD_PORT", String(cfg.dashboard!.port)],
    ["CASSIE_DASHBOARD_AUTH_FILE", authFilePath(cfg.id)],
    ["CASSIE_DASHBOARD_TLS_DIR", TLS_DIR],
  ];
}

export function certFingerprintCommand(): string {
  return `openssl x509 -in ${TLS_DIR}/cert.pem -noout -fingerprint -sha256`;
}

export function parseFingerprint(stdout: string): string | null {
  const match = /Fingerprint=([0-9A-Fa-f:]+)/.exec(stdout);
  return match ? `SHA256:${match[1]!.toUpperCase()}` : null;
}

/** A live dashboard answers 401 here: TLS is up and the session gate is on. */
export function verifyDashboardCommand(port: number): string {
  return `curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:${assertPort(port)}/api/session`;
}

export function dashboardStatusText(cfg: BotConfig): string {
  const d = cfg.dashboard;
  if (d?.enabled === false) return "off";
  if (!d?.passwordHash) return `not provisioned; cassie deploy ${cfg.id}`;
  return cfg.deployment ? dashboardUrl(cfg.deployment.host, d.port) : "set; deploy to serve it";
}

export interface ResolveDashboardDeps {
  resolveLocal: (names: readonly string[]) => ResolvedLocalValue | null;
  ask: (message: string, opts: { secret?: boolean }) => Promise<string>;
  isTty: () => boolean;
  hash: (password: string) => Promise<string>;
}

// Every dependency is reached at call time, so a test that mocks context.ts
// or local-env.ts partially can still import this module.
export const defaultResolveDashboardDeps: ResolveDashboardDeps = {
  resolveLocal: (names) => resolveLocalValue(names),
  ask: (message, opts) => ask(message, opts),
  isTty: () => Boolean(process.stdin.isTTY),
  hash: (password) => hashDashboardPassword(password),
};

export interface ResolvedDashboard {
  config: DashboardConfig;
  /** Where the password came from: the local env origin, "saved", or "prompt". */
  passwordOrigin?: string;
  /** Set when the dashboard stays off this deploy for want of a password. */
  skipped?: string;
}

export function requireDashboardPassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`dashboard password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  return password;
}

/**
 * Enabled: --no-dashboard, --dashboard or --dashboard-port, the saved flag, then on.
 * Password: CASSIE_DASHBOARD_PASSWORD (re-hashed), the saved hash, a prompt, else skip.
 */
export async function resolveDashboardConfig(
  cfg: BotConfig,
  opts: { dashboard?: boolean; dashboardPort?: number },
  deps: ResolveDashboardDeps = defaultResolveDashboardDeps,
): Promise<ResolvedDashboard> {
  const saved = cfg.dashboard;
  const port = assertPort(opts.dashboardPort ?? saved?.port ?? DEFAULT_DASHBOARD_PORT);
  const enabled = opts.dashboard === false ? false : opts.dashboard === true || opts.dashboardPort !== undefined ? true : (saved?.enabled ?? true);
  if (!enabled) return { config: { enabled: false, port, ...(saved?.passwordHash ? { passwordHash: saved.passwordHash } : {}) } };

  const local = deps.resolveLocal(["CASSIE_DASHBOARD_PASSWORD"]);
  if (local) {
    return { config: { enabled: true, port, passwordHash: await deps.hash(requireDashboardPassword(local.value)) }, passwordOrigin: local.origin };
  }
  if (saved?.passwordHash) return { config: { enabled: true, port, passwordHash: saved.passwordHash }, passwordOrigin: "saved" };
  if (!deps.isTty()) {
    return {
      config: { enabled: true, port },
      skipped: `no dashboard password; set CASSIE_DASHBOARD_PASSWORD or run cassie dashboard password ${cfg.id}, then deploy again`,
    };
  }
  const password = await deps.ask("Dashboard password (blank skips the dashboard)", { secret: true });
  if (password.length === 0) return { config: { enabled: true, port }, skipped: "no dashboard password given" };
  requireDashboardPassword(password);
  const confirmation = await deps.ask("Confirm dashboard password", { secret: true });
  if (confirmation !== password) throw new Error("dashboard passwords do not match");
  return { config: { enabled: true, port, passwordHash: await deps.hash(password) }, passwordOrigin: "prompt" };
}

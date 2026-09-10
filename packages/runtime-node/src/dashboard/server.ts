// packages/runtime-node/src/dashboard/server.ts
// One request handler for both dashboards. Hosted mode (a droplet) adds a
// password login, a session cookie, and HTTPS; local mode (the CLI on
// 127.0.0.1) serves the same routes without auth. Read-only by construction:
// there is no route that changes a bot.

import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import type { Logger } from "@quotient-forecasting/cassie-core";
import type { BotService } from "../service.js";
import { applySecurityHeaders, serveStatic } from "./assets.js";
import { parseDashboardAuthFile, verifyDashboardPassword } from "./password.js";
import { parseDashboardRange } from "./snapshot.js";
import type { DashboardBotEntry, DashboardRange } from "./types.js";

const COOKIE = "cassie_dash";
const MINUTE = 60_000;

export interface DashboardBotSource {
  list(range: DashboardRange): Promise<DashboardBotEntry[]>;
  get(id: string, range: DashboardRange): Promise<DashboardBotEntry | undefined>;
}

export interface DashboardAuth {
  current(): Promise<{ passwordHash: string } | undefined>;
}

export interface DashboardHandlerOptions {
  mode: "hosted" | "local";
  bots: DashboardBotSource;
  /** Required in hosted mode; without it every login is refused. */
  auth?: DashboardAuth;
  bot?: { id: string; venue: string; strategy: string };
  log: Logger;
  refreshSeconds?: number;
  now?: () => number;
  sessionTtlMs?: number;
  maxBodyBytes?: number;
}

// --- sessions and rate limiting ---------------------------------------------

export class SessionStore {
  private readonly sessions = new Map<string, number>();
  constructor(private readonly opts: { ttlMs: number; now: () => number; cap?: number }) {}

  create(): string {
    const token = randomBytes(32).toString("hex");
    const cap = this.opts.cap ?? 100;
    while (this.sessions.size >= cap) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    this.sessions.set(token, this.opts.now() + this.opts.ttlMs);
    return token;
  }

  has(token: string | undefined): boolean {
    if (!token) return false;
    const expires = this.sessions.get(token);
    if (expires === undefined) return false;
    if (expires <= this.opts.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  delete(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}

interface LimiterEntry {
  failures: number;
  lockedUntil: number;
  lockMs: number;
  lastAt: number;
}

export class LoginRateLimiter {
  private readonly perIp = new Map<string, LimiterEntry>();
  private attempts: number[] = [];
  private readonly failuresToLock: number;
  private readonly firstLockMs: number;
  private readonly maxLockMs: number;
  private readonly globalPerMinute: number;
  private readonly now: () => number;

  constructor(opts: { now?: () => number; failuresToLock?: number; firstLockMs?: number; maxLockMs?: number; globalPerMinute?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.failuresToLock = opts.failuresToLock ?? 5;
    this.firstLockMs = opts.firstLockMs ?? MINUTE;
    this.maxLockMs = opts.maxLockMs ?? 15 * MINUTE;
    this.globalPerMinute = opts.globalPerMinute ?? 20;
  }

  /** Call before verifying. Returns the wait when the caller must not try yet. */
  check(ip: string): { retryAfterMs: number } | undefined {
    const now = this.now();
    this.prune(now);
    const entry = this.perIp.get(ip);
    if (entry && entry.lockedUntil > now) return { retryAfterMs: entry.lockedUntil - now };
    if (this.attempts.length >= this.globalPerMinute) return { retryAfterMs: this.attempts[0]! + MINUTE - now };
    this.attempts.push(now);
    return undefined;
  }

  fail(ip: string): void {
    const now = this.now();
    const entry = this.perIp.get(ip) ?? { failures: 0, lockedUntil: 0, lockMs: this.firstLockMs, lastAt: now };
    entry.failures += 1;
    entry.lastAt = now;
    if (entry.failures >= this.failuresToLock) {
      entry.lockedUntil = now + entry.lockMs;
      entry.lockMs = Math.min(entry.lockMs * 2, this.maxLockMs);
      entry.failures = 0;
    }
    this.perIp.set(ip, entry);
  }

  reset(ip: string): void {
    this.perIp.delete(ip);
  }

  private prune(now: number): void {
    this.attempts = this.attempts.filter((t) => now - t < MINUTE);
    for (const [ip, entry] of this.perIp) {
      if (entry.lockedUntil <= now && now - entry.lastAt > 60 * MINUTE) this.perIp.delete(ip);
    }
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// --- handler -----------------------------------------------------------------

function sendJson(response: ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}): void {
  const body = JSON.stringify(data);
  applySecurityHeaders(response);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), ...extra });
  response.end(body);
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > limit) throw Object.assign(new Error("request body too large"), { status: 413 });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createDashboardHandler(opts: DashboardHandlerOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const now = opts.now ?? Date.now;
  const requireAuth = opts.mode === "hosted";
  const sessions = new SessionStore({ ttlMs: opts.sessionTtlMs ?? 7 * 24 * 60 * MINUTE, now });
  const limiter = new LoginRateLimiter({ now });
  const refreshSeconds = opts.refreshSeconds ?? (opts.mode === "hosted" ? 15 : 30);
  const maxBody = opts.maxBodyBytes ?? 4096;
  const cookieMaxAge = Math.floor((opts.sessionTtlMs ?? 7 * 24 * 60 * MINUTE) / 1000);
  let lastAuthWarnAt = 0;

  const sessionBody = () => ({ authenticated: true, mode: opts.mode, ...(opts.bot ? { bot: opts.bot } : {}) });
  const tokenOf = (request: IncomingMessage) => parseCookies(request.headers.cookie)[COOKIE];
  const authenticated = (request: IncomingMessage) => !requireAuth || sessions.has(tokenOf(request));

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (serveStatic(request, response)) return;
    const method = request.method?.toUpperCase() ?? "GET";
    const url = new URL(request.url ?? "/", "http://dashboard.local");
    const path = url.pathname;

    if (path === "/api/session") {
      if (method !== "GET") return sendJson(response, 405, { error: "method not allowed" }, { allow: "GET" });
      return authenticated(request) ? sendJson(response, 200, sessionBody()) : sendJson(response, 401, { authenticated: false });
    }

    if (path === "/api/login") {
      if (!requireAuth) return sendJson(response, 404, { error: "no login in local mode" });
      if (method !== "POST") return sendJson(response, 405, { error: "method not allowed" }, { allow: "POST" });
      const ip = request.socket.remoteAddress ?? "unknown";
      const wait = limiter.check(ip);
      if (wait) {
        const seconds = Math.max(1, Math.ceil(wait.retryAfterMs / 1000));
        return sendJson(response, 429, { error: "too many attempts", retryAfterSeconds: seconds }, { "retry-after": String(seconds) });
      }
      let password: unknown;
      try {
        password = (JSON.parse((await readBody(request, maxBody)) || "{}") as { password?: unknown }).password;
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        return sendJson(response, status, { error: status === 413 ? "request body too large" : "body must be JSON" });
      }
      if (typeof password !== "string" || password.length === 0 || password.length > 1024) {
        return sendJson(response, 400, { error: "password required" });
      }
      const current = await opts.auth?.current();
      if (!current) {
        if (now() - lastAuthWarnAt > 5 * MINUTE) {
          opts.log.warn("dashboard: auth file missing or invalid; logins refused");
          lastAuthWarnAt = now();
        }
        limiter.fail(ip);
        return sendJson(response, 401, { error: "invalid password" });
      }
      if (!(await verifyDashboardPassword(password, current.passwordHash))) {
        limiter.fail(ip);
        return sendJson(response, 401, { error: "invalid password" });
      }
      limiter.reset(ip);
      const token = sessions.create();
      return sendJson(response, 200, sessionBody(), {
        "set-cookie": `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${cookieMaxAge}`,
      });
    }

    if (path === "/api/logout") {
      if (method !== "POST") return sendJson(response, 405, { error: "method not allowed" }, { allow: "POST" });
      sessions.delete(tokenOf(request));
      applySecurityHeaders(response);
      response.writeHead(204, { "set-cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` });
      response.end();
      return;
    }

    const bots = /^\/api\/bots(?:\/([^/]+))?$/.exec(path);
    if (bots) {
      if (method !== "GET") return sendJson(response, 405, { error: "method not allowed" }, { allow: "GET" });
      if (!authenticated(request)) return sendJson(response, 401, { authenticated: false });
      let range: DashboardRange;
      try {
        range = parseDashboardRange(url.searchParams.get("range"));
      } catch (error) {
        return sendJson(response, 400, { error: (error as Error).message });
      }
      if (bots[1] === undefined) return sendJson(response, 200, { bots: await opts.bots.list(range), refreshSeconds });
      const entry = await opts.bots.get(decodeURIComponent(bots[1]), range);
      return entry ? sendJson(response, 200, entry) : sendJson(response, 404, { error: "unknown bot" });
    }

    sendJson(response, 404, { error: "not found" });
  }

  return (request, response) => {
    void route(request, response).catch((error) => {
      opts.log.error(`dashboard: ${(error as Error).message}`);
      if (!response.headersSent) sendJson(response, 500, { error: (error as Error).message });
      else response.end();
    });
  };
}

// --- file-backed auth, TLS, server -----------------------------------------

/** Re-reads the auth file when its mtime or size changes, so a password rotation needs no restart. */
export function fileDashboardAuth(path: string, log: Logger, opts: { statIntervalMs?: number; now?: () => number } = {}): DashboardAuth {
  const now = opts.now ?? Date.now;
  const statInterval = opts.statIntervalMs ?? 1000;
  let lastStatAt = Number.NEGATIVE_INFINITY;
  let seen: { mtimeMs: number; size: number } | undefined;
  let value: { passwordHash: string } | undefined;
  let lastWarnAt = Number.NEGATIVE_INFINITY;
  const warn = (message: string) => {
    if (now() - lastWarnAt > 5 * MINUTE) {
      log.warn(`dashboard: ${message}`);
      lastWarnAt = now();
    }
  };
  return {
    async current() {
      const t = now();
      if (t - lastStatAt < statInterval) return value;
      lastStatAt = t;
      let stat;
      try {
        stat = statSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") warn(`auth file ${path} is missing`);
        else warn(`auth file ${path}: ${(error as Error).message}`);
        seen = undefined;
        value = undefined;
        return value;
      }
      if (seen && seen.mtimeMs === stat.mtimeMs && seen.size === stat.size) return value;
      try {
        value = parseDashboardAuthFile(readFileSync(path, "utf8"));
        seen = { mtimeMs: stat.mtimeMs, size: stat.size };
      } catch (error) {
        warn(`auth file ${path}: ${(error as Error).message}`);
        value = undefined;
        seen = undefined;
      }
      return value;
    },
  };
}

export function loadDashboardTls(dir: string): { cert: Buffer; key: Buffer } | undefined {
  try {
    return { cert: readFileSync(join(dir, "cert.pem")), key: readFileSync(join(dir, "key.pem")) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export interface DashboardServerOptions extends DashboardHandlerOptions {
  port: number;
  host?: string;
  tlsDir: string;
}

export interface RunningDashboardServer {
  port: number;
  close(): Promise<void>;
}

/** HTTPS only. Without a certificate, or when the port is taken, it logs and stays off; the bot keeps trading. */
export function startDashboardServer(opts: DashboardServerOptions): Promise<RunningDashboardServer | undefined> {
  const tls = loadDashboardTls(opts.tlsDir);
  if (!tls) {
    opts.log.warn(`dashboard: cert.pem or key.pem missing in ${opts.tlsDir}; not listening`);
    return Promise.resolve(undefined);
  }
  const server = createHttpsServer({ cert: tls.cert, key: tls.key, minVersion: "TLSv1.2" }, createDashboardHandler(opts));
  return new Promise((resolve) => {
    server.once("error", (error) => {
      opts.log.error(`dashboard: listen failed on port ${opts.port}: ${error.message}`);
      resolve(undefined);
    });
    server.listen({ port: opts.port, host: opts.host ?? "::", ipv6Only: false }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      opts.log.info(`dashboard listening on port ${port}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeIdleConnections();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** The droplet's own bot, the only one a hosted dashboard shows. */
export function singleBotSource(service: Pick<BotService, "config" | "identity" | "dashboardSnapshot">, host: string): DashboardBotSource {
  const source = service.identity.runtime === "local" ? "local" : "droplet";
  const entry = async (range: DashboardRange): Promise<DashboardBotEntry> => {
    const fetchedAt = new Date().toISOString();
    try {
      return { id: service.config.id, source, host, fetchedAt, snapshot: await service.dashboardSnapshot(range) };
    } catch (error) {
      return { id: service.config.id, source, host, fetchedAt, error: (error as Error).message };
    }
  };
  return {
    list: async (range) => [await entry(range)],
    get: async (id, range) => (id === service.config.id ? entry(range) : undefined),
  };
}

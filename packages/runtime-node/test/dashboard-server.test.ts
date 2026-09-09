// packages/runtime-node/test/dashboard-server.test.ts
// The shared dashboard handler over plain HTTP: assets, session, login,
// lockout, cookie, bots routes, and password rotation without a restart.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashDashboardPassword } from "../src/dashboard/password.js";
import { LoginRateLimiter, createDashboardHandler, fileDashboardAuth, loadDashboardTls, parseCookies, type DashboardBotSource } from "../src/dashboard/server.js";
import type { DashboardBotEntry, DashboardRange } from "../src/dashboard/types.js";

const log = { info: () => {}, warn: vi.fn(), error: vi.fn(), debug: () => {} };

function bots(): DashboardBotSource {
  const entry = (range: DashboardRange): DashboardBotEntry => ({ id: "bot-1", source: "droplet", host: "1.2.3.4", snapshot: { history: { range } } as never });
  return { list: async (range) => [entry(range)], get: async (id, range) => (id === "bot-1" ? entry(range) : undefined) };
}

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; json: unknown; text: string }

function call(port: number, method: string, path: string, opts: { body?: string; cookie?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.body ? { "content-type": "application/json", "content-length": Buffer.byteLength(opts.body) } : {}), ...opts.headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json: unknown = undefined;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json, text });
      });
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe("dashboard handler (hosted)", () => {
  let dir: string;
  let authPath: string;
  let server: Server;
  let port: number;
  let now = Date.parse("2026-09-09T12:00:00Z");

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cassie-dash-"));
    authPath = join(dir, "bot-1.dashboard.json");
    writeFileSync(authPath, JSON.stringify({ passwordHash: await hashDashboardPassword("open sesame 1") }));
    const handler = createDashboardHandler({
      mode: "hosted",
      bots: bots(),
      auth: fileDashboardAuth(authPath, log, { statIntervalMs: 0 }),
      bot: { id: "bot-1", venue: "polymarket", strategy: "flip-flat" },
      log,
      now: () => now,
    });
    server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    log.warn.mockClear();
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the shell with security headers and refuses the api without a session", async () => {
    const page = await call(port, "GET", "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.text).toContain("<html");
    expect((await call(port, "GET", "/app.js")).headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect((await call(port, "HEAD", "/app.css")).status).toBe(200);
    expect((await call(port, "GET", "/api/session")).status).toBe(401);
    expect((await call(port, "GET", "/api/bots")).status).toBe(401);
    expect((await call(port, "GET", "/api/bots/bot-1")).status).toBe(401);
    expect((await call(port, "GET", "/nope")).status).toBe(404);
    expect((await call(port, "POST", "/api/bots")).status).toBe(405);
    expect((await call(port, "GET", "/api/login")).status).toBe(405);
  });

  it("logs in, sets a session cookie, serves bots, and logs out", async () => {
    const login = await call(port, "POST", "/api/login", { body: JSON.stringify({ password: "open sesame 1" }) });
    expect(login.status).toBe(200);
    expect(login.json).toEqual({ authenticated: true, mode: "hosted", bot: { id: "bot-1", venue: "polymarket", strategy: "flip-flat" } });
    const setCookie = String(login.headers["set-cookie"]);
    expect(setCookie).toMatch(/^cassie_dash=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=604800$/);
    const cookie = setCookie.split(";")[0]!;

    expect((await call(port, "GET", "/api/session", { cookie })).status).toBe(200);
    const list = await call(port, "GET", "/api/bots", { cookie });
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({ refreshSeconds: 15, bots: [{ id: "bot-1", snapshot: { history: { range: "24h" } } }] });
    const one = await call(port, "GET", "/api/bots/bot-1?range=7d", { cookie });
    expect(one.json).toMatchObject({ id: "bot-1", snapshot: { history: { range: "7d" } } });
    expect((await call(port, "GET", "/api/bots/other", { cookie })).status).toBe(404);
    expect((await call(port, "GET", "/api/bots?range=1y", { cookie })).status).toBe(400);

    const logout = await call(port, "POST", "/api/logout", { cookie });
    expect(logout.status).toBe(204);
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await call(port, "GET", "/api/session", { cookie })).status).toBe(401);
  });

  it("rejects wrong passwords, locks out after five, and doubles the lockout", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await call(port, "POST", "/api/login", { body: JSON.stringify({ password: "wrong" }) });
      expect(r.status).toBe(401);
      expect(r.json).toEqual({ error: "invalid password" });
    }
    const locked = await call(port, "POST", "/api/login", { body: JSON.stringify({ password: "open sesame 1" }) });
    expect(locked.status).toBe(429);
    expect(locked.headers["retry-after"]).toBe("60");
    expect(locked.json).toEqual({ error: "too many attempts", retryAfterSeconds: 60 });
    now += 61_000;
    const ok = await call(port, "POST", "/api/login", { body: JSON.stringify({ password: "open sesame 1" }) });
    expect(ok.status).toBe(200);
  });

  it("validates the login body", async () => {
    expect((await call(port, "POST", "/api/login", { body: "{" })).status).toBe(400);
    expect((await call(port, "POST", "/api/login", { body: JSON.stringify({}) })).status).toBe(400);
    expect((await call(port, "POST", "/api/login", { body: JSON.stringify({ password: "x".repeat(5000) }) })).status).toBe(413);
  });

  it("picks up a rotated password from the auth file without a restart", async () => {
    writeFileSync(authPath, JSON.stringify({ passwordHash: await hashDashboardPassword("new password 2") }));
    utimesSync(authPath, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect((await call(port, "POST", "/api/login", { body: JSON.stringify({ password: "open sesame 1" }) })).status).toBe(401);
    expect((await call(port, "POST", "/api/login", { body: JSON.stringify({ password: "new password 2" }) })).status).toBe(200);
  });

  it("refuses logins and warns once when the auth file is gone", async () => {
    rmSync(authPath);
    expect((await call(port, "POST", "/api/login", { body: JSON.stringify({ password: "open sesame 1" }) })).status).toBe(401);
    expect((await call(port, "POST", "/api/login", { body: JSON.stringify({ password: "open sesame 1" }) })).status).toBe(401);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});

describe("dashboard handler (local)", () => {
  it("needs no session and reports local mode", async () => {
    const server = createServer(createDashboardHandler({ mode: "local", bots: bots(), log, refreshSeconds: 30 }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    expect((await call(port, "GET", "/api/session")).json).toEqual({ authenticated: true, mode: "local" });
    expect((await call(port, "GET", "/api/bots")).json).toMatchObject({ refreshSeconds: 30 });
    expect((await call(port, "POST", "/api/login", { body: "{}" })).status).toBe(404);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe("helpers", () => {
  it("parses cookies", () => {
    expect(parseCookies("a=1; cassie_dash=abc; b==x")).toEqual({ a: "1", cassie_dash: "abc", b: "=x" });
    expect(parseCookies(undefined)).toEqual({});
  });

  it("rate limiter doubles the lockout up to fifteen minutes and caps global attempts", () => {
    let t = 0;
    const limiter = new LoginRateLimiter({ now: () => t, globalPerMinute: 3 });
    for (let i = 0; i < 5; i++) limiter.fail("ip");
    expect(limiter.check("ip")?.retryAfterMs).toBe(60_000);
    t = 60_000;
    expect(limiter.check("ip")).toBeUndefined();
    for (let i = 0; i < 5; i++) limiter.fail("ip");
    expect(limiter.check("ip")?.retryAfterMs).toBe(120_000);
    for (let i = 0; i < 12; i++) { t += 120_000; for (let j = 0; j < 5; j++) limiter.fail("ip"); }
    expect(limiter.check("ip")?.retryAfterMs).toBe(15 * 60_000);
    limiter.reset("ip");
    t = 10_000_000;
    expect(limiter.check("a")).toBeUndefined();
    expect(limiter.check("b")).toBeUndefined();
    expect(limiter.check("c")).toBeUndefined();
    expect(limiter.check("d")).toBeDefined();
  });

  it("loads TLS material or reports it missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cassie-tls-"));
    expect(loadDashboardTls(dir)).toBeUndefined();
    writeFileSync(join(dir, "cert.pem"), "CERT");
    writeFileSync(join(dir, "key.pem"), "KEY");
    expect(loadDashboardTls(dir)?.cert.toString()).toBe("CERT");
    rmSync(dir, { recursive: true, force: true });
  });
});

// packages/cli/test/dashboard-server.test.ts
// The local dashboard binds loopback only and refuses foreign Host headers.

import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import type { DashboardBotSource } from "@quotient-forecasting/cassie-runtime-node";
import { isAllowedHost, startLocalDashboardServer, type RunningLocalDashboard } from "../src/dashboard/server.js";

function call(port: number, path: string, host?: string): Promise<{ status: number; json: unknown; contentType?: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: host ? { host } : {} }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json: unknown;
        try { json = JSON.parse(text); } catch { json = text; }
        resolve({ status: res.statusCode ?? 0, json, contentType: res.headers["content-type"] });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const sources: DashboardBotSource & { refreshSeconds: number } = {
  refreshSeconds: 30,
  list: async () => [{ id: "bot-1", source: "offline" }],
  get: async (id, range) => (id === "bot-1" ? { id, source: "offline", snapshot: { history: { range } } as never } : undefined),
};

describe("isAllowedHost", () => {
  it("accepts loopback names with the bound port only", () => {
    expect(isAllowedHost("127.0.0.1:4747", 4747)).toBe(true);
    expect(isAllowedHost("localhost:4747", 4747)).toBe(true);
    expect(isAllowedHost("LOCALHOST:4747", 4747)).toBe(true);
    expect(isAllowedHost("[::1]:4747", 4747)).toBe(true);
    expect(isAllowedHost("127.0.0.1:4748", 4747)).toBe(false);
    expect(isAllowedHost("evil.example:4747", 4747)).toBe(false);
    expect(isAllowedHost(undefined, 4747)).toBe(false);
  });
});

describe("startLocalDashboardServer", () => {
  let running: RunningLocalDashboard | undefined;
  afterEach(async () => { await running?.close(); running = undefined; });

  it("serves the shared routes on loopback without a session", async () => {
    running = await startLocalDashboardServer({ port: 0, sources });
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await call(running.port, "/api/session")).json).toEqual({ authenticated: true, mode: "local" });
    expect((await call(running.port, "/api/bots")).json).toEqual({ bots: [{ id: "bot-1", source: "offline" }], refreshSeconds: 30 });
    expect((await call(running.port, "/api/bots/bot-1?range=7d")).json).toMatchObject({ snapshot: { history: { range: "7d" } } });
    expect((await call(running.port, "/")).contentType).toBe("text/html; charset=utf-8");
  });

  it("refuses a foreign Host header", async () => {
    running = await startLocalDashboardServer({ port: 0, sources });
    const res = await call(running.port, "/api/bots", "attacker.example:80");
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: "forbidden host" });
  });

  it("explains a port in use", async () => {
    running = await startLocalDashboardServer({ port: 0, sources });
    await expect(startLocalDashboardServer({ port: running.port, sources })).rejects.toThrow(/is in use; choose another with --port/);
  });
});

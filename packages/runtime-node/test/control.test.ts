// packages/runtime-node/test/control.test.ts
// The control surface over a real unix socket: routing, encoding, and the
// permissions the socket is created with.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { request } from "node:http";
import { serveControl } from "../src/control.js";
import type { BotService } from "../src/service.js";

interface Call {
  name: string;
  args: unknown[];
}

function fakeService(over: Partial<Record<string, unknown>> = {}) {
  const calls: Call[] = [];
  const record =
    (name: string, result: unknown = { ok: true }) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return Promise.resolve(result);
    };
  const service = {
    calls,
    config: { id: "bot-1", venue: "polymarket", strategy: { id: "signals" } },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    status: () => ({ runtime: "droplet", botId: "bot-1", region: "sgp1", active: true, tickIntervalMin: 5 }),
    paused: record("paused", false),
    start: record("start"),
    tick: record("tick", { ordersPlaced: 1 }),
    portfolio: record("portfolio", { equity: 12 }),
    orders: record("orders", []),
    cancelOrder: record("cancelOrder"),
    cancelAll: record("cancelAll"),
    manualOrder: record("manualOrder", { placed: true }),
    pause: record("pause"),
    resume: record("resume"),
    logs: record("logs", []),
    signalCheck: record("signalCheck", { count: 3 }),
    reportingCheck: record("reportingCheck", { ok: true, enabled: false }),
    geoblockCheck: record("geoblockCheck", { blocked: false, country: "SG" }),
    marketMakeStatus: () => ({ strategyId: "market-make", lifecycle: "HALTED" }),
    marketMakeSnapshot: () => ({ strategy: {}, persistence: {} }),
    marketMakeDryRun: record("marketMakeDryRun", { actions: [] }),
    marketMakeHalt: record("marketMakeHalt", { lifecycle: "HALTED" }),
    marketMakeResume: record("marketMakeResume", { lifecycle: "ACTIVE" }),
    marketMakeReconcile: record("marketMakeReconcile", { applied: true }),
    shutdown: record("shutdown", {
      stopped: true,
      restingOrdersCanceled: true,
      cancellation: {
        method: "engine",
        requested: true,
        completed: true,
        verifiedOpenOrders: false,
        remainingOpenOrders: null,
      },
    }),
    ...over,
  };
  return service as unknown as BotService & { calls: Call[] };
}

function call(
  socketPath: string,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json: unknown = text;
        try {
          json = JSON.parse(text);
        } catch {
          // Left as text so a malformed body shows up in the assertion.
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("serveControl", () => {
  let dir: string;
  let socketPath: string;
  let server: Server;
  let service: BotService & { calls: Call[] };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cassie-control-"));
    socketPath = join(dir, "sub", "bot-1.sock");
    service = fakeService();
    server = serveControl(service, socketPath);
    await new Promise((r) => server.once("listening", r));
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the socket with group-only access", () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o660);
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o750);
  });

  it("answers health without touching the service", async () => {
    expect(await call(socketPath, "GET", "/health")).toEqual({ status: 200, json: { ok: true } });
    expect(service.calls).toHaveLength(0);
  });

  it("reports runtime identity and pause state", async () => {
    const { json } = await call(socketPath, "GET", "/runtime");
    expect(json).toMatchObject({ runtime: "droplet", region: "sgp1", paused: false });
  });

  it("accepts the /bots/:botId prefix as well as a bare path", async () => {
    expect((await call(socketPath, "GET", "/bots/bot-1/portfolio")).json).toEqual({ equity: 12 });
    expect((await call(socketPath, "GET", "/portfolio")).json).toEqual({ equity: 12 });
  });

  it("passes a tick id through and rejects a malformed one", async () => {
    await call(socketPath, "POST", "/tick", JSON.stringify({ tickId: 7 }));
    expect(service.calls.at(-1)).toEqual({ name: "tick", args: [7] });

    const bad = await call(socketPath, "POST", "/tick", JSON.stringify({ tickId: -1 }));
    expect(bad.status).toBe(400);
  });

  it("requires an order id to cancel one", async () => {
    const missing = await call(socketPath, "POST", "/orders/cancel", "{}");
    expect(missing.status).toBe(400);
    const ok = await call(socketPath, "POST", "/orders/cancel", JSON.stringify({ id: "abc" }));
    expect(ok.status).toBe(200);
    expect(service.calls.at(-1)).toEqual({ name: "cancelOrder", args: ["abc"] });
  });

  it("returns 422 for a trade the engine declined", async () => {
    const declining = fakeService({
      manualOrder: () => Promise.resolve({ placed: false, skipReasons: ["depth cap"] }),
    });
    const otherSocket = join(dir, "declining.sock");
    const other = serveControl(declining, otherSocket);
    await new Promise((r) => other.once("listening", r));
    const res = await call(otherSocket, "POST", "/trade", JSON.stringify({ marketRef: "m", side: "buy", size: 1 }));
    expect(res.status).toBe(422);
    await new Promise((r) => other.close(r));
  });

  it("rejects a trade that names no market", async () => {
    const res = await call(socketPath, "POST", "/trade", JSON.stringify({ side: "buy" }));
    expect(res.status).toBe(400);
  });

  it("routes dedicated market-make controls and validates booleans", async () => {
    const proposalHash = "a".repeat(64);
    expect((await call(socketPath, "GET", "/market-make/status")).json).toMatchObject({ lifecycle: "HALTED" });
    await call(socketPath, "POST", "/market-make/halt", JSON.stringify({ liquidate: true }));
    expect(service.calls.at(-1)).toEqual({ name: "marketMakeHalt", args: [{ liquidate: true }] });
    await call(socketPath, "POST", "/market-make/resume", JSON.stringify({ acknowledgeLossReset: true }));
    expect(service.calls.at(-1)).toEqual({
      name: "marketMakeResume",
      args: [{ acknowledgeLossReset: true }],
    });
    await call(
      socketPath,
      "POST",
      "/market-make/reconcile",
      JSON.stringify({ apply: true, expectedProposalHash: proposalHash }),
    );
    expect(service.calls.at(-1)).toEqual({
      name: "marketMakeReconcile",
      args: [{ apply: true, expectedProposalHash: proposalHash }],
    });
    expect((await call(socketPath, "POST", "/market-make/reconcile", JSON.stringify({ apply: true }))).status).toBe(400);
    expect((await call(
      socketPath,
      "POST",
      "/market-make/reconcile",
      JSON.stringify({ apply: true, expectedProposalHash: "not-a-hash" }),
    )).status).toBe(400);
    expect((await call(socketPath, "POST", "/market-make/halt", '{"liquidate":"yes"}')).status).toBe(400);
  });

  it("rejects manual trades before they reach a market-make service", async () => {
    const maker = fakeService({
      config: { id: "bot-1", venue: "polymarket", strategy: { id: "market-make" } },
    });
    const otherSocket = join(dir, "maker.sock");
    const other = serveControl(maker, otherSocket);
    await new Promise((r) => other.once("listening", r));
    const result = await call(
      otherSocket,
      "POST",
      "/trade",
      JSON.stringify({ marketRef: "yes-token", side: "BUY", size: 1 }),
    );
    expect(result.status).toBe(409);
    expect(maker.calls.some((entry) => entry.name === "manualOrder")).toBe(false);

    expect((await call(
      otherSocket,
      "POST",
      "/orders/cancel",
      JSON.stringify({ id: "managed-order" }),
    )).status).toBe(409);
    expect((await call(otherSocket, "POST", "/orders/cancel-all")).status).toBe(409);
    expect(maker.calls.some((entry) => entry.name === "cancelOrder" || entry.name === "cancelAll")).toBe(false);
    await new Promise((r) => other.close(r));
  });

  it("turns a thrown service error into a 500 with its message", async () => {
    const failing = fakeService({
      signalCheck: () => Promise.reject(new Error("signal API 401 Unauthorized")),
    });
    const otherSocket = join(dir, "failing.sock");
    const other = serveControl(failing, otherSocket);
    await new Promise((r) => other.once("listening", r));
    const res = await call(otherSocket, "GET", "/signals/check");
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: "signal API 401 Unauthorized" });
    await new Promise((r) => other.close(r));
  });

  it("404s an unknown route", async () => {
    const res = await call(socketPath, "GET", "/nope");
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: expect.stringContaining("unknown route GET /nope") });
  });

  it("cancels resting orders on shutdown", async () => {
    const res = await call(socketPath, "POST", "/shutdown");
    expect(res.json).toMatchObject({
      stopped: true,
      restingOrdersCanceled: true,
      cancellation: { requested: true, completed: true },
    });
    expect(service.calls.at(-1)?.name).toBe("shutdown");
  });

  it("returns 500 instead of claiming cancellation when shutdown fails", async () => {
    const failing = fakeService({
      shutdown: () => Promise.reject(new Error("authoritative open-orders check found 2 resting orders")),
    });
    const otherSocket = join(dir, "shutdown-failing.sock");
    const other = serveControl(failing, otherSocket);
    await new Promise((r) => other.once("listening", r));
    const res = await call(otherSocket, "POST", "/shutdown");
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: "authoritative open-orders check found 2 resting orders" });
    expect(res.json).not.toMatchObject({ restingOrdersCanceled: true });
    await new Promise((r) => other.close(r));
  });

  it("replaces a stale socket left by a crash", async () => {
    const replacement = serveControl(fakeService(), socketPath);
    await new Promise((r) => replacement.once("listening", r));
    expect((await call(socketPath, "GET", "/health")).status).toBe(200);
    await new Promise((r) => replacement.close(r));
  });
});

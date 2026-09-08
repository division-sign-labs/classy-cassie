// packages/runtime-node/test/local-ownership.test.ts
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBotConfig, type Logger } from "@quotient-forecasting/cassie-core";
import { runLocal, type LocalRunOpts } from "../src/local.js";

const mocks = vi.hoisted(() => ({ construct: vi.fn() }));
vi.mock("../src/service.js", () => ({ BotService: class { constructor(...args: unknown[]) { return mocks.construct(...args); } } }));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function health(socketPath: string, method = "GET", path = "/health"): Promise<number> {
  return new Promise((accept, reject) => {
    const req = request({ socketPath, method, path }, response => { response.resume(); response.once("end", () => accept(response.statusCode!)); });
    req.once("error", reject); req.end();
  });
}

describe("local runtime ownership", () => {
  let dir: string;
  let opts: LocalRunOpts;
  let oldExitCode: typeof process.exitCode;
  let service: ReturnType<typeof fakeService>;
  const runs: Promise<unknown>[] = [];
  let baseline: NodeJS.SignalsListener[];

  function fakeService() {
    return { config: opts.config, log: opts.log!, running: false,
      start: vi.fn(async () => { service.running = true; }),
      tick: vi.fn(async () => ({ ordersPlaced: 0 })),
      shutdown: vi.fn(async () => { service.running = false; return { stopped: true, restingOrdersCanceled: true }; }),
      status: () => ({ active: service.running }), paused: async () => false,
    };
  }
  function begin() {
    const running = runLocal(opts);
    // Retain a rejection observer immediately, as a CLI entry point does.
    void running.catch(() => {});
    runs.push(running);
    return running;
  }
  function signal() {
    const handler = process.listeners("SIGTERM").find(listener => !baseline.includes(listener as NodeJS.SignalsListener));
    if (!handler) throw new Error("local termination handler was not installed");
    handler("SIGTERM");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    oldExitCode = process.exitCode;
    baseline = process.listeners("SIGTERM") as NodeJS.SignalsListener[];
    dir = mkdtempSync(join(tmpdir(), "cassie-local-owner-"));
    opts = { config: parseBotConfig({ id: "owner-test", venue: "polymarket", strategy: { id: "signals", config: {} } }),
      account: { venue: "polymarket", signerAddress: "0x01", funder: "0x02", signatureType: 3 }, statePath: join(dir, "bot.sqlite"),
      controlSocket: join(dir, "bot.sock"), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as Logger };
    service = fakeService();
    mocks.construct.mockReturnValue(service);
  });
  afterEach(async () => {
    const own = process.listeners("SIGTERM").filter(listener => !baseline.includes(listener as NodeJS.SignalsListener));
    for (const listener of own) listener("SIGTERM");
    await Promise.allSettled(runs.splice(0));
    process.exitCode = oldExitCode;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a concurrent launch before constructing another service and waits for its socket before start", async () => {
    const ready = deferred();
    service.start.mockImplementation(async () => {
      expect(await health(opts.controlSocket!)).toBe(200);
      expect(process.listeners("SIGTERM").some(listener => !baseline.includes(listener as NodeJS.SignalsListener))).toBe(true);
      ready.resolve(); service.running = true;
    });
    const first = begin();
    await Promise.race([ready.promise, first]);
    const lock = JSON.parse(readFileSync(`${opts.statePath}.run.lock`, "utf8"));
    expect(lock).toMatchObject({ pid: process.pid, botId: "owner-test", nonce: expect.any(String) });
    await expect(runLocal(opts)).rejects.toThrow("already owned");
    expect(mocks.construct).toHaveBeenCalledOnce();
    expect(await health(opts.controlSocket!)).toBe(200);
    signal(); await first;
    expect(existsSync(`${opts.statePath}.run.lock`)).toBe(false);
    expect(existsSync(opts.controlSocket!)).toBe(false);
  });

  it("does not steal a stale ownership lock", async () => {
    const lock = JSON.stringify({ pid: 2147483647, nonce: "old-owner" });
    writeFileSync(`${opts.statePath}.run.lock`, lock);
    await expect(runLocal(opts)).rejects.toThrow("Only after verifying");
    expect(readFileSync(`${opts.statePath}.run.lock`, "utf8")).toBe(lock);
    expect(mocks.construct).not.toHaveBeenCalled();
  });

  it("leaves an existing live control socket bound to its original server", async () => {
    const existing = createServer((_req, res) => { res.writeHead(204); res.end(); });
    await new Promise<void>((accept, reject) => { existing.once("error", reject); existing.listen(opts.controlSocket!, accept); });
    const before = statSync(opts.controlSocket!);
    try {
      await expect(runLocal(opts)).rejects.toThrow("could not be bound");
      expect(mocks.construct).not.toHaveBeenCalled();
      expect(service.start).not.toHaveBeenCalled();
      expect(service.shutdown).not.toHaveBeenCalled();
      expect(await health(opts.controlSocket!)).toBe(204);
      expect(statSync(opts.controlSocket!).ino).toBe(before.ino);
      expect(existsSync(`${opts.statePath}.run.lock`)).toBe(false);
    } finally { await new Promise<void>((accept, reject) => existing.close(error => error ? reject(error) : accept())); }
  });

  it("cleans up a failed start without removing the state database", async () => {
    writeFileSync(opts.statePath, "persistent-state");
    service.start.mockRejectedValue(new Error("venue unavailable"));
    await expect(begin()).rejects.toThrow("venue unavailable");
    expect(service.shutdown).toHaveBeenCalledWith(true);
    expect(existsSync(`${opts.statePath}.run.lock`)).toBe(false);
    expect(existsSync(opts.controlSocket!)).toBe(false);
    expect(readFileSync(opts.statePath, "utf8")).toBe("persistent-state");
  });

  it("latches shutdown immediately when termination arrives during startup", async () => {
    const entered = deferred();
    const finishStart = deferred();
    service.start.mockImplementation(async () => { entered.resolve(); await finishStart.promise; });
    const running = begin();
    await Promise.race([entered.promise, running]);
    signal();
    expect(service.shutdown).toHaveBeenCalledWith(true);
    expect(existsSync(`${opts.statePath}.run.lock`)).toBe(true);
    finishStart.resolve();
    await running;
    expect(service.shutdown).toHaveBeenCalledOnce();
    expect(existsSync(`${opts.statePath}.run.lock`)).toBe(false);
  });

  it("rejects an unconfirmed shutdown with nonzero status and retains ownership", async () => {
    const entered = deferred();
    service.start.mockImplementation(async () => { entered.resolve(); });
    service.shutdown.mockRejectedValue(new Error("cancellation unconfirmed"));
    const running = begin();
    await Promise.race([entered.promise, running]);
    signal();
    await expect(running).rejects.toThrow("cancellation unconfirmed");
    expect(process.exitCode).toBe(1);
    expect(existsSync(`${opts.statePath}.run.lock`)).toBe(true);
    await expect(runLocal(opts)).rejects.toThrow("already owned");
    expect(opts.log!.error).toHaveBeenCalledWith(expect.stringContaining("ownership retained"));
  });

  it("does not remove a replacement lock that belongs to another owner", async () => {
    const entered = deferred();
    service.start.mockImplementation(async () => { entered.resolve(); });
    const running = begin();
    await Promise.race([entered.promise, running]);
    rmSync(`${opts.statePath}.run.lock`);
    const replacement = JSON.stringify({ pid: 321, nonce: "replacement-owner" });
    writeFileSync(`${opts.statePath}.run.lock`, replacement);
    signal(); await running;
    expect(readFileSync(`${opts.statePath}.run.lock`, "utf8")).toBe(replacement);
  });

  it("releases ownership after a successful control shutdown without an OS signal", async () => {
    const entered = deferred();
    service.start.mockImplementation(async () => { entered.resolve(); });
    const running = begin();
    await Promise.race([entered.promise, running]);
    expect(await health(opts.controlSocket!, "POST", "/bots/owner-test/shutdown")).toBe(200);
    await running;
    expect(existsSync(`${opts.statePath}.run.lock`)).toBe(false);
    expect(existsSync(opts.controlSocket!)).toBe(false);
  });

  it("keeps local ownership when the control API cannot confirm shutdown", async () => {
    const entered = deferred();
    service.start.mockImplementation(async () => { entered.resolve(); });
    service.shutdown.mockRejectedValueOnce(new Error("cancellation unconfirmed"));
    const running = begin();
    await Promise.race([entered.promise, running]);
    expect(await health(opts.controlSocket!, "POST", "/shutdown")).toBe(500);
    expect(existsSync(`${opts.statePath}.run.lock`)).toBe(true);
    expect(await health(opts.controlSocket!)).toBe(200);
    signal(); await running;
  });
});

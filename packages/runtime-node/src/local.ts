// packages/runtime-node/src/local.ts
// `cassie run <botId>`: the same service the droplet runs, without the region
// gate. Ctrl-C cancels resting orders; the venue-side dead man's switch covers
// a hard kill.

import { consoleLogger, type BotConfig, type Logger, type RuntimeCreds, type VenueAccount } from "@quotient-forecasting/cassie-core";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { BotService } from "./service.js";
import type { PolymarketGaslessAuth } from "@quotient-forecasting/cassie-core";
import { handle } from "./control.js";

export interface LocalRunOpts {
  config: BotConfig;
  account: VenueAccount;
  creds?: RuntimeCreds;
  polymarketGaslessAuth?: PolymarketGaslessAuth;
  statePath: string;
  /** Contributor-test hook for a deterministic signal file. */
  signalsFixturePath?: string;
  quotientToken?: string;
  /** Strategy-scoped Quotient key (qsk_…). Required by the signals strategy. */
  strategyKey?: string;
  telegramToken?: string;
  /** Surplus Intelligence key. Required by the agent strategy only. */
  surplusApiKey?: string;
  fixtureBooksPath?: string;
  log?: Logger;
  /** Control socket for another terminal to reach this process. Omit for none. */
  controlSocket?: string;
  /** Test hook: run at most N ticks then return. */
  maxTicks?: number;
}

export function buildLocalService(opts: LocalRunOpts): BotService {
  return new BotService({ ...opts, runtime: "local" });
}

/** Cooperating local launches serialize before opening the bot's persistent state. */
function acquireOwnership(opts: LocalRunOpts): () => void {
  const lockPath = `${resolve(opts.statePath)}.run.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o750 });
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner = "an existing local process";
    try {
      const record = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
      if (Number.isSafeInteger(record.pid) && record.pid! > 0) owner = `PID ${record.pid}`;
    } catch { /* Incomplete or invalid locks remain exclusive. */ }
    throw new Error(`Local bot ${opts.config.id} is already owned by ${owner} (${lockPath}). ` +
      `Check cassie status ${opts.config.id} and cassie logs ${opts.config.id}. ` +
      `Only after verifying that the recorded process is gone, remove this bot's stale lock` +
      `${opts.controlSocket ? ` and stale socket (${opts.controlSocket})` : ""}, then retry.`);
  }
  const identity = fstatSync(descriptor);
  const nonce = randomUUID();
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, nonce, botId: opts.config.id, createdAt: Date.now() }) + "\n");
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(lockPath);
    throw error;
  }
  closeSync(descriptor);
  return () => {
    try {
      const current = statSync(lockPath);
      const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { nonce?: string };
      if (current.dev === identity.dev && current.ino === identity.ino && owner.nonce === nonce) unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}

/** Binding an occupied Unix path fails; local launches never unlink an existing endpoint. */
async function localControl(getService: () => BotService | undefined, botId: string, socketPath: string, onShutdown: () => void): Promise<Server> {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o750 });
  const server = createServer((request, response) => {
    const service = getService();
    if (!service) { response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":"local runtime is starting"}'); return; }
    void handle(service, request, response).then(() => {
      const path = new URL(request.url ?? "/", "http://cassie.local").pathname.split("/").filter(Boolean);
      if (request.method === "POST" && path.at(-1) === "shutdown" && response.statusCode >= 200 && response.statusCode < 300) onShutdown();
    }).catch(error => {
      if (response.headersSent) { response.destroy(error as Error); return; }
      const body = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      response.writeHead(500, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
    });
  });
  await new Promise<void>((accept, reject) => {
    const fail = (error: Error) => {
      reject(new Error(`Local control socket ${socketPath} could not be bound: ${error.message}. ` +
        `Check cassie status ${botId} and cassie logs ${botId}; remove a stale socket only after verifying its owner process is gone.`, { cause: error }));
    };
    server.once("error", fail);
    server.listen(socketPath, () => {
      server.removeListener("error", fail);
      try { chmodSync(socketPath, 0o660); accept(); }
      catch (error) { server.close(() => reject(error)); }
    });
  });
  return server;
}

async function closeControl(server: Server | undefined): Promise<void> {
  if (!server) return;
  server.closeIdleConnections();
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
}

/** Run the bot until SIGINT (or maxTicks, for tests). */
export async function runLocal(opts: LocalRunOpts): Promise<void> {
  const log = opts.log ?? consoleLogger(opts.config.id);
  const releaseOwnership = acquireOwnership(opts);
  let service: BotService | undefined;
  let server: Server | undefined;
  let stopping = false;
  let shutdown: Promise<unknown> | undefined;
  let wake!: () => void;
  const stopped = new Promise<void>(accept => { wake = accept; });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down: canceling resting orders…");
    // shutdown() latches admission synchronously, including during service.start().
    if (service) {
      shutdown = service.shutdown(true);
      void shutdown.catch(() => {});
    }
    wake();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let failure: unknown;
  let shutdownFailed = false;
  try {
    // Own the endpoint before opening SQLite or creating an account-capable service.
    if (opts.controlSocket) server = await localControl(() => service, opts.config.id, opts.controlSocket, stop);
    if (!stopping) {
      service = buildLocalService({ ...opts, log });
      if (opts.maxTicks !== undefined) {
        for (let i = 0; i < opts.maxTicks && !stopping; i++) await service.tick();
        stop();
      } else {
        await service.start();
        await stopped;
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    if (service) {
      try { await (shutdown ?? service.shutdown(true)); }
      catch (error) {
        shutdownFailed = true;
        process.exitCode = 1;
        log.error(`shutdown failed; local ownership retained: ${error instanceof Error ? error.message : String(error)}`);
        failure = failure ? new AggregateError([failure, error], "local startup and shutdown failed") : error;
      }
    }
    try { await closeControl(server); }
    catch (error) { failure ??= error; }
    try { if (!shutdownFailed) releaseOwnership(); }
    finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
  if (failure) throw failure;
}

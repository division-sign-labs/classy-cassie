// packages/runtime-container/src/index.ts
// Private HTTP control surface inside a Cloudflare Container. The outer Worker
// authenticates requests; this server is reachable only through its Container
// Durable Object binding.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LogLevel, ManualOrderParams } from "@quotient/cassie-core";
import { BotService } from "./service.js";

const service = new BotService();

function send(response: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data, null, 2);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function bodyJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return (text ? JSON.parse(text) : {}) as T;
}

function actionOf(request: IncomingMessage): { action: string; url: URL } {
  const url = new URL(request.url ?? "/", "http://container.local");
  const segments = url.pathname.split("/").filter(Boolean);
  const action = segments[0] === "bots" ? segments.slice(2).join("/") : segments.join("/");
  return { action, url };
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { action, url } = actionOf(request);
  const method = request.method?.toUpperCase() ?? "GET";

  if (method === "GET" && (action === "health" || action === "ping")) {
    send(response, { ok: true });
    return;
  }
  if (method === "GET" && action === "runtime") {
    send(response, { ...service.identity, active: service.running });
    return;
  }
  if (method === "GET" && action === "geoblock/check") {
    send(response, { ok: true, ...(await service.geoblockCheck()) });
    return;
  }
  if (method === "GET" && action === "portfolio") {
    send(response, await service.portfolio());
    return;
  }
  if (method === "GET" && action === "orders") {
    send(response, await service.orders());
    return;
  }
  if (method === "GET" && action === "signals/check") {
    send(response, { ok: true, ...(await service.signalCheck()) });
    return;
  }
  if (method === "GET" && action === "reporting/check") {
    send(response, await service.reportingCheck());
    return;
  }
  if (method === "GET" && action === "logs") {
    const level = url.searchParams.get("level") as LogLevel | null;
    const rawTail = Number(url.searchParams.get("tail") ?? 100);
    send(response, await service.logs(level ?? undefined, Number.isFinite(rawTail) ? rawTail : 100));
    return;
  }
  if (method === "POST" && action === "orders/cancel") {
    const body = await bodyJson<{ id?: string }>(request);
    if (!body.id) {
      send(response, { error: "body must include order id" }, 400);
      return;
    }
    await service.cancelOrder(body.id);
    send(response, { ok: true, canceled: body.id });
    return;
  }
  if (method === "POST" && action === "orders/cancel-all") {
    await service.cancelAll();
    send(response, { ok: true, canceled: "all" });
    return;
  }
  if (method === "POST" && action === "trade") {
    const params = await bodyJson<ManualOrderParams>(request);
    if (!params.marketRef || !params.side || !params.size) {
      send(response, { error: "trade requires marketRef, side, size" }, 400);
      return;
    }
    const result = await service.manualOrder(params);
    send(response, result, result.placed ? 200 : 422);
    return;
  }
  if (method === "POST" && action === "pause") {
    await service.pause();
    send(response, { ok: true, paused: true });
    return;
  }
  if (method === "POST" && action === "resume") {
    await service.resume();
    send(response, { ok: true, paused: false });
    return;
  }
  if (method === "POST" && (action === "init" || action === "internal/autostart")) {
    await service.start();
    send(response, {
      ok: true,
      botId: service.config.id,
      venue: service.config.venue,
      strategy: service.config.strategy.id,
      tickIntervalMin: service.config.tickIntervalMin,
      runtime: "cloudflare-container",
      region: service.identity.region,
    });
    return;
  }
  if (method === "POST" && action === "tick") {
    send(response, await service.tick());
    return;
  }
  if (method === "POST" && (action === "shutdown" || action === "internal/shutdown")) {
    await service.shutdown(true);
    send(response, { ok: true, stopped: true, restingOrdersCanceled: true });
    return;
  }
  send(response, { error: `unknown route ${method} ${url.pathname}` }, 404);
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error) => send(response, { error: (error as Error).message }, 500));
});

server.listen(8080, "0.0.0.0", () => {
  console.log(`[${new Date().toISOString()}] [${service.config.id}] INFO listening on :8080`);
});

let signalHandled = false;
async function terminate(signal: string): Promise<void> {
  if (signalHandled) return;
  signalHandled = true;
  console.log(`[${new Date().toISOString()}] [${service.config.id}] INFO ${signal} received`);
  await service.shutdown(true).catch((error) => console.error(`shutdown failed: ${(error as Error).message}`));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 30_000).unref();
}

process.once("SIGTERM", () => void terminate("SIGTERM"));
process.once("SIGINT", () => void terminate("SIGINT"));

export { BotService } from "./service.js";
export { DurableObjectStateStore } from "./state.js";

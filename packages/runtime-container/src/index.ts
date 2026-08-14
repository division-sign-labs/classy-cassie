// packages/runtime-container/src/index.ts
// Private HTTP control surface inside a Cloudflare Container. The outer Worker
// authenticates requests; this server is reachable only through its Container
// Durable Object binding.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LogLevel, ManualOrderParams } from "@quotient-forecasting/cassie-core";
import {
  createWalletBootstrapEnvelope,
  parseWalletBootstrapRequest,
  WALLET_BOOTSTRAP_NO_STORE_HEADERS,
  type WalletBootstrapEnvelope,
  type WalletBootstrapRequest,
} from "./bootstrap-wallet.js";
import { BotService } from "./service.js";

const bootstrapMode = process.env.CASSIE_BOOTSTRAP_MODE === "wallet";
const service = bootstrapMode ? undefined : new BotService();
let cachedBootstrap:
  | { request: WalletBootstrapRequest; envelope: WalletBootstrapEnvelope }
  | undefined;

function send(
  response: ServerResponse,
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(data, null, 2);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
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

function sameBootstrapRequest(left: WalletBootstrapRequest, right: WalletBootstrapRequest): boolean {
  return (
    left.version === right.version &&
    left.botId === right.botId &&
    left.sessionId === right.sessionId &&
    left.publicKeySpki === right.publicKeySpki &&
    left.publicKeyFingerprint === right.publicKeyFingerprint &&
    left.challenge === right.challenge
  );
}

async function handleBootstrap(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { action } = actionOf(request);
  const method = request.method?.toUpperCase() ?? "GET";
  const botId = process.env.CASSIE_BOT_ID;
  const requiredRegion = process.env.CASSIE_REQUIRED_REGION;
  const region = process.env.CLOUDFLARE_REGION;
  if (!botId || !requiredRegion || !region) throw new Error("bootstrap container is missing its bound identity");
  if (region !== requiredRegion) throw new Error(`refusing bootstrap outside required region ${requiredRegion}`);

  if (method === "GET" && (action === "health" || action === "ping")) {
    send(response, { ok: true, mode: "wallet-bootstrap" }, 200, WALLET_BOOTSTRAP_NO_STORE_HEADERS);
    return;
  }
  if (method === "GET" && action === "runtime") {
    send(
      response,
      {
        runtime: "cloudflare-container-bootstrap",
        protocol: 1,
        botId,
        requiredRegion,
        region,
        location: process.env.CLOUDFLARE_LOCATION,
      },
      200,
      WALLET_BOOTSTRAP_NO_STORE_HEADERS,
    );
    return;
  }
  if (method === "POST" && action === "internal/bootstrap/wallet") {
    const parsed = parseWalletBootstrapRequest(await bodyJson<unknown>(request));
    if (parsed.botId !== botId) throw new Error("bootstrap request bot id does not match this container");
    if (cachedBootstrap && !sameBootstrapRequest(cachedBootstrap.request, parsed)) {
      send(response, { error: "container already generated a wallet for another bootstrap binding" }, 409, WALLET_BOOTSTRAP_NO_STORE_HEADERS);
      return;
    }
    cachedBootstrap ??= { request: parsed, envelope: createWalletBootstrapEnvelope(parsed) };
    send(response, cachedBootstrap.envelope, 200, WALLET_BOOTSTRAP_NO_STORE_HEADERS);
    return;
  }
  send(response, { error: `unknown bootstrap route ${method} ${request.url ?? "/"}` }, 404, WALLET_BOOTSTRAP_NO_STORE_HEADERS);
}

async function handleTrading(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!service) throw new Error("trading service is unavailable in bootstrap mode");
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
    const body = await bodyJson<{ tickId?: unknown }>(request);
    if (body.tickId !== undefined && (!Number.isSafeInteger(body.tickId) || Number(body.tickId) < 0)) {
      send(response, { error: "tickId must be a non-negative safe integer" }, 400);
      return;
    }
    send(response, await service.tick(body.tickId === undefined ? undefined : Number(body.tickId)));
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
  void (bootstrapMode ? handleBootstrap(request, response) : handleTrading(request, response)).catch((error) =>
    send(
      response,
      { error: (error as Error).message },
      500,
      bootstrapMode ? WALLET_BOOTSTRAP_NO_STORE_HEADERS : {},
    ),
  );
});

server.listen(8080, "0.0.0.0", () => {
  const botId = service?.config.id ?? process.env.CASSIE_BOT_ID ?? "bootstrap";
  console.log(`[${new Date().toISOString()}] [${botId}] INFO listening on :8080 (${bootstrapMode ? "wallet-bootstrap" : "trading"})`);
});

let signalHandled = false;
async function terminate(signal: string): Promise<void> {
  if (signalHandled) return;
  signalHandled = true;
  const botId = service?.config.id ?? process.env.CASSIE_BOT_ID ?? "bootstrap";
  console.log(`[${new Date().toISOString()}] [${botId}] INFO ${signal} received`);
  if (service) await service.shutdown(true).catch((error) => console.error(`shutdown failed: ${(error as Error).message}`));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 30_000).unref();
}

process.once("SIGTERM", () => void terminate("SIGTERM"));
process.once("SIGINT", () => void terminate("SIGINT"));

export { BotService } from "./service.js";
export * from "./bootstrap-wallet.js";
export { DurableObjectStateStore } from "./state.js";

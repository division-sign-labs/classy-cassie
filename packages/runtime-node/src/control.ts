// packages/runtime-node/src/control.ts
// Control API for a running bot, served on a unix domain socket. Reaching it
// means having a shell on the host, so the socket's file permissions are the
// whole authorization story — no token, no port, no TLS.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { LogLevel, ManualOrderParams } from "@quotient-forecasting/cassie-core";
import type { BotService } from "./service.js";

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

/** Tolerates both /bots/:botId/x and /x so callers can use either shape. */
function actionOf(request: IncomingMessage): { action: string; url: URL } {
  const url = new URL(request.url ?? "/", "http://cassie.local");
  const segments = url.pathname.split("/").filter(Boolean);
  const action = segments[0] === "bots" ? segments.slice(2).join("/") : segments.join("/");
  return { action, url };
}

export async function handle(service: BotService, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { action, url } = actionOf(request);
  const method = request.method?.toUpperCase() ?? "GET";

  if (method === "GET" && (action === "health" || action === "ping")) {
    send(response, { ok: true });
    return;
  }
  if (method === "GET" && (action === "runtime" || action === "status")) {
    send(response, { ...service.status(), paused: await service.paused() });
    return;
  }
  if (method === "GET" && action === "geoblock/check") {
    send(response, { ok: true, ...(await service.geoblockCheck()) });
    return;
  }
  if (method === "GET" && action === "venue/check") {
    send(response, { ok: true, ...(await service.venueAccessCheck()) });
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
  if (method === "GET" && action === "agent/check") {
    send(response, await service.agentCheck());
    return;
  }
  if (method === "GET" && action === "agent/status") {
    send(response, await service.agentStatus());
    return;
  }
  if (method === "POST" && action === "agent/dry-run") {
    send(response, await service.agentDryRun());
    return;
  }
  if (method === "GET" && action === "market-make/status") {
    send(response, service.marketMakeStatus());
    return;
  }
  if (method === "GET" && action === "market-make/snapshot") {
    send(response, service.marketMakeSnapshot());
    return;
  }
  if (method === "POST" && action === "market-make/dry-run") {
    send(response, await service.marketMakeDryRun());
    return;
  }
  if (method === "POST" && action === "market-make/halt") {
    const body = await bodyJson<{ liquidate?: unknown }>(request);
    if (body.liquidate !== undefined && typeof body.liquidate !== "boolean") {
      send(response, { error: "liquidate must be boolean" }, 400);
      return;
    }
    send(response, await service.marketMakeHalt({ liquidate: body.liquidate === true }));
    return;
  }
  if (method === "POST" && action === "market-make/resume") {
    const body = await bodyJson<{ acknowledgeLossReset?: unknown }>(request);
    if (body.acknowledgeLossReset !== undefined && typeof body.acknowledgeLossReset !== "boolean") {
      send(response, { error: "acknowledgeLossReset must be boolean" }, 400);
      return;
    }
    send(response, await service.marketMakeResume({ acknowledgeLossReset: body.acknowledgeLossReset === true }));
    return;
  }
  if (method === "POST" && action === "market-make/reconcile") {
    const body = await bodyJson<{ apply?: unknown; expectedProposalHash?: unknown }>(request);
    if (body.apply !== undefined && typeof body.apply !== "boolean") {
      send(response, { error: "apply must be boolean" }, 400);
      return;
    }
    if (
      body.expectedProposalHash !== undefined &&
      (typeof body.expectedProposalHash !== "string" || !/^[0-9a-f]{64}$/.test(body.expectedProposalHash))
    ) {
      send(response, { error: "expectedProposalHash must be a lowercase 64-character SHA-256 hex digest" }, 400);
      return;
    }
    if (body.apply === true && body.expectedProposalHash === undefined) {
      send(response, { error: "apply requires expectedProposalHash from an exact report-only preview" }, 400);
      return;
    }
    send(response, await service.marketMakeReconcile({
      apply: body.apply === true,
      ...(typeof body.expectedProposalHash === "string"
        ? { expectedProposalHash: body.expectedProposalHash }
        : {}),
    }));
    return;
  }
  if (method === "GET" && action === "logs") {
    const level = url.searchParams.get("level") as LogLevel | null;
    const rawTail = Number(url.searchParams.get("tail") ?? 100);
    send(response, await service.logs(level ?? undefined, Number.isFinite(rawTail) ? rawTail : 100));
    return;
  }
  if (method === "POST" && action === "orders/cancel") {
    if (service.config.strategy.id === "market-make") {
      send(
        response,
        { error: "generic order cancellation is disabled for market-make bots; use market-make halt and reconcile" },
        409,
      );
      return;
    }
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
    if (service.config.strategy.id === "market-make") {
      send(
        response,
        { error: "generic cancel-all is disabled for market-make bots; use market-make halt and reconcile" },
        409,
      );
      return;
    }
    await service.cancelAll();
    send(response, { ok: true, canceled: "all" });
    return;
  }
  if (method === "POST" && action === "trade") {
    if (service.config.strategy.id === "market-make") {
      send(
        response,
        { error: "manual orders are disabled for market-make bots; use a separate bot id" },
        409,
      );
      return;
    }
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
  if (method === "POST" && action === "init") {
    await service.start();
    const status = service.status();
    send(response, {
      ok: true,
      botId: status.botId,
      venue: service.config.venue,
      strategy: service.config.strategy.id,
      tickIntervalMin: status.tickIntervalMin,
      runtime: status.runtime,
      region: status.region,
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
  if (method === "POST" && action === "shutdown") {
    const result = await service.shutdown(true);
    if (!result.stopped || !result.restingOrdersCanceled) {
      throw new Error("shutdown did not verify that resting orders were canceled");
    }
    send(response, { ok: true, ...result });
    return;
  }
  send(response, { error: `unknown route ${method} ${url.pathname}` }, 404);
}

/** Bind the control API to a unix socket, replacing a stale one from a crash. */
export function serveControl(service: BotService, socketPath: string): Server {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o750 });
  rmSync(socketPath, { force: true });
  const server = createServer((request, response) => {
    void handle(service, request, response).catch((error) =>
      send(response, { error: (error as Error).message }, 500),
    );
  });
  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o660);
    service.log.info(`control socket ${socketPath}`);
  });
  return server;
}

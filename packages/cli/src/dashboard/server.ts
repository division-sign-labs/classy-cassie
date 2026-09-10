// packages/cli/src/dashboard/server.ts
// The local dashboard: the shared handler on 127.0.0.1, no password. A Host
// check keeps a page from another origin from reading positions through DNS
// rebinding.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { consoleLogger } from "@quotient-forecasting/cassie-core";
import { createDashboardHandler, type DashboardBotSource } from "@quotient-forecasting/cassie-runtime-node";

export interface LocalDashboardServerOptions {
  port: number;
  sources: DashboardBotSource & { refreshSeconds: number };
  host?: string;
}

export interface RunningLocalDashboard {
  url: string;
  port: number;
  close(): Promise<void>;
}

export function isAllowedHost(header: string | undefined, port: number): boolean {
  if (!header) return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(header.trim().toLowerCase());
}

export function startLocalDashboardServer(opts: LocalDashboardServerOptions): Promise<RunningLocalDashboard> {
  const host = opts.host ?? "127.0.0.1";
  let boundPort = opts.port;
  const handler = createDashboardHandler({
    mode: "local",
    bots: opts.sources,
    refreshSeconds: opts.sources.refreshSeconds,
    log: consoleLogger("dashboard", "warn"),
  });
  const server = createServer((request, response) => {
    if (!isAllowedHost(request.headers.host, boundPort)) {
      const body = JSON.stringify({ error: "forbidden host" });
      response.writeHead(403, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    handler(request, response);
  });
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new Error(`port ${opts.port} is in use; choose another with --port`) : error);
    });
    server.listen({ port: opts.port, host }, () => {
      boundPort = (server.address() as AddressInfo).port;
      resolve({
        url: `http://${host}:${boundPort}`,
        port: boundPort,
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

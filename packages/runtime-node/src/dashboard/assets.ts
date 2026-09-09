// packages/runtime-node/src/dashboard/assets.ts
// The three static files the dashboard is made of, read from ./ui next to this
// module (src in tests, dist once built), and the headers every response carries.

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

const CONTENT_TYPES = {
  "index.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "app.css": "text/css; charset=utf-8",
} as const;

export type DashboardAssetName = keyof typeof CONTENT_TYPES;

export const DASHBOARD_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";

export function dashboardAsset(name: DashboardAssetName): { body: Buffer; contentType: string } {
  const contentType = CONTENT_TYPES[name];
  if (!contentType) throw new Error(`unknown dashboard asset ${String(name)}`);
  return { body: readFileSync(new URL(`./ui/${name}`, import.meta.url)), contentType };
}

export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("content-security-policy", DASHBOARD_CSP);
}

function assetFor(pathname: string): DashboardAssetName | undefined {
  if (pathname === "/" || pathname === "/index.html") return "index.html";
  if (pathname === "/app.js") return "app.js";
  if (pathname === "/app.css") return "app.css";
  return undefined;
}

/** Serve one of the three assets; false when the request is not for one. */
export function serveStatic(request: IncomingMessage, response: ServerResponse): boolean {
  const method = request.method?.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const name = assetFor(new URL(request.url ?? "/", "http://dashboard.local").pathname);
  if (!name) return false;
  const asset = dashboardAsset(name);
  applySecurityHeaders(response);
  response.writeHead(200, { "content-type": asset.contentType, "content-length": asset.body.length });
  if (method === "HEAD") response.end();
  else response.end(asset.body);
  return true;
}

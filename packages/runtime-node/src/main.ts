#!/usr/bin/env node
// packages/runtime-node/src/main.ts
// Process entry point for a deployed bot. systemd starts this with
// EnvironmentFile=/etc/cassie/<botId>.env and stops it with SIGTERM, which
// cancels resting orders before exit.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBotConfig, consoleLogger, type RuntimeCreds } from "@quotient-forecasting/cassie-core";
import { BotService } from "./service.js";
import { serveControl } from "./control.js";
import { requireRegion } from "./region.js";

/** The installed package's own version, so `--version` reports what is running. */
function version(): string {
  try {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
    return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
  } catch {
    return process.env.CASSIE_RUNTIME_VERSION ?? "unknown";
  }
}

const VERSION = version();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

async function main(): Promise<void> {
  // `cassie deploy` reads this to decide whether a redeploy needs to move the
  // droplet's runtime forward.
  if (process.argv.includes("--version")) {
    console.log(VERSION);
    return;
  }

  const botId = required("CASSIE_BOT_ID");
  const log = consoleLogger(botId);
  const config = parseBotConfig(JSON.parse(required("CASSIE_BOT_CONFIG")));
  if (config.id !== botId) throw new Error(`bot id mismatch: ${config.id} != ${botId}`);
  if (!config.account) throw new Error(`bot ${botId} has no venue account configured`);
  const creds = JSON.parse(required("CASSIE_BOT_CREDS")) as RuntimeCreds;

  const requiredRegion = required("CASSIE_REQUIRED_REGION");
  const region = await requireRegion(requiredRegion);
  log.info(`region ${region} confirmed by droplet metadata`);

  const service = new BotService({
    config,
    account: config.account,
    creds,
    statePath: process.env.CASSIE_STATE_PATH ?? `/var/lib/cassie/${botId}.sqlite`,
    runtime: "droplet",
    requiredRegion,
    region,
    version: VERSION,
    quotientToken: required("QUOTIENT_API_TOKEN"),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    reportingApiKey: process.env.ARES_API_KEY,
    log,
  });

  const server = serveControl(service, process.env.CASSIE_CONTROL_SOCKET ?? `/run/cassie/${botId}.sock`);

  // The deploy calls POST /init once it has verified region, geoblock, signals,
  // and reporting. A restart after that should come back trading on its own.
  if (process.env.CASSIE_AUTOSTART !== "0") {
    await service.start().catch((error) => log.error(`autostart failed: ${(error as Error).message}`));
  }

  let terminating = false;
  const terminate = async (signal: string): Promise<void> => {
    if (terminating) return;
    terminating = true;
    log.info(`${signal} received`);
    await service.shutdown(true).catch((error) => log.error(`shutdown failed: ${(error as Error).message}`));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 30_000).unref();
  };
  process.once("SIGTERM", () => void terminate("SIGTERM"));
  process.once("SIGINT", () => void terminate("SIGINT"));
}

main().catch((error) => {
  console.error(`[${new Date().toISOString()}] FATAL ${(error as Error).message}`);
  process.exit(1);
});

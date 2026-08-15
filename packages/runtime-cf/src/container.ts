// packages/runtime-cf/src/container.ts
// Cloudflare control plane for one persistent BotAgent Container per bot. The
// Worker authenticates and routes; every venue/signal/trading call runs inside
// the Container, whose deployment is hard-constrained to EEUR in wrangler.jsonc.

import {
  Container,
  getContainer,
  type OutboundHandler,
  type OutboundHandlerContext,
  type StopParams,
} from "@cloudflare/containers";
import type { ErrorRecord, LogLevel, LogQuery } from "@quotient-forecasting/cassie-core";
import type { TickScheduler } from "./tick-scheduler.js";
import { tickIntervalSeconds } from "./tick-schedule.js";

export { ContainerProxy } from "@cloudflare/containers";

export interface Env {
  BotAgent: DurableObjectNamespace<BotAgent>;
  TickScheduler: DurableObjectNamespace<TickScheduler>;
  CONTROL_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  ARES_API_KEY?: string;
  QUOTIENT_API_TOKEN?: string;
  [key: string]: unknown;
}

interface RuntimeBundleInput {
  botId: string;
  config: string;
  creds: string;
  quotientToken: string;
  telegramToken?: string;
  aresApiKey?: string;
}

interface RuntimeBundle extends RuntimeBundleInput {
  fingerprint: string;
}

type StateOperation =
  | { op: "get"; key: string }
  | { op: "set"; key: string; value: string }
  | { op: "delete"; key: string }
  | { op: "append-error"; record: ErrorRecord }
  | { op: "read-errors"; query?: LogQuery };

type ErrorRow = Record<string, SqlStorageValue> & {
  ts: number;
  level: string;
  code: string;
  venue: string | null;
  message: string;
  context: string | null;
  tick_seq: number | null;
};

const ACTIVE_KEY = "cassie:container-active";
const BOT_ID_KEY = "cassie:container-bot-id";
const REQUIRED_REGION = "EEUR";
const PORT = 8080;

function secretSegment(botId: string): string {
  return botId.toUpperCase().replace(/-/g, "_");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sameSecret(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.CONTROL_TOKEN) return false;
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return sameSecret(env.CONTROL_TOKEN, presented);
}

async function runtimeFingerprint(bundle: RuntimeBundleInput): Promise<string> {
  return sha256(
    [
      "cassie-container-protocol-1",
      bundle.botId,
      bundle.config,
      bundle.creds,
      bundle.quotientToken,
      bundle.telegramToken ?? "",
      bundle.aresApiKey ?? "",
    ].join("\u0000"),
  );
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BotAgent extends Container<Env> {
  defaultPort = PORT;
  requiredPorts = [PORT];
  sleepAfter = "10m";
  enableInternet = true;
  pingEndpoint = "localhost/health";

  private runtimeBundle?: RuntimeBundle;
  private stateTablesReady = false;

  async configureRuntime(input: RuntimeBundleInput): Promise<void> {
    this.runtimeBundle = { ...input, fingerprint: await runtimeFingerprint(input) };
    await this.ctx.storage.put(BOT_ID_KEY, input.botId);
  }

  private async loadRuntimeBundle(): Promise<RuntimeBundle> {
    if (this.runtimeBundle) return this.runtimeBundle;
    const botId = await this.ctx.storage.get<string>(BOT_ID_KEY);
    if (!botId) throw new Error("container has not been configured for a bot");
    const secret = secretSegment(botId);
    const config = this.env[`BOT_${secret}_CONFIG`];
    const creds = this.env[`BOT_${secret}_CREDS`];
    const quotientToken = this.env.QUOTIENT_API_TOKEN;
    if (typeof config !== "string" || typeof creds !== "string" || typeof quotientToken !== "string") {
      throw new Error(`missing runtime secrets for bot ${botId}`);
    }
    const input: RuntimeBundleInput = {
      botId,
      config,
      creds,
      quotientToken,
      telegramToken: typeof this.env.TELEGRAM_BOT_TOKEN === "string" ? this.env.TELEGRAM_BOT_TOKEN : undefined,
      aresApiKey: typeof this.env.ARES_API_KEY === "string" ? this.env.ARES_API_KEY : undefined,
    };
    this.runtimeBundle = { ...input, fingerprint: await runtimeFingerprint(input) };
    return this.runtimeBundle;
  }

  private startEnvVars(bundle: RuntimeBundle): Record<string, string> {
    return {
      CASSIE_BOT_ID: bundle.botId,
      CASSIE_BOT_CONFIG: bundle.config,
      CASSIE_BOT_CREDS: bundle.creds,
      CASSIE_REQUIRED_REGION: REQUIRED_REGION,
      CASSIE_RUNTIME_FINGERPRINT: bundle.fingerprint,
      QUOTIENT_API_TOKEN: bundle.quotientToken,
      ...(bundle.telegramToken ? { TELEGRAM_BOT_TOKEN: bundle.telegramToken } : {}),
      ...(bundle.aresApiKey ? { ARES_API_KEY: bundle.aresApiKey } : {}),
    };
  }

  private async runningFingerprint(): Promise<string | null> {
    try {
      const response = await this.containerFetch("http://localhost/runtime");
      if (!response.ok) return null;
      const body = (await response.json()) as { runtimeFingerprint?: unknown };
      return typeof body.runtimeFingerprint === "string" ? body.runtimeFingerprint : null;
    } catch {
      return null;
    }
  }

  private async ensureStarted(): Promise<void> {
    const bundle = await this.loadRuntimeBundle();
    const state = await this.getState();
    if (state.status === "healthy" && (await this.runningFingerprint()) === bundle.fingerprint) return;

    if (state.status === "healthy" || state.status === "running") {
      if (state.status === "healthy") {
        await this.containerFetch("http://localhost/internal/shutdown", { method: "POST" }).catch(() => undefined);
      }
      await this.stop();
    }

    await this.startAndWaitForPorts({
      ports: PORT,
      startOptions: { envVars: this.startEnvVars(bundle), enableInternet: true },
      cancellationOptions: { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 120_000 },
    });
    const actual = await this.runningFingerprint();
    if (actual !== bundle.fingerprint) throw new Error("container started with stale runtime configuration");
  }

  private scheduler(botId: string): DurableObjectStub<TickScheduler> {
    return this.env.TickScheduler.getByName(botId);
  }

  /** Drain alarms persisted by the superseded same-object scheduler. */
  async runScheduledTick(): Promise<void> {
    this.deleteSchedules("runScheduledTick");
  }

  override async onStart(): Promise<void> {
    if ((await this.ctx.storage.get<boolean>(ACTIVE_KEY)) === true) {
      const response = await this.containerFetch("http://localhost/internal/autostart", { method: "POST" });
      if (!response.ok) throw new Error(`container autostart failed: ${response.status}`);
    }
  }

  override async onActivityExpired(): Promise<void> {
    // A trading bot with an active loop must keep its heartbeat and trigger
    // timers alive. Returning without stop renews the inactivity timer.
    if ((await this.ctx.storage.get<boolean>(ACTIVE_KEY)) === true) return;
    await this.stop();
  }

  override onStop(params: StopParams): void {
    console.log("cassie container stopped", params);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const action = segments.slice(2).join("/");

    await this.ensureStarted();

    const headers = new Headers(request.headers);
    headers.delete("authorization");
    const forwarded = new Request(request, { headers });
    const response = await this.containerFetch(forwarded);

    if (request.method === "POST" && action === "init" && response.ok) {
      const bundle = await this.loadRuntimeBundle();
      try {
        await this.scheduler(bundle.botId).start(bundle.botId, tickIntervalSeconds(bundle.config));
        await this.ctx.storage.put(ACTIVE_KEY, true);
      } catch (error) {
        await this.scheduler(bundle.botId).stop().catch(() => undefined);
        await this.ctx.storage.put(ACTIVE_KEY, false);
        throw error;
      }
    }

    if (request.method === "POST" && action === "shutdown" && response.ok) {
      const body = await response.arrayBuffer();
      await this.ctx.storage.put(ACTIVE_KEY, false);
      await this.scheduler((await this.loadRuntimeBundle()).botId).stop();
      await this.stop();
      return new Response(body, { status: response.status, headers: response.headers });
    }
    return response;
  }

  private ensureStateTables(): void {
    if (this.stateTablesReady) return;
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS cassie_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cassie_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      level TEXT NOT NULL,
      code TEXT NOT NULL,
      venue TEXT,
      message TEXT NOT NULL,
      context TEXT,
      tick_seq INTEGER
    )`);
    this.stateTablesReady = true;
  }

  /** RPC target used only by the virtual cassie.state outbound handler. */
  async stateRequest(request: Request): Promise<Response> {
    this.ensureStateTables();
    let operation: StateOperation;
    try {
      operation = (await request.json()) as StateOperation;
    } catch {
      return json({ error: "invalid state request" }, 400);
    }

    switch (operation.op) {
      case "get": {
        const rows = [...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM cassie_kv WHERE key = ?", operation.key)];
        return json({ value: rows[0]?.value ?? null });
      }
      case "set":
        this.ctx.storage.sql.exec(
          "INSERT INTO cassie_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          operation.key,
          operation.value,
        );
        return json({ ok: true });
      case "delete":
        this.ctx.storage.sql.exec("DELETE FROM cassie_kv WHERE key = ?", operation.key);
        return json({ ok: true });
      case "append-error": {
        const record = operation.record;
        this.ctx.storage.sql.exec(
          "INSERT INTO cassie_errors (ts, level, code, venue, message, context, tick_seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
          record.ts,
          record.level,
          record.code,
          record.venue ?? null,
          record.message,
          record.context === undefined ? null : JSON.stringify(record.context),
          record.tickSeq ?? null,
        );
        return json({ ok: true });
      }
      case "read-errors": {
        const tail = Math.min(Math.max(operation.query?.tail ?? 100, 1), 1_000);
        const level = operation.query?.level;
        const rows = level
          ? [...this.ctx.storage.sql.exec<ErrorRow>("SELECT * FROM cassie_errors WHERE level = ? ORDER BY ts DESC LIMIT ?", level, tail)]
          : [...this.ctx.storage.sql.exec<ErrorRow>("SELECT * FROM cassie_errors ORDER BY ts DESC LIMIT ?", tail)];
        const errors: ErrorRecord[] = rows.reverse().map((row) => ({
          ts: row.ts,
          level: row.level as LogLevel,
          code: row.code,
          venue: (row.venue ?? undefined) as ErrorRecord["venue"],
          message: row.message,
          context: row.context ? (JSON.parse(row.context) as Record<string, unknown>) : undefined,
          tickSeq: row.tick_seq ?? undefined,
        }));
        return json({ errors });
      }
      default:
        return json({ error: "unknown state operation" }, 400);
    }
  }
}

const stateOutbound: OutboundHandler<Env> = async (
  request: Request,
  env: Env,
  context: OutboundHandlerContext,
): Promise<Response> => {
  const id = env.BotAgent.idFromString(context.containerId);
  return env.BotAgent.get(id).stateRequest(request);
};

BotAgent.outboundByHost = { "cassie.state": stateOutbound };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "bots" || !segments[1]) {
      return json({ error: "routes live under /bots/:botId/..." }, 404);
    }
    const botId = segments[1];
    if (!(await authorized(request, env))) return json({ error: "missing or invalid control token" }, 401);
    const secret = secretSegment(botId);
    const config = env[`BOT_${secret}_CONFIG`];
    const creds = env[`BOT_${secret}_CREDS`];
    const quotientToken = env.QUOTIENT_API_TOKEN;
    if (typeof config !== "string" || typeof creds !== "string" || typeof quotientToken !== "string") {
      return json({ error: `missing runtime secrets for bot ${botId} — run \`cassie deploy\`` }, 503);
    }

    try {
      const container = getContainer<BotAgent>(env.BotAgent, botId);
      await container.configureRuntime({
        botId,
        config,
        creds,
        quotientToken,
        telegramToken: typeof env.TELEGRAM_BOT_TOKEN === "string" ? env.TELEGRAM_BOT_TOKEN : undefined,
        aresApiKey: typeof env.ARES_API_KEY === "string" ? env.ARES_API_KEY : undefined,
      });
      return await container.fetch(request);
    } catch (error) {
      console.error(`container control error: ${safeError(error)}`);
      return json({ error: safeError(error) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

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
import {
  abortBootstrapState,
  acknowledgeBootstrapState,
  bootstrapPublicStatus,
  BootstrapParseError,
  BootstrapTransitionError,
  createBootstrapState,
  parseBootstrapBinding,
  parseBootstrapState,
  type BootstrapBinding,
  type BootstrapState,
} from "./bootstrap-state.js";
import type { TickScheduler } from "./tick-scheduler.js";
import { tickIntervalSeconds } from "./tick-schedule.js";

export { ContainerProxy } from "@cloudflare/containers";

export interface Env {
  BotAgent: DurableObjectNamespace<BotAgent>;
  TickScheduler: DurableObjectNamespace<TickScheduler>;
  CONTROL_TOKEN?: string;
  BOOTSTRAP_TOKEN?: string;
  BOOTSTRAP_BOT_ID?: string;
  BOOTSTRAP_SESSION_ID?: string;
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
const BOOTSTRAP_STATE_KEY = "cassie:wallet-bootstrap-state";
const BOOTSTRAP_GENERATING_KEY = "cassie:wallet-bootstrap-generating";
const BOOTSTRAP_LOCK_MAX_AGE_MS = 5 * 60_000;
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

function bootstrapJson(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const response = json(data, status);
  response.headers.set("cache-control", "no-store, max-age=0");
  response.headers.set("pragma", "no-cache");
  for (const [name, value] of Object.entries(extraHeaders)) response.headers.set(name, value);
  return response;
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

async function authorizedWith(request: Request, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return sameSecret(expected, presented);
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  return authorizedWith(request, env.CONTROL_TOKEN);
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

function bootstrapError(error: unknown): Response {
  if (error instanceof BootstrapTransitionError || error instanceof BootstrapParseError) {
    return bootstrapJson({ error: error.message, code: error.code }, error.status);
  }
  return bootstrapJson({ error: safeError(error) }, 500);
}

interface BootstrapRequestBody extends BootstrapBinding {
  version: 1;
  publicKeySpki: string;
}

interface BootstrapGeneratingLock extends BootstrapBinding {
  operationId: string;
  startedAt: number;
}

type BootstrapGenerationClaim =
  | { kind: "ready"; state: BootstrapState }
  | { kind: "busy" }
  | { kind: "claimed"; lock: BootstrapGeneratingLock };

function parseBootstrapRequestBody(value: unknown, env: Env): BootstrapRequestBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BootstrapParseError("invalid bootstrap request");
  const object = value as Record<string, unknown>;
  const expectedKeys = ["botId", "challenge", "publicKeyFingerprint", "publicKeySpki", "sessionId", "version"];
  if (Object.keys(object).sort().join("\0") !== expectedKeys.sort().join("\0") || object.version !== 1) {
    throw new BootstrapParseError("invalid bootstrap request");
  }
  const binding = parseBootstrapBinding({
    botId: object.botId,
    sessionId: object.sessionId,
    publicKeyFingerprint: object.publicKeyFingerprint,
    challenge: object.challenge,
  });
  if (binding.botId !== env.BOOTSTRAP_BOT_ID || binding.sessionId !== env.BOOTSTRAP_SESSION_ID) {
    throw new BootstrapTransitionError("bootstrap-conflict", 409, "bootstrap request does not match the deployed session");
  }
  if (typeof object.publicKeySpki !== "string" || object.publicKeySpki.length < 400 || object.publicKeySpki.length > 1_000) {
    throw new BootstrapParseError("invalid bootstrap recipient public key");
  }
  return { version: 1, ...binding, publicKeySpki: object.publicKeySpki };
}

function sameBootstrapBinding(left: BootstrapBinding, right: BootstrapBinding): boolean {
  return (
    left.botId === right.botId &&
    left.sessionId === right.sessionId &&
    left.publicKeyFingerprint === right.publicKeyFingerprint &&
    left.challenge === right.challenge
  );
}

function parseBootstrapGeneratingLock(value: unknown): BootstrapGeneratingLock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).sort().join("\0") !==
      ["botId", "challenge", "operationId", "publicKeyFingerprint", "sessionId", "startedAt"].sort().join("\0") ||
    typeof object.operationId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(object.operationId) ||
    typeof object.startedAt !== "number" ||
    !Number.isSafeInteger(object.startedAt) ||
    object.startedAt <= 0
  ) {
    return null;
  }
  try {
    return {
      ...parseBootstrapBinding({
        botId: object.botId,
        sessionId: object.sessionId,
        publicKeyFingerprint: object.publicKeyFingerprint,
        challenge: object.challenge,
      }),
      operationId: object.operationId,
      startedAt: object.startedAt,
    };
  } catch {
    return null;
  }
}

export class BotAgent extends Container<Env> {
  defaultPort = PORT;
  requiredPorts = [PORT];
  sleepAfter = "10m";
  enableInternet = true;
  pingEndpoint = "localhost/health";

  private runtimeBundle?: RuntimeBundle;
  private stateTablesReady = false;

  private async storedBootstrapState(): Promise<BootstrapState> {
    return parseBootstrapState(await this.ctx.storage.get(BOOTSTRAP_STATE_KEY));
  }

  private async stopBootstrapContainer(): Promise<void> {
    const state = await this.getState();
    if (state.status === "running" || state.status === "healthy") await this.stop();
  }

  private bootstrapContainerFetch(url: string, init?: RequestInit, timeoutMs = 30_000): Promise<Response> {
    return this.containerFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }

  private async startBootstrapContainer(): Promise<void> {
    await this.stopBootstrapContainer();
    await this.startAndWaitForPorts({
      ports: PORT,
      startOptions: {
        envVars: {
          CASSIE_BOOTSTRAP_MODE: "wallet",
          CASSIE_BOT_ID: String(this.env.BOOTSTRAP_BOT_ID),
          CASSIE_REQUIRED_REGION: REQUIRED_REGION,
        },
        enableInternet: false,
      },
      cancellationOptions: { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 120_000 },
    });
    const runtime = await this.bootstrapContainerFetch("http://localhost/runtime", undefined, 15_000);
    const identity = (await runtime.json().catch(() => null)) as {
      runtime?: unknown;
      botId?: unknown;
      requiredRegion?: unknown;
      region?: unknown;
    } | null;
    if (
      !runtime.ok ||
      identity?.runtime !== "cloudflare-container-bootstrap" ||
      identity.botId !== this.env.BOOTSTRAP_BOT_ID ||
      identity.requiredRegion !== REQUIRED_REGION ||
      identity.region !== REQUIRED_REGION
    ) {
      await this.stop();
      throw new Error("bootstrap Container identity or region verification failed");
    }
  }

  private async bootstrapStatus(): Promise<Response> {
    return bootstrapJson(bootstrapPublicStatus(await this.storedBootstrapState()));
  }

  private async claimBootstrapGeneration(input: BootstrapRequestBody): Promise<BootstrapGenerationClaim> {
    const now = Date.now();
    const lock: BootstrapGeneratingLock = {
      botId: input.botId,
      sessionId: input.sessionId,
      publicKeyFingerprint: input.publicKeyFingerprint,
      challenge: input.challenge,
      operationId: crypto.randomUUID(),
      startedAt: now,
    };
    return this.ctx.storage.transaction(async (transaction) => {
      const current = parseBootstrapState(await transaction.get(BOOTSTRAP_STATE_KEY));
      if (current.status === "acknowledged") {
        throw new BootstrapTransitionError("bootstrap-gone", 410, "wallet bootstrap envelope has been consumed");
      }
      if (current.status === "envelope-ready") {
        if (!sameBootstrapBinding(current, input)) {
          throw new BootstrapTransitionError(
            "bootstrap-conflict",
            409,
            "a different wallet bootstrap session is already active",
          );
        }
        return { kind: "ready", state: current };
      }

      const existing = parseBootstrapGeneratingLock(await transaction.get(BOOTSTRAP_GENERATING_KEY));
      if (existing && now - existing.startedAt < BOOTSTRAP_LOCK_MAX_AGE_MS) {
        if (!sameBootstrapBinding(existing, input)) {
          throw new BootstrapTransitionError(
            "bootstrap-conflict",
            409,
            "another wallet bootstrap is being generated",
          );
        }
        return { kind: "busy" };
      }
      await transaction.put(BOOTSTRAP_GENERATING_KEY, lock);
      return { kind: "claimed", lock };
    });
  }

  private async commitBootstrapGeneration(
    lock: BootstrapGeneratingLock,
    input: BootstrapRequestBody,
    envelope: unknown,
  ): Promise<BootstrapState> {
    return this.ctx.storage.transaction(async (transaction) => {
      const current = parseBootstrapState(await transaction.get(BOOTSTRAP_STATE_KEY));
      if (current.status === "envelope-ready") {
        if (!sameBootstrapBinding(current, input)) {
          throw new BootstrapTransitionError(
            "bootstrap-conflict",
            409,
            "a different wallet bootstrap session is already active",
          );
        }
        return current;
      }
      if (current.status === "acknowledged") {
        throw new BootstrapTransitionError("bootstrap-gone", 410, "wallet bootstrap envelope has been consumed");
      }
      const owner = parseBootstrapGeneratingLock(await transaction.get(BOOTSTRAP_GENERATING_KEY));
      if (!owner || owner.operationId !== lock.operationId) {
        throw new BootstrapTransitionError(
          "bootstrap-conflict",
          409,
          "wallet bootstrap generation ownership changed before commit",
        );
      }
      const transition = await createBootstrapState(current, {
        botId: input.botId,
        sessionId: input.sessionId,
        publicKeyFingerprint: input.publicKeyFingerprint,
        challenge: input.challenge,
        envelope,
      });
      await transaction.put(BOOTSTRAP_STATE_KEY, transition.state);
      await transaction.delete(BOOTSTRAP_GENERATING_KEY);
      return transition.state;
    });
  }

  private async releaseBootstrapGeneration(lock: BootstrapGeneratingLock): Promise<boolean> {
    return this.ctx.storage.transaction(async (transaction) => {
      const owner = parseBootstrapGeneratingLock(await transaction.get(BOOTSTRAP_GENERATING_KEY));
      if (!owner || owner.operationId !== lock.operationId) return false;
      await transaction.delete(BOOTSTRAP_GENERATING_KEY);
      return true;
    });
  }

  private async bootstrapWallet(request: Request): Promise<Response> {
    const input = parseBootstrapRequestBody(await request.json(), this.env);
    const claim = await this.claimBootstrapGeneration(input);
    if (claim.kind === "ready") return bootstrapJson(bootstrapPublicStatus(claim.state));
    if (claim.kind === "busy") {
      return bootstrapJson({ error: "wallet bootstrap generation is already in progress" }, 503, { "retry-after": "3" });
    }

    let committed = false;
    try {
      await this.startBootstrapContainer();
      const generated = await this.bootstrapContainerFetch("http://localhost/internal/bootstrap/wallet", {
        method: "POST",
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify(input),
      }, 45_000);
      const text = await generated.text();
      if (!generated.ok) throw new Error(`bootstrap Container generation failed (${generated.status}): ${text.slice(0, 300)}`);
      const envelope = JSON.parse(text) as unknown;
      const state = await this.commitBootstrapGeneration(claim.lock, input, envelope);
      committed = true;
      return bootstrapJson(bootstrapPublicStatus(state));
    } finally {
      const released = await this.releaseBootstrapGeneration(claim.lock).catch(() => false);
      // A stale request must never stop the Container owned by its replacement.
      if (committed || released) await this.stopBootstrapContainer().catch(() => undefined);
    }
  }

  private async bootstrapAcknowledge(request: Request): Promise<Response> {
    const input = await request.json();
    const transition = await this.ctx.storage.transaction(async (transaction) => {
      const next = await acknowledgeBootstrapState(await transaction.get(BOOTSTRAP_STATE_KEY), input);
      await transaction.put(BOOTSTRAP_STATE_KEY, next.state);
      await transaction.delete(BOOTSTRAP_GENERATING_KEY);
      return next;
    });
    await this.stopBootstrapContainer();
    return bootstrapJson(bootstrapPublicStatus(transition.state));
  }

  private async bootstrapAbort(request: Request): Promise<Response> {
    const input = await request.json();
    const transition = await this.ctx.storage.transaction(async (transaction) => {
      const next = abortBootstrapState(await transaction.get(BOOTSTRAP_STATE_KEY), input);
      await transaction.delete(BOOTSTRAP_STATE_KEY);
      await transaction.delete(BOOTSTRAP_GENERATING_KEY);
      return next;
    });
    await this.ctx.storage.deleteAll();
    await this.stopBootstrapContainer();
    return bootstrapJson(bootstrapPublicStatus(transition.state));
  }

  private async bootstrapPurge(request: Request): Promise<Response> {
    const binding = parseBootstrapBinding(await request.json());
    if (binding.botId !== this.env.BOOTSTRAP_BOT_ID || binding.sessionId !== this.env.BOOTSTRAP_SESSION_ID) {
      throw new BootstrapTransitionError("bootstrap-conflict", 409, "bootstrap purge does not match the deployed session");
    }
    await this.ctx.storage.transaction(async (transaction) => {
      const current = parseBootstrapState(await transaction.get(BOOTSTRAP_STATE_KEY));
      if (current.status === "envelope-ready") {
        throw new BootstrapTransitionError(
          "bootstrap-conflict",
          409,
          "wallet bootstrap envelope must be acknowledged or aborted before purge",
        );
      }
      if (current.status === "acknowledged" && !sameBootstrapBinding(current, binding)) {
        throw new BootstrapTransitionError("bootstrap-conflict", 409, "bootstrap purge does not match the consumed session");
      }
      await transaction.delete(BOOTSTRAP_STATE_KEY);
      await transaction.delete(BOOTSTRAP_GENERATING_KEY);
    });
    await this.ctx.storage.deleteAll();
    await this.stopBootstrapContainer();
    return bootstrapJson({ version: 1, status: "purged" });
  }

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

    if (action.startsWith("bootstrap/")) {
      try {
        if (request.method === "GET" && action === "bootstrap/status") return this.bootstrapStatus();
        if (request.method === "POST" && action === "bootstrap/wallet") return this.bootstrapWallet(request);
        if (request.method === "POST" && action === "bootstrap/ack") return this.bootstrapAcknowledge(request);
        if (request.method === "POST" && action === "bootstrap/abort") return this.bootstrapAbort(request);
        if (request.method === "POST" && action === "bootstrap/purge") return this.bootstrapPurge(request);
        return bootstrapJson({ error: `unknown bootstrap route ${request.method} ${url.pathname}` }, 404);
      } catch (error) {
        return bootstrapError(error);
      }
    }

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
    const action = segments.slice(2).join("/");

    if (action.startsWith("bootstrap/")) {
      if (!(await authorizedWith(request, env.BOOTSTRAP_TOKEN))) {
        return bootstrapJson({ error: "missing or invalid bootstrap token" }, 401);
      }
      if (!env.BOOTSTRAP_BOT_ID || !env.BOOTSTRAP_SESSION_ID) {
        return bootstrapJson({ error: "bootstrap deployment is not configured" }, 503);
      }
      if (botId !== env.BOOTSTRAP_BOT_ID) return bootstrapJson({ error: "bootstrap bot id mismatch" }, 404);
      if (request.headers.get("content-length") && Number(request.headers.get("content-length")) > 16_384) {
        return bootstrapJson({ error: "bootstrap request body too large" }, 413);
      }
      try {
        return await getContainer<BotAgent>(env.BotAgent, botId).fetch(request);
      } catch (error) {
        console.error(`bootstrap control error: ${safeError(error)}`);
        return bootstrapError(error);
      }
    }

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

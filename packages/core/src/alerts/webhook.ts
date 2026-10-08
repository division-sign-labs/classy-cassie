// packages/core/src/alerts/webhook.ts
// Posts each alert to an operator-configured URL. Delivery is in order, off the
// tick path, bounded, and never throws: an unreachable endpoint cannot delay a
// fill or fail a tick. With a secret, each request carries an HMAC-SHA256
// signature over `${timestamp}.${body}` so the receiver can verify it.

import { createHash, createHmac, randomUUID } from "node:crypto";
import type { AlertEvent, AlertKind, Alerter, Logger } from "../types.js";
import { boundFetch } from "../http.js";
import { alertHeadline, formatAlertText } from "./format.js";

export type WebhookFormat = "json" | "slack" | "discord";
export const WEBHOOK_FORMATS: readonly WebhookFormat[] = ["json", "slack", "discord"];
export const WEBHOOK_PAYLOAD_VERSION = 1;
const DISCORD_MAX = 1900;
const DEFAULT_DELAYS_MS = [1_000, 4_000];
const ATTEMPTS = 3;

export interface WebhookAlerterOptions {
  url: string;
  secret?: string;
  format?: WebhookFormat;
  /** Kinds to deliver; default every kind. */
  kinds?: readonly AlertKind[];
  /** Runtime version for the user-agent. */
  version?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
  maxQueue?: number;
  timeoutMs?: number;
  /** Delay before each retry; the last value repeats. */
  retryDelaysMs?: number[];
}

export interface WebhookFlushResult {
  sent: number;
  failed: number;
  dropped: number;
  lastError?: string;
}

interface Pending {
  id: string;
  kind: AlertKind;
  botId: string;
  body: string;
}

/**
 * Stable per emission, so a receiver can drop repeats:
 * `${botId}:${kind}:${key}:${at}`. The key is the most specific id the event
 * carries: settlement, fill, order, error fingerprint, else a content hash.
 */
export function webhookEventId(event: AlertEvent, at: string): string {
  const data = event.data ?? {};
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);
  const settlement = str(data.settlementId);
  const fill = str(data.fillId);
  const order = event.trade?.orderId ?? str(data.orderId);
  const fingerprint = str(data.fingerprint);
  const key = settlement
    ? `settlement:${settlement}`
    : fill
    ? `fill:${fill}`
    : order
    ? `order:${order}`
    : fingerprint
    // Error fingerprints carry raw error text; hash it so the id is always a valid header value.
    ? `fp:${createHash("sha256").update(fingerprint).digest("hex").slice(0, 16)}`
    : createHash("sha256").update(`${event.kind}|${event.message}|${at}`).digest("hex").slice(0, 16);
  return `${event.botId}:${event.kind}:${key}:${at}`;
}

function snakeMarket(m: NonNullable<AlertEvent["market"]>): Record<string, unknown> {
  const { tokenId, conditionId, ...market } = m;
  return {
    ...market,
    ...(tokenId !== undefined ? { token_id: tokenId } : {}),
    ...(conditionId !== undefined ? { condition_id: conditionId } : {}),
  };
}

function snakeTrade(t: NonNullable<AlertEvent["trade"]>): Record<string, unknown> {
  return {
    side: t.side,
    size: t.size,
    price: t.price,
    ...(t.notionalUsd !== undefined ? { notional_usd: t.notionalUsd } : {}),
    ...(t.feeUsd !== undefined ? { fee_usd: t.feeUsd } : {}),
    ...(t.orderId !== undefined ? { order_id: t.orderId } : {}),
    ...(t.maker !== undefined ? { maker: t.maker } : {}),
    ...(t.positionSide !== undefined ? { position_side: t.positionSide } : {}),
    ...(t.filled !== undefined ? { filled: t.filled } : {}),
  };
}

export function buildWebhookPayload(
  event: AlertEvent,
  format: WebhookFormat,
  now: () => number = Date.now,
): { id: string; body: string } {
  const at = event.at ?? new Date(now()).toISOString();
  const id = webhookEventId(event, at);
  if (format === "slack") return { id, body: JSON.stringify({ text: formatAlertText(event) }) };
  if (format === "discord") {
    const text = formatAlertText(event);
    return { id, body: JSON.stringify({ content: text.length > DISCORD_MAX ? `${text.slice(0, DISCORD_MAX - 1)}…` : text }) };
  }
  const payload = {
    version: WEBHOOK_PAYLOAD_VERSION,
    id,
    kind: event.kind,
    at,
    bot_id: event.botId,
    ...(event.venue ? { venue: event.venue } : {}),
    ...(event.strategy ? { strategy: event.strategy } : {}),
    headline: alertHeadline(event, { emoji: false }),
    text: formatAlertText(event, { includeData: false }),
    ...(event.market ? { market: snakeMarket(event.market) } : {}),
    ...(event.trade ? { trade: snakeTrade(event.trade) } : {}),
    ...(event.pnl ? { pnl: event.pnl } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
    message: event.message,
    ...(event.data && Object.keys(event.data).length ? { data: event.data } : {}),
  };
  return { id, body: JSON.stringify(payload) };
}

/** Hex HMAC-SHA256 of `${timestamp}.${body}`. */
export function signWebhookBody(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

class RetryableError extends Error {}

export class WebhookAlerter implements Alerter {
  private readonly queue: Pending[] = [];
  private draining?: Promise<void>;
  private readonly stats: WebhookFlushResult = { sent: 0, failed: 0, dropped: 0 };
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly format: WebhookFormat;
  private readonly kinds?: ReadonlySet<AlertKind>;
  private readonly maxQueue: number;
  private readonly timeoutMs: number;
  private readonly delays: number[];
  private lastDropWarn = 0;
  private closed = false;

  constructor(private readonly opts: WebhookAlerterOptions) {
    this.fetchImpl = boundFetch(opts.fetchImpl);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.format = opts.format ?? "json";
    this.kinds = opts.kinds ? new Set(opts.kinds) : undefined;
    this.maxQueue = Math.max(1, opts.maxQueue ?? 200);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.delays = opts.retryDelaysMs ?? DEFAULT_DELAYS_MS;
  }

  /** Enqueues and returns at once. Never rejects. */
  async send(event: AlertEvent): Promise<void> {
    try {
      if (this.kinds && !this.kinds.has(event.kind)) return;
      const { id, body } = buildWebhookPayload(event, this.format, this.now);
      this.queue.push({ id, kind: event.kind, botId: event.botId, body });
      if (this.queue.length > this.maxQueue) {
        const overflow = this.queue.length - this.maxQueue;
        this.queue.splice(0, overflow);
        this.stats.dropped += overflow;
        if (this.now() - this.lastDropWarn > 60_000) {
          this.lastDropWarn = this.now();
          this.opts.log?.warn(`webhook queue full; dropped ${overflow} oldest alert(s)`);
        }
      }
      this.kick();
    } catch (error) {
      this.opts.log?.warn(`webhook alert not queued: ${(error as Error).message}`);
    }
  }

  /** Waits until every queued alert is delivered or given up on. Never rejects. */
  async flush(): Promise<WebhookFlushResult> {
    while (this.draining) await this.draining;
    return { ...this.stats };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.queue.length) this.kick();
    });
  }

  private async drain(): Promise<void> {
    for (let item = this.queue.shift(); item; item = this.queue.shift()) {
      try {
        await this.deliver(item);
        this.stats.sent += 1;
      } catch (error) {
        this.stats.failed += 1;
        this.stats.lastError = (error as Error).message;
        this.opts.log?.warn(`webhook delivery failed (${item.kind}): ${this.stats.lastError}`);
      }
    }
  }

  private async deliver(item: Pending): Promise<void> {
    const delivery = randomUUID();
    for (let attempt = 1; ; attempt++) {
      try {
        await this.post(item, delivery, attempt);
        return;
      } catch (error) {
        if (!(error instanceof RetryableError) || attempt >= ATTEMPTS) throw error;
        await this.sleep(this.delays[Math.min(attempt - 1, this.delays.length - 1)] ?? 0);
      }
    }
  }

  private async post(item: Pending, delivery: string, attempt: number): Promise<void> {
    const timestamp = Math.floor(this.now() / 1000);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": `cassie/${this.opts.version ?? "dev"}`,
      "x-cassie-bot": item.botId,
      "x-cassie-event": item.kind,
      "x-cassie-event-id": item.id,
      "x-cassie-delivery": delivery,
      "x-cassie-attempt": String(attempt),
      "x-cassie-timestamp": String(timestamp),
    };
    if (this.opts.secret) headers["x-cassie-signature"] = `v1=${signWebhookBody(this.opts.secret, timestamp, item.body)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.url, {
        method: "POST",
        headers,
        body: item.body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new RetryableError(`request failed: ${(error as Error).message}`);
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 200 && res.status < 300) return;
    const message = `endpoint answered ${res.status}`;
    if (res.status === 408 || res.status === 429 || res.status >= 500) throw new RetryableError(message);
    throw new Error(message);
  }
}

// packages/core/src/alerts/index.ts
// Alerter interface implementations (§14). Telegram is the MVP transport;
// the interface is the extension point for Slack/email later.

import type { AlertEvent, Alerter, Logger } from "../types.js";
import { boundFetch } from "../http.js";
import { formatAlertText } from "./format.js";

export * from "./format.js";
export * from "./webhook.js";

export class NoopAlerter implements Alerter {
  async send(_event: AlertEvent): Promise<void> {}
}

export class ConsoleAlerter implements Alerter {
  constructor(private readonly log: Logger) {}
  async send(event: AlertEvent): Promise<void> {
    this.log.info(`ALERT ${formatAlertText(event, { includeData: false })}`, event.data);
  }
}

export class TelegramAlerter implements Alerter {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = boundFetch(fetchImpl);
  }

  private readonly fetchImpl: typeof fetch;

  async send(event: AlertEvent): Promise<void> {
    const text = formatAlertText(event);
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text }),
    });
    if (!res.ok) {
      throw new Error(`telegram sendMessage failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  }
}

/**
 * Delivers one event to several transports. Each is sent independently, so a
 * dead transport can't suppress the others (wrap each in SafeAlerter to make
 * that true of throws as well).
 */
export class FanoutAlerter implements Alerter {
  private readonly sinks: Alerter[];
  constructor(sinks: Alerter[]) {
    this.sinks = sinks.filter((s): s is Alerter => Boolean(s));
  }
  async send(event: AlertEvent): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.send(event)));
  }
  async flush(): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.flush?.()));
  }
}

/** Never lets an alert failure break a tick; logs instead. */
export class SafeAlerter implements Alerter {
  constructor(
    private readonly inner: Alerter,
    private readonly log: Logger,
  ) {}
  async send(event: AlertEvent): Promise<void> {
    try {
      await this.inner.send(event);
    } catch (err) {
      this.log.warn(`alert delivery failed (${event.kind}): ${(err as Error).message}`);
    }
  }
  async flush(): Promise<unknown> {
    try {
      return await this.inner.flush?.();
    } catch (err) {
      this.log.warn(`alert flush failed: ${(err as Error).message}`);
      return undefined;
    }
  }
}

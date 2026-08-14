// Independent Durable Object alarm loop. Keeping this outside BotAgent lets a
// tick call back into BotAgent's state RPC without a same-object event deadlock.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./container.js";
import { nextTickAtMs, tickIdAt } from "./tick-schedule.js";

const ACTIVE_KEY = "cassie:tick-active";
const BOT_ID_KEY = "cassie:tick-bot-id";
const INTERVAL_KEY = "cassie:tick-interval-seconds";

export class TickScheduler extends DurableObject<Env> {
  async start(botId: string, intervalSeconds: number): Promise<void> {
    if (!botId) throw new Error("tick scheduler requires a bot id");
    if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error("tick scheduler requires a positive integer interval");
    }
    await this.ctx.storage.put({
      [ACTIVE_KEY]: true,
      [BOT_ID_KEY]: botId,
      [INTERVAL_KEY]: intervalSeconds,
    });
    await this.ctx.storage.setAlarm(nextTickAtMs(Date.now(), intervalSeconds));
  }

  async stop(): Promise<void> {
    await this.ctx.storage.put(ACTIVE_KEY, false);
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const values = await this.ctx.storage.get([ACTIVE_KEY, BOT_ID_KEY, INTERVAL_KEY]);
    if (values.get(ACTIVE_KEY) !== true) return;
    const botId = values.get(BOT_ID_KEY);
    const intervalSeconds = values.get(INTERVAL_KEY);
    if (typeof botId !== "string" || !Number.isSafeInteger(intervalSeconds) || Number(intervalSeconds) <= 0) {
      console.error("durable tick scheduler has invalid persisted configuration");
      await this.stop();
      return;
    }

    const interval = Number(intervalSeconds);
    const now = Date.now();
    // Persist the successor first so venue, signal, or Container failures never
    // terminate polling. The slot-derived id makes alarm retries idempotent.
    await this.ctx.storage.setAlarm(nextTickAtMs(now, interval));
    try {
      const response = await this.env.BotAgent.getByName(botId).fetch(
        new Request(`https://cassie.internal/bots/${encodeURIComponent(botId)}/tick`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tickId: tickIdAt(now, interval) }),
        }),
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`container tick failed: ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ""}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`scheduled tick failed for ${botId}: ${message}`);
    }
  }
}

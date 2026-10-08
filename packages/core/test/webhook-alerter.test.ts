// packages/core/test/webhook-alerter.test.ts
// The webhook sink: signed, ordered, bounded, retried on transient failures,
// and never able to throw into the engine.

import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WebhookAlerter, buildWebhookPayload, webhookEventId, type AlertEvent } from "@quotient-forecasting/cassie-core";

const NOW = Date.parse("2026-09-24T14:03:00Z");

const event = (over: Partial<AlertEvent> = {}): AlertEvent => ({
  kind: "exit",
  botId: "wti-1",
  message: "exit YES m: SELL 120 @ 0.71",
  at: "2026-09-24T14:03:00.000Z",
  venue: "polymarket",
  strategy: "signals",
  market: { ref: "m", title: "Will it?", outcome: "YES", tokenId: "m", conditionId: "0xcondition" },
  trade: { side: "SELL", size: 120, price: 0.71, notionalUsd: 85.2, feeUsd: 0.43, orderId: "0xabc", maker: true, filled: true },
  pnl: { usd: 12.4, pct: 8.3, basis: "realized" },
  reason: "take-profit",
  data: { orderId: "0xabc", signalId: "sig_1" },
  ...over,
});

type Call = { url: string; init: RequestInit };

function recorder(statuses: Array<number | Error> = []) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = statuses.shift() ?? 200;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const make = (fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof WebhookAlerter>[0]> = {}) =>
  new WebhookAlerter({ url: "https://hooks.example.com/x", fetchImpl, now: () => NOW, sleep: async () => {}, ...over });

describe("WebhookAlerter", () => {
  it("posts the structured JSON payload with a verifiable signature", async () => {
    const { calls, fetchImpl } = recorder();
    const sink = make(fetchImpl, { secret: "s3cret", version: "0.4.17" });
    await sink.send(event());
    expect(await sink.flush()).toMatchObject({ sent: 1, failed: 0, dropped: 0 });
    const { url, init } = calls[0]!;
    expect(url).toBe("https://hooks.example.com/x");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-cassie-event"]).toBe("exit");
    expect(headers["x-cassie-bot"]).toBe("wti-1");
    expect(headers["user-agent"]).toBe("cassie/0.4.17");
    const body = String(init.body);
    const ts = headers["x-cassie-timestamp"];
    const expected = createHmac("sha256", "s3cret").update(`${ts}.${body}`).digest("hex");
    expect(headers["x-cassie-signature"]).toBe(`v1=${expected}`);
    const payload = JSON.parse(body);
    expect(payload).toMatchObject({
      version: 1,
      kind: "exit",
      bot_id: "wti-1",
      venue: "polymarket",
      headline: "Exit +$12.40 (+8.3%)",
      market: { title: "Will it?", token_id: "m", condition_id: "0xcondition" },
      trade: { side: "SELL", notional_usd: 85.2, fee_usd: 0.43, order_id: "0xabc", maker: true },
      pnl: { usd: 12.4, pct: 8.3, basis: "realized" },
      data: { signalId: "sig_1" },
    });
    expect(payload.text).not.toContain("signalId");
    expect(payload.id).toBe(headers["x-cassie-event-id"]);
  });

  it("delivers an error alert whose fingerprint carries line breaks and non-ASCII text", async () => {
    const delivered: Headers[] = [];
    // Real fetch validates header values the way this does.
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      delivered.push(new Headers(init?.headers));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const sink = make(fetchImpl);
    await sink.send(event({ kind: "error", trade: undefined, data: { fingerprint: "venue:invalid response\n  at line 2 → ✗" } }));
    expect(await sink.flush()).toMatchObject({ sent: 1, failed: 0 });
    expect(delivered[0]!.get("x-cassie-event-id")).toMatch(/^wti-1:error:fp:[0-9a-f]{16}:/);
  });

  it("sends no signature without a secret", async () => {
    const { calls, fetchImpl } = recorder();
    const sink = make(fetchImpl);
    await sink.send(event());
    await sink.flush();
    expect((calls[0]!.init.headers as Record<string, string>)["x-cassie-signature"]).toBeUndefined();
  });

  it.each((["entry", "exit", "fill", "flip", "resolution"] as const).flatMap(kind =>
    (["YES", "NO"] as const).map(outcome => ({ kind, outcome }))))(
    "carries exact outcome identifiers on $kind $outcome payloads", ({ kind, outcome }) => {
      const yes = "17538918577045757318444194668211148943610591693537184656815548450079156080092";
      const no = "64703197063795243847360183645307109446147801518759459137324323079702380490951";
      const source = event({ kind, market: { ref: yes, title: "Will it?", outcome, tokenId: outcome === "YES" ? yes : no,
        conditionId: "0xcondition", url: "https://polymarket.com/event/example" } });
      const { body, id } = buildWebhookPayload(source, "json");
      expect(JSON.parse(body).market).toEqual({ ref: yes, title: "Will it?", outcome, token_id: outcome === "YES" ? yes : no,
        condition_id: "0xcondition", url: "https://polymarket.com/event/example" });
      expect(id).toBe(webhookEventId(source, source.at!));
      expect(source.market).toHaveProperty("tokenId");
    },
  );

  it("omits unavailable market identities without substituting the reference", () => {
    const { body } = buildWebhookPayload(event({ venue: "kalshi", market: { ref: "KXTICKER", outcome: "NO" } }), "json");
    expect(JSON.parse(body).market).toEqual({ ref: "KXTICKER", outcome: "NO" });
  });

  it("preserves a zero resolution payout and the average entry price", () => {
    const { body } = buildWebhookPayload(event({ kind: "resolution", data: { size: 12, payout: 0, entryAvgPrice: 0.42 } }), "json");
    expect(JSON.parse(body).data).toEqual({ size: 12, payout: 0, entryAvgPrice: 0.42 });
  });

  it("posts readable text for Slack and Discord", async () => {
    const { calls, fetchImpl } = recorder();
    const slack = make(fetchImpl, { format: "slack" });
    await slack.send(event());
    await slack.flush();
    expect(JSON.parse(String(calls[0]!.init.body)).text.startsWith("🔵 Exit  +$12.40 (+8.3%)")).toBe(true);
    const discord = make(fetchImpl, { format: "discord" });
    await discord.send(event({ data: { blob: "x".repeat(5000) } }));
    await discord.flush();
    expect(JSON.parse(String(calls[1]!.init.body)).content.length).toBeLessThanOrEqual(1900);
  });

  it("delivers in order", async () => {
    const { calls, fetchImpl } = recorder();
    const sink = make(fetchImpl);
    for (const kind of ["entry", "fill", "exit"] as const) await sink.send(event({ kind, trade: undefined, data: { n: kind } }));
    await sink.flush();
    expect(calls.map((c) => JSON.parse(String(c.init.body)).kind)).toEqual(["entry", "fill", "exit"]);
  });

  it("retries transient failures and gives up on other 4xx at once", async () => {
    const retried = recorder([503, 200]);
    const a = make(retried.fetchImpl);
    await a.send(event());
    expect(await a.flush()).toMatchObject({ sent: 1, failed: 0 });
    expect(retried.calls).toHaveLength(2);

    const rejected = recorder([404]);
    const b = make(rejected.fetchImpl);
    await b.send(event());
    expect(await b.flush()).toMatchObject({ sent: 0, failed: 1, lastError: "endpoint answered 404" });
    expect(rejected.calls).toHaveLength(1);
  });

  it("stops after three network failures without throwing", async () => {
    const down = recorder([new Error("ECONNREFUSED"), new Error("ECONNREFUSED"), new Error("ECONNREFUSED")]);
    const sink = make(down.fetchImpl);
    await expect(sink.send(event())).resolves.toBeUndefined();
    expect(await sink.flush()).toMatchObject({ sent: 0, failed: 1 });
    expect(down.calls).toHaveLength(3);
  });

  it("bounds the queue by dropping the oldest", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bodies: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      await gate;
      bodies.push(String(init?.body));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const sink = make(fetchImpl, { maxQueue: 5 });
    for (let i = 0; i < 12; i++) await sink.send(event({ kind: "fill", trade: undefined, message: `m${i}`, data: { n: i } }));
    release();
    const result = await sink.flush();
    // The first event was already in flight; of the 11 queued behind it, the 6 oldest are dropped.
    expect(result).toMatchObject({ sent: 6, dropped: 6 });
    expect(bodies.map((b) => JSON.parse(b).data.n)).toEqual([0, 7, 8, 9, 10, 11]);
  });

  it("delivers only the configured kinds", async () => {
    const { calls, fetchImpl } = recorder();
    const sink = make(fetchImpl, { kinds: ["exit"] });
    await sink.send(event({ kind: "entry" }));
    await sink.send(event());
    await sink.flush();
    expect(calls).toHaveLength(1);
  });

  it("closes idempotently", async () => {
    const { fetchImpl } = recorder();
    const sink = make(fetchImpl);
    await sink.send(event());
    await sink.close();
    await sink.close();
  });
});

describe("webhookEventId", () => {
  it("is stable per emission and prefers the most specific id", () => {
    const at = "2026-09-24T14:03:00.000Z";
    expect(webhookEventId(event(), at)).toBe(`wti-1:exit:order:0xabc:${at}`);
    expect(webhookEventId(event({ data: { settlementId: "st1", orderId: "0xabc" } }), at)).toBe(`wti-1:exit:settlement:st1:${at}`);
    expect(webhookEventId(event({ trade: undefined, data: { fingerprint: "fp1" } }), at)).toMatch(new RegExp(`^wti-1:exit:fp:[0-9a-f]{16}:${at}$`));
    expect(webhookEventId(event({ trade: undefined, data: { fingerprint: "fp1" } }), at)).toBe(webhookEventId(event({ trade: undefined, data: { fingerprint: "fp1" } }), at));
    expect(webhookEventId(event({ trade: undefined, data: { fingerprint: "fp1" } }), at)).not.toBe(webhookEventId(event({ trade: undefined, data: { fingerprint: "fp2" } }), at));
    const plain = event({ trade: undefined, data: {} });
    expect(webhookEventId(plain, at)).toBe(webhookEventId(plain, at));
  });

  it("stamps an event without a time from the clock", () => {
    const { body } = buildWebhookPayload(event({ at: undefined }), "json", () => NOW);
    expect(JSON.parse(body).at).toBe("2026-09-24T14:03:00.000Z");
  });
});

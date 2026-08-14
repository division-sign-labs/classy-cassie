// packages/core/test/ares.test.ts
// Ares attribution + publishing. The expensive failures here are silent ones:
// an order that quietly loses its builder code (breaks the commercial term,
// nobody notices), or a NO-side post referencing the YES token (404s forever).

import { describe, expect, it, vi } from "vitest";
import {
  AresAlerter,
  AresClient,
  buildReporter,
  FanoutAlerter,
  PolymarketAdapter,
  captionFor,
  captionFromThesis,
  parseBotConfig,
  silentLogger,
  widgetFor,
  type AlertEvent,
  type Alerter,
  type OrderIntent,
} from "@quotient/cassie-core";

const BUILDER_CODE = "0xaca2b0761a55c278c8f145a3ec9ec8ccdea292610a4b4be5f2a6618139091c12";
const YES_TOKEN = "7132104519000000000000000000000000000000000000000000000000000001";
const NO_TOKEN = "7132104519000000000000000000000000000000000000000000000000000002";
const FUNDER = "0x1a2b000000000000000000000000000000000000";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------
// Attribution: the code must reach the SDK on every order shape
// ---------------------------------------------------------------------------

/**
 * Drives PolymarketAdapter.placeOrder against a stubbed secure client so the
 * request the SDK would receive is observable.
 */
function stubbedAdapter(opts: { builderCode?: string } = {}) {
  const limitCalls: Record<string, unknown>[] = [];
  const marketCalls: Record<string, unknown>[] = [];
  const adapter = new PolymarketAdapter({
    urls: parseBotConfig({ id: "t", venue: "polymarket" }).venueUrls,
    creds: {
      venue: "polymarket",
      signerPk: "0x00",
      funder: FUNDER,
      signatureType: 3,
      l2: { apiKey: "k", secret: "s", passphrase: "p" },
    },
    ...opts,
  });

  const client = {
    placeLimitOrder: async (req: Record<string, unknown>) => {
      limitCalls.push(req);
      return { ok: true, orderId: "0xORDER", status: "live" };
    },
    placeMarketOrder: async (req: Record<string, unknown>) => {
      marketCalls.push(req);
      return { ok: true, orderId: "0xORDER", status: "matched", makingAmount: "5", takingAmount: "10" };
    },
  };
  // Bypass network setup: the SDK client and market metadata are not under test.
  const inner = adapter as unknown as {
    secure: () => Promise<unknown>;
    marketInfoForToken: (t: string) => Promise<unknown>;
    tokenFor: (ref: string, outcome?: "YES" | "NO") => Promise<string>;
  };
  inner.secure = async () => client;
  inner.marketInfoForToken = async () => ({ conditionId: "0xCOND", info: { tickSize: "0.01", tokens: [] } });
  inner.tokenFor = async (ref, outcome) => (outcome === "NO" ? NO_TOKEN : ref);

  return { adapter, limitCalls, marketCalls };
}

const account = {
  venue: "polymarket" as const,
  signerAddress: "0xSIGNER",
  funder: FUNDER,
  signatureType: 3,
};

function intent(over: Partial<OrderIntent> = {}): OrderIntent {
  return {
    marketRef: YES_TOKEN,
    side: "BUY",
    size: 10,
    limitPrice: 0.5,
    tif: "GTC",
    clientId: "c1",
    ...over,
  };
}

describe("builder-code attribution", () => {
  it("stamps the bot-wide code on limit orders", async () => {
    const { adapter, limitCalls } = stubbedAdapter({ builderCode: BUILDER_CODE });
    await adapter.placeOrder(account, intent());
    expect(limitCalls[0]!.builderCode).toBe(BUILDER_CODE);
  });

  it("stamps it on market orders, both sides", async () => {
    const { adapter, marketCalls } = stubbedAdapter({ builderCode: BUILDER_CODE });
    await adapter.placeOrder(account, intent({ tif: "FOK" }));
    await adapter.placeOrder(account, intent({ tif: "FOK", side: "SELL" }));
    expect(marketCalls).toHaveLength(2);
    for (const call of marketCalls) expect(call.builderCode).toBe(BUILDER_CODE);
  });

  it("does not let an intent replace the bot-wide code", async () => {
    const { adapter, limitCalls } = stubbedAdapter({ builderCode: BUILDER_CODE });
    await adapter.placeOrder(account, { ...intent(), builderCode: "0xOTHER" } as OrderIntent);
    expect(limitCalls[0]!.builderCode).toBe(BUILDER_CODE);
  });

  it("omits the field entirely when no bot opted in", async () => {
    const { adapter, limitCalls } = stubbedAdapter();
    await adapter.placeOrder(account, intent());
    expect(limitCalls[0]).not.toHaveProperty("builderCode");
  });

  it("returns the traded token — the NO token, not marketRef", async () => {
    const { adapter } = stubbedAdapter({ builderCode: BUILDER_CODE });
    const ack = await adapter.placeOrder(account, intent({ outcome: "NO" }));
    expect(ack.tokenId).toBe(NO_TOKEN);
    expect(ack.tokenId).not.toBe(YES_TOKEN);
    expect(ack.funder).toBe(FUNDER);
    expect(ack.builderCode).toBe(BUILDER_CODE);
  });
});

// ---------------------------------------------------------------------------
// Config: attribution and posting cannot drift apart
// ---------------------------------------------------------------------------

describe("reporting config", () => {
  it("is absent by default — other bots are untouched", () => {
    expect(parseBotConfig({ id: "b", venue: "polymarket" }).reporting).toBeUndefined();
  });

  it("cannot enable posting without a builder code", () => {
    expect(() => parseBotConfig({ id: "b", venue: "polymarket", reporting: { post: true } })).toThrow();
  });

  it("rejects a malformed builder code", () => {
    expect(() => parseBotConfig({ id: "b", venue: "polymarket", reporting: { builderCode: "0xnope" } })).toThrow();
  });

  it("defaults to posting entries and exits", () => {
    const cfg = parseBotConfig({ id: "b", venue: "polymarket", reporting: { builderCode: BUILDER_CODE } });
    expect(cfg.reporting?.provider).toBe("ares");
    expect(cfg.reporting?.post).toBe(true);
    expect(cfg.reporting?.postOn).toEqual(["entry", "exit"]);
    expect(cfg.reporting?.baseUrl).toBe("https://api.ares.pro");
  });
});

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

function entryEvent(over: Record<string, unknown> = {}): AlertEvent {
  return {
    kind: "entry",
    botId: "b",
    message: "enter YES 71321045…: BUY 10 @ 0.53",
    data: {
      orderId: "0xORDER",
      asset: NO_TOKEN,
      funder: FUNDER,
      builderCode: BUILDER_CODE,
      reason: "signal sig_8f21 spread 12.3pp",
      note: "Model has this at 65c against a 53c market. Taking the spread.",
      ...over,
    },
  };
}

describe("widget + caption", () => {
  it("builds the card from the resolved token and funder", () => {
    expect(widgetFor(entryEvent())).toEqual({
      type: "polymarket_position",
      clobOrderId: "0xORDER",
      depositWalletAddress: FUNDER,
      asset: NO_TOKEN,
    });
  });

  it("omits the card when the trade reference is incomplete", () => {
    expect(widgetFor(entryEvent({ asset: undefined }))).toBeUndefined();
    expect(widgetFor(entryEvent({ funder: undefined }))).toBeUndefined();
  });

  it("uses the operator's note as the caption", () => {
    expect(captionFor(entryEvent())).toBe("Model has this at 65c against a 53c market. Taking the spread.");
  });

  it("never leaks internal signal ids or log lines to the feed", () => {
    const caption = captionFor(entryEvent());
    expect(caption).not.toContain("sig_8f21");
    expect(caption).not.toContain("71321045");
  });

  it("says nothing rather than something internal when no note was written", () => {
    expect(captionFor(entryEvent({ note: undefined }))).toBe("");
  });

  it("truncates to the API's 2000-char ceiling", () => {
    const caption = captionFor(entryEvent({ note: "x".repeat(3000) }));
    expect(caption.length).toBeLessThanOrEqual(2000);
  });
});

describe("AresAlerter", () => {
  it("posts a caption and card on entry", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "post_1" }));
    await new AresAlerter({ apiKey: "ares_sk_live_x", fetchImpl: fetchImpl as never }).send(entryEvent());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.ares.pro/public/v1/feed/posts");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ares_sk_live_x");
    const body = JSON.parse(init.body as string);
    expect(body.widget.asset).toBe(NO_TOKEN);
    expect(body.content).toContain("65c against a 53c market");
  });

  it("ignores kinds outside postOn", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "p" }));
    const alerter = new AresAlerter({ apiKey: "k", fetchImpl: fetchImpl as never, postOn: ["entry"] });
    await alerter.send({ ...entryEvent(), kind: "exit" });
    await alerter.send({ kind: "error", botId: "b", message: "boom" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the card alone when no note was written", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "p" }));
    await new AresAlerter({ apiKey: "k", fetchImpl: fetchImpl as never }).send(entryEvent({ note: undefined }));
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.content).toBeUndefined();
    expect(body.widget.asset).toBe(NO_TOKEN);
  });

  it("still posts a caption when the ack carried no trade reference", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "p" }));
    await new AresAlerter({ apiKey: "k", fetchImpl: fetchImpl as never }).send(
      entryEvent({ orderId: undefined, asset: undefined, funder: undefined }),
    );
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.widget).toBeUndefined();
    expect(body.content).toBeTruthy();
  });
});

describe("AresClient retry", () => {
  it("retries the indexing 404 until the builder feed catches up", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls < 3 ? jsonResponse({ error: "position not held" }, 404) : jsonResponse({ id: "post_9" });
    });
    const client = new AresClient({
      apiKey: "k",
      fetchImpl: fetchImpl as never,
      retryDelaysMs: [0, 0, 0],
      sleep: async () => {},
    });
    expect((await client.post({ content: "hi" })).id).toBe("post_9");
    expect(calls).toBe(3);
  });

  it("does not retry a 401", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
    const client = new AresClient({ apiKey: "bad", fetchImpl: fetchImpl as never, sleep: async () => {} });
    await expect(client.post({ content: "hi" })).rejects.toThrow(/401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "position not held" }, 404));
    const client = new AresClient({
      apiKey: "k",
      fetchImpl: fetchImpl as never,
      retryDelaysMs: [0, 0],
      sleep: async () => {},
    });
    await expect(client.post({ content: "hi" })).rejects.toThrow(/404/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("FanoutAlerter", () => {
  it("delivers to every sink", async () => {
    const seen: string[] = [];
    const sink = (name: string): Alerter => ({ async send() { seen.push(name); } });
    await new FanoutAlerter([sink("telegram"), sink("ares")]).send(entryEvent());
    expect(seen).toEqual(["telegram", "ares"]);
  });
});

// ---------------------------------------------------------------------------
// Thesis → caption. The thesis is the intended caption source for a bot whose
// posts are read by people deciding whether to copy the trade.
// ---------------------------------------------------------------------------

describe("captionFromThesis", () => {
  const base = {
    venue: "polymarket" as const,
    instrument: YES_TOKEN,
    side: "YES" as const,
    confidence: "high" as const,
    timeframe: "weeks" as const,
    magnitude: "repricing" as const,
    riskBudgetPct: 1,
  };

  it("leads with the operator's reasoning, then the trade's terms", () => {
    const caption = captionFromThesis({
      ...base,
      reasoningSummary: "Polling has moved 6pts in two weeks and the market hasn't repriced.",
      invalidationPx: 0.35,
    });
    expect(caption.startsWith("Polling has moved 6pts")).toBe(true);
    expect(caption).toContain("high conviction");
    expect(caption).toContain("weeks");
    expect(caption).toContain("Invalidated at 0.35.");
  });

  it("falls back to notes when no reasoning summary was written", () => {
    expect(captionFromThesis({ ...base, notes: "cheap tail" })).toContain("cheap tail");
  });

  it("still describes the trade when neither was written", () => {
    const caption = captionFromThesis(base);
    expect(caption).toContain("YES");
    expect(caption).toContain("high conviction");
  });

  it("prefers the filled ticket's computed stop over the stated invalidation", () => {
    const caption = captionFromThesis({ ...base, invalidationPx: 0.35 }, {
      stopPx: 0.31,
      tpPx: 0.78,
    } as never);
    expect(caption).toContain("Invalidated at 0.31.");
    expect(caption).toContain("Target 0.78.");
  });

  it("omits size and price — the card carries those from the real fill", () => {
    const caption = captionFromThesis({ ...base, reasoningSummary: "edge is real" });
    expect(caption).not.toMatch(/\$\d/);
  });

  it("truncates to the API ceiling", () => {
    expect(captionFromThesis({ ...base, reasoningSummary: "y".repeat(3000) }).length).toBeLessThanOrEqual(2000);
  });
});

// ---------------------------------------------------------------------------
// Provider selection. Runtimes ask for a reporter and never name a provider,
// so this is the only place that knows Ares exists.
// ---------------------------------------------------------------------------

describe("buildReporter", () => {
  const reporting = { provider: "ares" as const, builderCode: BUILDER_CODE, post: true, postOn: ["entry" as const], baseUrl: "https://api.ares.pro" };
  const warnings: string[] = [];
  const log = { ...silentLogger, warn: (m: string) => void warnings.push(m) };

  it("returns a reporter for a configured provider", () => {
    expect(buildReporter({ reporting, apiKey: "k", log })).toBeDefined();
  });

  it("returns nothing when the bot reports nowhere", () => {
    expect(buildReporter({ reporting: undefined, apiKey: "k", log })).toBeUndefined();
  });

  it("returns nothing when posting is switched off", () => {
    expect(buildReporter({ reporting: { ...reporting, post: false }, apiKey: "k", log })).toBeUndefined();
  });

  it("warns and disables reporting alone when the key is missing", () => {
    warnings.length = 0;
    expect(buildReporter({ reporting, apiKey: undefined, log })).toBeUndefined();
    // Attribution must survive a missing key — it is a property of the order.
    expect(warnings.join(" ")).toMatch(/ARES_API_KEY/);
    expect(warnings.join(" ")).toMatch(/stay attributed/);
  });
});

// packages/core/src/feed/ares.ts
// Ares feed publisher. Ares is not a venue — trades execute on Polymarket as
// they always have; Ares reads Polymarket's builder-attributed trade feed and
// renders a position card from the real fill. This module is the second half
// of that contract: attribute the order (see PolymarketAdapter.placeOrder),
// then reference the trade in a post.
//
// Verified against the Bot Integration Guide, 2026-08-13:
//   POST {baseUrl}/public/v1/feed/posts   Bearer ares_sk_live_…
//   GET  {baseUrl}/public/v1/me           → { username }
//
// Implemented as an Alerter so publishing sits entirely off the trading path:
// the engine already emits entry/exit events, and an Ares outage can never
// block or delay a fill.

import type { AlertEvent, Alerter, FilledTicket, Logger, ThesisTicket } from "../types.js";
import { boundFetch } from "../http.js";

/** Caption ceiling from the API contract; longer bodies are a 400. */
const MAX_CONTENT = 2000;

/**
 * Fresh trades index with a short lag, so a post issued immediately after the
 * fill can 404 until the builder feed catches up. Retry a few times before
 * treating it as a real mismatch.
 */
const DEFAULT_RETRY_MS = [1_000, 2_000, 4_000, 8_000] as const;

export interface AresPositionWidget {
  type: "polymarket_position";
  clobOrderId: string;
  depositWalletAddress: string;
  asset: string;
}

export interface AresPostBody {
  content?: string;
  widget?: AresPositionWidget;
}

export interface AresClientOpts {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  retryDelaysMs?: readonly number[];
  /** Test seam: swap out the wall-clock wait. */
  sleep?: (ms: number) => Promise<void>;
}

export class AresClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelaysMs: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: AresClientOpts) {
    this.baseUrl = (opts.baseUrl ?? "https://api.ares.pro").replace(/\/+$/, "");
    this.fetchImpl = boundFetch(opts.fetchImpl);
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.apiKey}`,
      "content-type": "application/json",
    };
  }

  /** Resolves the user the key posts as — used by `cassie ops` to verify setup. */
  async me(): Promise<{ username: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/public/v1/me`, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`ares /me ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
    return (await res.json()) as { username: string };
  }

  /**
   * Publishes a post, retrying the documented indexing 404 on the way.
   * Returns the created post id.
   */
  async post(body: AresPostBody): Promise<{ id: string; createdAt?: string }> {
    if (!body.content && !body.widget) {
      throw new Error("ares post needs content, widget, or both");
    }
    let lastErr = "";
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}/public/v1/feed/posts`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
      if (res.ok) return (await res.json()) as { id: string; createdAt?: string };

      const text = (await res.text().catch(() => "")).slice(0, 300);
      lastErr = `${res.status}: ${text}`;
      // 404 = the trade isn't in the builder feed yet (or the wallet/token/order
      // genuinely don't match an attributed trade). Only that is worth waiting on.
      const retriable = res.status === 404 && attempt < this.retryDelaysMs.length;
      if (!retriable) break;
      await this.sleep(this.retryDelaysMs[attempt]!);
    }
    throw new Error(`ares post failed — ${lastErr}`);
  }
}

export interface AresAlerterOpts extends AresClientOpts {
  /** Which alert kinds become posts. Defaults to entry + exit. */
  postOn?: readonly AlertEvent["kind"][];
  log?: Logger;
}

/**
 * Turns engine entry/exit events into feed posts.
 *
 * The caption is the bot's own words — the engine already carries a `reason`
 * on every action, so nothing has to be fetched to write one. The widget is
 * attached only when the ack carried a full trade reference; a post with a
 * caption alone is valid and is the right degradation when it didn't.
 */
export class AresAlerter implements Alerter {
  private readonly client: AresClient;
  private readonly postOn: readonly AlertEvent["kind"][];

  constructor(private readonly opts: AresAlerterOpts) {
    this.client = new AresClient(opts);
    this.postOn = opts.postOn ?? ["entry", "exit"];
  }

  async send(event: AlertEvent): Promise<void> {
    if (!this.postOn.includes(event.kind)) return;

    const body: AresPostBody = {};
    const content = captionFor(event);
    if (content) body.content = content;

    const widget = widgetFor(event);
    if (widget) {
      body.widget = widget;
    } else if (event.data?.builderCode) {
      // Attributed but unreferenceable: the card would have been the point.
      this.opts.log?.warn(
        `ares: posting caption only for ${event.kind} — ack carried no ${missingWidgetField(event)}`,
      );
    }

    if (!body.content && !body.widget) return;
    const post = await this.client.post(body);
    this.opts.log?.info(`ares: published ${event.kind} post ${post.id}`);
  }
}

/** Which trade-reference field was absent, for a log line worth reading. */
function missingWidgetField(event: AlertEvent): string {
  const d = event.data ?? {};
  const missing = ["orderId", "asset", "funder"].filter((k) => !isNonEmpty(d[k]));
  return missing.length ? missing.join(" / ") : "trade reference";
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Builds the position card from the ack the engine stamped into the event.
 *
 * `asset` is the resolved outcome token, never marketRef: marketRef is the
 * YES-token ref by convention (§7), so a NO trade referenced by marketRef
 * names a token the account does not hold and 404s forever.
 */
export function widgetFor(event: AlertEvent): AresPositionWidget | undefined {
  const d = event.data ?? {};
  const clobOrderId = d.orderId;
  const asset = d.asset;
  const depositWalletAddress = d.funder;
  if (!isNonEmpty(clobOrderId) || !isNonEmpty(asset) || !isNonEmpty(depositWalletAddress)) {
    return undefined;
  }
  return { type: "polymarket_position", clobOrderId, depositWalletAddress, asset };
}

/**
 * The post caption.
 *
 * Readers here are deciding whether to copy the trade, so the caption is the
 * operator's own words — a thesis `reasoningSummary`, or `--note` — carried on
 * the event as `note`.
 *
 * With no note, this returns empty and the post goes out as the card alone.
 * The engine's `reason` is deliberately excluded: strings like
 * `signal sig_8f21 spread 12.3pp` are internal identifiers and telemetry,
 * meaningless to a copy-trader and not ours to publish. A trade with nothing
 * written about it says nothing rather than leaking a log line.
 */
/**
 * Renders a thesis as a post caption: the operator's reasoning, then the terms
 * of the trade a reader would want before copying it.
 *
 * Only fields the operator actually supplied appear — no filler, and no
 * conviction language the thesis didn't state. Size and price are left out on
 * purpose: the position card carries those from the real fill, so repeating
 * them in prose invites the two to disagree.
 */
export function captionFromThesis(thesis: ThesisTicket, filled?: FilledTicket): string {
  const parts: string[] = [];
  if (isNonEmpty(thesis.reasoningSummary)) parts.push(thesis.reasoningSummary.trim());
  else if (isNonEmpty(thesis.notes)) parts.push(thesis.notes.trim());

  const terms: string[] = [
    `${thesis.side} · ${thesis.confidence} conviction · ${thesis.timeframe} · expecting a ${thesis.magnitude} move`,
  ];
  const invalidation = filled?.stopPx ?? thesis.invalidationPx;
  if (invalidation !== undefined) terms.push(`Invalidated at ${invalidation}.`);
  if (filled?.tpPx !== undefined) terms.push(`Target ${filled.tpPx}.`);
  else if (filled?.trailBps !== undefined) terms.push(`Trailing stop ${filled.trailBps}bps.`);
  parts.push(terms.join("\n"));

  const text = parts.join("\n\n").trim();
  return text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT - 1)}…` : text;
}

export function captionFor(event: AlertEvent): string {
  const note = event.data?.note;
  if (!isNonEmpty(note)) return "";
  const text = note.trim();
  return text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT - 1)}…` : text;
}

// packages/core/src/alerts/format.ts
// One readable layout for every alert sink. The trade and its P&L come first,
// then the time, the market, the side and size, where it ran, and why; the
// debug metadata (`event.data`) comes last. Events without structured fields
// render exactly as they always have.

import type { AlertEvent, AlertKind, AlertPnl, AlertPnlBasis, PositionSide } from "../types.js";

export const KIND_EMOJI: Record<AlertKind, string> = {
  entry: "🟢",
  exit: "🔵",
  flip: "🔄",
  fill: "✅",
  "partial-fill-timeout": "⏱️",
  "skipped-order": "⏭️",
  deposit: "💰",
  deploy: "🚀",
  error: "🔴",
  deadman: "🛑",
  resolution: "🏁",
  test: "🔔",
};

export const KIND_LABEL: Record<AlertKind, string> = {
  entry: "Entry",
  exit: "Exit",
  flip: "Flip",
  fill: "Fill",
  "partial-fill-timeout": "Partial fill timed out",
  "skipped-order": "Order skipped",
  deposit: "Deposit",
  deploy: "Deploy",
  error: "Error",
  deadman: "Dead man's switch",
  resolution: "Resolved",
  test: "Test",
};

/** Telegram rejects messages over 4096 characters. */
export const ALERT_TEXT_MAX = 4000;

const REASONS: Record<string, string> = {
  "synthetic-stop": "stop triggered",
  "synthetic-tp": "take-profit triggered",
  "synthetic-trail": "trailing stop triggered",
  "strategy-entry": "strategy entry",
  "strategy-exit": "strategy exit",
  target: "take-profit filled",
  "protective-stop": "protective stop hit",
  "time-limit": "hold time limit reached",
  "liquidation-buffer": "liquidation buffer reached",
  "protection-failed": "protection could not be confirmed",
  "invalid-stop": "stop invalid",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortMarketRef(ref: string): string {
  return ref.length > 18 ? `${ref.slice(0, 8)}…${ref.slice(-6)}` : ref;
}

export function humanizeReason(reason: string): string {
  return REASONS[reason] ?? reason;
}

function money(usd: number): string {
  const sign = usd < 0 ? "-" : "";
  return `${sign}$${Math.abs(usd).toFixed(2)}`;
}

function signedMoney(usd: number): string {
  return `${usd > 0 ? "+" : usd < 0 ? "-" : ""}$${Math.abs(usd).toFixed(2)}`;
}

function signedPct(pct: number): string {
  return `${pct > 0 ? "+" : pct < 0 ? "-" : ""}${Math.abs(pct).toFixed(1)}%`;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** `+$12.40 (+8.3%)`; either part is dropped when unknown; empty when both are. */
export function formatPnl(pnl: AlertPnl | undefined): string {
  if (!pnl) return "";
  const usd = finite(pnl.usd) ? signedMoney(pnl.usd) : "";
  const pct = finite(pnl.pct) ? signedPct(pnl.pct) : "";
  if (usd && pct) return `${usd} (${pct})`;
  return usd || pct;
}

/** `14:03 UTC · Sep 24`, or undefined when `at` does not parse. */
export function formatAlertTime(at: string | undefined): string | undefined {
  if (!at) return undefined;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC · ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function isStructured(event: AlertEvent): boolean {
  return Boolean(event.at || event.market || event.trade || event.pnl);
}

/**
 * The first line. Structured: `🔵 Exit  +$12.40 (+8.3%)`. Legacy: the old
 * `🔵 [botId] message` line. `emoji: false` drops the marker (webhook JSON).
 */
export function alertHeadline(event: AlertEvent, opts: { emoji?: boolean } = {}): string {
  const emoji = opts.emoji === false ? "" : `${KIND_EMOJI[event.kind] ?? "ℹ️"} `;
  if (!isStructured(event)) return `${emoji}[${event.botId}] ${event.message}`;
  const pnl = formatPnl(event.pnl);
  const gap = opts.emoji === false ? " " : "  ";
  return `${emoji}${KIND_LABEL[event.kind] ?? event.kind}${pnl ? `${gap}${pnl}` : ""}`;
}

function sideLine(event: AlertEvent): string | undefined {
  const t = event.trade;
  const held = event.market?.outcome ?? t?.positionSide;
  if (!t) return held;
  const past = t.filled === true || event.kind === "fill";
  const verb = t.side === "BUY" ? (past ? "bought" : "buy") : past ? "sold" : "sell";
  const parts = [
    ...(held ? [held] : []),
    `${verb} ${Number(t.size.toFixed(4))} @ ${Number(t.price.toFixed(6))}`,
  ];
  const notional = t.notionalUsd ?? t.size * t.price;
  if (finite(notional)) parts.push(money(notional));
  if (finite(t.feeUsd) && t.feeUsd > 0) parts.push(`fee ${money(t.feeUsd)}`);
  if (t.maker) parts.push("maker");
  return parts.join(" · ");
}

function dataLines(data: Record<string, unknown> | undefined): string[] {
  if (!data) return [];
  return Object.entries(data).map(([k, v]) => `${k}: ${typeof v === "number" ? v : JSON.stringify(v)}`);
}

function truncate(text: string, max = ALERT_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The full message: readable lines first, then a blank line and the debug metadata. */
export function formatAlertText(event: AlertEvent, opts: { includeData?: boolean } = {}): string {
  const includeData = opts.includeData ?? true;
  const debug = includeData ? dataLines(event.data) : [];
  if (!isStructured(event)) {
    return truncate([alertHeadline(event), ...debug].join("\n"));
  }
  const lines: string[] = [alertHeadline(event)];
  const time = formatAlertTime(event.at);
  if (time) lines.push(time);
  if (event.market) lines.push(event.market.title?.trim() || shortMarketRef(event.market.ref));
  const side = sideLine(event);
  if (side) lines.push(side);
  const where = [event.venue, event.strategy, event.botId].filter((p): p is string => Boolean(p));
  lines.push(where.join(" · "));
  lines.push(event.reason ? humanizeReason(event.reason) : event.message);
  if (debug.length) lines.push("", ...debug);
  return truncate(lines.join("\n"));
}

/**
 * P&L of closing `size` held at `entryAvgPrice`. YES and NO are both long in
 * their own token price, so only SHORT flips the sign. `usd` is net of the
 * fee; `pct` is the price return on the closed size, before the fee.
 * Undefined when there is no usable entry price.
 */
export function closingPnl(
  entryAvgPrice: number | undefined,
  positionSide: PositionSide | undefined,
  size: number,
  price: number,
  feeUsd: number | undefined,
  basis: AlertPnlBasis,
): AlertPnl | undefined {
  if (!finite(entryAvgPrice) || entryAvgPrice <= 0 || !finite(size) || size <= 0 || !finite(price)) return undefined;
  const direction = positionSide === "SHORT" ? -1 : 1;
  const gross = (price - entryAvgPrice) * size * direction;
  const fee = finite(feeUsd) ? feeUsd : 0;
  return {
    usd: Math.round((gross - fee) * 10_000) / 10_000,
    pct: Math.round((gross / (entryAvgPrice * size)) * 100 * 100) / 100,
    basis,
  };
}

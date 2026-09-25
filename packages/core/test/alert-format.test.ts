// packages/core/test/alert-format.test.ts
// The readable alert layout: trade and P&L first, then time, market, side,
// venue, reason, and the debug metadata last. Legacy events keep their text.

import { describe, expect, it } from "vitest";
import {
  alertHeadline,
  closingPnl,
  formatAlertText,
  formatPnl,
  humanizeReason,
  type AlertEvent,
} from "@quotient-forecasting/cassie-core";

const exit: AlertEvent = {
  kind: "exit",
  botId: "wti-1",
  message: "exit YES 12345678…abcdef (take-profit): SELL 120 @ 0.71",
  at: "2026-09-24T14:03:00Z",
  venue: "polymarket",
  strategy: "signals",
  market: { ref: "123456789012345678901234", title: "Will Bitcoin close above $100k on Sep 30?", outcome: "YES" },
  trade: { side: "SELL", size: 120, price: 0.71, notionalUsd: 85.2, filled: true },
  pnl: { usd: 12.4, pct: 8.3, basis: "realized" },
  reason: "take-profit: 71¢ bid reached",
  data: { orderId: "0xabc", signalId: "sig_8f21" },
};

describe("formatAlertText", () => {
  it("leads with the trade and P&L and ends with the debug metadata", () => {
    expect(formatAlertText(exit)).toBe(
      [
        "🔵 Exit  +$12.40 (+8.3%)",
        "14:03 UTC · Sep 24",
        "Will Bitcoin close above $100k on Sep 30?",
        "YES · sold 120 @ 0.71 · $85.20",
        "polymarket · signals · wti-1",
        "take-profit: 71¢ bid reached",
        "",
        'orderId: "0xabc"',
        'signalId: "sig_8f21"',
      ].join("\n"),
    );
  });

  it("drops the debug block on request", () => {
    expect(formatAlertText(exit, { includeData: false })).not.toContain("orderId");
  });

  it("renders an entry placement without P&L in the present tense", () => {
    const text = formatAlertText({
      kind: "entry",
      botId: "b",
      message: "enter YES m: BUY 10 @ 0.4",
      at: "2026-01-05T09:07:00Z",
      market: { ref: "m", outcome: "YES" },
      trade: { side: "BUY", size: 10, price: 0.4 },
      reason: "strategy-entry",
    });
    expect(text.split("\n").slice(0, 5)).toEqual([
      "🟢 Entry",
      "09:07 UTC · Jan 5",
      "m",
      "YES · buy 10 @ 0.4 · $4.00",
      "b",
    ]);
    expect(text).toContain("strategy entry");
  });

  it("shows fee and maker on a fill", () => {
    const text = formatAlertText({
      kind: "fill",
      botId: "b",
      message: "fill",
      at: "2026-01-05T09:07:00Z",
      trade: { side: "BUY", size: 8, price: 0.56, feeUsd: 0.02, maker: true, positionSide: "YES" },
    });
    expect(text).toContain("YES · bought 8 @ 0.56 · $4.48 · fee $0.02 · maker");
  });

  it("falls back to the message when there is no reason", () => {
    const text = formatAlertText({
      kind: "error",
      botId: "b",
      message: "error [strategy-tick]: boom",
      at: "2026-01-05T09:07:00Z",
      venue: "kalshi",
      strategy: "signals",
      data: { tick: 4 },
    });
    expect(text).toBe(["🔴 Error", "09:07 UTC · Jan 5", "kalshi · signals · b", "error [strategy-tick]: boom", "", "tick: 4"].join("\n"));
  });

  it("keeps the legacy text for events without structured fields", () => {
    expect(formatAlertText({ kind: "exit", botId: "wti-1", message: "exit YES abcdefgh…uvwxyz", data: { orderId: "0x1" } }))
      .toBe('🔵 [wti-1] exit YES abcdefgh…uvwxyz\norderId: "0x1"');
  });

  it("shortens a long market ref when no title is known", () => {
    const text = formatAlertText({ ...exit, market: { ref: "123456789012345678901234" } });
    expect(text).toContain("12345678…901234");
  });

  it("formats a loss", () => {
    expect(formatPnl({ usd: -3.1, pct: -4.2, basis: "realized" })).toBe("-$3.10 (-4.2%)");
    expect(formatPnl({ pct: 5, basis: "executable" })).toBe("+5.0%");
    expect(alertHeadline({ ...exit, pnl: { usd: -3.1, basis: "realized" } })).toBe("🔵 Exit  -$3.10");
  });

  it("drops the emoji for machine payloads", () => {
    expect(alertHeadline(exit, { emoji: false })).toBe("Exit +$12.40 (+8.3%)");
  });

  it("caps the text below Telegram's limit", () => {
    const text = formatAlertText({ ...exit, data: { blob: "x".repeat(10_000) } });
    expect(text.length).toBe(4000);
    expect(text.startsWith("🔵 Exit")).toBe(true);
  });

  it("maps engine reason codes to plain words", () => {
    expect(humanizeReason("synthetic-tp")).toBe("take-profit triggered");
    expect(humanizeReason("an operator note")).toBe("an operator note");
  });
});

describe("closingPnl", () => {
  it("prices a YES sale against the average cost, fee deducted from usd only", () => {
    expect(closingPnl(0.5, "YES", 100, 0.6, 1, "realized")).toEqual({ usd: 9, pct: 20, basis: "realized" });
  });

  it("flips the sign for a short cover", () => {
    expect(closingPnl(100, "SHORT", 2, 90, 0, "executable")).toEqual({ usd: 20, pct: 10, basis: "executable" });
  });

  it("returns nothing without a usable entry price", () => {
    expect(closingPnl(0, "YES", 10, 0.5, 0, "realized")).toBeUndefined();
    expect(closingPnl(undefined, "YES", 10, 0.5, 0, "realized")).toBeUndefined();
  });
});

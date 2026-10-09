// packages/core/test/sports-hold.test.ts
import { describe, expect, it, vi } from "vitest";
import { BotConfigSchema } from "../src/config.js";
import { MemoryStateStore } from "../src/state.js";
import { SPORTS_HOLD_KEY, SportsHoldGuard } from "../src/engine/sports-hold.js";
import type { MarketMetadata } from "../src/types.js";

const START = Date.UTC(2026, 9, 8, 20);
function setup(config: Record<string, unknown> = {}) {
  let now = START;
  const state = new MemoryStateStore();
  const metadata = vi.fn(async (): Promise<MarketMetadata[]> => [{ marketRef: "game", sports: { gameKey: "nfl:game", kickoffAt: START + 60_000 } }, { marketRef: "other" }]);
  const deps = { config: BotConfigSchema.parse({ id: "sports", venue: "polymarket", strategy: { id: "signals", config } }), state,
    signals: { latest: async () => [], marketMetadata: metadata }, now: () => now,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  return { guard: new SportsHoldGuard(deps), deps, state, metadata, advance: (ms: number) => { now += ms; } };
}

describe("sports hold after kickoff", () => {
  it("allows pregame trading and blocks at kickoff without waiting for another refresh", async () => {
    const h = setup(); await h.guard.refresh(["game", "other"]);
    expect(h.guard.isHeld("game")).toBe(false);
    h.advance(60_000);
    expect(h.guard.isHeld("game")).toBe(true);
    expect(h.guard.isHeld("other")).toBe(false);
  });

  it("survives feed removal, an outage and a restart, and cannot be cleared by rescheduling after kickoff", async () => {
    const h = setup(); await h.guard.refresh(["game"]); h.advance(60_000);
    h.metadata.mockResolvedValue([{ marketRef: "game", sports: { kickoffAt: START + 600_000, inPlay: false } }]);
    await h.guard.refresh(["game"]);
    h.metadata.mockRejectedValue(new Error("gateway unavailable"));
    const restarted = new SportsHoldGuard(h.deps); await restarted.refresh(["game"]);
    expect(restarted.isHeld("game")).toBe(true);
    expect(JSON.parse((await h.state.get(SPORTS_HOLD_KEY))!).markets.game.started).toBe(true);
  });

  it("latches an early in-play status, even before the scheduled time", async () => {
    const h = setup(); h.metadata.mockResolvedValue([{ marketRef: "game", sports: { kickoffAt: START + 600_000, inPlay: true } }]);
    await h.guard.refresh(["game"]); expect(h.guard.isHeld("game")).toBe(true);
  });

  it("defers known sports with unknown kickoff and unclassified markets, then resumes a confirmed pregame market", async () => {
    const h = setup(); h.metadata.mockResolvedValue([{ marketRef: "game", sports: {} }]);
    await h.guard.refresh(["game", "missing"]);
    expect(h.guard.isHeld("game")).toBe(true); expect(h.guard.isHeld("missing")).toBe(true);
    h.metadata.mockResolvedValue([{ marketRef: "game", sports: { kickoffAt: START + 60_000 } }, { marketRef: "missing" }]);
    await h.guard.refresh(["game", "missing"]);
    expect(h.guard.isHeld("game")).toBe(false); expect(h.guard.isHeld("missing")).toBe(false);
  });

  it("retains a game identity when later lookup rows omit sports metadata", async () => {
    const h = setup(); await h.guard.refresh(["game"]);
    h.metadata.mockResolvedValue([{ marketRef: "game" }]); h.advance(60_000); await h.guard.refresh(["game"]);
    expect(h.guard.isHeld("game")).toBe(true);
  });

  it("can be explicitly disabled without changing other exit rules", async () => {
    const h = setup({ sportsHoldAfterStart: false }); h.advance(60_000); await h.guard.refresh(["game"]);
    expect(h.guard.isHeld("game")).toBe(false); expect(h.metadata).not.toHaveBeenCalled();
  });
});

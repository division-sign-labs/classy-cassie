// packages/core/test/strategy-rules.test.ts
// Served strategy rules: fetched behind the strategy key, persisted, served
// from the last good copy through an outage, and applied over the operator
// config so rule keys in a saved bot config cannot loosen the strategy.

import { describe, expect, it, vi } from "vitest";
import { MemoryStateStore, silentLogger } from "@quotient-forecasting/cassie-core";
import {
  StrategyRulesClient,
  checkStrategyKeyAccess,
  fetchStrategyRules,
  strategyRulesPath,
  strategyRulesStateKey,
  usesStrategyKey,
} from "../src/quotient/strategy-rules.js";
import { QuotientApiError } from "../src/quotient/retry.js";
import { FLIP_FLAT_RULE_KEYS, resolveFlipFlatConfig, stripFlipFlatRules } from "../../../strategies/flip-flat/dist/index.js";

const BASE = "https://gateway.test";
const KEY = "qsk_" + "0".repeat(48);

function document(version: number, rules: Record<string, unknown> = { convergenceExitPp: 2, maxHoldDays: 5 }) {
  return { strategyId: "signals", version, updatedAt: `2026-09-0${version}T00:00:00Z`, rules };
}

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => body, text: async () => JSON.stringify(body) };
}

describe("strategy rules endpoint", () => {
  it("maps both strategy ids to the signals rule set and sends the strategy key", async () => {
    const fetchImpl = vi.fn(async () => respond(200, document(1)));
    await expect(fetchStrategyRules({ baseUrl: BASE }, "flip-flat", KEY, fetchImpl as never)).resolves.toMatchObject({ version: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/v1/strategies/signals/rules`);
    expect((init.headers as Record<string, string>)["x-quotient-api-key"]).toBe(KEY);
    expect(strategyRulesPath("signals")).toBe("/api/v1/strategies/signals/rules");
    expect(usesStrategyKey("signals")).toBe(true);
    expect(usesStrategyKey("agent")).toBe(false);
  });

  it("surfaces a rejected key as an unauthorized error", async () => {
    const fetchImpl = vi.fn(async () => respond(403, { error: "route_not_in_strategy_scope" }));
    await expect(checkStrategyKeyAccess({ baseUrl: BASE }, "signals", KEY, fetchImpl as never)).rejects.toMatchObject({ status: 403, unauthorized: true });
  });
});

describe("StrategyRulesClient", () => {
  it("fetches once per refresh window, persists the document, and reports the version", async () => {
    let now = 1_000_000;
    const state = new MemoryStateStore();
    const fetchImpl = vi.fn(async () => respond(200, document(3)));
    const client = new StrategyRulesClient({ baseUrl: BASE, strategyId: "signals", key: KEY, state, fetchImpl: fetchImpl as never, now: () => now, refreshMs: 60_000 });

    await expect(client.current()).resolves.toMatchObject({ version: 3 });
    now += 59_999;
    await expect(client.current()).resolves.toMatchObject({ version: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.version()).toBe(3);
    expect(JSON.parse((await state.get(strategyRulesStateKey("signals")))!)).toMatchObject({ version: 3 });

    now += 1;
    await client.current();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("serves the last good document through an outage and the persisted one across a restart", async () => {
    let now = 1_000_000;
    const state = new MemoryStateStore();
    const responses: Array<() => ReturnType<typeof respond>> = [() => respond(200, document(4))];
    const fetchImpl = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("fetch failed");
      return next();
    });
    const retry = { sleep: async () => {} };
    const client = new StrategyRulesClient({ baseUrl: BASE, strategyId: "signals", key: KEY, state, fetchImpl: fetchImpl as never, now: () => now, refreshMs: 60_000, retry, log: silentLogger });
    await expect(client.current()).resolves.toMatchObject({ version: 4 });

    now += 60_000;
    await expect(client.current()).resolves.toMatchObject({ version: 4 });
    expect(fetchImpl).toHaveBeenCalledTimes(1 + 3);

    // A fresh process during the same outage starts on the persisted copy.
    const restarted = new StrategyRulesClient({ baseUrl: BASE, strategyId: "signals", key: KEY, state, fetchImpl: fetchImpl as never, now: () => now, refreshMs: 60_000, retry, log: silentLogger });
    await expect(restarted.current()).resolves.toMatchObject({ version: 4 });
  });

  it("returns nothing when no document was ever fetched, and does not retry a revoked key", async () => {
    const fetchImpl = vi.fn(async () => respond(401, { error: "invalid_strategy_key" }));
    const client = new StrategyRulesClient({ baseUrl: BASE, strategyId: "signals", key: KEY, fetchImpl: fetchImpl as never, log: silentLogger, retry: { sleep: async () => {} } });
    await expect(client.current()).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(client.require()).rejects.toBeInstanceOf(QuotientApiError);
  });
});

describe("served rules over operator config", () => {
  it("lets served rules override rule keys in the saved config while operator keys stay", () => {
    const config = { marketCapPct: 4, entrySpreadPp: 1, convergenceExitPp: 0, maxHoldDays: 90 };
    const resolved = resolveFlipFlatConfig({ config, rules: { entrySpreadPp: 12, convergenceExitPp: 3, maxHoldDays: 7 } });
    expect(resolved).toMatchObject({ marketCapPct: 4, entrySpreadPp: 12, convergenceExitPp: 3, maxHoldDays: 7 });
  });

  it("falls back to compiled defaults only when no rules are supplied", () => {
    expect(resolveFlipFlatConfig({ config: {} })).toMatchObject({ entrySpreadPp: 10, maxHoldDays: 7 });
    expect(resolveFlipFlatConfig({ config: {}, rules: {} })).toMatchObject({ entrySpreadPp: 10 });
  });

  it("rejects a malformed rules document instead of trading on it", () => {
    expect(() => resolveFlipFlatConfig({ config: {}, rules: { maxHoldDays: -1 } })).toThrow();
  });

  it("strips every rule key from an operator config", () => {
    const config: Record<string, unknown> = { topN: 3 };
    for (const key of FLIP_FLAT_RULE_KEYS) config[key] = 1;
    expect(stripFlipFlatRules(config)).toEqual({ topN: 3 });
  });
});

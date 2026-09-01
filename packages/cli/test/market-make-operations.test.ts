// packages/cli/test/market-make-operations.test.ts

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseBotConfig, type BotConfig } from "@quotient-forecasting/cassie-core";
import {
  MARKET_MAKE_PRESET,
  marketMakeConfigHash,
} from "@quotient-forecasting/strategy-market-make";
import {
  createMarketMakeCommandHandlers,
  type MarketMakeCommandDependencies,
} from "../src/commands/market-make.js";
import { assertGenericOrderMutationAllowed } from "../src/commands/ops.js";

function deployedBot(): BotConfig {
  return parseBotConfig({
    id: "maker-1",
    venue: "polymarket",
    strategy: { id: "market-make", config: MARKET_MAKE_PRESET },
    deployment: {
      provider: "digitalocean",
      dropletId: 123,
      host: "203.0.113.10",
      region: "sgp1",
      size: "s-1vcpu-1gb",
      user: "root",
    },
  });
}

function harness(confirmResult: boolean, statusOverrides: Record<string, unknown> = {}) {
  const proposalHash = "a".repeat(64);
  const bot = deployedBot();
  const calls: Array<{ path: string; init?: { method?: "GET" | "POST"; body?: string } }> = [];
  const control = vi.fn(async (_config: BotConfig, path: string, init?: { method?: "GET" | "POST"; body?: string }) => {
    calls.push({ path, init });
    if (path.endsWith("/status")) {
      return {
        lifecycle: "HALTED",
        configHash: marketMakeConfigHash(MARKET_MAKE_PRESET),
        activeMarkets: 2,
        liveOrders: 3,
        deployedUsd: 41.25,
        freeCollateralUsd: 458.75,
        ...statusOverrides,
      };
    }
    if (path.endsWith("/reconcile")) {
      return {
        applied: JSON.parse(init?.body ?? "{}").apply === true,
        proposalHash,
        proposals: { unknownOrdersToCancel: [], residualInventory: [] },
      };
    }
    return { ok: true };
  });
  const confirm = vi.fn(async () => confirmResult);
  const log = vi.fn();
  const saveConfig = vi.fn();
  const deps: Partial<MarketMakeCommandDependencies> = {
    loadConfig: () => bot,
    saveConfig,
    control,
    confirm,
    localRuntimeAvailable: () => true,
    log,
  };
  return { handlers: createMarketMakeCommandHandlers(deps), calls, confirm, control, log, saveConfig };
}

describe("market-make operational confirmations", () => {
  it("blocks generic local and deployed order cancellation before it can bypass durable reservations", () => {
    const local = parseBotConfig({
      id: "local-maker",
      venue: "polymarket",
      strategy: { id: "market-make", config: MARKET_MAKE_PRESET },
    });
    for (const bot of [local, deployedBot()]) {
      expect(() => assertGenericOrderMutationAllowed(bot, { cancel: "order-1" })).toThrow(
        /disabled for market-make.*durable reservations/,
      );
      expect(() => assertGenericOrderMutationAllowed(bot, { cancelAll: true })).toThrow(
        /cassie market-make halt/,
      );
      expect(() => assertGenericOrderMutationAllowed(bot, {})).not.toThrow();
    }
  });

  it("does not halt or liquidate when the operator declines", async () => {
    const { handlers, calls, confirm } = harness(false);
    await handlers.halt("maker-1", { liquidate: true });

    expect(confirm).toHaveBeenCalledOnce();
    expect(String(confirm.mock.calls[0]?.[0])).toMatch(/urgent bounded exits/i);
    expect(String(confirm.mock.calls[0]?.[0])).toContain("2 active markets");
    expect(calls).toEqual([{ path: "/market-make/status", init: undefined }]);
  });

  it("sends the exact liquidation intent only after confirmation", async () => {
    const { handlers, calls } = harness(true);
    await handlers.halt("maker-1", { liquidate: true });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      path: "/market-make/halt",
      init: { method: "POST", body: JSON.stringify({ liquidate: true }) },
    });
  });

  it("refuses liquidation under configuration drift while leaving plain halt available", async () => {
    const drifted = harness(true, { configHash: "different-runtime-config" });
    await expect(drifted.handlers.halt("maker-1", { liquidate: true })).rejects.toThrow(
      /refusing liquidation with configuration drift/,
    );
    expect(drifted.confirm).not.toHaveBeenCalled();

    await drifted.handlers.halt("maker-1");
    expect(drifted.calls.at(-1)).toEqual({
      path: "/market-make/halt",
      init: { method: "POST", body: JSON.stringify({ liquidate: false }) },
    });
  });

  it("keeps reconciliation report-only without prompting", async () => {
    const { handlers, calls, confirm } = harness(false);
    await handlers.reconcile("maker-1");

    expect(confirm).not.toHaveBeenCalled();
    expect(calls[1]).toEqual({
      path: "/market-make/reconcile",
      init: { method: "POST", body: JSON.stringify({ apply: false }) },
    });
  });

  it("does not apply reconciliation changes when confirmation is declined", async () => {
    const { handlers, calls, confirm } = harness(false);
    await handlers.reconcile("maker-1", { apply: true });

    expect(confirm).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      { path: "/market-make/status", init: undefined },
      {
        path: "/market-make/reconcile",
        init: { method: "POST", body: JSON.stringify({ apply: false }) },
      },
    ]);
  });

  it("applies only the exact proposal hash returned by the reviewed preview", async () => {
    const { handlers, calls, confirm, log } = harness(true);
    await handlers.reconcile("maker-1", { apply: true });

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      proposalHash: "a".repeat(64),
      proposals: { unknownOrdersToCancel: [], residualInventory: [] },
    });
    expect(String(confirm.mock.calls[0]?.[0])).toContain("a".repeat(64));
    expect(calls[2]).toEqual({
      path: "/market-make/reconcile",
      init: {
        method: "POST",
        body: JSON.stringify({ apply: true, expectedProposalHash: "a".repeat(64) }),
      },
    });
  });

  it("refuses an invalid proposal hash returned by the runtime", async () => {
    const { handlers, control, confirm } = harness(true);
    control.mockImplementation(async (_config, path, init) => {
      if (path.endsWith("/status")) return { lifecycle: "HALTED" };
      return {
        applied: false,
        proposalHash: "not-a-sha256",
        proposals: { unknownOrdersToCancel: [], residualInventory: [] },
      };
    });

    await expect(handlers.reconcile("maker-1", { apply: true })).rejects.toThrow(
      /valid SHA-256 proposal hash/,
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("never resumes live trading when the operator declines", async () => {
    const { handlers, calls, confirm } = harness(false);
    await handlers.resume("maker-1");

    expect(confirm).toHaveBeenCalledOnce();
    expect(String(confirm.mock.calls[0]?.[0])).toMatch(/resume live market-making/i);
    expect(calls).toEqual([{ path: "/market-make/status", init: undefined }]);
  });

  it("allows the first explicit resume while activation is intentionally not current", async () => {
    const { handlers, calls } = harness(true, { activationCurrent: false });

    await handlers.resume("maker-1");

    expect(calls[1]).toEqual({
      path: "/market-make/resume",
      init: { method: "POST", body: JSON.stringify({ acknowledgeLossReset: false }) },
    });
  });
});

describe("market-make configure drift messaging", () => {
  it("shows that funded capital is automatic without requiring a bankroll setting", async () => {
    const { handlers, saveConfig, log } = harness(true);

    await handlers.configure("maker-1");

    expect(saveConfig).not.toHaveBeenCalled();
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("live funded capital (automatic)");
    expect(output).toContain("ceiling none");
    expect(output).toContain("reference bankroll:   $500.00");
  });

  it("shows observed and effective live bankroll in status", async () => {
    const { handlers, log } = harness(true, {
      bankrollMode: "live",
      bankrollObserved: true,
      bankrollEntryReady: true,
      strategyCapitalUsd: 10_000,
      effectiveBankrollUsd: 7_500,
      bankrollCeilingUsd: 7_500,
      bankrollScale: 15,
    });

    await handlers.status("maker-1");

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("automatic — $10000.00 funded, $7500.00 effective (15.000x reference)");
    expect(output).toContain("ceiling $7500.00");
    expect(output).toContain("entries authorized");
  });

  it("saves atomically through the config helper and warns that a deployment is stale", async () => {
    const { handlers, saveConfig, log } = harness(true);
    await handlers.configure("maker-1", { baseOrderUsd: "13" });

    expect(saveConfig).toHaveBeenCalledOnce();
    const saved = saveConfig.mock.calls[0]?.[0] as BotConfig;
    expect((saved.strategy.config as { capital: { base_order_notional_usd: number } }).capital.base_order_notional_usd).toBe(13);
    expect(log.mock.calls.flat().join("\n")).toMatch(/deployed runtime still has its prior config/);
    expect(log.mock.calls.flat().join("\n")).toMatch(/remain halted/);
  });

  it("warns that an already-running local runtime must be restarted", async () => {
    const local = parseBotConfig({
      id: "local-maker",
      venue: "polymarket",
      strategy: { id: "market-make", config: MARKET_MAKE_PRESET },
    });
    const log = vi.fn();
    const handlers = createMarketMakeCommandHandlers({
      loadConfig: () => local,
      saveConfig: vi.fn(),
      localRuntimeAvailable: () => true,
      log,
    });

    await handlers.configure("local-maker", { baseOrderUsd: "13" });

    const output = log.mock.calls.flat().join("\n");
    expect(output).toMatch(/running local runtime still has its prior config/);
    expect(output).toContain("cassie run local-maker");
    expect(output).toMatch(/remain halted/);
  });
});

describe("market-make offline replay", () => {
  it("runs a strict JSON bundle without contacting a bot runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "cassie-market-make-replay-"));
    try {
      const input = join(root, "bundle.json");
      writeFileSync(
        input,
        JSON.stringify({
          schemaVersion: "cassie-market-make-replay/1",
          generatedAt: "2026-08-31T00:00:00.000Z",
          source: "cli-test",
          events: [],
        }),
      );
      const { handlers, control, log } = harness(true);

      await handlers.replay({ input, fillModel: "queue" });

      expect(control).not.toHaveBeenCalled();
      const report = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
        fillModel: string;
        eventsProcessed: number;
      };
      expect(report).toMatchObject({ fillModel: "queue", eventsProcessed: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

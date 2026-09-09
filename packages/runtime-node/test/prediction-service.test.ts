// packages/runtime-node/test/prediction-service.test.ts
// Slow strategy work must not delay directional order supervision or heartbeat.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotConfigSchema, type VenueAccount } from "@quotient-forecasting/cassie-core";
import { BotService } from "../src/service.js";

const doubles = vi.hoisted(() => ({ engine: vi.fn(), adapter: vi.fn() }));
vi.mock("@quotient-forecasting/cassie-core", async importOriginal => ({
  ...await importOriginal<typeof import("@quotient-forecasting/cassie-core")>(),
  Engine: class { constructor(...args: unknown[]) { return doubles.engine(...args); } },
  createAdapter: doubles.adapter,
}));
vi.mock("../src/swing-controller.js", () => ({ SwingController: class {} }));

const account: VenueAccount = { venue: "polymarket", signerAddress: "0x0000000000000000000000000000000000000001",
  funder: "0x0000000000000000000000000000000000000002", signatureType: 3 };

describe("adaptive execution runtime lanes", () => {
  let dir: string;
  let service: BotService | undefined;
  let finishTick: (() => void) | undefined;
  let engine: ReturnType<typeof engineDouble>;
  function engineDouble() {
    return {
      adaptivePredictionExecution: true,
      recoverPredictions: vi.fn().mockResolvedValue(undefined),
      resumePredictions: vi.fn().mockResolvedValue(undefined),
      beginPredictionShutdown: vi.fn().mockResolvedValue(undefined),
      drainRedemptions: vi.fn().mockResolvedValue(undefined),
      predictionStatus: vi.fn().mockResolvedValue({ parents: [], blocked: false, dailySpentUsd: {}, entryCooldowns: {} }),
      supervisePredictions: vi.fn().mockResolvedValue(undefined),
      checkTriggers: vi.fn().mockResolvedValue(undefined),
      heartbeatIfResting: vi.fn().mockResolvedValue(true),
      cancelAllResting: vi.fn().mockResolvedValue(undefined),
      cancelPredictionOrder: vi.fn().mockResolvedValue(true),
      tick: vi.fn().mockImplementation(() => new Promise(resolve => { finishTick = () => resolve({ ordersPlaced: 0 }); })),
    };
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "cassie-prediction-service-"));
    engine = engineDouble();
    doubles.engine.mockReturnValue(engine);
    doubles.adapter.mockReturnValue({ cancelAll: vi.fn(), openOrders: vi.fn().mockResolvedValue([]) });
    service = new BotService({ config: BotConfigSchema.parse({ id: "adaptive-test", venue: "polymarket",
      strategy: { id: "signals", config: {} }, tickIntervalMin: 1,
      reporting: { provider: "ares", builderCode: "0x" + "a".repeat(64) } }),
      account, statePath: join(dir, "bot.sqlite"), runtime: "local", quotientToken: "test-token",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } });
  });
  afterEach(async () => {
    finishTick?.();
    await service?.shutdown();
    service = undefined;
    finishTick = undefined;
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("recovers before ticking and keeps both five-second lanes independent of a blocked strategy", async () => {
    await service!.start();
    expect(engine.recoverPredictions).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.tick).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.supervisePredictions).toHaveBeenCalledTimes(2);
    expect(engine.heartbeatIfResting).toHaveBeenCalledTimes(2);
    expect(service!.status()).toHaveProperty("execution.blocked", false);
    expect(doubles.adapter.mock.calls[0]![1]).not.toHaveProperty("builderCode");
  });

  it("continues supervision while paused and sends order cancellation through its parent", async () => {
    await service!.start();
    await service!.pause();
    expect(await service!.paused()).toBe(true);
    expect(engine.supervisePredictions).toHaveBeenCalledOnce();
    await service!.cancelOrder("child-order");
    expect(engine.cancelPredictionOrder).toHaveBeenCalledWith("child-order");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.supervisePredictions).toHaveBeenCalledTimes(2);
  });

  it("prevents overlapping supervision calls while heartbeat remains available", async () => {
    let finishSupervision!: () => void;
    engine.supervisePredictions.mockImplementation(() => new Promise<void>(resolve => { finishSupervision = resolve; }));
    await service!.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(engine.supervisePredictions).toHaveBeenCalledOnce();
    expect(engine.heartbeatIfResting).toHaveBeenCalledTimes(3);
    finishSupervision();
  });

  it("keeps SQLite open for late redemption receipts after bounded shutdown", async () => {
    const state = (service as unknown as { state: { close(): void; set(key: string, value: string): Promise<void>; get(key: string): Promise<string | null> } }).state;
    const close = vi.spyOn(state, "close");
    let finishRedemption!: () => void;
    engine.drainRedemptions.mockImplementation(() => new Promise<void>(resolve => { finishRedemption = resolve; }));
    const shutdown = service!.shutdown();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(shutdown).resolves.toMatchObject({ stopped: true });
    expect(close).not.toHaveBeenCalled();
    await state.set("engine:redemption:condition", JSON.stringify({ status: "confirmed", receipt: { transactionId: "late-receipt" } }));
    expect(await state.get("engine:redemption:condition")).toContain("late-receipt");
    finishRedemption(); await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it("latches shutdown before waiting for a delayed strategy tick", async () => {
    await service!.start();
    await vi.advanceTimersByTimeAsync(1);
    const shutdown = service!.shutdown();
    expect(engine.beginPredictionShutdown).toHaveBeenCalledOnce();
    expect(engine.cancelAllResting).not.toHaveBeenCalled();
    finishTick!();
    await shutdown;
    expect(engine.cancelAllResting).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

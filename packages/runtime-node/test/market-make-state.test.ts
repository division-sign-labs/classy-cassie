// packages/runtime-node/test/market-make-state.test.ts

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MARKET_MAKE_SCHEMA_VERSION,
  MarketMakeStateStore,
  marketMakeActivationHash,
} from "../src/market-make-state.js";

const BASE_TS = 2_000_000_000_000;

describe("MarketMakeStateStore", () => {
  let dir: string;
  let path: string;
  let store: MarketMakeStateStore | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cassie-mm-state-"));
    path = join(dir, "bot.sqlite");
  });

  afterEach(() => {
    store?.close();
    store = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function open(options?: { maxEvents?: number; maxEventAgeMs?: number }): MarketMakeStateStore {
    store = new MarketMakeStateStore(path, options);
    return store;
  }

  function closeAndReopen(options?: { maxEvents?: number; maxEventAgeMs?: number }): MarketMakeStateStore {
    store!.close();
    store = new MarketMakeStateStore(path, options);
    return store;
  }

  function reconcile(
    state: MarketMakeStateStore,
    ts = BASE_TS + 1,
    input: { collateral?: number; tokenQuantity?: number; openOrders?: Parameters<typeof state.reconcileSnapshot>[0]["openOrders"] } = {},
  ): void {
    state.reconcileSnapshot({
      reconciliationId: `reconcile-${ts}`,
      ts,
      collateralTotalUsd: input.collateral ?? 500,
      balances: [
        {
          tokenId: "yes-token",
          marketKey: "market-1",
          outcome: "YES",
          totalQuantity: input.tokenQuantity ?? 10,
        },
      ],
      openOrders: input.openOrders ?? [],
    });
  }

  it("applies additive versioned migrations without changing legacy kv/errors data", () => {
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL,
        code TEXT NOT NULL,
        venue TEXT,
        message TEXT NOT NULL,
        context TEXT,
        tick_seq INTEGER
      );
      INSERT INTO kv (key, value) VALUES ('paused', 'true');
      INSERT INTO errors (ts, level, code, message) VALUES (1, 'error', 'old', 'preserved');
    `);
    legacy.close();

    const state = open();
    expect(state.schemaVersion()).toBe(MARKET_MAKE_SCHEMA_VERSION);
    expect(state.status()).toMatchObject({ lifecycle: "BOOTSTRAP", schemaVersion: 1 });
    state.close();
    store = undefined;

    const inspected = new Database(path, { readonly: true });
    expect(inspected.prepare("SELECT value FROM kv WHERE key = 'paused'").pluck().get()).toBe("true");
    expect(inspected.prepare("SELECT message FROM errors WHERE code = 'old'").pluck().get()).toBe("preserved");
    expect(inspected.prepare("SELECT COUNT(*) FROM mm_schema_migrations").pluck().get()).toBe(1);
    inspected.close();
  });

  it("records fills idempotently and never moves a first-fill anchor", () => {
    const state = open();
    reconcile(state);
    state.reserveOrder({
      clientOrderId: "entry-1",
      marketKey: "market-1",
      cycleId: "cycle-1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "BUY",
      purpose: "ADD",
      quantity: 5,
      limitPrice: 0.41,
      tif: "GTC",
      postOnly: true,
      now: BASE_TS + 2,
    });
    state.recordSignedOrderHash("entry-1", "signed-hash-1", BASE_TS + 3);
    state.markOrderSubmitting("entry-1", BASE_TS + 4);
    state.acknowledgeOrder("entry-1", "venue-1", BASE_TS + 5);

    const first = state.recordFill({
      fillId: "fill-1",
      clientOrderId: "entry-1",
      quantity: 2,
      price: 0.4,
      ts: BASE_TS + 6,
      anchorQVersion: "q-v1",
      anchorQProbability: 0.65,
    });
    const duplicate = state.recordFill({
      fillId: "fill-1",
      clientOrderId: "entry-1",
      quantity: 2,
      price: 0.4,
      ts: BASE_TS + 6,
      anchorQVersion: "q-v1",
      anchorQProbability: 0.65,
    });
    state.recordFill({
      fillId: "fill-2",
      clientOrderId: "entry-1",
      quantity: 1,
      price: 0.39,
      ts: BASE_TS + 7,
      anchorQVersion: "q-v2",
      anchorQProbability: 0.8,
    });

    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(state.getOrder("entry-1")).toMatchObject({
      status: "PARTIALLY_FILLED",
      filledQuantity: 3,
      reservedCashUsd: 0.82,
    });
    expect(state.getInventoryCycle("cycle-1")).toMatchObject({
      quantity: 3,
      firstFillAt: BASE_TS + 6,
      anchorQVersion: "q-v1",
      anchorQProbability: 0.65,
      anchorExecutionPrice: 0.4,
    });

    const reopened = closeAndReopen();
    expect(reopened.getInventoryCycle("cycle-1")).toMatchObject({
      quantity: 3,
      anchorQVersion: "q-v1",
      anchorExecutionPrice: 0.4,
    });
    expect(() =>
      reopened.recordFill({
        fillId: "fill-1",
        clientOrderId: "entry-1",
        quantity: 1,
        price: 0.4,
        ts: BASE_TS + 8,
      }),
    ).toThrow(/already recorded differently/);
  });

  it("reconciles an active inventory quantity idempotently and closes it at zero", () => {
    const state = open();
    state.createInventoryCycle({
      cycleId: "cycle-reconcile",
      marketKey: "market-1",
      outcome: "YES",
      tokenId: "yes-token",
      quantity: 5,
      costBasisUsd: 2.5,
      firstFillAt: BASE_TS,
      anchorQVersion: "q-v1",
      anchorQProbability: 0.7,
      anchorExecutionPrice: 0.5,
      createdAt: BASE_TS,
    });

    const changed = state.reconcileInventoryQuantity({
      marketKey: "market-1",
      tokenId: "yes-token",
      quantity: 4,
      costBasisUsd: 1.8,
      now: BASE_TS + 1,
    });
    expect(changed).toMatchObject({
      applied: true,
      inventory: { cycleId: "cycle-reconcile", status: "OPEN", quantity: 4, costBasisUsd: 1.8 },
    });

    const repeated = state.reconcileInventoryQuantity({
      marketKey: "market-1",
      tokenId: "yes-token",
      quantity: 4,
      costBasisUsd: 1.8,
      now: BASE_TS + 2,
    });
    expect(repeated).toMatchObject({ applied: false, inventory: { updatedAt: BASE_TS + 1 } });

    expect(state.reconcileInventoryQuantity({
      marketKey: "market-1",
      tokenId: "yes-token",
      quantity: 0,
      now: BASE_TS + 3,
    })).toMatchObject({
      applied: true,
      inventory: { status: "CLOSED", quantity: 0, costBasisUsd: 0, closedAt: BASE_TS + 3 },
    });
    expect(state.reconcileInventoryQuantity({
      marketKey: "market-1",
      tokenId: "yes-token",
      quantity: 0,
      now: BASE_TS + 4,
    })).toEqual({ applied: false });
    expect(state.listInventoryCycles(true)).toEqual([]);
    expect(() => state.reconcileInventoryQuantity({
      marketKey: "market-1",
      tokenId: "yes-token",
      quantity: 1,
      now: BASE_TS + 5,
    })).toThrow(/no active inventory cycle/);
  });

  it("refuses opposite-token and ambiguous active inventory reconciliation", () => {
    const state = open();
    state.createInventoryCycle({
      cycleId: "cycle-yes",
      marketKey: "market-1",
      outcome: "YES",
      tokenId: "yes-token",
      quantity: 2,
      costBasisUsd: 1,
      firstFillAt: BASE_TS,
      anchorQVersion: "q-v1",
      anchorQProbability: 0.7,
      anchorExecutionPrice: 0.5,
      createdAt: BASE_TS,
    });
    expect(() => state.reconcileInventoryQuantity({
      marketKey: "market-1",
      tokenId: "no-token",
      quantity: 2,
      now: BASE_TS + 1,
    })).toThrow(/active inventory token yes-token conflicts with no-token/);

    state.close();
    store = undefined;
    const corrupted = new Database(path);
    corrupted.exec(`
      DROP INDEX mm_inventory_active_market_uq;
      INSERT INTO mm_inventory_cycles (
        cycle_id, market_key, outcome, token_id, status, quantity, cost_basis_usd,
        first_fill_at, anchor_q_version, anchor_q_probability, anchor_execution_price,
        renewal_used, created_at, updated_at
      ) VALUES (
        'cycle-no', 'market-1', 'NO', 'no-token', 'RESIDUAL', 1, 0.6,
        ${BASE_TS}, 'q-v1', 0.3, 0.6, 0, ${BASE_TS}, ${BASE_TS}
      );
    `);
    corrupted.close();

    const reopened = open();
    expect(() => reopened.reconcileInventoryQuantity({
      marketKey: "market-1",
      tokenId: "yes-token",
      quantity: 2,
      now: BASE_TS + 2,
    })).toThrow(/multiple active inventory cycles are ambiguous/);
  });

  it("retains cancel-pending quantity reservations through partial fills", () => {
    const state = open();
    reconcile(state, BASE_TS + 1, { tokenQuantity: 10 });
    state.reserveOrder({
      clientOrderId: "sell-1",
      marketKey: "market-1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "SELL",
      purpose: "UNKNOWN",
      quantity: 5,
      limitPrice: 0.6,
      tif: "GTC",
      postOnly: true,
      now: BASE_TS + 2,
    });
    state.acknowledgeOrder("sell-1", "venue-sell-1", BASE_TS + 3);
    state.requestCancel("sell-1", BASE_TS + 4);

    expect(state.availability("yes-token").tokens[0]).toMatchObject({
      totalQuantity: 10,
      reservedQuantity: 5,
      freeQuantity: 5,
    });
    state.recordFill({
      fillId: "cancel-race-fill",
      clientOrderId: "sell-1",
      quantity: 2,
      price: 0.6,
      ts: BASE_TS + 5,
    });
    expect(state.getOrder("sell-1")).toMatchObject({
      status: "CANCEL_PENDING",
      filledQuantity: 2,
      reservedQuantity: 3,
    });
    expect(state.availability("yes-token").tokens[0]).toMatchObject({ reservedQuantity: 3, freeQuantity: 7 });

    state.confirmCancellation("sell-1", BASE_TS + 6);
    expect(state.getOrder("sell-1")).toMatchObject({ status: "CANCELED", reservedQuantity: 0 });
    expect(state.availability("yes-token").tokens[0]).toMatchObject({ reservedQuantity: 0, freeQuantity: 10 });
  });

  it("binds activation to both deployment identity and configuration hash", () => {
    const state = open();
    state.setDeployment({ configHash: "config-a", deploymentId: "droplet-a", now: BASE_TS });
    expect(state.status()).toMatchObject({
      lifecycle: "HALTED",
      deploymentConfigHash: "config-a",
      activationCurrent: false,
    });
    reconcile(state, BASE_TS + 1);
    const active = state.resume({
      configHash: "config-a",
      deploymentId: "droplet-a",
      now: BASE_TS + 2,
    });
    expect(active).toMatchObject({
      lifecycle: "ACTIVE",
      activationConfigHash: "config-a",
      activationDeploymentId: "droplet-a",
      activationHash: marketMakeActivationHash("config-a", "droplet-a"),
      activationCurrent: true,
    });
    const reopened = closeAndReopen();
    expect(reopened.canRestoreActivation("config-a", "droplet-a")).toBe(true);

    reopened.setDeployment({ configHash: "config-b", deploymentId: "droplet-a", now: BASE_TS + 3 });
    expect(reopened.status()).toMatchObject({
      lifecycle: "HALTED",
      deploymentConfigHash: "config-b",
      activationHash: undefined,
      activationCurrent: false,
    });
    expect(reopened.canRestoreActivation("config-b", "droplet-a")).toBe(false);
  });

  it("keeps EXIT_BLOCKED above automatic halt, degradation, loss, reconciliation, and deployment changes", () => {
    let state = open();
    state.setDeployment({ configHash: "config-a", deploymentId: "droplet-a", now: BASE_TS });
    reconcile(state, BASE_TS + 1);
    state.resume({ configHash: "config-a", deploymentId: "droplet-a", now: BASE_TS + 2 });
    state.setExitOnlyLifecycle("EXIT_BLOCKED", "bounded exits exhausted", BASE_TS + 3);

    state = closeAndReopen();
    expect(state.status()).toMatchObject({
      lifecycle: "EXIT_BLOCKED",
      haltReason: "bounded exits exhausted",
      activationCurrent: false,
    });

    state.halt("automatic halt", BASE_TS + 4);
    state.setExitOnlyLifecycle("DATA_DEGRADED", "websocket stale", BASE_TS + 5);
    state.setExitOnlyLifecycle("RECONCILING", "automatic reconciliation", BASE_TS + 6);
    state.setExitOnlyLifecycle("RISK_EXIT_ONLY", "ordinary risk-only transition", BASE_TS + 7);
    state.latchLoss("rolling 24h loss limit", BASE_TS + 8);
    reconcile(state, BASE_TS + 9);
    state.setDeployment({ configHash: "config-b", deploymentId: "droplet-b", now: BASE_TS + 10 });
    reconcile(state, BASE_TS + 11);

    state = closeAndReopen();
    expect(state.status()).toMatchObject({
      lifecycle: "EXIT_BLOCKED",
      haltReason: "bounded exits exhausted",
      deploymentConfigHash: "config-b",
      deploymentId: "droplet-b",
      activationCurrent: false,
      loss: { latched: true, trigger: "rolling 24h loss limit" },
      lastReconciliation: { ts: BASE_TS + 11, ok: true },
    });
    expect(() => state.resume({
      configHash: "config-b",
      deploymentId: "droplet-b",
      now: BASE_TS + 12,
      acknowledgeLossReset: true,
    })).toThrow(/cannot resume directly from EXIT_BLOCKED/);
    // The failed transactional resume must not consume the explicit loss
    // acknowledgement while the stronger lifecycle still blocks activation.
    expect(state.status()).toMatchObject({
      lifecycle: "EXIT_BLOCKED",
      loss: { latched: true, trigger: "rolling 24h loss limit" },
    });
  });

  it("resets EXIT_BLOCKED only through the explicit operator liquidation transition", () => {
    let state = open();
    state.setDeployment({ configHash: "config-a", deploymentId: "local-a", now: BASE_TS });
    reconcile(state, BASE_TS + 1);
    state.resume({ configHash: "config-a", deploymentId: "local-a", now: BASE_TS + 2 });
    state.setExitOnlyLifecycle("EXIT_BLOCKED", "bounded exit liquidity exhausted", BASE_TS + 3);
    state = closeAndReopen();

    expect(state.resetExitBlockedForOperatorLiquidation(
      "operator requested reviewed liquidation",
      BASE_TS + 4,
    )).toMatchObject({
      lifecycle: "HALTED",
      haltReason: "operator requested reviewed liquidation",
      activationHash: undefined,
      activationCurrent: false,
    });
    expect(state.resume({
      configHash: "config-a",
      deploymentId: "local-a",
      now: BASE_TS + 5,
    })).toMatchObject({ lifecycle: "ACTIVE", activationCurrent: true });

    state.halt("ordinary operator halt", BASE_TS + 6);
    state.resetExitBlockedForOperatorLiquidation("must be a no-op outside EXIT_BLOCKED", BASE_TS + 7);
    expect(state.status()).toMatchObject({
      lifecycle: "HALTED",
      haltReason: "ordinary operator halt",
    });
  });

  it.each(["RESERVED", "SIGNED", "SUBMITTING", "UNKNOWN", "CANCEL_PENDING"] as const)(
    "refuses resume and activation restoration while a %s order is unresolved",
    (status) => {
      const state = open();
      state.setDeployment({ configHash: "config-a", deploymentId: "droplet-a", now: BASE_TS });
      reconcile(state, BASE_TS + 1);
      state.resume({ configHash: "config-a", deploymentId: "droplet-a", now: BASE_TS + 2 });
      state.reserveOrder({
        clientOrderId: "transition-order",
        marketKey: "market-1",
        tokenId: "yes-token",
        outcome: "YES",
        side: "BUY",
        purpose: "UNKNOWN",
        quantity: 5,
        limitPrice: 0.4,
        tif: "GTC",
        postOnly: true,
        now: BASE_TS + 3,
      });
      if (status !== "RESERVED") {
        state.recordSignedOrderHash("transition-order", "transition-hash", BASE_TS + 4);
      }
      if (["SUBMITTING", "UNKNOWN", "CANCEL_PENDING"].includes(status)) {
        state.markOrderSubmitting("transition-order", BASE_TS + 5);
      }
      if (status === "UNKNOWN") {
        state.markSubmissionUnknown("transition-order", "ambiguous POST", BASE_TS + 6);
      }
      if (status === "CANCEL_PENDING") {
        state.acknowledgeOrder("transition-order", "venue-transition", BASE_TS + 6);
        state.requestCancel("transition-order", BASE_TS + 7);
      }
      expect(state.getOrder("transition-order")?.status).toBe(status);
      expect(state.canRestoreActivation("config-a", "droplet-a")).toBe(false);
      expect(state.status().activationCurrent).toBe(false);

      state.halt("restart recovery", BASE_TS + 8);
      expect(() => state.resume({
        configHash: "config-a",
        deploymentId: "droplet-a",
        now: BASE_TS + 9,
      })).toThrow(/unresolved transitional orders remain/);
    },
  );

  it("allows reconciled open and partially-filled orders across activation", () => {
    const state = open();
    state.setDeployment({ configHash: "config-a", deploymentId: "droplet-a", now: BASE_TS });
    reconcile(state, BASE_TS + 1);
    for (const clientOrderId of ["open-order", "partial-order"]) {
      state.reserveOrder({
        clientOrderId,
        marketKey: "market-1",
        tokenId: "yes-token",
        outcome: "YES",
        side: "BUY",
        purpose: "UNKNOWN",
        quantity: 5,
        limitPrice: 0.4,
        tif: "GTC",
        postOnly: true,
        now: BASE_TS + 2,
      });
      state.acknowledgeOrder(clientOrderId, `venue-${clientOrderId}`, BASE_TS + 3);
    }
    state.recordFill({
      fillId: "partial-fill",
      clientOrderId: "partial-order",
      quantity: 2,
      price: 0.4,
      ts: BASE_TS + 4,
    });
    expect(state.listOrders({ activeOnly: true }).map((order) => order.status).sort()).toEqual([
      "OPEN",
      "PARTIALLY_FILLED",
    ]);

    expect(state.resume({
      configHash: "config-a",
      deploymentId: "droplet-a",
      now: BASE_TS + 5,
    })).toMatchObject({ lifecycle: "ACTIVE", activationCurrent: true });
    expect(state.canRestoreActivation("config-a", "droplet-a")).toBe(true);
  });

  it("persists a loss latch and requires explicit acknowledgement before resume", () => {
    const state = open();
    state.setDeployment({ configHash: "config-a", deploymentId: "local-a", now: BASE_TS });
    reconcile(state, BASE_TS + 1);
    state.resume({ configHash: "config-a", deploymentId: "local-a", now: BASE_TS + 2 });
    state.updateLossMark({
      now: BASE_TS + 3,
      rolling24hLossUsd: 21,
      drawdownUsd: 22,
      navUsd: 478,
      highWaterUsd: 500,
      marketKey: "market-1",
      marketLossUsd: 8.5,
    });
    state.latchLoss("rolling 24h loss limit", BASE_TS + 4);

    const reopened = closeAndReopen();
    expect(reopened.status()).toMatchObject({
      lifecycle: "RISK_EXIT_ONLY",
      loss: { latched: true, trigger: "rolling 24h loss limit", rolling24hLossUsd: 21 },
    });
    expect(() =>
      reopened.resume({ configHash: "config-a", deploymentId: "local-a", now: BASE_TS + 5 }),
    ).toThrow(/loss limit is latched/);
    expect(
      reopened.resume({
        configHash: "config-a",
        deploymentId: "local-a",
        now: BASE_TS + 6,
        acknowledgeLossReset: true,
      }),
    ).toMatchObject({ lifecycle: "ACTIVE", loss: { latched: false, rolling24hLossUsd: 0 } });
  });

  it("keeps signed and unknown submissions reserved across crashes until reconciliation", () => {
    const state = open();
    reconcile(state, BASE_TS + 1, { collateral: 100 });
    state.reserveOrder({
      clientOrderId: "crash-order",
      marketKey: "market-1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "BUY",
      purpose: "UNKNOWN",
      quantity: 10,
      limitPrice: 0.4,
      tif: "GTC",
      postOnly: true,
      now: BASE_TS + 2,
    });
    state.recordSignedOrderHash("crash-order", "signed-before-post", BASE_TS + 3);

    let reopened = closeAndReopen();
    expect(reopened.getOrder("crash-order")).toMatchObject({ status: "SIGNED", reservedCashUsd: 4 });
    reopened.markSubmissionUnknown("crash-order", "POST acknowledgement timed out", BASE_TS + 4);
    reopened = closeAndReopen();
    expect(reopened.getOrder("crash-order")).toMatchObject({
      status: "UNKNOWN",
      signedOrderHash: "signed-before-post",
      reservedCashUsd: 4,
    });

    reopened.reconcileSnapshot({
      reconciliationId: "reconcile-crash-open",
      ts: BASE_TS + 5,
      collateralTotalUsd: 100,
      balances: [],
      openOrders: [
        {
          clientOrderId: "crash-order",
          venueOrderId: "venue-crash-order",
          marketKey: "market-1",
          tokenId: "yes-token",
          outcome: "YES",
          side: "BUY",
          remainingQuantity: 10,
          limitPrice: 0.4,
        },
      ],
    });
    expect(reopened.getOrder("crash-order")).toMatchObject({
      status: "OPEN",
      venueOrderId: "venue-crash-order",
      reservedCashUsd: 4,
    });

    reopened.reconcileSnapshot({
      reconciliationId: "reconcile-crash-absent",
      ts: BASE_TS + 6,
      collateralTotalUsd: 100,
      balances: [],
      openOrders: [],
    });
    expect(reopened.getOrder("crash-order")).toMatchObject({ status: "CANCELED", reservedCashUsd: 0 });
  });

  it("keeps an order UNKNOWN until authoritative fills explain venue cumulative remaining", () => {
    const state = open();
    state.reserveOrder({
      clientOrderId: "partial-ack",
      marketKey: "market-1",
      tokenId: "yes-token",
      outcome: "YES",
      side: "BUY",
      purpose: "UNKNOWN",
      quantity: 10,
      limitPrice: 0.4,
      tif: "GTC",
      postOnly: true,
      now: BASE_TS,
    });
    state.recordSignedOrderHash("partial-ack", "partial-ack-hash", BASE_TS + 1);
    state.markOrderSubmitting("partial-ack", BASE_TS + 2);
    state.markSubmissionUnknown("partial-ack", "partial acknowledgement", BASE_TS + 3);

    state.reconcileSnapshot({
      reconciliationId: "reconcile-unexplained-partial",
      ts: BASE_TS + 4,
      collateralTotalUsd: 100,
      balances: [],
      openOrders: [{
        clientOrderId: "partial-ack",
        venueOrderId: "venue-partial-ack",
        marketKey: "market-1",
        tokenId: "yes-token",
        outcome: "YES",
        side: "BUY",
        remainingQuantity: 7,
        limitPrice: 0.4,
      }],
    });
    const unexplained = state.getOrder("partial-ack")!;
    expect(unexplained).toMatchObject({
      status: "UNKNOWN",
      filledQuantity: 0,
    });
    expect(unexplained.reservedCashUsd).toBeCloseTo(2.8);

    state.recordFill({
      fillId: "authoritative-partial-fill",
      clientOrderId: "partial-ack",
      quantity: 3,
      price: 0.4,
      ts: BASE_TS + 5,
    });
    state.reconcileSnapshot({
      reconciliationId: "reconcile-explained-partial",
      ts: BASE_TS + 6,
      collateralTotalUsd: 100,
      balances: [],
      openOrders: [{
        clientOrderId: "partial-ack",
        venueOrderId: "venue-partial-ack",
        marketKey: "market-1",
        tokenId: "yes-token",
        outcome: "YES",
        side: "BUY",
        remainingQuantity: 7,
        limitPrice: 0.4,
      }],
    });
    const explained = state.getOrder("partial-ack")!;
    expect(explained).toMatchObject({
      status: "PARTIALLY_FILLED",
      filledQuantity: 3,
    });
    expect(explained.reservedCashUsd).toBeCloseTo(2.8);
  });

  it("bounds normalized event history by count, age, and event id", () => {
    const state = open({ maxEvents: 3, maxEventAgeMs: 100 });
    for (let i = 0; i < 4; i += 1) {
      expect(
        state.appendEvent({ eventId: `event-${i}`, ts: 1_000 + i, type: "BOOK", payload: { i } }),
      ).toBe(true);
    }
    expect(state.readEvents(3).map((event) => event.eventId)).toEqual(["event-1", "event-2", "event-3"]);
    expect(
      state.appendEvent({ eventId: "event-3", ts: 1_003, type: "BOOK", payload: { i: 3 } }),
    ).toBe(false);

    state.appendEvent({ eventId: "event-new", ts: 1_200, type: "TIMER", payload: {} });
    expect(state.readEvents(3).map((event) => event.eventId)).toEqual(["event-new"]);
    expect(state.status().counts.events).toBe(1);
  });
});

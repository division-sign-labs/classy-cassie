// packages/runtime-node/src/market-make-state.ts

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const MARKET_MAKE_SCHEMA_VERSION = 1;

const DEFAULT_MAX_EVENTS = 50_000;
const DEFAULT_MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
// Decision and reconciliation rows are research telemetry. They are never read
// back into memory by the runtime, but a market maker watching dozens of
// markets writes them by the hundred per minute, so they need a ceiling too.
const DEFAULT_MAX_DECISIONS = 250_000;
const DEFAULT_MAX_DECISION_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RECONCILIATIONS = 20_000;
const DECISION_PRUNE_EVERY = 1_000;
const RECONCILIATION_PRUNE_EVERY = 100;
const EPSILON = 1e-9;

export type MarketMakeLifecycle =
  | "BOOTSTRAP"
  | "RECONCILING"
  | "HALTED"
  | "ACTIVE"
  | "DATA_DEGRADED"
  | "RISK_EXIT_ONLY"
  | "EXIT_BLOCKED";

export type MarketMakeOutcome = "YES" | "NO";
export type MarketMakeOrderSide = "BUY" | "SELL";
export type MarketMakeOrderPurpose = "ADD" | "EXIT" | "LIQUIDATE" | "UNKNOWN";
export type MarketMakeOrderStatus =
  | "RESERVED"
  | "SIGNED"
  | "SUBMITTING"
  | "UNKNOWN"
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "CANCEL_PENDING"
  | "CANCELED"
  | "FILLED"
  | "REJECTED";
export type MarketMakeInventoryStatus = "OPEN" | "EXITING" | "RESIDUAL" | "CLOSED";

const ACTIVE_ORDER_STATUSES: readonly MarketMakeOrderStatus[] = [
  "RESERVED",
  "SIGNED",
  "SUBMITTING",
  "UNKNOWN",
  "OPEN",
  "PARTIALLY_FILLED",
  "CANCEL_PENDING",
];

const UNRESOLVED_TRANSITIONAL_ORDER_STATUSES: readonly MarketMakeOrderStatus[] = [
  "RESERVED",
  "SIGNED",
  "SUBMITTING",
  "UNKNOWN",
  "CANCEL_PENDING",
];

export interface MarketMakeStateOptions {
  maxEvents?: number;
  maxEventAgeMs?: number;
  maxDecisions?: number;
  maxDecisionAgeMs?: number;
  maxReconciliations?: number;
}

export interface MarketMakeMarketInput {
  marketKey: string;
  conditionId?: string;
  eventId?: string;
  categoryFamily?: string;
  yesTokenId: string;
  noTokenId: string;
  gammaStatus?: string;
  qVersion?: string;
  qProbability?: number;
  qObservedAt?: number;
  metadata?: unknown;
  updatedAt: number;
}

export interface MarketMakeMarket extends MarketMakeMarketInput {
  conditionId?: string;
  eventId?: string;
  categoryFamily?: string;
  gammaStatus?: string;
  qVersion?: string;
  qProbability?: number;
  qObservedAt?: number;
  metadata?: unknown;
}

export interface MarketMakeInventoryCycleInput {
  cycleId: string;
  marketKey: string;
  outcome: MarketMakeOutcome;
  tokenId: string;
  status?: MarketMakeInventoryStatus;
  quantity?: number;
  costBasisUsd?: number;
  firstFillAt?: number;
  anchorQVersion?: string;
  anchorQProbability?: number;
  anchorExecutionPrice?: number;
  renewalUsed?: boolean;
  createdAt: number;
}

export interface MarketMakeInventoryCycle {
  cycleId: string;
  marketKey: string;
  outcome: MarketMakeOutcome;
  tokenId: string;
  status: MarketMakeInventoryStatus;
  quantity: number;
  costBasisUsd: number;
  firstFillAt?: number;
  anchorQVersion?: string;
  anchorQProbability?: number;
  anchorExecutionPrice?: number;
  renewalUsed: boolean;
  renewedAt?: number;
  exitStartedAt?: number;
  closedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReconcileMarketMakeInventoryQuantityInput {
  marketKey: string;
  tokenId: string;
  quantity: number;
  costBasisUsd?: number;
  now: number;
}

export interface MarketMakeInventoryQuantityReconcileResult {
  applied: boolean;
  inventory?: MarketMakeInventoryCycle;
}

export interface ReserveMarketMakeOrderInput {
  clientOrderId: string;
  marketKey: string;
  cycleId?: string;
  tokenId: string;
  outcome: MarketMakeOutcome;
  side: MarketMakeOrderSide;
  purpose: MarketMakeOrderPurpose;
  quantity: number;
  limitPrice: number;
  tif: string;
  postOnly: boolean;
  now: number;
  metadata?: unknown;
}

export interface MarketMakeOrder {
  clientOrderId: string;
  marketKey: string;
  cycleId?: string;
  tokenId: string;
  outcome: MarketMakeOutcome;
  side: MarketMakeOrderSide;
  purpose: MarketMakeOrderPurpose;
  quantity: number;
  limitPrice: number;
  tif: string;
  postOnly: boolean;
  status: MarketMakeOrderStatus;
  reservedCashUsd: number;
  reservedQuantity: number;
  filledQuantity: number;
  fillNotionalUsd: number;
  fillFeesUsd: number;
  signedOrderHash?: string;
  venueOrderId?: string;
  createdAt: number;
  signedAt?: number;
  submittedAt?: number;
  acknowledgedAt?: number;
  cancelRequestedAt?: number;
  canceledAt?: number;
  terminalAt?: number;
  updatedAt: number;
  lastError?: string;
  metadata?: unknown;
}

export interface MarketMakeFillInput {
  fillId: string;
  venueTradeId?: string;
  clientOrderId: string;
  quantity: number;
  price: number;
  feeUsd?: number;
  ts: number;
  anchorQVersion?: string;
  anchorQProbability?: number;
  raw?: unknown;
}

export interface MarketMakeFillResult {
  inserted: boolean;
  order: MarketMakeOrder;
  inventory?: MarketMakeInventoryCycle;
}

export interface MarketMakeTokenBalanceInput {
  tokenId: string;
  marketKey?: string;
  outcome?: MarketMakeOutcome;
  totalQuantity: number;
}

export interface MarketMakeReconciledOrderInput {
  venueOrderId: string;
  clientOrderId?: string;
  marketKey: string;
  cycleId?: string;
  tokenId: string;
  outcome: MarketMakeOutcome;
  side: MarketMakeOrderSide;
  purpose?: MarketMakeOrderPurpose;
  remainingQuantity: number;
  limitPrice: number;
  tif?: string;
  postOnly?: boolean;
}

export interface MarketMakeReconcileSnapshotInput {
  reconciliationId: string;
  ts: number;
  collateralTotalUsd: number;
  balances: MarketMakeTokenBalanceInput[];
  openOrders: MarketMakeReconciledOrderInput[];
  completeBalances?: boolean;
  completeOpenOrders?: boolean;
  source?: string;
  raw?: unknown;
}

export interface MarketMakeLossState {
  latched: boolean;
  trigger?: string;
  triggeredAt?: number;
  acknowledgedAt?: number;
  rolling24hLossUsd: number;
  drawdownUsd: number;
  navUsd?: number;
  highWaterUsd?: number;
  updatedAt: number;
}

export interface MarketMakeAvailability {
  collateralTotalUsd: number;
  collateralReservedUsd: number;
  collateralFreeUsd: number;
  tokens: Array<{
    tokenId: string;
    marketKey?: string;
    outcome?: MarketMakeOutcome;
    totalQuantity: number;
    reservedQuantity: number;
    freeQuantity: number;
  }>;
}

export interface MarketMakeStateStatus {
  schemaVersion: number;
  lifecycle: MarketMakeLifecycle;
  haltReason?: string;
  /** @deprecated Prefer deploymentConfigHash for runtime/CLI comparisons. */
  configuredHash?: string;
  deploymentConfigHash?: string;
  deploymentId?: string;
  activationHash?: string;
  activationConfigHash?: string;
  activationDeploymentId?: string;
  activationCurrent: boolean;
  activatedAt?: number;
  deploymentUpdatedAt?: number;
  lastReconciliation?: {
    id: string;
    ts: number;
    ok: boolean;
  };
  loss: MarketMakeLossState;
  counts: {
    markets: number;
    activeInventoryCycles: number;
    activeOrders: number;
    unknownOrders: number;
    cancelPendingOrders: number;
    events: number;
  };
  availability: MarketMakeAvailability;
  updatedAt: number;
}

export interface MarketMakeNormalizedEventInput {
  eventId: string;
  ts: number;
  type: string;
  marketKey?: string;
  payload: unknown;
}

interface RuntimeRow {
  lifecycle: MarketMakeLifecycle;
  halt_reason: string | null;
  configured_hash: string | null;
  deployment_id: string | null;
  activation_hash: string | null;
  activated_config_hash: string | null;
  activated_deployment_id: string | null;
  activated_at: number | null;
  deployment_updated_at: number | null;
  last_reconciliation_id: string | null;
  last_reconciled_at: number | null;
  last_reconcile_ok: number;
  updated_at: number;
}

interface OrderRow extends Record<string, unknown> {
  client_order_id: string;
  market_key: string;
  cycle_id: string | null;
  token_id: string;
  outcome: MarketMakeOutcome;
  side: MarketMakeOrderSide;
  purpose: MarketMakeOrderPurpose;
  quantity: number;
  limit_price: number;
  tif: string;
  post_only: number;
  status: MarketMakeOrderStatus;
  reserved_cash_usd: number;
  reserved_quantity: number;
  filled_quantity: number;
  fill_notional_usd: number;
  fill_fees_usd: number;
  signed_order_hash: string | null;
  venue_order_id: string | null;
  created_at: number;
  signed_at: number | null;
  submitted_at: number | null;
  acknowledged_at: number | null;
  cancel_requested_at: number | null;
  canceled_at: number | null;
  terminal_at: number | null;
  updated_at: number;
  last_error: string | null;
  metadata_json: string | null;
}

interface InventoryRow extends Record<string, unknown> {
  cycle_id: string;
  market_key: string;
  outcome: MarketMakeOutcome;
  token_id: string;
  status: MarketMakeInventoryStatus;
  quantity: number;
  cost_basis_usd: number;
  first_fill_at: number | null;
  anchor_q_version: string | null;
  anchor_q_probability: number | null;
  anchor_execution_price: number | null;
  renewal_used: number;
  renewed_at: number | null;
  exit_started_at: number | null;
  closed_at: number | null;
  created_at: number;
  updated_at: number;
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  return normalized;
}

function requireFinite(value: number, name: string, minimum = 0): number {
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a finite number >= ${minimum}`);
  }
  return value;
}

function requireProbability(value: number, name: string): number {
  requireFinite(value, name);
  if (value > 1) throw new Error(`${name} must be <= 1`);
  return value;
}

function requireTimestamp(value: number, name = "timestamp"): number {
  requireFinite(value, name);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer millisecond timestamp`);
  return value;
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: unknown): unknown {
  return value == null ? undefined : JSON.parse(String(value));
}

function optionalNumber(value: unknown): number | undefined {
  return value == null ? undefined : Number(value);
}

function optionalString(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

export function marketMakeActivationHash(configHash: string, deploymentId: string): string {
  return createHash("sha256")
    .update(requireText(deploymentId, "deploymentId"))
    .update("\0")
    .update(requireText(configHash, "configHash"))
    .digest("hex");
}

export class MarketMakeStateStore {
  private readonly db: Database.Database;
  private readonly maxEvents: number;
  private readonly maxEventAgeMs: number;
  private readonly maxDecisions: number;
  private readonly maxDecisionAgeMs: number;
  private readonly maxReconciliations: number;
  private decisionsSincePrune = 0;
  private reconciliationsSincePrune = 0;

  constructor(path: string, options: MarketMakeStateOptions = {}) {
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxEventAgeMs = options.maxEventAgeMs ?? DEFAULT_MAX_EVENT_AGE_MS;
    this.maxDecisions = options.maxDecisions ?? DEFAULT_MAX_DECISIONS;
    this.maxDecisionAgeMs = options.maxDecisionAgeMs ?? DEFAULT_MAX_DECISION_AGE_MS;
    this.maxReconciliations = options.maxReconciliations ?? DEFAULT_MAX_RECONCILIATIONS;
    for (const [name, value] of [["maxDecisions", this.maxDecisions], ["maxReconciliations", this.maxReconciliations]] as const) {
      if (!Number.isInteger(value) || value < 1) throw new Error(` must be a positive integer`);
    }
    if (!Number.isFinite(this.maxDecisionAgeMs) || this.maxDecisionAgeMs <= 0) throw new Error("maxDecisionAgeMs must be positive");
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 1) {
      throw new Error("maxEvents must be a positive integer");
    }
    if (!Number.isFinite(this.maxEventAgeMs) || this.maxEventAgeMs < 0) {
      throw new Error("maxEventAgeMs must be a finite number >= 0");
    }

    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mm_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
    const applied = new Set(
      (this.db.prepare("SELECT version FROM mm_schema_migrations").all() as Array<{ version: number }>).map(
        (row) => Number(row.version),
      ),
    );

    if (!applied.has(1)) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS errors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            level TEXT NOT NULL,
            code TEXT NOT NULL,
            venue TEXT,
            message TEXT NOT NULL,
            context TEXT,
            tick_seq INTEGER
          );

          CREATE TABLE mm_runtime (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            lifecycle TEXT NOT NULL CHECK (lifecycle IN (
              'BOOTSTRAP', 'RECONCILING', 'HALTED', 'ACTIVE',
              'DATA_DEGRADED', 'RISK_EXIT_ONLY', 'EXIT_BLOCKED'
            )),
            halt_reason TEXT,
            configured_hash TEXT,
            deployment_id TEXT,
            activation_hash TEXT,
            activated_config_hash TEXT,
            activated_deployment_id TEXT,
            activated_at INTEGER,
            deployment_updated_at INTEGER,
            last_reconciliation_id TEXT,
            last_reconciled_at INTEGER,
            last_reconcile_ok INTEGER NOT NULL DEFAULT 0 CHECK (last_reconcile_ok IN (0, 1)),
            updated_at INTEGER NOT NULL
          );

          CREATE TABLE mm_markets (
            market_key TEXT PRIMARY KEY,
            condition_id TEXT,
            event_id TEXT,
            category_family TEXT,
            yes_token_id TEXT NOT NULL,
            no_token_id TEXT NOT NULL,
            gamma_status TEXT,
            q_version TEXT,
            q_probability REAL,
            q_observed_at INTEGER,
            metadata_json TEXT,
            updated_at INTEGER NOT NULL,
            CHECK (yes_token_id <> no_token_id),
            CHECK (q_probability IS NULL OR (q_probability >= 0 AND q_probability <= 1))
          );
          CREATE UNIQUE INDEX mm_markets_yes_token_uq ON mm_markets (yes_token_id);
          CREATE UNIQUE INDEX mm_markets_no_token_uq ON mm_markets (no_token_id);

          CREATE TABLE mm_inventory_cycles (
            cycle_id TEXT PRIMARY KEY,
            market_key TEXT NOT NULL,
            outcome TEXT NOT NULL CHECK (outcome IN ('YES', 'NO')),
            token_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('OPEN', 'EXITING', 'RESIDUAL', 'CLOSED')),
            quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
            cost_basis_usd REAL NOT NULL DEFAULT 0 CHECK (cost_basis_usd >= 0),
            first_fill_at INTEGER,
            anchor_q_version TEXT,
            anchor_q_probability REAL,
            anchor_execution_price REAL,
            renewal_used INTEGER NOT NULL DEFAULT 0 CHECK (renewal_used IN (0, 1)),
            renewed_at INTEGER,
            exit_started_at INTEGER,
            closed_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            CHECK (anchor_q_probability IS NULL OR (anchor_q_probability >= 0 AND anchor_q_probability <= 1)),
            CHECK (anchor_execution_price IS NULL OR (anchor_execution_price >= 0 AND anchor_execution_price <= 1)),
            CHECK (
              (first_fill_at IS NULL AND anchor_q_version IS NULL AND anchor_q_probability IS NULL AND anchor_execution_price IS NULL)
              OR
              (first_fill_at IS NOT NULL AND anchor_q_version IS NOT NULL AND anchor_q_probability IS NOT NULL AND anchor_execution_price IS NOT NULL)
            )
          );
          CREATE UNIQUE INDEX mm_inventory_active_market_uq
            ON mm_inventory_cycles (market_key)
            WHERE status IN ('OPEN', 'EXITING', 'RESIDUAL');

          CREATE TABLE mm_orders (
            client_order_id TEXT PRIMARY KEY,
            market_key TEXT NOT NULL,
            cycle_id TEXT,
            token_id TEXT NOT NULL,
            outcome TEXT NOT NULL CHECK (outcome IN ('YES', 'NO')),
            side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
            purpose TEXT NOT NULL CHECK (purpose IN ('ADD', 'EXIT', 'LIQUIDATE', 'UNKNOWN')),
            quantity REAL NOT NULL CHECK (quantity > 0),
            limit_price REAL NOT NULL CHECK (limit_price >= 0 AND limit_price <= 1),
            tif TEXT NOT NULL,
            post_only INTEGER NOT NULL CHECK (post_only IN (0, 1)),
            status TEXT NOT NULL CHECK (status IN (
              'RESERVED', 'SIGNED', 'SUBMITTING', 'UNKNOWN', 'OPEN',
              'PARTIALLY_FILLED', 'CANCEL_PENDING', 'CANCELED', 'FILLED', 'REJECTED'
            )),
            reserved_cash_usd REAL NOT NULL DEFAULT 0 CHECK (reserved_cash_usd >= 0),
            reserved_quantity REAL NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
            filled_quantity REAL NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
            fill_notional_usd REAL NOT NULL DEFAULT 0 CHECK (fill_notional_usd >= 0),
            fill_fees_usd REAL NOT NULL DEFAULT 0 CHECK (fill_fees_usd >= 0),
            signed_order_hash TEXT,
            venue_order_id TEXT,
            created_at INTEGER NOT NULL,
            signed_at INTEGER,
            submitted_at INTEGER,
            acknowledged_at INTEGER,
            cancel_requested_at INTEGER,
            canceled_at INTEGER,
            terminal_at INTEGER,
            updated_at INTEGER NOT NULL,
            last_error TEXT,
            metadata_json TEXT
          );
          CREATE UNIQUE INDEX mm_orders_signed_hash_uq ON mm_orders (signed_order_hash)
            WHERE signed_order_hash IS NOT NULL;
          CREATE UNIQUE INDEX mm_orders_venue_id_uq ON mm_orders (venue_order_id)
            WHERE venue_order_id IS NOT NULL;
          CREATE INDEX mm_orders_active_idx ON mm_orders (status, market_key);
          CREATE INDEX mm_orders_token_idx ON mm_orders (token_id, status);

          CREATE TABLE mm_fills (
            fill_id TEXT PRIMARY KEY,
            venue_trade_id TEXT,
            client_order_id TEXT NOT NULL,
            quantity REAL NOT NULL CHECK (quantity > 0),
            price REAL NOT NULL CHECK (price >= 0 AND price <= 1),
            fee_usd REAL NOT NULL DEFAULT 0 CHECK (fee_usd >= 0),
            ts INTEGER NOT NULL,
            raw_json TEXT,
            FOREIGN KEY (client_order_id) REFERENCES mm_orders(client_order_id)
          );
          CREATE INDEX mm_fills_order_idx ON mm_fills (client_order_id, ts);
          CREATE INDEX mm_fills_trade_idx ON mm_fills (venue_trade_id);

          CREATE TABLE mm_balances (
            token_id TEXT PRIMARY KEY,
            market_key TEXT,
            outcome TEXT CHECK (outcome IS NULL OR outcome IN ('YES', 'NO')),
            total_quantity REAL NOT NULL CHECK (total_quantity >= 0),
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE mm_account (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            collateral_total_usd REAL NOT NULL DEFAULT 0 CHECK (collateral_total_usd >= 0),
            updated_at INTEGER NOT NULL
          );

          CREATE TABLE mm_reconciliations (
            reconciliation_id TEXT PRIMARY KEY,
            ts INTEGER NOT NULL,
            source TEXT,
            snapshot_json TEXT NOT NULL
          );

          CREATE TABLE mm_decisions (
            decision_id TEXT PRIMARY KEY,
            ts INTEGER NOT NULL,
            kind TEXT NOT NULL,
            market_key TEXT,
            cycle_id TEXT,
            config_hash TEXT,
            q_version TEXT,
            rationale TEXT,
            decision_json TEXT NOT NULL
          );
          CREATE INDEX mm_decisions_ts_idx ON mm_decisions (ts);

          CREATE TABLE mm_markouts (
            markout_id TEXT PRIMARY KEY,
            ts INTEGER NOT NULL,
            market_key TEXT NOT NULL,
            cycle_id TEXT,
            horizon_seconds INTEGER NOT NULL CHECK (horizon_seconds >= 0),
            mark_price REAL NOT NULL CHECK (mark_price >= 0 AND mark_price <= 1),
            pnl_usd REAL,
            details_json TEXT
          );
          CREATE INDEX mm_markouts_market_idx ON mm_markouts (market_key, ts);

          CREATE TABLE mm_loss_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            latched INTEGER NOT NULL DEFAULT 0 CHECK (latched IN (0, 1)),
            trigger TEXT,
            triggered_at INTEGER,
            acknowledged_at INTEGER,
            rolling_24h_loss_usd REAL NOT NULL DEFAULT 0 CHECK (rolling_24h_loss_usd >= 0),
            drawdown_usd REAL NOT NULL DEFAULT 0 CHECK (drawdown_usd >= 0),
            nav_usd REAL,
            high_water_usd REAL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE mm_market_loss_state (
            market_key TEXT PRIMARY KEY,
            marked_loss_usd REAL NOT NULL DEFAULT 0 CHECK (marked_loss_usd >= 0),
            updated_at INTEGER NOT NULL
          );

          CREATE TABLE mm_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            ts INTEGER NOT NULL,
            type TEXT NOT NULL,
            market_key TEXT,
            payload_json TEXT NOT NULL
          );
          CREATE INDEX mm_events_ts_idx ON mm_events (ts);
          CREATE INDEX mm_events_market_idx ON mm_events (market_key, seq);
        `);
        const now = Date.now();
        this.db.prepare(
          "INSERT OR IGNORE INTO mm_runtime (singleton, lifecycle, updated_at) VALUES (1, 'BOOTSTRAP', ?)",
        ).run(now);
        this.db.prepare(
          "INSERT OR IGNORE INTO mm_account (singleton, collateral_total_usd, updated_at) VALUES (1, 0, ?)",
        ).run(now);
        this.db.prepare(
          "INSERT OR IGNORE INTO mm_loss_state (singleton, updated_at) VALUES (1, ?)",
        ).run(now);
        this.db.prepare(
          "INSERT INTO mm_schema_migrations (version, name, applied_at) VALUES (1, 'initial-market-make-state', ?)",
        ).run(now);
      })();
    }

    const newer = this.db
      .prepare("SELECT MAX(version) AS version FROM mm_schema_migrations")
      .get() as { version: number | null };
    if (Number(newer.version ?? 0) > MARKET_MAKE_SCHEMA_VERSION) {
      throw new Error(
        `market-make state schema ${newer.version} is newer than supported ${MARKET_MAKE_SCHEMA_VERSION}`,
      );
    }
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    const row = this.db
      .prepare("SELECT MAX(version) AS version FROM mm_schema_migrations")
      .get() as { version: number | null };
    return Number(row.version ?? 0);
  }

  setDeployment(input: { configHash: string; deploymentId: string; now: number }): MarketMakeStateStatus {
    const configHash = requireText(input.configHash, "configHash");
    const deploymentId = requireText(input.deploymentId, "deploymentId");
    const now = requireTimestamp(input.now, "now");
    this.db.transaction(() => {
      const current = this.runtimeRow();
      const changed = current.configured_hash !== configHash || current.deployment_id !== deploymentId;
      this.db.prepare(`
        UPDATE mm_runtime SET
          configured_hash = ?, deployment_id = ?, deployment_updated_at = ?,
          lifecycle = CASE
            WHEN lifecycle = 'EXIT_BLOCKED' THEN lifecycle
            WHEN ? THEN 'HALTED'
            ELSE lifecycle
          END,
          halt_reason = CASE
            WHEN lifecycle = 'EXIT_BLOCKED' THEN halt_reason
            WHEN ? THEN 'configuration or deployment identity changed'
            ELSE halt_reason
          END,
          activation_hash = CASE WHEN ? THEN NULL ELSE activation_hash END,
          activated_config_hash = CASE WHEN ? THEN NULL ELSE activated_config_hash END,
          activated_deployment_id = CASE WHEN ? THEN NULL ELSE activated_deployment_id END,
          activated_at = CASE WHEN ? THEN NULL ELSE activated_at END,
          last_reconcile_ok = CASE WHEN ? THEN 0 ELSE last_reconcile_ok END,
          updated_at = ?
        WHERE singleton = 1
      `).run(
        configHash,
        deploymentId,
        now,
        changed ? 1 : 0,
        changed ? 1 : 0,
        changed ? 1 : 0,
        changed ? 1 : 0,
        changed ? 1 : 0,
        changed ? 1 : 0,
        changed ? 1 : 0,
        now,
      );
    })();
    return this.status();
  }

  halt(reason: string, now: number): MarketMakeStateStatus {
    const normalized = requireText(reason, "reason");
    requireTimestamp(now, "now");
    this.db.prepare(`
      UPDATE mm_runtime SET
        lifecycle = CASE WHEN lifecycle = 'EXIT_BLOCKED' THEN lifecycle ELSE 'HALTED' END,
        halt_reason = CASE WHEN lifecycle = 'EXIT_BLOCKED' THEN halt_reason ELSE ? END,
        activation_hash = NULL,
        activated_config_hash = NULL, activated_deployment_id = NULL, activated_at = NULL, updated_at = ?
      WHERE singleton = 1
    `).run(normalized, now);
    return this.status();
  }

  /**
   * Explicit operator-only escape hatch used by `halt --liquidate` after the
   * operator has reviewed an EXIT_BLOCKED position. Automatic lifecycle
   * transitions must never call this method.
   */
  resetExitBlockedForOperatorLiquidation(reason: string, now: number): MarketMakeStateStatus {
    const normalized = requireText(reason, "reason");
    requireTimestamp(now, "now");
    this.db.prepare(`
      UPDATE mm_runtime SET lifecycle = 'HALTED', halt_reason = ?, activation_hash = NULL,
        activated_config_hash = NULL, activated_deployment_id = NULL, activated_at = NULL, updated_at = ?
      WHERE singleton = 1 AND lifecycle = 'EXIT_BLOCKED'
    `).run(normalized, now);
    return this.status();
  }

  setExitOnlyLifecycle(
    lifecycle: Exclude<MarketMakeLifecycle, "ACTIVE" | "BOOTSTRAP">,
    reason: string,
    now: number,
  ): MarketMakeStateStatus {
    requireTimestamp(now, "now");
    requireText(reason, "reason");
    if (![
      "RECONCILING",
      "HALTED",
      "DATA_DEGRADED",
      "RISK_EXIT_ONLY",
      "EXIT_BLOCKED",
    ].includes(lifecycle)) {
      throw new Error(`invalid exit-only lifecycle ${lifecycle}`);
    }
    this.db.prepare(`
      UPDATE mm_runtime SET lifecycle = ?, halt_reason = ?, updated_at = ?
      WHERE singleton = 1 AND (lifecycle <> 'EXIT_BLOCKED' OR ? = 'EXIT_BLOCKED')
    `).run(lifecycle, reason, now, lifecycle);
    return this.status();
  }

  resume(input: {
    configHash: string;
    deploymentId: string;
    now: number;
    acknowledgeLossReset?: boolean;
    /** Rebase a reviewed, unlatched cash-flow drawdown. Caller must prove the account is flat. */
    rebaseUnlatchedLoss?: boolean;
    requireReconciled?: boolean;
  }): MarketMakeStateStatus {
    const configHash = requireText(input.configHash, "configHash");
    const deploymentId = requireText(input.deploymentId, "deploymentId");
    const now = requireTimestamp(input.now, "now");
    this.db.transaction(() => {
      const runtime = this.runtimeRow();
      if (runtime.configured_hash !== configHash || runtime.deployment_id !== deploymentId) {
        throw new Error("cannot resume: configuration or deployment identity does not match persisted state");
      }
      if (
        input.requireReconciled !== false &&
        (!runtime.last_reconcile_ok ||
          runtime.last_reconciled_at == null ||
          runtime.deployment_updated_at == null ||
          runtime.last_reconciled_at < runtime.deployment_updated_at)
      ) {
        throw new Error("cannot resume: a successful reconciliation is required after deployment/configuration");
      }
      if (this.hasUnresolvedTransitionalOrders()) {
        throw new Error(
          "cannot resume: unresolved transitional orders remain (RESERVED, SIGNED, SUBMITTING, UNKNOWN, or CANCEL_PENDING)",
        );
      }
      const loss = this.lossRow();
      if (loss.latched) {
        if (!input.acknowledgeLossReset) {
          throw new Error("cannot resume: loss limit is latched; acknowledge the loss reset explicitly");
        }
        this.resetLossLatchInternal(now);
      } else if (input.rebaseUnlatchedLoss) {
        if (!input.acknowledgeLossReset) {
          throw new Error("cannot rebase unlatched loss state without explicit acknowledgement");
        }
        const activeOrders = this.db.prepare(
          `SELECT COUNT(*) AS count FROM mm_orders WHERE status IN (${placeholders(ACTIVE_ORDER_STATUSES)})`,
        ).get(...ACTIVE_ORDER_STATUSES) as { count: number };
        const activeInventory = this.db.prepare(
          "SELECT COUNT(*) AS count FROM mm_inventory_cycles WHERE status <> 'CLOSED'",
        ).get() as { count: number };
        const tokenInventory = this.db.prepare(
          "SELECT COUNT(*) AS count FROM mm_balances WHERE total_quantity > ?",
        ).get(EPSILON) as { count: number };
        if (activeOrders.count > 0 || activeInventory.count > 0 || tokenInventory.count > 0) {
          throw new Error("cannot rebase unlatched loss state unless the reconciled account is flat");
        }
        this.resetLossLatchInternal(now);
      }
      if (runtime.lifecycle === "EXIT_BLOCKED") {
        throw new Error("cannot resume directly from EXIT_BLOCKED; reconcile and halt first");
      }
      const activationHash = marketMakeActivationHash(configHash, deploymentId);
      this.db.prepare(`
        UPDATE mm_runtime SET lifecycle = 'ACTIVE', halt_reason = NULL,
          activation_hash = ?, activated_config_hash = ?, activated_deployment_id = ?,
          activated_at = ?, updated_at = ? WHERE singleton = 1
      `).run(activationHash, configHash, deploymentId, now, now);
    })();
    return this.status();
  }

  canRestoreActivation(configHash: string, deploymentId: string): boolean {
    const runtime = this.runtimeRow();
    const expected = marketMakeActivationHash(configHash, deploymentId);
    return (
      runtime.lifecycle === "ACTIVE" &&
      !this.lossRow().latched &&
      runtime.configured_hash === configHash &&
      runtime.deployment_id === deploymentId &&
      runtime.activated_config_hash === configHash &&
      runtime.activated_deployment_id === deploymentId &&
      runtime.activation_hash === expected &&
      Boolean(runtime.last_reconcile_ok) &&
      runtime.last_reconciled_at != null &&
      runtime.deployment_updated_at != null &&
      runtime.last_reconciled_at >= runtime.deployment_updated_at &&
      !this.hasUnresolvedTransitionalOrders()
    );
  }

  upsertMarket(input: MarketMakeMarketInput): MarketMakeMarket {
    requireText(input.marketKey, "marketKey");
    requireText(input.yesTokenId, "yesTokenId");
    requireText(input.noTokenId, "noTokenId");
    if (input.yesTokenId === input.noTokenId) throw new Error("YES and NO token ids must differ");
    if (input.qProbability !== undefined) requireProbability(input.qProbability, "qProbability");
    if (input.qObservedAt !== undefined) requireTimestamp(input.qObservedAt, "qObservedAt");
    requireTimestamp(input.updatedAt, "updatedAt");
    this.db.prepare(`
      INSERT INTO mm_markets (
        market_key, condition_id, event_id, category_family, yes_token_id, no_token_id,
        gamma_status, q_version, q_probability, q_observed_at, metadata_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(market_key) DO UPDATE SET
        condition_id = excluded.condition_id, event_id = excluded.event_id,
        category_family = excluded.category_family, yes_token_id = excluded.yes_token_id,
        no_token_id = excluded.no_token_id, gamma_status = excluded.gamma_status,
        q_version = excluded.q_version, q_probability = excluded.q_probability,
        q_observed_at = excluded.q_observed_at, metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      input.marketKey,
      input.conditionId ?? null,
      input.eventId ?? null,
      input.categoryFamily ?? null,
      input.yesTokenId,
      input.noTokenId,
      input.gammaStatus ?? null,
      input.qVersion ?? null,
      input.qProbability ?? null,
      input.qObservedAt ?? null,
      json(input.metadata),
      input.updatedAt,
    );
    return this.getMarket(input.marketKey)!;
  }

  getMarket(marketKey: string): MarketMakeMarket | undefined {
    const row = this.db.prepare("SELECT * FROM mm_markets WHERE market_key = ?").get(marketKey) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      marketKey: String(row.market_key),
      conditionId: optionalString(row.condition_id),
      eventId: optionalString(row.event_id),
      categoryFamily: optionalString(row.category_family),
      yesTokenId: String(row.yes_token_id),
      noTokenId: String(row.no_token_id),
      gammaStatus: optionalString(row.gamma_status),
      qVersion: optionalString(row.q_version),
      qProbability: optionalNumber(row.q_probability),
      qObservedAt: optionalNumber(row.q_observed_at),
      metadata: parseJson(row.metadata_json),
      updatedAt: Number(row.updated_at),
    };
  }

  createInventoryCycle(input: MarketMakeInventoryCycleInput): MarketMakeInventoryCycle {
    const quantity = requireFinite(input.quantity ?? 0, "quantity");
    const costBasisUsd = requireFinite(input.costBasisUsd ?? 0, "costBasisUsd");
    requireTimestamp(input.createdAt, "createdAt");
    const anchors = [
      input.firstFillAt,
      input.anchorQVersion,
      input.anchorQProbability,
      input.anchorExecutionPrice,
    ];
    const providedAnchors = anchors.filter((value) => value !== undefined).length;
    if (providedAnchors !== 0 && providedAnchors !== anchors.length) {
      throw new Error("first-fill anchor fields must be supplied together");
    }
    if (input.firstFillAt !== undefined) requireTimestamp(input.firstFillAt, "firstFillAt");
    if (input.anchorQProbability !== undefined) requireProbability(input.anchorQProbability, "anchorQProbability");
    if (input.anchorExecutionPrice !== undefined) requireProbability(input.anchorExecutionPrice, "anchorExecutionPrice");
    if (quantity > EPSILON && providedAnchors === 0) {
      throw new Error("a non-empty inventory cycle requires a first-fill anchor");
    }
    this.db.prepare(`
      INSERT INTO mm_inventory_cycles (
        cycle_id, market_key, outcome, token_id, status, quantity, cost_basis_usd,
        first_fill_at, anchor_q_version, anchor_q_probability, anchor_execution_price,
        renewal_used, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requireText(input.cycleId, "cycleId"),
      requireText(input.marketKey, "marketKey"),
      input.outcome,
      requireText(input.tokenId, "tokenId"),
      input.status ?? "OPEN",
      quantity,
      costBasisUsd,
      input.firstFillAt ?? null,
      input.anchorQVersion ?? null,
      input.anchorQProbability ?? null,
      input.anchorExecutionPrice ?? null,
      input.renewalUsed ? 1 : 0,
      input.createdAt,
      input.createdAt,
    );
    return this.getInventoryCycle(input.cycleId)!;
  }

  getInventoryCycle(cycleId: string): MarketMakeInventoryCycle | undefined {
    const row = this.db.prepare("SELECT * FROM mm_inventory_cycles WHERE cycle_id = ?").get(cycleId) as
      | InventoryRow
      | undefined;
    return row ? this.mapInventory(row) : undefined;
  }

  listInventoryCycles(activeOnly = false): MarketMakeInventoryCycle[] {
    const rows = activeOnly
      ? this.db.prepare("SELECT * FROM mm_inventory_cycles WHERE status <> 'CLOSED' ORDER BY created_at").all()
      : this.db.prepare("SELECT * FROM mm_inventory_cycles ORDER BY created_at").all();
    return (rows as InventoryRow[]).map((row) => this.mapInventory(row));
  }

  reconcileInventoryQuantity(
    input: ReconcileMarketMakeInventoryQuantityInput,
  ): MarketMakeInventoryQuantityReconcileResult {
    const marketKey = requireText(input.marketKey, "marketKey");
    const tokenId = requireText(input.tokenId, "tokenId");
    const requestedQuantity = requireFinite(input.quantity, "quantity");
    const quantity = requestedQuantity <= EPSILON ? 0 : requestedQuantity;
    const suppliedCostBasis = input.costBasisUsd === undefined
      ? undefined
      : requireFinite(input.costBasisUsd, "costBasisUsd");
    const now = requireTimestamp(input.now, "now");

    return this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM mm_inventory_cycles
        WHERE market_key = ? AND status IN ('OPEN', 'EXITING', 'RESIDUAL')
        ORDER BY created_at, cycle_id
      `).all(marketKey) as InventoryRow[];
      if (rows.length > 1) {
        throw new Error(`cannot reconcile ${marketKey}: multiple active inventory cycles are ambiguous`);
      }
      if (rows.length === 0) {
        if (quantity === 0) return { applied: false };
        throw new Error(`cannot reconcile ${marketKey}: no active inventory cycle exists for token ${tokenId}`);
      }

      const current = this.mapInventory(rows[0]!);
      if (current.tokenId !== tokenId) {
        throw new Error(
          `cannot reconcile ${marketKey}: active inventory token ${current.tokenId} conflicts with ${tokenId}`,
        );
      }

      const costBasisUsd = quantity === 0 ? 0 : (suppliedCostBasis ?? current.costBasisUsd);
      const nextStatus: MarketMakeInventoryStatus = quantity === 0 ? "CLOSED" : current.status;
      const unchanged =
        Math.abs(current.quantity - quantity) <= EPSILON &&
        Math.abs(current.costBasisUsd - costBasisUsd) <= EPSILON &&
        current.status === nextStatus;
      if (unchanged) return { applied: false, inventory: current };

      this.db.prepare(`
        UPDATE mm_inventory_cycles SET quantity = ?, cost_basis_usd = ?, status = ?,
          closed_at = CASE WHEN ? = 'CLOSED' THEN COALESCE(closed_at, ?) ELSE NULL END,
          updated_at = ?
        WHERE cycle_id = ?
      `).run(quantity, costBasisUsd, nextStatus, nextStatus, now, now, current.cycleId);
      return { applied: true, inventory: this.getInventoryCycle(current.cycleId)! };
    })();
  }

  markRenewalUsed(cycleId: string, now: number): MarketMakeInventoryCycle {
    requireTimestamp(now, "now");
    const result = this.db.prepare(`
      UPDATE mm_inventory_cycles SET renewal_used = 1, renewed_at = ?, updated_at = ?
      WHERE cycle_id = ? AND renewal_used = 0 AND status IN ('OPEN', 'EXITING')
    `).run(now, now, requireText(cycleId, "cycleId"));
    if (result.changes !== 1) throw new Error(`inventory cycle ${cycleId} is not renewable`);
    return this.getInventoryCycle(cycleId)!;
  }

  beginInventoryExit(cycleId: string, now: number): MarketMakeInventoryCycle {
    requireTimestamp(now, "now");
    const result = this.db.prepare(`
      UPDATE mm_inventory_cycles SET status = 'EXITING',
        exit_started_at = COALESCE(exit_started_at, ?), updated_at = ?
      WHERE cycle_id = ? AND status IN ('OPEN', 'RESIDUAL', 'EXITING')
    `).run(now, now, requireText(cycleId, "cycleId"));
    if (result.changes !== 1) throw new Error(`inventory cycle ${cycleId} cannot begin exit`);
    return this.getInventoryCycle(cycleId)!;
  }

  reserveOrder(input: ReserveMarketMakeOrderInput): MarketMakeOrder {
    const quantity = requireFinite(input.quantity, "quantity", Number.MIN_VALUE);
    const limitPrice = requireProbability(input.limitPrice, "limitPrice");
    requireTimestamp(input.now, "now");
    const normalized = {
      clientOrderId: requireText(input.clientOrderId, "clientOrderId"),
      marketKey: requireText(input.marketKey, "marketKey"),
      tokenId: requireText(input.tokenId, "tokenId"),
      tif: requireText(input.tif, "tif"),
    };
    return this.db.transaction(() => {
      const existing = this.getOrder(normalized.clientOrderId);
      if (existing) {
        const same =
          existing.marketKey === normalized.marketKey &&
          existing.cycleId === input.cycleId &&
          existing.tokenId === normalized.tokenId &&
          existing.outcome === input.outcome &&
          existing.side === input.side &&
          existing.purpose === input.purpose &&
          Math.abs(existing.quantity - quantity) <= EPSILON &&
          Math.abs(existing.limitPrice - limitPrice) <= EPSILON &&
          existing.tif === normalized.tif &&
          existing.postOnly === input.postOnly;
        if (!same) throw new Error(`client order id ${normalized.clientOrderId} is already reserved differently`);
        return existing;
      }
      const reservedCashUsd = input.side === "BUY" ? quantity * limitPrice : 0;
      const reservedQuantity = input.side === "SELL" ? quantity : 0;
      this.db.prepare(`
        INSERT INTO mm_orders (
          client_order_id, market_key, cycle_id, token_id, outcome, side, purpose,
          quantity, limit_price, tif, post_only, status, reserved_cash_usd,
          reserved_quantity, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?, ?, ?)
      `).run(
        normalized.clientOrderId,
        normalized.marketKey,
        input.cycleId ?? null,
        normalized.tokenId,
        input.outcome,
        input.side,
        input.purpose,
        quantity,
        limitPrice,
        normalized.tif,
        input.postOnly ? 1 : 0,
        reservedCashUsd,
        reservedQuantity,
        input.now,
        input.now,
        json(input.metadata),
      );
      return this.getOrder(normalized.clientOrderId)!;
    })();
  }

  recordSignedOrderHash(clientOrderId: string, signedOrderHash: string, now: number): MarketMakeOrder {
    requireTimestamp(now, "now");
    const id = requireText(clientOrderId, "clientOrderId");
    const hash = requireText(signedOrderHash, "signedOrderHash");
    const order = this.getOrderRequired(id);
    if (order.signedOrderHash) {
      if (order.signedOrderHash !== hash) throw new Error(`order ${id} already has a different signed hash`);
      return order;
    }
    if (order.status !== "RESERVED") throw new Error(`order ${id} cannot be signed from ${order.status}`);
    this.db.prepare(`
      UPDATE mm_orders SET signed_order_hash = ?, signed_at = ?, status = 'SIGNED', updated_at = ?
      WHERE client_order_id = ?
    `).run(hash, now, now, id);
    return this.getOrderRequired(id);
  }

  markOrderSubmitting(clientOrderId: string, now: number): MarketMakeOrder {
    return this.updateOrderStatus(clientOrderId, ["SIGNED"], "SUBMITTING", now, {
      submitted_at: now,
    });
  }

  markSubmissionUnknown(clientOrderId: string, error: string, now: number): MarketMakeOrder {
    return this.updateOrderStatus(clientOrderId, ["SIGNED", "SUBMITTING", "UNKNOWN"], "UNKNOWN", now, {
      submitted_at: now,
      last_error: requireText(error, "error"),
    });
  }

  acknowledgeOrder(clientOrderId: string, venueOrderId: string, now: number): MarketMakeOrder {
    requireTimestamp(now, "now");
    const id = requireText(clientOrderId, "clientOrderId");
    const venueId = requireText(venueOrderId, "venueOrderId");
    const current = this.getOrderRequired(id);
    if (current.venueOrderId && current.venueOrderId !== venueId) {
      throw new Error(`order ${id} already has a different venue order id`);
    }
    if (["CANCELED", "FILLED", "REJECTED"].includes(current.status)) return current;
    const next: MarketMakeOrderStatus =
      current.status === "CANCEL_PENDING"
        ? "CANCEL_PENDING"
        : current.filledQuantity > EPSILON
          ? "PARTIALLY_FILLED"
          : "OPEN";
    this.db.prepare(`
      UPDATE mm_orders SET venue_order_id = ?, acknowledged_at = COALESCE(acknowledged_at, ?),
        submitted_at = COALESCE(submitted_at, ?), status = ?, last_error = NULL, updated_at = ?
      WHERE client_order_id = ?
    `).run(venueId, now, now, next, now, id);
    return this.getOrderRequired(id);
  }

  /**
   * Persist a venue id without treating a cumulative partial/filled ACK as a
   * fill. Only the authoritative trade feed may release the reservation and
   * mutate inventory; reconciliation keeps this order quarantined meanwhile.
   */
  acknowledgeOrderUnknown(clientOrderId: string, venueOrderId: string, reason: string, now: number): MarketMakeOrder {
    requireTimestamp(now, "now");
    const id = requireText(clientOrderId, "clientOrderId");
    const venueId = requireText(venueOrderId, "venueOrderId");
    const current = this.getOrderRequired(id);
    if (current.venueOrderId && current.venueOrderId !== venueId) {
      throw new Error(`order ${id} already has a different venue order id`);
    }
    if (["CANCELED", "FILLED", "REJECTED"].includes(current.status)) return current;
    this.db.prepare(`
      UPDATE mm_orders SET venue_order_id = ?, acknowledged_at = COALESCE(acknowledged_at, ?),
        submitted_at = COALESCE(submitted_at, ?), status = 'UNKNOWN', last_error = ?, updated_at = ?
      WHERE client_order_id = ?
    `).run(venueId, now, now, requireText(reason, "reason"), now, id);
    return this.getOrderRequired(id);
  }

  requestCancel(clientOrderId: string, now: number): MarketMakeOrder {
    requireTimestamp(now, "now");
    const id = requireText(clientOrderId, "clientOrderId");
    const order = this.getOrderRequired(id);
    if (["CANCELED", "FILLED", "REJECTED"].includes(order.status)) return order;
    this.db.prepare(`
      UPDATE mm_orders SET status = 'CANCEL_PENDING',
        cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ?
      WHERE client_order_id = ?
    `).run(now, now, id);
    return this.getOrderRequired(id);
  }

  confirmCancellation(clientOrderId: string, now: number): MarketMakeOrder {
    requireTimestamp(now, "now");
    const id = requireText(clientOrderId, "clientOrderId");
    const order = this.getOrderRequired(id);
    if (order.status === "FILLED") return order;
    if (order.status === "CANCELED") return order;
    if (order.status === "REJECTED") throw new Error(`rejected order ${id} cannot be canceled`);
    this.db.prepare(`
      UPDATE mm_orders SET status = 'CANCELED', reserved_cash_usd = 0, reserved_quantity = 0,
        canceled_at = ?, terminal_at = ?, updated_at = ? WHERE client_order_id = ?
    `).run(now, now, now, id);
    return this.getOrderRequired(id);
  }

  rejectOrder(clientOrderId: string, error: string, now: number): MarketMakeOrder {
    requireTimestamp(now, "now");
    const id = requireText(clientOrderId, "clientOrderId");
    const order = this.getOrderRequired(id);
    if (order.status === "FILLED") throw new Error(`filled order ${id} cannot be rejected`);
    if (order.status === "REJECTED") return order;
    this.db.prepare(`
      UPDATE mm_orders SET status = 'REJECTED', reserved_cash_usd = 0, reserved_quantity = 0,
        last_error = ?, terminal_at = ?, updated_at = ? WHERE client_order_id = ?
    `).run(requireText(error, "error"), now, now, id);
    return this.getOrderRequired(id);
  }

  recordFill(input: MarketMakeFillInput): MarketMakeFillResult {
    const fillId = requireText(input.fillId, "fillId");
    const quantity = requireFinite(input.quantity, "quantity", Number.MIN_VALUE);
    const price = requireProbability(input.price, "price");
    const feeUsd = requireFinite(input.feeUsd ?? 0, "feeUsd");
    const ts = requireTimestamp(input.ts, "ts");
    return this.db.transaction(() => {
      const duplicate = this.db.prepare("SELECT * FROM mm_fills WHERE fill_id = ?").get(fillId) as
        | Record<string, unknown>
        | undefined;
      if (duplicate) {
        const same =
          String(duplicate.client_order_id) === input.clientOrderId &&
          Math.abs(Number(duplicate.quantity) - quantity) <= EPSILON &&
          Math.abs(Number(duplicate.price) - price) <= EPSILON &&
          Math.abs(Number(duplicate.fee_usd) - feeUsd) <= EPSILON;
        if (!same) throw new Error(`fill id ${fillId} is already recorded differently`);
        const order = this.getOrderRequired(input.clientOrderId);
        return {
          inserted: false,
          order,
          inventory: order.cycleId ? this.getInventoryCycle(order.cycleId) : undefined,
        };
      }

      const order = this.getOrderRequired(input.clientOrderId);
      if (order.status === "REJECTED") throw new Error(`rejected order ${order.clientOrderId} cannot fill`);
      const newFilled = order.filledQuantity + quantity;
      if (newFilled > order.quantity + EPSILON) {
        throw new Error(`fill would exceed order ${order.clientOrderId} quantity`);
      }
      let inventory: MarketMakeInventoryCycle | undefined;
      if (order.purpose === "ADD" || order.purpose === "EXIT" || order.purpose === "LIQUIDATE") {
        inventory = this.applyInventoryFill(order, input, quantity, price, feeUsd, ts);
      }

      this.db.prepare(`
        INSERT INTO mm_fills (
          fill_id, venue_trade_id, client_order_id, quantity, price, fee_usd, ts, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fillId,
        input.venueTradeId ?? null,
        order.clientOrderId,
        quantity,
        price,
        feeUsd,
        ts,
        json(input.raw),
      );

      const remaining = Math.max(0, order.quantity - newFilled);
      let nextStatus: MarketMakeOrderStatus;
      if (remaining <= EPSILON) nextStatus = "FILLED";
      else if (order.status === "CANCEL_PENDING") nextStatus = "CANCEL_PENDING";
      else if (order.status === "CANCELED") nextStatus = "CANCELED";
      else nextStatus = "PARTIALLY_FILLED";
      const reserveCash = ["CANCELED", "REJECTED"].includes(nextStatus)
        ? 0
        : order.side === "BUY"
          ? remaining * order.limitPrice
          : 0;
      const reserveQuantity = ["CANCELED", "REJECTED"].includes(nextStatus)
        ? 0
        : order.side === "SELL"
          ? remaining
          : 0;
      this.db.prepare(`
        UPDATE mm_orders SET status = ?, filled_quantity = ?,
          fill_notional_usd = fill_notional_usd + ?, fill_fees_usd = fill_fees_usd + ?,
          reserved_cash_usd = ?, reserved_quantity = ?,
          terminal_at = CASE WHEN ? IN ('FILLED', 'CANCELED') THEN COALESCE(terminal_at, ?) ELSE terminal_at END,
          updated_at = ? WHERE client_order_id = ?
      `).run(
        nextStatus,
        newFilled,
        quantity * price,
        feeUsd,
        reserveCash,
        reserveQuantity,
        nextStatus,
        ts,
        ts,
        order.clientOrderId,
      );
      return { inserted: true, order: this.getOrderRequired(order.clientOrderId), inventory };
    })();
  }

  private applyInventoryFill(
    order: MarketMakeOrder,
    input: MarketMakeFillInput,
    quantity: number,
    price: number,
    feeUsd: number,
    ts: number,
  ): MarketMakeInventoryCycle {
    if (!order.cycleId) throw new Error(`${order.purpose} order ${order.clientOrderId} requires an inventory cycle`);
    let cycle = this.getInventoryCycle(order.cycleId);
    if (order.purpose === "ADD") {
      if (!cycle) {
        if (input.anchorQVersion === undefined || input.anchorQProbability === undefined) {
          throw new Error("the first ADD fill requires Q version and probability anchors");
        }
        cycle = this.createInventoryCycle({
          cycleId: order.cycleId,
          marketKey: order.marketKey,
          outcome: order.outcome,
          tokenId: order.tokenId,
          createdAt: ts,
        });
      }
      if (cycle.marketKey !== order.marketKey || cycle.outcome !== order.outcome || cycle.tokenId !== order.tokenId) {
        throw new Error(`order ${order.clientOrderId} does not match inventory cycle ${cycle.cycleId}`);
      }
      if (cycle.status === "CLOSED") throw new Error(`closed inventory cycle ${cycle.cycleId} cannot receive ADD fills`);
      if (cycle.firstFillAt === undefined) {
        if (input.anchorQVersion === undefined || input.anchorQProbability === undefined) {
          throw new Error("the first ADD fill requires Q version and probability anchors");
        }
        requireText(input.anchorQVersion, "anchorQVersion");
        requireProbability(input.anchorQProbability, "anchorQProbability");
        this.db.prepare(`
          UPDATE mm_inventory_cycles SET quantity = quantity + ?, cost_basis_usd = cost_basis_usd + ?,
            first_fill_at = ?, anchor_q_version = ?, anchor_q_probability = ?,
            anchor_execution_price = ?, updated_at = ? WHERE cycle_id = ?
        `).run(
          quantity,
          quantity * price + feeUsd,
          ts,
          input.anchorQVersion,
          input.anchorQProbability,
          price,
          ts,
          cycle.cycleId,
        );
      } else {
        this.db.prepare(`
          UPDATE mm_inventory_cycles SET quantity = quantity + ?, cost_basis_usd = cost_basis_usd + ?,
            updated_at = ? WHERE cycle_id = ?
        `).run(quantity, quantity * price + feeUsd, ts, cycle.cycleId);
      }
      return this.getInventoryCycle(cycle.cycleId)!;
    }

    if (!cycle) throw new Error(`${order.purpose} fill references missing inventory cycle ${order.cycleId}`);
    if (quantity > cycle.quantity + EPSILON) {
      throw new Error(`${order.purpose} fill would make inventory cycle ${cycle.cycleId} negative`);
    }
    const remaining = Math.max(0, cycle.quantity - quantity);
    const remainingBasis = cycle.quantity <= EPSILON ? 0 : cycle.costBasisUsd * (remaining / cycle.quantity);
    const closed = remaining <= EPSILON;
    this.db.prepare(`
      UPDATE mm_inventory_cycles SET quantity = ?, cost_basis_usd = ?,
        status = CASE WHEN ? THEN 'CLOSED' ELSE 'EXITING' END,
        exit_started_at = COALESCE(exit_started_at, ?),
        closed_at = CASE WHEN ? THEN ? ELSE closed_at END, updated_at = ?
      WHERE cycle_id = ?
    `).run(remaining, remainingBasis, closed ? 1 : 0, ts, closed ? 1 : 0, ts, ts, cycle.cycleId);
    return this.getInventoryCycle(cycle.cycleId)!;
  }

  getOrder(clientOrderId: string): MarketMakeOrder | undefined {
    const row = this.db.prepare("SELECT * FROM mm_orders WHERE client_order_id = ?").get(clientOrderId) as
      | OrderRow
      | undefined;
    return row ? this.mapOrder(row) : undefined;
  }

  listOrders(input: { activeOnly?: boolean; marketKey?: string } = {}): MarketMakeOrder[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.activeOnly) {
      where.push(`status IN (${placeholders(ACTIVE_ORDER_STATUSES)})`);
      params.push(...ACTIVE_ORDER_STATUSES);
    }
    if (input.marketKey) {
      where.push("market_key = ?");
      params.push(input.marketKey);
    }
    const sql = `SELECT * FROM mm_orders${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`;
    return (this.db.prepare(sql).all(...params) as OrderRow[]).map((row) => this.mapOrder(row));
  }

  reconcileSnapshot(input: MarketMakeReconcileSnapshotInput): { applied: boolean; status: MarketMakeStateStatus } {
    const reconciliationId = requireText(input.reconciliationId, "reconciliationId");
    const ts = requireTimestamp(input.ts, "ts");
    const collateral = requireFinite(input.collateralTotalUsd, "collateralTotalUsd");
    const canonical = JSON.stringify({
      collateralTotalUsd: collateral,
      balances: input.balances,
      openOrders: input.openOrders,
      completeBalances: input.completeBalances ?? true,
      completeOpenOrders: input.completeOpenOrders ?? true,
      source: input.source,
      raw: input.raw,
    });
    const applied = this.db.transaction(() => {
      const previous = this.db
        .prepare("SELECT snapshot_json FROM mm_reconciliations WHERE reconciliation_id = ?")
        .get(reconciliationId) as { snapshot_json: string } | undefined;
      if (previous) {
        if (previous.snapshot_json !== canonical) {
          throw new Error(`reconciliation id ${reconciliationId} is already recorded differently`);
        }
        return false;
      }

      if (input.completeBalances ?? true) this.db.prepare("DELETE FROM mm_balances").run();
      for (const balance of input.balances) {
        requireText(balance.tokenId, "balance.tokenId");
        requireFinite(balance.totalQuantity, "balance.totalQuantity");
        this.db.prepare(`
          INSERT INTO mm_balances (token_id, market_key, outcome, total_quantity, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(token_id) DO UPDATE SET market_key = excluded.market_key,
            outcome = excluded.outcome, total_quantity = excluded.total_quantity,
            updated_at = excluded.updated_at
        `).run(
          balance.tokenId,
          balance.marketKey ?? null,
          balance.outcome ?? null,
          balance.totalQuantity,
          ts,
        );
      }
      this.db.prepare(`
        INSERT INTO mm_account (singleton, collateral_total_usd, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET collateral_total_usd = excluded.collateral_total_usd,
          updated_at = excluded.updated_at
      `).run(collateral, ts);

      const seenClientIds = new Set<string>();
      for (const venueOrder of input.openOrders) {
        const remaining = requireFinite(venueOrder.remainingQuantity, "openOrder.remainingQuantity");
        const limitPrice = requireProbability(venueOrder.limitPrice, "openOrder.limitPrice");
        const venueOrderId = requireText(venueOrder.venueOrderId, "openOrder.venueOrderId");
        let current = venueOrder.clientOrderId ? this.getOrder(venueOrder.clientOrderId) : undefined;
        current ??= this.getOrderByVenueId(venueOrderId);
        if (!current) {
          const clientOrderId = `external:${venueOrderId}`;
          current = this.reserveOrder({
            clientOrderId,
            marketKey: venueOrder.marketKey,
            cycleId: venueOrder.cycleId,
            tokenId: venueOrder.tokenId,
            outcome: venueOrder.outcome,
            side: venueOrder.side,
            purpose: venueOrder.purpose ?? "UNKNOWN",
            quantity: remaining,
            limitPrice,
            tif: venueOrder.tif ?? "GTC",
            postOnly: venueOrder.postOnly ?? false,
            now: ts,
            metadata: { discoveredByReconciliation: reconciliationId },
          });
        }
        if (
          current.marketKey !== venueOrder.marketKey ||
          current.tokenId !== venueOrder.tokenId ||
          current.side !== venueOrder.side
        ) {
          throw new Error(`reconciled order ${venueOrderId} conflicts with persisted order ${current.clientOrderId}`);
        }
        if (remaining > current.quantity - current.filledQuantity + EPSILON) {
          throw new Error(`reconciled remaining quantity exceeds order ${current.clientOrderId}`);
        }
        const authoritativeRemaining = Math.max(0, current.quantity - current.filledQuantity);
        const venueImpliesUnrecordedFills = remaining + EPSILON < authoritativeRemaining;
        const nextStatus = current.status === "CANCEL_PENDING"
          ? "CANCEL_PENDING"
          : venueImpliesUnrecordedFills
            ? "UNKNOWN"
            : current.filledQuantity > EPSILON
              ? "PARTIALLY_FILLED"
              : "OPEN";
        this.db.prepare(`
          UPDATE mm_orders SET venue_order_id = ?, status = ?,
            reserved_cash_usd = ?, reserved_quantity = ?,
            acknowledged_at = COALESCE(acknowledged_at, ?), updated_at = ?
          WHERE client_order_id = ?
        `).run(
          venueOrderId,
          nextStatus,
          current.side === "BUY" ? remaining * current.limitPrice : 0,
          current.side === "SELL" ? remaining : 0,
          ts,
          ts,
          current.clientOrderId,
        );
        seenClientIds.add(current.clientOrderId);
      }

      if (input.completeOpenOrders ?? true) {
        for (const local of this.listOrders({ activeOnly: true })) {
          if (!seenClientIds.has(local.clientOrderId) && !["RESERVED", "SIGNED"].includes(local.status)) {
            this.db.prepare(`
              UPDATE mm_orders SET status = 'CANCELED', reserved_cash_usd = 0, reserved_quantity = 0,
                canceled_at = ?, terminal_at = ?, updated_at = ? WHERE client_order_id = ?
            `).run(ts, ts, ts, local.clientOrderId);
          }
        }
      }

      this.db.prepare(
        "INSERT INTO mm_reconciliations (reconciliation_id, ts, source, snapshot_json) VALUES (?, ?, ?, ?)",
      ).run(reconciliationId, ts, input.source ?? null, canonical);
      if (++this.reconciliationsSincePrune >= RECONCILIATION_PRUNE_EVERY) {
        this.reconciliationsSincePrune = 0;
        this.pruneReconciliations();
      }
      this.db.prepare(`
        UPDATE mm_runtime SET last_reconciliation_id = ?, last_reconciled_at = ?,
          last_reconcile_ok = 1, updated_at = ? WHERE singleton = 1
      `).run(reconciliationId, ts, ts);
      return true;
    })();
    return { applied, status: this.status() };
  }

  availability(tokenId?: string): MarketMakeAvailability {
    const account = this.db.prepare("SELECT collateral_total_usd FROM mm_account WHERE singleton = 1").get() as {
      collateral_total_usd: number;
    };
    const active = placeholders(ACTIVE_ORDER_STATUSES);
    const cashRow = this.db.prepare(`
      SELECT COALESCE(SUM(reserved_cash_usd), 0) AS reserved
      FROM mm_orders WHERE status IN (${active})
    `).get(...ACTIVE_ORDER_STATUSES) as { reserved: number };
    const balanceRows = tokenId
      ? this.db.prepare("SELECT * FROM mm_balances WHERE token_id = ? ORDER BY token_id").all(tokenId)
      : this.db.prepare("SELECT * FROM mm_balances ORDER BY token_id").all();
    const reservedRows = this.db.prepare(`
      SELECT token_id, MIN(market_key) AS market_key, MIN(outcome) AS outcome,
        COALESCE(SUM(reserved_quantity), 0) AS reserved
      FROM mm_orders WHERE status IN (${active}) GROUP BY token_id
    `).all(...ACTIVE_ORDER_STATUSES) as Array<{
      token_id: string;
      market_key: string;
      outcome: MarketMakeOutcome;
      reserved: number;
    }>;
    const reservedByToken = new Map(reservedRows.map((row) => [row.token_id, Number(row.reserved)]));
    const tokens = (balanceRows as Array<Record<string, unknown>>).map((row) => {
      const total = Number(row.total_quantity);
      const reserved = reservedByToken.get(String(row.token_id)) ?? 0;
      return {
        tokenId: String(row.token_id),
        marketKey: optionalString(row.market_key),
        outcome: row.outcome == null ? undefined : (String(row.outcome) as MarketMakeOutcome),
        totalQuantity: total,
        reservedQuantity: reserved,
        freeQuantity: Math.max(0, total - reserved),
      };
    });
    const knownTokens = new Set(tokens.map((balance) => balance.tokenId));
    for (const row of reservedRows) {
      if ((tokenId === undefined || tokenId === row.token_id) && !knownTokens.has(row.token_id)) {
        tokens.push({
          tokenId: row.token_id,
          marketKey: row.market_key,
          outcome: row.outcome,
          totalQuantity: 0,
          reservedQuantity: Number(row.reserved),
          freeQuantity: 0,
        });
      }
    }
    tokens.sort((a, b) => a.tokenId.localeCompare(b.tokenId));
    const collateralTotalUsd = Number(account.collateral_total_usd);
    const collateralReservedUsd = Number(cashRow.reserved);
    return {
      collateralTotalUsd,
      collateralReservedUsd,
      collateralFreeUsd: Math.max(0, collateralTotalUsd - collateralReservedUsd),
      tokens,
    };
  }

  updateLossMark(input: {
    now: number;
    rolling24hLossUsd: number;
    drawdownUsd: number;
    navUsd?: number;
    highWaterUsd?: number;
    marketKey?: string;
    marketLossUsd?: number;
  }): MarketMakeLossState {
    requireTimestamp(input.now, "now");
    requireFinite(input.rolling24hLossUsd, "rolling24hLossUsd");
    requireFinite(input.drawdownUsd, "drawdownUsd");
    if (input.navUsd !== undefined) requireFinite(input.navUsd, "navUsd");
    if (input.highWaterUsd !== undefined) requireFinite(input.highWaterUsd, "highWaterUsd");
    if (input.marketLossUsd !== undefined) requireFinite(input.marketLossUsd, "marketLossUsd");
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mm_loss_state SET rolling_24h_loss_usd = ?, drawdown_usd = ?,
          nav_usd = ?, high_water_usd = ?, updated_at = ? WHERE singleton = 1
      `).run(
        input.rolling24hLossUsd,
        input.drawdownUsd,
        input.navUsd ?? null,
        input.highWaterUsd ?? null,
        input.now,
      );
      if (input.marketKey !== undefined && input.marketLossUsd !== undefined) {
        this.db.prepare(`
          INSERT INTO mm_market_loss_state (market_key, marked_loss_usd, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(market_key) DO UPDATE SET marked_loss_usd = excluded.marked_loss_usd,
            updated_at = excluded.updated_at
        `).run(requireText(input.marketKey, "marketKey"), input.marketLossUsd, input.now);
      }
    })();
    return this.lossState();
  }

  latchLoss(trigger: string, now: number): MarketMakeStateStatus {
    const normalized = requireText(trigger, "trigger");
    requireTimestamp(now, "now");
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mm_loss_state SET latched = 1, trigger = COALESCE(trigger, ?),
          triggered_at = COALESCE(triggered_at, ?), acknowledged_at = NULL, updated_at = ?
        WHERE singleton = 1
      `).run(normalized, now, now);
      this.db.prepare(`
        UPDATE mm_runtime SET
          lifecycle = CASE WHEN lifecycle = 'EXIT_BLOCKED' THEN lifecycle ELSE 'RISK_EXIT_ONLY' END,
          halt_reason = CASE WHEN lifecycle = 'EXIT_BLOCKED' THEN halt_reason ELSE ? END,
          updated_at = ?
        WHERE singleton = 1
      `).run(normalized, now);
    })();
    return this.status();
  }

  resetLossLatch(now: number): MarketMakeLossState {
    requireTimestamp(now, "now");
    this.db.transaction(() => this.resetLossLatchInternal(now))();
    return this.lossState();
  }

  private resetLossLatchInternal(now: number): void {
    const current = this.lossRow();
    this.db.prepare(`
      UPDATE mm_loss_state SET latched = 0, trigger = NULL, triggered_at = NULL,
        acknowledged_at = ?, rolling_24h_loss_usd = 0, drawdown_usd = 0,
        high_water_usd = nav_usd, updated_at = ? WHERE singleton = 1
    `).run(now, now);
    if (current.latched) this.db.prepare("DELETE FROM mm_market_loss_state").run();
  }

  lossState(): MarketMakeLossState {
    const row = this.lossRow();
    return {
      latched: Boolean(row.latched),
      trigger: optionalString(row.trigger),
      triggeredAt: optionalNumber(row.triggered_at),
      acknowledgedAt: optionalNumber(row.acknowledged_at),
      rolling24hLossUsd: Number(row.rolling_24h_loss_usd),
      drawdownUsd: Number(row.drawdown_usd),
      navUsd: optionalNumber(row.nav_usd),
      highWaterUsd: optionalNumber(row.high_water_usd),
      updatedAt: Number(row.updated_at),
    };
  }

  appendDecision(input: {
    decisionId: string;
    ts: number;
    kind: string;
    decision: unknown;
    marketKey?: string;
    cycleId?: string;
    configHash?: string;
    qVersion?: string;
    rationale?: string;
  }): boolean {
    requireTimestamp(input.ts, "ts");
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO mm_decisions (
        decision_id, ts, kind, market_key, cycle_id, config_hash, q_version, rationale, decision_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requireText(input.decisionId, "decisionId"),
      input.ts,
      requireText(input.kind, "kind"),
      input.marketKey ?? null,
      input.cycleId ?? null,
      input.configHash ?? null,
      input.qVersion ?? null,
      input.rationale ?? null,
      JSON.stringify(input.decision),
    );
    if (result.changes === 1 && ++this.decisionsSincePrune >= DECISION_PRUNE_EVERY) {
      this.decisionsSincePrune = 0;
      this.pruneDecisions(input.ts);
    }
    return result.changes === 1;
  }

  private pruneDecisions(now: number): void {
    this.db.prepare("DELETE FROM mm_decisions WHERE ts < ?").run(now - this.maxDecisionAgeMs);
    this.db.prepare(`
      DELETE FROM mm_decisions WHERE decision_id NOT IN (
        SELECT decision_id FROM mm_decisions ORDER BY ts DESC LIMIT ?
      )
    `).run(this.maxDecisions);
  }

  private pruneReconciliations(): void {
    this.db.prepare(`
      DELETE FROM mm_reconciliations WHERE reconciliation_id NOT IN (
        SELECT reconciliation_id FROM mm_reconciliations ORDER BY ts DESC LIMIT ?
      )
    `).run(this.maxReconciliations);
  }

  appendMarkout(input: {
    markoutId: string;
    ts: number;
    marketKey: string;
    cycleId?: string;
    horizonSeconds: number;
    markPrice: number;
    pnlUsd?: number;
    details?: unknown;
  }): boolean {
    requireTimestamp(input.ts, "ts");
    if (!Number.isInteger(input.horizonSeconds) || input.horizonSeconds < 0) {
      throw new Error("horizonSeconds must be a non-negative integer");
    }
    requireProbability(input.markPrice, "markPrice");
    if (input.pnlUsd !== undefined && !Number.isFinite(input.pnlUsd)) throw new Error("pnlUsd must be finite");
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO mm_markouts (
        markout_id, ts, market_key, cycle_id, horizon_seconds, mark_price, pnl_usd, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requireText(input.markoutId, "markoutId"),
      input.ts,
      requireText(input.marketKey, "marketKey"),
      input.cycleId ?? null,
      input.horizonSeconds,
      input.markPrice,
      input.pnlUsd ?? null,
      json(input.details),
    );
    return result.changes === 1;
  }

  appendEvent(input: MarketMakeNormalizedEventInput): boolean {
    requireTimestamp(input.ts, "ts");
    const inserted = this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO mm_events (event_id, ts, type, market_key, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        requireText(input.eventId, "eventId"),
        input.ts,
        requireText(input.type, "type"),
        input.marketKey ?? null,
        JSON.stringify(input.payload),
      );
      this.pruneEvents(input.ts);
      return result.changes === 1;
    })();
    return inserted;
  }

  private pruneEvents(now: number): void {
    const latest = this.db.prepare("SELECT MAX(ts) AS ts FROM mm_events").get() as { ts: number | null };
    const reference = Math.max(now, Number(latest.ts ?? now));
    this.db.prepare("DELETE FROM mm_events WHERE ts < ?").run(reference - this.maxEventAgeMs);
    this.db.prepare(`
      DELETE FROM mm_events WHERE seq NOT IN (
        SELECT seq FROM mm_events ORDER BY seq DESC LIMIT ?
      )
    `).run(this.maxEvents);
  }

  /** Every persisted event after `seq`, oldest first; the table itself is bounded by maxEvents. */
  readEventsAfter(seq: number): Array<MarketMakeNormalizedEventInput & { seq: number }> {
    if (!Number.isFinite(seq) || seq < 0) throw new Error("seq must be a non-negative number");
    const rows = this.db.prepare("SELECT * FROM mm_events WHERE seq > ? ORDER BY seq ASC").all(seq) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      seq: Number(row.seq),
      eventId: String(row.event_id),
      ts: Number(row.ts),
      type: String(row.type),
      marketKey: optionalString(row.market_key),
      payload: parseJson(row.payload_json),
    }));
  }

  /** Newest persisted fill timestamp, or 0 when no fill has been recorded. */
  latestFillTimestamp(): number {
    const row = this.db.prepare("SELECT MAX(ts) AS ts FROM mm_fills").get() as { ts: number | null };
    return Number(row.ts ?? 0);
  }

  readEvents(limit = 100): Array<MarketMakeNormalizedEventInput & { seq: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxEvents) {
      throw new Error(`limit must be an integer from 1 to ${this.maxEvents}`);
    }
    const rows = this.db.prepare("SELECT * FROM mm_events ORDER BY seq DESC LIMIT ?").all(limit) as Array<
      Record<string, unknown>
    >;
    return rows.reverse().map((row) => ({
      seq: Number(row.seq),
      eventId: String(row.event_id),
      ts: Number(row.ts),
      type: String(row.type),
      marketKey: optionalString(row.market_key),
      payload: parseJson(row.payload_json),
    }));
  }

  status(): MarketMakeStateStatus {
    const runtime = this.runtimeRow();
    const count = (sql: string, ...params: unknown[]): number => {
      const row = this.db.prepare(sql).get(...params) as { count: number };
      return Number(row.count);
    };
    const activeParams = [...ACTIVE_ORDER_STATUSES];
    const activationCurrent =
      runtime.lifecycle === "ACTIVE" &&
      runtime.configured_hash != null &&
      runtime.deployment_id != null &&
      runtime.activated_config_hash === runtime.configured_hash &&
      runtime.activated_deployment_id === runtime.deployment_id &&
      runtime.activation_hash === marketMakeActivationHash(runtime.configured_hash, runtime.deployment_id) &&
      Boolean(runtime.last_reconcile_ok) &&
      runtime.last_reconciled_at != null &&
      runtime.deployment_updated_at != null &&
      runtime.last_reconciled_at >= runtime.deployment_updated_at &&
      !this.lossRow().latched &&
      !this.hasUnresolvedTransitionalOrders();
    return {
      schemaVersion: this.schemaVersion(),
      lifecycle: runtime.lifecycle,
      haltReason: optionalString(runtime.halt_reason),
      configuredHash: optionalString(runtime.configured_hash),
      deploymentConfigHash: optionalString(runtime.configured_hash),
      deploymentId: optionalString(runtime.deployment_id),
      activationHash: optionalString(runtime.activation_hash),
      activationConfigHash: optionalString(runtime.activated_config_hash),
      activationDeploymentId: optionalString(runtime.activated_deployment_id),
      activationCurrent,
      activatedAt: optionalNumber(runtime.activated_at),
      deploymentUpdatedAt: optionalNumber(runtime.deployment_updated_at),
      lastReconciliation:
        runtime.last_reconciliation_id == null || runtime.last_reconciled_at == null
          ? undefined
          : {
              id: runtime.last_reconciliation_id,
              ts: runtime.last_reconciled_at,
              ok: Boolean(runtime.last_reconcile_ok),
            },
      loss: this.lossState(),
      counts: {
        markets: count("SELECT COUNT(*) AS count FROM mm_markets"),
        activeInventoryCycles: count("SELECT COUNT(*) AS count FROM mm_inventory_cycles WHERE status <> 'CLOSED'"),
        activeOrders: count(
          `SELECT COUNT(*) AS count FROM mm_orders WHERE status IN (${placeholders(activeParams)})`,
          ...activeParams,
        ),
        unknownOrders: count("SELECT COUNT(*) AS count FROM mm_orders WHERE status = 'UNKNOWN'"),
        cancelPendingOrders: count("SELECT COUNT(*) AS count FROM mm_orders WHERE status = 'CANCEL_PENDING'"),
        events: count("SELECT COUNT(*) AS count FROM mm_events"),
      },
      availability: this.availability(),
      updatedAt: Number(runtime.updated_at),
    };
  }

  async backup(destination: string): Promise<void> {
    requireText(destination, "destination");
    mkdirSync(dirname(destination), { recursive: true });
    await this.db.backup(destination);
  }

  exportSnapshot(): Record<string, unknown> {
    const tables = [
      "mm_schema_migrations",
      "mm_runtime",
      "mm_markets",
      "mm_inventory_cycles",
      "mm_orders",
      "mm_fills",
      "mm_balances",
      "mm_account",
      "mm_reconciliations",
      "mm_decisions",
      "mm_markouts",
      "mm_loss_state",
      "mm_market_loss_state",
      "mm_events",
    ];
    return Object.fromEntries(
      tables.map((table) => [table, this.db.prepare(`SELECT * FROM ${table}`).all()]),
    );
  }

  private runtimeRow(): RuntimeRow {
    return this.db.prepare("SELECT * FROM mm_runtime WHERE singleton = 1").get() as RuntimeRow;
  }

  private lossRow(): Record<string, unknown> & { latched: number } {
    return this.db.prepare("SELECT * FROM mm_loss_state WHERE singleton = 1").get() as Record<string, unknown> & {
      latched: number;
    };
  }

  private getOrderRequired(clientOrderId: string): MarketMakeOrder {
    const order = this.getOrder(clientOrderId);
    if (!order) throw new Error(`unknown client order ${clientOrderId}`);
    return order;
  }

  private getOrderByVenueId(venueOrderId: string): MarketMakeOrder | undefined {
    const row = this.db.prepare("SELECT * FROM mm_orders WHERE venue_order_id = ?").get(venueOrderId) as
      | OrderRow
      | undefined;
    return row ? this.mapOrder(row) : undefined;
  }

  private hasUnresolvedTransitionalOrders(): boolean {
    const row = this.db.prepare(`
      SELECT EXISTS(
        SELECT 1 FROM mm_orders
        WHERE status IN (${placeholders(UNRESOLVED_TRANSITIONAL_ORDER_STATUSES)})
      ) AS unresolved
    `).get(...UNRESOLVED_TRANSITIONAL_ORDER_STATUSES) as { unresolved: number };
    return Boolean(row.unresolved);
  }

  private updateOrderStatus(
    clientOrderId: string,
    from: MarketMakeOrderStatus[],
    to: MarketMakeOrderStatus,
    now: number,
    fields: Record<string, string | number | null> = {},
  ): MarketMakeOrder {
    requireTimestamp(now, "now");
    const id = requireText(clientOrderId, "clientOrderId");
    const current = this.getOrderRequired(id);
    if (current.status === to) return current;
    if (!from.includes(current.status)) throw new Error(`order ${id} cannot transition from ${current.status} to ${to}`);
    const allowedFields = new Set(["submitted_at", "last_error"]);
    for (const field of Object.keys(fields)) {
      if (!allowedFields.has(field)) throw new Error(`unsupported order transition field ${field}`);
    }
    const assignments = ["status = ?", "updated_at = ?", ...Object.keys(fields).map((field) => `${field} = ?`)];
    this.db.prepare(`UPDATE mm_orders SET ${assignments.join(", ")} WHERE client_order_id = ?`).run(
      to,
      now,
      ...Object.values(fields),
      id,
    );
    return this.getOrderRequired(id);
  }

  private mapOrder(row: OrderRow): MarketMakeOrder {
    return {
      clientOrderId: row.client_order_id,
      marketKey: row.market_key,
      cycleId: optionalString(row.cycle_id),
      tokenId: row.token_id,
      outcome: row.outcome,
      side: row.side,
      purpose: row.purpose,
      quantity: Number(row.quantity),
      limitPrice: Number(row.limit_price),
      tif: row.tif,
      postOnly: Boolean(row.post_only),
      status: row.status,
      reservedCashUsd: Number(row.reserved_cash_usd),
      reservedQuantity: Number(row.reserved_quantity),
      filledQuantity: Number(row.filled_quantity),
      fillNotionalUsd: Number(row.fill_notional_usd),
      fillFeesUsd: Number(row.fill_fees_usd),
      signedOrderHash: optionalString(row.signed_order_hash),
      venueOrderId: optionalString(row.venue_order_id),
      createdAt: Number(row.created_at),
      signedAt: optionalNumber(row.signed_at),
      submittedAt: optionalNumber(row.submitted_at),
      acknowledgedAt: optionalNumber(row.acknowledged_at),
      cancelRequestedAt: optionalNumber(row.cancel_requested_at),
      canceledAt: optionalNumber(row.canceled_at),
      terminalAt: optionalNumber(row.terminal_at),
      updatedAt: Number(row.updated_at),
      lastError: optionalString(row.last_error),
      metadata: parseJson(row.metadata_json),
    };
  }

  private mapInventory(row: InventoryRow): MarketMakeInventoryCycle {
    return {
      cycleId: row.cycle_id,
      marketKey: row.market_key,
      outcome: row.outcome,
      tokenId: row.token_id,
      status: row.status,
      quantity: Number(row.quantity),
      costBasisUsd: Number(row.cost_basis_usd),
      firstFillAt: optionalNumber(row.first_fill_at),
      anchorQVersion: optionalString(row.anchor_q_version),
      anchorQProbability: optionalNumber(row.anchor_q_probability),
      anchorExecutionPrice: optionalNumber(row.anchor_execution_price),
      renewalUsed: Boolean(row.renewal_used),
      renewedAt: optionalNumber(row.renewed_at),
      exitStartedAt: optionalNumber(row.exit_started_at),
      closedAt: optionalNumber(row.closed_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}

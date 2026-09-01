// strategies/market-make/src/preset.ts
// Loads the immutable research artifact and resolves Cassie-only defaults.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MarketMakeConfigSchema, type MarketMakeConfig } from "./schema.js";

export const MARKET_MAKE_SOURCE_SHA256 = "27feab003ab5d22f85387fb778653f748c1f50e1104edd9457cfbdfa09e85c32";

export interface MarketMakePresetProvenance {
  source_repository: string;
  source_path: string;
  source_schema_version: string;
  copied_at: string;
  sha256: string;
  cassie_resolution: {
    bankroll: MarketMakeConfig["cassie_overrides"]["bankroll"];
    renewal_min_edge_pp: { NO: number; YES: number };
    liquidity: MarketMakeConfig["cassie_overrides"]["liquidity"];
  };
  note: string;
}

type JsonObject = { [key: string]: unknown };
export type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function mergeObjects(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (Array.isArray(override)) return [...override];
  if (override !== null && typeof override === "object" && base !== null && typeof base === "object" && !Array.isArray(base)) {
    const merged: JsonObject = { ...(base as JsonObject) };
    for (const [key, value] of Object.entries(override)) merged[key] = mergeObjects(merged[key], value);
    return merged;
  }
  return override;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as JsonObject).sort().map((key) => [key, canonicalize((value as JsonObject)[key])]));
  }
  return value;
}

const sourceText = readFileSync(new URL("../strategy.v1.json", import.meta.url), "utf8");
if (sha256(sourceText) !== MARKET_MAKE_SOURCE_SHA256) {
  throw new Error("vendored strategy.v1.json checksum mismatch; update provenance deliberately");
}

/** The byte-for-byte research payload after strict validation, before Cassie defaults. */
export const MARKET_MAKE_SOURCE_PRESET = deepFreeze(JSON.parse(sourceText) as JsonObject);

/** Fully resolved Cassie config. Directional renewal is deliberately NO=10pp, YES=20pp. */
export const MARKET_MAKE_PRESET: Readonly<MarketMakeConfig> = deepFreeze(MarketMakeConfigSchema.parse(MARKET_MAKE_SOURCE_PRESET));

export const MARKET_MAKE_PRESET_PROVENANCE = deepFreeze(
  JSON.parse(readFileSync(new URL("../strategy.v1.provenance.json", import.meta.url), "utf8")) as MarketMakePresetProvenance,
);

/** Merge a partial operator override onto the immutable preset and revalidate every key and invariant. */
export function createMarketMakeConfig(overrides: DeepPartial<MarketMakeConfig> = {}): MarketMakeConfig {
  return MarketMakeConfigSchema.parse(mergeObjects(MARKET_MAKE_PRESET, overrides));
}

/** Stable SHA-256 of the resolved config, independent of object key insertion order. */
export function marketMakeConfigHash(config: MarketMakeConfig): string {
  const resolved = MarketMakeConfigSchema.parse(config);
  return sha256(JSON.stringify(canonicalize(resolved)));
}

/**
 * Resolve the funded capital that may drive dollar limits. Open inventory is
 * expected to be included in `strategyCapitalUsd` at cost by the caller.
 */
export function effectiveMarketMakeBankrollUsd(
  config: MarketMakeConfig,
  strategyCapitalUsd: number,
): number {
  if (!Number.isFinite(strategyCapitalUsd) || strategyCapitalUsd < 0) {
    throw new Error("strategy capital must be a finite non-negative number");
  }
  if (config.cassie_overrides.bankroll.mode === "fixed") {
    return config.capital.sizing_bankroll_usd;
  }
  const ceiling = config.cassie_overrides.bankroll.maximum_sizing_bankroll_usd;
  return ceiling === null ? strategyCapitalUsd : Math.min(strategyCapitalUsd, ceiling);
}

/**
 * Scale every dollar-denominated policy limit from the reference bankroll.
 * Count and percentage limits deliberately remain unchanged.
 */
export function marketMakeConfigForBankroll(
  config: MarketMakeConfig,
  bankrollUsd: number,
): MarketMakeConfig {
  if (!Number.isFinite(bankrollUsd) || bankrollUsd <= 0) {
    throw new Error("effective bankroll must be a finite positive number");
  }
  const ratio = bankrollUsd / config.capital.sizing_bankroll_usd;
  const scale = (value: number): number => value * ratio;

  return MarketMakeConfigSchema.parse({
    ...config,
    capital: {
      ...config.capital,
      initial_bankroll_usd: bankrollUsd,
      sizing_bankroll_usd: bankrollUsd,
      max_total_inventory_and_pending_entry_cost_usd: scale(
        config.capital.max_total_inventory_and_pending_entry_cost_usd,
      ),
      minimum_free_collateral_usd: scale(config.capital.minimum_free_collateral_usd),
      operational_reserve_usd: scale(config.capital.operational_reserve_usd),
      base_order_notional_usd: scale(config.capital.base_order_notional_usd),
      max_order_notional_usd: scale(config.capital.max_order_notional_usd),
      hard_market_cost_usd: scale(config.capital.hard_market_cost_usd),
    },
    direction_policy: {
      ...config.direction_policy,
      NO: {
        ...config.direction_policy.NO,
        target_market_cost_usd: scale(config.direction_policy.NO.target_market_cost_usd),
      },
      YES: {
        ...config.direction_policy.YES,
        target_market_cost_usd: scale(config.direction_policy.YES.target_market_cost_usd),
      },
    },
    portfolio_risk: {
      ...config.portfolio_risk,
      max_event_cost_usd: scale(config.portfolio_risk.max_event_cost_usd),
      max_category_family_cost_usd: scale(config.portfolio_risk.max_category_family_cost_usd),
      max_manual_correlation_group_cost_usd: scale(
        config.portfolio_risk.max_manual_correlation_group_cost_usd,
      ),
    },
    loss_limits: {
      ...config.loss_limits,
      max_marked_loss_per_market_usd: scale(config.loss_limits.max_marked_loss_per_market_usd),
      max_rolling_24h_loss_usd: scale(config.loss_limits.max_rolling_24h_loss_usd),
      max_strategy_drawdown_usd: scale(config.loss_limits.max_strategy_drawdown_usd),
    },
  });
}

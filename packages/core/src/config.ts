// packages/core/src/config.ts
// Bot configuration: zod schemas, defaults (§8, §9), and (de)serialization.
// File I/O lives in the CLI/runtime-local; this module stays Workers-safe.

import { z } from "zod";

export const RiskConfigSchema = z.object({
  /** Max slippage from mid when computing the executable band, in bps. */
  maxSlippageBps: z.number().positive().default(100),
  /** Cap order size at this % of executable depth within the band. */
  depthCapPct: z.number().positive().max(100).default(25),
  /** Market eligibility floor: 24h volume in USD. */
  minDailyVolume: z.number().nonnegative().default(10_000),
  /** Market eligibility ceiling on spread, in bps. */
  maxSpreadBps: z.number().positive().default(500),
  /** Skip rather than dribble below this notional. */
  minViableNotional: z.number().nonnegative().default(1),
  /** Hard cap per order, USD notional. */
  maxOrderNotional: z.number().positive().default(1_000),
  /** Resting order lifetime before re-price/cancel. */
  orderTtlSec: z.number().positive().default(300),
});
export type RiskConfig = z.output<typeof RiskConfigSchema>;

export const SignalsConfigSchema = z.object({
  source: z.enum(["live", "fixture"]).default("fixture"),
  /** Fixture file path (local runtime) or inline fixture JSON (deployed). */
  fixturePath: z.string().optional(),
  /** Quotient gateway. dev.quotient.social is gateway-only and rejects direct calls. */
  baseUrl: z.string().default("https://quotient-api-gateway.onrender.com"),
  path: z.string().default("/api/v1/signals"),
});
export type SignalsConfig = z.output<typeof SignalsConfigSchema>;

export const TelegramConfigSchema = z.object({
  chatId: z.string(),
});

export const AlertsConfigSchema = z.object({
  telegram: TelegramConfigSchema.optional(),
  /** Dedup window for error alerts, minutes (§14). */
  errorDedupMin: z.number().positive().default(15),
});
export type AlertsConfig = z.output<typeof AlertsConfigSchema>;

/**
 * Trade reporting: attribute an order to a destination, and report the trade
 * there with a comment. Two independent switches — `builderCode` governs
 * attribution on the order itself, `post` governs whether anything is
 * published about it.
 *
 * `provider` selects the destination's API and its credential:
 *   ares → api.ares.pro, key from ARES_API_KEY (`ares-api-key` in the keystore)
 *
 * `builderCode` is required whenever this block exists, so a bot cannot be
 * configured to report trades it never attributed — the pairing is the
 * commercial term, and the schema is where it's enforced.
 *
 * Distinct from the Polymarket *Builder API key* (GASLESS_AUTH_ROLE), which
 * authenticates gasless relayer ops and has nothing to do with attribution.
 */
export const ReportingConfigSchema = z.object({
  /** Destination. One today; the discriminator is here so adding one is additive. */
  provider: z.literal("ares").default("ares"),
  /** Attribution code stamped on every order this bot places (0x + 64 hex). */
  builderCode: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "reporting.builderCode: expected 0x followed by 64 hex chars"),
  /** Report each attributed order to the provider. Attribution continues either way. */
  post: z.boolean().default(true),
  /** Which order events are reported. */
  postOn: z.array(z.enum(["entry", "exit"])).default(["entry", "exit"]),
  /** Provider API base. Defaults per provider when unset. */
  baseUrl: z.string().default("https://api.ares.pro"),
});
export type ReportingConfig = z.output<typeof ReportingConfigSchema>;

/** Per-venue base URLs so testnets are reachable by config change only (§3). */
export const VenueUrlsSchema = z.object({
  polymarket: z
    .object({
      chainId: z.number().default(137),
      clob: z.string().default("https://clob.polymarket.com"),
      gamma: z.string().default("https://gamma-api.polymarket.com"),
      data: z.string().default("https://data-api.polymarket.com"),
      bridge: z.string().default("https://bridge.polymarket.com"),
      relayer: z.string().optional(),
    })
    .prefault({}),
  hyperliquid: z
    .object({
      api: z.string().default("https://api.hyperliquid.xyz"),
      testnet: z.boolean().default(false),
      arbitrumRpc: z.string().default("https://arb1.arbitrum.io/rpc"),
    })
    .prefault({}),
  lighter: z
    .object({
      api: z.string().default("https://mainnet.zklighter.elliot.ai"),
    })
    .prefault({}),
});
export type VenueUrls = z.output<typeof VenueUrlsSchema>;

export const VenueAccountSchema = z.discriminatedUnion("venue", [
  z.object({
    venue: z.literal("polymarket"),
    signerAddress: z.string(),
    funder: z.string(),
    signatureType: z.number().default(3),
    bridgeAddresses: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    venue: z.literal("hyperliquid"),
    masterAddress: z.string(),
    agentAddress: z.string().optional(),
    agentName: z.string().optional(),
  }),
  z.object({
    venue: z.literal("lighter"),
    l1Address: z.string(),
    accountIndex: z.number().optional(),
    apiKeyIndex: z.number().optional(),
    intentAddresses: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    venue: z.literal("fixture"),
    address: z.string(),
  }),
]);

export const BotConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "bot id: lowercase alphanumerics and dashes, max 32 chars"),
  venue: z.enum(["polymarket", "hyperliquid", "lighter", "fixture"]),
  account: VenueAccountSchema.optional(),
  strategy: z
    .object({
      id: z.string().default("flip-flat"),
      config: z.record(z.string(), z.unknown()).default({}),
    })
    .prefault({}),
  risk: RiskConfigSchema.prefault({}),
  signals: SignalsConfigSchema.prefault({}),
  alerts: AlertsConfigSchema.prefault({}),
  /** Opt-in per bot. Polymarket only — other venues carry no builder code. */
  reporting: ReportingConfigSchema.optional(),
  venueUrls: VenueUrlsSchema.prefault({}),
  tickIntervalMin: z.number().positive().default(5),
  /** Set by `cassie deploy`: the Workers control API base URL for this bot. */
  controlUrl: z.string().optional(),
  createdAt: z.string().optional(),
});
export type BotConfig = z.output<typeof BotConfigSchema>;

export function parseBotConfig(raw: unknown): BotConfig {
  return BotConfigSchema.parse(raw);
}

export function serializeBotConfig(cfg: BotConfig): string {
  return JSON.stringify(cfg, null, 2) + "\n";
}

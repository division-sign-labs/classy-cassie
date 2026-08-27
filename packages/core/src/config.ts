// packages/core/src/config.ts
// Bot configuration: zod schemas, defaults (§8, §9), and (de)serialization.
// File I/O lives in the CLI and the runtime; this module holds no side effects.

import { z } from "zod";

/** Live signals older than three hours are stale unless a bot overrides this. */
export const DEFAULT_SIGNAL_MAX_AGE_SEC = 3 * 60 * 60;

export const RiskConfigSchema = z.preprocess(
  // Migrate earlier execution controls onto the single percentage setting.
  (raw) => {
    if (typeof raw !== "object" || raw === null) return raw;
    const legacy = raw as Record<string, unknown>;
    const migrated = legacy.depthCapPct === 25 ? { ...legacy, depthCapPct: 100 } : legacy;
    if (migrated.slippagePct === undefined) {
      if (typeof migrated.slippageCents === "number") return { ...migrated, slippagePct: migrated.slippageCents };
      if (typeof migrated.maxBookWalkCents === "number") return { ...migrated, slippagePct: migrated.maxBookWalkCents };
    }
    return migrated;
  },
  z.object({
    /**
     * Slippage tolerance as a percentage from the best executable price.
     * Bounds both the capacity band and the crossing limit: an order may walk
     * the book at most this far past the best bid/ask. The single
     * operator-facing execution-quality control; set it per bot with
     * `cassie strategy <botId> --slippage <pct>` or per order with
     * `cassie trade … --slippage <pct>`.
     */
    slippagePct: z.number().positive().max(100).default(3),
    /** Cap order size at this % of executable depth within the band. Defaults to no extra cap. */
    depthCapPct: z.number().positive().max(100).default(100),
    /** Market eligibility floor: 24h volume in USD. */
    minDailyVolume: z.number().nonnegative().default(10_000),
    /** Skip rather than dribble below this notional. */
    minViableNotional: z.number().nonnegative().default(1),
    /** Hard cap per order, USD notional. */
    maxOrderNotional: z.number().positive().default(1_000),
    /** Resting order lifetime before re-price/cancel. */
    orderTtlSec: z.number().positive().default(300),
  }),
);
export type RiskConfig = z.output<typeof RiskConfigSchema>;

export const SignalsConfigSchema = z
  .object({
    /** Backward compatibility for existing real-bot configs; omitted on serialization. */
    source: z.literal("live").optional(),
    /** Reject the removed test-fixture field instead of silently ignoring it. */
    fixturePath: z.never().optional(),
    /** Quotient gateway. dev.quotient.social is gateway-only and rejects direct calls. */
    baseUrl: z.string().default("https://quotient-api-gateway.onrender.com"),
    path: z.string().default("/api/v1/signals"),
    /** Maximum age of a live forecast before it is ignored. */
    maxAgeSec: z.number().positive().default(DEFAULT_SIGNAL_MAX_AGE_SEC),
  })
  .transform(({ source: _legacySource, fixturePath: _removedFixturePath, ...config }) => config);
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
      /** Polygon RPC for chain reads and transaction waits. Defaults to the SDK's. */
      rpc: z.string().optional(),
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
  kalshi: z
    .object({
      api: z.string().default("https://api.elections.kalshi.com/trade-api/v2"),
      demoApi: z.string().default("https://demo-api.kalshi.co/trade-api/v2"),
      /** Trade against Kalshi's demo environment (separate keys, paper funds). */
      demo: z.boolean().default(false),
    })
    .prefault({}),
});
export type VenueUrls = z.output<typeof VenueUrlsSchema>;

const EvmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte EVM address");

/** The bot's master EOA, generated into Cassie's local encrypted keystore. */
export const WalletConfigSchema = z
  .object({
    origin: z.literal("local").default("local"),
    address: EvmAddressSchema.optional(),
  })
  .strict();
export type WalletConfig = z.output<typeof WalletConfigSchema>;

/**
 * An organization-owned Splits subaccount used as this bot's treasury source.
 * Splits authentication stays operator-local and is deliberately absent from
 * this schema. Signers listed here are scoped to this one account.
 */
export const SplitsTreasurySchema = z
  .object({
    provider: z.literal("splits"),
    organizationId: z.string().min(1),
    organizationName: z.string().min(1).nullable().optional(),
    accountId: z.string().min(1),
    accountAddress: EvmAddressSchema,
    accountName: z.string().min(1),
    signers: z
      .object({
        passkeyIds: z.array(z.string().min(1)).min(1),
        eoa: z
          .object({
            id: z.string().min(1),
            address: EvmAddressSchema,
          })
          .strict()
          .optional(),
      })
      .strict(),
    threshold: z.number().int().positive(),
  })
  .strict()
  .superRefine((treasury, ctx) => {
    if (new Set(treasury.signers.passkeyIds).size !== treasury.signers.passkeyIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["signers", "passkeyIds"],
        message: "passkey signer ids must be unique",
      });
    }
    const signerCount = treasury.signers.passkeyIds.length + (treasury.signers.eoa ? 1 : 0);
    if (treasury.threshold > signerCount) {
      ctx.addIssue({
        code: "custom",
        path: ["threshold"],
        message: `threshold ${treasury.threshold} exceeds ${signerCount} configured signer${signerCount === 1 ? "" : "s"}`,
      });
    }
  });
export type SplitsTreasury = z.output<typeof SplitsTreasurySchema>;

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
    venue: z.literal("kalshi"),
    /** Kalshi API key id (UUID, non-secret). The RSA private key lives in the keystore. */
    keyId: z.string().min(1),
  }),
]);

/** Where a deployed bot runs. `cassie deploy` writes it; `cassie destroy` clears it. */
export const DeploymentSchema = z.object({
  provider: z.literal("digitalocean"),
  dropletId: z.number().int().positive(),
  /** Public IPv4. */
  host: z.string(),
  region: z.string(),
  size: z.string(),
  user: z.string().default("root"),
  deployedAt: z.string().optional(),
});

export const BotConfigSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "bot id: lowercase alphanumerics and dashes, max 32 chars"),
    venue: z.enum(["polymarket", "kalshi", "hyperliquid", "lighter"]),
    account: VenueAccountSchema.optional(),
    wallet: WalletConfigSchema.prefault({}),
    treasury: SplitsTreasurySchema.optional(),
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
    /** Set by `cassie deploy`: the droplet this bot runs on. */
    deployment: DeploymentSchema.optional(),
    createdAt: z.string().optional(),
  })
  .superRefine((config, ctx) => {
    const treasurySigner = config.treasury?.signers.eoa;
    if (
      treasurySigner &&
      config.wallet.address &&
      treasurySigner.address.toLowerCase() !== config.wallet.address.toLowerCase()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["treasury", "signers", "eoa", "address"],
        message: "Splits EOA signer must match this bot's wallet address",
      });
    }
    if (config.venue === "polymarket" && treasurySigner) {
      ctx.addIssue({
        code: "custom",
        path: ["treasury", "signers", "eoa"],
        message: "Polymarket's deployed signer cannot also control the Splits treasury; use operator passkeys only",
      });
    }
    if (config.account && config.account.venue !== config.venue) {
      ctx.addIssue({
        code: "custom",
        path: ["account", "venue"],
        message: `account venue ${config.account.venue} does not match bot venue ${config.venue}`,
      });
    }
    // Kalshi accounts carry no wallet address (API-key auth), so they yield
    // undefined here and skip the wallet/account cross-check.
    const accountWalletAddress =
      config.account?.venue === "polymarket"
        ? config.account.signerAddress
        : config.account?.venue === "hyperliquid"
          ? config.account.masterAddress
          : config.account?.venue === "lighter"
            ? config.account.l1Address
            : undefined;
    if (
      config.wallet.address &&
      accountWalletAddress &&
      config.wallet.address.toLowerCase() !== accountWalletAddress.toLowerCase()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["account"],
        message: "venue account does not match this bot's wallet address",
      });
    }
  });
export type BotConfig = z.output<typeof BotConfigSchema>;

/**
 * Unknown keys are dropped, which is also the migration path off the
 * Cloudflare-era `controlUrl`: an older config still loads, and saving it back
 * writes the field out.
 */
export function parseBotConfig(raw: unknown): BotConfig {
  return BotConfigSchema.parse(raw);
}

export function serializeBotConfig(cfg: BotConfig): string {
  return JSON.stringify(cfg, null, 2) + "\n";
}

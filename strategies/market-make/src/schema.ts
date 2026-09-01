// strategies/market-make/src/schema.ts
// Strict external configuration and normalized replay-event schemas.

import { z } from "zod";

const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const positive = finite.positive();
const probability = finite.min(0).max(1);
const timestamp = finite.nonnegative();
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

const CapitalSchema = strict({
  initial_bankroll_usd: positive,
  sizing_bankroll_usd: positive,
  auto_compound: z.boolean(),
  max_total_inventory_and_pending_entry_cost_usd: positive,
  minimum_free_collateral_usd: nonnegative,
  operational_reserve_usd: nonnegative,
  base_order_notional_usd: positive,
  max_order_notional_usd: positive,
  hard_market_cost_usd: positive,
  max_active_markets: z.number().int().positive(),
  max_live_orders: z.number().int().positive(),
});

const QuotientFeedSchema = strict({
  discovery_command: z.array(z.string()).min(1),
  exact_forecast_command_template: z.array(z.string()).min(1),
  idle_poll_seconds: positive,
  active_poll_seconds: positive,
  daily_api_cost_cap_usd: positive,
  require_published_signal_for_new_entry: z.boolean(),
  require_is_active: z.boolean(),
  require_live_priced: z.boolean(),
  require_suppression_reason_null: z.boolean(),
  new_entry_max_forecast_age_seconds: positive,
  no_add_forecast_age_seconds: positive,
  stale_forecast_exit_seconds: positive,
  missing_row_policy: z.literal("freeze_entries_then_exact_forecast_lookup"),
  missing_row_is_not_retirement: z.boolean(),
  units: strict({
    entry_q: z.literal("0_to_100_yes_scale"),
    entry_pm: z.literal("0_to_100_yes_scale"),
    latest_q: z.literal("0_to_1_yes_scale"),
    "market.market_odds": z.literal("0_to_1_yes_scale"),
    "venue_quote.selected_probability": z.literal("0_to_1_yes_scale"),
  }),
});

const MarketCatalogSchema = strict({
  gamma_refresh_seconds: positive,
  require_active: z.boolean(),
  require_closed_false: z.boolean(),
  require_archived_false: z.boolean(),
  require_accepting_orders: z.boolean(),
  require_orderbook_enabled: z.boolean(),
  require_condition_id: z.boolean(),
  require_yes_and_no_token_ids: z.boolean(),
  minimum_seconds_to_end_at_entry: positive,
  allow_neg_risk_children: z.boolean(),
  net_risk_across_neg_risk_children: z.boolean(),
  identity_key: z.literal("market.marketKey"),
  clob_identity_key: z.literal("market.condition_id"),
});

const MarketDataSchema = strict({
  clob_sdk_generation: z.literal("v2"),
  public_market_websocket: z.boolean(),
  authenticated_user_websocket: z.boolean(),
  rest_snapshot_on_connect_and_gap: z.boolean(),
  market_ws_ping_seconds: positive,
  market_data_stale_seconds: positive,
  venue_quote_max_age_seconds: positive,
  book_sequence_gap_action: z.literal("cancel_market_orders_and_resnapshot"),
  subscribe_both_outcome_tokens: z.boolean(),
  max_yes_no_midpoint_complement_error_pp: nonnegative,
});

const EligibilitySchema = strict({
  q_market_edge_min_pp: nonnegative,
  q_market_edge_max_pp: positive,
  q_market_edge_bounds_inclusive: z.boolean(),
  apply_30pp_cap_to_q_market_gap: z.boolean(),
  hard_max_selected_token_book_spread_pp: positive,
  max_selected_token_book_spread_pp: positive,
  book_spread_policy: z.string().min(1),
  historical_bbo_filter_backtested: z.boolean(),
  min_selected_side_price: probability,
  max_selected_side_price: probability,
  min_q_probability_on_selected_side: probability,
  min_live_depth_usd_within_2c: nonnegative,
  min_volume_24h_usd: nonnegative,
  entry_stability_seconds: nonnegative,
  max_move_away_from_q_during_entry_stability_pp: nonnegative,
  reject_crossed_or_empty_book: z.boolean(),
  reject_unknown_tick_or_min_order_size: z.boolean(),
  reject_drawdown_risk_elevated: z.boolean(),
});

const DirectionSchema = strict({
  minimum_edge_pp: nonnegative,
  maximum_edge_pp: positive,
  size_multiplier: nonnegative,
  target_market_cost_usd: nonnegative,
  maximum_center_shift_pp: nonnegative,
});

const DirectionPolicySchema = strict({
  NO: DirectionSchema,
  YES: DirectionSchema,
  bearish_inventory_order: z.tuple([z.literal("sell_free_yes_inventory"), z.literal("buy_no")]),
  bullish_inventory_order: z.tuple([z.literal("sell_free_no_inventory"), z.literal("buy_yes")]),
  never_sell_more_than_free_token_inventory: z.boolean(),
});

const VolRegimeSchema = strict({
  new_entry_enabled: z.boolean(),
  size_multiplier: nonnegative,
  extra_quote_ticks: z.number().int().nonnegative(),
});

const VolatilitySchema = strict({
  definition: z.literal("sqrt_sum_squared_hourly_midpoint_changes_over_trailing_24h_in_pp"),
  acceleration_definition: z.literal("rv24_divided_by_mean_daily_rv_of_prior_6_days"),
  dead_rv24_upper_pp: nonnegative,
  normal_rv24_upper_pp: positive,
  high_rv24_upper_pp: positive,
  extreme_acceleration_lower: positive,
  regimes: strict({
    dead: VolRegimeSchema,
    normal: VolRegimeSchema,
    high: VolRegimeSchema,
    extreme: VolRegimeSchema,
  }),
});

const DiversificationSchema = strict({
  category_families: strict({
    international: z.array(z.string()),
    domestic: z.array(z.string()),
    macro_business: z.array(z.string()),
    culture_tech: z.array(z.string()),
  }),
  allocation_method: z.literal("one_best_candidate_per_available_family_first_then_fill_remaining_slots_by_candidate_priority"),
  target_distinct_families_when_available: z.number().int().positive(),
  may_relax_entry_or_risk_gate_for_diversification: z.boolean(),
});

const QuoteModelSchema = strict({
  order_type: z.literal("GTC"),
  post_only: z.literal(true),
  fair_value_beta: nonnegative,
  minimum_remaining_edge_at_entry_policy: z.literal("direction_policy.minimum_edge_pp"),
  maximum_ticks_behind_best_bid: z.number().int().nonnegative(),
  quote_ttl_seconds: positive,
  minimum_ordinary_rest_seconds: nonnegative,
  reprice_on_bbo_move_ticks: z.number().int().positive(),
  reprice_on_q_move_pp: positive,
  cancel_entry_when_edge_below_direction_minimum: z.boolean(),
  edge_size_multiplier_enabled: z.boolean(),
  size_cap_fraction_of_depth_within_2c: probability,
  size_cap_fraction_of_best_level: probability,
  cancel_remaining_entry_after_any_fill: z.boolean(),
  post_fill_add_pause_seconds: nonnegative,
  max_inventory_increasing_fills_per_market_per_day: z.number().int().positive(),
});

const PortfolioRiskSchema = strict({
  max_event_cost_usd: positive,
  max_category_family_cost_usd: positive,
  max_manual_correlation_group_cost_usd: positive,
  max_open_markets_per_event: z.number().int().positive(),
  count_pending_entries_as_filled: z.boolean(),
  reserve_cancel_pending_and_replacement_simultaneously: z.boolean(),
  same_event_source: z.string().min(1),
  category_family_source: z.literal("diversification.category_families"),
  title_similarity_may_not_net_risk: z.boolean(),
});

const InventorySchema = strict({
  track_yes_and_no_quantities_separately: z.boolean(),
  track_free_and_reserved_sell_quantity: z.boolean(),
  track_average_cost_by_token: z.boolean(),
  track_worst_case_resolution_pnl: z.boolean(),
  allow_averaging_down_after_adverse_shock: z.boolean(),
  allow_same_side_add_after_favorable_q_refresh: z.boolean(),
  merge_verified_complete_sets: z.boolean(),
  net_unrelated_markets: z.boolean(),
});

const ExitPolicySchema = strict({
  primary_style: z.literal("convergence_or_forecast_change_with_time_ceiling"),
  remaining_live_q_edge_exit_pp: nonnegative,
  captured_initial_gap_fraction_exit: probability,
  early_fixed_take_profit_enabled: z.boolean(),
  partial_scale_out_enabled: z.boolean(),
  soft_review_after_seconds: positive,
  default_hard_hold_seconds: positive,
  absolute_max_hold_seconds: positive,
  forecast_refresh_can_extend_once: z.boolean(),
  maximum_extension_seconds: positive,
  same_side_refresh_min_edge_to_hold_pp: nonnegative,
  same_side_refresh_edge_below_pp_to_exit: nonnegative,
  retired_reasons_to_urgent_exit: z.array(z.enum(["flipped", "fading_q"])),
  expired_signal_policy: z.literal("normal_exit_unless_a_newer_same-side_forecast_qualifies_the_single_extension"),
  extension_requires_forecast_newer_than_first_fill: z.boolean(),
  forecast_status_actions: strict({
    converged: z.literal("exit_remaining_inventory"),
    converging: z.literal("hold_unless_other_exit_trigger"),
    sideways: z.literal("hold_until_next_q_or_time_limit"),
    diverging: z.literal("cancel_adds_and_wait_for_q_refresh"),
    caution: z.literal("cancel_adds_and_reduce_if_liquid"),
    warning: z.literal("urgent_exit"),
  }),
  normal_exit_order: z.literal("post_only_sell_selected_token_at_or_one_tick_inside_best_ask"),
  normal_exit_reprice_seconds: positive,
  normal_exit_max_rest_seconds: positive,
  normal_exit_then_fak_max_concession_pp: nonnegative,
  urgent_exit_order: z.literal("FAK_sell_selected_token_against_bids"),
  urgent_exit_max_concession_pp: nonnegative,
  urgent_exit_max_attempts: z.number().int().positive(),
});

const MarketShockSchema = strict({
  adverse_move_5m_pp: positive,
  adverse_move_15m_pp: positive,
  absolute_move_60s_pp: positive,
  spread_multiple_vs_trailing_5m: positive,
  depth_drop_fraction_60s: probability,
  entry_freeze_seconds: positive,
  require_new_q_version_after_adverse_shock: z.boolean(),
  favorable_shock_action: z.literal("cancel_entries_and_evaluate_convergence_exit"),
  adverse_shock_action: z.literal("cancel_entries_do_not_add_wait_for_new_q_or_risk_exit"),
  correlated_shocks_for_global_pause: z.number().int().positive(),
  correlated_shock_window_seconds: positive,
  global_shock_pause_seconds: positive,
});

const LossLimitsSchema = strict({
  max_marked_loss_per_market_usd: positive,
  max_rolling_24h_loss_usd: positive,
  max_strategy_drawdown_usd: positive,
  three_consecutive_order_rejections_global_pause_seconds: positive,
});

const LiquidityRewardsSchema = strict({
  mode: z.literal("observe_and_account_only"),
  poll_market_reward_configuration: z.boolean(),
  reward_may_bypass_entry_or_risk_gate: z.boolean(),
  reward_may_increase_order_size: z.boolean(),
  assumed_reward_in_backtest_usd: nonnegative,
  record_only_actual_paid_rewards: z.boolean(),
});

const ReconciliationSchema = strict({
  rest_reconcile_seconds: positive,
  reconcile_on_startup: z.boolean(),
  reconcile_after_websocket_reconnect: z.boolean(),
  deduplicate_fills_by: z.array(z.enum(["trade_id", "maker_order_id", "matched_amount_delta"])),
  unknown_order_state_action: z.literal("reserve_risk_cancel_and_reconcile"),
  cancel_all_on_shutdown: z.boolean(),
});

const GlobalKillSwitchesSchema = strict({
  manual_halt: z.boolean(),
  market_websocket_stale_seconds: positive,
  user_websocket_stale_seconds: positive,
  max_clock_skew_seconds: positive,
  unresolved_inventory_mismatch_cycles: z.number().int().positive(),
  cancel_only_or_venue_incident: z.boolean(),
  insufficient_collateral_or_allowance: z.boolean(),
  loss_limit_breach: z.boolean(),
  venue_access_preflight_failure: z.boolean(),
});

const TelemetrySchema = strict({
  markout_horizons_seconds: z.array(positive),
  record_every_gate_decision: z.boolean(),
  record_q_version_and_units: z.boolean(),
  record_book_and_quote_inputs: z.boolean(),
  record_order_and_fill_lifecycle: z.boolean(),
  record_inventory_and_resolution_scenarios: z.boolean(),
  record_forecast_change_and_exit_reason: z.boolean(),
  record_realized_rewards_and_fees: z.boolean(),
  record_api_cost: z.boolean(),
  redact_credentials_signatures_and_private_keys: z.boolean(),
});

export const CassieOverridesSchema = strict({
  bankroll: strict({
    /**
     * `live` treats the configured dollar limits as ratios against the
     * reference sizing bankroll and applies them to funded strategy capital.
     * `fixed` preserves the literal configured dollar limits.
     */
    mode: z.enum(["live", "fixed"]).default("live"),
    maximum_sizing_bankroll_usd: positive.nullable().default(null),
  }).prefault({}),
  renewal_min_edge_pp: strict({
    NO: nonnegative.default(10),
    YES: nonnegative.default(20),
  }).prefault({}),
  liquidity: strict({
    minimum_exit_bid_depth_1c_usd: nonnegative.default(1_000),
    minimum_exit_bid_depth_2c_usd: nonnegative.default(2_500),
    max_order_fraction_of_exit_bid_depth_1c: probability.default(0.02),
    max_order_fraction_of_exit_bid_depth_2c: probability.default(0.008),
    max_market_fraction_of_exit_bid_depth_1c: probability.default(0.04),
    max_market_fraction_of_exit_bid_depth_2c: probability.default(0.016),
  }).prefault({}),
}).prefault({});

export const MarketMakeConfigSchema = strict({
  schema_version: z.literal("q-directed-polymarket-mm/1"),
  strategy_id: z.literal("q-directed-passive-inventory-v1"),
  venue: z.literal("polymarket"),
  mode: z.literal("passive_entry_passive_inventory_exit"),
  decision_probability: z.literal("latest canonical served Q probability"),
  external_news_or_x_enabled: z.literal(false),
  capital: CapitalSchema,
  quotient_feed: QuotientFeedSchema,
  market_catalog: MarketCatalogSchema,
  market_data: MarketDataSchema,
  eligibility: EligibilitySchema,
  direction_policy: DirectionPolicySchema,
  volatility: VolatilitySchema,
  candidate_priority: z.tuple([
    z.literal("existing_inventory_reduction_first"),
    z.literal("first_pass_adds_new_category_family"),
    z.literal("NO_before_YES"),
    z.literal("larger_live_edge_within_bounds"),
    z.literal("newer_forecast"),
    z.literal("tighter_book_spread"),
    z.literal("greater_depth_within_2c"),
  ]),
  diversification: DiversificationSchema,
  quote_model: QuoteModelSchema,
  portfolio_risk: PortfolioRiskSchema,
  inventory: InventorySchema,
  exit_policy: ExitPolicySchema,
  market_shock: MarketShockSchema,
  loss_limits: LossLimitsSchema,
  liquidity_rewards: LiquidityRewardsSchema,
  reconciliation: ReconciliationSchema,
  global_kill_switches: GlobalKillSwitchesSchema,
  telemetry: TelemetrySchema,
  cassie_overrides: CassieOverridesSchema,
}).superRefine((cfg, ctx) => {
  const issue = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: "custom", path, message });
  };
  if (cfg.capital.max_order_notional_usd > cfg.capital.hard_market_cost_usd) {
    issue(["capital", "max_order_notional_usd"], "max order cannot exceed hard market cost");
  }
  if (
    cfg.capital.max_total_inventory_and_pending_entry_cost_usd + cfg.capital.minimum_free_collateral_usd + cfg.capital.operational_reserve_usd >
    cfg.capital.sizing_bankroll_usd + 1e-9
  ) {
    issue(["capital"], "deployment, free collateral, and reserve exceed sizing bankroll");
  }
  if (cfg.eligibility.q_market_edge_min_pp > cfg.eligibility.q_market_edge_max_pp) {
    issue(["eligibility"], "minimum Q edge exceeds maximum");
  }
  if (cfg.eligibility.q_market_edge_max_pp > 30) {
    issue(["eligibility", "q_market_edge_max_pp"], "Q-market edge maximum cannot exceed the 30pp hard sanity ceiling");
  }
  if (cfg.eligibility.max_selected_token_book_spread_pp > cfg.eligibility.hard_max_selected_token_book_spread_pp) {
    issue(["eligibility", "max_selected_token_book_spread_pp"], "operational spread exceeds hard sanity spread");
  }
  if (cfg.eligibility.min_selected_side_price >= cfg.eligibility.max_selected_side_price) {
    issue(["eligibility"], "selected-side price interval is empty");
  }
  for (const side of ["NO", "YES"] as const) {
    if (cfg.direction_policy[side].minimum_edge_pp > cfg.direction_policy[side].maximum_edge_pp) {
      issue(["direction_policy", side], "direction minimum edge exceeds maximum");
    }
    if (cfg.direction_policy[side].maximum_edge_pp > 30) {
      issue(["direction_policy", side, "maximum_edge_pp"], "direction maximum edge cannot exceed the 30pp hard sanity ceiling");
    }
  }
  if (!(cfg.volatility.dead_rv24_upper_pp < cfg.volatility.normal_rv24_upper_pp && cfg.volatility.normal_rv24_upper_pp < cfg.volatility.high_rv24_upper_pp)) {
    issue(["volatility"], "volatility thresholds must be strictly increasing");
  }
  if (!(cfg.exit_policy.soft_review_after_seconds < cfg.exit_policy.default_hard_hold_seconds && cfg.exit_policy.default_hard_hold_seconds < cfg.exit_policy.absolute_max_hold_seconds)) {
    issue(["exit_policy"], "review, hard hold, and absolute hold must be strictly increasing");
  }
  if (cfg.cassie_overrides.liquidity.minimum_exit_bid_depth_1c_usd > cfg.cassie_overrides.liquidity.minimum_exit_bid_depth_2c_usd) {
    issue(["cassie_overrides", "liquidity"], "1c minimum depth cannot exceed 2c minimum depth");
  }
  if (
    cfg.cassie_overrides.bankroll.mode === "fixed" &&
    cfg.cassie_overrides.bankroll.maximum_sizing_bankroll_usd !== null
  ) {
    issue(
      ["cassie_overrides", "bankroll", "maximum_sizing_bankroll_usd"],
      "a sizing-bankroll ceiling applies only in live bankroll mode",
    );
  }
});

export type MarketMakeConfig = z.output<typeof MarketMakeConfigSchema>;
export type MarketMakeConfigInput = z.input<typeof MarketMakeConfigSchema>;

const OutcomeSchema = z.enum(["YES", "NO"]);
const ForecastStatusSchema = z.enum(["converged", "converging", "sideways", "diverging", "caution", "warning"]);
const BookLevelSchema = strict({ price: probability, size: nonnegative });
const TokenBookSchema = strict({ tokenId: z.string().min(1), bids: z.array(BookLevelSchema), asks: z.array(BookLevelSchema), ts: timestamp });
const PublishedSignalSchema = strict({
  id: z.string().min(1),
  marketKey: z.string().min(1),
  nativeMarketId: z.string().min(1),
  conditionId: z.string().min(1),
  publishedAt: timestamp,
  entryQ: finite,
  entryPm: finite,
  latestQ: finite,
  qAsOf: timestamp,
  active: z.boolean(),
  livePriced: z.boolean(),
  suppressionReason: z.string().nullable().optional(),
  retiredReason: z.enum(["flipped", "fading_q", "expired", "resolved"]).nullable().optional(),
  forecastStatus: ForecastStatusSchema.optional(),
  drawdownRiskElevated: z.boolean().optional(),
});
const CatalogSchema = strict({
  marketKey: z.string().min(1), nativeMarketId: z.string().min(1), conditionId: z.string().min(1), marketRef: z.string().min(1),
  eventId: z.string().min(1), category: z.string(), manualCorrelationGroup: z.string().optional(), yesTokenId: z.string().min(1), noTokenId: z.string().min(1),
  active: z.boolean(), closed: z.boolean(), archived: z.boolean(), acceptingOrders: z.boolean(), orderbookEnabled: z.boolean(), endsAt: timestamp,
  volume24hUsd: nonnegative, tickSize: positive, minOrderSize: positive, rewardRateUsd: nonnegative.optional(),
});
const VolatilitySnapshotSchema = strict({ rv24Pp: nonnegative, acceleration: nonnegative });
const StabilitySnapshotSchema = strict({ validSince: timestamp, maxMoveAwayFromQPp: nonnegative });
const OrderPurposeSchema = z.enum(["entry", "inventory-reduction", "normal-exit", "urgent-exit"]);
const TrackedOrderSchema = strict({
  orderId: z.string().min(1), clientId: z.string().min(1), marketKey: z.string().min(1), marketRef: z.string().min(1), conditionId: z.string().min(1), tokenId: z.string().min(1),
  outcome: OutcomeSchema, side: z.enum(["BUY", "SELL"]), size: positive, filledSize: nonnegative, price: probability,
  tif: z.enum(["GTC", "FAK"]), postOnly: z.boolean(), qAsOfAtPlacement: timestamp.optional(), qSideAtPlacement: probability.optional(), bestBidAtPlacement: probability.optional(),
  purpose: OrderPurposeSchema, status: z.enum(["PLANNED", "LIVE", "PARTIAL", "CANCEL_PENDING", "CANCELED", "FILLED", "REJECTED", "UNKNOWN"]), createdAt: timestamp,
});
const LossSnapshotSchema = strict({ marketLossUsd: z.record(z.string(), nonnegative), rolling24hLossUsd: nonnegative, drawdownUsd: nonnegative });

export const NormalizedMarketMakeEventSchema = z.discriminatedUnion("type", [
  strict({ type: z.literal("signal"), ts: timestamp, signal: PublishedSignalSchema }),
  strict({ type: z.literal("catalog"), ts: timestamp, market: CatalogSchema }),
  strict({ type: z.literal("book"), ts: timestamp, marketKey: z.string(), outcome: OutcomeSchema, book: TokenBookSchema }),
  strict({ type: z.literal("volatility"), ts: timestamp, marketKey: z.string(), volatility: VolatilitySnapshotSchema }),
  strict({ type: z.literal("stability"), ts: timestamp, marketKey: z.string(), stability: StabilitySnapshotSchema }),
  strict({ type: z.literal("fill"), ts: timestamp, fillId: z.string(), orderId: z.string(), clientId: z.string().optional(), marketKey: z.string(), tokenId: z.string(), outcome: OutcomeSchema, side: z.enum(["BUY", "SELL"]), size: positive, price: probability, feeUsd: nonnegative.optional() }),
  strict({ type: z.literal("order"), ts: timestamp, marketKey: z.string(), order: TrackedOrderSchema }),
  strict({ type: z.literal("cancel-confirmed"), ts: timestamp, marketKey: z.string(), orderId: z.string() }),
  strict({ type: z.literal("timer"), ts: timestamp }),
  strict({ type: z.literal("balance"), ts: timestamp, availableCollateralUsd: nonnegative }),
  strict({ type: z.literal("loss"), ts: timestamp, loss: LossSnapshotSchema }),
  strict({ type: z.literal("shock"), ts: timestamp, marketKey: z.string(), adverse: z.boolean(), reason: z.string() }),
  strict({ type: z.literal("reward"), ts: timestamp, marketKey: z.string(), amountUsd: nonnegative }),
  strict({
    type: z.literal("inventory-reconciled"), ts: timestamp, marketKey: z.string().min(1),
    tokenId: z.string().min(1), outcome: OutcomeSchema, quantity: nonnegative,
    costBasisUsd: nonnegative, reason: z.string().min(1),
  }),
  strict({
    type: z.literal("redemption"), ts: timestamp, marketKey: z.string().min(1),
    status: z.enum(["submitted", "failed", "confirmed"]),
    quantity: positive.optional(), payoutUsd: nonnegative.optional(),
    reference: z.string().trim().min(1).max(256).regex(/^[\x20-\x7E]+$/, "reference must contain printable ASCII only").optional(),
    error: z.string().min(1).optional(),
  }),
  strict({
    type: z.literal("execution"), ts: timestamp, marketKey: z.string().min(1),
    clientId: z.string().min(1), status: z.enum(["accepted", "rejected"]), reason: z.string().min(1).optional(),
  }),
  strict({ type: z.literal("halt"), ts: timestamp, liquidate: z.boolean() }),
  strict({ type: z.literal("resume"), ts: timestamp, acknowledgeLossReset: z.boolean() }),
]);

export const MarketMakeReplayBundleSchema = strict({
  schemaVersion: z.literal("cassie-market-make-replay/1"),
  generatedAt: z.string().datetime(),
  source: z.string().min(1),
  events: z.array(NormalizedMarketMakeEventSchema),
});

export type ParsedMarketMakeReplayBundle = z.output<typeof MarketMakeReplayBundleSchema>;

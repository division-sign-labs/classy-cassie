# Cassie market-make strategy

`market-make` supports two distinct execution policies. They do not run together.

## Two-sided spread quoting

`createTwoSidedMarketMakeConfig()` selects `two-sided-spread-v1`. Discovery uses active Polymarket markets and executable books, without forecast-direction or Q-edge gates.

- A flat market starts with matched-share YES and NO bids. Equal shares do not mean equal dollar amounts.
- Held tokens are offered back out through passive SELL orders. Each economic bid/ask has one route, preventing duplicate exits through complementary tokens.
- Inventory imbalance skews prices; cash, gross inventory, pending orders, and unmatched exposure remain bounded.
- Quotes are post-only. Routine checks do not cancel unchanged quotes.

The planner is `planTwoSidedQuotes`. Its defaults are operating choices, not empirically optimized parameters. Complementary orders fill independently; a quoted spread does not guarantee a paired fill or a profit. This follows Polymarket's [complementary-token market-making mechanics](https://docs.polymarket.com/trading/market-making).

The legacy replay cannot model this policy and rejects two-sided configurations.

The runtime keeps a bounded trading checkpoint in the existing SQLite database: orders, settlement receipts, inventory, activation, and loss-limit state. Books and rejected-candidate telemetry are not stored. An activated deployment resumes after clean startup checks; temporary data outages can recover after cancellation and reconciliation. Operator halts, ambiguous submissions, configuration changes, and loss stops require explicit review.

Normal inventory exits use CLOB sells. Resolution redemption is a separate capability: the SDK redeems both outcomes for a condition, but Deposit Wallet redemption requires relayer authorization absent from the standard trade-only runtime credentials. Resolved inventory pauses new entries and is marked operator-required. Local redemption and reviewed balance reconciliation clear that marker; the runtime does not widen credentials or repeatedly attempt an unauthorized transaction.

## Legacy forecast inventory

`createMarketMakeConfig()` retains `q-directed-passive-inventory-v1` for existing configurations. This policy is directional passive inventory, not a symmetric dealer. It consumes normalized Quotient, Gamma, CLOB book, user-order/fill, timer, shock, and loss events; one pure reducer produces passive entry, bounded exit, and cancellation actions. The runtime handles credentials, persistence, risk reservations, reconciliation, and venue execution.

The authoritative research payload is vendored unchanged as `strategy.v1.json`. Its SHA-256 and source path are recorded in `strategy.v1.provenance.json`. `MARKET_MAKE_PRESET` resolves three Cassie-specific decisions without modifying that source artifact:

- funded strategy capital is the live sizing source by default, with an optional ceiling;
- renewal requires at least 10pp remaining edge for NO and 20pp for YES;
- executable selected-token bid depth must be at least $1,000 within 1¢ and $2,500 within 2¢, with 2%/0.8% order participation and 4%/1.6% total-market participation.

Public entry points:

- `MarketMakeConfigSchema`, `MARKET_MAKE_PRESET`, `createMarketMakeConfig`, `effectiveMarketMakeBankrollUsd`, `marketMakeConfigForBankroll`, and `marketMakeConfigHash`;
- `normalizeCandidate`, `gateCandidate`, `buildEntryQuote`, `allocateCandidates`, and `evaluateExit`;
- `createInitialMarketMakeState` and `reduceMarketMake` for both live and replay processing;
- `MarketMakeReplayBundleSchema` and `replayMarketMake(bundle, config, { fillModel })` for a single normalized JSON replay bundle.

No module in this package performs network I/O, reads credentials, signs, or submits an order.

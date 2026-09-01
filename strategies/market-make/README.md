# Cassie market-make strategy

`market-make` is a deterministic, Polymarket-only, Q-directed passive-inventory strategy. It is not a symmetric always-on dealer. It consumes normalized Quotient, Gamma, CLOB book, user-order/fill, timer, shock, and loss events; one pure reducer produces explicit passive entry, bounded exit, and cancellation actions. The runtime remains responsible for credentials, persistence, risk reservations, reconciliation, and venue execution.

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

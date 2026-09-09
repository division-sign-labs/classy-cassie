# Quotient swing

1–5 day equity and commodity perpetual strategy for Hyperliquid’s `xyz` market. Published Quotient price outlooks select direction and target; deterministic cost, concentration and margin rules control execution. The rule follows the perps-frame study of price outlooks (enter when a reading publishes, take profit on the first touch of the median, otherwise mark at the anchor). Parameters are research defaults; live profitability has not been established.

## Setup

Use a new bot id and its own account; do not repurpose a bot with another strategy’s state or exposure. Build this checkout with `pnpm build`, then use the linked `cassie` binary below, or substitute `node packages/cli/dist/index.js` for `cassie`.

```sh
cassie init
```

In the wizard, choose a new id such as `q-swing`, Hyperliquid, and `quotient-swing`. Enter the Quotient credential only through the secret prompts or supported local credential storage. Keep keys and passphrases out of CLI arguments, chat and logs. Hyperliquid’s master key stays in the local encrypted keystore; the runtime uses an approved trade-scoped agent key. No LLM credential is used.

Complete the wizard’s funding flow, or return to it with `cassie fund q-swing`. Review and confirm the exact destination and amount before sending funds. That flow also approves the Hyperliquid agent key once the venue account exists. The strategy requires Standard account mode and USDC allocated to the `xyz` perp DEX. A deposit to the default perp DEX is not `xyz` NAV; transfer collateral explicitly and verify the reported `xyz` balance before starting. The strategy sizes every order from that live NAV, so any account size works; orders below the venue’s minimum size are skipped.

Deploy this checkout to a DigitalOcean droplet:

```sh
cassie deploy q-swing --from-workspace
```

The workspace flag packages the current checkout for the droplet. Without it, deployment installs the published Cassie release. To run locally instead, keep this command open on a computer that stays awake:

```sh
cassie run q-swing
```

Running or deploying starts live trading after account and execution checks. Restarts preserve existing operator and safety halts. A strategy configuration change (including an upgrade that adds or removes settings) changes the execution config hash; the runtime then halts entries with `config-drift` until an operator runs `cassie swing resume q-swing`, which is allowed while the bot is flat.

Monitor the bot with:

```sh
cassie swing status q-swing
cassie logs q-swing
```

Status reports the eligible outlook count and per-reason rejection counts from the last decision cycle. `cassie swing halt q-swing` cancels additions while preserving native stops, resting targets and exit supervision; it does not liquidate the account. Use `cassie swing resume q-swing` to recover after a reviewed operator or safety halt. A drawdown reset uses `--acknowledge-loss-reset` and requires confirmation. Generic order cancellation is disabled for swing bots.

Optional diagnostics: `cassie swing dry-run q-swing` reports proposed decisions without placing orders (it fetches outlooks, which are metered). `cassie swing configure q-swing --config /absolute/path/config.json` updates settings only while the local runtime is stopped; deployed configurations require the reviewed deployment workflow. Settings from earlier strategy revisions are dropped on load.

## Decisions

The strategy intersects Quotient-covered assets with active `xyz` instruments and considers every exact Hyperliquid outlook with 24–120 hours remaining. An outlook is eligible when it is active with an accepted freshness state (`freshnessStates`, default `fresh`), published within `maxPublicationAgeHours` (2; outlooks publish hourly), carries a full quantile curve, has a bullish or bearish directional take, and its `spot_gap_sigma` (median distance from spot in units of the outlook’s uncertainty) lies inside `[minGapSigma, maxGapSigma]` (defaults 0.30–1.0) on the published side. The backtest in `research/swing-perps/report.md` found trades below 0.30σ carry no edge after costs.

For each eligible outlook the entry is a crossing IOC order bounded by `maxSlippageBps`; the target is the median; the stop is `stopSigmaMultiple` (3.0) × `sigma_total`, scaled by the square root of the remaining horizon fraction. The backtest in `research/swing-perps/report.md` found stops only subtract expectancy, so the stop is a wide safety net. Net edge is the log return from entry to target after two taker fees, the spread, twice the slippage bound and an adverse funding reserve (`fundingReserveMultiple` × current hourly rate × remaining hours). Outlooks whose median the market has already crossed, or whose edge is inside costs, are rejected. Candidates are ranked by net edge, then by nearer anchor; one position per underlying; up to `maxPositions` (4). Assets in `reservedAssets` (default `commodity:wti`) always keep one slot available: other candidates leave that slot free until the reserved asset holds a position. After any exit the asset waits `postExitCooldownHours` (1) and the next hourly revision can re-enter it as a new trade.

## Risk

NAV determines sizing. Every position is isolated-margin, and size is a margin figure: the book may post `totalMarginPct` (80%) of NAV in total, and each tick's new entries share the unused part of that budget equally across the underlyings still to place plus any open reserved slot, capped at `singleMarginPct` (20%) of NAV each. Three eligible outlooks against an empty book therefore post about 20% each; a lone outlook posts 20%; once the budget is in use, a new entry takes what remains. Leverage is derived, not configured: the largest integer whose liquidation distance still clears the stop (`liquidationStopMultiple` 1.0 × stop distance plus `emergencyGapFraction` 1% plus the funding reserve), so notional is margin × that leverage. With a 3σ stop that is roughly 5–12× isolated leverage. The stop-loss budget (`riskBasePct` 10% to `riskMaxPct` 15% of NAV as net edge grows from `riskBaseEdge` 0.5% to `riskMaxEdge` 2%) and the limits below can reduce that size further; keep it at or above the margin share when margin should be the only binding rule:

| Limit | Default |
| --- | --- |
| Single / total isolated margin | 20% / 80% of NAV, new entries sharing the unused budget |
| Single position notional | 2 × NAV |
| Total notional | 10 × NAV |
| Positions | 9 (one slot reserved for `commodity:wti`) |
| Total planned stop loss | 90% of NAV |
| Leverage | Largest integer clearing the liquidation buffer, maximum 20× |

Venue risk checks remain authoritative; stop execution can incur gaps and slippage. At 15% drawdown, new position budgets are halved. At 25%, additions halt pending review and pending entries are canceled. Existing positions continue under their stop, target, forecast and time exit rules. External transfers adjust the NAV high-water mark. Clearing a loss stop requires the reviewed loss-reset command.

## Exits

The engine owns two resting orders per position: a native stop and a reduce-only take-profit limit at the median. The target follows the latest revision’s median in either direction. Exits also occur when the latest revision flips against the position with at least `minGapSigma`, when the latest median crosses the entry price, at the original forecast anchor or `maxHoldHours` (48) after the fill (the backtest found trades still open after 48 hours average a loss), and after `staleExitHours` without a usable forecast. Stops remain active independently of forecast availability. Non-urgent exits rest post-only for `exitRetryMin` and then cross within the execution limits.

## Offline replay

Offline replay is a research tool, not a trading mode. `replaySwing` simulates an ordered history of recorded live snapshots with the same decision reducer. It places no orders and does not modify the live account. Targets fill as maker orders once a later quote trades through the median (the optional touch model fills on a touch); stops fill from the book with the configured slippage. The ledger includes fees, adverse stop gaps and signed funding. Sharpe remains unavailable with fewer than 30 daily returns. Replay results are not evidence of live profitability.

```sh
cassie swing replay q-swing --costs 2 --fill-model cross
```

## Checks

```sh
pnpm --filter @quotient-forecasting/strategy-quotient-swing typecheck
pnpm exec vitest run --config strategies/quotient-swing/test/vitest.config.ts
pnpm exec vitest run packages/cli/test/swing.test.ts packages/runtime-node/test/swing-recordings.test.ts
```

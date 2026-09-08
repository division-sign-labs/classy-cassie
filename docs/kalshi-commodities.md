# Kalshi commodities

`kalshi-commodities` defaults to an oil-only pilot using the published Q blend for each exact Kalshi contract. Gold, Bitcoin, copper, and silver remain available through an explicit asset configuration. It submits bounded limit orders through Cassie's durable execution engine and permits one oil exposure capped at 2.5% of current equity. Each runtime start is paused; automated trading begins only after an explicit `commodities resume`.

Oil's published blend scored 0.1648 Brier versus the market's 0.1880 in the cohort matching the implemented price math with an assumed 2-cent spread. That cohort contains 60 forecasts across 37 markets and 11 fixing dates; actual fills and account Sharpe remain unmeasured. [Entry-band findings](../research/kalshi-commodities/performance/entry_bands.md)

The strategy is an experiment. The broader research includes 9,269 historical forecasts across 875 markets, but no actual Kalshi account ledger. [Research](../research/kalshi-commodities/README.md)

## Forecasts and settlement

The probability input is the current published blend on a directly linked Kalshi market. Discovery requires the exact Quotient asset relationship and native series, event, and market identifiers. Each selected contract is checked against live Kalshi metadata before its forecast can authorize entry. The oil pilot searches the oil series below; the other rows describe supported assets that must be enabled explicitly.

| Asset | Series considered | Settlement reference accepted |
|---|---|---|
| Oil | `KXWTI`, `KXWTIW` | ICE WBS daily settlement for the contract month named in the market |
| Gold | `KXGOLDD`, `KXGOLDW`, `KXGOLDMON` | Pyth `Metal.Index.GOLD/USD`, feed 3153 |
| Bitcoin | `KXBTCD`, `KXBTC` | Mean of CF Benchmarks BRTI observations over the preceding sixty seconds |
| Copper | `KXCOPPERD`, `KXCOPPERW`, `KXCOPPERMON` | Pyth `Commodities.Index.CU/USD`, feed 3525 |
| Silver | `KXSILVERD`, `KXSILVERW`, `KXSILVERMON` | Pyth `Metal.Index.SILVER/USD`, feed 3154 |

Metal contracts use the preceding one-minute candle close at the specified fixing and the contract's two-decimal rounding rule. WTI uses its named ICE contract and fixing; a generic front-month quote does not qualify. BTC uses BRTI's minute average, not a single exchange price. The validator checks source URLs, terms document, primary/secondary rules, fixing time, strike bounds, fee metadata, and a one-cent price grid. Unsupported wording or changed source metadata produces a refusal.

Gold and silver transitioned to continuous Pyth index feeds in late July. Copper daily markets transitioned for August 31, weekly markets for September 4, and monthly markets for September 30. Earlier copper futures contracts are different settlement regimes. The current strategy accepts the index regime and requires Q to postdate the series metadata update. A changed contract or rules digest invalidates outstanding entry authority. [Settlement audit](../research/kalshi-commodities/settlement.md), [silver source metadata](../research/kalshi-commodities/settlement/KXSILVERD-series.json)

Touch, maximum, minimum, cumulative, and other path-dependent products are excluded. Terminal monthlies may qualify only within the same 14-day horizon; their inclusion is not evidence of validated monthly performance. Above, below, and range geometry must agree with the exact numeric rules. Series recognition alone does not guarantee admission.

Price outlooks are included in the research report as diagnostics. The main curves describe Hyperliquid instruments; their Kalshi groups are statistical translations with their own dates and source uncertainty. They do not provide another independent probability vote, and the strategy does not invert those ranges into contract probabilities. This avoids importing a stale bridge, a different contract month, or a mismatched fixing into order sizing.

## Decisions

Discovery considers up to six current candidates per asset, preferring the nearest expiry and central venue probabilities before looking at Q's edge. Previously tracked contracts remain available for position supervision. A missing current forecast, disputed market, warning/caution status, unverified rules, stale book, or inadequate depth can leave the candidate set empty.

For each verified contract, the strategy selects YES when the published Q probability exceeds the live YES midpoint, and NO otherwise, then compares that outcome's probability with its executable ask. It then halves the published blend's disagreement with the current midpoint, subtracts one percentage point of model uncertainty, and reserves taker costs for entry and a possible exit. Each fee reserve includes an additional $0.01 per contract. At least two percentage points of edge must remain. The 50% weight is a conservative sizing rule, not a fitted calibration result.

For example, a 48/50-cent YES book and Q at 70% produce a 58.5% sizing probability after shrinkage and uncertainty. With a standard 7% quadratic taker coefficient, the two fee reserves leave about 3.05 percentage points of entry edge. A raw five-point disagreement generally fails the later cost gate.

Candidates are ranked by remaining edge adjusted for binary payout uncertainty and time to fixing. This is a ranking heuristic, not a measured Sharpe estimate. Sizing uses 15% Kelly, reduces allocation as gross and related exposure grow, and applies the smallest portfolio or liquidity cap. Positions, pending entries, and recent fills reserve the underlying. There are no repeat top-ups or multiple ladder strikes on the same underlying.

| Setting | Default |
|---|---|
| Assets | Oil only; gold, BTC, copper, and silver require explicit configuration |
| Engine cadence / public metadata verification | 1 minute / 5 minutes |
| Paid forecast refresh / outlook diagnostics | 30 minutes / 6 hours |
| Maximum Q age / maximum book age | 6 hours / 10 seconds |
| Entry horizon | 2 hours to 14 days before fixing |
| Held-outcome ask / maximum bid-ask spread | 10–90 cents / 5 cents |
| Published-Q executable edge before strategy adjustments | 5–25 percentage points |
| Q disagreement weight / uncertainty deduction | 50% / 1 percentage point |
| Required edge after reserves | 2 percentage points |
| Kelly fraction | 15% |
| Market / event / underlying caps | 2.5% / 2.5% / 2.5% of current equity |
| Gross premium cap | 10% of current equity |
| Shared-theme cap | 5%: oil+copper; BTC+gold+silver |
| Direction cap | 6% for each of up, down, and range exposure |
| Exit bids within two cents | At least $50 |
| Liquidity participation | At most 2% of exit bid depth and 2% of displayed best-ask notional |
| Minimum requested entry / engine order ceiling | $1 / $100 |
| Entry style / adaptive entry deadline | Marketable limit / 20 seconds |
| Normal exit passive period | 20 seconds |
| Equity drawdown / UTC-day loss stop | 8% / 3% |

The oil-only pilot retains the 2.5% underlying cap and one-exposure limit; the broader 10% gross cap does not increase its oil allocation. The caps are ceilings. Reserved costs and available depth often produce much smaller orders or no order. For example, two percent of a $50 book is only $1 before cost reserves. Unknown account exposure, external orders, incomplete inventory marks, stale research, or a blocked execution receipt disable additions. Default engine risk also checks order size and slippage after the strategy proposes an action.

Equity uses collateral plus positions marked at the executable held-side bid. Loss limits latch until reviewed and explicitly reset while flat. Deposits and withdrawals are not separately attributed in this strategy's risk ledger; moving cash can alter its measured gain or loss. Review account cash changes while flat and paused before resetting the baseline.

## Orders and exits

`marketable` submits an immediate-or-cancel limit at or below the observed ask. `adaptive` first attempts a passive order, then permits a bounded crossing attempt after the 20-second deadline. Both keep the original observed ask as the maximum entry price. A missed order is permitted; there is no additional allowance to chase a moving market. Execution preserves durable parent/child receipts, reconciles ambiguous submissions, and reserves recent fills while positions catch up.

The normal holding policy is settlement. A missing Q refresh alone does not force liquidation. Before fixing, the strategy can request an exit when:

- Q falls at least 15 points from the entry forecast and more than 3 points below the current held-side bid.
- The bid reaches Q and the gain exceeds the reserved exit fee plus 2 cents per contract.
- Settlement identity changes, or an equity loss limit latches.

Profitable convergence uses the passive exit period before a bounded crossing attempt. Invalidation, changed terms, and drawdown exits are urgent. The strategy's exit floor is three cents below the observed bid, rounded upward to a cent and bounded below by one cent. Liquidity, execution checks, and price bounds can leave an exit unfilled. There is no fixed percentage price stop, automatic seven-day liquidation, or guaranteed liquidation at the loss threshold.

Current series fee type and multiplier are checked on refresh. The official general taker coefficient is 0.07; maker coefficient is 0.0175 with a default maker multiplier of zero unless otherwise specified. A crossing limit is a taker. The additional $0.01-per-contract entry and exit allowances are strategy reserves, not official fees. [Official fee schedule](https://kalshi.com/docs/kalshi-fee-schedule.pdf)

## First test

From this checkout, `pnpm cassie` builds changed workspace inputs and runs the local CLI. The public scan needs the existing Quotient key from `.local.env`, the environment, or the Quotient CLI configuration. It does not unlock Kalshi credentials or place orders.

```sh
pnpm cassie commodities scan --equity 1000 --output /tmp/kalshi-commodities-scan.json
```

The report uses a hypothetical flat $1,000 portfolio and scans oil by default. Inspect the exact source identity, forecast age, bid/ask, net edge, size, and exclusions. An empty `actions` array is a valid result.

Create a **new bot ID** through the wizard; choose Kalshi and `kalshi-commodities`:

```sh
pnpm cassie init
```

Use a dedicated trading account with no unrelated orders or positions; a new bot ID does not isolate a shared Kalshi account. Demo is suitable only if it exposes the same native contract tickers and settlement rules. A generic demo universe may not match the production forecast catalog. In that case, use the public scan for testing without orders, then preview a small, separately funded production account while the runtime remains paused. Production activation places real orders.

The default entry mode is marketable limit. To choose adaptive entries, configure the stopped bot before starting it:

```sh
pnpm cassie commodities configure kalshi-commodities-test --execution adaptive
```

A `--config <file>` option accepts strategy JSON, with omitted fields filled from schema defaults, including `"assets": ["oil"]`. Additional assets require an explicit `assets` array. The file replaces the strategy settings; it does not merge into the previous configuration. `--execution` alone preserves the other current settings. Configuration changes require a stopped local runtime. Existing strategy state cannot be repurposed under a different bot strategy.

Start the runtime in one terminal:

```sh
pnpm cassie run kalshi-commodities-test
```

Every start remains paused until explicitly resumed. In another terminal, inspect the account preview and runtime state:

```sh
pnpm cassie commodities dry-run kalshi-commodities-test --output /tmp/kalshi-commodities-preview.json
pnpm cassie commodities status kalshi-commodities-test
pnpm cassie status kalshi-commodities-test
pnpm cassie logs kalshi-commodities-test
```

`dry-run` reads current research, positions, and orders, evaluates in isolated strategy memory, and returns proposed actions without submitting them. It can also preview a stopped bot. It does not simulate fills, produce a historical replay, or calculate realized account Sharpe. A zero-funded account reports no funded equity.

After reviewing the displayed limits and proposed orders, explicitly enable automation:

```sh
pnpm cassie commodities resume kalshi-commodities-test
```

The command displays current status and asks for confirmation. Keep the first session observable through status and logs. To stop trading and request cancellation of working orders:

```sh
pnpm cassie commodities halt kalshi-commodities-test
```

Halt pauses strategy trading; it does not liquidate existing holdings. Review status and logs before retrying an error. A latched loss stop requires the account to be flat with no working orders and a separate acknowledgment:

```sh
pnpm cassie commodities resume kalshi-commodities-test --acknowledge-loss-reset
```

Scans and dry runs use metered Quotient reads. The default forecast refresh is every 30 minutes and diagnostic outlook refresh every six hours, while public Kalshi metadata is rechecked every five minutes. At listed prices of $0.01 per asset lookup and $0.01 per outlook lookup, a full day of continuous operation implies about $0.52 before extra cold-start scans or other usage. This is a list-price estimate, not a statement about the user's plan or actual debit. These external research charges are absent from the displayed entry edge and venue account equity. Include them when judging the experiment; the strategy is not a complete net-performance reporting system.

The runtime records each completed strategy evaluation in a separate SQLite database, retaining 30 days and at most 50,000 frames. Records include the observed books, account marks, candidates, refusals, intended actions, configuration hash and exact research snapshot. Repeated research is compressed and stored once per snapshot. Confirmed fills and fees remain authoritative in the execution ledger; an intended action in a recording is not a fill.

Export a chronological slice for forward evaluation:

```sh
pnpm cassie commodities history kalshi-commodities-test --from 2026-09-05T00:00:00Z --output /tmp/kalshi-commodities-history.json
```

The export defaults to 100 frames. Use `--until` and `--limit` to select another slice; the maximum is 10,000. Large remote exports may need narrower date ranges. Each export includes configuration and research definitions with the first frame of each cohort. Dry runs and public scans do not enter the runtime history; save their JSON explicitly.

Retain runtime logs, actual fills, fees, and settlement receipts alongside these observations. Compare realized outcomes across whole future fixing dates, including empty scans and unfilled attempts, before changing parameters. Historical candle returns and a candidate's ranking score are not live performance metrics.

## Implementation

- [Strategy and defaults](../packages/core/src/strategies/kalshi-commodities.ts)
- [Research and contract validation](../packages/runtime-node/src/commodity-data.ts)
- [CLI commands](../packages/cli/src/commands/commodities.ts)
- [Execution controller](../packages/core/src/engine/prediction-execution.ts)
- [Runtime activation](../packages/runtime-node/src/service.ts)

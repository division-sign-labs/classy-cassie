# Kalshi performance audit

The refreshed evidence does not establish a profitable Q-specific Kalshi strategy or a reliable Sharpe estimate. Q's settled forecast accuracy trails the stored venue probability on Bitcoin, gold, copper, and silver in the full sample. Oil improves only when repeated forecasts are included. The previously open portion of a reconstruction of the August strategy subsequently lost 41.7% per ticket. Settlement-specific outlook history is five days long for most assets and has materially less range coverage than its labels imply.

These findings support a small, diversified experiment with strict source matching, limited order sizes, and forward measurement. They do not support optimizing allocations against the historical headline returns.

## Evidence

Read-only graph export: September 5, 2026, 06:58 UTC, corresponding to September 4, 23:58 Pacific. Forecast coverage ends September 5, 06:20 UTC. Public Kalshi settlement metadata was retrieved immediately around that export; the resumable export returned all 875 requested tickers: 774 finalized, 27 closed awaiting finalization, and 74 active. No account keys, balances, or orders were sent to Quotient or Kalshi.

| Asset | Forecast rows | Markets | First forecast UTC | Last forecast UTC |
|---|---:|---:|---|---|
| Bitcoin | 1,676 | 193 | Aug 13, 21:55 | Sep 5, 06:20 |
| Copper | 1,414 | 141 | Aug 8, 12:06 | Sep 5, 04:25 |
| Gold | 2,101 | 188 | Aug 8, 12:06 | Sep 5, 04:28 |
| Silver | 1,649 | 157 | Aug 8, 12:10 | Sep 5, 04:27 |
| WTI | 2,429 | 196 | Aug 13, 12:11 | Sep 5, 06:10 |

The graph contains 9,269 committed forecasts on these linked Kalshi markets. Of these, 1,205 lack a stored forecast-time venue probability. Every row lacks the pipeline's forecast-time executable bid, ask, and two-cent depth fields. Graph `outcomePrices` is also absent for these Kalshi rows. Official API `result` fields supply outcomes; closed markets awaiting finalization remain unscored.

Local Cassie evidence contains two bot configurations, `ares-trader` and `poly-mm-v01`, both Polymarket. Immutable read-only inspections of their local main SQLite files found no Kalshi trading evidence. Uncheckpointed WAL contents were not read. There is no local Kalshi account ledger here from which to calculate realized returns, trading fees, equity drawdown, or Sharpe. This is an evidence limitation, not proof that no Kalshi trades exist in another account or deployment. [Sanitized local inspection](performance/local_bot_evidence.json)

## Forecast accuracy

Brier is mean squared probability error; lower is better. **Q in the original tables means the stored published blend (`probability`), not pre-market-blend raw Q.** The comparison uses the exact stored `yesOddsAtCreation` paired with each forecast, never today's price. It does not establish that the stored price was executable or fresh. Only finalized results, probabilities in [0,1], and forecasts made before the fixing are scored. Three incorrect WTI asset links are excluded: two Brent thresholds and one Alaska crude market.

| Asset | Scored forecasts | Markets | Settlement clusters | Q Brier | Venue Brier | Q minus venue, 95% interval |
|---|---:|---:|---:|---:|---:|---|
| Bitcoin | 1,218 | 174 | 16 | 0.1844 | 0.1708 | +0.0136 [−0.0008, +0.0369] |
| Copper | 1,221 | 134 | 13 | 0.1705 | 0.1654 | +0.0051 [−0.0151, +0.0315] |
| Gold | 1,707 | 177 | 14 | 0.1611 | 0.1362 | +0.0249 [−0.0122, +0.0589] |
| Silver | 1,473 | 149 | 13 | 0.1404 | 0.1217 | +0.0187 [−0.0206, +0.0592] |
| WTI | 1,048 | 123 | 12 | 0.1925 | 0.2012 | −0.0088 [−0.0173, +0.0106] |

Intervals resample 5,000 sets of underlying/fixing clusters. All strikes, repeated forecasts, and daily/weekly wrappers of the same fixing move together. Bitcoin monthly touch thresholds share one monthly-path cluster, including thresholds that closed early. Cross-asset co-movement and serial dependence can make effective sample sizes smaller still. No asset-level interval excludes zero.

Repeated updates can change conclusions. The two checks below select the first eligible priced forecast per market and one reproducible hash-selected forecast per market. They are sensitivity checks, not additional independent experiments.

| Asset | First Q / venue | Random Q / venue |
|---|---|---|
| Bitcoin | 0.1976 / 0.1942 | 0.1625 / 0.1599 |
| Copper | 0.1870 / 0.1948 | 0.1504 / 0.1590 |
| Gold | 0.2241 / 0.2088 | 0.1555 / 0.1520 |
| Silver | 0.1893 / 0.1861 | 0.1462 / 0.1399 |
| WTI | 0.2551 / 0.2481 | 0.2113 / 0.2042 |

Oil's full-sample advantage reverses under both market-level checks. Restricting to daily/weekly contracts forecast at least six hours before fixing preserves the full-sample ranking: Q/venue scores are BTC 0.2007/0.1857, copper 0.1962/0.1880, gold 0.1800/0.1589, silver 0.1573/0.1412, and oil 0.1994/0.2090.

The side and time breakdowns are informative but too small to train asset-specific rules. Gold and silver YES disagreements performed worse than the venue, while NO disagreements scored better. Silver NO has only seven fixing clusters. Oil YES scored better and oil NO worse. After the August 25 research snapshot, the venue was better on BTC, copper, gold, and silver; Q improved on oil, over eight fixing clusters. These opposite signs across assets and periods argue against a universal long bias.

Larger disagreement does not establish a stronger forecast. At gaps of 15–25 points, Q Brier is 0.2520 versus 0.2081 for the venue, a difference of +0.0439 with interval [+0.0044,+0.0760]. At gaps of at least 25 points, Q scores 0.2726 versus 0.1875, over 49 clusters. This is observational, with many examined cuts and no multiplicity correction. The complete asset/horizon/side/gap/cohort tables are in [metrics.json](performance/metrics.json).

Monthlies now have outcomes, unlike the August notebook: 1,010 scored forecasts represent only 34 markets and three underlying/month-end clusters. Bitcoin touch contracts have 72 scored forecasts but only one monthly price path. Neither establishes repeatable monthly or barrier skill.

## Raw Q versus published blend

The same 6,667 scored forecast rows have all three probabilities, so this comparison introduces no missing-data sample change. `rawProbability` is temperature-calibrated adapter Q before market blending; `probability` is the canonical published blend. It is not a fixed arithmetic average: the serving implementation uses fitted logistic weights, and this historical cohort spans multiple versions. The diagnostic `calibratedProbabilityGated` field is absent throughout this export and is not used. [Field definitions](/Users/jordanolmstead/dev/quotient-analytics-pipelines/include/pipelines/analytics/quoapp/gemini_forecasting/models.py:1502)

| Asset | Raw Q Brier | Published blend Brier | Market Brier |
|---|---:|---:|---:|
| Bitcoin | 0.1932 | 0.1844 | 0.1708 |
| Copper | 0.1939 | 0.1705 | 0.1654 |
| Gold | 0.2172 | 0.1611 | 0.1362 |
| Silver | 0.1978 | 0.1404 | 0.1217 |
| WTI | 0.1658 | 0.1925 | 0.2012 |

Blending improves the pooled Brier on BTC and all three metals, while it weakens oil's raw forecast advantage. Oil raw Q remains slightly better than market on the first-forecast-per-market sample (0.2437 versus 0.2481), but approximately matches market on the reproducible hash-selected sample (0.2047 versus 0.2042). Its much larger all-forecast advantage therefore depends on repeated updates and their timing. These are paired forecast-accuracy scores, not realized trading returns or a basis for retrospectively optimizing asset weights.

[Complete paired metrics and settlement-cluster intervals](performance/raw_blend_metrics.json). Reproduce offline with `python research/kalshi-commodities/performance/compare_raw_blend.py` in the existing analysis environment. Stored published values are not an independently archived publication history; the export does not contain enough serving/coherence metadata to separate every historical version.

## Trading reconstruction

The sibling notebook [asset_rule.py](/Users/jordanolmstead/dev/q-trade-analysis/asset_rule.py) documented favorable August returns but explicitly warned about bullish-regime exposure, adverse maker fills, and unresolved month-end inventory. Its historical maker-at-mid comparison favored crossing the ask by 13.3 percentage points per attempt. That result is a simulation based on coarse candles, not observed queue-level executions.

This audit freezes the actual August 25 forecast cache and uses its public hourly bid/ask candles, then refreshes only settlement results. It reconstructs a conservative selection rule: daily/weekly; 6 hours to 14 days until fixing; 10–90 cent outcome price; executable Q gap at least 5 and below 25 points; spread no more than 5 cents; first chronological eligible contract per underlying/fixing/direction. WTI daily `KXWTI` is explicitly admitted despite having no `D` suffix. Entries use the first candle close at or after the forecast, no more than three hours later, and must precede fixing.

| Cohort | Tickets | Mean net return | 95% cluster interval | Win rate |
|---|---:|---:|---|---:|
| All reconstructed tickets | 33 | +24.9% | [−16.5%, +70.1%] | 60.6% |
| Already finalized in the August cache | 21 | +63.0% | [+8.3%, +124.2%] | 76.2% |
| Open in the August cache, subsequently finalized | 12 | −41.7% | [−86.6%, −0.9%] | 33.3% |

Thirty-two of 33 tickets are YES. Always buying YES on the same selected contracts beats the reconstructed Q side by 3.4 percentage points. The one NO ticket explains the difference. By-asset returns are BTC +45.8% on seven tickets, copper +8.7% on seven, gold +49.9% on seven, silver +17.4% on six, and oil −2.0% on six. These are hypothetical arithmetic means per ticket, not account returns.

This reconstruction intentionally differs from the old notebook's repeated event/day entries and mixed marked/settled reporting. Selection was reconstructed during this audit; it is not a prospective paper ledger. It lacks historical order-book depth, queue position, observed fills, deployment capital, and liquidation marks. It applies conservative one-contract cent-rounded fees and divides by entry cost **including** fees. A real order can receive different rounding at aggregate quantity. Results do not include API research costs. [All selected contracts and arithmetic](performance/candle_replay.csv)

A trade-row mean divided by trade-row standard deviation is not portfolio Sharpe. Credible Sharpe requires a dated equity curve, cash-flow adjustment, unfilled attempts, fee/slippage accounting, and a defined marking convention during illiquid periods. Those inputs are absent. The previously open cohort demonstrates how reporting only finalized winners can exaggerate performance.

## Price outlooks

There are 197 scored PriceOutcome records for the five requested assets: 156 settle against a Hyperliquid candle and 41 against a venue settlement value. The Hyperliquid records begin August 15–17; the venue records begin August 30–31 and cover four or five distinct dates per asset. These sources are different instruments and cannot validate each other's settlement predictions.

The pipeline scores the last eligible revision before each fixing, not a fixed entry horizon: [DUE_FOR_SETTLEMENT_QUERY](/Users/jordanolmstead/dev/quotient-analytics-pipelines/include/pipelines/analytics/quoapp/price_outlook/cypher.py:977). For venue records this is typically about 29 minutes before fixing, or 60 minutes for oil. All 41 venue records have zero scored Q rungs in `legRungBrierJson`. Their range scores concern the composite outlook, not independent raw-Q validation.

| Asset | Venue records / dates | Latest-revision 80% band coverage | Median absolute price error |
|---|---|---:|---:|
| Bitcoin | 7 / 5 | 85.7% | 0.054% |
| Copper | 9 / 5 | 11.1% | 1.425% |
| Gold | 9 / 5 | 88.9% | 0.076% |
| Silver | 9 / 5 | 88.9% | 0.286% |
| WTI | 7 / 4 | 71.4% | 0.461% |

Copper's middle 50% band covered zero of nine records, and the median prediction had a −1.25% mean signed error. This warrants source, roll-contract, and interval-width investigation. It does not identify which mechanism caused the miss.

To remove the near-fixing advantage, a separate read-only query selects the latest non-backfilled outlook published at least 6 or 24 hours before the same fixing, within the same series and anchor. No replacement observation is selected using its later outcome.

| Asset | Six-hour records | Six-hour 80% coverage | 24-hour records | 24-hour 80% coverage |
|---|---:|---:|---:|---:|
| Bitcoin | 7 | 71.4% | 2 | 50.0% |
| Copper | 9 | 55.6% | 6 | 66.7% |
| Gold | 9 | 66.7% | 6 | 66.7% |
| Silver | 9 | 66.7% | 6 | 66.7% |
| WTI | 7 | 57.1% | 4 | 50.0% |

These samples are too small to fit asset-specific correction multipliers. The evidence does support treating the published percentile labels as model outputs requiring an uncertainty reserve. It also rules out advertising the last-revision statistics as day-ahead forecasting accuracy. [Horizon-selected outlooks](performance/horizon_outlooks.json), [complete audit](performance/scored_outlook_audit.csv)

The prior price-outlook drift study evaluated Hyperliquid **perpetual trades** with take-profit on the first touch of the median. That is a different payoff from a Kalshi terminal threshold. Its reported +0.23% per market-backed trade cannot be transferred to Kalshi hold-to-resolution returns. The current pipeline's removal of constant house drift similarly does not establish directional Kalshi alpha.

## Settlement and execution implications

1. Resolve the exact series, operator, contract month, source, and fixing time before interpreting any probability. WTI asset links contain Brent and Alaska crude. Weekly WTI includes ranges: `KXWTIW-26AUG1414-B81.50` settles on 81.00–81.99, not on exceeding 81.50. `KXWTI` daily rules name ICE WBS contract months. Copper rules identify contracts such as CCU6 and a one-minute candle close. Bitcoin daily rules use the average of 60 seconds of CF BRTI before the fixing. The actual public rules are preserved in [kalshi_markets.json](performance/kalshi_markets.json).
2. Avoid counting a daily contract, weekly wrapper, adjacent strike, or gold/silver pair as independent diversification. Budget by underlying and fixing first, then cap shared commodity and directional exposure. Gold and silver need a combined precious-metals constraint.
3. A limit order at the current ask can immediately execute as a taker. Passive orders need strict age limits and bounded repricing because historical mid-price fills selected adverse paths. A price cap and a small depth participation limit remain useful even for urgent entry. Candle quotes do not prove a fill or its capacity. [Kalshi candle contract](https://docs.kalshi.com/api-reference/historical/get-historical-market-candlesticks)
4. Prefer source-matched Q probabilities with conservative disagreement limits; require exact outlook basis/horizon alignment before using a price range as support. Do not convert Hyperliquid medians into probabilities for an ICE, Pyth, or BRTI fixing by matching ticker names. Abstention is a valid risk adjustment when settlement metadata or a current two-sided book is missing.
5. Default monthly and touch experiments to separate evaluation. Their outcomes are now visible, but they still represent one month. Avoid threshold-specific optimization against these dependent observations.

Current official fees differ from assumptions in the old notebook. The July 7, 2026 schedule uses taker coefficient 0.07 and maker coefficient 0.0175, each multiplied by price × (1−price), quantity, and the applicable series multiplier. Default maker multiplier is zero unless listed. There is no settlement fee. Rounding applies to the order calculation; the PDF's text and displayed examples merit preserving a conservative upper bound in execution rather than assuming fractional rounding savings. A separate $0.01-per-contract execution reserve is an additional planning allowance, not an official venue fee. [Official fee schedule](https://kalshi.com/docs/kalshi-fee-schedule.pdf)

For forward testing, log every candidate, refusal, forecast ID, exact settlement specification, bid/ask/depth, intended price, actual fill, fee, cancellation, and settlement. Evaluate one dated strategy equity curve and paired same-universe baselines: venue probability alone, Q-directed, and constant-direction. Compare fixed rules across whole future fixing dates before modifying weights. Research costs and conservative liquidation marks belong in net performance.

## Reproduction

Artifacts contain only public market/forecast information and sanitized local inventory evidence. Sibling repositories were read-only; no bot, deployment, strategy state, order, or database was changed.

From this repository, using the existing analysis virtual environment:

```sh
/Users/jordanolmstead/dev/q-trade-analysis/.venv/bin/python research/kalshi-commodities/performance/fetch_readonly.py
/Users/jordanolmstead/dev/q-trade-analysis/.venv/bin/python research/kalshi-commodities/performance/fetch_kalshi_public.py
/Users/jordanolmstead/dev/q-trade-analysis/.venv/bin/python research/kalshi-commodities/performance/analyze.py
```

The first script uses the sibling repository's existing `.env` internally and opens Neo4j sessions in READ mode. It neither displays nor persists credentials. The public metadata script resumes successful ticker reads; use a fresh output directory/cache for a new as-of audit rather than mixing old and new settlements. `analyze.py` is offline and uses the saved snapshots plus three original files under `q-trade-analysis/data`: `asset_rule_universe.csv.gz`, `asset_rule_kalshi_markets.csv`, and `asset_rule_kalshi_candles.csv.gz`. [Exact Cypher queries](performance/queries.json), [export manifest](performance/manifest.json), [public API manifest](performance/kalshi_manifest.json)

The principal code sources are [asset_rule_lib.py](/Users/jordanolmstead/dev/q-trade-analysis/asset_rule_lib.py), [asset_rule.py](/Users/jordanolmstead/dev/q-trade-analysis/asset_rule.py), [forecast_daily_pnl documentation](/Users/jordanolmstead/dev/quotient-analytics-pipelines/include/pipelines/analytics/quoapp/forecast_daily_pnl/README.md), and [price_outlook settlement selection](/Users/jordanolmstead/dev/quotient-analytics-pipelines/include/pipelines/analytics/quoapp/price_outlook/cypher.py:977). The path-P/L pipeline specifically uses Polymarket history; its extrema are not Kalshi trading returns.

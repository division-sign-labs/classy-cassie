# H200 compute-price forecast audit

September 5, 2026 snapshot. Historical Q coverage contains 71 forecasts across 18 Kalshi contracts, August 18–31. Official settlements permit scoring 45 forecasts across 12 contracts and only three fixing dates. The historical contracts are weekly observations (KXH200WS) and month-end observations (KXH200MON), each tied to Ornn's H200 rental-compute index in USD per GPU-hour. Monthly averages and annual threshold-crossing products have different payoffs and no forecast history in this extract.

## Raw adapter

Lower Brier is better. Every comparison pairs Q with the venue quote stored on the same forecast.

| Sampling | Observations | Raw adapter | Market |
|---|---:|---:|---:|
| All forecasts, equal weight per forecast | 45 | 0.1902 | 0.1719 |
| First forecast per contract | 12 | 0.2181 | 0.1797 |
| Random forecast per contract, fixed SHA-256 selection | 12 | 0.1834 | 0.1458 |
| Last forecast per contract | 12 | 0.1169 | 0.1314 |
| Average each contract's probabilities, then score | 12 | 0.1579 | 0.1534 |
| Average each contract's Brier, then weight contracts equally | 12 | 0.1713 | 0.1574 |

The last row is also the expected Brier when selecting one uniformly random forecast per contract. It differs from the particular fixed random draw. Averaging probabilities before scoring differs from averaging individual Brier scores.

Raw Q underperforms market in the all/first/random comparisons and slightly outperforms for the last forecast. The result depends on timing and has only three related fixing dates. All settled forecasts use research_market_v1; the only union_v4 forecast is unsettled. These figures do not establish current-model trading alpha.

## Blend and selected bands

Across all 45 settled forecasts, the preserved blend before later coherence repairs scores 0.2400, versus raw Q 0.1902 and market 0.1719. Stored canonical Q scores 0.2390. Six monthly forecasts were changed by a later cross-strike repair; the final repair timestamp is August 30, several days after forecast creation. Historical gap selection therefore uses probabilityBeforeCoherence when present. This preserves the original stage but does not reconstruct an immutable archive of every probability served over time.

Inside a 10–25pp original-blend gap, selected-side quote of 10–90¢, and 2-hour to 14-day horizon, 19 forecasts across eight contracts score raw Q 0.3027, blend 0.3098, market 0.1967. These are quote-based forecast cohorts: all historical bid, ask and depth fields are missing. They are not actual trades, profit or account Sharpe.

Q did particularly poorly on the August 28 observation and improved on September 4. Official fixing values are $4.49, $4.42 and $4.63 for August 28, August 31 and September 4 respectively. Full event-level Brier, log loss and directional diagnostics are in [metrics.json](metrics.json).

## Current coverage and settlement diligence

The six open contracts with Q coverage have forecasts aged approximately 5–12 days. For September 11 above $5, Q's old 61.70% versus a 31.5% current midpoint suggests a 30.2pp disagreement, but the observed 3¢/60¢ book leaves only 1.7pp against the executable YES ask before fees. Another strike, September 11 above $4.50, has a tight 75¢/76¢ quote but only about $9 of exit bids near the best price.

Ornn's public daily history and the three official WS/MON settlements agree at the rounded values. The separate August monthly-average contract settles at $4.55568, while the currently available public daily history averages $4.70484. Hourly coverage, window boundaries and revisions remain unverified; daily history should not substitute for that contract's settlement feed. See [settlement diligence](settlement.md) for primary sources, orderbooks, benchmark methodology and the archived evidence.

The forecast summaries generally identify Ornn and distinguish cheaper provider listings; this audit does not establish use of the wrong benchmark. It does find stale forecasts, an older-model evaluation cohort, later changes to stored probabilities, and severe differences in book liquidity across strikes.

## Reproduction

The two fetch scripts use read-only research-database sessions and retain no credentials. `analyze.py` joins the frozen forecasts and stage provenance to official Kalshi results, censors forecasts after the benchmark fixing, and writes [scored_forecasts.csv.gz](scored_forecasts.csv.gz) and [metrics.json](metrics.json). SHA-256 input hashes are recorded in the metrics artifact. No trading configuration or orders were changed for this audit.

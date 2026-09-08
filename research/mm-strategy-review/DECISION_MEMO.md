# How Quotient should inform the market maker

Research date: September 4, 2026 Pacific / September 5 UTC. Read-only graph, Quotient API, public Polymarket data, source-code and literature review. No live orders, configuration, deployment or credential changes were made.

## Judgment

The original passive-inventory strategy has more direct support from the forecasting research than a generic two-sided dealer does. But it is substantially the same economic bet as the existing directional strategy: acquire the Q-favored outcome and wait for convergence. Passive execution and a shorter holding period do not make its forecast errors independent.

For a genuinely separate market-making strategy, the most useful next hypothesis is **Q-conditioned liquidity provision**: test whether Q disagreement and event information help decide where to quote, how much compensation to require, and which inventory is dangerous. This is different from blindly moving the quote center toward every Q forecast. It is a research recommendation, not a finding that this maker is already profitable or superior to directional trading.

I would neither restore the original specification unchanged nor treat removing Q from the maker as a justified conclusion. Separate the directional-return objective from the spread-income objective, and judge the proposed maker by additional net spread income after inventory losses.

## The user's volatility hypothesis

Here “Q spread” means Q probability minus Polymarket probability, not the venue bid–ask spread. Three questions must remain separate:

1. Does the signed gap predict which way price moves?
2. Does the gap's magnitude predict how much price moves, or the uncertainty around its expected movement?
3. Can a maker use either prediction to improve returns on the orders that actually fill?

The earlier fair-value-blend test primarily addresses the first question. It does not reject the second or third.

Even the second question needs care. An absolute endpoint move is not the same as path volatility or residual uncertainty. Formally, `E[(price change)^2 | information] = Var(price change | information) + E[price change | information]^2`. A predictable one-way move can therefore look like “more volatility” in an absolute-move analysis. It can also make the wrong passive quote particularly costly.

Consider YES at 50¢ and Q at 70%. That disagreement might indicate pending upward repricing, persistent disagreement that lasts weeks, or an erroneous/stale forecast. None implies that price will repeatedly oscillate through our bid and ask. Buying equal YES and NO shares creates a fixed-payoff complete set, not an option position that automatically gains from larger moves.

The policy implications differ:

| Evidence available | Candidate maker response |
| --- | --- |
| Predictable two-way activity, little directional information | Quote both economic sides and target low net inventory |
| Higher movement risk but no reliable direction | Require more spread compensation; limit inventory and quote size |
| Reliable signed repricing signal | Reduce or move away the vulnerable quote; allow a bounded inventory tilt |
| Near-term catalyst or stale evidence | Reassess/cancel affected quotes rather than assume the daily forecast is unchanged truth |

These are hypotheses to calibrate, not validated thresholds. Widening quotes can reduce fills or reward eligibility; smaller quotes can miss venue/reward minima. The useful edge is predicting movement or toxic fills **better than the information already in market prices, recent volatility and order flow**. Inventory-risk and directional-bet models support this decomposition, not its profitability on our markets. [Avellaneda–Stoikov](https://math.nyu.edu/inmemoriam/avellaneda/HighFrequencyTrading.pdf), [Fodra–Labadie](https://arxiv.org/abs/1206.4810).

### Direct test of the gap hypothesis

An additional offline analysis used the newer immutable initial-publication Q data. It required timing-valid reference prices, entry probability between 5% and 95%, and a matured horizon before the market's recorded closing time. This is the broader forecast universe, not just the 54 current signals or a liquidity-qualified maker universe.

Equal-market mean absolute endpoint moves in percentage points; parentheses are forecast-observation counts:

| Initial absolute Q gap | 1 hour | 6 hours | 24 hours |
| --- | ---: | ---: | ---: |
| 0–5pp | 2.10 (246) | 6.32 (236) | 6.85 (143) |
| 5–10pp | 2.47 (228) | 5.74 (217) | 9.64 (159) |
| 10–20pp | 3.17 (243) | 6.43 (226) | 8.44 (169) |
| 20–30pp | 4.37 (52) | 7.43 (48) | 17.71 (37) |
| Above 30pp | 14.21 (18) | 21.41 (14) | 24.09 (8) |

In equal-market-weighted regressions controlling for starting-price bucket, category, time to close, Q direction and prior 24h reference-price realized volatility, an additional 10pp gap associates with:

| Horizon | Additional absolute move | Event-clustered approximate 95% interval | Observations / markets |
| --- | ---: | ---: | ---: |
| 1 hour | +2.11pp | +0.58 to +3.64 | 747 / 363 |
| 6 hours | +0.15pp | −1.68 to +1.99 | 711 / 341 |
| 24 hours | +2.00pp | +0.23 to +3.77 | 504 / 238 |

This is evidence for a possible movement-risk feature, not a fitted model validated on a further holdout. The 20–30pp group's 24h absolute move averaged 17.71pp while its signed move toward Q averaged −0.50pp, with a wide interval spanning both directions. That illustrates why movement magnitude and reliable direction are different.

Robustness is limited: excluding above-30pp gaps makes all three adjusted intervals include zero (24h: +1.75pp, interval −0.02 to +3.52). Restricting every horizon to the same matured forecasts also removes the clear 1h result; 24h remains positive. Large-gap observations are few, and their movement is predominantly directional. Multiple testing is not adjusted. Neither residual path variance nor fill-conditioned profit was measured. The correct conclusion is **worth testing for maker risk controls**, not “the wider the Q gap, the larger we should trade.” [Full gap analysis](volatility-gap-analysis.json), [reproducible offline calculation](volatility-gap-analysis.py).

## Daily refresh changes the freshness interpretation

The user clarified that signals refresh daily. A generic six-hour expiry is poorly matched to a daily cycle: a successfully refreshed forecast would fail that test during most of a normal day. Six hours could still be a defensible alpha-expiry rule, but only if the data show predictive usefulness decays that quickly. A six-hour return-measurement horizon does not establish six-hour forecast expiry.

Separate scheduled refresh health, age-dependent forecast usefulness, and executable-book freshness. A current daily Q forecast can coexist with a book that must be refreshed in seconds. Conversely, material news can invalidate a forecast before its next scheduled refresh. The snapshot below establishes the effects of the old gate, not a failed daily publishing job or a reason by itself to replace signal discovery.

## What the graph and current books actually show

At approximately 05:33–05:46 UTC, all 54 published-signal markets returned both YES and NO order books. The current evidence does not support an inability to obtain books. Under the original six-hour forecast gate, 53 were too old; the sole fresh signal failed the original YES edge threshold.

The broader graph had 589 graph-active markets with committed forecasts, including 69 under six hours old. Sixty-eight of those fresh forecasts were absent from the published feed. However, venue checks of **all 69**, without a graph-volume prefilter, found only three above $1,000 reported daily volume. Only Russia–Ukraine October ceasefire passed the illustrative two-sided screen requiring $300 bid depth within 2¢ on both outcomes, spreads no wider than 6pp, adequate time to close and venue-valid sizing. Three responses had unusable/empty book sides despite successful HTTP responses.

Relaxing freshness gives a different picture: 28 of the 54 signal markets passed a provisional two-sided static screen. That does not establish expected fills or profit. Thirty-four of the 54 had no public taker-trade rows in the preceding hour. The graph's broader coverage is worth testing, but it is not a demonstrated supply of liquid fresh candidates. Daily refresh can change these intersections.

Source: [timestamped market screens](market-screen-results.json), [graph freshness](graph-freshness-summary.json). The static screens are illustrative comparisons, not fitted profit-maximizing policies. Public trade counts are activity proxies, not our fills.

## Forecast evidence: promising, conditional, not maker P&L

The new period, August 31–September 5, contains 992 committed forecasts across 447 markets and 122 published signals across 66 markets. Initial publication probabilities were recovered from immutable artifacts for all 992 forecasts. The primary full-forecast analysis uses those initial values, not retrospectively repaired Q values.

Equal-market mean subsequent moves toward Q, in percentage points:

| Cohort | 1 hour | 6 hours | 24 hours |
| --- | ---: | ---: | ---: |
| Initial Q, 10–30pp disagreement | +1.09 | +1.66 | +0.96 |
| Initial Q, all disagreements ≥10pp | +2.19 | +3.04 | +2.34 |
| Published signals, 10–30pp and original price band | −0.36 | +1.17 | +6.09 |

Every interval in the first row includes zero. Only 1h/6h in the second row and 24h in the third exclude zero under the event-clustered normal-approximation calculation. Horizons have different matured samples. These are public reference-price changes, not bid–ask executions, and the short evaluation period is vulnerable to event concentration and multiple comparisons. The stronger ≥10pp cohort does not by itself justify removing the original upper-gap sanity check.

The original full set of historically reconstructible signal gates admitted just 15 updates across ten markets in this newer period, with none on September 4. Its NO-only subset did not show convincing positive newer-period results. The exact NO preference, YES half-sizing and complete gate combination are not durable facts established by the refresh.

The older chronological continuous-blend test fitted small Q weights—approximately 0.3%, 0.9%, 3.5% and 4.2% at 5m/1h/6h/24h. Observation-weighted holdout MAE worsened at all four horizons, although RMSE improved slightly. This weakens an indiscriminate quote-center blend, not conditional uses of the gap as a movement-risk feature. Source: [original blend results](/Users/jordanolmstead/dev/quotient-analytics-pipelines/research/market_maker_utility/2026-08-31/alltime_scorecard_pm/fair_value_blend.csv).

Historical probability provenance also matters. Of 4,468 original-study rows with recoverable publication artifacts, 175 saved Q values differ from initial publication Q. This establishes exposure to revisions, not proof that every original finding is biased. The complete time series of served coherence revisions has not been reconstructed. [New markouts and limitations](graph-oos-refresh/graph-summary.json), [original provenance audit](original-analysis-q-provenance.json).

## Economics the forecast test cannot settle

All four currently managed comparison markets showed combined YES/NO bid prices of 99¢. Equal-share completed pairs therefore offer 1¢ gross per pair before capital recovery and other costs. With one leg unfilled, a 3¢ adverse move on the filled leg erases three such completed-pair gains at equal share counts. There is no promise that both orders fill or that cash turns over quickly.

At illustrative $30 maximum tickets per leg, three of the four markets did not meet the observed reward minimum share size. The remaining market's whole daily reward pool was only $3, shared competitively. Maker fees are zero, but taker exits can incur fees; liquidity rewards and maker rebates are distinct. Count actual received amounts, not advertised reward pools. [Venue fee rules](https://docs.polymarket.com/trading/fees), [liquidity rewards](https://docs.polymarket.com/programs/liquidity-rewards).

A maker's crucial price forecast is conditional on a quote filling. A useful unconditional Q forecast does not guarantee that the subset of orders someone chooses to trade against us is profitable. The academic literature explicitly models that adverse-selection problem. [Cartea, Jaimungal and Ricci](https://epubs.siam.org/doi/10.1137/18M1176968).

The current source also does not autonomously merge completed pairs. Passive sale of inventory requires further fills and can reopen directional exposure. This is an implementation constraint, not a reason to expand runtime credential authority during research. See [execution and payoff review](strategy-comparison-economics.md).

## The comparison that would justify a strategy choice

Test three policies on the same eligible universe and capital/execution assumptions: existing Q-directed trading; book-and-recent-volatility two-sided quoting; and the same maker with Q-gap-conditioned risk controls. Do not grant the Q maker different liquidity filters and then attribute the difference to Q.

First test whether absolute gap adds out-of-sample predictive value beyond starting probability, recent realized volatility, forecast age, category and event timing. Separate signed drift from residual movement risk. For a daily feed, evaluate forecast ages through the normal daily cycle rather than only at publication.

Then compare confirmed-fill net returns and inventory risk. Include unmatched inventory, unfilled quotes, fees, actual rewards, terminal liquidation/marks, and cash tied up. Group correlated markets by event and split chronologically. Neither successful completed pairs alone nor a midpoint-touch fill assumption is sufficient.

This research does not require another production database or permanently retaining every book update. A bounded external research sample can retain decision/quote/fill records, a small set of scheduled markouts, and aggregate counters. Production storage can remain focused on order, position and recovery state.

Independent public-literature research was also run with the Gemini skill. Its generated report mixed Polymarket US and international documentation and made unsupported reward-program claims. Those claims were not adopted; conclusions here use directly checked primary sources. The writing skill was used to keep this memo's measured findings separate from proposed policies. No production code or live state was changed by this review.

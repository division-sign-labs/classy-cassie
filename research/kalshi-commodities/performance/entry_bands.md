# Entry-band performance

Frozen August 8–September 5, 2026 forecast audit. These are matched forecast cohorts, not actual trades. Lower Brier is better. Selection uses the published blend; raw Q is scored on the same selected observations.

The implemented price filter adds 50% shrinkage toward the midpoint to the already published blend, subtracts 1pp uncertainty, reserves entry and possible-exit fees plus 1¢ per leg, and requires 2pp net edge. At a 50¢ ask and 2¢ bid/ask spread, its minimum executable published-Q edge is about 17.9pp. The nominal 5–25pp filter alone does not describe admission.

All scenarios enforce current terminal-series and static contract-rule checks and a 2-hour to 14-day fixing horizon. 437 old Copper forecasts fail the current index-candle settlement rules; 72 BTC touch forecasts are excluded. Historical active status is assumed and the current series-update timestamp check is omitted.

## Implemented price math: assumed 2¢ spread

| Asset | Forecasts / markets / fixings | Raw Q | Published blend | Market |
|---|---:|---:|---:|---:|
| Bitcoin | 68 / 38 / 11 | 0.3333 | 0.2894 | 0.2241 |
| Copper | 43 / 22 / 4 | 0.3279 | 0.2624 | 0.1676 |
| Gold | 177 / 75 / 12 | 0.3993 | 0.2950 | 0.1994 |
| Silver | 140 / 65 / 12 | 0.3645 | 0.2840 | 0.2068 |
| WTI Crude Oil | 60 / 37 / 11 | 0.1878 | 0.1648 | 0.1880 |

The counts include repeated forecasts. One first qualifying forecast per market gives:

| Asset | Forecasts / markets / fixings | Raw Q | Published blend | Market |
|---|---:|---:|---:|---:|
| Bitcoin | 38 / 38 / 11 | 0.3105 | 0.2691 | 0.2169 |
| Copper | 22 / 22 / 4 | 0.2674 | 0.2114 | 0.1600 |
| Gold | 75 / 75 / 12 | 0.3004 | 0.2334 | 0.1946 |
| Silver | 65 / 65 / 12 | 0.2885 | 0.2315 | 0.2098 |
| WTI Crude Oil | 37 / 37 / 11 | 0.2120 | 0.1810 | 0.2009 |

### Selected-side outcomes

These are equal-weight forecast diagnostics, before actual fees and portfolio sizing. A win rate above the assumed entry price implies positive gross one-contract payoff in this cohort; it is not an account return.

| Asset | Win rate | Mean assumed entry | Blend − market Brier, 95% fixing-cluster interval |
|---|---:|---:|---:|
| Bitcoin | 41.2% | 47.6% | +0.0653 [-0.0930, +0.1444] |
| Copper | 39.5% | 50.9% | +0.0948 [-0.0023, +0.1406] |
| Gold | 34.5% | 46.0% | +0.0956 [-0.0540, +0.1525] |
| Silver | 35.7% | 43.3% | +0.0772 [-0.0358, +0.1463] |
| WTI Crude Oil | 66.7% | 52.3% | -0.0232 [-0.1067, +0.0877] |

### Entry odds

Pooled across assets; these rows have different asset mixes.

| Selected-side entry band | Forecasts / markets / fixings | Raw Q | Published blend | Market |
|---|---:|---:|---:|---:|
| 10-30c | 106 / 66 / 30 | 0.3197 | 0.1876 | 0.1130 |
| 30-50c | 133 / 86 / 32 | 0.3906 | 0.2954 | 0.2201 |
| 50-70c | 199 / 116 / 41 | 0.3797 | 0.3325 | 0.2488 |
| 70-90c | 50 / 33 / 21 | 0.1672 | 0.1492 | 0.1440 |

### Favorite agreement

Buying the underdog can mean Q flips the favorite, or Q merely assigns the underdog more probability than the market does. The current strategy applies the same thresholds to both.

| Position | Forecasts / markets / fixings | Raw Q | Published blend | Market |
|---|---:|---:|---:|---:|
| buy_market_favorite | 213 / 131 / 39 | 0.3157 | 0.2785 | 0.2242 |
| buy_underdog_Q_flips_favorite | 145 / 88 / 33 | 0.3919 | 0.3038 | 0.2219 |
| buy_underdog_Q_keeps_market_favorite | 106 / 65 / 29 | 0.3233 | 0.1869 | 0.1134 |
| market_even | 24 / 18 / 13 | 0.4751 | 0.4009 | 0.2500 |

## Simple 10–25pp quote-gap selector

| Asset | Forecasts / markets / fixings | Raw Q | Published blend | Market |
|---|---:|---:|---:|---:|
| Bitcoin | 211 / 90 / 15 | 0.2809 | 0.2526 | 0.2086 |
| Copper | 158 / 34 / 5 | 0.3177 | 0.2635 | 0.2012 |
| Gold | 488 / 125 / 13 | 0.3342 | 0.2539 | 0.2000 |
| Silver | 429 / 112 / 13 | 0.2926 | 0.2274 | 0.1973 |
| WTI Crude Oil | 195 / 88 / 11 | 0.1636 | 0.1621 | 0.1812 |

The counts include repeated forecasts. One first qualifying forecast per market gives:

| Asset | Forecasts / markets / fixings | Raw Q | Published blend | Market |
|---|---:|---:|---:|---:|
| Bitcoin | 90 / 90 / 15 | 0.2172 | 0.2065 | 0.1936 |
| Copper | 34 / 34 / 5 | 0.2778 | 0.2337 | 0.2057 |
| Gold | 125 / 125 / 13 | 0.2866 | 0.2473 | 0.2237 |
| Silver | 112 / 112 / 13 | 0.2378 | 0.1970 | 0.2054 |
| WTI Crude Oil | 88 / 88 / 11 | 0.2114 | 0.2040 | 0.2034 |

### Selected-side outcomes

These are equal-weight forecast diagnostics, before actual fees and portfolio sizing. A win rate above the assumed entry price implies positive gross one-contract payoff in this cohort; it is not an account return.

| Asset | Win rate | Mean assumed entry | Blend − market Brier, 95% fixing-cluster interval |
|---|---:|---:|---:|
| Bitcoin | 45.5% | 50.5% | +0.0440 [-0.0328, +0.0917] |
| Copper | 38.6% | 51.2% | +0.0623 [-0.0065, +0.1179] |
| Gold | 42.0% | 49.5% | +0.0540 [-0.0253, +0.1050] |
| Silver | 50.3% | 49.9% | +0.0302 [-0.0351, +0.0848] |
| WTI Crude Oil | 68.2% | 54.6% | -0.0190 [-0.0536, +0.0314] |

### Entry odds

Pooled across assets; these rows have different asset mixes.

| Selected-side entry band | Forecasts / markets / fixings | Raw Q | Published blend | Market |
|---|---:|---:|---:|---:|
| 10-30c | 283 / 123 / 46 | 0.2860 | 0.1681 | 0.1180 |
| 30-50c | 387 / 170 / 45 | 0.3422 | 0.2708 | 0.2339 |
| 50-70c | 479 / 225 / 52 | 0.3159 | 0.2855 | 0.2385 |
| 70-90c | 332 / 149 / 45 | 0.1966 | 0.1775 | 0.1662 |

### Favorite agreement

Buying the underdog can mean Q flips the favorite, or Q merely assigns the underdog more probability than the market does. The current strategy applies the same thresholds to both.

| Position | Forecasts / markets / fixings | Raw Q | Published blend | Market |
|---|---:|---:|---:|---:|
| buy_market_favorite | 781 / 305 / 53 | 0.2601 | 0.2355 | 0.2074 |
| buy_underdog_Q_flips_favorite | 284 / 137 / 44 | 0.3560 | 0.2824 | 0.2374 |
| buy_underdog_Q_keeps_market_favorite | 386 / 155 / 51 | 0.2909 | 0.1870 | 0.1463 |
| market_even | 30 / 25 / 16 | 0.4483 | 0.3916 | 0.2500 |

## Interpretation

Oil has the best point estimates under the implemented-price scenarios. The published blend beats market on oil, and underperforms on the other four assets in the 2¢ scenario. All five paired 95% intervals include zero. Copper has only four fixing clusters in that scenario. These data do not establish optimized thresholds or realized Sharpe.

The simple 10–25pp oil advantage nearly disappears when taking one first qualifying forecast per market, and silver changes sign under that weighting. Repeated forecasts materially affect the conclusions.

The actual strategy also selects only six markets per asset by nearest expiry and then proximity to even odds; ranks qualifying entries by modeled edge, uncertainty and time; caps one exposure per underlying; and applies depth, portfolio and execution constraints. Those decisions cannot be reconstructed here.

## Limits

- These are forecast cohorts, not historical trades or an executable strategy backtest.
- Selection uses allowed terminal series and 2h–14d to fixing at forecast creation; runtime also checks catalog and venue dates agree.
- Quote cohorts use yesOddsAtCreation as entry quote. Assumed-spread cohorts treat it as midpoint without historical book evidence.
- Zero spread is a limiting mathematical case; the live bot rejects a locked bid/ask book.
- Static contract checks reuse the runtime normalizer and saved market/current-series metadata; historical active status is assumed and series-update gating omitted.
- Implemented price-math scenarios use saved current series fees; historical fee schedules are not reconstructed.
- No spread/depth/staleness, historical source-version timeline, top-six universe, portfolio reservations, sizing, exits or fills reconstructed.
- Win rate and gross payoff are selected forecast diagnostics before actual fees, slippage and portfolio weights.
- All-forecast rows repeat markets; first-qualifying-per-market is a sensitivity, not the portfolio policy.
- Intervals resample asset/fixing clusters. Small cluster counts and retrospective slicing limit inference.
- Stored published probability can include later coherence adjustment; it is not an immutable served snapshot.

The machine-readable artifact contains asset-by-odds, asset-by-gap, asset-by-favorite-agreement, first-per-market, and zero/2¢/5¢ spread sensitivity tables: [entry_band_metrics.json](entry_band_metrics.json).

Reproduce with `node research/kalshi-commodities/performance/reconstruct_contract_gates.mjs`, then run `compare_entry_bands.py` with the q-trade-analysis Python environment. The Node helper uses the built runtime normalizer.

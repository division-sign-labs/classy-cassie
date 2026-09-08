# Kalshi settlement alignment

Research date: September 4, 2026 Pacific; public API captures crossed midnight UTC into September 5. Quotient outlook snapshot: `2026-09-05T06:54:07.469Z`. Local pipeline and API checkouts were inspected read-only. Saved JSON contains market data, not credentials.

The current price outlooks are primarily forecasts of the Hyperliquid midpoint. Their additional Kalshi groups are statistical translations, not independently observed settlement feeds. They should not be converted into a second independent vote alongside the exact Kalshi market forecast. Copper's settlement source changed this week, and the bridge identifier does not distinguish the old and new sources.

## Settlement feeds

| Asset | Supported terminal series | Current settlement observable | Hyperliquid reference |
|---|---|---|---|
| Oil | `KXWTI`, `KXWTIW` | ICE WTI futures daily settlement, named contract month; current September 8–11 examples identify `WBS 26V-ICE`, October 2026 | `xyz:CL`; designated futures blend |
| Gold | `KXGOLDD`, `KXGOLDW`, `KXGOLDMON` | Pyth `Metal.Index.GOLD/USD`, feed 3153; preceding one-minute candle close at specified 5 p.m. Eastern fixing | `xyz:GOLD`; precious-metal spot reference, traded perp midpoint |
| Silver | `KXSILVERD`, `KXSILVERW`, `KXSILVERMON` | Pyth `Metal.Index.SILVER/USD`, feed 3154; preceding one-minute candle close at specified 5 p.m. Eastern fixing | `xyz:SILVER`; precious-metal spot reference, traded perp midpoint |
| Copper | `KXCOPPERD`, `KXCOPPERW`, `KXCOPPERMON` | Pyth `Commodities.Index.CU/USD`, feed 3525; preceding one-minute candle close at specified 5 p.m. Eastern fixing | `xyz:COPPER`; designated futures blend |
| Bitcoin | `KXBTCD`, `KXBTC` | Simple arithmetic mean of sixty CF Benchmarks BRTI observations over the minute immediately before specified fixing | `BTC`; traded perp midpoint |

The live [WTI series](https://api.elections.kalshi.com/trade-api/v2/series/KXWTIW) names ICE. [ICE's product specification](https://www.ice.com/products/213/WTI-Crude-Futures) identifies WBS as the logical/symbol code and describes its terminal cash settlement relationship to NYMEX. This does not make a generic NYMEX last trade, physical oil spot price, or continuous futures chart the Kalshi daily settlement. Current daily market secondary rules roll to the next listed contract two business days before last trading day. The market's explicit contract month and fixing date take precedence over a generic front-month assumption. Weekly examples close at 14:30 Eastern, not the 17:00 fixing used by gold/copper.

The [gold series](https://api.elections.kalshi.com/trade-api/v2/series/KXGOLDW) records the change to the continuous index after the July 31 weekly event; the daily change began with July 30. [Pyth's gold metadata](https://app.pyth.com/explore/Metal.Index.GOLD%2FUSD) identifies feed 3153, exponent −5, 24/7 coverage, and instrument type index. This is not the COMEX official settlement or LBMA fix. The current monthly market has `front_month_contract: "N/A"`.

The [copper daily series](https://api.elections.kalshi.com/trade-api/v2/series/KXCOPPERD) changed to the Pyth 24/7 index for August 31 settlements. The [weekly series](https://api.elections.kalshi.com/trade-api/v2/series/KXCOPPERW) changed for September 4 settlements, and [monthly](https://api.elections.kalshi.com/trade-api/v2/series/KXCOPPERMON) changes for September 30. Earlier markets retain their front-month contract methodology. [Pyth's copper metadata](https://app.pyth.com/explore/Commodities.Index.CU%2FUSD) identifies feed 3525, exponent −5 and Hermes identifier `b2b238aeb6ef5a722c5cf278595bf40434e174cac4f88c8ad5b6f5009b548c59`. It is a 24/7 proprietary index; a generic HG front month is not source-identical.

Current gold/copper primary rules specify the close of the one-minute candle ending at 17:00 Eastern. Secondary rules clarify that the 16:59 timestamp covers 16:59:00–16:59:59 and closes at 17:00:00. They round the settlement to two decimals, and specify a most-recent-published-data fallback. Generic [COMMODITIES terms](https://assets.kalshi.com/contract_terms/COMMODITIES.pdf) also contain correction/outage contingencies; capture the exact iteration's rules rather than assuming every commodity product uses one convention. COMEX official settlement windows are earlier: gold 13:29–13:30 and copper 12:59–13:00 Eastern. These are different observations from Kalshi's current 17:00 Pyth candle. [CME settlement windows](https://cmegroupclientsite.atlassian.net/wiki/spaces/EPICSANDBOX/pages/457085528/Daily+Settlement+Time+Details).

The [BTC terms](https://assets.kalshi.com/contract_terms/BTC.pdf) specify BRTI's preceding sixty-second mean; the live [series metadata](https://api.elections.kalshi.com/trade-api/v2/series/KXBTCD) agrees. Neither the daily BRR reference rate nor a single exchange's spot last trade is equivalent. BTC terms do not explicitly establish the commodity two-decimal rounding rule: preserve the contract's actual numeric comparator and do not import it. [BRTI](https://www.cfbenchmarks.com/data/indices/BRTI) aggregates eligible BTC/USD exchange order data. Kalshi also documents [CF value streaming](https://docs.kalshi.com/websockets/cfbenchmarks-value), which could support future feed-specific short-horizon modeling.

## What the outlook pipeline publishes

Silver was added to the requested strategy during implementation. Its [daily](https://api.elections.kalshi.com/trade-api/v2/series/KXSILVERD), [weekly](https://api.elections.kalshi.com/trade-api/v2/series/KXSILVERW), and [monthly](https://api.elections.kalshi.com/trade-api/v2/series/KXSILVERMON) metadata records the same July 30/31 transition, to Pyth `Metal.Index.SILVER/USD` ID 3154. Current month-end rules specify 17:00 Eastern preceding-minute close in USD/troy ounce, two-decimal rounding, and no delivery contract. The source uses canonical asset key `commodity:silver`, included in the single batched five-asset request.

Local source references are relative to `/Users/jordanolmstead/dev/quotient-analytics-pipelines` unless indicated otherwise.

- `price_outlook/hyperliquid.py:110` reads `allMids`, including the separate `xyz` book. Although comments elsewhere call this a mark, the code and live API identify it as midpoint. Candle-based realized measurements use the traded instrument, not the Kalshi source's original ticks.
- `price_outlook/README.md` describes a house curve centered on midpoint, a market width contribution, and Q's pre-blend strike probabilities. Terminal and path-dependent distributions are separated. Published median, whole-curve directional read, and confirmed execution signal are distinct outputs.
- `price_outlook/basis_join.py` converts Kalshi strikes by `strike_hl = strike_settle * exp(-valueLog)`. It moves strike geometry, not contract probabilities. The venue distribution is widened for bridge uncertainty.
- `price_outlook/basis_estimate.py:130` keys a bridge by asset, venue, Hyperliquid target, and coin. It omits settlement provider, source symbol, contract month, roll policy, fixing window, and source revision. It learns an EWMA from settled Kalshi `expiration_value` versus a Hyperliquid candle, with 10-observation half-life, at least 3 observations, 10-day staleness ceiling, and 2% maximum log standard deviation.
- `price_outlook/process.py:3280` publishes the optional reverse translation as an estimated Kalshi group: `settle = hl * exp(valueLog)`, then widens quantiles again. The resulting reference says `provider: kalshi-settlement`, `instrumentId: <series>`, `priceField: settle`; contract month, roll policy, timezone, candle interval, and rounding are null. It does not bind to the actual ICE/Pyth/CF feed.
- `basis_join.py:77` silently returns no bridge when unavailable, stale, disabled or underpopulated; `bridged_rows` then copies the original strike rows unchanged. This allows incomparable prices into the primary pool when a bridge is absent. The optional translated group itself fails closed.
- `basis_estimate.py:449` permits a candle close through **fixing + 60 seconds**, then selects the last one. This can pair a settlement with a subsequent-minute Hyperliquid close. The bridge estimate therefore includes a timing error, not just feed basis. Refit from same-window observations before using it as a trading conversion.

The different Hyperliquid commodity references are substantive. [XYZ commodity documentation](https://docs.trade.xyz/asset-directory/commodities) says gold uses precious-metal spot markets, while oil and copper use designated futures. Industrial/energy feeds roll from the fifth to tenth business day in 20% increments; this differs from Kalshi's two-business-day pre-expiry oil switch. XYZ also has internal pricing outside external coverage. Same asset name and dollar unit do not prove matching observables.

## Live measurements

The saved `settlement/outlook-summary.json` condenses the complete wire snapshot. Main Hyperliquid weekly outlooks at 06:30 UTC were:

| Asset | Fixing | Bear / base / bull | Midpoint at publication |
|---|---|---|---|
| Copper | Sep 11, 17:00 ET | 6.4721 / 6.6143 / 6.7576 USD/lb | 6.6706 |
| Gold | Sep 11, 17:00 ET | 4,341.64 / 4,449.81 / 4,576.65 USD/oz | 4,433.85 |
| Silver | Sep 11, 17:00 ET | 64.3634 / 67.0902 / 70.9737 USD/oz | 66.2125 |
| WTI | Sep 11, 14:30 ET | 88.3164 / 91.0070 / 93.9416 USD/bbl | 91.0070 |
| BTC | Sep 11, 17:00 ET | 75,585.98 / 80,147.08 / 84,075.07 USD | 79,610.50 |

These are the 25th, 50th and 75th percentiles of the **Hyperliquid** curve. They are not predictions of a named Kalshi payout without matching feed and fixing.

Live bridge estimates were copper −1.024% with 0.653% log uncertainty (8 observations), gold −0.0363% with 0.251% uncertainty (16), WTI −0.0324% with 0.256% uncertainty (13), BTC −0.00707% with 0.251% uncertainty (20). These are estimates from the saved response, not tradable spreads. The copper bridge combines observations around the provider transition; no regime identity is carried in the pair key.

Copper and current WTI translated groups were marked diagnostic because estimate uncertainty exceeded the API gate. Gold and BTC examples passed the estimated tier, but still had no original feed identifier, rules hash, or exact fixing window. A `mapping_status: verified` value alone did not prove source identity.

Silver's bridge estimated −0.01257% with 0.251% log uncertainty from 15 observations. Its fresh Hyperliquid weekly group targeted September 11; the retained Kalshi estimate still targeted expired September 4. The same date and source-identity restrictions apply. Silver's daily/weekly series also had no open contracts in the public API capture.

The API can combine different anchor dates within one series container: copper's next-day Hyperliquid group targets September 7 while its retained Kalshi estimate targets the already-expired September 3. Gold does the same. A BTC monthly estimated group still references expired `KXBTCMAXMON` August data alongside September's fresh terminal Hyperliquid curve. Read each group's own `outlook.anchor_at` and freshness; do not trust the series label or `is_primary_horizon` for all contained groups.

## Strategy data boundary

Use exact `assets/search` references `commodity:wti`, `commodity:gold`, `commodity:copper`, `crypto:btc` in one request. `linked_markets` carries direct market forecasts; verify its `relationships.assets` contains `HAS_MARKET`, `via: direct`, the expected asset key, and incoming direction. Do not infer commodity identity from question words. Retain `marketKey`, `nativeMarketId`, `seriesTicker`, `nativeEventId`, `latest_q_probability`, `forecast_at`, `market_odds_at_forecast`, and forecast status. Market-scoped Q is the probability input. Outlooks are diagnostics until a future source-specific model supplies independently validated forecasts.

Fetch each selected market from Kalshi and its exact series. Bind source name/URL, permitted contract document, primary and secondary rules, strike geometry, fixing, and contract month into a rules digest. Cancel additions if that identity changes. Accept finite probability in [0,1], timezone-aware non-future forecast time, fresh Q, native ticker equality, direct linkage, and an open venue market. Candidate selection should be balanced by asset, near-term horizon, book quality and central strikes before Q-edge ranking.

`close_time` is the trading cutoff. If `custom_strike.strike_date` is present it must agree. `expiration_time` is commonly seven days later. BTC `expected_expiration_time`, `occurrence_datetime`, and Quotient `end_date` commonly equal close +5 minutes; that documented scheduling field is not the fixing. Validate it against the exact venue fields rather than treating +5 minutes as a different price event. `status: active` does not replace checking `open_time`.

Read strike geometry from fields: `greater` uses `floor_strike`; `less` uses `cap_strike`; `between` needs both ordered bounds. Above/below are strict; ranges are inclusive per contract terms. Rounded commodity comparisons require integrating over rounded price cells if a future continuous distribution supplies probabilities. The existing outlook parser labels strict venue comparisons as `gte/lte`; this approximation matters near discrete settlement boundaries, especially copper. Exact market Q avoids reinterpreting those boundaries.

Exclude every touch/min/max/path product, including `KXWTIMONTHLY` (WTIMINMAX terms), `KXWTIMAX`, `KXBTCMAXMON`, and similarly named variants. BTC's monthly product checks a cumulative trimmed mean, not the terminal one-minute average. `can_close_early: true` also appears on ordinary terminal products, so that flag alone is not a path detector.

Current [fee rules](https://kalshi.com/docs/kalshi-fee-schedule.pdf), effective July 7, specify taker coefficient 0.07 and maker coefficient 0.0175 with respective default multipliers 1 and 0. Rounding applies to fee plus position cost to a centicent ($0.0001). All sampled allowed series report `fee_type: quadratic`, multiplier 1, so ordinary passive fills have no maker fee. Verify fee type/multiplier each refresh; use conservative entry and potential exit costs. A limit order crossing the spread is a taker order. Avoid claiming guaranteed Sharpe improvement from theoretical edges without realized fills, fees, and correlated outcome attribution.

## Evidence

`settlement/*-series.json` and `*-markets.json` preserve public rules and representative current market pages. Listings are capped samples, not an exhaustive catalog. `quotient-assets-live.json` preserves the batched exact-asset response; `quotient-price-outlooks-live.json` preserves the full outlook response. Gold/copper daily and weekly series had no open contracts at capture; their available month-end contracts exceeded a 14-day horizon. An empty candidate set at that time is expected and should not loosen the source or horizon gates.

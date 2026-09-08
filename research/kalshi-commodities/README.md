# Kalshi commodities research

The initial pilot defaults to oil only, with conservative sizing and bounded limits. Gold, BTC, copper and silver remain available through explicit configuration. The evidence does not establish a realized account Sharpe ratio or optimized trading thresholds.

The conditional entry-band audit favors oil: published blend Brier is 0.1648 versus market 0.1880 in the implemented price-math scenario with an assumed 2¢ spread. This includes 60 forecasts across 37 contracts and 11 fixing clusters; the paired confidence interval includes zero. The other four assets underperform market in that scenario. These are reconstructed forecast cohorts, not fills. [Entry-band audit](performance/entry_bands.md)

The read-only September 5 UTC audit retrieved 9,269 forecasts across 875 markets. The sample begins August 8–13 and ends September 5, 06:20 UTC. No local Kalshi account ledger was found. [Performance audit](performance.md)

| Asset | Q Brier | Stored venue Brier | Settlement clusters |
|---|---:|---:|---:|
| Bitcoin | 0.1844 | 0.1708 | 16 |
| Copper | 0.1705 | 0.1654 | 13 |
| Gold | 0.1611 | 0.1362 | 14 |
| Silver | 0.1404 | 0.1217 | 13 |
| WTI | 0.1925 | 0.2012 | 12 |

Lower Brier is better. Every asset-level confidence interval for Q's advantage includes zero. Oil's apparent advantage reverses when selecting one forecast per market. A reconstruction of 33 August entries averages +24.9%, with interval [−16.5%, +70.1%]; the twelve entries still open at the old snapshot subsequently average −41.7%. Thirty-two of 33 entries are YES. These are hypothetical returns, not fills or account performance.

Main price outlooks describe Hyperliquid instruments. Their Kalshi groups are statistical translations with incomplete source and fixing identity, sometimes containing older horizons than the surrounding series. They are diagnostic inputs only. The existing bridge can mix copper's old futures methodology with the new Pyth index. [Settlement audit](settlement.md)

| Asset | Current Kalshi settlement reference |
|---|---|
| Oil | ICE WBS daily settlement, exact named contract month |
| Gold | Pyth `Metal.Index.GOLD/USD`, feed 3153, preceding one-minute candle close |
| Copper | Pyth `Commodities.Index.CU/USD`, feed 3525, preceding one-minute candle close |
| Silver | Pyth `Metal.Index.SILVER/USD`, feed 3154, preceding one-minute candle close |
| Bitcoin | Preceding sixty-second mean of CF Benchmarks BRTI |

Copper daily contracts changed for August 31, weekly for September 4, and monthly for September 30. Gold and silver changed in late July. Historical contract-month copper observations must not be treated as the current index. [Silver daily notice](settlement/KXSILVERD-series.json), [silver weekly notice](settlement/KXSILVERW-series.json), [silver monthly notice](settlement/KXSILVERMON-series.json)

There are only four or five settlement dates of venue-specific outlook evidence per asset. At a matched six-hour horizon, the labeled 80% band contains the outcome in 55.6% of copper records, 66.7% of gold and silver, 57.1% of oil, and 71.4% of BTC. These small samples support an uncertainty allowance, not asset-specific calibration fits.

The implementation therefore validates live settlement terms, uses market-scoped Q, limits one position per underlying, caps shared exposure, and reserves entry and potential exit costs. Marketable limits are the default because the older candle study found adverse selection in passive-at-mid attempts. Current official maker fees depend on the series; the old study's universal maker-fee assumption is not the current fee contract. [Official fees](https://kalshi.com/docs/kalshi-fee-schedule.pdf)

The operator workflow and actual defaults are in [docs/kalshi-commodities.md](../../docs/kalshi-commodities.md). Public scans and account dry runs submit no orders; they do not simulate fills or produce account Sharpe. Runtime starts paused and requires explicit activation.

Reproducible evidence is under [performance/](performance/): read-only Cypher queries, official settlement responses, scored forecast rows, horizon-selected outlooks, replay arithmetic, input hashes, and sanitized local bot evidence. Current source/rules snapshots are under [settlement/](settlement/). Both sibling repositories and all trading state were left unchanged during research.

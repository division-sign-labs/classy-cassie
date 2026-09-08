# H200 settlement and market diligence

Public-source snapshot: September 5, 2026. Raw series metadata, contracts, rule PDFs, benchmark history, and selected orderbooks are saved in [settlement/](settlement/).

The relevant underlying is Ornn's H200 rental-compute benchmark, expressed in USD per GPU-hour. Kalshi's H200 series contain different payoff definitions; their forecasts and outcomes must be scored separately.

| Series | Payoff | Current status in snapshot |
| --- | --- | --- |
| `KXH200WS` | H200 value at 4 PM ET on the specified Friday | 163 contracts across 15 events; 44 active contracts in four events |
| `KXH200MON` | H200 value on the specified month-end date | 80 finalized contracts across July and August; no active contracts |
| `KXH200MS` | Arithmetic mean of hourly H200 values in the specified month | 165 contracts; 132 active, 33 finalized |
| `KXH200MAX` | Threshold crossed by December 31, 2026 | Six contracts; four active, two already finalized Yes |
| `KXH200Q` | Threshold crossed by June 30, 2026 | 20 finalized contracts |
| `KXH200W` | Weekly directional comparison | 11 contracts; ten finalized, one old closed contract |

These counts come from the [Kalshi public series endpoint](https://api.elections.kalshi.com/trade-api/v2/series) and each series's market endpoint. `KXH200CHINA` is a shipment event and is excluded. `KXH200MON` is an observation on a specified date; `KXH200MAX` and `KXH200Q` use “by” and can resolve after a threshold crossing. `KXH200MS` is an average. Shared generic rule-PDF filenames do not override the instantiated market rules.

The historical Q cohort identified in the graph contains `KXH200WS` and `KXH200MON`. Relevant official outcomes:

| Event | Benchmark value | Consequence |
| --- | --- | --- |
| `KXH200WS-26AUG28` | $4.49 | Above $4.50 = No |
| `KXH200MON-26AUG31` | $4.42 | Above $4.52 and every higher strike = No |
| `KXH200WS-26SEP04` | $4.63 | Above $4.50 = Yes |

These are official finalized results from [weekly contracts](https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXH200WS&limit=1000) and [month-end contracts](https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXH200MON&limit=1000), independently matching Ornn's public daily values for those dates. Use official `result` for scoring; some other events use a nonnumeric `expiration_value` such as `Yes`.

Weekly rules use the most recently published value if the exact scheduled value is unavailable. Values are rounded to two decimal places and “above” is strict greater-than. Post-expiration revisions are excluded. Month-end rules instead specify no-data treatment as No for ordinary strikes. [Weekly terms](https://assets.kalshi.com/contract_terms/GPUA.pdf), [month-end terms](https://assets.kalshi.com/contract_terms/GPUMON.pdf).

For Aug 31, the public Ornn daily record is timestamped 20:00 UTC. Kalshi closed the contracts at 21:28 UTC and settled at 21:58 UTC, while `occurrence_datetime` retained September 1 at 03:59 UTC. Scoring through that nominal occurrence timestamp would admit observations after the benchmark was published. The exact hourly fixing and release timestamps must be reconstructed when checking late forecasts.

## Benchmark

Ornn describes OCPI as a volume-weighted, winsorized mean of actual on-demand rentals over a rolling hour, with global contributor coverage. It excludes reserved capacity and forward contracts. Its July 24 methodology publication distinguishes this transaction approach from the earlier H100 rental-offer index; this alone does not establish an H200 transition date. Provider identities, the winsorization percentile, and some verification thresholds are confidential. Ornn acknowledges the conflict created by administering an index while operating a compute marketplace and describes separation controls. The oversight committee is described as being established, rather than documented as already constituted. Errors can trigger restatements; disruptions can produce carried values or suspension. These features limit independent reconstruction and make timestamped archives useful. [OCPI methodology](https://data.ornn.com/methodology).

The API distinguishes hourly observations from daily averages. Anonymous access provides three months of daily H200 history through `index-history`; hourly data requires authorized Full access. `history-range` returned 401 without a key, while the documented public endpoint succeeded. [Price-index documentation](https://data.ornn.com/docs/price-index), [public-history endpoint](https://data.ornn.com/docs/api-reference/historical-prices/get-a-public-daily-series).

The saved public series contains 92 daily records, June 5–September 4. The latest daily API value is $4.6254167, rounded to $4.63, timestamped September 4 at 20:00 UTC. From the cent-rounded series, the change is +3.12% over seven days and −3.74% over 30 days. The Aug 21–31 decline was 13.16%. These are our calculations from [Ornn public H200 history](https://api.ornnai.com/api/gpu/H200/index-history?startDate=2026-06-05&endDate=2026-09-05), rather than intraday prices.

There is a separate reconciliation issue for the monthly-average product. The current public August daily values average $4.70484 across 31 days, whereas `KXH200MS-26AUG` records an official settlement average of $4.555681818. July's public average, $4.57742, agrees with its $4.58 settlement after rounding. Cent rounding cannot explain the August difference. Hourly coverage, window boundaries, or historical revisions remain unverified; the daily series should not substitute for the monthly settlement feed until reconciled. This does not alter the three directly verified WS/MON outcomes above.

## Liquidity

The public books show substantial differences across strikes. These are observations, not executable guarantees or recommendations:

| Contract | YES bid / ask | Best YES bid / ask quantity | Interpretation |
| --- | --- | --- | --- |
| Sep 11 weekly above $4.50 | 75¢ / 76¢ | 12 / 50 | Tight quote, approximately $9 of YES exit value within 2¢; next YES bid is 50¢ |
| Sep 11 weekly above $5.00 | 3¢ / 60¢ | 50 / 116 | A 57¢ spread makes midpoint-based edge unusable |
| September average above $4.50 | 54¢ / 58¢ | 200 / 220 | Different payoff; approximately $108 of YES exit value within 2¢ |

Sources: saved public [Sep 11 $4.50 orderbook](https://api.elections.kalshi.com/trade-api/v2/markets/KXH200WS-26SEP11-4.500/orderbook?depth=10), [Sep 11 $5.00 orderbook](https://api.elections.kalshi.com/trade-api/v2/markets/KXH200WS-26SEP11-5.000/orderbook?depth=10), and [September average $4.50 orderbook](https://api.elections.kalshi.com/trade-api/v2/markets/KXH200MS-26SEP-4.500/orderbook?depth=10).

The series metadata reports `quadratic_with_maker_fees`, multiplier 1. A passive fill therefore should not be modeled as fee-free. Historical Q accuracy remains separate from achievable trading returns: it needs contemporaneous executable quotes, depth, and fees, with repeated ladder strikes grouped by settlement event.

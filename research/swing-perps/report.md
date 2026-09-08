# Swing perps backtest

Generated 2026-09-06T18:25+00:00. Outlook rows 20610 (HL basis, terminal_close), 2026-08-18 to 2026-09-06.

Frame: entry at the open of the first 15m bar at or after publish; target = outlook median on first touch (maker exit); stop = k x sigmaTotal x sqrt(remaining/horizon), same-bar stop wins; otherwise mark at the anchor bar close (taker exit). Costs: per-asset taker/maker from the account's fee schedule and the xyz deployer fee scale (growth-mode assets discounted); assumed round-trip spread 5 bps; funding from venue funding history over the hold. One weight per settle.

Per-asset fees (bps): xyz:COPPER 0.9/0.3, xyz:GOLD 9.0/3.0, xyz:NATGAS 0.9/0.3, xyz:PLATINUM 0.9/0.3, xyz:SILVER 0.9/0.3, xyz:CL 0.9/0.3, xyz:AAPL 0.9/0.3, xyz:HOOD 0.9/0.3, xyz:INTC 0.9/0.3, xyz:META 0.9/0.3, xyz:NVDA 0.9/0.3, xyz:ORCL 0.9/0.3, xyz:PLTR 0.9/0.3, xyz:TSLA 0.9/0.3, BTC 4.5/1.5, ETH 4.5/1.5

Directional take available from 2026-09-04: 3835 rows, side agrees with sign(gap) on 2187 of the directional ones (2586 directional). Before that, side = sign(gap).

## 1. Reproduction of the 9/1 headline (study frame: entry at spotAtObs, TP on median touch, else settle; gross, no stop)

### By market-backed (9/3 proxy), all horizons

| marketBacked | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|
| False | 97.2 | 3044 | 0.074 | 0.002 | 70.8 | 0.0 | 30.4 |
| True | 143.8 | 3014 | 0.255 | 0.166 | 71.6 | 0.0 | 18.6 |


### By market-backed x |gap| bucket

| marketBacked | absGapBucket | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|---|
| False | 0.15-0.30 | 46.4 | 1246 | 0.244 | 0.169 | 86.8 | 0.0 | 18.5 |
| False | 0.30-0.50 | 19.9 | 744 | 0.075 | -0.003 | 73.4 | 0.0 | 36.1 |
| False | 0.50-1.0 | 22.7 | 783 | 0.009 | -0.057 | 55.6 | 0.0 | 41.0 |
| False | >=1.0 | 8.1 | 271 | -0.719 | -0.775 | 15.3 | 0.0 | 55.2 |
| True | 0.15-0.30 | 53.7 | 891 | 0.077 | -0.02 | 86.5 | 0.0 | 12.4 |
| True | 0.30-0.50 | 40.1 | 803 | 0.285 | 0.197 | 74.4 | 0.0 | 18.8 |
| True | 0.50-1.0 | 33.8 | 800 | 0.6 | 0.524 | 65.4 | 0.0 | 25.7 |
| True | >=1.0 | 16.2 | 520 | 0.052 | -0.037 | 28.2 | 0.0 | 23.9 |


### Same window, bot frame (entry at next 15m bar open)

| marketBacked | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|
| False | 96.1 | 3016 | 0.084 | 0.012 | 69.5 | 0.0 | 30.8 |
| True | 142.9 | 2971 | 0.252 | 0.162 | 70.7 | 0.0 | 18.8 |


## 2. Bot frame, 24-120h horizons, |gap| in [0.15, 1.0]

### Stop sweep (whole sample)


### By stop multiple

| stop | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|
| 1.0 | 155.0 | 2951 | 0.19 | 0.106 | 71.1 | 18.4 | 20.8 |
| 1.5 | 155.0 | 2951 | 0.205 | 0.122 | 73.3 | 9.3 | 23.1 |
| 2.0 | 155.0 | 2951 | 0.232 | 0.149 | 74.3 | 4.1 | 24.3 |
| 3.0 | 155.0 | 2951 | 0.325 | 0.243 | 75.2 | 0.1 | 25.0 |
| None | 155.0 | 2951 | 0.326 | 0.244 | 75.2 | 0.0 | 25.0 |


### By stop multiple x regime

| stop | regime | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|---|
| 1.0 | <2026-09-01 | 132.3 | 2678 | 0.244 | 0.164 | 72.4 | 16.7 | 21.7 |
| 1.0 | >=2026-09-01 | 22.7 | 273 | -0.128 | -0.233 | 63.4 | 28.2 | 15.3 |
| 1.5 | <2026-09-01 | 132.3 | 2678 | 0.273 | 0.194 | 73.7 | 8.1 | 24.0 |
| 1.5 | >=2026-09-01 | 22.7 | 273 | -0.195 | -0.299 | 70.5 | 16.2 | 18.2 |
| 2.0 | <2026-09-01 | 132.3 | 2678 | 0.309 | 0.23 | 74.7 | 3.2 | 25.1 |
| 2.0 | >=2026-09-01 | 22.7 | 273 | -0.215 | -0.319 | 72.2 | 9.4 | 19.9 |
| 3.0 | <2026-09-01 | 132.3 | 2678 | 0.36 | 0.281 | 74.9 | 0.0 | 25.6 |
| 3.0 | >=2026-09-01 | 22.7 | 273 | 0.125 | 0.022 | 76.6 | 0.3 | 21.7 |
| None | <2026-09-01 | 132.3 | 2678 | 0.36 | 0.281 | 74.9 | 0.0 | 25.6 |
| None | >=2026-09-01 | 22.7 | 273 | 0.13 | 0.027 | 76.6 | 0.0 | 21.8 |


### |gap| buckets including >= 1.0 (stop 1.5)

| absGapBucket | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|
| 0.15-0.30 | 66.6 | 1265 | 0.174 | 0.089 | 87.8 | 5.3 | 16.2 |
| 0.30-0.50 | 42.2 | 834 | 0.023 | -0.066 | 68.5 | 12.9 | 23.9 |
| 0.50-1.0 | 35.5 | 852 | 0.598 | 0.525 | 59.9 | 9.6 | 32.7 |
| >=1.0 | 13.7 | 366 | -0.812 | -0.894 | 25.4 | 26.6 | 39.2 |


### Max-hold sweep at stop 3.0 (exit at the mark when the hold limit is reached before a touch)

| maxHold | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|
| 24 | 155.0 | 2951 | 0.153 | 0.067 | 57.8 | 0.0 | 14.7 |
| 48 | 155.0 | 2951 | 0.345 | 0.262 | 71.9 | 0.1 | 21.3 |
| 72 | 155.0 | 2951 | 0.303 | 0.221 | 74.4 | 0.1 | 23.7 |
| None | 155.0 | 2951 | 0.325 | 0.243 | 75.2 | 0.1 | 25.0 |


### Max-hold sweep x regime

| maxHold | regime | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|---|
| 24 | <2026-09-01 | 132.3 | 2678 | 0.228 | 0.145 | 57.9 | 0.0 | 14.6 |
| 24 | >=2026-09-01 | 22.7 | 273 | -0.283 | -0.389 | 57.0 | 0.3 | 15.0 |
| 48 | <2026-09-01 | 132.3 | 2678 | 0.361 | 0.281 | 71.4 | 0.0 | 21.5 |
| 48 | >=2026-09-01 | 22.7 | 273 | 0.252 | 0.148 | 75.2 | 0.3 | 20.2 |
| 72 | <2026-09-01 | 132.3 | 2678 | 0.335 | 0.255 | 74.0 | 0.0 | 24.1 |
| 72 | >=2026-09-01 | 22.7 | 273 | 0.121 | 0.018 | 76.6 | 0.3 | 21.5 |
| None | <2026-09-01 | 132.3 | 2678 | 0.36 | 0.281 | 74.9 | 0.0 | 25.6 |
| None | >=2026-09-01 | 22.7 | 273 | 0.125 | 0.022 | 76.6 | 0.3 | 21.7 |


## 3. Chosen stop 3.0 x sigmaTotal, max hold 48h (best whole-sample net %/trade)

### By regime

| regime | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|
| <2026-09-01 | 132.3 | 2678 | 0.361 | 0.281 | 71.4 | 0.0 | 21.5 |
| >=2026-09-01 | 22.7 | 273 | 0.252 | 0.148 | 75.2 | 0.3 | 20.2 |


### By |gap| bucket

| absGapBucket | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|
| 0.15-0.30 | 68.7 | 1265 | 0.261 | 0.176 | 87.2 | 0.0 | 15.7 |
| 0.30-0.50 | 44.3 | 834 | 0.224 | 0.135 | 65.4 | 0.2 | 23.1 |
| 0.50-1.0 | 42.0 | 852 | 0.61 | 0.535 | 53.9 | 0.1 | 28.5 |


### By anchor type

| anchorType | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|
| daily | 12.0 | 250 | 0.386 | 0.301 | 82.3 | 0.0 | 22.8 |
| monthly | 18.0 | 711 | 0.535 | 0.451 | 60.5 | 0.0 | 27.0 |
| next-day | 58.0 | 554 | 0.366 | 0.278 | 79.6 | 0.2 | 14.9 |
| two-day | 31.0 | 495 | 0.253 | 0.182 | 65.3 | 0.0 | 26.4 |
| weekly | 36.0 | 941 | 0.282 | 0.197 | 67.6 | 0.0 | 23.7 |


### By asset class

| assetClass | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|
| commodity | 51.0 | 1218 | 0.117 | 0.029 | 68.6 | 0.2 | 23.5 |
| crypto | 25.0 | 360 | 0.784 | 0.652 | 63.6 | 0.0 | 24.1 |
| equity | 79.0 | 1373 | 0.354 | 0.289 | 76.7 | 0.0 | 18.9 |


### By ISO week of publish

| week | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|
| 2026-W34 | 21.3 | 447 | 0.431 | 0.348 | 70.0 | 0.0 | 29.0 |
| 2026-W35 | 85.2 | 1949 | 0.2 | 0.118 | 65.9 | 0.0 | 22.4 |
| 2026-W36 | 48.5 | 555 | 0.563 | 0.477 | 83.3 | 0.2 | 15.9 |


### By perceived net edge quartile (|ln(median/entry)| - round-trip cost)

| edgeQ | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|
| Q1 low | 46.1 | 738 | 0.137 | 0.05 | 86.6 | 0.2 | 13.8 |
| Q2 | 37.9 | 738 | 0.261 | 0.18 | 79.1 | 0.1 | 18.6 |
| Q3 | 37.6 | 737 | 0.341 | 0.26 | 69.2 | 0.0 | 22.4 |
| Q4 high | 33.4 | 738 | 0.733 | 0.65 | 46.5 | 0.0 | 33.4 |


### By class x |gap| bucket

| assetClass | absGapBucket | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|---|
| commodity | 0.15-0.30 | 21.0 | 487 | 0.282 | 0.181 | 90.3 | 0.0 | 16.9 |
| commodity | 0.30-0.50 | 15.3 | 380 | 0.03 | -0.054 | 61.8 | 0.5 | 25.3 |
| commodity | 0.50-1.0 | 14.7 | 351 | -0.028 | -0.101 | 44.8 | 0.2 | 31.0 |
| crypto | 0.15-0.30 | 10.6 | 114 | 0.542 | 0.422 | 83.8 | 0.0 | 17.7 |
| crypto | 0.30-0.50 | 8.1 | 112 | 0.23 | 0.078 | 46.5 | 0.0 | 26.8 |
| crypto | 0.50-1.0 | 6.4 | 134 | 1.889 | 1.765 | 51.6 | 0.0 | 31.5 |
| equity | 0.15-0.30 | 37.1 | 664 | 0.17 | 0.104 | 86.3 | 0.0 | 14.4 |
| equity | 0.30-0.50 | 20.9 | 342 | 0.363 | 0.294 | 75.3 | 0.0 | 20.0 |
| equity | 0.50-1.0 | 20.9 | 367 | 0.671 | 0.61 | 61.0 | 0.0 | 25.9 |


### First eligible revision per settle only (what a bot holding one position per asset actually trades), by regime

| regime | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|
| <2026-09-01 | 138.0 | 138 | 0.379 | 0.298 | 65.9 | 0.0 | 23.9 |
| >=2026-09-01 | 17.0 | 17 | -0.034 | -0.144 | 70.6 | 5.9 | 18.8 |


### First eligible revision per settle, by class

| assetClass | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|
| commodity | 51.0 | 51 | -0.063 | -0.154 | 58.8 | 2.0 | 26.0 |
| crypto | 25.0 | 25 | 0.585 | 0.457 | 52.0 | 0.0 | 29.2 |
| equity | 79.0 | 79 | 0.511 | 0.444 | 75.9 | 0.0 | 19.7 |


### First eligible revision per settle, by |gap| bucket

| absGapBucket | settles | revs | gross% | net% | touch% | stop% | holdH |
|---|---|---|---|---|---|---|---|
| 0.15-0.30 | 68.0 | 68 | 0.057 | -0.028 | 79.4 | 0.0 | 18.4 |
| 0.30-0.50 | 48.0 | 48 | 0.473 | 0.383 | 68.8 | 2.1 | 22.4 |
| 0.50-1.0 | 39.0 | 39 | 0.645 | 0.568 | 41.0 | 0.0 | 33.0 |


## 4. Sizing bootstrap (sequential book, up to 4 positions, class caps 1/3 commodity 2/3 equity, daily marks, weekly-block bootstrap x1000)

| risk% | grossCap | trades | meanLev | realized% | p95 maxDD% | median terminal% |
|---|---|---|---|---|---|---|
| 5.0 | 2.0 | 46.0 | 0.35 | -2.52 | 10.9 | -5.6 |
| 5.0 | 3.0 | 46.0 | 0.46 | -3.23 | 13.5 | -6.7 |
| 5.0 | 4.0 | 46.0 | 0.45 | -1.49 | 9.1 | -3.8 |
| 7.5 | 2.0 | 55.0 | 0.45 | -1.96 | 21.3 | -8.8 |
| 7.5 | 3.0 | 46.0 | 0.52 | -3.82 | 16.0 | -8.4 |
| 7.5 | 4.0 | 46.0 | 0.64 | -5.39 | 20.1 | -10.7 |
| 10.0 | 2.0 | 54.0 | 0.46 | 0.95 | 15.2 | -4.2 |
| 10.0 | 3.0 | 46.0 | 0.58 | -3.13 | 15.8 | -7.1 |
| 10.0 | 4.0 | 45.0 | 0.68 | 0.89 | 11.7 | -1.8 |


Book trades at risk 10% / gross 4x (publish order):

| date | assetKey | notional | lev | net% |
|---|---|---|---|---|
| 08-18 21:30 | company:nvda | 234.0 | 0.39 | 0.334 |
| 08-19 21:30 | company:nvda | 235.0 | 0.39 | 0.347 |
| 08-20 01:30 | company:nvda | 225.0 | 0.37 | -1.898 |
| 08-21 21:31 | commodity:copper | 802.0 | 1.33 | 0.319 |
| 08-22 02:30 | company:nvda | 229.0 | 0.38 | 0.425 |
| 08-22 03:30 | commodity:copper | 800.0 | 1.33 | 0.214 |
| 08-22 05:30 | commodity:copper | 802.0 | 1.33 | -0.601 |
| 08-22 07:51 | company:tsla | 593.0 | 0.99 | -0.06 |
| 08-22 08:30 | company:orcl | 437.0 | 0.73 | 0.59 |
| 08-23 02:04 | company:nvda | 238.0 | 0.39 | 0.368 |
| 08-23 16:30 | company:hood | 368.0 | 0.61 | 2.345 |
| 08-24 00:30 | company:pltr | 328.0 | 0.54 | 1.608 |
| 08-24 06:30 | company:orcl | 314.0 | 0.52 | 1.067 |
| 08-24 08:30 | commodity:copper | 801.0 | 1.33 | -1.787 |
| 08-24 09:30 | company:nvda | 229.0 | 0.38 | -0.701 |
| 08-24 14:30 | commodity:platinum | 11.0 | 0.02 | -2.755 |
| 08-25 16:30 | company:tsla | 533.0 | 0.86 | -0.348 |
| 08-26 09:30 | company:orcl | 737.0 | 1.22 | 1.532 |
| 08-26 10:30 | company:hood | 333.0 | 0.55 | -2.302 |
| 08-26 11:30 | company:pltr | 487.0 | 0.79 | 0.563 |
| 08-26 14:30 | company:meta | 777.0 | 1.26 | 0.167 |
| 08-26 15:30 | company:pltr | 507.0 | 0.82 | -6.439 |
| 08-26 15:30 | company:orcl | 273.0 | 0.44 | -1.484 |
| 08-27 17:30 | company:tsla | 528.0 | 0.86 | 1.036 |
| 08-28 11:30 | company:nvda | 226.0 | 0.37 | -3.603 |
| 08-28 16:30 | company:tsla | 526.0 | 0.91 | 0.672 |
| 08-28 16:30 | company:orcl | 469.0 | 0.81 | 0.959 |
| 08-28 16:30 | company:intc | 316.0 | 0.55 | 1.128 |
| 08-29 09:30 | company:meta | 536.0 | 0.92 | 0.444 |
| 08-30 12:30 | company:hood | 205.0 | 0.36 | 0.756 |
| 08-30 17:30 | company:pltr | 708.0 | 1.22 | 1.916 |
| 08-30 17:30 | company:nvda | 98.0 | 0.17 | 0.246 |
| 08-30 22:30 | company:tsla | 209.0 | 0.36 | -1.708 |
| 08-31 10:30 | company:orcl | 155.0 | 0.27 | 1.233 |
| 08-31 13:30 | company:pltr | 382.0 | 0.64 | 2.5 |
| 08-31 14:30 | company:nvda | 219.0 | 0.37 | 0.644 |
| 08-31 14:30 | company:orcl | 159.0 | 0.27 | 0.618 |
| 08-31 15:30 | company:orcl | 160.0 | 0.27 | 0.773 |
| 08-31 19:30 | company:hood | 286.0 | 0.48 | 2.367 |
| 09-01 04:30 | commodity:copper | 811.0 | 1.33 | -1.653 |
| 09-01 19:30 | company:orcl | 166.0 | 0.27 | 3.422 |
| 09-01 23:30 | company:intc | 428.0 | 0.7 | -3.054 |
| 09-02 15:30 | commodity:gold | 17.0 | 0.03 | -1.7 |
| 09-03 05:30 | commodity:copper | 794.0 | 1.3 | 0.72 |
| 09-03 13:30 | commodity:copper | 801.0 | 1.3 | 0.605 |


## Verdict

- Whole sample, stop 3.0, max hold 48: net +0.262%/trade on 155.0 settles (2951 revisions).
- After 2026-09-01: net +0.148%/trade on 22.7 settles.
- No-stop reference: net +0.244%/trade; every stop lowers expectancy, the widest tested least.
- Largest (risk, gross cap) with p95 drawdown <= 25%: risk 10%, gross 4x NAV.
- |gap| >= 1.0 at stop 1.5: net -0.894%/trade on 13.7 settles; the 1.0 cap is kept.
- First eligible revision per settle (the trade a one-position-per-asset bot takes): before 2026-09-01 +0.298%/trade on 138 settles; after -0.144% on 17; equity +0.444% (79), commodity -0.154% (51).
- Perceived-edge quartiles, net %/trade: Q1 low +0.050, Q2 +0.180, Q3 +0.260, Q4 high +0.650 (ranking by edge orders trades monotonically in this sample).
- Sequential book at the chosen sizing on the sample path: 45 trades, mean leverage 0.68x NAV, realized +0.89%, bootstrap p95 max drawdown 11.7%, bootstrap median terminal -1.8%. Small per-trade edge with wide dispersion: three weeks does not separate the strategy from zero at the book level.
- Config written to config.json: `{"minGapSigma": 0.15, "maxGapSigma": 1.0, "stopSigmaMultiple": 3.0, "maxHoldHours": 48, "riskBasePct": 5, "riskMaxPct": 10, "grossNotionalNav": 4, "classShare": {"commodity": 0.3333, "equity": 0.6667}}`
- Caveats: three weeks of data; the last few days of publishes have unsettled anchors and are excluded; the touch frame has a mechanical positive bias; spread is assumed.

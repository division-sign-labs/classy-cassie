# @quotient-forecasting/strategy-flip-flat

The `signals` strategy for [cassie](https://www.npmjs.com/package/@quotient-forecasting/cassie).
It follows published [Quotient](https://quotient.social) forecasts on prediction markets:
it enters where a forecast diverges from the market price and exits once the market
prices the forecast in, at a maximum hold, or at resolution.

## Operator settings

Sizing, caps, cadence, and universe belong to the operator and are set with
`cassie strategy <botId>`:

- position cap (`topN`), allocation mode (`portfolio-kelly` or the legacy `daily-budget`)
- Kelly fraction, per-market and per-event caps, or the daily budget and per-entry share
- held-side bid depth required within 2¢ before an entry
- minimum viable entry, position check cadence, signal refresh cadence, universe

## Served rules

The entry and exit rules are served by Quotient behind the bot's strategy key
(`cassie strategy-key <botId>`), cached, persisted, and refreshed hourly. They override any
rule-shaped keys in the saved bot config. A bot never starts without a served or
persisted rule set, and a Quotient outage keeps it on the last one: reads retry, entries
stop, and exits still fire on the last committed forecast.

## Fees

Every Polymarket order carries Quotient's builder code. Quotient charges 0.75% of
notional on each fill; Polymarket collects it alongside its own fee.

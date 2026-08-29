# @quotient-forecasting/strategy-flip-flat

The `signals` strategy for [cassie](https://www.npmjs.com/package/@quotient-forecasting/cassie).
It follows published [Quotient](https://dev.quotient.social) forecasts: enter where a
forecast diverges from the market price, hold, exit when the two converge.

The strategy has no position-count cap by default and ranks competing signals widest edge
first. An optional numeric cap remains available. A daily entry budget caps cumulative
entry notional from 00:00 to 23:59 UTC. Rejected entries do not consume it; an entry capped
by liquidity or risk consumes only what it actually placed. The UTC reset replenishes entry
capacity without closing anything.

Exits are position-driven, not signal-driven. Every held prediction market gets its latest
Q forecast on the five-minute forecast cadence; the venue price is checked every minute.
A stale or unpublished entry signal cannot suppress convergence.

Tune it through the CLI rather than in code:

```sh
cassie strategy <botId> --top unlimited --daily-budget 100 --position-budget-pct 25
```

Every entry still passes the engine's per-order, liquidity, spread, and volume guardrails.

[Source](https://github.com/Quotient-Solutions-Inc/classy-cassie) ·
[Apache-2.0](https://github.com/Quotient-Solutions-Inc/classy-cassie/blob/main/LICENSE)

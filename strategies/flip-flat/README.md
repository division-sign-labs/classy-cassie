# @quotient-forecasting/strategy-flip-flat

The `signals` strategy for [cassie](https://www.npmjs.com/package/@quotient-forecasting/cassie).
It follows published [Quotient](https://dev.quotient.social) forecasts: enter where a
forecast diverges from the market price, hold, exit when the two converge.

The strategy holds at most a configured number of positions and ranks competing signals
widest edge first. A daily entry budget caps cumulative entry notional from 00:00 to 23:59
UTC. Rejected entries do not consume it; an entry capped by liquidity or risk consumes only
what it actually placed. The UTC reset replenishes entry capacity without closing anything.

Tune it through the CLI rather than in code:

```sh
cassie strategy <botId> --top 2 --daily-budget 100 --position-budget-pct 25
```

Every entry still passes the engine's per-order, liquidity, spread, and volume guardrails.

[Source](https://github.com/Quotient-Solutions-Inc/classy-cassie) ·
[Apache-2.0](https://github.com/Quotient-Solutions-Inc/classy-cassie/blob/main/LICENSE)

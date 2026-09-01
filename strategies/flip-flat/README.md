# @quotient-forecasting/strategy-flip-flat

The `signals` strategy for [cassie](https://www.npmjs.com/package/@quotient-forecasting/cassie).
It follows published [Quotient](https://dev.quotient.social) forecasts. On prediction
markets, it enters where a forecast diverges from the market price, then exits on positive
convergence or the default seven-day maximum hold.

The strategy has no position-count cap by default and ranks competing signals widest edge
first. An optional numeric cap remains available. The default eligible forecast entry edge
is 10–30 percentage points, inclusive. The maximum is configurable; `unlimited` removes it.
This edge is the gap between the Q forecast and the market reference price, not the quoted
bid/ask spread.

The default prediction-market allocator targets quarter Kelly using current portfolio
equity, subject to a 5% cap per market and a 7.5% cap across markets in the same parent
event. Same-side repeat signals can top up only the gap between existing exposure and the
new target. Added capital changes future targets automatically. If an existing position is
already above its target or cap, the allocator blocks further additions but does not
auto-trim it.

Before a portfolio-mode entry or top-up, the strategy requires at least $2,500 of
held-outcome bid notional within 2¢ of the best bid. This is an entry-only ability-to-exit
check; set `--min-exit-depth-2c-usd 0` to disable it. The engine separately sizes the buy
against live ask depth and slippage.

The legacy `daily-budget` mode remains available. It caps cumulative entry notional from
00:00 to 23:59 UTC; rejected entries do not consume it, and an entry capped by liquidity
or risk consumes only what it actually placed. The UTC reset replenishes entry capacity
without closing anything.

Exits are position-driven, not signal-driven. Every held prediction market gets its latest
Q forecast on the five-minute forecast cadence; the venue price is checked every minute.
Early convergence requires at most 2pp of edge remaining and at least a +2% gain at the
executable held-outcome bid. Otherwise the default maximum hold is seven days. A stale or
unpublished entry signal cannot suppress either exit, and the entry volume floor never
blocks a sell; executable slippage and depth still apply.

Tune it through the CLI rather than in code:

```sh
cassie strategy <botId> --allocation-mode portfolio-kelly \
  --kelly-fraction 0.25 --market-cap-pct 5 --event-cap-pct 7.5 \
  --min-exit-depth-2c-usd 2500
cassie strategy <botId> --daily-budget 100 --position-budget-pct 25
cassie strategy <botId> --max-entry-edge unlimited
```

Every entry still passes the engine's per-order, liquidity, slippage, and volume guardrails.
Cassie does not cap the quoted bid/ask spread.

[Source](https://github.com/Quotient-Solutions-Inc/classy-cassie) ·
[Apache-2.0](https://github.com/Quotient-Solutions-Inc/classy-cassie/blob/main/LICENSE)

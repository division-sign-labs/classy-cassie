# @quotient-forecasting/strategy-agent

The `agent` strategy for [Cassie](https://www.npmjs.com/package/@quotient-forecasting/cassie).
It discovers prediction markets, enriches them with Quotient forecasts, and uses one
structured Surplus Intelligence completion to select entries and exits.

The model selects and ranks markets. Cassie's deterministic sizing code converts accepted
forecasts into notionals with quarter-Kelly and fixed-fractional limits. Every action then
passes through the engine's liquidity, spread, volume, and per-order risk checks.

Configure and inspect the strategy through the CLI:

```sh
cassie init
cassie agent dry-run <botId>
cassie agent status <botId>
cassie agent prompt <botId> --set "Focus on commodities markets ending within one week"
```

The strategy supports Polymarket and Kalshi bots. It requires Quotient credentials and a
`SURPLUS_API_KEY`. The optional persona command adds an X profile as a judgment layer:

```sh
cassie agent persona <botId> --handle <x-handle>
```

[Source](https://github.com/Quotient-Solutions-Inc/classy-cassie) ·
[Apache-2.0](https://github.com/Quotient-Solutions-Inc/classy-cassie/blob/main/LICENSE)

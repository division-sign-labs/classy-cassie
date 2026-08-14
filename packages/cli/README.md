# Cassie

Cassie is an open-source, self-hosted, non-custodial trading bot for prediction
markets and perps venues.

Cassie is experimental, open-source software. Check every funding destination carefully:
something may go wrong, and you may lose funds. Quotient is a publisher; its signals are
informational and are not trading advice.

```sh
npm install --global @quotient-forecasting/cassie
cassie init
```

The wizard supports an optional organization-owned Splits Teams subaccount. Hyperliquid
also supports one-use Container-first wallet generation with encrypted export back to the
local keystore; Polymarket and Lighter remain local-generation only for custody/runtime
reasons. See the bundled Cassie operator skill for the exact boundaries and recovery flow.

The package includes the local runtime, the Cloudflare Worker control plane,
the Cloudflare Container deployment assets, and the Cassie operator skill. Its
installer copies the skill to both `~/.agents/skills/cassie` (Codex) and
`~/.claude/skills/cassie` (Claude Code). If lifecycle scripts were disabled,
install it explicitly:

```sh
cassie skill install
```

Run locally with `cassie run <botId>`, or deploy to a Cloudflare Container in
the `EEUR` placement region with `cassie deploy <botId>`. Cloudflare deploys
require Docker and a Workers Paid account; Cassie guides first-time login.

The signal strategy defaults to at most 2 positions, evaluates competing new signals
from widest to narrowest edge, and uses 50% of the daily entry budget per position. The
wizard asks for the dollar budget; it resets at 00:00
UTC and counts entry notional actually placed after risk limits. View or change it with:

```sh
cassie strategy <botId> --top 3 --daily-budget 100 --position-budget-pct 33
```

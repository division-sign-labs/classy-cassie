# cassie

Open-source, self-hosted, non-custodial trading bots for prediction markets and perps
venues. An operator runs one or more bots — each with its own wallet, one venue, one
strategy — on their own machine or their own DigitalOcean account. Signals come from the
[Quotient](https://dev.quotient.social) developer API, a separate product. No order in
this repo routes through Quotient infrastructure, and Quotient holds no keys or funds.

Cassie is experimental, open-source software. Check every funding destination carefully:
something may go wrong, and you may lose funds. Quotient is a publisher; its signals are
informational and are not trading advice.

## Quickstart

```sh
npm install --global @quotient-forecasting/cassie
cassie init
```

Node 24 or newer. The npm package installs the operator skill for Codex and Claude Code
alongside the CLI. If npm lifecycle scripts are disabled, run `cassie skill install` once.

`cassie init` can also create a dedicated Splits Teams subaccount under the organization
authenticated by the official Splits CLI. It is passkey-operated by default, appears with
the org's other subaccounts, and gives the bot no authority over them. Bot wallets are
generated directly into Cassie's encrypted local keystore.

For contributors working from this checkout:

```sh
pnpm install && pnpm build

# create a bot: wallet, venue account, strategy, Telegram, funding — all in the terminal
node packages/cli/dist/index.js init

# deterministic offline engine test: entry → capacity cap → convergence → exit
pnpm exec vitest run packages/core/test/engine-e2e.test.ts

# live, locally
node packages/cli/dist/index.js run <botId>

# or on a droplet in your own DigitalOcean account
node packages/cli/dist/index.js deploy <botId>
```

`pnpm test` runs the suite (engine idempotency, capacity checks, the convergence e2e,
thesis arithmetic, keystore round-trips).

## Venues

| venue       | status | TP/SL     | deploy | notes |
|-------------|--------|-----------|--------|-------|
| Polymarket  | ✓      | synthetic (engine-managed) | ✓ | the raw venue signer is deployed; keep it away from Splits authority |
| Kalshi      | ✓      | synthetic (engine-managed) | ✓ (US regions only) | RSA API-key auth (no wallet); funded by ACH/debit/wire on kalshi.com; cash auto-settlement; no dead man's switch |
| Hyperliquid | ✓      | native    | ✓      | master/agent key split; the agent key is the only key a runtime sees |

Adapters carry a `verifiedAgainst` date (`cassie venue status`). These venues ship breaking
changes on months-long cadence; SDK versions are pinned exactly and bumps must re-verify
against live docs. Kalshi has no official TS SDK — its RSA-PSS request signing lives in
the adapter and is pinned by known-vector tests.

## Deploy

`cassie deploy <botId>` provisions a DigitalOcean droplet in the operator's own account —
`s-1vcpu-1gb`, $6/mo, `sgp1` by default — and runs the bot there under systemd. Orders
leave from that droplet, which is what the region choice decides.

Deploy refuses to start trading unless four things hold: the droplet confirms its region
to DigitalOcean's metadata service, the venue accepts orders from there, the signal
credential works from the droplet, and Ares reporting matches local configuration. Any
failure stops the deploy with the reason and leaves the bot idle.

Credentials reach the droplet over SSH on stdin and land in `/etc/cassie/<botId>.env`,
mode 0600, owned by the service user. Droplet user-data carries none, since the metadata
service serves it to anything running on the box.

Reaching a deployed bot needs no token and no open port. The runtime listens on a unix
socket at `/run/cassie/<botId>.sock`; `cassie status`, `cassie logs`, `cassie ssh`,
`cassie portfolio`, and `cassie trade` all go over SSH with a key generated at
`~/.cassie/ssh/id_ed25519`. Host keys are pinned to `~/.cassie/ssh/known_hosts` on first
contact, and every later connection runs with `StrictHostKeyChecking=yes`.

`cassie destroy <botId>` cancels resting orders, stops the service, and deletes the
droplet. Keys and venue balances are untouched.

## Layout

| path                   | what                                                                 |
|------------------------|----------------------------------------------------------------------|
| `packages/core`        | venue adapters, wallet/keystore, strategy engine, risk module, signal client, alerts, thesis sizing |
| `packages/cli`         | the `cassie` binary: wizard, wallet, fund, run, deploy, status, logs, portfolio, trade, orders, ticket |
| `packages/runtime-node` | the bot process: engine loop, SQLite state, unix-socket control API. Same code for `cassie run` and a droplet |
| `strategies/flip-flat` | the `signals` strategy: follow Quotient signals, hold until the forecast converges with the price |
| `skills/cassie`        | agent-facing operator manual ([SKILL.md](skills/cassie/SKILL.md)) + thesis policy (`thesis/mappings.json`) |
| `fixtures/`            | signal + order-book fixtures for the offline e2e                     |

## Ares reporting (per bot)

For a Polymarket bot, `cassie reporting <botId>` opts only that bot into Ares builder
attribution and verified position-card posts. Put `ARES_BUILDER_CODE` and
`ARES_API_KEY` in the nearest `.local.env`; the command verifies the key against Ares
before saving the bot config. Use `--no-post` to retain attribution without posts, or
`--off` to remove both from that bot. Captions are per trade: `--note` supplies a manual
caption; without it, a direct Polymarket trade uses the latest Quotient forecast thesis.
Thesis trades use their public reasoning summary.

## Signals

Bots consume this contract live from Quotient. Contributor tests use internal test
doubles rather than a configurable venue or signal source:

```ts
interface Signal {
  id: string;
  ts: string;             // ISO
  venue: "polymarket" | "hyperliquid" | "lighter";
  marketRef: string;      // Polymarket: CLOB token ID (YES token); perps: instrument symbol
  side: "YES" | "NO" | "LONG" | "SHORT";
  prob?: number;          // model probability (prediction markets)
  refPrice: number;       // market price at signal time
  spreadPp?: number;      // |prob - price| in percentage points
  ttlSec: number;
}
```

Financial fields (P&L, balances, position sizes, account size) never flow toward Quotient.
For convergence, Cassie sends only the held market identifiers needed to retrieve their
latest Q forecasts.

The runtime separates the two cadences: every five minutes it refreshes the entry-signal
snapshot and batches Q forecast lookups for held markets; every 60 seconds it re-reads
venue odds and checks convergence. Entry-signal freshness never gates an exit. Held-market
lookups cost $0.005 per batch of up to 10 markets per refresh. Configure the cadences with
`cassie strategy <botId> --signal-check-minutes 5 --position-check-seconds 60`.

### Signal allocation

The signal strategy has no position-count cap by default and evaluates competing new
signals from widest to narrowest edge. Set an explicit cap with `--top N`; restore the
default with `--top unlimited`. Its daily entry budget caps cumulative entry
notional placed from 00:00–23:59 UTC;
rejected entries do not count, and liquidity/risk-capped entries consume only their final
order notional. The default allocation is 25% of the $100 daily budget per entry, while
`cassie init` asks for the dollar budget (default $100).

```sh
cassie strategy <botId> --top unlimited --daily-budget 100 --position-budget-pct 33
```

The UTC reset replenishes entry capacity; it does not close positions. Every entry remains
subject to the engine's per-order, liquidity, spread, and volume guardrails.

## Risk module

Engine-enforced on every order, whether it came from the strategy, a manual `trade`, or a
thesis ticket:

- Executable size within a slippage band of mid, 100bps by default.
- Order size capped at 25% of in-band depth, and at a per-order notional cap.
- Market eligibility: a 24-hour volume floor, $10k by default, and a spread ceiling.
- A minimum viable notional, so a capped order is skipped rather than dribbled out.
- A TTL that re-prices or cancels a resting remainder.

A skip raises an alert naming the limit that stopped it.

## Thesis intake

`cassie trade <botId> --thesis` turns a directional thesis plus six categorical answers
into a concrete, approvable trade — stops (invalidation- or ATR-anchored), R-multiple targets,
size = min(fixed-fractional, quarter-Kelly), derived leverage with liquidation-buffer
guardrails, funding-drag estimates. Every number prints with its provenance; guardrail
overrides need a second explicit confirmation. Policy lives in
[`skills/cassie/thesis/mappings.json`](skills/cassie/thesis/mappings.json) — changing it
is a file PR, not a code change. See the [skill](skills/cassie/SKILL.md) for the flow.

## License

[Apache-2.0](LICENSE).

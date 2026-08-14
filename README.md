# cassie

Open-source, self-hosted, non-custodial trading bots for prediction markets and perps
venues. An operator spins up one or more bots — each with its own wallet, trading on one
venue, running one strategy — locally or on their own Cloudflare account. Signals come
from the [Quotient](https://dev.quotient.social) developer API (separate product); nothing
in this repo routes orders through Quotient infrastructure, and Quotient never holds keys
or funds.

## Layout

| path                   | what                                                                 |
|------------------------|----------------------------------------------------------------------|
| `packages/core`        | venue adapters, wallet/keystore, strategy engine, risk module, signal client, alerts, thesis sizing |
| `packages/cli`         | the `cassie` binary: wizard, wallet, fund, run, deploy, portfolio, trade, orders, logs, ticket |
| `packages/runtime-local` | Node runner (better-sqlite3 state, Ctrl-C cancels resting orders)  |
| `packages/runtime-container` | Long-running Node trading runtime packaged into the Cloudflare Container image |
| `packages/runtime-cf`  | Cloudflare Worker control plane + Durable Object state, backed by an EEUR Container |
| `strategies/flip-flat` | the `signals` strategy: follow Quotient signals, hold until the side flips |
| `skills/cassie`        | agent-facing operator manual ([SKILL.md](skills/cassie/SKILL.md)) + thesis policy (`thesis/mappings.json`) |
| `fixtures/`            | signal + order-book fixtures for the offline e2e                     |

## Quickstart

```sh
npm install --global @quotient-forecasting/cassie
cassie init
```

The npm package installs the Cassie operator skill for Codex and Claude Code,
the local runtime, and the Cloudflare Worker + Container deployment assets. If
npm lifecycle scripts are disabled, run `cassie skill install` once.

For contributors working from this checkout:

```sh
pnpm install && pnpm build

# create a bot: wallet, venue account, strategy, Telegram, funding — all in the terminal
node packages/cli/dist/index.js init

# offline dry run (no keys, no funds): entry → capacity cap → flip → exit → re-entry
node packages/cli/dist/index.js run <botId> \
  --signals fixtures/signals.json --books fixtures/books.json --ticks 4

# live, locally
node packages/cli/dist/index.js run <botId>

# or on your own Cloudflare Workers Paid account (Docker running; pnpm exec wrangler login first)
node packages/cli/dist/index.js deploy <botId>
```

`pnpm test` runs the suite (engine idempotency, capacity checks, the flip e2e, thesis
arithmetic, keystore round-trips).

## Venues

| venue       | status | TP/SL     | Cloudflare deploy | notes |
|-------------|--------|-----------|-------------------|-------|
| Polymarket  | ✓      | synthetic (engine-managed) | ✓ | Deposit Wallets, pUSD collateral, gasless approvals, CLOB heartbeat dead-man's-switch |
| Hyperliquid | ✓      | native    | ✓                 | master/agent key split; agent key is the only key a runtime sees |
| Lighter     | ✓      | native    | ✗ local-only      | not yet wired or verified in the deployed Container runtime |

Adapters carry a `verifiedAgainst` date (`cassie venue status`). All three venues ship
breaking changes on months-long cadence; SDK versions are pinned exactly and bumps must
re-verify against live docs.

Cloudflare deploys execute trading and outbound venue/API calls in a Container whose
placement constraint is exactly `EEUR`; the Worker is only the authenticated control
plane. Deploy refuses to resume a bot unless the running Container reports `EEUR` and
the venue and signal checks pass.

## Ares reporting (per bot)

For a Polymarket bot, `cassie reporting <botId>` opts only that bot into Ares builder
attribution and verified position-card posts. Put `ARES_BUILDER_CODE` and
`ARES_API_KEY` in the nearest `.local.env`; the command verifies the key against Ares
before saving the bot config. Use `--no-post` to retain attribution without posts, or
`--off` to remove both from that bot. Captions are per trade: `--note` supplies a manual
caption, while thesis trades use their public reasoning summary.

## Signals

Bots consume this contract (live from Quotient, or fixtures for offline runs):

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

Financial fields (P&L, balances, account size) never flow toward the signal API — the
client's type surface has no method that accepts account state.

## Risk module

Engine-enforced on every order (strategy, manual, or ticket): executable size within a
slippage band of mid (default 100bps), order size capped at 25% of in-band depth and a
per-order notional cap, 24h-volume floor ($10k default) and spread ceiling for market
eligibility, minimum viable notional (skip rather than dribble), TTL-based re-price/cancel
of resting remainders. Skips raise alerts.

## Thesis intake

`cassie trade <botId> --thesis` turns a directional thesis plus six categorical answers
into a concrete, approvable trade — stops (invalidation- or ATR-anchored), R-multiple targets,
size = min(fixed-fractional, quarter-Kelly), derived leverage with liquidation-buffer
guardrails, funding-drag estimates. Every number prints with its provenance; guardrail
overrides need a second explicit confirmation. Policy lives in
[`skills/cassie/thesis/mappings.json`](skills/cassie/thesis/mappings.json) — changing it
is a file PR, not a code change. See the [skill](skills/cassie/SKILL.md) for the flow.

## Disclaimer

cassie is self-hosted software: your machines, your keys, your risk. It is not investment
advice, and no outcome is promised or implied. Trading on prediction markets and perps
venues can lose the entire balance you fund a bot with. Operators are responsible for
complying with each venue's terms of service and with the laws of their jurisdiction.
Keys are generated and stored locally; no third party —
including Quotient — takes custody of funds or credentials.

## License

[Apache-2.0](LICENSE).

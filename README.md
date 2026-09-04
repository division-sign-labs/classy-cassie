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

After the passphrase is confirmed, Cassie offers to save it per bot in macOS Keychain,
Windows Credential Manager, or Linux Secret Service. This is the default for local
agent-driven CLI commands. The passphrase stays on the operator's machine and is never
sent to the droplet.
Use `cassie passphrase remember <botId>` for an existing bot. Keep a recovery copy in a
password manager; the system credential store is not a recovery service.
Use `cassie passphrase change <botId>` to re-encrypt every entry in that bot's local
keystore in one atomic replacement. An existing system-credential-store copy is updated;
the command never changes or restarts a deployed bot. If `CASSIE_PASSPHRASE` is set in a
`.local.env` or the shell, update or remove that override after the change as instructed.

For contributors working from this checkout:

```sh
pnpm install && pnpm build

# create a bot: wallet, venue account, strategy, alerts, funding, optional deployment
node packages/cli/dist/index.js init

# deterministic offline engine test: entry → capacity cap → hold through a signal flip
pnpm exec vitest run packages/core/test/engine-e2e.test.ts

# live, locally
node packages/cli/dist/index.js run <botId>

# or on a droplet in your own DigitalOcean account
node packages/cli/dist/index.js deploy <botId>
```

`pnpm test` runs the suite (engine idempotency, capacity checks, the offline e2e,
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

The final `cassie init` step offers to continue into deployment. `cassie deploy <botId>`
can run the same flow later. It provisions a DigitalOcean droplet in the operator's own
account — `s-1vcpu-1gb`, $6/mo, `blr1` by default — and runs the bot there under systemd. Orders
leave from that droplet, which is what the region choice decides.

Deploy refuses to start or authorize trading unless four things hold: the droplet confirms
its region to DigitalOcean's metadata service, the venue accepts orders from there, the
signal credential works from the droplet, and Ares reporting matches local configuration.
Even after those checks, a newly deployed market-maker remains `HALTED` pending the
hash-bound operator review below. Any failure stops the deploy with the reason and leaves
the bot idle.

Credentials reach the droplet over SSH on stdin and land in `/etc/cassie/<botId>.env`,
mode 0600, owned by the service user. Droplet user-data carries none, since the metadata
service serves it to anything running on the box.

Reaching a deployed bot needs no token and no open port. The runtime listens on a unix
socket at `/run/cassie/<botId>.sock`; `cassie status`, `cassie logs`, `cassie ssh`,
`cassie portfolio`, and `cassie trade` all go over SSH with a key generated at
`~/.cassie/ssh/id_ed25519`. Host keys are pinned to `~/.cassie/ssh/known_hosts` on first
contact, and every later connection runs with `StrictHostKeyChecking=yes`.

Those deployed control commands need only the SSH key. Commands that decrypt local
credentials, including deploy, local run, funding, and withdrawal, read the per-bot
passphrase from the system credential store. `CASSIE_PASSPHRASE` remains an explicit
override for headless environments.

`cassie destroy <botId>` cancels resting orders, stops the service, and deletes the
droplet. Keys and venue balances are untouched.

## Layout

| path                   | what                                                                 |
|------------------------|----------------------------------------------------------------------|
| `packages/core`        | venue adapters, wallet/keystore, strategy engine, risk module, signal client, alerts, thesis sizing |
| `packages/cli`         | the `cassie` binary: wizard, wallet, fund, run, deploy, status, logs, portfolio, trade, orders, ticket |
| `packages/runtime-node` | the bot process: engine loop, SQLite state, unix-socket control API. Same code for `cassie run` and a droplet |
| `strategies/flip-flat` | the `signals` strategy: follow Quotient signals; prediction positions exit at a 90¢ held-side bid or the seven-day maximum hold |
| `skills/cassie`        | agent-facing operator manual ([SKILL.md](skills/cassie/SKILL.md)) + thesis policy (`thesis/mappings.json`) |
| `fixtures/`            | signal + order-book fixtures for the offline e2e                     |

## Quotient key (per bot)

One `.local.env` in a shared working directory serves every bot in it. To run one bot on a
different Quotient account, pin it to its own keystore entry with `cassie signals-key
<botId>`; the command verifies the key against the gateway before storing it, and the bot
then ignores `QUOTIENT_API_TOKEN` / `QUOTIENT_API_KEY` from the directory and the
environment. `cassie signals-key <botId> --auto` unpins it. Deploy afterward — the droplet
keeps the key it was last deployed with.

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
  endsAt?: number;        // venue resolution/close time in epoch ms, when the feed carries one
  ttlSec: number;
}
```

Financial fields (P&L, balances, position sizes, account size) never flow toward Quotient.
For exit evaluation, Cassie sends only the held market identifiers needed to retrieve
their latest Q forecasts.

The runtime separates the two cadences: every five minutes it refreshes the entry-signal
snapshot and batches Q forecast lookups for held markets; every 60 seconds it re-reads
venue odds and checks the take-profit price and hold deadlines. Entry-signal freshness never gates
an exit. Held-market lookups cost $0.005 per batch of up to 10 markets per refresh.
Configure the cadences with
`cassie strategy <botId> --signal-check-minutes 5 --position-check-seconds 60`.

### Signal allocation

The signal strategy has no position-count cap by default and evaluates competing new
signals from widest to narrowest eligible edge. Prediction-market entries default to a
10–30 percentage-point forecast-edge range: 30pp is eligible, while anything larger is
skipped as a likely stale or mismapped signal. Change the ceiling with
`--max-entry-edge <pp>` or remove it with `--max-entry-edge unlimited`. This is distinct
from quoted bid/ask spread, which is controlled through executable-book slippage and
depth. Set an explicit position cap with `--top N`; restore the default with
`--top unlimited`.

Prediction markets use portfolio-relative sizing by default. Each signal gets a
quarter-Kelly target based on current portfolio equity, capped at 2.5% of equity in one
market and 5% across one parent event. An entry into a market that resolves within three
days is sized 25% smaller. A repeat signal on the same side may top the
position up only by the remaining target and cap headroom. Deposits therefore affect the
next sizing decision automatically; there is no fixed daily allowance in this mode. An
existing position above a target or cap is grandfathered: it cannot be topped up, but the
allocator never sells merely to trim it back to the cap.

An entry or top-up also requires at least $2,500 of held-outcome bid notional within 2¢
of the best bid, so the strategy checks its ability to unwind before buying. Set
`--min-exit-depth-2c-usd 0` to remove that entry-only eligibility gate. Actual orders are
still sized against live entry-side depth and a slippage band.

A position is sold once the executable held-outcome bid reaches 90¢; the forecast plays
no part in that exit. Otherwise the position remains open until the default seven-day
deadline (or resolution). Low 24-hour volume never blocks an exit; executable depth and
slippage still bound it.

```sh
cassie strategy <botId> --allocation-mode portfolio-kelly \
  --kelly-fraction 0.25 --market-cap-pct 2.5 --event-cap-pct 5
cassie strategy <botId> --near-resolution-days 3 --near-resolution-size-cut-pct 25
```

The legacy fixed-budget allocator remains available. Supplying either legacy budget flag
selects it explicitly:

```sh
cassie strategy <botId> --daily-budget 100 --position-budget-pct 25
```

Its UTC reset replenishes entry capacity; it does not close positions. Every entry in
either mode remains subject to the engine's per-order, liquidity, slippage, and volume
guardrails.

## Q-directed Polymarket market making

`market-make` is a separate, deterministic strategy selected during `cassie init`. It
passively buys only the outcome favored by the latest Q forecast, then sells held
inventory on convergence, a forecast change, risk, staleness, or time. It is not a
symmetric always-on dealer and does not poll X or news.

```sh
cassie market-make configure <botId>
cassie market-make reconcile <botId>          # exact report only; no venue writes
# Review exact sanitized cancellations and each residual mismatch/reason, plus the SHA-256.
cassie market-make reconcile <botId> --apply  # confirm and submit that exact proposal hash
cassie market-make dry-run <botId>
cassie market-make status <botId>
# If still HALTED, repeat reconcile/status review after authorized reconciliation ticks.
cassie market-make resume <botId>
```

The $500 preset is a ratio template applied automatically to the bot's funded strategy
capital (collateral balance plus open inventory at average cost; pending buys remain
separately reserved). There is no required
bankroll setting; use `--bankroll-ceiling-usd 10000` only when you want a ceiling, or the
legacy `--bankroll-usd 10000` form for fixed sizing. The strategy requires at least
$1,000 of exit-side bids within 1¢ and $2,500 within 2¢. Orders are additionally capped
at 2%/0.8% of those depth bands, while total market inventory is capped at 4%/1.6%. A
$10,000 effective bankroll scales the complete dollar risk budget by 20× but leaves
those absolute floors unchanged. The hard
per-order cap becomes $400, while the normal base requests become $250 NO and $125 YES;
bankroll scaling alone does not request $400. A custom $400 NO request, such as one from a
`--base-order-usd` override, still requires $20,000/$50,000 of displayed exit depth. YES
remains half the configured base unless its direction configuration changes. Resting
entries are canceled when refreshed depth participation no longer supports their
remaining size.

A first local run and every new deployment start `HALTED` and do **not** apply venue
reconciliation. The report-only command prints the exact sanitized cancellations plus
only actual residual-inventory mismatches, each with a `reason` and
`application: 'observe-and-authorize-repeated-reconciliation'`, plus the
`inventoryApplication` policy and a proposal SHA-256. `--apply` requires confirmation and
submits only that exact hash. It authorizes the exact cancellations and observation of
those mismatches; it does not immediately adopt or correct all residual inventory.
Inventory changes wait for the configured repeated-snapshot and late-fill gates. Any
venue-snapshot change makes apply fail closed and requires a fresh report and review.
Then run `dry-run` and check `status`; the bot may remain halted, requiring a later
reconcile/status review before it is clean enough to explicitly `resume`. Once that
deployment is authorized and active, ordinary ticks may auto-reconcile; a new deployment
must repeat the review.
Ordinary `cassie trade` is disabled for these bots so it cannot bypass durable
reservations. See [the operator guide](docs/market-make.md) for the lifecycle, replay,
residual-inventory procedure, and all controls.

The prompt-driven monitor is still the separate `agent` strategy. Configure its mandate
with `cassie agent prompt <botId> --set "..."`; v1 does not layer an LLM agent over the
deterministic market-maker.

## Risk module

Engine-enforced on every order, whether it came from the strategy, a manual `trade`, or a
thesis ticket:

- Executable size within a slippage band from the best executable price, 3% by default.
- Order size capped at available in-band depth and at a per-order notional cap.
- Entry eligibility: a 24-hour volume floor, $1k by default. Exits ignore this volume floor.
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

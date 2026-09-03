# cassie

Self-hosted, non-custodial trading bots for prediction markets and perps. A bot is one
wallet, one venue, one strategy. Strategies can follow published
[Quotient](https://dev.quotient.social) forecasts, run a prompt-driven monitoring agent,
or manage Q-directed passive inventory on Polymarket.

Keys stay in an encrypted keystore on your machine. Quotient publishes the signals and
holds neither keys nor funds.

Venues: Polymarket and Hyperliquid.

Cassie is experimental software. It places real orders with real money, and you may lose
funds. Check every funding destination. Quotient's signals are informational and are not
trading advice.

## Install

Node 24 or newer.

```sh
npm install --global @quotient-forecasting/cassie
cassie --version
```

Installing also adds the operator skill for Claude Code and Codex, so an agent can drive
the same commands. If npm lifecycle scripts are disabled, run `cassie skill install`.

## Quickstart

```sh
cassie init          # wallet, venue account, strategy, alerts, funding, optional deployment
cassie run bot-1     # the bot in this terminal
```

`cassie init` asks for a keystore passphrase, generates an EOA into
`~/.cassie/keys/bot-1.json`, provisions the venue account, configures strategy allocation,
and walks through funding. Its final step offers to deploy the bot to DigitalOcean. It
offers to save the confirmed passphrase in the native system
credential store so later agent-driven commands do not prompt. Everything happens in the
terminal.

For the market-maker, choose `polymarket`, then `market-make`. It is a dedicated strategy,
not an option layered onto `signals` or `agent`.

Ctrl-C cancels resting orders before the process exits.

## Commands

| | |
|---|---|
| `cassie init` | Create a bot. Resumable if interrupted. |
| `cassie fund <bot>` | Run or re-run the funding flow. |
| `cassie withdraw <bot> <amount>` | Send collateral out. Market-makers must be freshly reconciled, settlement-quiescent, HALTED, and flat. |
| `cassie run <bot>` | Run the bot here. |
| `cassie deploy <bot>` | Run the bot on a droplet. |
| `cassie status <bot>` | Droplet, service, and engine on one screen. |
| `cassie logs <bot>` | Recent log lines. `-f` to follow. |
| `cassie ssh <bot>` | A shell on the droplet. |
| `cassie destroy <bot>` | Cancel resting orders, delete the droplet. |
| `cassie portfolio [bot]` | Cash, position value, equity, orders, and PnL. |
| `cassie orders <bot>` | List or cancel open orders. |
| `cassie trade <bot> buy\|sell <market>` | Place one order. |
| `cassie trade <bot> --thesis` | Six questions to a sized, stopped, approvable order. |
| `cassie strategy <bot>` | View or tune position count, allocation, exits, and guardrails. |
| `cassie market-make configure <bot>` | View or tune the Q-directed market-maker. |
| `cassie market-make status <bot>` | Lifecycle, config identity, inventory, orders, and loss stops. |
| `cassie market-make dry-run <bot>` | Read live inputs and propose actions without placing orders or changing trading state; metered API spend is recorded. |
| `cassie market-make reconcile <bot>` | Report exact sanitized cancellations and filtered residual mismatches with their SHA-256; `--apply` confirms only that reviewed proposal. |
| `cassie market-make halt <bot>` | Stop additions; `--liquidate` requests bounded urgent exits. |
| `cassie market-make resume <bot>` | Explicitly activate a reconciled market-maker. |
| `cassie market-make replay --input <file>` | Replay a normalized event bundle offline. |
| `cassie agent prompt <bot>` | View or change the separate monitoring-agent mandate. |
| `cassie wallet list` | Bots and key roles. |
| `cassie passphrase change <bot>` | Atomically re-encrypt every local keystore entry under a new passphrase. |
| `cassie passphrase remember <bot>` | Save a verified passphrase in the system credential store. |
| `cassie passphrase forget <bot>` | Remove a saved passphrase. |
| `cassie passphrase status <bot>` | Show whether a passphrase is saved. |
| `cassie alerts test <bot>` | Send a Telegram ping. |
| `cassie venue status` | Adapters and when each was last verified. |

## Market make

`market-make` is Polymarket-only and deterministic. It is not a symmetric, always-on
dealer: it passively acquires one outcome only when live Q has a qualifying edge, then
reduces inventory on forecast change, convergence, risk, or time. It does not poll X or
news; Quotient updates provide the thesis and CLOB movement provides shock detection.

The $500 preset is a ratio template applied automatically to funded strategy capital. At
the $500 reference size it allows at most $350 of inventory plus pending entries across
six markets. It starts with $12.50 tickets, a $20 per-order cap, $40 NO and $20 YES targets, 10–30pp
NO edges, and 10–30pp YES edges (YES at half size). Six hours is review-only. Cassie reacts immediately to
new `latest_q`, exits at 5pp remaining edge or 75% of the first-fill gap captured, uses a
24-hour normal ceiling, and permits one qualifying same-direction forecast to extend the
position to at most 36 hours.

Entry liquidity is measured on the selected outcome's exit-side bids. Defaults require
$1,000 within 1¢ and $2,500 within 2¢. One order may use at most 2%/0.8% of those
respective depth bands, and total inventory in one market may use at most 4%/1.6%. At the
minimum floors, that means at most a $20 order and $40 in one market. Both floors are
configurable. A resting entry is canceled if refreshed depth participation no longer
supports its remaining size:

```sh
cassie market-make configure bot-1 \
  --min-depth-1c-usd 1000 \
  --min-depth-2c-usd 2500 \
  --max-order-depth-1c-pct 2 \
  --max-order-depth-2c-pct 0.8 \
  --max-market-depth-1c-pct 4 \
  --max-market-depth-2c-pct 1.6
```

No bankroll flag is required: funding the bot changes sizing automatically. Decreases
apply immediately; increases require two matching clean snapshots by default to avoid a
non-atomic balance/position race. Resting adds are paused/canceled when needed to create
a clean post-settlement refresh window; exits remain supervised. `--bankroll-ceiling-usd` optionally caps the funded-capital sizing base, while
depth floors and participation fractions stay fixed. A $10,000 effective bankroll raises the hard per-order cap
to $400, but the normal base requests become $250 NO and $125 YES; scaling alone does not
request $400. A custom $400 NO request, for example from a `--base-order-usd` override,
still requires at least $20,000 within 1¢ and $50,000 within 2¢. YES remains half the
configured base unless its direction configuration changes. Configure an optional ceiling with:

```sh
cassie market-make configure bot-1 --bankroll-ceiling-usd 10000
```

`--bankroll-usd 10000` remains as an explicit fixed-sizing compatibility mode.

A first local run and every new deployment remain halted until reviewed. Startup runs
preflights but does not apply or authorize venue reconciliation. Reconcile in report-only
mode first; it prints every exact sanitized cancellation plus only residual-inventory
rows with an actual mismatch. Each residual row includes its `reason` and
`application: 'observe-and-authorize-repeated-reconciliation'`; `inventoryApplication`
describes the repeated-snapshot gate. The complete proposal has a SHA-256:

```sh
cassie market-make reconcile bot-1          # report only
cassie market-make reconcile bot-1 --apply  # confirm and submit that exact proposal hash
cassie market-make dry-run bot-1
cassie market-make status bot-1
# If still HALTED, repeat report-only reconcile/status review before resuming.
cassie market-make resume bot-1
```

Review every proposed cancellation and residual mismatch before `--apply`. Apply
authorizes the exact cancellations and observation under that hash; it does not
immediately adopt or correct residual inventory. Mutation waits for the configured
matching-snapshot count and late-fill protections. If the authoritative venue snapshot
has changed, apply refuses rather than substituting a new proposal; rerun the report and
review its new hash. Run `dry-run` and inspect `status` after apply. The bot may remain
halted while those gates are pending, in which case run a subsequent reconcile/status
review and do not resume yet. After the current deployment has been explicitly authorized
and resumed, ordinary ticks may auto-reconcile. A new deployment or configuration
identity starts halted and requires a fresh proposal.

`halt` cancels additions and resting orders while mandatory exits continue;
`halt --liquidate` requests bounded urgent exits. Manual `cassie trade` orders are
disabled for market-make bots because they would bypass durable inventory reservations.
Use a separate bot id for discretionary trading.

Configuration changes are not hot-reloaded. Redeploy a remote bot, or restart
`cassie run` locally, before reconciling and explicitly resuming the new configuration.

Prompt-driven monitoring remains the separate `agent` strategy, configured with
`cassie agent prompt <bot> --set "..."`. It is not an overlay on market-make in v1.

## Deploy

`cassie deploy` provisions a DigitalOcean droplet in your own account and runs the bot
there under systemd. It costs $6 a month and takes about three minutes the first time.

```
$ cassie deploy bot-1
DigitalOcean account you@example.com (token from ~/.cassie/digitalocean.token)
signals credential: ~/.local.env

deploying bot-1 to a new droplet in Bangalore 1
cassie-bot-1  s-1vcpu-1gb  ubuntu-24-04-x64
? Deploy? › yes

provisioning the droplet... done
running first-boot setup...... done
droplet cassie-bot-1 ready at 203.0.113.10 (blr1)
installing credentials… ok
starting the runtime.. done
runtime verified: droplet in blr1 (Bangalore 1)
Polymarket order placement permitted from IN
signals credential verified by the droplet (34 published rows)
loop started: positions every 60s; signals every 5m

bot-1 is live on cassie-bot-1 in Bangalore 1.
  cassie status bot-1
  cassie logs bot-1
  cassie destroy bot-1
```

Non-market-make bots start trading only after the droplet proves its region to
DigitalOcean's metadata service, the venue accepts orders from there, and the signal and
reporting credentials check out. Market-make completes those checks and starts `HALTED`,
as described above. A failure at any step stops the deploy with the reason and leaves the
bot idle.

`--region <slug>` picks somewhere else. The default is `blr1`.

Reaching a deployed bot needs no token or open port. The runtime listens on a unix socket,
the droplet's firewall allows SSH alone, and `cassie` uses a key it generates at
`~/.cassie/ssh/id_ed25519`. Host keys are pinned on first contact.

```sh
cassie status bot-1
cassie logs bot-1 --since '1 hour ago'
cassie logs bot-1 --errors        # the engine's recorded errors, not the journal
cassie destroy bot-1              # cancels resting orders, then deletes the droplet
```

## Keys

Cassie's local files live under `~/.cassie`, mode 0600:

| | |
|---|---|
| `keys/<bot>.json` | AES-256-GCM, scrypt-derived from your passphrase |
| `bots/<bot>.json` | Bot configuration. Holds no secret. |
| `state/<bot>.sqlite` | Tick state and recorded errors from local runs |
| `ssh/id_ed25519` | The deploy key |
| `digitalocean.token` | Your API token |

Passphrases saved for unattended local commands live outside this directory: macOS
Keychain, Windows Credential Manager, or Linux Secret Service. The entry is per bot and
per `CASSIE_HOME`. `cassie passphrase remember <bot>` prompts for and verifies the secret;
the passphrase is not part of the command. `cassie passphrase change <bot>` prompts for a
new value twice, re-encrypts the complete local keystore in one atomic replacement, and
updates an existing native-store entry. It does not change or restart a deployed bot.
`CASSIE_PASSPHRASE` in the nearest `.local.env` or exported environment is the explicit
automation override; update or remove it after a passphrase change. There is no
`ARES_PASSPHRASE`; Ares reporting uses separate `ARES_API_KEY` and `ARES_BUILDER_CODE`
values. Cassie does not add exports to shell startup files.

A deployed bot needs trade-scoped credentials, so `cassie deploy` copies only that runtime
set to the droplet over SSH and writes it to `/etc/cassie/<bot>.env`, readable only by the
service user. Polymarket is the explicit exception to the usual master-key rule: its pinned
client requires the raw venue signer plus L2 CLOB credentials at runtime. That is why
`cassie` refuses to let a Polymarket signer also hold Splits treasury authority. Hyperliquid
master/L1 keys and Polymarket Builder/Relayer credentials stay on your machine.

Nothing secret goes into droplet user-data, into a command line, or into a log.

## Risk

Every order — strategy, manual, or thesis — passes engine-enforced limits: a 3% slippage band
from the best executable price, available in-band liquidity, a per-order notional cap, a
minimum viable size, and a TTL that re-prices or cancels a resting remainder. The 24-hour
volume floor is entry eligibility and does not veto exits. Skipped orders raise an alert
saying which limit stopped them.

The strategy has no position-count cap by default. `cassie strategy <bot>` shows the
allocation and accepts either `--top N` or `--top unlimited`. On prediction markets the
default allocator recalculates a quarter-Kelly target from current portfolio equity, then
caps exposure at 5% per market and 7.5% per parent event. Same-side repeat signals may top
up toward that target. Positions already above a target or cap are not topped up and are
not automatically trimmed. New entries and top-ups also require $2,500 of held-outcome
bid depth within 2¢ by default; `--min-exit-depth-2c-usd 0` disables that entry-only gate.

Early convergence takes profit only when no more than 2pp of edge remains and the
executable held-side bid is at least 2% above cost. Otherwise the default maximum hold is
seven days. Tune those with `--min-convergence-profit-pct` and `--max-hold-days`.
The 24-hour volume floor remains an entry filter but never blocks an exit; exit slippage
and executable depth still apply.

Use `--kelly-fraction`, `--market-cap-pct`, or `--event-cap-pct` to tune that allocator;
any of those flags selects `portfolio-kelly`. The legacy fixed daily allowance remains
available, and either `--daily-budget` or `--position-budget-pct` selects `daily-budget`.
An explicitly conflicting `--allocation-mode` is rejected.

```sh
cassie strategy <bot> --kelly-fraction 0.25 --market-cap-pct 5 --event-cap-pct 7.5 \
  --min-exit-depth-2c-usd 2500
cassie strategy <bot> --daily-budget 100 --position-budget-pct 25
```

The signals strategy defaults to a maximum forecast entry edge of 30 percentage points,
inclusive. An edge of 30pp is eligible; a larger edge is skipped. This is the gap between
the Q forecast and the market reference price, not the quoted bid/ask spread. Change or
remove the ceiling at any time:

```sh
cassie strategy <bot> --max-entry-edge 25
cassie strategy <bot> --max-entry-edge unlimited
```

The signals strategy does not cap quoted bid/ask spread; slippage and in-band depth
constrain execution. Market-make separately uses a 4pp operational selected-token spread
ceiling and a 30pp hard sanity ceiling.

While orders rest, the runtime heartbeats every five seconds. If it dies, the venue cancels
those orders about ten seconds later.

## Links

[Source](https://github.com/Quotient-Solutions-Inc/classy-cassie) ·
[Operator manual](https://github.com/Quotient-Solutions-Inc/classy-cassie/blob/main/skills/cassie/SKILL.md) ·
[Issues](https://github.com/Quotient-Solutions-Inc/classy-cassie/issues) ·
[Apache-2.0](https://github.com/Quotient-Solutions-Inc/classy-cassie/blob/main/LICENSE)

# cassie

Self-hosted, non-custodial trading bots for prediction markets and perps. A bot is one
wallet, one venue, one strategy. Strategies can follow published
[Quotient](https://dev.quotient.social) forecasts, run a prompt-driven monitoring agent,
or trade one-to-five-day perps on Hyperliquid.

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

Ctrl-C cancels resting orders before the process exits.

## Commands

| | |
|---|---|
| `cassie init` | Create a bot. Resumable if interrupted. |
| `cassie fund <bot>` | Run or re-run the funding flow. |
| `cassie withdraw <bot> <amount>` | Send collateral out. |
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
| `cassie strategy <bot>` | View or tune position count, allocation, and guardrails. |
| `cassie strategy-key <bot> [key]` | Store the strategy-scoped Quotient key the signals strategy runs on. |
| `cassie agent prompt <bot>` | View or change the separate monitoring-agent mandate. |
| `cassie wallet list` | Bots and key roles. |
| `cassie passphrase change <bot>` | Atomically re-encrypt every local keystore entry under a new passphrase. |
| `cassie passphrase remember <bot>` | Save a verified passphrase in the system credential store. |
| `cassie passphrase forget <bot>` | Remove a saved passphrase. |
| `cassie passphrase status <bot>` | Show whether a passphrase is saved. |
| `cassie alerts test <bot>` | Send a Telegram ping. |
| `cassie venue status` | Adapters and when each was last verified. |

## Execution

From a source checkout, `pnpm cassie <command>` rebuilds changed code and runs the
workspace CLI. Install dependencies once with `pnpm install`; code edits need no
global installation or version bump. A stopped local bot can be started again with
`pnpm cassie run <local-bot>`, using its existing configuration and database.

Update a deployed bot directly from this checkout:

```sh
pnpm cassie deploy ares-trader --from-workspace
```

The checkout is resolved from the current directory, then from the CLI's own
location. A `cassie` alias pointing to `node /path/to/classy-cassie/scripts/cassie.mjs`
works from any directory. An npm-installed CLI needs to run from the checkout.

The update uploads built code and reuses dependencies installed on the droplet.
The first workspace deployment, or a changed lockfile, package manifest or target
Node ABI, installs a fresh dependency cache. It builds native dependencies on the
droplet, stages and checks the new release, then stops the old runtime and preserves
its database before switching code. Status shows the deployed build hash. Previous
code remains available; the database stays current through updates.

Use `--from-workspace` for subsequent source updates. A deploy without that flag
selects the published npm runtime. Local runs require a separate bot configuration
without a droplet assignment, so the same bot cannot start on both machines.

Polymarket signals bots use adaptive post-only limits by default. Entries have a
120-second deadline; unfilled remainders are canceled while partial fills are kept.
Normal exits spend up to 60 seconds posting passively, then use one bounded fill-and-kill
attempt. Urgent exits use bounded immediate execution.

Status shows confirmed-fill maker share, fees and gross price improvement against
arrival quotes. Post-only orders guarantee maker execution if filled; urgent fill-and-kill
exits can pay [Polymarket taker fees](https://docs.polymarket.com/trading/fees).

```sh
cassie strategy bot-1 --execution adaptive
cassie strategy bot-1 --entry-deadline-seconds 120 --exit-passive-seconds 60
cassie strategy bot-1 --execution legacy
```

These settings apply only to Polymarket `signals` and `flip-flat` bots. Other venues and
strategies keep their existing execution. The strategy command displays the effective
mode and durations. Restart or redeploy after changing settings; `legacy` restores
crossing limits. Before retrying an unfinished trade, inspect status, logs and orders.

Manual and thesis-driven orders require `legacy` execution on these bots. Finish or
cancel adaptive orders and reconcile their fills, then save `--execution legacy` and
restart or redeploy before placing a manual order.

Redeployment preserves the execution database in both modes. A switch to `legacy`
pauses the old adaptive runtime and waits for its orders and settlements to reconcile.
An unreachable host or unresolved submission stops deployment with the old state intact.

## Strategy keys and fees

The signals strategy runs on a strategy-scoped key (`qsk_…`) issued from the Quotient
admin console. It reads the signal feed, market lookups, and the strategy's served rules,
draws no credits, and stops on its next request once revoked. `cassie run` and
`cassie deploy` refuse to start a signals bot without one.

```sh
cassie strategy-key bot-1 <key>      # verifies against the gateway, stores it runtime-eligible
cassie strategy-key bot-1 --status   # which source the next run or deployment would use
```

`QUOTIENT_STRATEGY_KEY` in the environment or nearest `.local.env` also works. Entry and
exit rules are served by Quotient, refreshed hourly, and override any rule keys in the
saved bot config; `cassie strategy` tunes sizing, caps, and cadence only.

Quotient charges 0.75% of notional on each Polymarket fill. Every signed order carries
Quotient's builder code and Polymarket collects the fee with its own.

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

Bots start trading only after the droplet proves its region to DigitalOcean's metadata
service, the venue accepts orders from there, and the signal credential checks out. A
failure at any step stops the deploy with the reason and leaves the bot idle.

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
automation override; update or remove it after a passphrase change. Cassie does not add
exports to shell startup files.

A deployed bot needs trade-scoped credentials, so `cassie deploy` copies only that runtime
set to the droplet over SSH and writes it to `/etc/cassie/<bot>.env`, readable only by the
service user. Polymarket is the explicit exception to the usual master-key rule: its pinned
client requires the raw venue signer plus L2 CLOB credentials at runtime. That is why
`cassie` refuses to let a Polymarket signer also hold Splits treasury authority. Hyperliquid
master/L1 keys stay on your machine.
Directional Polymarket bots also receive the saved default Builder/Relayer service
credential for automatic redemption of resolved winners and losers. It travels over
SSH stdin into the private runtime environment, separately from trading credentials.

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
caps exposure at 2.5% per market and 5% per parent event. A market that resolves within
three days gets a target 25% smaller; tune that with `--near-resolution-days` and
`--near-resolution-size-cut-pct`, or `--near-resolution-days off` to disable it. Same-side
repeat signals may top up toward that target. Positions already above a target or cap are
not topped up and are not automatically trimmed. New entries and top-ups also require
$2,500 of held-outcome bid depth within 2¢ by default; `--min-exit-depth-2c-usd 0`
disables that entry-only gate.

A position is sold once at most 3pp of held-side forecast edge remains. There is no
profit floor, so a converged position goes out at whatever the market pays. Otherwise the
default maximum hold is seven days. Tune those with `--convergence-exit-pp` (`off`
disables it) and `--max-hold-days`.
The 24-hour volume floor remains an entry filter but never blocks an exit; exit slippage
and executable depth still apply.

Use `--kelly-fraction`, `--market-cap-pct`, or `--event-cap-pct` to tune that allocator;
any of those flags selects `portfolio-kelly`. The legacy fixed daily allowance remains
available, and either `--daily-budget` or `--position-budget-pct` selects `daily-budget`.
An explicitly conflicting `--allocation-mode` is rejected.

```sh
cassie strategy <bot> --kelly-fraction 0.25 --market-cap-pct 2.5 --event-cap-pct 5 \
  --min-exit-depth-2c-usd 2500
cassie strategy <bot> --near-resolution-days 3 --near-resolution-size-cut-pct 25
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
constrain execution.

While orders rest, the runtime heartbeats every five seconds. If it dies, the venue cancels
those orders about ten seconds later.

## Links

[Source](https://github.com/Quotient-Solutions-Inc/classy-cassie) ·
[Operator manual](https://github.com/Quotient-Solutions-Inc/classy-cassie/blob/main/skills/cassie/SKILL.md) ·
[Issues](https://github.com/Quotient-Solutions-Inc/classy-cassie/issues) ·
[Apache-2.0](https://github.com/Quotient-Solutions-Inc/classy-cassie/blob/main/LICENSE)

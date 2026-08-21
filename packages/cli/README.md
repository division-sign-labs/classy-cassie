# cassie

Self-hosted, non-custodial trading bots for prediction markets and perps. A bot is one
wallet, one venue, one strategy. It follows published [Quotient](https://dev.quotient.social)
forecasts, enters where a forecast diverges from the market price, and exits when the two
converge.

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
cassie init          # wallet, venue account, strategy, alerts, funding
cassie run bot-1     # the bot in this terminal
```

`cassie init` asks for a keystore passphrase, generates an EOA into
`~/.cassie/keys/bot-1.json`, provisions the venue account, sets the daily entry budget,
and walks through funding. Everything happens in the terminal.

Ctrl-C cancels resting orders before the process exits.

## Commands

| | |
|---|---|
| `cassie init` | Create a bot. Resumable if interrupted. |
| `cassie fund <bot>` | Run or re-run the funding flow. |
| `cassie withdraw <bot> <amount>` | Send collateral to an external address. |
| `cassie run <bot>` | Run the bot here. |
| `cassie deploy <bot>` | Run the bot on a droplet. |
| `cassie status <bot>` | Droplet, service, and engine on one screen. |
| `cassie logs <bot>` | Recent log lines. `-f` to follow. |
| `cassie ssh <bot>` | A shell on the droplet. |
| `cassie destroy <bot>` | Cancel resting orders, delete the droplet. |
| `cassie portfolio [bot]` | Balances, positions, orders, PnL. |
| `cassie orders <bot>` | List or cancel open orders. |
| `cassie trade <bot> buy\|sell <market>` | Place one order. |
| `cassie trade <bot> --thesis` | Six questions to a sized, stopped, approvable order. |
| `cassie strategy <bot>` | View or tune position count, budget, and guardrails. |
| `cassie wallet list` | Bots and key roles. |
| `cassie alerts test <bot>` | Send a Telegram ping. |
| `cassie venue status` | Adapters and when each was last verified. |

## Deploy

`cassie deploy` provisions a DigitalOcean droplet in your own account and runs the bot
there under systemd. It costs $6 a month and takes about three minutes the first time.

```
$ cassie deploy bot-1
DigitalOcean account you@example.com (token from ~/.cassie/digitalocean.token)
signals credential: ~/.local.env

deploying bot-1 to a new droplet in Singapore 1
cassie-bot-1  s-1vcpu-1gb  ubuntu-24-04-x64
? Deploy? › yes

provisioning the droplet... done
running first-boot setup...... done
droplet cassie-bot-1 ready at 203.0.113.10 (sgp1)
installing credentials… ok
starting the runtime.. done
runtime verified: droplet in sgp1 (Singapore 1)
Polymarket order placement permitted from SG
signals credential verified by the droplet (34 published rows)
loop started: every 5 minutes

bot-1 is live on cassie-bot-1 in Singapore 1.
  cassie status bot-1
  cassie logs bot-1
  cassie destroy bot-1
```

The bot starts trading only after the droplet proves its region to DigitalOcean's metadata
service, the venue accepts orders from there, and the signal and reporting credentials
check out. A failure at any step stops the deploy with the reason and leaves the bot idle.

`--region <slug>` picks somewhere else. The default is `sgp1`.

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

Everything lives under `~/.cassie`, mode 0600:

| | |
|---|---|
| `keys/<bot>.json` | AES-256-GCM, scrypt-derived from your passphrase |
| `bots/<bot>.json` | Bot configuration. Holds no secret. |
| `state/<bot>.sqlite` | Tick state and recorded errors from local runs |
| `ssh/id_ed25519` | The deploy key |
| `digitalocean.token` | Your API token |

A deployed bot needs a key that can sign orders, so `cassie deploy` copies that one
credential to the droplet over SSH and writes it to `/etc/cassie/<bot>.env`, readable only
by the service user. On Polymarket that credential is the raw venue signer, which is why
`cassie` refuses to let a Polymarket signer also hold Splits treasury authority. Master
keys and relayer keys stay on your machine.

Nothing secret goes into droplet user-data, into a command line, or into a log.

## Risk

Every order — strategy, manual, or thesis — passes engine-enforced limits: a 3% slippage band
from the best executable price, available in-band liquidity, a 24-hour volume floor, a per-order
notional cap, a minimum viable size, and a TTL that re-prices or cancels a resting
remainder. Skipped orders raise an alert saying which limit stopped them.

The strategy holds a bounded number of positions inside a daily entry budget that resets at
00:00 UTC. `cassie strategy <bot>` shows and changes both.

While orders rest, the runtime heartbeats every five seconds. If it dies, the venue cancels
those orders about ten seconds later.

## Links

[Source](https://github.com/Quotient-Solutions-Inc/classy-cassie) ·
[Operator manual](https://github.com/Quotient-Solutions-Inc/classy-cassie/blob/main/skills/cassie/SKILL.md) ·
[Issues](https://github.com/Quotient-Solutions-Inc/classy-cassie/issues) ·
[Apache-2.0](https://github.com/Quotient-Solutions-Inc/classy-cassie/blob/main/LICENSE)

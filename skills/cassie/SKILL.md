---
name: cassie
description: Operate cassie — self-hosted, non-custodial trading bots for prediction markets (Polymarket, Kalshi) and perps (Hyperliquid). Use for creating and funding a bot, wallets and keystore, running a bot locally or deploying it to a DigitalOcean droplet, monitoring it with status and logs, checking portfolio and orders, placing manual or thesis-driven trades, the LLM monitoring-agent strategy (mandate, persona, dry runs), the Q-directed Polymarket market-make strategy, and the risk module's sizing, stop, and leverage rules.
---

# cassie — operator manual

Agent-agnostic. Works the same whether the operator is a human at a terminal or an agent
(Claude Code, Codex, Hermes) driving the CLI. This skill **wraps** the `cassie` CLI. Numbers (sizes, stops, leverage) come from the CLI.

## 1. What cassie is

An open-source, self-hosted, **non-custodial** trading bot system. One bot = one wallet =
one venue = one strategy. Bots run locally (`cassie run`) or on a DigitalOcean droplet in
the operator's own account (`cassie deploy`). Signals come from the Quotient developer API
(a separate product with its own skill, `quotient-api`). Nothing in this repo routes
orders through Quotient infrastructure, and Quotient never holds keys or funds.

Custody model:

- Per-bot EOA, independently generated (no shared seed) directly into the local encrypted
  keystore. Final keys live in
  `~/.cassie/keys/<botId>.json`, AES-256-GCM encrypted with a scrypt-derived key from the
  operator passphrase, file mode 0600.
- Keys are split by role. Hyperliquid's master stays local; a deployed runtime receives
  the Hyperliquid agent key. **Polymarket is an explicit
  exception:** the pinned client requires the raw venue signer plus L2 HMAC credentials in
  the runtime. Builder/Relayer credentials remain local, but do not describe the deployed
  Polymarket signer as local-only or reuse it for Splits authority.
- An optional Splits Teams subaccount is an organization-owned treasury association, not a
  replacement for the venue's EOA signing requirement. It is created under the active
  organization and appears alongside its other subaccounts. Cassie stores only its public
  org/account/signer metadata; Splits authentication remains in the official Splits CLI.

**Risk statement.** This software places real orders with real money on venues that can
and do change their APIs, halt, or lose liquidity without notice. Strategies can lose the
entire balance of a bot's account. Synthetic stops (Polymarket) are best-effort at poll
cadence, not guarantees. Nothing here is investment advice. You are responsible for the
venue terms and the laws of your jurisdiction. Start small.

## 2. Install

Prerequisites: Node 24+ (better-sqlite3 native build needs a working toolchain) and
`pnpm` for source checkouts. Deploying additionally needs a DigitalOcean account and an
API token with read and write scope; `cassie deploy` walks through creating one.

- From source (current path): `pnpm install && pnpm build`, then run
  `node packages/cli/dist/index.js …` or link it with pnpm 10:
  `pnpm --dir packages/cli link`.
- Published: `npm i -g @quotient-forecasting/cassie`, or `npx @quotient-forecasting/cassie init`.
  Note the bare `cassie` npm name is taken by an unrelated package — the published names
  are the scoped `@quotient-forecasting/*` packages; the installed binary is still `cassie`.

Environment: `CASSIE_HOME` overrides `~/.cassie`; `CASSIE_PASSPHRASE` supplies an
explicit non-interactive keystore-passphrase override. Otherwise Cassie reads the per-bot
passphrase from macOS Keychain, Windows Credential Manager, or Linux Secret Service, then
prompts. A confirmed prompt offers to save there by default. The native store is the
normal agent-driven path; keep a separate recovery copy because Cassie cannot recover a
lost passphrase.
`cassie passphrase remember <botId>` itself prompts for and verifies the passphrase before
saving it; never put the secret on the command line. Cassie resolves `CASSIE_PASSPHRASE`
from the nearest `.local.env` before the exported environment when that explicit override
is needed. `cassie passphrase change <botId>` prompts for a new value twice and atomically
re-encrypts every entry in the local keystore; an existing native-store copy is updated,
while deployed runtime credentials and processes are untouched. Update or remove any
explicit `CASSIE_PASSPHRASE` override afterward. There is no `ARES_PASSPHRASE`: Ares
uses `ARES_API_KEY` and `ARES_BUILDER_CODE`, independently of the keystore passphrase.
`QUOTIENT_API_TOKEN` / `QUOTIENT_API_KEY`, `ARES_API_KEY`, `ARES_BUILDER_CODE`, and
`SURPLUS_API_KEY` (the agent strategy's LLM credential) from
the nearest `.local.env` (preferred and authoritative over stale exported values) or
the exported environment override keystore copies; `TELEGRAM_BOT_TOKEN` overrides its
keystore copy; `CASSIE_DEBUG=1`
prints stack traces; `DIGITALOCEAN_TOKEN` / `DIGITALOCEAN_ACCESS_TOKEN` override the token
stored at `~/.cassie/digitalocean.token`.

## 3. The wizard (`cassie init`), step by step

Every step happens in the terminal; you only leave it to copy-paste dashboard values.

1. **Bot id** — lowercase, dashes, max 32 chars. Names the config, keystore, and state files.
2. **Venue** — `polymarket`, `kalshi`, or `hyperliquid`.
3. **Wallet** — generate directly into the encrypted local keystore.
4. **Passphrase** — encrypts the keystore. After confirmation, Cassie offers to save it
   per bot in the native system credential store. This lets a local agent run commands
   without a prompt; it does not send the passphrase to the droplet. There is no Cassie
   recovery service, so keep a separate copy in a password manager.
5. **Optional Splits Teams subaccount** — requires the official
   `@splits/splits-cli@0.2.11`. Its API key is bound to one organization; Cassie runs
   `splits auth whoami`, shows the exact org name/id, and asks for confirmation. You choose
   your member and active passkey, then Cassie creates `cassie-<botId>` directly under that
   org's treasury owner. Passkey-only is the safe default. For Hyperliquid an
   advanced option can also register the local bot EOA and attach it to this new account
   only at threshold 1: either the passkey or EOA can move that subaccount's funds alone.
   Cassie does not yet sign Splits proposals. Polymarket's deployed signer is never offered.
   Creation is journaled and reconciled by name plus exact signer set before retry, so a
   timeout cannot silently duplicate the account. No existing account is mutated.
6. **Venue account provisioning** (adapter-driven):
   - **Polymarket** — two paths. Polymarket account creation and every gasless op
     (approvals, redemption) require a **Relayer or Builder API key** in the client —
     verified live 2026-08-13; solo derivation without either is rejected by the relayer.
     - *create* (default): create a Polymarket account. The Builder key menu offers
       **Use default Builder key** when one exists (from `~/.cassie/defaults.json` or the
       `POLYMARKET_BUILDER_KEY/SECRET/PASSPHRASE` env vars), `open` to launch
       polymarket.com → **Settings → Builders** (free) for a new one, or a pasted key
       (the wizard offers to save it as the default). A Relayer key works here too when
       the Builder prompt is left blank. This is your Polymarket relationship, not
       Quotient's.
     - *connect*: use an existing Polymarket account. Copy the wallet address from your
       polymarket.com profile, and create a Relayer API key at polymarket.com →
       **Settings → API Keys → Relayer API Keys**. Note the Relayer key is bound to the
       **signer** that created it, not the wallet — the wizard asks for that address.
     Either way the wizard derives CLOB L2 credentials (HMAC key/secret/passphrase) and
     stores them runtime-eligible; the Relayer/Builder key stays **local-only**. It also surfaces the geoblock answer (GET polymarket.com/api/geoblock,
     informational only — if `blocked: true`, reads and funding work but order placement
     is rejected by the venue).
   - **Kalshi** — no wallet is involved (the bot's EOA stays local-only identity). The
     wizard first asks production vs **demo** (demo.kalshi.co, paper funds, separate
     keys; stored as `venueUrls.kalshi.demo`). Create an API key on the site under
     **Account → API Keys** and download the RSA private key — Kalshi shows it once.
     The wizard asks for the key id (a UUID) and the private key **file path** (a pasted
     single-line base64 key also works), normalizes the key to single-line base64 PKCS#8
     DER, stores it runtime-eligible as `kalshi-api`, and verifies it with a signed
     balance read. A 401 here usually means a demo key against production (or vice
     versa) or a skewed clock. Splits treasuries are not offered — Kalshi runs on bank
     rails.
   - **Hyperliquid** — derives the master address from the bot key. Agent approval happens
     in the funding flow, after the account exists on the L1.
7. **Strategy** — prediction venues offer `signals` and `agent`; Polymarket additionally
   offers `market-make`; Hyperliquid bots always run `signals`. `market-make` is the
   deterministic Q-directed passive-inventory strategy, not a symmetric dealer; see §14.
   The `agent` strategy is the monitoring agent — plain-language mandate, Quotient
   research, model-selected entries, quarter-Kelly sizing; see §13. `signals` follows
   Quotient signals. Prediction positions exit on positive convergence, the default
   seven-day maximum hold, or resolution. The recommended allocation has no position-count
   cap, prioritizes the widest eligible edges for new entries, and accepts forecast entry
   edges from 10pp through 30pp, inclusive. The 30pp maximum is configurable or removable;
   it is the forecast-to-market edge, not quoted bid/ask spread. On prediction venues, the recommended allocator targets
   quarter Kelly from current portfolio equity, capped at 5% per market and 7.5% across one
   parent event. Same-side repeat signals may top up only the remaining target and cap
   headroom. New deposits automatically affect subsequent targets. A holding already above
   its target or cap is not topped up and is not automatically trimmed. There is no daily
   throttle in this mode. Entry and top-up eligibility also requires $2,500 of held-outcome
   bid depth within 2¢ by default, an entry-only check that can be disabled with
   `--min-exit-depth-2c-usd 0`. Early convergence requires no more than 2pp of remaining
   edge and at least +2% at the executable held-side bid; otherwise a prediction position
   exits at the seven-day maximum hold (or resolution). `--scenario-exit on` replaces that
   overlay with the confirmed seven-day signal-exit state machine (Q collapse, confirmed
   adverse cross, confirmed Q flip, positive price-led convergence, time stop from the
   entry fill), evaluated in that precedence with one canonical reason per exit; it is off
   unless an operator turns it on. In that state machine a market that resolves at or
   before `maxHoldDays` from the entry fill is held to resolution: the positive
   take-profit is switched off for that position while Q collapse, adverse cross, Q flip,
   and the time stop stay armed. The resolution date comes from the Quotient feed and is
   remembered per position. The 24h-volume floor and the minimum-notional floor
   apply to entries, never exits; exit slippage and executable depth still apply. An
   accepted entry stays reserved against market and event caps until the venue position or
   a resting order shows it, so a fill lag cannot admit a duplicate entry. The legacy
   `daily-budget` mode remains available; it defaults to
   $100 per UTC day and requests 25% of that allowance per entry. The budget counts only
   entry notional actually placed after risk/capacity limits, and its reset does not close
   positions. Hyperliquid keeps this legacy mode as its recommendation.
   The engine re-reads venue odds for held positions every 60 seconds. Every 5 minutes it
   separately refreshes entry signals and batches the latest Q forecasts for held markets,
   so stale or unpublished entry signals do not suppress convergence checks or hold-deadline
   exits. Held-market forecast lookups cost $0.005 per batch of up to 10 markets per refresh.
   Declining the recommendation asks for an optional position cap, allocation mode and its
   mode-specific parameters, minimum and maximum entry edges, minimum viable entry, tick
   interval, and universe. `cassie strategy <botId>` displays or changes the same settings
   at any time.
8. **Quotient** — live signals and exact Q forecasts. The wizard reuses a key found from
   the Quotient CLI or asks for one. `QUOTIENT_API_KEY` and `QUOTIENT_API_TOKEN` are both
   honoured from the environment, unless the bot pins its key with `cassie signals-key`
   (§7). `market-make` consumes the same market-scoped API at
   runtime; it does not send balances, P&L, or position sizes to Quotient. Deterministic
   fixture sources exist only inside the contributor test harness; they are not an
   operator choice.
9. **Telegram alerts** — create a bot with **@BotFather** on Telegram and paste its token;
   get your chat id from **@userinfobot**. The wizard offers a test ping.
10. **Funding** — optionally continues straight into `cassie fund <botId>`.
11. **Runtime** — offers to deploy the completed bot to a DigitalOcean droplet. Declining
    prints both the local-run and deploy-later commands. Reconfiguring a deployed bot
    offers to apply the new configuration to its existing deployment.

Non-secret progress is checkpointed at `~/.cassie/setup/<botId>.json` (0600). Rerunning
`cassie init` resumes wallet/Splits/venue steps without repeating completed external writes.
The complete bot config is saved before Cassie shows a funding destination or starts
deployment. After that recovery boundary, an interrupted wizard can continue with
`cassie fund <botId>` or `cassie deploy <botId>` without losing the funded venue identity.

### Funding flows (per venue)

All flows print exactly what to send where, then poll until the venue credits.

- **Polymarket**: the bridge (`bridge.polymarket.com`) issues per-chain deposit addresses
  for the bot's trading address. The wizard labels the trading address **Polygon pUSD
  only.** Do not send funding assets there; send USDC to the bridge-issued `evm` deposit
  address from a supported chain, where it is auto-wrapped to **pUSD**, the Polygon
  collateral token. Deposits over $50k should use a
  third-party bridge (DeBridge/Across/Portal) direct to Polygon USDC to limit slippage.
  The flow starts polling even when the bot already has a balance; press `s` during the
  wait to skip directly to approval verification. A top-up reports the newly credited
  delta and resulting total balance separately. After credit or skip, the flow sets
  trading approvals (one-time, **gasless** via relayer) and syncs the CLOB allowance
  cache. No gas token is ever needed.
- **Kalshi**: there is no crypto deposit address. Deposit USD on kalshi.com (**Account →
  Deposit**: ACH, debit, or wire); the flow polls the API balance until it arrives. Demo
  accounts come pre-funded. `--from splits` refuses Kalshi bots.
- **Hyperliquid**: send **≥5 USDC** (below the minimum is lost — the flow warns) plus
  **~$2 of ETH** for gas to the master address **on Arbitrum**. The CLI then submits the
  bridge deposit from the master EOA, polls the L1 until credited, generates an agent
  keypair, has the master sign `approveAgent` (named `cassie-<botId>`, truncated to 16
  chars), and marks the agent key runtime-eligible. The master key stays local.

`cassie fund <botId>` re-enters the flow for top-ups. With a configured treasury,
`--from splits` is automated only for Hyperliquid mainnet: it fixes the source to Arbitrum
One native USDC, asks the amount, and then prints the exact
`splits transactions create transfer --account … --chain-id … --recipient … --token …`
proposal. Approve the returned `signUrl` with the selected passkey. Cassie never reads or
deploys the Splits API key. Hyperliquid still needs ETH at the master for bridge gas.
Polymarket is blocked until its live bridge route can be validated.

### Withdrawals

`cassie withdraw <botId> <amount|all> --to <address>` sends collateral back out. It shows
the exact venue, amount, and destination and asks for confirmation. Withdrawals sign with
the master/L1 key, which lives in the local keystore, so the command runs on the machine
that holds it. Per venue: **Polymarket** transfers pUSD from the trading address on Polygon
(gasless, uses the operator's Builder/Relayer key); **Hyperliquid** submits a user-signed
withdrawal of USDC to the destination on Arbitrum ($1 venue fee, arrives in minutes);
**Kalshi** is not supported over the API — withdraw on kalshi.com (**Account → Withdraw**,
bank transfer), and the command says so instead of asking for an address.

## 4. Command reference

```
cassie init                                  # the wizard
cassie wallet create <botId>                 # generate a fresh EOA
cassie wallet import <botId>                 # import a private key via stdin
cassie wallet export <botId> --yes-print-my-key   # print raw key (double confirmation)
cassie wallet list                           # bots, key roles, runtime-eligibility
cassie wallet register-splits <botId>        # register EOA only; grants no account authority
cassie passphrase change <botId>             # atomically re-encrypt the complete local keystore
cassie passphrase remember <botId>           # save a verified passphrase in the native credential store
cassie passphrase forget <botId>             # remove the saved passphrase
cassie passphrase status <botId>             # report whether a passphrase is saved
cassie fund <botId> [--from splits]          # run/re-run the venue funding flow
cassie withdraw <botId> <amount|all> --to <address>   # send collateral out (signs locally)
cassie run <botId> [--debug]
cassie strategy <botId>                      # view/tune position cap, allocation, guardrails
cassie strategy <botId> --kelly-fraction .25 --market-cap-pct 5 --event-cap-pct 7.5
cassie strategy <botId> --min-exit-depth-2c-usd 2500 --max-hold-days 7
cassie strategy <botId> --daily-budget 100 --position-budget-pct 25   # legacy allocator
cassie strategy <botId> --max-entry-edge unlimited   # remove the forecast-edge ceiling
cassie strategy <botId> --position-check-seconds 60 --signal-check-minutes 5
cassie strategy <botId> --scenario-exit on      # confirmed seven-day signal-exit state machine
cassie deploy <botId> [--region <slug>] [--size <slug>] [-y]   # a droplet in YOUR DigitalOcean account
cassie destroy <botId> [-y] [--force]        # cancel resting orders, delete the droplet
cassie status <botId>                        # droplet + service + engine, one screen
cassie ssh <botId>                           # a shell on the droplet
cassie signals-key <botId> [--auto]           # pin this bot's Quotient key to its keystore
cassie reporting <botId> [--no-post|--off]   # configure Ares for this bot only
cassie portfolio [botId]                     # cash/position value/equity/orders/PnL, per bot + aggregate
cassie orders <botId> [--cancel <id>] [--cancel-all]
cassie trade <botId> buy|sell <marketRef> --size <n> [--limit <px>] [--tif gtc|ioc|fok]
             [--slippage <pct>] [--stop <px>] [--trail <bps>] [--tp <px>] [--outcome yes|no] [-y]
cassie trade <botId> --thesis [--save <file>] [--mappings <file>]   # develop a trade from a thesis
cassie trade <botId> --from-thesis <file> [--mappings <file>]       # place a saved thesis
cassie logs <botId> [--tail <n>] [-f] [--since '1 hour ago']   # the droplet's journal
cassie logs <botId> --errors [--level error|warn|info]         # the engine's recorded errors
cassie alerts test <botId>                   # Telegram ping
cassie venue status                          # adapters + verifiedAgainst dates
cassie agent prompt <botId> [--set <text>]   # view/update the agent strategy's mandate
cassie agent persona <botId> [--handle <h>] [--refresh]   # persona judgment layer ($1/fetch)
cassie agent status <botId>                  # agent config + the last wake's run report
cassie agent dry-run <botId>                 # full scan+decide cycle, places nothing
cassie market-make configure <botId>         # view/tune market-maker config and dollar limits
cassie market-make configure <botId> --bankroll-ceiling-usd 10000  # optional; funded capital is automatic
cassie market-make configure <botId> --min-depth-1c-usd 1000 --min-depth-2c-usd 2500
cassie market-make configure <botId> --max-order-depth-1c-pct 2 --max-order-depth-2c-pct 0.8 --max-market-depth-1c-pct 4 --max-market-depth-2c-pct 1.6
cassie market-make status <botId> [--json]   # lifecycle, config identity, inventory, orders, loss
cassie market-make dry-run <botId>            # live proposal only; API spend is still metered
cassie market-make reconcile <botId> [--apply]   # exact hashed report; apply only after review
cassie market-make halt <botId> [--liquidate]    # cancel adds; optional bounded urgent exits
cassie market-make resume <botId> [--acknowledge-loss-reset]
cassie market-make replay --input <bundle.json> [--fill-model queue|trade-through|touch|all]
```

Notes:

- `trade` on prediction venues defaults `--outcome yes`. On Polymarket `marketRef` is the
  **YES-token CLOB id** — NO-side orders set `--outcome no` and the adapter resolves the
  sibling token. On Kalshi `marketRef` is the **market ticker** (e.g. `KXWTI-26AUG29-T80`);
  prices are dollars 0–1 as everywhere else, converted to Kalshi's cents at the adapter,
  and sizes are whole contracts.
- `--stop`/`--tp` map to **native** trigger orders on Hyperliquid; on
  Polymarket they arm **synthetic** engine-managed triggers, best-effort at poll cadence
  (the CLI says so when you arm one). `--trail` is engine-managed everywhere.
- Every order — strategy, manual, or thesis-driven — passes the risk module:
  slippage (percentage of book walk from the best price, default 3% — set per bot with
  `cassie strategy <botId> --slippage <pct>` or per order with `--slippage`), available
  in-band depth, and min-viable-notional. The 24h volume floor ($1k) is entry eligibility,
  not an exit veto. There is no additional
  depth-percentage cap by default. Skips
  raise alerts. There is no quoted-spread gate: a wide market with depth at the touch is
  tradable, because execution cost is bounded by the slippage band, not the quote.
- The signals strategy separately defaults to a 30pp maximum forecast entry edge. The
  ceiling is inclusive: 30pp is eligible and anything above it is skipped. Set another
  ceiling with `--max-entry-edge <pp>` or remove it with `--max-entry-edge unlimited`.
  This guardrail compares the Q forecast with the market reference price; it does not cap
  the quoted bid/ask spread.
- Prediction-market signals default to `portfolio-kelly`: 0.25 of full Kelly, capped at
  5% of current portfolio equity per market and 7.5% per parent event. Repeat signals can
  add only enough to reach the current target. The allocator never auto-trims an existing
  over-cap holding. An entry/top-up additionally needs $2,500 of held-side bid depth within
  2¢ by default. Any of `--kelly-fraction`, `--market-cap-pct`, `--event-cap-pct`, or
  `--min-exit-depth-2c-usd` selects this mode. Either `--daily-budget` or
  `--position-budget-pct` selects the legacy
  `daily-budget` mode. Use `--allocation-mode` when switching explicitly; contradictory
  mode and sizing flags are rejected.
- `market-make` has a separate passive-capacity contract: entry-side inventory must have
  at least $1,000 of exit bids within 1¢ and $2,500 within 2¢ by default. A single order
  may use at most 2%/0.8% of those bands, and total inventory in one market at most
  4%/1.6%. It also enforces a 4pp operational selected-token spread ceiling and a 30pp
  hard ceiling. These controls do not change the generic `signals` strategy rules above.
- Manual `cassie trade` is disabled for `market-make` bots because an out-of-controller
  order would bypass durable cash and inventory reservations. Use another bot id for
  discretionary orders.
- For a deployed bot, `portfolio`, direct `trade`, `orders`, `status`, and `logs` reach
  the droplet over SSH. The SSH key at `~/.cassie/ssh/id_ed25519` is the whole control
  credential. `deploy`, local runs and trades, funding, withdrawals, and local thesis
  sizing can unlock the keystore; the native credential store supplies that passphrase
  to agent-driven commands.

## 5. Deploy

`cassie deploy <botId>` provisions a DigitalOcean droplet in the operator's own account and
runs the bot there under systemd. Default `s-1vcpu-1gb` in `blr1`, $6/mo, about three
minutes on a first deploy and under a minute on a redeploy. One droplet per bot.

DigitalOcean has no Japan region. Droplet regions are `nyc1/2/3`, `sfo2/3`, `ams3`,
`lon1`, `fra1`, `tor1`, `blr1`, `sgp1`, `syd1`, `atl1`, `ric1`, `mkc1`, `mem1`.

What deploy does, in order:

1. Resolves a DigitalOcean token: `DIGITALOCEAN_TOKEN` → `~/.cassie/digitalocean.token` →
   `doctl`'s config → a guided prompt. This runs **before** the passphrase prompt, so
   nobody unlocks a keystore only to hit a login wall.
2. Checks the region and size are available on that account.
3. Gathers credentials: runtime creds from the keystore, the Quotient key, Telegram, the
   Ares key with a local `/me` verification, and — for agent-strategy bots — the
   `SURPLUS_API_KEY`, verified locally against the Surplus API before any droplet work.
4. Stops any bot already running on the old droplet and cancels its resting orders.
5. Registers `~/.cassie/ssh/id_ed25519.pub`, creates the droplet, waits for cloud-init,
   and pins the host key.
6. Writes `/etc/cassie/<botId>.env` over SSH on stdin, mode 0600, owned by `cassie`.
7. `systemctl enable --now cassie@<botId>`.
8. **Verifies before trading.** `/runtime` must report a droplet in the pinned region,
   confirmed by DigitalOcean's metadata service rather than by anything the deploy passed
   in. Polymarket bots must pass `/geoblock/check`; Kalshi bots must pass `/venue/check`
   (an authenticated balance read proving the venue accepts the droplet's IP and the
   credentials). `/signals/check` must pass. Agent-strategy bots must pass `/agent/check`.
   Reporting, if enabled, must match. Non-market-make bots then run `/resume` and `/init`.
   For `market-make`, deploy starts the controller in `HALTED` and does **not** apply or
   authorize venue reconciliation. The operator must run report-only reconciliation,
   review every exact sanitized cancellation and filtered residual-inventory mismatch
   plus its proposal SHA-256, then apply that exact reviewed hash. Apply authorizes
   observation; residual mutation still waits for repeated-snapshot and late-fill gates.
   Run `dry-run` and check `status`, repeat reconcile/status review if still halted, and
   explicitly `resume` only when clean.

**Kalshi region rule**: Kalshi accepts API access from US IPs only — the inverse of
Polymarket's geoblock. A Kalshi bot defaults to `nyc3` instead of `blr1`, and deploy
refuses a non-US `--region` up front (US slugs: `nyc1/2/3`, `sfo1/2/3`, `atl1`). An
existing non-US droplet (e.g. `blr1`) cannot serve a Kalshi bot.

Any failure at step 8 stops the deploy with the reason and leaves the bot idle. The
droplet is already recorded in the bot config at that point, so a retry picks up from
there rather than orphaning a droplet.

Nothing secret goes into droplet user-data. The metadata service serves user-data to
every process on the box, so it carries only the systemd unit, the firewall rules, and the
pinned runtime version.

Reaching a deployed bot needs no token and no open port. The runtime listens on a unix
socket at `/run/cassie/<botId>.sock`; the CLI runs `curl --unix-socket` over SSH. The
droplet firewall allows inbound 22 and nothing else.

```sh
cassie deploy <botId> --region fra1     # somewhere else
cassie deploy <botId> --size s-1vcpu-2gb
cassie deploy <botId> -y                # no confirmation prompt
cassie destroy <botId>                  # cancel resting orders, then delete the droplet
```

`cassie destroy` leaves the keystore and the venue balance alone. Redeploying after a
destroy creates a fresh droplet; the bot's SQLite state does not survive it, and the
engine rebuilds what it needs from the venue on the next tick.

On the droplet: the service is `cassie@<botId>`, the binary is `/usr/bin/cassie-runtime`,
state is `/var/lib/cassie/<botId>.sqlite`, and the process runs as the unprivileged
`cassie` user with `ProtectSystem=strict`. `systemctl stop` sends SIGTERM, which cancels
resting orders before exit, with 45 seconds to do it.

## 6. Monitoring

```sh
cassie status <botId>                      # droplet + service + engine, one screen
cassie logs <botId>                        # last 200 journal lines
cassie logs <botId> -f                     # follow until Ctrl-C
cassie logs <botId> --since '1 hour ago'
cassie logs <botId> --errors               # the engine's recorded errors instead
cassie ssh <botId>                         # a shell on the droplet
```

`cassie status` reads the DigitalOcean API, `systemctl show`, and the control socket, then
prints the droplet (region, size, address, monthly cost, uptime), the service (state,
restart count, start time), the engine (live or paused, last tick), the book, and the last
five journal lines. It does not unlock the keystore. A deployed `cassie portfolio` also
reads the runtime over SSH; a local portfolio unlocks the local venue credentials.

Two log sources, and they answer different questions:

- **The journal** is everything the process wrote, at every level. This is the default and
  the right place to start. Line format is
  `[ISO timestamp] [botId] LEVEL message`, with structured context as a second argument.
- **`--errors`** reads the `errors` table the engine persists through `Engine.recordError`.
  Every row is a real engine failure with a code: `strategy-tick`, `reconcile-fills`,
  `order-ttl`, `triggers`, `action-<kind>`, `deadman`. Format is
  `<ISO> LEVEL [code] tick=<n> <message> {context}`. This table holds errors only, so
  `--level warn` and `--level info` match nothing here — use the journal for those.

Telegram carries the events worth interrupting someone for. `cassie alerts test <botId>`
sends a ping. The kinds, each prefixed with its own marker in the message:

| kind | when |
|---|---|
| `entry` | a position opened |
| `exit` | a position closed |
| `flip` | a position reversed |
| `fill` | an order filled |
| `partial-fill-timeout` | a resting remainder hit its TTL |
| `skipped-order` | the risk module refused an order, with the reason |
| `deposit` | collateral credited |
| `deploy` | a deploy finished |
| `error` | an engine error, deduped by fingerprint for `alerts.errorDedupMin` minutes |
| `deadman` | the venue cancelled resting orders because the runtime stopped heartbeating |
| `resolution` | a prediction market resolved |
| `test` | `cassie alerts test` |

## 7. Wiring Quotient signals

Live signals come from the Quotient gateway
(`https://quotient-api-gateway.onrender.com/api/v1/signals`, authenticated with an
`x-quotient-api-key` header — dev.quotient.social is gateway-only and rejects direct
calls). Get a key at quotient.social; if the **quotient-api** skill/CLI is installed and
logged in, the same key lives in `~/.config/quotient/config.json`. Give it to cassie via
`QUOTIENT_API_TOKEN` / `QUOTIENT_API_KEY` in the environment or nearest `.local.env`,
or let the wizard store it in the keystore by re-running `cassie init`.

One working directory shared by several bots means one `.local.env` key for all of them.
To put one bot on a different Quotient account, pin it to its own keystore entry:

```sh
cassie signals-key <botId>            # prompts, verifies against the gateway, stores + pins
cassie signals-key <botId> --auto     # unpin: back to .local.env, environment, keystore
```

A pinned bot ignores `QUOTIENT_API_TOKEN` / `QUOTIENT_API_KEY` from the directory and the
environment; `signals.keySource: "keystore"` in its bot config records the pin. Deploy the
bot afterward so the droplet's `/etc/cassie/<botId>.env` gets the new key — a restart alone
keeps the old one.

The quotient-api skill is a separate product surface (research, forecasts, briefs). For
entries, cassie consumes the published-signals feed: Polymarket `condition_id` resolves
to the YES-token marketRef, `latest_q` becomes the side-adjusted model probability, and
`current_cost_cents` the reference price. Forecasts older than three hours fail entry
freshness by default; `signals.maxAgeSec` can override that per bot. Freshness never
suppresses an exit.

For exits, held positions drive a batched market lookup independently of signal publication.
The runtime caches both the entry-signal snapshot and held-market Q forecasts for
`signalPollIntervalMin` (5 minutes by default), then re-reads venue odds on the faster
engine cadence. Each held-market lookup costs $0.005 per batch of up to 10 markets.

Financial fields never flow toward Quotient: no P&L, balances, position sizes, or account
size. Exit lookups disclose only the held market identifiers needed to retrieve Q forecasts;
the typed API accepts no account state.

Contributors can run the deterministic offline engine case without creating a bot,
keys, or funds:

```
pnpm exec vitest run packages/core/test/engine-e2e.test.ts
```

The test enters YES with size capped by the thin test book, then holds when forecast
convergence would realize a loss. The fixture venue and signal source are test doubles, not
product options.

## 8. Trade reporting (opt-in, Polymarket only)

Ares is a social feed, **not a venue** — there is no adapter and nothing to fund. Trades
execute on Polymarket exactly as before; Ares reads Polymarket's builder-attributed trade
feed and renders a position card from the real fill. The bot publishes its trades there
and other Ares traders may copy them, so posts are public-facing. Two halves:

1. **Attribution** — orders carry Ares' builder code, so the trade is visible to them.
2. **Posting** — after the order, a post referencing that trade is published to the feed.

Opt a single bot in with `cassie reporting <botId>`. It discovers
`ARES_BUILDER_CODE` and `ARES_API_KEY` from the nearest `.local.env`, verifies the key
with Ares `/public/v1/me`, and only then saves a `reporting` block to that bot's config:

```jsonc
"reporting": {
  "provider": "ares",                    // the destination; one today
  "builderCode": "0xaca2b076…091c12",    // required — 0x + 64 hex
  "post": true,                          // default true
  "postOn": ["entry", "exit"]            // default both
}
```

Two independent switches: `builderCode` attributes the order on the venue, `post`
governs whether the trade is reported anywhere. `cassie reporting <botId> --no-post`
keeps attribution while disabling posts; `--off` removes both from that bot.

Bots without that block are untouched: no code on their orders, no posts. The code is
applied by the adapter, not by strategy code, so every Polymarket order from an opted-in
bot carries that bot's configured builder code.

The provider key (`ares_sk_live_…` for `provider: "ares"`) comes from the nearest
`.local.env`, exported `ARES_API_KEY`, or the bot's keystore (`ares-api-key` role), in
that order. `cassie deploy` writes it into the droplet's environment file, readable only
by the service user. If posts are enabled, deploy refuses to proceed or resume unless both
the local Ares `/me` check and the droplet's own check accept the same account.

### Captions

Posts are read by people deciding whether to **copy the trade**, so the caption is the
operator's own words. It comes from one place: the `note` on the order.

| Trade path | Caption source |
| --- | --- |
| `--thesis` / `--from-thesis` | the thesis `reasoningSummary`, then the trade's terms |
| `cassie trade … --note "…"` | that text verbatim |
| direct `cassie trade …` without `--note` | the latest Quotient forecast thesis for that Polymarket market |
| strategy tick (signals) | none today — the card posts alone |

`reasoningSummary` is asked for during thesis intake, separately from `notes`, so private
scratch and the public rationale never blur. `captionFromThesis` renders it followed by
side, conviction, timeframe, expected move, and the invalidation level — the terms a
copy-trader needs. Size and price are deliberately left out of the prose: the card
carries those from the real fill, and repeating them invites the two to disagree.

For a direct manual Polymarket trade without `--note`, the CLI resolves the traded token
with CLOB's exact `/markets-by-token/{token}` endpoint, then reads the latest active thesis
from Quotient's published `/api/v1/signals` feed after the user confirms the order. It does
not use Gamma or the forecast lookup API. The read is best-effort and never blocks the fill.
If no thesis is available, Cassie skips the manual Ares post rather than allowing Ares to
invent generic copy. Strategy trades without a note still post the card alone. The
engine's internal `reason` (`signal sig_8f21 spread 12.3pp`) is never published — it's an
internal id and telemetry, meaningless to a reader.

Notes:

- Manual and thesis orders raise the same `entry`/`exit` alert a strategy tick does.
  (They previously raised none at all, so they were invisible to every sink.)
- The card is built server-side from the real trade, so size, price and P&L can't be
  faked and are never sent. cassie only sends the order id, the traded token, and the
  trading address — **the funder, not the signer** (the classic confusion; sending the
  signer fails to resolve the position).
- Posting runs as an `Alerter` alongside Telegram, wrapped in `SafeAlerter`. An Ares
  outage cannot block, delay, or fail a fill.
- Fresh trades index with a lag, so a 404 on the first attempt is expected; the client
  retries on a backoff before treating it as a real mismatch.
- **Attributed fills pay Polymarket's builder taker fee.** That is the cost of the
  relationship, and it lands on your side of the trade.

## 9. Thesis intake (perps-first)

The split is strict: **elicitation lives here, arithmetic lives in code.** The agent asks
the questions; `cassie trade <botId> --thesis` (or `--from-thesis <file>`) computes every
number. **The agent must never translate a categorical answer into a price, size, or
leverage figure itself.** No figure produced by an LLM ever reaches an order.

The six questions, exactly as the CLI asks them (`cassie trade <botId> --thesis`):

1. a. `Venue (hyperliquid / polymarket)`
   b. `Instrument (e.g. ETH, or YES-token id)`
   c. `Direction (long/short)` — or `Side (yes/no)` on Polymarket
2. `Confidence (low / medium / high)`
3. `Timeframe (intraday / days / weeks / quarter)`
4. `Magnitude (small / meaningful / repricing)`
5. `Invalidation price (or "none")`
6. `Risk budget, % of equity (soft cap 2)`

Workflow: `cassie trade <botId> --thesis` runs the whole thing in one sitting (add
`--save idea.json` to keep the thesis for reuse; place a saved one later with
`--from-thesis idea.json`). The computed trade prints every field with its provenance
(answer → rule → number), both sizing computations (fixed-fractional and quarter-Kelly,
smaller wins), derived leverage, estimated liquidation price next to the stop, funding-drag
estimate, and any capacity capping. The operator can **approve / edit / reject**; an edit
that breaks a guardrail (risk above the soft cap, stop inside the liquidation buffer, size
above the capacity cap) prints the specific violation and requires a **second explicit
confirm**. Nothing is silently blocked; nothing silently passes.

Policy lives in `skills/cassie/thesis/mappings.json` (confidence edges, ATR specs,
R-multiples, leverage caps, …) — changing policy is a file PR, not a code change.
Alternative files load via `--mappings <file>` or the thesis file's `mappings` field.

**Prediction markets variant** (thin by design): binaries have no meaningful TP/SL.
Confidence maps to an entry-spread threshold (low 12pp / medium 10pp / high 7pp); sizing
reuses min(fixed-fractional, quarter-Kelly) with `p` = model probability and `b` implied by
the share price. When a fresh live Quotient signal covers the market, the CLI takes `p`
from it automatically (mirrored if the signal's side differs from the thesis side);
otherwise it asks the operator. Flip-flat owns exits: positive convergence (at most 2pp
remaining edge and at least +2% at the executable bid), the default seven-day maximum
hold, or resolution; with `--scenario-exit on`, the confirmed signal-exit state machine.

## 10. Rules for the agent operating cassie

1. **Never** print or persist private keys outside Cassie's encrypted keystore and the
   droplet's `/etc/cassie/<botId>.env`. Logs, messages, scratch files, droplet user-data,
   and command lines must never contain one.
2. **Always** show the operator the exact order — market, side, size, limit — and get
   their confirmation before any live `trade`. (The CLI also asks; `-y` is for the
   operator to decide, not the agent.)
3. **Never** initiate a funding transfer without explicit operator confirmation of the
   destination address and amount.
4. On any error, read `cassie status <botId>` and `cassie logs <botId>` **before**
   retrying. `--errors` narrows to the engine's own recorded failures.
5. Numbers come from the CLI (§9). Categorical answers in, computed figures out.

## 11. Venue support and runtime notes

| venue       | trading | native TP/SL | deploy | dead man's switch |
|-------------|---------|--------------|--------|-------------------|
| polymarket  | ✓       | synthetic    | ✓      | CLOB heartbeat (~10s window) |
| kalshi      | ✓       | synthetic    | ✓ (US regions only) | none — the engine's TTL cancels are the only order safety net |
| hyperliquid | ✓       | ✓            | ✓      | scheduleCancel (10-min horizon, refreshed) |

Kalshi notes: RSA API-key auth (key id + private key; no wallet, no gas); markets settle
cash automatically at resolution, so there is no redeem step; quotes and orders convert
between cassie's dollars-0–1 and Kalshi's integer cents at the adapter; the 24h volume
the risk module sees is approximated from contract volume × mid.

Lighter is not a supported venue. An adapter for it exists in the tree and `cassie init`
does not offer it; `cassie deploy`, `cassie fund --from splits`, and `cassie withdraw`
refuse it.

Never attach a Polymarket bot EOA to a Splits account.

## 12. Troubleshooting

- **Polymarket 401 / "order owner mismatch"** — the classic signer-vs-funder confusion.
  Orders are *signed* by the bot's EOA (`POLY_ADDRESS`, L2 auth); the *funder* is the
  trading address. Check `~/.cassie/bots/<botId>.json`: `account.signerAddress`
  must be the keystore EOA, `account.funder` the trading address.
- **Polymarket "not enough balance/allowance" right after funding or before a first
  sell** — allowance-cache staleness. The funding flow syncs COLLATERAL; the adapter
  syncs CONDITIONAL per token before its first sell. Re-run `cassie fund <botId>` to
  re-sync if a deposit arrived outside the flow.
- **Hyperliquid queries return empty** — you queried by the agent address. All info
  queries (balances, positions, fills, open orders) key on the **master** address; the
  adapter does this, so if you're poking the API manually, use `account.masterAddress`.
- **Hyperliquid deposit never credits** — did you send exactly ≥5 USDC on **Arbitrum** to
  the master address first, and was there ETH for gas? Amounts under 5 USDC are lost by
  the bridge.
- **Duplicate-looking ticks** — the runtime serializes engine work and the engine dedupes
  by interval-slot `tickId`. A restart inside an interval re-presents a slot that already
  completed; the log says so and skips it. That line is normal, not a second trade.
- **Polymarket resting order vanished** — the dead man's switch. While orders rest, the
  runtime heartbeats every ~5s; if the runtime dies (or laptop sleeps), the venue cancels
  all resting orders ~10–15s later. That is the designed behavior (kill-safety), not a bug.
- **"wrong passphrase (or corrupted keystore)"** — scrypt+AES-GCM authentication failed:
  wrong passphrase, or the keystore file was edited. There is no recovery without the
  passphrase; re-import the key (`cassie wallet import`) if you have it elsewhere. Cassie
  does not delete a saved system-credential-store entry on this ambiguous error.
- **`cassie deploy` fails immediately** — the DigitalOcean token is missing or lacks write
  scope, the account is at its droplet limit, or the region does not offer the size. The
  error names which. Deploys run against your own DigitalOcean account.
- **`refusing to resume: Polymarket reports … as blocked`** — orders leave from the
  droplet, and the venue does not accept them from that region. Redeploy elsewhere:
  `cassie deploy <botId> --region <slug>`. The bot stays idle until one passes.
- **`cannot confirm this host's region`** — the runtime asks DigitalOcean's metadata
  service where it is and refuses to trade without an answer. Check that
  `169.254.169.254` is reachable from the droplet.
- **`cassie logs` says the host key changed** — the droplet was rebuilt outside cassie.
  Verify that is what happened, then `ssh-keygen -R <ip> -f ~/.cassie/ssh/known_hosts`.
- **Splits shows the wrong organization** — `SPLITS_API_KEY` overrides the CLI's saved auth
  and every key belongs to one org. Stop at the org confirmation, unset/change the key,
  and verify with `splits auth whoami`; Cassie has no team-switch command.

## 13. Monitoring-agent strategy (`agent`)

The prompt-driven strategy for prediction-venue bots. The operator supplies a plain-language
mandate — e.g. *"look for commodities markets meeting these criteria, ending within a
week"* — an optional persona, and a bankroll. Each wake the bot:

1. **Discovers** open markets on its venue (Polymarket Gamma / Kalshi's public catalog),
   filtered deterministically by the configured criteria (end window, volume floor,
   category keywords). Free.
2. **Enriches** with Quotient: the mispriced feed, a market search on the mandate text,
   and batched forecast lookups (10 markets per billed call) for held markets and top
   candidates. Metered by `maxQuotientSpendUsdPerWake` (default $0.10) with a per-market
   forecast cache (default 4h TTL) so nothing is re-bought inside a wake window.
3. **Decides** with one structured Surplus Intelligence completion (default model
   `gpt-5.6-sol`, ordered fallback pool). The model selects, ranks, and vetoes; for each
   entry it emits a calibrated probability and a confidence, never a size.
4. **Sizes deterministically.** The live venue mid is re-read at decision time; the
   sizing probability defaults to *min-edge* (whichever of the model's and Quotient's
   probabilities implies the smaller edge); the edge must clear the thesis mappings'
   confidence bar; the stake is `buildPredictionSize` (min of fixed-fractional and
   quarter-Kelly) on `min(equity, budgetUsd)`, capped by bankroll headroom, the optional
   daily budget, and `maxPositions`. **No model-produced figure ever reaches an order**,
   and the engine's risk module (slippage band, depth, volume floor, per-order cap) still
   gates every placement.

Prerequisites: a Quotient API key (research + persona) and **`SURPLUS_API_KEY`**
(resolved from the environment / nearest `.local.env` / bot keystore role
`surplus-api-key`; verified live at init and deploy; the droplet env carries it). Engine
ticks run every `tickIntervalMin` (default 15) as free housekeeping; the paid cycle runs
at `agentIntervalMin` (default 60), restart-safe via strategy memory.

**Persona (optional judgment layer)**: `cassie agent persona <botId> --handle <x-handle>`
profiles an X account through Quotient (`$1` per fetch — confirmed each time; the test
handle used during development was `amphib0ly`), renders a deterministic brief, and stores
it in the bot config, so it survives redeploys and is never re-bought per wake. The model
reviews candidates through it — veto, lower confidence, or reweight, with inferences
treated as uncertain; the persona never adds markets and never overrides policy.
`--refresh` re-profiles the stored handle. Persona and criteria compose; either may be
absent.

Workflow:

```sh
cassie init                          # choose venue → strategy: agent → mandate, budget, key, persona
cassie agent dry-run <botId>         # full cycle: candidates, model reasoning, sizing arithmetic — no orders
cassie run <botId>                   # live locally
cassie deploy <botId>                # droplet; /agent/check gates resume
cassie agent status <botId>          # config + last wake report (spend, decisions, skips)
cassie agent prompt <botId> --set "…"   # update the mandate (redeploy to apply on a droplet)
```

Disclosures: the decision prompt includes held positions and budget headroom (the model
needs them to judge exits and allocation) and is sent to Surplus Intelligence. Nothing
about the account ever flows to Quotient — its calls stay market-scoped. Every paid
Quotient call and its per-wake total appear in the run report.

`agent` is not an overlay on `market-make` in v1. One bot has one strategy; use a separate
bot id when prompt-driven monitoring and deterministic market-making should run alongside
each other.

## 14. Q-directed market-make strategy (`market-make`)

Polymarket-only. Despite the command name, this is not a symmetric always-on dealer. It
passively acquires the Q-favored outcome when a published, current forecast has enough
edge, then manages that inventory until forecast change, convergence, risk, or time calls
for an exit. The strategy is deterministic: it does not poll X or external news, and no
LLM-produced number reaches an order. Quotient updates supply the thesis; live CLOB
movement and data-freshness checks supply shock detection.

### Live funded capital and the default $500 template

- Cassie uses funded strategy capital automatically: collateral balance plus open
  inventory at average cost. Pending BUYs are counted once through collateral and
  separately reserved as exposure. Deposits and realized P&L affect authoritative
  observations without mark-to-market sizing noise. Decreases apply immediately;
  increases require two matching clean snapshots by default. No bankroll flag is required.
  If resting adds prevent a clean increase, Cassie pauses/cancels new BUYs, keeps exits
  supervised through the five-minute late-fill window, then scales automatically.
  This Cassie live mode supersedes the research artifact's legacy `auto_compound: false`;
  use a ceiling or fixed mode when gains must not raise limits.
  Expected/unpaid liquidity rewards never affect a quote. Once actually paid into
  collateral, they count as realized cash in live mode; a ceiling/fixed mode prevents
  that later growth.
- Do not withdraw while the market-maker has positions or working orders. Venue snapshots
  do not label transfers, so a withdrawal can conservatively trigger drawdown exits. Get
  flat, halt it, keep the controller running, let the five-minute late-fill overlap elapse,
  and apply a fresh reconciliation.
  `cassie withdraw` fails closed unless live status proves the current deployment is
  settlement-quiescent, `HALTED`, and completely flat. Withdraw, reconcile/review again,
  then always resume with
  `--acknowledge-loss-reset` to rebase the intentional cash flow, even if it did not latch
  the loss stop.
- At the $500 reference size, at most $350 is inventory plus pending entries, with $100 minimum
  free collateral, a $50 operational reserve, six active markets, and 12 live orders.
- $12.50 base ticket and $20 hard per-order notional cap.
- NO: 10–30pp live Q edge, full sizing, $40 target cost per market.
- YES: 20–30pp live Q edge, half sizing, $20 target cost per market.
- 4pp operational selected-token spread ceiling; 30pp is the hard sanity ceiling.
- Category-family diversification is preferred when valid candidates exist. V1 is
  generally opportunity-constrained rather than bankroll-constrained.

Liquidity is measured on the selected outcome's exit-side bid book before adding
inventory. Defaults require at least $1,000 within 1¢ and $2,500 within 2¢ of the best
bid. A single order may use no more than 2% of the 1¢ band and 0.8% of the 2¢ band; all
inventory in one market may use no more than 4% and 1.6%, respectively. The best-level,
order, market, and portfolio caps can only reduce those amounts. At both minimum depth
floors, the resulting capacity is $20 per order and $40 per market. Refreshed depth
participation also governs working entries: cancel a resting entry when its remaining
size is no longer supported.

Both floors are configurable. Dollar limits scale automatically from funded capital;
the depth floors, percentages, edge rules, and market count do not. An optional ceiling
limits the sizing base. The older `--bankroll-usd` flag selects explicit fixed sizing:

```sh
cassie market-make configure <botId> --min-depth-1c-usd 1000 --min-depth-2c-usd 2500
cassie market-make configure <botId> --bankroll-ceiling-usd 10000
cassie market-make configure <botId> --bankroll-usd 10000  # fixed compatibility mode
cassie market-make configure <botId> --max-order-depth-1c-pct 2 --max-order-depth-2c-pct 0.8 --max-market-depth-1c-pct 4 --max-market-depth-2c-pct 1.6
```

The $10,000 example scales the hard per-order cap from $20 to $400, but its normal base
requests are $250 NO and $125 YES because YES uses half size. Bankroll scaling alone does
not request $400. A custom $400 NO request, such as one from a `--base-order-usd`
override, still requires at least $20,000 of exit bids within 1¢ and $50,000 within 2¢.
YES remains half the configured base unless `direction_policy.YES.size_multiplier` is
changed in a complete configuration. A complete replacement JSON is accepted with
`--config <file>` and is strictly validated before the bot config is replaced.

### Activation and operations

A first local run and every new deployment begin halted. Deploy performs region, venue,
credential, and signal checks and starts controller loops, but it does not apply or
authorize venue reconciliation. Use this exact activation sequence:

```sh
cassie market-make reconcile <botId>          # report only
cassie market-make reconcile <botId> --apply  # confirm and submit the reviewed proposal hash
cassie market-make dry-run <botId>
cassie market-make status <botId>
# If still HALTED, repeat report-only reconcile/status review before resuming.
cassie market-make resume <botId>
```

The report must show every exact sanitized unknown/external order proposed for
cancellation. `residualInventory[]` must be filtered to actual mismatches only, identified
by `reason`: `unmanaged`, `missing-durable-cycle`, `identity-conflict`,
`quantity-mismatch`, or `venue-position-absent`. Each row must say
`application: 'observe-and-authorize-repeated-reconciliation'`, and
`inventoryApplication` must expose the repeated-authoritative-snapshot mode, configured
minimum matching snapshots, and late-fill warning. Review the whole proposal and its
SHA-256 before running `--apply`.

Apply confirms and submits only that exact hash. It authorizes the exact cancellations
and observation of residual mismatches; it does not immediately adopt or correct all
residual inventory. Mutation occurs only after the configured repeated-snapshot and
late-fill gates pass. If any authoritative balance, position, order, or fill changes, the
snapshot no longer matches and apply must refuse; run report-only reconciliation again
and review the new proposal. Never accept a replacement snapshot under the old
confirmation.

`dry-run` reads live Quotient, Gamma, and CLOB inputs, but places no orders and changes no
trading state. Metered API spend is still recorded.
`status --json` exposes the config/deployment identity and lifecycle for automation.
`resume` refuses config drift, stale deployment activation, unresolved reconciliation,
or a latched loss stop. Apply alone does not guarantee that resume is allowed: if status
remains halted while inventory evidence accumulates, run a subsequent report-only
reconcile and status review and wait for the repeated-snapshot/late-fill gates to clear.
Resetting a reviewed loss stop requires the explicit `--acknowledge-loss-reset` flag.

Only after the current deployment/config identity has been explicitly authorized and
resumed may ordinary controller ticks auto-reconcile. A first run, new deployment, or
new configuration identity starts halted and requires a fresh hashed proposal and
operator review.

`halt` cancels additions and resting orders while mandatory exits continue.
`halt --liquidate` requests bounded urgent exits; it never authorizes an unlimited market
sale. If residual venue inventory is adopted or status reaches `EXIT_BLOCKED`, first read
`cassie status <botId>`, `cassie market-make status <botId> --json`, and
`cassie logs <botId>`; keep the bot halted, run report-only reconciliation, inspect
balances/orders/fills, every exact sanitized cancellation, each filtered residual
mismatch and its application metadata, and the proposal SHA-256. Use
`cassie market-make reconcile <botId> --apply` only to confirm and submit that exact
reviewed hash; it authorizes observation rather than immediate inventory mutation. A
snapshot change must refuse and require a fresh report. Keep reviewing reconcile/status
until the evidence gates clear. Do not blindly repeat an exit when the bounded price or
available liquidity prevented it.

Manual `cassie trade` is disabled for a market-make bot because it would bypass durable
cash and inventory reservations. Use another bot id for discretionary trading.

### Forecast and exit timing

`latest_q` changes trigger immediate reevaluation. Six hours is review/telemetry only,
not a forced hold or exit. A normal convergence exit begins when remaining Q-market edge
is at most 5pp or 75% of the first-fill gap has been captured. Q flips/fades, warning or
staleness, loss/risk controls, and time limits also exit. The normal ceiling is 24 hours;
one newer same-direction forecast can extend once, provided at least 10pp NO or 20pp YES
edge remains, but total hold time never exceeds 36 hours.

Normal exits begin post-only and progress to bounded FAK attempts. Urgent exits have a
short passive phase, then bounded FAK attempts. Those bounds can intentionally leave
inventory unfilled when liquidity disappears.

Offline replay uses the same reducer:

```sh
cassie market-make replay --input <bundle.json> --fill-model all --output <report.json>
```

Fill models are `queue`, `trade-through`, `touch`, or `all`; `--config` can supply an
alternate complete versioned strategy document.

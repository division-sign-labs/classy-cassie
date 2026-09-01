# Operating the market-make strategy

`market-make` is a deterministic, Polymarket-only, Q-directed passive-inventory
strategy. It is not a symmetric dealer that continuously quotes both outcomes. Cassie
opens inventory only when a published, live Quotient forecast has an eligible edge,
prefers passive maker orders, and sells held inventory when the forecast, convergence,
risk, or time policy says to exit.

The strategy does not poll X or external news. Quotient forecast changes drive the
thesis, while live CLOB movement and freshness checks provide shock detection.

## Create a bot and store its passphrase

Run:

```sh
cassie init
```

Choose `polymarket`, then choose `market-make` at the strategy step. The wizard asks for
a new keystore passphrase, asks you to confirm it, and offers to save it for this bot in
macOS Keychain, Windows Credential Manager, or Linux Secret Service. Keep a separate
recovery copy; Cassie cannot recover a lost passphrase.

For an existing bot, this command prompts for the passphrase, verifies it, and saves it
in the native credential store:

```sh
cassie passphrase remember <botId>
```

For non-interactive automation, Cassie also accepts `CASSIE_PASSPHRASE` from the nearest
`.local.env` or the exported environment. Native per-bot storage is preferable because
it does not leave the passphrase in a project file. There is no `ARES_PASSPHRASE`:
`ARES_API_KEY` and `ARES_BUILDER_CODE` are separate optional reporting credentials. A
Splits passkey is likewise separate and remains in the official Splits/browser flow.

## Configure the strategy

View the resolved configuration:

```sh
cassie market-make configure <botId>
```

Change common limits with flags, or replace the whole versioned JSON configuration:

```sh
cassie market-make configure <botId> \
  --max-deployed-usd 350 \
  --max-markets 6 \
  --base-order-usd 12.50 \
  --target-no-usd 40 \
  --min-no-edge-pp 10 \
  --min-depth-1c-usd 1000 \
  --min-depth-2c-usd 2500 \
  --max-order-depth-1c-pct 2 \
  --max-order-depth-2c-pct 0.8 \
  --max-market-depth-1c-pct 4 \
  --max-market-depth-2c-pct 1.6

cassie market-make configure <botId> --config strategy.json
```

The $500 preset is a ratio template. By default Cassie applies those ratios to the
capital actually funded in the bot. The template uses:

- $350 maximum inventory plus pending-entry cost, six active markets, and a $12.50 base
  ticket with a $20 hard per-order cap;
- NO edges from 10–30 percentage points, full sizing, and a $40 market target;
- YES edges from 20–30 percentage points, half sizing, and a $20 market target;
- a 4pp operational selected-token spread ceiling and a 30pp hard sanity ceiling; and
- $100 minimum free collateral plus a $50 operational reserve.

The allocator diversifies category families when eligible candidates exist. V1 is
usually opportunity-constrained rather than bankroll-constrained.

## Liquidity and funded-capital sizing

Every new entry must have executable exit-side bid depth of at least $1,000 within 1¢
and $2,500 within 2¢ of the best bid. Those are floors, not permission to consume the
whole book. A single order is capped at 2% of the 1¢ depth and 0.8% of the 2¢ depth;
total inventory in one market is capped at 4% and 1.6%, respectively. The configured
per-order, per-market, portfolio, and best-level limits can only reduce those amounts.
While an entry rests, refreshed order-band, market-band, best-level, and source-depth
participation are checked again. Cassie cancels the remaining entry when that live depth
no longer supports it.

At the default depth floors, the participation rules allow at most a $20 order and $40
of total market inventory. That fits the $500 preset without pretending a thin book can
support a larger exit.

You do not normally set a bankroll. Fund the bot and run it: on each authoritative venue
snapshot Cassie defines strategy capital as the collateral balance plus open inventory
at average cost, then scales the complete dollar budget from the $500 template. Pending
BUYs are counted once through collateral and separately reserved as exposure. Counting
inventory at cost keeps a purchase from looking like a withdrawal. Deposits and realized
P&L take effect automatically without mark-to-market noise. Decreases apply on the first
authoritative snapshot. Increases require two matching,
clean snapshots by default so a non-atomic balance/position read cannot briefly inflate
risk; an active runtime performs those reconciliations automatically on its normal
15-second cadence. If resting entry orders prevent a clean increase, Cassie pauses and
cancels new BUY adds, continues supervising exits, waits through the five-minute late-fill
window, then applies the larger budget after the repeated clean snapshots. No operator
bankroll update is needed.
In this Cassie live mode, that funded-capital rule supersedes the research artifact's
legacy `auto_compound: false` field. Use a ceiling—or explicit fixed mode—when gains
should not raise the sizing base.
The source rule that rewards may not increase order size still prevents expected or
unpaid rewards from affecting a quote. Once a reward is actually paid into collateral,
live mode treats it as realized cash on later sizing snapshots; a ceiling or fixed mode
also prevents that growth.

Do not withdraw from this account while it has positions or working orders. Venue
snapshots do not label external transfers, so a withdrawal is conservatively seen as a
drawdown and can start mandatory exits. First get the market-maker flat, halt it, and keep
the controller running. After the last order becomes terminal, let the five-minute
late-fill overlap elapse and apply a fresh reconciliation. `cassie withdraw` refuses
unless that live status proves the bot is current, settlement-quiescent, `HALTED`, and
completely flat. After the transfer, reconcile and review status again, then always resume with
`--acknowledge-loss-reset` so the intentional cash flow is removed from rolling-loss and
drawdown history even when it was too small to latch the stop. That reset is refused
while a current marked market loss still breaches its limit.

To keep automatic sizing below a hard ceiling:

```sh
cassie market-make configure <botId> --bankroll-ceiling-usd 10000
```

Use `--bankroll-ceiling-usd unlimited` to remove the ceiling. The older
`--bankroll-usd 10000` form remains available as an explicit fixed-bankroll mode for
operators who want literal limits instead of funded-capital sizing.

Automatic sizing scales the dollar caps coherently; it does not scale
the number of markets, edge thresholds, participation fractions, or absolute depth
floors. At $10,000, the hard per-order cap is $400, but the scaled normal base requests are
$250 for NO and $125 for YES because YES is half size. Bankroll scaling alone therefore
does not request $400. A custom $400 NO request—for example, one produced by a
`--base-order-usd` override—still needs at least $20,000 within 1¢ and $50,000 within 2¢
before the participation gates allow it. YES remains half the configured base unless its
direction configuration changes. The minimum depth floors remain $1,000/$2,500.

Offline replay has no venue account to observe, so a live-mode replay uses the
configuration's reference bankroll. Pass an explicitly fixed strategy JSON when testing
a different historical bankroll. Every new replay report records that bankroll basis and
the exact resolved configuration hash.

All four participation percentages are configurable with the `--max-order-depth-*`
and `--max-market-depth-*` flags shown above. They are percentages (`2` means 2%), not
decimal fractions.

## Run, inspect, and activate

A first local run and every newly deployed market-maker start halted. Startup performs
preflight checks but does not apply or authorize venue reconciliation. Generate a
report-only proposal before any activation:

```sh
cassie run <botId>                            # local runtime; leave this running
cassie market-make reconcile <botId>          # exact report only; no venue writes
# Review exact sanitized cancellations and each residual mismatch/reason, plus the SHA-256.
cassie market-make reconcile <botId> --apply  # confirm and submit that exact proposal hash
cassie market-make dry-run <botId>
cassie market-make status <botId>
# If still HALTED, repeat report-only reconcile/status review before resuming.
cassie market-make resume <botId>
```

For a droplet, replace the first command with `cassie deploy <botId>`. The final deploy
message reports `HALTED` and no venue reconciliation has been applied. The report lists
the exact sanitized unknown/external orders proposed for cancellation. Its
`residualInventory[]` excludes healthy inventory and contains only actual mismatches,
with one of these `reason` values: `unmanaged`, `missing-durable-cycle`,
`identity-conflict`, `quantity-mismatch`, or `venue-position-absent`. Every row reports
`application: 'observe-and-authorize-repeated-reconciliation'`, and the adjacent
`inventoryApplication` object reports the mode, configured minimum matching snapshots,
and late-fill warning. The whole proposal is bound to a SHA-256.

`--apply` asks for confirmation and submits only that hash. It authorizes the exact
cancellations and repeated observation of the residual mismatches; it does not itself
adopt or correct all residual inventory. Inventory mutation occurs only after the
configured repeated-authoritative-snapshot count and late-fill gates pass. If balances,
positions, orders, or fills change before commit, apply refuses without applying a
replacement proposal; generate and review a fresh report and hash.

After a successful apply, `dry-run` reads live Q, Gamma, and CLOB state and proposes
actions without placing orders or changing trading state. Metered API spend is still
recorded. Check `status` (or `status --json`). Apply can leave the lifecycle halted while
inventory evidence accumulates; use a subsequent report-only reconcile and status review
until the residual mismatch is either safely adopted/corrected or otherwise clean. Only
then explicitly `resume`. Once the current deployment/config identity is authorized and
active, ordinary ticks may auto-reconcile. A new deployment or configuration identity
starts halted and requires a fresh report, review, and authorization.

Changing a saved configuration does not hot-reload a process. Redeploy a remote bot, or
stop and restart `cassie run <botId>` locally, then reconcile and resume the new
configuration explicitly. Until that restart, the old runtime and its old risk bounds
remain in force. Plain `halt` remains available, but `halt --liquidate` refuses config
drift so its confirmation cannot describe different bounds from the runtime executing it.

Operational controls are:

```sh
cassie market-make halt <botId>
cassie market-make halt <botId> --liquidate
cassie market-make resume <botId> --acknowledge-loss-reset
cassie market-make reconcile <botId> [--apply]
```

Plain `halt` cancels additions and resting orders while mandatory exits continue.
`--liquidate` requests bounded urgent exits; it does not authorize an unlimited market
sale. A loss stop stays latched until its status is reviewed and the reset is explicitly
acknowledged.

Ordinary `cassie trade` is disabled for a `market-make` bot because a manual order would
bypass its durable inventory reservations. Use a separate bot id for discretionary
trades.

## Holding and exit policy

Cassie reevaluates immediately when `latest_q` changes. Six hours is review and
telemetry only, not an instruction to sell. A normal convergence exit begins when the
remaining live Q-to-market edge is at most 5pp or when 75% of the first-fill gap has
been captured.

It also exits when Q flips or fades, Q becomes stale, forecast/risk/loss controls fire,
or the hold reaches its time ceiling. Twenty-four hours is the normal ceiling. One
newer, same-direction forecast may extend a position once when sufficient edge remains
(10pp for NO or 20pp for YES), but never beyond 36 hours total.

Normal exits begin passively and progress to bounded FAK attempts. Urgent exits use a
short passive phase followed by bounded FAK attempts. Bounds can leave inventory
unfilled when the book disappears; they are deliberate protection against selling at
an arbitrary price.

## Residual inventory and `EXIT_BLOCKED`

After the current deployment/config identity is explicitly authorized, reconciliation
may observe a real residual mismatch and halt additions. Authorization alone does not
mutate inventory: the controller adopts or corrects it only after the configured number
of matching authoritative snapshots and its late-fill gates pass, then manages any
adopted residual conservatively. A first run or new deployment never adopts it implicitly
at startup. If status reports `EXIT_BLOCKED`, do not repeatedly resume or liquidate
blindly:

1. Read `cassie status <botId>`, `cassie market-make status <botId> --json`, and
   `cassie logs <botId>` before retrying.
2. Run `cassie market-make halt <botId>` to keep additions disabled, then run
   `cassie market-make reconcile <botId>` in report-only mode.
3. Verify the reported Polymarket balances, open orders, fills, every exact sanitized
   proposed cancellation, and every filtered `residualInventory[]` mismatch with its
   `reason`, `application`, `inventoryApplication`, and proposal SHA-256. Use
   `reconcile --apply` only to confirm and submit that exact reviewed hash. This authorizes
   observation, not immediate residual adoption. If the venue snapshot has changed, apply
   refuses; generate and review a fresh proposal.
4. Keep the bot halted while exposure or an inventory mismatch remains. When usable
   liquidity returns, `halt --liquidate` may request another bounded exit. A subsequent
   reconcile/status review may be required while repeated-snapshot or late-fill gates are
   pending. Resume only after reconciliation is clean and the runtime accepts the current
   deployment and configuration activation.

If a safe exit cannot fit the configured bounds, waiting for liquidity or deliberately
reviewing a complete replacement config is safer than bypassing the controller.

## Replay and prompt-driven Cassie

Replay a normalized event bundle without a bot or live orders:

```sh
cassie market-make replay \
  --input replay-bundle.json \
  --fill-model all \
  --output replay-report.json
```

`--fill-model` accepts `queue`, `trade-through`, `touch`, or `all`; `--config` can supply
an alternate complete strategy JSON.

The prompt-driven monitoring feature is the separate `agent` strategy. Create an
`agent` bot with `cassie init`, then view or change its mandate with:

```sh
cassie agent prompt <botId> --set "monitor these markets and implement this mandate"
```

In v1, the agent is not an overlay on `market-make`; one bot has one strategy. Use a
separate bot id if you want prompt-driven monitoring alongside this deterministic
market-maker.

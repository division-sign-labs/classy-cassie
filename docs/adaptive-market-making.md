# Q-adaptive liquidity

Decision: September 4, 2026 (Pacific). This is an experimental, deterministic policy for
`poly-mm-v01`, authorized by Jordan for live deployment. The deployment record below is
updated after verification.

## Conclusion

Use Quotient to select markets and control the direction and aggressiveness of passive
quotes. Use executable Polymarket books to set prices. Do not continuously blend Q into
the market midpoint or assume that a large Q disagreement is a calibrated volatility
forecast.

The original passive Q-accumulation strategy overlaps the directional bot. A Q-blind
two-sided maker discards our differentiated information. This implementation allows
both-sided spread collection where Q is compatible with it, withdraws quotes that
oppose a confirmed Q-aligned move, and manages the resulting inventory explicitly.
The objective is net return after execution costs and inventory losses, not trade count.
This is my preferred live experiment from the available evidence, not a demonstrated
profit-maximizing strategy.

The [chronological calibration](../research/mm-strategy-review/adaptive-calibration.md)
contains 992 new forecast publications. Adding absolute Q disagreement to movement
features improved held-out one-hour absolute-movement prediction error by about 1.9%.
It did not improve six-hour or 24-hour prediction. The sample covers only five days,
does not model our queue position or fills, and does not establish profitable market
making. Earlier work also found that a continuous Q/market probability blend could
worsen forecast accuracy. See the [research memo](../research/mm-strategy-review/DECISION_MEMO.md).

## Policy

| State | Conditions | Quotes |
| --- | --- | --- |
| Balanced | Usable Q, small disagreement, current books | Existing inventory-aware bid and ask, using equal-share economic exposure when capacity allows |
| Defensive | Larger disagreement, aging Q, or caution status | Retreat by at most one additional tick and reduce requested size modestly; keep genuine inventory-reducing sells competitive |
| Directional | Q disagrees by 10–30 percentage points, is within 24 hours, and the market has moved at least one tick toward Q over at least 30 seconds in the last five minutes | Keep the Q-favored economic lane at the existing capped price and size; withhold its opposite |
| Q-supported holding | Unmatched inventory with a qualifying Q edge, before its original holding deadline | Withhold the surplus's SELL and the opposite-outcome BUY; paired inventory can still recycle |
| Reduce-only | Convergence, Q invalidation, 24-hour holding ceiling, missing/expired/invalid/warning Q, or loss controls | Sell only the surplus YES or NO shares. Do not break a balanced complete set and call it risk reduction |

An economic bid is BUY YES or SELL NO; an economic ask is SELL YES or BUY NO.
This means the bot can buy both outcomes, quote a buy and a sell in one outcome, or
sell inventory in both outcomes. Its current inventory determines the route. It cannot
promise equal fills, and a partial pair remains directional exposure.

Directional confirmation is an unvalidated operating hypothesis. It avoids treating
every large Q gap as an immediate reason to accumulate, but can still buy into a move
that reverses. No fitted optimizer claims that its thresholds or position sizes are optimal.

## Data and sizing

- Published Q signals and the first 100 liquid Gamma catalog markets both contribute to
  discovery. Exact venue identity must match before a signal can seed a forecast.
  Up to five signal markets outside the Gamma page are resolved per discovery pass.
- Q refresh runs on a 15-minute cadence. Daily forecasts retain full weight for 24 hours,
  fade thereafter, and expire after 36 hours. There is no six-hour entry expiry.
- Exact lookups are batched by ten market identifiers. Held and working-order markets
  have priority. Live cycles attempt one due batch; remaining candidates rotate through
  later cycles. Last-good forecasts survive request failures without changing their
  original publication time. Calls have a four-second timeout and retry backoff.
- Executable books must be current, correctly identified, uncrossed, and coherent across
  YES and NO. The same policy is checked immediately before submission. Newly unsafe
  resting prices are canceled without waiting for the ordinary minimum resting time.
- Existing bankroll, order, market, event, liquidity and loss caps remain binding. The
  deployment preserves the existing $30 reference base ticket and $30 reference order
  ceiling. Live-funded scaling can change effective dollars. A 20-point Q gap normally
  trims a defensive request by 10%; directional favored quotes retain baseline sizing.
- Q receives market identifiers, not balances, position sizes or P/L. There is no Quotient
  API budget or spending stop. Quotient is the operator's own API: its cost to this bot is
  $0. List-price usage metering is not an expense and must not be deducted from P/L.

## Inventory and execution limits

The existing durable controller, pinned venue client, cash reservations, fill handling,
heartbeat and loss stops execute the policy. No external database, package-version bump,
new signing implementation or discretionary order path is introduced.

The inherited one-hour cutoff is removed for the adaptive strategy. Q-backed unmatched
inventory is held while its thesis remains useful, not continuously offered at the spread.
A holding qualifies with at least 10 percentage points of Q edge at entry or against the
current executable held-outcome bid. Once qualified, it remains Q-backed through that
inventory cycle. Exit starts when any of these conditions occurs:

- Remaining Q edge over the executable bid falls to 5 points or less, including a reversal.
- At least 75% of the recorded initial entry gap has closed.
- Q becomes unusable or warns against the position, or existing loss/operator controls require reduction.
- The holding reaches 24 hours from its original entry. A fresh daily Q does not extend that clock.

The Q status label `converged` alone is not evidence that the venue price reached Q; the
executable price gap determines convergence here. Small-gap spread inventory keeps ordinary
recycling, so not every position is intended to last 24 hours. Hard risk exits still apply.
The original research supports testing convergence/Q-driven exits with a 24-hour ceiling,
not an optimal exit exactly at 24 hours or a promise that longer holds will be profitable.

Exits remain bounded, post-only SELLs. The ceiling starts reduction; it does not guarantee
a fill or immediate liquidation, and no new fill-and-kill path is added. Exit prices can
be below acquisition cost. A thesis exit stays latched until that inventory cycle is flat.
Transient book or forecast-fetch problems do not manufacture a permanent thesis change;
usable last-good Q remains available during refresh failures.

New BUY receipts retain the entry forecast, and confirmed fills establish the first-held
time and initial gap. Top-ups, restart and reviewed reconciliation do not reset that clock.
Imported holdings can use current Q without inventing a historical entry gap; the 75%
test applies only when an entry gap is known. A legacy clock reset can be repaired from a
single durable BUY and its SELLs when they fully explain the current quantity. Its first
confirmed fill is preferred; the older order-creation time is a conservative fallback.

With usable Q, complete YES/NO sets can be offered through ordinary independent passive
sells. Those sells are not atomic: one fill can leave temporary directional exposure.
With unavailable Q or hard reduce-only controls, neutral sets are held. This version
does not autonomously merge complete sets; capital can remain tied up until Q recovers,
inventory can be recycled, or settlement occurs. Existing settlement permissions are unchanged.

Only the last-good forecast, retry state and compact inventory-thesis evidence join the
existing SQLite checkpoint. A bounded five-minute price history lives in memory. No raw order-book,
trade-stream or forecast-history database is added. Durable orders, fills and inventory
remain necessary for restart-safe execution.

## Configuration and operations

The strategy identity is `quotient-adaptive-liquidity-v1`, with schema
`polymarket-adaptive-mm/1`. `cassie market-make configure <botId> --adaptive` selects it
while preserving saved capital limits. `--two-sided` explicitly restores the ordinary
two-sided policy. Neither command updates a running process by itself.

For adaptive holdings, the existing `exit_policy` fields supply the 5-point remaining
edge, 75% gap capture, 10-point qualification and 24-hour ceiling. `--max-hold-hours`
updates that ceiling and the compatibility `two_sided.maximum_inventory_age_seconds`
field together. Adaptive configuration disables automatic forecast-based extensions;
the ordinary two-sided strategy's default one-hour inventory limit is unchanged.

Deploy from this checkout with `--from-workspace`; publishing or updating an npm library
is not required. A new deployment starts halted for account reconciliation. Review the
exact reconciliation proposal, apply it, inspect a live dry run, and resume once clean.
An orderly restart of the same authorized configuration retains its activation intent.
No loss latch is reset as part of a strategy upgrade.

The user authorized this deployment and activation, so the operator agent performs these
steps; Jordan does not need to issue a separate unhalt command.

### Account polling and recovery

Routine account checks run every 60 seconds, independently of the five-second book-age
limit. Fill/order stream notifications trigger authenticated order, fill and token-balance
reconciliation sooner, using a minute-cached public positions index. Explicit startup,
reconciliation, resume and dry-run checks request fresh positions. Cached index rows are
copied before authenticated quantities are merged; a recently sold token cannot reappear
as inventory from the cached index.

Temporary venue read failures, including the pinned SDK's `RateLimitError`, enter a
recoverable pause. Retries wait 60, 120, 240, then at most 300 seconds between attempts;
a longer server `Retry-After` takes precedence. The compact retry checkpoint survives
restart, and stream wakes cannot bypass the cooldown. No new orders are submitted during
the pause. Existing quotes receive an emergency cancellation attempt, and heartbeats stop
renewing potentially stale quotes. Cancellation receipts and risk reservations remain
until venue reconciliation confirms their outcome.

Previously authorized trading resumes automatically after orders, fills, cash and token
balances reconcile. Operator halts, loss stops, invalid credentials, unknown submissions
and unresolved redemptions do not gain automatic-resume authority. An ambiguous order
submission is not blindly posted again. The process remains running during transient
outages; its holdings still carry market risk while execution is unavailable.

## Next evaluation

Evaluate realized cash flows and marked inventory together, including actual fees. Compare
the Q-conditioned policy with the ordinary maker under comparable market conditions.
Separate completed spread cycles from unmatched-inventory losses; report time and capital
tied up, fill rate, adverse price movement after fills, and the contribution of each policy
state. Rewards count only when actually received. A profitable fill is not evidence that
Q caused the profit, and a high trade count is not a success metric.

The highest-value later changes are an empirical fill/adverse-selection model and a
reviewed complete-set recycling mechanism, if the live economics justify them. They are
not prerequisites silently delegated to a new database or service.

## Deployment record

The final local build, all 1,257 tests across 103 files, and all workspace typechecks
passed. The submission tests cover slow signing, forecast expiry during preparation,
and a slow durable write; known pre-submission aborts release their reservation and do
not require an unhalt.

Prior configuration hash:
`b6a23c2054c084ff527a2f61f8ca0163c2e88ba399bfd51daddacb612aac290c`.
New configuration hash:
`a3985863e83d4335be44dffd980d629539444e0d896660394e535e93eec1c325`.
Workspace build:
`0eb333587891d7e52ea90153e3ec071b999c4541a3ce59ebf4f2d4baf4eea21e`.

The pre-upgrade account had approximately $532.28 marked equity, $531.50 collateral,
four resting orders, and four residual YES shares in the October Russia/Ukraine market.
Historical controller realized P/L was −$0.79 and no loss stop was latched. These are
the old strategy's results, not adaptive-strategy performance.

Deployment installed on droplet `596789914`, `168.144.115.167`, in `blr1`, retaining
the same wallet and state database. Runtime venue checks confirmed order placement
permitted from its reported IN location. The Q credential check returned 68 published
rows. Local and runtime configuration hashes matched.

Reviewed reconciliation proposal:
`94f760f2a7849ff602e1f917e18aa3d704d5bf5c2c0c990a85092d63588fa086`.
It contained zero venue/unknown orders and the existing four YES shares. Applied that
exact proposal, waited for pending cancellation receipts to clear, and verified zero
unknown/cancel-pending orders without resetting historical losses.

The post-reconciliation preview proposed six bounded passive BUYs across these markets:

| Market | Q YES | Forecast age at preview | Initial state |
| --- | --- | --- | --- |
| Russia/Ukraine ceasefire by October 31 | 28.14% | 6.3h | Defensive |
| WTI reaches $100 in September | 25.64% | 8.4h | Defensive |
| SPD wins 7–9% of valid second votes | 66.06% | 0.83h | Defensive |

Each market had both a YES and a NO quote. These are preview observations, not promised
fills; books and Q can change the selected markets and final terms. Effective limits
at activation were $372.81 total deployed exposure and $31.96 per order, from the
existing live-funded scaling of the $350/$30 reference limits.

Live quoting activated September 4 at approximately 23:59 Pacific (September 5,
06:59 UTC). Independent verification at September 5, 07:00:30 UTC confirmed:

- Controller `ACTIVE`, `started: true`, activation current, runtime not paused.
- Systemd service active/running, zero restarts; process started at 06:55:17 UTC.
- The deployed build and local/runtime strategy hashes match the identities above.
- Six orders confirmed open by the venue across the three selected markets; no fills
  reported on those orders yet. They remained open across subsequent account checks.
- Zero unknown orders, zero pending cancellations and no latched loss stop.
- $126.74 reserved for BUY orders and $404.77 free collateral. The four legacy YES
  shares remain accounted for separately.

Initial venue-confirmed orders:

| Market | Shares per outcome | YES BUY | NO BUY |
| --- | --- | --- | --- |
| Russia/Ukraine October ceasefire | 38.11 | $0.16 | $0.79 |
| WTI $100 in September | 45.61 | $0.30 | $0.67 |
| SPD 7–9% vote share | 48.22 | $0.55 | $0.41 |

These are resting limit orders, not completed pairs or realized profits. The runtime
continues automatically; no further unhalt command is required from Jordan.

Handover note: the old runtime's first shutdown saw one order still present immediately
after cancellation and retained that failed result. Subsequent authoritative reads
confirmed zero venue orders. The operator verified `started: false`, zero unknown
submissions and zero venue orders again before stopping the quiesced systemd service.
The account ledger and existing SQLite database were retained. This was a cached
shutdown-error recovery, not permission to ignore unresolved orders.

### September 5 reliability deployment

Build `3b23db7546723a0f6084df109fe8826b6742adeaa8bdbd29e880fde944fcd205`
was deployed to the same droplet and activated at approximately 19:13 UTC. The configuration
hash remains `a3985863e83d4335be44dffd980d629539444e0d896660394e535e93eec1c325`;
the $30 reference ticket, entry policy, one-hour inventory setting and loss limits were
not changed. The existing ledger was retained with a local recovery snapshot. No loss
reset was requested.

Reviewed and applied proposal
`52a0641f59b0235eff4d3f64ac31559f9995c8988b5010e7ade7fefb0407161c`:
zero open/unknown orders, $505.638517 collateral, and 45.415456 SPD YES shares at $0.55
average cost. A live dry run preceded activation. The runtime reports a one-minute loop
and `accountPollSeconds: 60`. Five initial orders were independently confirmed at the
venue, including the existing SPD inventory's SELL at $0.46. A subsequent WTI $95 YES
BUY filled 8.61 shares at $0.63; confirmed receipts, token holdings and collateral reconciled
while the controller remained `ACTIVE`. Resting-order counts change during normal quoting.

All 1,378 tests across 110 files and workspace typechecks passed. Regression coverage
includes SDK rate-limit classification, exponential/server-directed waits, stream-wake
suppression during cooldown, late fills, restart persistence, minute-paced routine reads,
read-only previews, and preservation of operator/loss/unknown-submission halts. No failure
was deliberately injected into the funded runtime.

### September 5 holding-policy correction

All 1,395 tests across 110 files and workspace typechecks passed. New coverage verifies
Q-supported holds at one, six and 23 hours; executable convergence and gap capture;
symmetric YES/NO handling; bounded reduction at 24 hours; partial fills and top-ups;
entry evidence and exit decisions in previews; restart/reconciliation clock preservation;
and conservative recovery of legacy clocks from durable order receipts.

Configuration changed from
`a3985863e83d4335be44dffd980d629539444e0d896660394e535e93eec1c325` to
`ad49bca49ee2958b66b42f52ba4283607636eac4555f294773925094d99fb195`.
The only saved setting changes are the compatibility inventory age from 3,600 to
86,400 seconds and disabling automatic forecast-based holding extensions. Existing
entry selection, reference tickets, portfolio caps, loss limits and minute polling
remain unchanged.

Workspace build:
`de83a7abfbb2b5b946b074a1719c79aecd7b12fa870896a37cf8d345579dd343`.
Deployment reused the installed dependencies, passed its smoke check and canceled
the previous runtime's resting orders before replacement. The existing wallet and
SQLite trading ledger were retained, with a local recovery snapshot.

Reviewed and applied proposal
`3905bdd692240d42f65cb8ff7ece4666f8e136227e9c368ee95040307c25a237`:
zero venue/unknown orders, $508.160616 collateral, and existing YES inventory of
38.87 October-ceasefire shares, 20.32 WTI-$100 shares and 12.082124 SPD shares.
The old build sold 33.333332 SPD shares at approximately $0.45 at 22:10:56 UTC,
before replacement; that fill belongs to the prior policy, not this correction.

The initial post-deployment account read encountered a real venue rate limit. The
runtime stayed running and recorded a 60-second retry delay. A subsequent account
read succeeded; the exact snapshot was reviewed and applied without a loss reset.
After an orderless live preview and clearance of old cancellation receipts, the
new deployment was activated at approximately 22:18 UTC.

At activation, the controller reported `ACTIVE`, current authorization, no unknown
orders, no pending cancellations and no loss latch. Ceasefire and SPD surplus were
explicitly `adaptive-inventory-q-supported`, with no surplus SELL reservation. WTI
remained ordinary small-gap spread inventory. The SPD holding clock was recovered
to September 5 at 08:53:47 UTC from its sole accounted BUY receipt; the other two
holdings retained their existing first-held times. None restarted at deployment.

Independent verification at 22:19 UTC confirmed four open venue orders: ceasefire
YES BUY 185.46 at $0.13; SPD YES BUY 51.64 at $0.42; WTI YES BUY 102.17 at $0.29
and SELL 20.32 at $0.31. There were no SPD/ceasefire SELLs. Service state was
active/running with zero restarts, controller `ACTIVE`, routine account checks at
60 seconds, and no active venue cooldown. These are resting orders, not filled trades.
The operator completed reconciliation and activation; Jordan needs no separate command.

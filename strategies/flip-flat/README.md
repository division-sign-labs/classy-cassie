# @quotient-forecasting/strategy-flip-flat

The `signals` strategy for [cassie](https://www.npmjs.com/package/@quotient-forecasting/cassie).
It follows published [Quotient](https://dev.quotient.social) forecasts. On prediction
markets, it enters where a forecast diverges from the market price, then exits once the
market prices the forecast in, or at the default seven-day maximum hold.

The strategy has no position-count cap by default and ranks competing signals widest edge
first. An optional numeric cap remains available. The default eligible forecast entry edge
is 10–30 percentage points, inclusive. The maximum is configurable; `unlimited` removes it.
This edge is the gap between the Q forecast and the market reference price, not the quoted
bid/ask spread.

The default prediction-market allocator targets quarter Kelly using current portfolio
equity, subject to a 2.5% cap per market and a 5% cap across markets in the same parent
event. A market that resolves within three days of the entry gets a target 25% smaller
(`nearResolutionDays`, `nearResolutionSizeCutPct`); the same cut applies to a legacy
daily-budget entry. Same-side repeat signals can top up only the gap between existing
exposure and the new target, so a reduced position is not topped back up to full size.
Added capital changes future targets automatically. If an existing position is already
above its target or cap, the allocator blocks further additions but does not auto-trim it.

Before a portfolio-mode entry or top-up, the strategy requires at least $2,500 of
held-outcome bid notional within 2¢ of the best bid. This is an entry-only ability-to-exit
check; set `--min-exit-depth-2c-usd 0` to disable it. The engine separately sizes the buy
against live ask depth and slippage.

The legacy `daily-budget` mode remains available. It caps cumulative entry notional from
00:00 to 23:59 UTC; rejected entries do not consume it, and an entry capped by liquidity
or risk consumes only what it actually placed. The UTC reset replenishes entry capacity
without closing anything.

Exits are position-driven, not signal-driven, and the venue book is checked every minute.
By default a position is sold once the held outcome's executable best bid reaches 90¢
(`takeProfitPrice`; `null` disables it). The forecast plays no part in that exit: above
90¢ a position risks the whole stake for a few more cents, and replayed against published
signals, holding past the floor lost about 7% on average versus selling there. Otherwise
the default maximum hold is seven days. There is no forecast-convergence exit: replayed,
selling once the market got within a few points of Q sold winners before the take-profit
could and lowered the average return. A stale or unpublished entry signal cannot suppress
either exit. Neither the entry volume floor nor the minimum-notional floor ever blocks a
sell; executable slippage and depth still apply.

## Seven-day signal-exit state machine (opt-in)

`scenarioExitEnabled: true` wraps the take-profit above in a confirmed state machine
that also reads the latest Q forecast for every held market on the five-minute forecast
cadence. Everything is measured on the contract actually held: for a NO position,
Q, the midpoint, and the executable bid are all mirrored. The immutable entry Q is the
published signal's held-side probability captured when the entry is accepted; it never
changes, however the linked forecast later moves. The current Q is the newest distinct
committed forecast available at evaluation time, identified by its committed timestamp.
Two engine ticks over the same forecast are one observation, never two confirmations.

Exits are evaluated in this order and exactly one reason is emitted:

1. `market_resolved` — redeem.
2. `q_collapse` — held-side Q retreated at least 30pp from entry and remaining edge is at
   or below 0pp. Immediate, regardless of P&L.
3. `adverse_cross` — remaining edge at or below 0pp, executable P&L at or below 0%, and two
   distinct committed forecasts observed with the spread non-positive. A new forecast that
   restores positive edge resets the run.
4. `q_flip` — two consecutive distinct committed forecasts below 50% on the held side
   confirm the flip; exit once remaining edge is at or below 5pp. The confirmation is
   retained while Q stays flipped, so a later market move can still trigger it. A forecast
   back above 50% resets it.
5. `take_profit` — the held outcome's executable best bid is at or above
   `takeProfitPrice` (90¢), whatever edge the forecast still shows.
6. `time_stop` — position age at or above `maxHoldDays` (7) measured from the actual entry
   fill, regardless of P&L.

Executable P&L walks the held-side bids for the full position and deducts `exitFeeBps`.
Each trigger logs entry Q, current Q, midpoint, executable bid, remaining edge, Q retreat,
executable P&L, both confirmation counters, position age, the selected reason, and the
forecast versions that provided the confirmations. The same telemetry rides on the exit
order as provenance. A submitted exit is remembered per position, so repeated evaluation
cannot create duplicate sells; a still-held position resubmits only after `exitRetrySec`
with no visible order.

Positions that predate the record are seeded from the active same-side signal when one
exists; without an entry Q, the collapse branch stays off for that position while the
adverse-cross, flip, take-profit, and time stop still apply.

```sh
cassie strategy <botId> --scenario-exit on
cassie strategy <botId> --take-profit-price 0.9 --adverse-cross-confirmations 2 \
  --q-collapse-pp 30 --flip-confirmations 2 --flip-exit-max-remaining-edge-pp 5 --max-hold-days 7
```

## Hold-to-resolution preset

`cassie strategy <botId> --preset hold` (or `signals-hold` in `cassie init`) sets the
same strategy to: one fixed-dollar lot per market (`allocationMode: fixed-notional`,
`lotNotionalUsd`, no top-ups, no daily reset), entered on the first signal seen with at
least 15pp of edge and no ceiling (`entrySpreadPp: 15`, `maxEntrySpreadPp: null`) and at
most 60 days to resolution (`maxWindowDays: 60`); sold only after two consecutive
committed forecasts put Q on the other side of 50%, at any remaining edge
(`flipConfirmations: 2`, `flipExitMaxRemainingEdgePp: null`); otherwise held to the
payout (`takeProfitPrice: null`, `maxHoldDays: null`, `qCollapsePp: null`,
`adverseCrossConfirmations: null`). A market that resolves within the near-resolution
window is not sized down (`nearResolutionDays: null`).

Replayed on every published Polymarket signal from 2026-06-29 to 2026-09-16 (1,048
signals, 222 markets; `q-trade-analysis/signal-daily-hold-report.md`): +19.6% per lot
with open lots marked (95% range +4.3 to +36.0), +17.7% on the last three weeks alone,
about 1.3 lots a day, a lot held 8 days at the median. The literal rule, every signal a
lot and a one-forecast flip, made +1.5% per lot because repeat signals piled into a few
markets; the three changes above are the ones that held in both halves of the tape. The
90c take-profit and the 7-day cap lower the mean on this book, so the preset turns them
off; the 15pp floor is where the marginal lot stops losing money, and above 20pp the book
gets too thin to trade daily.

```sh
cassie strategy <botId> --preset hold
cassie strategy <botId> --lot-notional 25          # stake per market
cassie strategy <botId> --max-window-days 30       # tighter window; off disables
cassie strategy <botId> --flip-exit-max-remaining-edge-pp off --q-collapse-pp off --adverse-cross-confirmations off
```

## Pending-entry reservation and order provenance

An accepted entry is reserved durably by order id with its market, parent event, and
notional. Polymarket can show an immediate fill in neither positions nor open orders for a
few ticks; the reservation keeps counting against the market and event caps and blocks a
second entry for that market until the venue position absorbs the size, the order rests
visibly, or `pendingEntryReservationSec` (900) passes with nothing absorbed. Only the part
not yet visible through the position or a resting order is counted, so nothing is counted
twice once the venue catches up.

Every order the engine places persists a decision record (`orders:decision:<orderId>`)
with the signal id and timestamp, live edge, target, current market and event exposure,
cap headroom, and the limiting cap, or the full exit telemetry. The explanatory subset is
attached to the order alert.

Tune it through the CLI rather than in code:

```sh
cassie strategy <botId> --allocation-mode portfolio-kelly \
  --kelly-fraction 0.25 --market-cap-pct 2.5 --event-cap-pct 5 \
  --min-exit-depth-2c-usd 2500
cassie strategy <botId> --near-resolution-days 3 --near-resolution-size-cut-pct 25
cassie strategy <botId> --daily-budget 100 --position-budget-pct 25
cassie strategy <botId> --max-entry-edge unlimited
cassie strategy <botId> --scenario-exit on
cassie strategy <botId> --preset hold
```

Every entry still passes the engine's per-order, liquidity, slippage, and volume guardrails.
Cassie does not cap the quoted bid/ask spread.

[Source](https://github.com/Quotient-Solutions-Inc/classy-cassie) ·
[Apache-2.0](https://github.com/Quotient-Solutions-Inc/classy-cassie/blob/main/LICENSE)

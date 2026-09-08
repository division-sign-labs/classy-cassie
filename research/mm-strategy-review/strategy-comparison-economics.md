# Strategy comparison

Read-only review of current checkout and selected public local configuration. No Quotient requests, live orders, deployment changes, or credential access. Dollar examples below are payoff calculations, not order recommendations. The approximately $533 bankroll is the parent task's reference, not a new balance observation.

## Conclusion

The original Q-directed passive-inventory strategy and `ares-trader` have substantial economic overlap: both acquire the Q-favored binary outcome and seek forecast convergence. Adaptive execution already makes the directional bot a passive liquidity provider during entries and normal exits. Faster repricing or post-only orders alone do not create a distinct return source.

A balanced two-sided dealer is economically different. Its completed equal-share YES/NO pair earns the purchase-price discount to the pair's fixed payout, independent of Q. Its difficult risks are asymmetric fills, adverse selection, inventory turnover, and capital recovery. Nothing inspected establishes that the current book-only dealer has positive returns after those costs.

For a Q-alpha mandate, directional inventory is the economically coherent use of the forecast. The existing directional bot already implements that exposure with passive execution. A second Q-directed bot should earn its place through demonstrably different holding-period returns or execution improvement; it should not be described as independent diversification merely because its orders rest longer or its name says market maker.

For an independent spread-income mandate, neither the current book-only maker nor a Q-skewed hybrid has established positive expectancy at this bankroll. The balanced maker provides a genuinely different payoff, but its small gross edge, asymmetric-fill risk and missing autonomous merge path make capital turnover material. The evidence does not justify forcing a hybrid to reconcile the two mandates. Preserve the execution improvements, separate the strategy objectives, and test the maker's fill-conditioned net edge before treating it as an additional return source.

Parent-supplied research update, not independently re-queried here: the published feed has 54 healthy-book markets but only one forecast under six hours old; broader graph coverage has 69 active forecasts under six hours old, 68 outside that feed. A chronological fair-value-blend fit assigned Q weights of .0031 at five minutes and .0094 at one hour; modest blending worsened holdout MAE while slightly improving RMSE. These results do not disprove terminal forecast value. They do weaken the case for making a large short-horizon quote-center adjustment toward Q. Broader graph coverage is a different discovery universe, not proof that three candidates satisfy the original published-signal strategy. Requiring three admissions would change that strategy if only one passes its freshness contract.

## Evidence boundary

Selected local config for `ares-trader`, observed during this review:

- Strategy `signals`; universe `from-signals`; entry edge 10–30 percentage points; no position-count cap.
- Quarter Kelly; 2.5% market cap; 5% parent-event cap; $2,500 exit-side depth within 2¢; $1 entry-notional floor.
- Seven-day maximum hold; scenario exits enabled; signal polling five minutes; engine tick one minute; signal maximum age three hours.
- Saved `takeProfitPrice: 0.9`; no execution override.

Version caveat: current `FlipFlatConfigSchema` removes the saved, now-unrecognized `takeProfitPrice` and defaults `convergenceExitPp` to 3. Parsing the local config with the current built schema confirmed that result. Current engine source selects adaptive execution when the override is absent. The remotely loaded directional implementation was not queried, so the live exit behavior cannot be inferred from the saved 90¢ field alone. Sources: [flip-flat schema](../../strategies/flip-flat/src/index.ts#L23), [scenario exits](../../strategies/flip-flat/src/index.ts#L359), [engine dispatch](../../packages/core/src/engine/engine.ts#L210).

The vendored August 31 strategy is still present, with subsequent amendments recorded in [provenance](../../strategies/market-make/strategy.v1.provenance.json). This comparison uses the current amended implementation, not a claim that it is byte-identical to the initial research artifact.

## Decision and execution overlap

| Dimension | Q-directed passive inventory | Signals with current adaptive source | New two-sided dealer |
|---|---|---|---|
| Discovery | Published Q signals; exact Q refresh for held/resting markets | Published Q signals; held-market Q lookup independent of entry publication | High-volume active Gamma catalog; Q not supplied by service |
| Direction | Q versus live YES midpoint selects one favored outcome | Published signal side, revalidated against live held-side price | Two economic lanes; flat inventory buys complementary YES and NO |
| Price input | Book midpoint plus a bounded Q-driven center shift, volatility width, competitive-price and minimum-edge caps | Post-only entry phases move toward the ask within original/explicit price bounds and required Q edge | Both outcome books plus bounded inventory skew; no forecast input |
| Sizing | Base ticket × directional/volatility multipliers, constrained by liquidity participation and portfolio limits | Quarter-Kelly target, market/event/cash headroom; same-side top-ups only | Paired share quantity, gross/pending cash limits and unpaired exposure limits |
| Exit trigger | Q flip/fade/warning, convergence to ≤5pp remaining edge or 75% gap captured, staleness, risk, time | Current source: Q collapse, confirmed adverse cross/flip, ≤3pp convergence, seven-day deadline; live version caveat above | Held tokens become passive SELL quotes; inventory age blocks further BUYs; no Q convergence thesis |
| Passive execution | Repricing rules for resting adds; normal exits rest up to 15 minutes then bounded FAK; urgent exits use shorter passive phase | Entries up to 120 seconds; normal exits up to 60 seconds then one bounded FAK if still valid; urgent exits immediate bounded execution | Continuous post-only GTC lanes; minimum rest 30 seconds before ordinary repricing; no automatic FAK unwind |
| Intended inventory horizon | Default 24 hours, one qualifying Q renewal, absolute 36-hour ceiling | Up to 7 days, with earlier forecast/scenario exits | Intended short-lived inventory; one-hour age gate does not guarantee sale by one hour |

Decisive source locations:

- Q discovery and held refresh: [legacy controller](../../packages/runtime-node/src/market-make-controller.ts#L3492).
- Q side/gates/pricing: [math](../../strategies/market-make/src/math.ts#L92), [entry pricing](../../strategies/market-make/src/math.ts#L249).
- Q exit timing and execution escalation: [exit policy](../../strategies/market-make/src/exit.ts#L25), [exit order terms](../../strategies/market-make/src/exit.ts#L91).
- Signals Kelly and live-edge sizing: [Kelly formula](../../strategies/flip-flat/src/index.ts#L555), [entry allocation](../../strategies/flip-flat/src/index.ts#L1684).
- Adaptive edge-constrained admission and quote phases: [executor admission](../../packages/core/src/engine/prediction-execution.ts#L290), [quote maintenance](../../packages/core/src/engine/prediction-execution.ts#L421).
- Mode bypass: [service dispatch](../../packages/runtime-node/src/service.ts#L303); new [Gamma discovery](../../packages/runtime-node/src/two-sided-market-make-controller.ts#L676) and [book-only pricing](../../strategies/market-make/src/two-sided.ts#L207).

The current Q-maker's 10–30pp band substantially overlaps the directional bot's 10–30pp band. YES half-sizing, NO priority, tighter eligibility, shorter holding periods, and different exit timing can change realized returns. They do not remove shared forecast/model error or shared event exposure. Account-separated market/event caps also do not enforce combined portfolio caps across bots. At a hypothetical $533 equity, the directional config's market/event caps are $13.325/$26.65; those percentages describe that bot, not the maker's larger configured tickets.

## Payoff and capital

For one binary condition, let `X` be 1 if YES wins and 0 otherwise. A YES token pays `X`; its complementary NO token pays `1−X`. The venue documents that equal YES/NO balances can merge into collateral, with one full pair returning 1 pUSD. Its SDK position-operation examples require Relayer or Builder authority. [Polymarket position management](https://docs.polymarket.com/trading/positions/manage).

For quantities `nY,nN` bought at prices `pY,pN`, terminal profit before costs is:

`nY·X + nN·(1−X) − nY·pY − nN·pN`

Under a Q probability `q`, expected profit is:

`(nY−nN)·q + nN − nY·pY − nN·pN`

Thus forecast sensitivity is `nY−nN`. With equal quantities `n`, expected and terminal profit reduce to `n·(1−pY−pN)`: Q cancels. Example: with Q = .65 and both purchase prices .49, YES has estimated edge +.16 and NO −.14 per share; the equal pair retains only +.02. Equal dollars are not equal quantities except at equal token prices.

This does not mean a two-sided strategy cannot use forecasts. Forecasts can influence quote asymmetry, fill selection and the inventory carried between fills. Research explicitly models directional bets within inventory-constrained market making. It does mean the profit of an already completed equal-share pair cannot also be counted as forecast alpha. [Fodra and Labadie, 2012](https://arxiv.org/abs/1206.4810).

Illustrative 60-share acquisition:

| Quantity | Amount |
|---|---:|
| BUY 60 YES at .49 and 60 NO at .49 | $58.80 cash committed |
| Complete-set terminal/merge value | $60.00 |
| Gross paired profit, before costs | $1.20 |
| Gross return on committed cash for that completed cycle | 2.0408% |
| Three such pairs | $176.40 committed; $3.60 gross profit |
| Share of a $533 bankroll committed | 33.10% |

These are conditional payoff identities, not fill probabilities or daily returns. Buying both legs does not itself credit the $60 collateral value. The present new controller does not merge; it tries passive SELL exits, and resolved holdings have an operator-required recovery boundary. A complete set can therefore remain economically neutral while consuming cash and gross inventory capacity. Selling only one side releases cash but recreates directional exposure.

If both existing bids are .49, immediately selling both acquired tokens at those bids returns $58.80 before fees, not the $60 merge value. Passive sales at better prices may earn more, but require another set of fills. No double-counting of pair discount, token-sale profits, or mark-to-market gains is valid.

## Break-even and fill toxicity

Positive displayed spread is not evidence of positive maker profit. Better-informed traders select which quotes to hit. The foundational adverse-selection model produces a positive bid/ask spread even with zero expected dealer profits. [Glosten and Milgrom, 1985](https://www.sciencedirect.com/science/article/pii/0304405X85900443).

For a maker BUY at `b`, the execution-conditioned markout at horizon `h` is `E[m(t+h)−b | our BUY filled]`; for a SELL at `a`, it is `E[a−m(t+h) | our SELL filled]`. Evaluate those conditional quantities, not an unconditional future price or an assumption that both quotes fill symmetrically. News can fill the now-overpriced bid while the protective opposite leg remains unfilled.

In the 60-share example, a 5¢ adverse move in the only filled leg is a $3 mark loss: 2.5 completed $1.20 paired gains. A small bankroll can quote venue-valid tickets, but has fewer dollars to absorb such asymmetric inventory and less capacity to wait for recycling. Neither more capital nor three eligible markets establishes positive expected value.

Break-even requires realized spread capture plus received rewards to exceed adverse inventory/unwind losses, actual fees, capital-holding costs, and operating costs. Current official fee documentation says makers pay no trading fee; taker fees depend on market parameters. Under its politics rate, a 60-share taker exit at .50 costs $0.60; under its crypto rate it costs $1.05. Those illustrative costs alone consume 50%/87.5% of the $1.20 gross pair edge. Verify the actual market's fee parameters rather than applying a category label blindly. [Polymarket fees](https://docs.polymarket.com/trading/fees).

Rewards are separate from spread profit. Qualification depends on each market's minimum size, maximum spread and competing liquidity; the documented minimum payout is $1. Count earned, received amounts rather than advertised pools. [Liquidity rewards](https://docs.polymarket.com/programs/liquidity-rewards).

Inventory-skew models formalize a trade-off between inventory risk, quote placement and fill intensity. They do not establish profitability of a midpoint heuristic on binary event markets; model assumptions and arrival parameters need calibration. [Avellaneda and Stoikov, 2008](https://math.nyu.edu/inmemoriam/avellaneda/HighFrequencyTrading.pdf). Polymarket's own guide likewise distinguishes the midpoint from a quoting strategy's fair value and treats inventory operations as part of market making. [Venue market-making guide](https://docs.polymarket.com/trading/market-making).

## Discriminating evidence

1. Compare the two Q strategies on the same timestamped candidate universe and Q versions. Measure admitted-market/outcome overlap, simultaneous signed event exposure, daily P&L correlation, and marginal portfolio risk. Use exact public config and loaded deployment versions; resolve the 90¢/3pp exit mismatch first.
2. For actual passive fills, retain an external research sample of arrival/filled prices, confirmed quantities, queue/depth context and signed markouts at 5s, 30s, 5min, 1h, 6h and 24h. Distinguish entry, inventory-reduction and hedge-leg fills. The short horizons diagnose toxicity; the longer ones diagnose Q drift.
3. Report fill probability, partial-fill rate, elapsed time to first fill, time to second complementary fill, inventory age, paired capital locked, and return per committed-dollar-day. Count unfilled quotes and abandoned candidates; successful two-leg completions alone are a selected sample.
4. Decompose net P&L into directional inventory movement, executed spread/complete-set discount, unwind slippage, fees, received rewards, and transfers. Reconcile terminal tokens and cash; avoid counting a paired mark as both cash and inventory profit.
5. Compare Q-only execution, neutral book quoting, and Q-skewed quoting under identical latency, capacity and fill assumptions. Queue-aware or trade-through replay is preferable to assuming every touch fills. Public trades do not reveal every queue ahead, cancellation race or our counterfactual fill.
6. Treat event/day clusters as dependent observations. A few trades in one catalyst cannot establish reliable diversification or positive expectancy. The original research's forecast markouts, if supplied by the parent, should be reweighted to actual eligible/passively filled candidates before attributing them to either bot.

This review establishes strategy overlap and the required economic tests. It does not establish expected returns, a profitable spread width, or a reason to increase live exposure.

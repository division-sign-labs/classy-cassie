# research/kalshi-commodities/performance/compare_entry_bands.py
"""Offline conditional scoring; assumed books are sensitivity cases, not fills."""
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parent
SOURCE = OUT / 'scored_forecasts.csv.gz'
SERIES = {'KXWTI', 'KXWTIW', 'KXGOLDD', 'KXGOLDW', 'KXGOLDMON',
          'KXBTCD', 'KXBTC', 'KXCOPPERD', 'KXCOPPERW', 'KXCOPPERMON',
          'KXSILVERD', 'KXSILVERW', 'KXSILVERMON'}
MODELS = {'raw_q': 'qRaw', 'published_blend': 'qProb', 'market': 'yesOdds'}


def interval(frame, column):
    grouped = frame.groupby('cluster')[column].agg(['sum', 'count'])
    if len(grouped) < 2:
        return [None, None]
    rng = np.random.default_rng(20260905)
    draws = rng.integers(0, len(grouped), size=(3000, len(grouped)))
    means = grouped['sum'].values[draws].sum(1) / grouped['count'].values[draws].sum(1)
    return np.quantile(means, [.025, .975]).tolist()


def summary(frame, **labels):
    if frame.empty:
        return {**labels, 'forecasts': 0, 'markets': 0, 'settlement_clusters': 0}
    scores = {name: float(((frame[column] - frame.outcome)**2).mean())
              for name, column in MODELS.items()}
    delta = frame.assign(delta=(frame.qProb-frame.outcome)**2 - (frame.yesOdds-frame.outcome)**2)
    raw_delta = frame.assign(delta=(frame.qRaw-frame.outcome)**2 - (frame.yesOdds-frame.outcome)**2)
    return {**labels, 'forecasts': len(frame), 'markets': int(frame.marketId.nunique()),
            'settlement_clusters': int(frame.cluster.nunique()), 'brier': scores,
            'blend_minus_market': {'mean': float(delta.delta.mean()), 'cluster_ci95': interval(delta, 'delta')},
            'raw_minus_market': {'mean': float(raw_delta.delta.mean()), 'cluster_ci95': interval(raw_delta, 'delta')},
            'selected_side_win_rate': float(frame.won.mean()),
            'selected_side_mean_market_quote': float(frame.held_quote.mean()),
            'selected_side_mean_blend': float(frame.held_q.mean()),
            'mean_assumed_entry_price': float(frame.entry_price.mean()),
            'gross_payoff_per_contract_at_assumed_price': float((frame.won-frame.entry_price).mean()),
            'mean_quote_gap_pp': float(frame.gap.mean()*100),
            'yes_position_fraction': float(frame.buy_yes.mean())}


def tables(frame):
    modes = {'all_forecasts': frame,
             'first_qualifying_forecast_per_market': frame.sort_values(['createdAt', 'forecastId']).drop_duplicates('marketId')}
    result = {}
    for mode, sample in modes.items():
        records = {'all': summary(sample)}
        for columns in [['asset'], ['odds_band'], ['gap_band'], ['position_vs_favorite'],
                        ['asset', 'odds_band'], ['asset', 'gap_band'], ['asset', 'position_vs_favorite']]:
            records['_by_'.join(columns)] = [summary(group, **dict(zip(columns, keys if isinstance(keys, tuple) else (keys,))))
                for keys, group in sample.groupby(columns, observed=True)]
        result[mode] = records
    return result


def write_report(artifact):
    lines = ['# Entry-band performance', '',
        'Frozen August 8–September 5, 2026 forecast audit. These are matched forecast cohorts, not actual trades. '
        'Lower Brier is better. Selection uses the published blend; raw Q is scored on the same selected observations.', '',
        'The implemented price filter adds 50% shrinkage toward the midpoint to the already published blend, '
        'subtracts 1pp uncertainty, reserves entry and possible-exit fees plus 1¢ per leg, and requires 2pp net edge. '
        'At a 50¢ ask and 2¢ bid/ask spread, its minimum executable published-Q edge is about 17.9pp. '
        'The nominal 5–25pp filter alone does not describe admission.', '',
        'All scenarios enforce current terminal-series and static contract-rule checks and a 2-hour to 14-day fixing horizon. '
        '437 old Copper forecasts fail the current index-candle settlement rules; 72 BTC touch forecasts are excluded. '
        'Historical active status is assumed and the current series-update timestamp check is omitted.', '']

    def table(rows, label):
        lines.extend(['| '+label+' | Forecasts / markets / fixings | Raw Q | Published blend | Market |',
                      '|---|---:|---:|---:|---:|'])
        for r in rows:
            b = r['brier']
            lines.append(f"| {r.get('asset', r.get('odds_band', r.get('position_vs_favorite', 'All')))} | "
                         f"{r['forecasts']} / {r['markets']} / {r['settlement_clusters']} | "
                         f"{b['raw_q']:.4f} | {b['published_blend']:.4f} | {b['market']:.4f} |")
        lines.append('')

    for scenario, title in [('implemented_price_math_2c_spread', 'Implemented price math: assumed 2¢ spread'),
                            ('quote_gap_10_to_25pp', 'Simple 10–25pp quote-gap selector')]:
        modes = artifact['scenarios'][scenario]
        lines.extend(['## '+title, ''])
        table(modes['all_forecasts']['asset'], 'Asset')
        lines.extend(['The counts include repeated forecasts. One first qualifying forecast per market gives:', ''])
        table(modes['first_qualifying_forecast_per_market']['asset'], 'Asset')
        lines.extend(['### Selected-side outcomes', '',
                      'These are equal-weight forecast diagnostics, before actual fees and portfolio sizing. '
                      'A win rate above the assumed entry price implies positive gross one-contract payoff in this cohort; it is not an account return.', '',
                      '| Asset | Win rate | Mean assumed entry | Blend − market Brier, 95% fixing-cluster interval |',
                      '|---|---:|---:|---:|'])
        for r in modes['all_forecasts']['asset']:
            ci = r['blend_minus_market']['cluster_ci95']
            lines.append(f"| {r['asset']} | {r['selected_side_win_rate']:.1%} | {r['mean_assumed_entry_price']:.1%} | "
                         f"{r['blend_minus_market']['mean']:+.4f} [{ci[0]:+.4f}, {ci[1]:+.4f}] |")
        lines.extend(['', '### Entry odds', '', 'Pooled across assets; these rows have different asset mixes.', ''])
        table(modes['all_forecasts']['odds_band'], 'Selected-side entry band')
        lines.extend(['### Favorite agreement', '',
                      'Buying the underdog can mean Q flips the favorite, or Q merely assigns the underdog more probability than the market does. '
                      'The current strategy applies the same thresholds to both.', ''])
        table(modes['all_forecasts']['position_vs_favorite'], 'Position')
    lines.extend(['## Interpretation', '',
        'Oil has the best point estimates under the implemented-price scenarios. The published blend beats market on oil, '
        'and underperforms on the other four assets in the 2¢ scenario. All five paired 95% intervals include zero. '
        'Copper has only four fixing clusters in that scenario. These data do not establish optimized thresholds or realized Sharpe.', '',
        'The simple 10–25pp oil advantage nearly disappears when taking one first qualifying forecast per market, '
        'and silver changes sign under that weighting. Repeated forecasts materially affect the conclusions.', '',
        'The actual strategy also selects only six markets per asset by nearest expiry and then proximity to even odds; '
        'ranks qualifying entries by modeled edge, uncertainty and time; caps one exposure per underlying; and applies depth, '
        'portfolio and execution constraints. Those decisions cannot be reconstructed here.', '',
        '## Limits', ''])
    lines.extend('- '+v for v in artifact['limitations'])
    lines.extend(['', 'The machine-readable artifact contains asset-by-odds, asset-by-gap, asset-by-favorite-agreement, '
                  'first-per-market, and zero/2¢/5¢ spread sensitivity tables: [entry_band_metrics.json](entry_band_metrics.json).', '',
                  'Reproduce with `node research/kalshi-commodities/performance/reconstruct_contract_gates.mjs`, '
                  'then run `compare_entry_bands.py` with the q-trade-analysis Python environment. The Node helper uses the built runtime normalizer.', ''])
    (OUT/'entry_bands.md').write_text('\n'.join(lines))


def main():
    frame = pd.read_csv(SOURCE)
    assert frame.forecastId.is_unique
    assert frame[['qRaw', 'qProb', 'yesOdds', 'outcome']].notna().all().all()
    gate_path = OUT/'static_contract_gates.json'
    gates = json.loads(gate_path.read_text())
    gate_frame = pd.DataFrame(gates['records'])[['forecastId', 'eligible', 'reason', 'takerFeeRate']]
    assert gate_frame.forecastId.is_unique
    frame = frame.merge(gate_frame, on='forecastId', validate='one_to_one', how='left')
    assert frame.eligible.notna().all()
    base = frame[frame.eligible & frame.series.isin(SERIES) & frame.hoursToAnchor.between(2, 336)].copy()
    base['buy_yes'] = base.qProb > base.yesOdds
    base['held_quote'] = np.where(base.buy_yes, base.yesOdds, 1-base.yesOdds)
    base['held_q'] = np.where(base.buy_yes, base.qProb, 1-base.qProb)
    base['won'] = np.where(base.buy_yes, base.outcome, 1-base.outcome)
    favorite_yes = base.yesOdds > .5
    base['position_vs_favorite'] = np.select(
        [base.yesOdds.eq(.5), base.qProb.eq(.5), base.buy_yes.eq(favorite_yes), (base.qProb > .5).ne(favorite_yes)],
        ['market_even', 'Q_even', 'buy_market_favorite', 'buy_underdog_Q_flips_favorite'],
        default='buy_underdog_Q_keeps_market_favorite')
    base['gap_band'] = pd.cut(base.gap, [0, .05, .10, .15, .20, .250000001, 1], right=False,
                              labels=['<5pp', '5-10pp', '10-15pp', '15-20pp', '20-25pp', '>25pp'])
    results = {}
    selected_rows = []
    for name, minimum, spread in [('quote_gap_5_to_25pp', .05, None),
                                  ('quote_gap_10_to_25pp', .10, None),
                                  ('implemented_price_math_zero_spread', .05, 0),
                                  ('implemented_price_math_2c_spread', .05, .02),
                                  ('implemented_price_math_5c_spread', .05, .05)]:
        sample = base.copy()
        sample['entry_price'] = sample.held_quote + (spread or 0)/2
        sample['entry_gap'] = sample.held_q - sample.entry_price
        mask = sample.entry_price.between(.10, .90) & sample.entry_gap.between(minimum-1e-8, .25+1e-8)
        if spread is not None:
            # Exactly the strategy's price-only math with assumed standard coefficient.
            # Actual yesOddsAtCreation is not proven to be an order-book midpoint.
            adjusted = sample.held_quote + .5*(sample.held_q-sample.held_quote)-.01
            rates = sample.takerFeeRate
            assert rates.notna().all()
            fee_reserve = rates*sample.entry_price*(1-sample.entry_price)+.01 + rates*adjusted*(1-adjusted)+.01
            sample['assumed_net_edge'] = adjusted-sample.entry_price-fee_reserve
            mask &= sample.assumed_net_edge.ge(.02-1e-8)
            mask &= (sample.yesOdds-(spread/2)).gt(0) & (sample.yesOdds+(spread/2)).lt(1)
        sample = sample[mask].copy()
        sample['odds_band'] = pd.cut(sample.entry_price, [.10-1e-8, .30, .50, .70, .90+1e-8], right=False,
                                    labels=['10-30c', '30-50c', '50-70c', '70-90c'])
        results[name] = tables(sample)
        selected_rows.append(sample.assign(scenario=name))
    artifact = {
        'source_sha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        'source_rows': len(frame), 'terminal_horizon_rows': len(base),
        'contract_gate_artifact': gate_path.name,
        'contract_gate_sha256': hashlib.sha256(gate_path.read_bytes()).hexdigest(),
        'historical_book_fields_present': frame[['bestAsk', 'bestBid', 'cap2c']].notna().sum().to_dict(),
        'selection_probability': 'published blend, consistently across all three paired Brier columns',
        'limitations': [
            'These are forecast cohorts, not historical trades or an executable strategy backtest.',
            'Selection uses allowed terminal series and 2h–14d to fixing at forecast creation; runtime also checks catalog and venue dates agree.',
            'Quote cohorts use yesOddsAtCreation as entry quote. Assumed-spread cohorts treat it as midpoint without historical book evidence.',
            'Zero spread is a limiting mathematical case; the live bot rejects a locked bid/ask book.',
            'Static contract checks reuse the runtime normalizer and saved market/current-series metadata; historical active status is assumed and series-update gating omitted.',
            'Implemented price-math scenarios use saved current series fees; historical fee schedules are not reconstructed.',
            'No spread/depth/staleness, historical source-version timeline, top-six universe, portfolio reservations, sizing, exits or fills reconstructed.',
            'Win rate and gross payoff are selected forecast diagnostics before actual fees, slippage and portfolio weights.',
            'All-forecast rows repeat markets; first-qualifying-per-market is a sensitivity, not the portfolio policy.',
            'Intervals resample asset/fixing clusters. Small cluster counts and retrospective slicing limit inference.',
            'Stored published probability can include later coherence adjustment; it is not an immutable served snapshot.'
        ],
        'scenarios': results}
    (OUT/'entry_band_metrics.json').write_text(json.dumps(artifact, indent=2, allow_nan=False)+'\n')
    write_report(artifact)
    pd.concat(selected_rows, ignore_index=True).to_csv(OUT/'entry_band_forecasts.csv.gz', index=False)
    for scenario, modes in results.items():
        print(scenario)
        for row in modes['all_forecasts']['asset']:
            print(row['asset'], row['forecasts'], row['markets'], row['settlement_clusters'],
                  {k: round(v, 4) for k,v in row['brier'].items()},
                  'win/quote', round(row['selected_side_win_rate'], 4), round(row['selected_side_mean_market_quote'],4),
                  'CI', [round(x,4) if x is not None else None for x in row['blend_minus_market']['cluster_ci95']])


if __name__ == '__main__':
    main()

# research/mm-strategy-review/volatility-gap-analysis.py
"""Offline test of initial Q disagreement versus subsequent absolute price movement."""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).parent
SOURCE = ROOT / 'graph-oos-refresh/graph-reference-marks.parquet'
ASOF = pd.Timestamp('2026-09-05T05:32:46.258285+00:00')
HORIZONS = [1, 6, 24]
GAP_LABELS = ['0-5pp', '5-10pp', '10-20pp', '20-30pp', '>30pp']


def equal_market_stats(frame: pd.DataFrame, field: str):
    if frame.empty:
        return None
    means = frame.groupby('market_key').agg(value=(field, 'mean'), event=('cluster_key', 'first'))
    center = float(means.value.mean())
    scores = means.assign(residual=means.value-center).groupby('event').residual.sum()
    groups = len(scores)
    se = math.sqrt(groups/(groups-1)*float((scores**2).sum())/len(means)**2) if groups > 1 else None
    return {'mean': center, 'median_market_mean': float(means.value.median()),
            'event_clustered_ci95': [center-1.96*se, center+1.96*se] if se is not None else None}


def strict_frame(all_rows: pd.DataFrame, hours: int):
    suffix = f'{hours}h'
    target = all_rows.signal_at + pd.Timedelta(hours=hours)
    valid = (all_rows.entry_price_source.eq('api_at_publication')
             & all_rows.entry_price.between(.05, .95)
             & all_rows.q_probability.between(0, 1)
             & all_rows[f'price_{suffix}'].between(0, 1)
             & all_rows[f'price_{suffix}_timing_valid'].eq(True)
             & all_rows[f'entry_mark_basis_compatible_{suffix}'].eq(True)
             & (all_rows.market_close_at > target) & (target <= ASOF))
    frame = all_rows.loc[valid].copy()
    move = (frame[f'price_{suffix}']-frame.entry_price)*100
    frame['abs_move_pp'] = move.abs()
    frame['signed_toward_q_pp'] = np.sign(frame.q_probability-frame.entry_price)*move
    frame['move_at_least_2pp'] = (move.abs() >= 2).astype(float)
    frame['move_at_least_5pp'] = (move.abs() >= 5).astype(float)
    return frame


def bins(frame: pd.DataFrame):
    result = []
    for label in GAP_LABELS:
        group = frame.loc[frame.gap_bucket.eq(label)]
        result.append({'gap_bucket': label, 'observations': len(group),
                       'markets': group.market_key.nunique(), 'events': group.cluster_key.nunique(),
                       'absolute_move_pp': equal_market_stats(group, 'abs_move_pp'),
                       'signed_toward_q_pp': equal_market_stats(group, 'signed_toward_q_pp'),
                       'move_at_least_2pp_fraction': equal_market_stats(group, 'move_at_least_2pp'),
                       'move_at_least_5pp_fraction': equal_market_stats(group, 'move_at_least_5pp'),
                       'prior_rv24_pp': equal_market_stats(group.dropna(subset=['realized_vol_24h_pp']), 'realized_vol_24h_pp')})
    return result


def regression(frame: pd.DataFrame, *, controls: bool, prior_vol: bool, outcome: str):
    required = ['gap_abs_pp', outcome]
    if controls:
        required += ['entry_price', 'log1p_hours_to_close', 'price_bucket', 'category']
    if prior_vol:
        required += ['realized_vol_24h_pp']
    work = frame.dropna(subset=required).copy()
    if len(work) < 30:
        return {'observations': len(work), 'not_estimated': 'fewer than 30 observations'}
    columns = [np.ones(len(work)), work.gap_abs_pp.to_numpy()/10]
    names = ['intercept', 'gap_per_10pp']
    if controls:
        dummies = pd.get_dummies(work[['price_bucket', 'category']].astype(str), drop_first=True, dtype=float)
        columns.extend([work.log1p_hours_to_close.to_numpy(), (work.q_probability > work.entry_price).to_numpy(dtype=float)])
        names.extend(['log1p_hours_to_close', 'q_direction_yes'])
        for name in dummies:
            columns.append(dummies[name].to_numpy())
            names.append(name)
    if prior_vol:
        columns.append(work.realized_vol_24h_pp.to_numpy()/10)
        names.append('prior_rv24_per_10pp')
    x = np.column_stack(columns)
    y = work[outcome].to_numpy()
    weights = 1/work.groupby('market_key').market_key.transform('size').to_numpy()
    assert np.isfinite(x).all() and np.isfinite(y).all() and np.isfinite(weights).all()
    # Direct weighted-design SVD avoids squaring its condition number. Explicit
    # einsum also avoids this machine's BLAS matmul floating-point-flag warnings.
    u, singular, vt = np.linalg.svd(x*np.sqrt(weights)[:, None], full_matrices=False)
    inverse = np.where(singular > singular[0]*1e-12, 1/singular, 0)
    bread = np.einsum('ki,k,kj->ij', vt, inverse**2, vt, optimize=False)
    projected = np.einsum('ij,i->j', u, y*np.sqrt(weights), optimize=False)
    coefficient = np.einsum('ki,k,k->i', vt, inverse, projected, optimize=False)
    residual = y-np.einsum('ij,j->i', x, coefficient, optimize=False)
    scores = pd.DataFrame(x*(weights*residual)[:, None]).groupby(work.cluster_key.to_numpy()).sum().to_numpy()
    count = len(scores)
    rank = int((singular > singular[0]*1e-12).sum())
    correction = count/(count-1)*(len(work)-1)/(len(work)-rank) if count > 1 and len(work) > rank else np.nan
    meat = np.einsum('ki,kj->ij', scores, scores, optimize=False)
    covariance = np.einsum('ij,jk,kl->il', bread, meat, bread, optimize=False)*correction
    assert np.isfinite(coefficient).all() and np.isfinite(covariance).all()
    standard_error = float(np.sqrt(max(0, covariance[1, 1])))
    estimate = float(coefficient[1])
    return {'observations': len(work), 'markets': work.market_key.nunique(), 'events': count,
            'outcome': outcome, 'gap_effect_pp_per_10pp_gap': estimate,
            'event_clustered_ci95': [estimate-1.96*standard_error, estimate+1.96*standard_error],
            'controls': names[2:], 'design_rank': rank,
            'weighted_r_squared': float(1-(weights*residual**2).sum()/(weights*(y-np.average(y, weights=weights))**2).sum())}


def main():
    rows = pd.read_parquet(SOURCE)
    rows = rows.loc[rows.research_cohort.eq('forecast') & rows.q_at_publication_verified.eq(True)].copy()
    rows['gap_abs_pp'] = (rows.q_probability-rows.entry_price).abs()*100
    # Boundaries: [0,5), [5,10), [10,20), [20,30], (30,infinity).
    rows['gap_bucket'] = pd.cut(rows.gap_abs_pp, bins=[-np.inf,5,10,20,30,np.inf],
                                labels=GAP_LABELS, right=False).astype(str)
    rows.loc[rows.gap_abs_pp.eq(30), 'gap_bucket'] = '20-30pp'
    rows['price_bucket'] = pd.cut(rows.entry_price, bins=[0,.2,.4,.6,.8,1], include_lowest=True).astype(str)
    rows['log1p_hours_to_close'] = np.log1p((rows.market_close_at-rows.signal_at).dt.total_seconds().clip(lower=0)/3600)
    rows['cluster_key'] = rows.event_key.fillna(rows.market_key)
    frames = {hours: strict_frame(rows, hours) for hours in HORIZONS}
    common_ids = set.intersection(*(set(frame.forecast_id) for frame in frames.values()))
    results = {}
    for hours, frame in frames.items():
        results[f'{hours}h'] = {
            'observations': len(frame), 'markets': frame.market_key.nunique(), 'events': frame.cluster_key.nunique(),
            'bins': bins(frame),
            'regressions': {
                'unadjusted': regression(frame, controls=False, prior_vol=False, outcome='abs_move_pp'),
                'price_category_time_direction': regression(frame, controls=True, prior_vol=False, outcome='abs_move_pp'),
                'plus_prior_rv24': regression(frame, controls=True, prior_vol=True, outcome='abs_move_pp'),
                'plus_prior_rv24_gap_at_most_30': regression(frame.loc[frame.gap_abs_pp.le(30)], controls=True, prior_vol=True, outcome='abs_move_pp'),
                'signed_plus_prior_rv24': regression(frame, controls=True, prior_vol=True, outcome='signed_toward_q_pp'),
            },
            'same_common_matured_forecasts': {
                'count': len(common_ids), 'bins': bins(frame.loc[frame.forecast_id.isin(common_ids)]),
                'fully_adjusted': regression(frame.loc[frame.forecast_id.isin(common_ids)], controls=True, prior_vol=True, outcome='abs_move_pp'),
            },
        }
    report = {
        'source': str(SOURCE), 'as_of': str(ASOF), 'verified_initial_publication_forecasts': len(rows),
        'method': {
            'exposure': 'Absolute initial publication Q minus timing-valid public reference entry price, in pp.',
            'primary_outcome': 'Absolute reference-price change at horizon; NOT realized path volatility or residual volatility.',
            'entry_range': '[0.05,0.95]; horizon must be matured, before market close, with timing-valid compatible reference-price marks.',
            'weighting': 'Within each sample/fit each market has total weight one; repeated updates share its weight.',
            'uncertainty': 'Event-clustered sandwich normal-approximation 95% CI; not multiple-testing adjusted.',
            'controls': 'Starting-price bins (.0-.2/.2-.4/.4-.6/.6-.8/.8-1), category fixed effects, log(1+hours to close), Q direction; additional prior 24h realized-volatility proxy.',
            'boundaries': '[0,5),[5,10),[10,20),[20,30],(30,infinity)',
        },
        'horizons': results,
        'limitations': [
            'Only about five days out of sample; this is an exploratory association, not a validated forecasting model.',
            'Absolute endpoint move mixes directional drift with uncertainty; it misses paths that move substantially and return.',
            'Prior rv24 is the saved trailing hourly reference-price volatility proxy, not reconstructed executable BBO variance.',
            'Controlled endpoint movement is not a forecast of residual path variance, even when the gap coefficient is positive.',
            'Category and market end metadata are current graph metadata; timing-valid initial Q is recovered from atomic publication artifacts.',
            'No test here identifies an optimal quote width, inventory target, ticket size, or profitable maker execution rule.',
        ],
    }
    (ROOT/'volatility-gap-analysis.json').write_text(json.dumps(report, indent=2, default=lambda value:value.item()))
    compact = {h: {'bins': [{'gap': r['gap_bucket'], 'n': r['observations'], 'markets': r['markets'],
                             'abs_pp': r['absolute_move_pp']['mean'], 'signed_pp':r['signed_toward_q_pp']['mean']}
                            for r in d['bins']],
                    'fully_adjusted':{k:d['regressions']['plus_prior_rv24'][k]
                                      for k in ['gap_effect_pp_per_10pp_gap','event_clustered_ci95']}}
               for h,d in results.items()}
    print(json.dumps(compact, indent=2, default=lambda value:value.item()))


if __name__ == '__main__':
    main()

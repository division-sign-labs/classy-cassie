# research/mm-strategy-review/adaptive-calibration.py
"""Offline chronological comparison of movement-risk forecasts; no network access."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).parent
SOURCE = ROOT / 'graph-oos-refresh/graph-reference-marks.parquet'
ASOF = pd.Timestamp('2026-09-05T05:32:46.258285+00:00')
SEED = 20260905


def event_weights(frame):
    """Each event gets one total weight, equally divided across its markets."""
    counts = frame.groupby('market_key').market_key.transform('size')
    markets = frame.groupby('cluster_key').market_key.transform('nunique')
    return 1/(counts.to_numpy()*markets.to_numpy())


def horizon_frame(rows, hours):
    suffix = f'{hours}h'
    target = rows.signal_at + pd.Timedelta(hours=hours)
    valid = (rows.entry_price_source.eq('api_at_publication')
             & rows.entry_price.between(.05, .95)
             & rows.q_probability.between(0, 1)
             & rows[f'price_{suffix}'].between(0, 1)
             & rows[f'price_{suffix}_timing_valid'].eq(True)
             & rows[f'entry_mark_basis_compatible_{suffix}'].eq(True)
             & (rows.market_close_at > target) & (target <= ASOF)
             & rows.realized_vol_24h_pp.notna())
    frame = rows.loc[valid].copy()
    frame['target_at'] = target.loc[valid]
    frame['absolute_move_pp'] = (frame[f'price_{suffix}']-frame.entry_price).abs()*100
    frame['gap_abs_pp'] = (frame.q_probability-frame.entry_price).abs()*100
    frame['log1p_hours_to_close'] = np.log1p((frame.market_close_at-frame.signal_at).dt.total_seconds()/3600)
    frame['price_bucket'] = pd.cut(frame.entry_price, bins=[0,.2,.4,.6,.8,1], include_lowest=True).astype(str)
    frame['category'] = frame.category.fillna('Unknown').astype(str)
    return frame.sort_values(['signal_at','forecast_id']).reset_index(drop=True)


def design(train, test, add_gap):
    train_w = event_weights(train)
    names = ['intercept','prior_rv24_per_10pp','log1p_hours_to_close']
    train_columns = [np.ones(len(train)),train.realized_vol_24h_pp.to_numpy()/10,train.log1p_hours_to_close.to_numpy()]
    test_columns = [np.ones(len(test)),test.realized_vol_24h_pp.to_numpy()/10,test.log1p_hours_to_close.to_numpy()]
    unknown = {}
    for field in ['price_bucket','category']:
        levels = sorted(train[field].unique())
        is_unknown = ~test[field].isin(levels)
        unknown[field] = int(is_unknown.sum())
        # Unseen levels receive the training-frequency mixture, rather than an
        # arbitrary reference-category effect. This choice is fixed in advance.
        for level in levels[1:]:
            a = train[field].eq(level).to_numpy(dtype=float)
            b = test[field].eq(level).to_numpy(dtype=float)
            b[is_unknown.to_numpy()] = np.average(a,weights=train_w)
            train_columns.append(a)
            test_columns.append(b)
            names.append(field+'='+level)
    if add_gap:
        train_columns.append(train.gap_abs_pp.to_numpy()/10)
        test_columns.append(test.gap_abs_pp.to_numpy()/10)
        names.append('gap_per_10pp')
    return np.column_stack(train_columns),np.column_stack(test_columns),names,unknown


def fit_predict(train,test,add_gap):
    x,z,names,unknown = design(train,test,add_gap)
    weights = event_weights(train)
    y = train.absolute_move_pp.to_numpy()
    assert np.isfinite(x).all() and np.isfinite(z).all() and np.isfinite(y).all()
    u,s,vt = np.linalg.svd(x*np.sqrt(weights)[:,None],full_matrices=False)
    inverse = np.where(s>s[0]*1e-12,1/s,0)
    projected = np.einsum('ij,i->j',u,y*np.sqrt(weights),optimize=False)
    coef = np.einsum('ki,k,k->i',vt,inverse,projected,optimize=False)
    raw = np.einsum('ij,j->i',z,coef,optimize=False)
    maximum_move = 100*np.maximum(test.entry_price.to_numpy(),1-test.entry_price.to_numpy())
    prediction = np.clip(raw,0,maximum_move)
    assert np.isfinite(prediction).all()
    return prediction,{
        'coefficients':dict(zip(names,coef.tolist())),
        'rank':int((s>s[0]*1e-12).sum()),'features':len(names),
        'unseen_test_levels':unknown,
        'negative_predictions_before_clipping':int((raw<0).sum()),
        'above_feasible_range_before_clipping':int((raw>maximum_move).sum()),
    }


def errors(test,prediction):
    actual = test.absolute_move_pp.to_numpy()
    weights = event_weights(test)
    absolute = np.abs(actual-prediction)
    squared = (actual-prediction)**2
    summary = {
        'event_weighted_mae_pp':float(np.average(absolute,weights=weights)),
        'event_weighted_rmse_pp':float(np.sqrt(np.average(squared,weights=weights))),
        'event_weighted_actual_mean_abs_move_pp':float(np.average(actual,weights=weights)),
        'event_weighted_predicted_mean_abs_move_pp':float(np.average(prediction,weights=weights)),
        'event_weighted_underprediction_by_over_5pp_fraction':float(np.average(actual-prediction>5,weights=weights)),
    }
    per_event = pd.DataFrame({'event':test.cluster_key.to_numpy(),'abs_error':absolute*weights,
                              'squared_error':squared*weights}).groupby('event').sum()
    return summary,per_event


def paired_difference(base,augmented):
    delta = augmented.abs_error-base.abs_error
    rng = np.random.default_rng(SEED)
    samples = rng.integers(0,len(delta),size=(2000,len(delta)))
    boot = delta.to_numpy()[samples].mean(axis=1)
    return {'augmented_minus_baseline_mae_pp':float(delta.mean()),
            'paired_event_bootstrap_ci95_pp':np.quantile(boot,[.025,.975]).tolist(),
            'event_count':len(delta),'bootstrap_repetitions':2000,
            'sign_convention':'Negative means adding gap improved MAE.'}


def main():
    rows = pd.read_parquet(SOURCE)
    rows = rows.loc[rows.research_cohort.eq('forecast') & rows.q_at_publication_verified.eq(True)].copy()
    rows['cluster_key'] = rows.event_key.fillna(rows.market_key)
    results = {}
    for hours in [1,6,24]:
        frame = horizon_frame(rows,hours)
        split = frame.iloc[int(np.floor(.7*len(frame)))].signal_at
        before = frame.loc[frame.signal_at<split]
        train = before.loc[before.target_at<split].copy()
        test = frame.loc[frame.signal_at>=split].copy()
        assert len(train)>30 and len(test)>20
        assert train.target_at.max()<test.signal_at.min()
        baseline,base_fit = fit_predict(train,test,False)
        augmented,gap_fit = fit_predict(train,test,True)
        base_score,base_events = errors(test,baseline)
        gap_score,gap_events = errors(test,augmented)
        results[f'{hours}h'] = {
            'split':{
                'test_start':str(split),'training_first':str(train.signal_at.min()),
                'training_last':str(train.signal_at.max()),'training_last_label_available':str(train.target_at.max()),
                'test_last':str(test.signal_at.max()),'training_observations':len(train),
                'embargoed_observations':len(before)-len(train),'test_observations':len(test),
                'training_markets':train.market_key.nunique(),'training_events':train.cluster_key.nunique(),
                'test_markets':test.market_key.nunique(),'test_events':test.cluster_key.nunique(),
                'test_markets_previously_in_training':len(set(test.market_key)&set(train.market_key)),
                'test_events_previously_in_training':len(set(test.cluster_key)&set(train.cluster_key)),
            },
            'baseline':base_score,'baseline_plus_gap':gap_score,
            'paired_holdout_comparison':paired_difference(base_events,gap_events),
            'baseline_fit':base_fit,'baseline_plus_gap_fit':gap_fit,
        }
    report = {
        'source':str(SOURCE),'as_of':str(ASOF),'verified_initial_q_rows':len(rows),
        'protocol':{
            'split':'One preselected chronological70/30 split per horizon after timing-valid/mature/prior-RV availability filters.',
            'embargo':'Discard training examples whose outcome horizon reaches or crosses the first test timestamp.',
            'target':'Absolute endpoint reference-price move in pp, not realized path volatility or maker return.',
            'baseline':'Weighted linear least squares: prior24hRV, initial price bucket, category, log(1+hours to close).',
            'augmentation':'Add only the absolute initial Q-reference-price gap, linearly per10pp; no parameter search.',
            'weighting':'Each event equal total weight; within event each market equal; within market each forecast equal.',
            'prediction_bounds':'Clip both models to [0,100*max(entryprice,1-entryprice)] using only known entry information.',
            'primary_metric':'Event-weighted holdout MAE; RMSE secondary. Difference CI resamples paired holdout events.',
            'seed':SEED,
        },
        'horizons':results,
        'limitations':[
            'This five-day dataset was already used to formulate the movement hypothesis. Holdout excludes model fitting, but is not a pristine hypothesis-selection holdout.',
            'One split and short coverage; no rolling validation, hyperparameter search, or claim of generalizable profitability.',
            'Some test events/markets occur in training; the label embargo prevents chronological overlap but does not create an unseen-event test.',
            'The initial atomic publication Q precedes later coherence repairs; it is not the entire historical served-Q revision stream.',
            'Public reference prices are not executable BBOs. Endpoint displacement cannot distinguish directional drift from oscillating paths.',
            'The paired bootstrap conditions on fitted training models and resamples only holdout events.',
            'No fitted coefficient is endorsed as an optimal quote skew, spread width, inventory target, or ticket size.',
        ],
    }
    (ROOT/'adaptive-calibration.json').write_text(json.dumps(report,indent=2,default=lambda value:value.item()))
    print(json.dumps({h:{'split':v['split'],'baseline':v['baseline'],'plus_gap':v['baseline_plus_gap'],
                         'comparison':v['paired_holdout_comparison'],
                         'fitted_gap_effect':v['baseline_plus_gap_fit']['coefficients']['gap_per_10pp']}
                      for h,v in results.items()},indent=2,default=lambda value:value.item()))


if __name__=='__main__':
    main()

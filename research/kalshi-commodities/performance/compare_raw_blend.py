# research/kalshi-commodities/performance/compare_raw_blend.py
"""Offline paired Brier comparison using the frozen scored forecast cohort."""
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parent
SOURCE = OUT / 'scored_forecasts.csv.gz'
FIELDS = {'raw_q': 'qRaw', 'stored_published_blend': 'qProb', 'market': 'yesOdds'}


def interval(g, column):
    groups = g.groupby('cluster')[column].agg(['sum', 'count'])
    if len(groups) < 2:
        return [None, None]
    rng = np.random.default_rng(20260904)
    draws = rng.integers(0, len(groups), size=(5000, len(groups)))
    means = groups['sum'].values[draws].sum(1) / groups['count'].values[draws].sum(1)
    return np.quantile(means, [.025, .975]).tolist()


def summarize(g, asset):
    scores = {name: float(g[name].mean()) for name in FIELDS}
    differences = {}
    for lhs, rhs in [('raw_q', 'stored_published_blend'), ('raw_q', 'market'), ('stored_published_blend', 'market')]:
        paired = g.assign(delta=g[lhs]-g[rhs])
        differences[f'{lhs}_minus_{rhs}'] = {'mean': float(paired.delta.mean()), 'cluster_ci95': interval(paired, 'delta')}
    return {'asset': asset, 'forecasts': len(g), 'markets': int(g.marketId.nunique()),
            'settlement_clusters': int(g.cluster.nunique()), 'brier': scores, 'differences': differences}


def main():
    frame = pd.read_csv(SOURCE)
    assert frame.forecastId.is_unique
    present = frame[list(FIELDS.values()) + ['outcome']].notna().all(axis=1)
    matched = frame[present].copy()
    for column in [*FIELDS.values(), 'outcome']:
        assert matched[column].between(0, 1).all()
    assert matched.outcome.isin([0, 1]).all()
    for name, column in FIELDS.items():
        matched[name] = (matched[column]-matched.outcome)**2
    cohorts = {'all': matched, 'first_per_market': matched.sort_values(['createdAt', 'forecastId']).drop_duplicates('marketId'),
               'hash_selected_per_market': matched.sort_values('randomKey').drop_duplicates('marketId')}
    result = {
        'source_sha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        'source_rows': len(frame), 'matched_rows': len(matched), 'missing_comparison_rows': int((~present).sum()),
        'fields': FIELDS,
        'semantics': {
            'raw_q': 'Persisted rawProbability: temperature-calibrated pre-market-blend adapter Q; not raw model logits.',
            'stored_published_blend': 'Persisted probability: canonical published value, potentially including coherence adjustment.',
            'market': 'Persisted yesOddsAtCreation: contemporaneously stored venue probability, not executable bid/ask.',
            'qCalGated': 'All values absent in this cohort; not substituted for publication.',
        },
        'limitations': ['Frozen September 5 audit; no new outcome or forecast fetch.',
                       'Contains repeated forecasts and multiple model/serving versions.',
                       'Stored probability is not an immutable archived publication snapshot.',
                       'No trade fills, spread, fee or account-return inference.'],
        'samples': {mode: [summarize(g, asset) for asset, g in cohort.groupby('asset')] for mode, cohort in cohorts.items()},
    }
    (OUT / 'raw_blend_metrics.json').write_text(json.dumps(result, indent=2, allow_nan=False)+'\n')
    for record in result['samples']['all']:
        print(record['asset'], record['forecasts'], {key: round(value, 6) for key, value in record['brier'].items()})


if __name__ == '__main__':
    main()

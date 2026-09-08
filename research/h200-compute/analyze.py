# research/h200-compute/analyze.py
"""Paired H200 forecast scoring against official Kalshi settlements."""
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parent
FIELDS = {'raw_q': 'qRaw', 'blend_before_later_repairs': 'qOriginal',
          'stored_published_q': 'qProb', 'market': 'yesOdds'}


def summarize(g):
    scores = {k: float(((g[v]-g.outcome)**2).mean()) for k,v in FIELDS.items()}
    return {'forecasts': len(g), 'markets': int(g.marketId.nunique()), 'fixing_dates': int(g.fixing.nunique()),
            'brier': scores,
            'log_loss': {k: float(-(g.outcome*np.log(g[v].clip(1e-6,1-1e-6))+(1-g.outcome)*np.log(1-g[v].clip(1e-6,1-1e-6))).mean()) for k,v in FIELDS.items()},
            'favorite_accuracy': {k: float(((g[v]>.5)==g.outcome.astype(bool)).mean()) for k,v in FIELDS.items()},
            'mean_probability': {k: float(g[v].mean()) for k,v in FIELDS.items()},
            'yes_outcome_rate': float(g.outcome.mean()),
            'blend_selected_side_win_rate': float(g.won.mean()),
            'blend_selected_side_mean_quote': float(g.held_quote.mean()),
            'gross_payoff_per_contract_at_quote': float((g.won-g.held_quote).mean())}


def main():
    f = pd.read_csv(OUT/'forecasts.csv.gz')
    stages = pd.DataFrame(json.loads((OUT/'stages.json').read_text())['records'])
    assert f.forecastId.is_unique and stages.forecastId.is_unique
    f = f.merge(stages, on='forecastId', validate='one_to_one')
    assert np.allclose(f.qProb, f.storedProbabilityNow)
    f['qOriginal'] = f.probabilityBeforeCoherence.fillna(f.qProb)
    market_files = [OUT/f'settlement/{s}-markets.json' for s in ['KXH200WS','KXH200MON']]
    markets = pd.DataFrame([m for p in market_files for m in json.loads(p.read_text())['markets']])
    f['ticker'] = f.marketId.str.removeprefix('kalshi:')
    d = f.merge(markets[['ticker','result','expiration_value','event_ticker','close_time','floor_strike']], on='ticker', validate='many_to_one')
    assert len(d)==len(f)
    d['created'] = pd.to_datetime(d.createdAt,utc=True,format='ISO8601')
    # These two series fix on a calendar-day Ornn print; use 20:00Z on the encoded
    # date, preceding MON's late close/occurrence metadata. All scored forecasts
    # are days earlier, so intraday MON ambiguity does not affect this cohort.
    d['fixing'] = pd.to_datetime(d.event_ticker.str.split('-').str[1],format='%y%b%d',utc=True)+pd.Timedelta(hours=20)
    d['hours_to_fixing'] = (d.fixing-d.created).dt.total_seconds()/3600
    d['outcome'] = d.result.map({'yes':1,'no':0})
    d['gap'] = (d.qOriginal-d.yesOdds).abs()
    d['buy_yes'] = d.qOriginal>d.yesOdds
    d['held_quote'] = np.where(d.buy_yes,d.yesOdds,1-d.yesOdds)
    d['won'] = np.where(d.buy_yes,d.outcome,1-d.outcome)
    settled = d[d.outcome.notna() & d.hours_to_fixing.gt(0)].copy()
    assert settled[list(FIELDS.values())].notna().all().all()
    selected = settled[settled.hours_to_fixing.between(2,336) & settled.held_quote.between(.1,.9)]
    samples = {'all': settled,
               'first_per_market': settled.sort_values(['created','forecastId']).drop_duplicates('marketId'),
               'last_per_market': settled.sort_values(['created','forecastId']).drop_duplicates('marketId',keep='last'),
               'hash_selected_per_market': settled.assign(randomKey=settled.forecastId.map(lambda v:hashlib.sha256(v.encode()).hexdigest())).sort_values('randomKey').drop_duplicates('marketId'),
               'quote_gap_5_to_25pp': selected[selected.gap.between(.05,.25)],
               'quote_gap_10_to_25pp': selected[selected.gap.between(.10,.25)]}
    mean_forecasts = settled.groupby('marketId')[list(FIELDS.values())+['outcome']].mean()
    mean_forecast_brier = {name: float(((mean_forecasts[column]-mean_forecasts.outcome)**2).mean()) for name,column in FIELDS.items()}
    equal_market_brier = {name: float(settled.assign(score=(settled[column]-settled.outcome)**2).groupby('marketId').score.mean().mean()) for name,column in FIELDS.items()}
    at = pd.Timestamp(json.loads((OUT/'manifest.json').read_text())['retrievedAt'])
    current = json.loads((OUT/'current-forecasts.json').read_text())['results']
    open_reads=[]
    for row in current:
        q=row['quotient_odds'];quote=row['venue_quote'];mid=quote['selected_probability']
        side='YES' if q>mid else 'NO';ask=quote['yes_ask'] if side=='YES' else 1-quote['yes_bid']
        open_reads.append({'marketId':row['marketKey'],'q':q,'createdAt':row['last_updated'],
            'forecast_age_days':(at-pd.Timestamp(row['last_updated'])).total_seconds()/86400,
            'bid':quote['yes_bid'],'ask':quote['yes_ask'],'midpoint':mid,'side':side,
            'quote_gap_pp':abs(q-mid)*100,'executable_gap_pp':((q if side=='YES' else 1-q)-ask)*100,
            'spread_cents':(quote['yes_ask']-quote['yes_bid'])*100,
            'quote_observed_at':quote['observed_at'],'market_updated_at':quote['venue_timestamp']})
    artifact={'retrievedAt':at.isoformat(),'total_forecasts':len(f),'total_markets':int(f.marketId.nunique()),
        'first_forecast':f.createdAt.min(),'last_forecast':f.createdAt.max(),
        'settled_forecasts':len(settled),'open_forecasts':int(d.outcome.isna().sum()),
        'historical_books_present':f[['bestBid','bestAsk','cap2c']].notna().sum().to_dict(),
        'coherence_tagged':int(f.coherenceAt.notna().sum()),
        'coherence_changed':int((abs(f.qOriginal-f.qProb)>1e-8).sum()),
        'model_paths':f.adapterModelPath.value_counts().to_dict(),
        'samples':{k:summarize(g) for k,g in samples.items()},
        'brier_of_mean_forecast_per_market': mean_forecast_brier,
        'mean_brier_with_equal_market_weights': equal_market_brier,
        'by_event':{k:summarize(g) for k,g in settled.groupby('event_ticker')},
        'by_series':{k:summarize(g) for k,g in settled.groupby(settled.ticker.str.split('-').str[0])},
        'open_reads':open_reads,
        'limitations':['Only three fixing dates; repeated forecasts and related strikes are not independent observations.',
            'All settled forecasts use research_market_v1. The only union_v4 forecast is unsettled.',
            'Pre-coherence blend recovers the preserved pre-repair stage, not an immutable archive of every probability served at publication.',
            'Stored published probability can reflect later repairs. Six monthly rows were changed with last coherence timestamp Aug30.',
            'Quote-gap bands use the preserved blend and contemporaneously stored quote, not executable historical asks.',
            'No historical bid/ask, depth, positions, fills, fees or account-return ledger; no realized profit or Sharpe inference.',
            'Current forecasts are 5–12 days old; present quote comparisons are descriptive and do not establish fresh edge.',
            'KXH200MS monthly averages and KXH200MAX annual products have no forecasts in this extract and are excluded.'],
        'source_sha256':{str(p.relative_to(OUT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [OUT/'forecasts.csv.gz',OUT/'stages.json',OUT/'current-forecasts.json',*market_files]}}
    (OUT/'metrics.json').write_text(json.dumps(artifact,indent=2,allow_nan=False)+'\n')
    d.to_csv(OUT/'scored_forecasts.csv.gz',index=False)
    print(json.dumps({'samples':artifact['samples'],'by_event':artifact['by_event']},indent=2))


if __name__=='__main__':
    main()

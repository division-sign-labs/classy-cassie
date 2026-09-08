# research/kalshi-commodities/performance/analyze.py
"""Reproducible outcome scoring and explicitly hypothetical candle-entry replay."""
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parent
OLD = Path('/Users/jordanolmstead/dev/q-trade-analysis/data')
SERIES = {
    'KXWTI': 'day', 'KXWTIW': 'week', 'KXGOLDD': 'day', 'KXGOLDW': 'week',
    'KXGOLDMON': 'month', 'KXCOPPERD': 'day', 'KXCOPPERW': 'week',
    'KXCOPPERMON': 'month', 'KXBTCD': 'day', 'KXBTCMAXMON': 'touch',
    'KXBTCMINMON': 'touch',
    'KXSILVERD': 'day', 'KXSILVERW': 'week', 'KXSILVERMON': 'month',
}


def ci(frame, column, cluster='cluster'):
    frame = frame.dropna(subset=[column])
    if frame.empty:
        return [None, None]
    group = frame.groupby(cluster)[column].agg(['sum', 'count'])
    if len(group) < 2:
        return [None, None]
    rng = np.random.default_rng(20260904)
    draws = rng.integers(0, len(group), size=(5000, len(group)))
    means = group['sum'].values[draws].sum(1) / group['count'].values[draws].sum(1)
    return np.quantile(means, [0.025, 0.975]).tolist()


def brier_summary(frame, **extra):
    return dict(extra, n=len(frame), markets=int(frame.marketId.nunique()),
                clusters=int(frame.cluster.nunique()), q_brier=frame.q_brier.mean(),
                market_brier=frame.market_brier.mean(),
                q_minus_market=frame.brier_delta.mean(),
                delta_ci95=ci(frame, 'brier_delta'),
                yes_outcome=frame.outcome.mean(), q_mean=frame.qProb.mean(),
                market_mean=frame.yesOdds.mean(), yes_side_share=frame.side.eq('YES').mean())


def summarize_groups(frame, columns, metric):
    records = []
    for keys, group in frame.groupby(columns, observed=True):
        keys = keys if isinstance(keys, tuple) else (keys,)
        record = dict(zip(columns, keys))
        records.append(metric(group, **record))
    return records


def load():
    f = pd.read_csv(OUT / 'forecasts.csv.gz').drop_duplicates('forecastId')
    f['createdAt'] = pd.to_datetime(f.createdAt, utc=True, format='ISO8601')
    m = pd.DataFrame(json.loads((OUT / 'kalshi_markets.json').read_text()))
    m['anchor'] = [(v.get('strike_date') if isinstance(v, dict) else None) or close
                   for v, close in zip(m.custom_strike, m.close_time)]
    m['anchor'] = pd.to_datetime(m.anchor, utc=True, format='ISO8601')
    f['ticker'] = f.marketId.str.removeprefix('kalshi:')
    f['series'] = f.ticker.str.split('-').str[0]
    f['kind'] = f.series.map(SERIES).fillna('excluded')
    f = f.merge(m[['ticker', 'anchor', 'status', 'result', 'event_ticker', 'strike_type']], on='ticker', how='left', validate='many_to_one')
    f['outcome'] = f.result.map({'yes': 1.0, 'no': 0.0})
    f['hoursToAnchor'] = (f.anchor-f.createdAt).dt.total_seconds()/3600
    # Same asset and exact source fixing is one cluster across daily/weekly wrappers.
    f['cluster'] = f.asset + '|' + f.anchor.astype(str)
    touch = f.kind.eq('touch')
    # Early touch closes share one monthly price path; they are not independent events.
    f.loc[touch, 'cluster'] = f.loc[touch, 'asset']+'|touch:'+f.loc[touch,'ticker'].str.split('-').str[2]
    f['side'] = np.where(f.qProb > f.yesOdds, 'YES', 'NO')
    f['gap'] = (f.qProb-f.yesOdds).abs()
    f['q_brier'] = (f.qProb-f.outcome)**2
    f['market_brier'] = (f.yesOdds-f.outcome)**2
    f['brier_delta'] = f.q_brier-f.market_brier
    f['horizon'] = pd.cut(f.hoursToAnchor, [0, 6, 24, 72, 168, 336, np.inf],
                          labels=['0-6h', '6-24h', '1-3d', '3-7d', '7-14d', '>14d'])
    f['gapBand'] = pd.cut(f.gap, [-1, .05, .15, .25, 1], right=False,
                          labels=['<5pp','5-15pp','15-25pp','>=25pp'])
    return f


def candle_replay(f):
    # Freeze the forecast universe to the actual Aug25 cache, not forecasts
    # discovered by this audit that happen to match an old candle.
    cached_forecasts = pd.read_csv(OLD / 'asset_rule_universe.csv.gz', usecols=['forecastId'])
    f = f[f.forecastId.isin(cached_forecasts.forecastId)].copy()
    candles = pd.read_csv(OLD / 'asset_rule_kalshi_candles.csv.gz')
    candles['entryAt'] = pd.to_datetime(candles.ts, unit='s', utc=True)
    old = pd.read_csv(OLD / 'asset_rule_kalshi_markets.csv')
    old_status = old.set_index('ticker').status.to_dict()
    groups = dict(tuple(candles.groupby('ticker')))
    rows = []
    for ticker, group in f.groupby('ticker'):
        if ticker not in groups:
            continue
        quotes = groups[ticker].sort_values('entryAt')
        matched = pd.merge_asof(group.sort_values('createdAt'),
                               quotes[['entryAt', 'bid_close', 'ask_close']],
                               left_on='createdAt', right_on='entryAt',
                               direction='forward', tolerance=pd.Timedelta(hours=3))
        rows.append(matched)
    d = pd.concat(rows, ignore_index=True)
    d['price'] = np.where(d.side.eq('YES'), d.ask_close, 1-d.bid_close)
    d['qSide'] = np.where(d.side.eq('YES'), d.qProb, 1-d.qProb)
    d['gapExec'] = d.qSide - d.price
    d['spread'] = d.ask_close-d.bid_close
    d = d[d.kind.isin(['day','week']) & d.hoursToAnchor.between(6, 336)
          & d.price.between(.10, .90) & d.gapExec.ge(.05) & d.gapExec.lt(.25)
          & d.spread.between(0, .05000000001) & d.entryAt.lt(d.anchor)].copy()
    # Chronological first eligible contract; among simultaneous candidates, larger edge wins.
    d = d.sort_values(['createdAt','gapExec'], ascending=[True,False])
    d = d.drop_duplicates(['cluster','side'])
    # No entry is added based on whether it has resolved by the audit date.
    d['previouslyFinal'] = d.ticker.map(old_status).isin(['finalized','settled'])
    d['won'] = np.where(d.outcome.notna(), np.where(d.side.eq('YES'), d.outcome, 1-d.outcome), np.nan)
    # Conservative one-contract fee rounding; denominator includes fees.
    d['fee'] = np.ceil(.07*d.price*(1-d.price)*100)/100
    d['return'] = (d.won-d.price-d.fee)/(d.price+d.fee)
    yes_fee = np.ceil(.07*d.ask_close*(1-d.ask_close)*100)/100
    d['alwaysYesReturn'] = (d.outcome-d.ask_close-yes_fee)/(d.ask_close+yes_fee)
    d['qMinusAlwaysYesReturn'] = d['return']-d.alwaysYesReturn
    d.to_csv(OUT/'candle_replay.csv', index=False)

    def metrics(g, **extra):
        settled = g[g.outcome.notna()]
        return dict(extra, selected=len(g), finalized=len(settled),
                    clusters=int(g.cluster.nunique()), yes=int(g.side.eq('YES').sum()),
                    mean_return=settled['return'].mean(), ci95=ci(settled, 'return'),
                    win_rate=settled.won.mean(), paired_always_yes=settled.qMinusAlwaysYesReturn.mean(),
                    paired_ci95=ci(settled, 'qMinusAlwaysYesReturn'))
    return {'all':metrics(d), 'by_asset':summarize_groups(d, ['asset'], metrics),
            'previously_final':summarize_groups(d, ['previouslyFinal'], metrics)}


def outlooks():
    outcomes = pd.DataFrame([r['outcome'] for r in json.loads((OUT/'outcomes.json').read_text())])
    sources = pd.DataFrame(json.loads((OUT/'scored_outlooks.json').read_text()))
    sources = sources.rename(columns={'medianPrice':'forecastMedian'})
    joined = outcomes.merge(sources, on=['outcomeId','outlookId','assetKey','seriesId'], suffixes=('', '_outlook'))
    joined['medianErrorPct'] = (joined.forecastMedian-joined.settlePrice)/joined.settlePrice*100
    joined['absMedianErrorPct'] = joined.medianErrorPct.abs()
    joined['horizonHours'] = (pd.to_datetime(joined.anchorAt_outlook, utc=True, format='ISO8601')
                              -pd.to_datetime(joined.publishedAt, utc=True, format='ISO8601')).dt.total_seconds()/3600
    joined['cluster'] = joined.assetKey+'|'+joined.anchorDate+'|'+joined.settlementBasis
    joined['qRungs'] = [json.loads(x).get('legs',{}).get('q',{}).get('n',0) for x in joined.legRungBrierJson]
    joined.to_csv(OUT/'scored_outlook_audit.csv',index=False)

    def metrics(g, **extra):
        return dict(extra, n=len(g), independent_dates=int(g.anchorDate.nunique()),
                    min_anchor=g.anchorDate.min(),max_anchor=g.anchorDate.max(),
                    median_abs_error_pct=g.absMedianErrorPct.median(),
                    mean_error_pct=g.medianErrorPct.mean(), band50_coverage=g.inBand.mean(),
                    band80_coverage=g.inWideBand.mean(), median_horizon_hours=g.horizonHours.median(),
                    backfilled=int(g.backfilled.fillna(False).astype(bool).sum()),
                    published_at_or_after_anchor=int(g.horizonHours.le(0).sum()),
                    with_q_rungs=int(g.qRungs.gt(0).sum()))
    horizon = pd.DataFrame(json.loads((OUT/'horizon_outlooks.json').read_text()))
    horizon['in50'] = horizon.settlePrice.between(horizon.p25,horizon.p75)
    horizon['in80'] = horizon.settlePrice.between(horizon.p10,horizon.p90)
    horizon['absMedianErrorPct'] = (horizon.medianPrice/horizon.settlePrice-1).abs()*100
    horizon_summary = summarize_groups(horizon,['assetKey','settlementBasis','horizonHours'],
        lambda g,**x:dict(x,n=len(g),dates=int(g.anchorDate.nunique()),
                         band50_coverage=g.in50.mean(),band80_coverage=g.in80.mean(),
                         median_abs_error_pct=g.absMedianErrorPct.median()))
    return {'by_asset_basis':summarize_groups(joined,['assetKey','settlementBasis'],metrics),
            'matched_horizons':horizon_summary,
            'horizon_hours_min':joined.horizonHours.min(),
            'venue_selected':joined[joined.settlementBasis.eq('venue-settlement-value')][['assetKey','anchorDate','publishedAt','anchorAt_outlook','horizonHours','settlementSource','settlePrice','forecastMedian','qRungs']].to_dict(orient='records')}


def main():
    f = load()
    valid = f[f.outcome.notna() & f.qProb.between(0,1) & f.yesOdds.between(0,1)
              & f.hoursToAnchor.gt(0) & f.kind.ne('excluded')].copy()
    valid['randomKey'] = valid.forecastId.map(lambda s: hashlib.sha256(('20260904|'+s).encode()).hexdigest())
    valid['cohort'] = np.where(valid.createdAt < pd.Timestamp('2026-08-25T07:00:00Z'), 'through_Aug25_snapshot', 'after_Aug25_snapshot')
    metrics = {'coverage':summarize_groups(f,['asset'],lambda g,**x:dict(x,n=len(g),markets=int(g.marketId.nunique()),first=str(g.createdAt.min()),last=str(g.createdAt.max()),settled_forecast_rows=int(g.outcome.notna().sum()))),
               'total_forecasts':len(f),'missing_snapshot_quote':int(f.yesOdds.isna().sum()),
               'post_anchor_rows':int(f.hoursToAnchor.le(0).sum()),
               'excluded_asset_links':f.loc[f.kind.eq('excluded'), ['marketId','asset']].drop_duplicates().to_dict(orient='records'),
               'scores':[], 'all_by_horizon':summarize_groups(valid,['asset','horizon'],brier_summary),
               'all_by_side':summarize_groups(valid,['asset','side'],brier_summary),
               'all_by_gap':summarize_groups(valid,['gapBand'],brier_summary),
               'all_by_kind':summarize_groups(valid,['kind'],brier_summary),
               'all_by_cohort':summarize_groups(valid,['asset','cohort'],brier_summary)}
    for name, sample in [('all',valid),('first',valid.sort_values('createdAt').drop_duplicates('marketId')),
                         ('random',valid.sort_values('randomKey').drop_duplicates('marketId'))]:
        metrics['scores'] += summarize_groups(sample,['asset'],lambda g,**x:brier_summary(g,sample=name,**x))
    terminal = valid[valid.kind.isin(['day','week']) & valid.hoursToAnchor.ge(6)]
    metrics['terminal_min6h'] = summarize_groups(terminal,['asset'],brier_summary)
    metrics['candle_replay'] = candle_replay(f)
    metrics['outlooks'] = outlooks()
    # Forecast-level scoring rows enable downstream audits without database access.
    valid.to_csv(OUT/'scored_forecasts.csv.gz',index=False)
    (OUT/'metrics.json').write_text(json.dumps(metrics,indent=2,default=str,allow_nan=True))
    print(json.dumps({k:metrics[k] for k in ['coverage','scores','terminal_min6h','candle_replay']},indent=2,default=str))


if __name__ == '__main__':
    main()

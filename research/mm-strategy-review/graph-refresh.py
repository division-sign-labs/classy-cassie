# research/mm-strategy-review/graph-refresh.py
"""Bounded read-only graph research. Never prints connection details or secrets."""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import traceback
import warnings
from datetime import datetime, timezone
from pathlib import Path

ANALYTICS = Path('/Users/jordanolmstead/dev/quotient-analytics-pipelines')
sys.path.insert(0, str(ANALYTICS))
from dotenv import load_dotenv
from neo4j import GraphDatabase, READ_ACCESS

logging.getLogger('neo4j').setLevel(logging.CRITICAL)
warnings.filterwarnings('ignore',message='DataFrame is highly fragmented')


def connect():
    load_dotenv(ANALYTICS / '.env', override=False)
    names = ['QUOAPP_NEO4J_URI', 'QUOAPP_NEO4J_USERNAME', 'QUOAPP_NEO4J_PASSWORD']
    if not all(os.environ.get(name) for name in names):
        raise RuntimeError('required graph credentials are not available')
    return GraphDatabase.driver(
        os.environ[names[0]], auth=(os.environ[names[1]], os.environ[names[2]]),
        connection_timeout=10, connection_acquisition_timeout=15,
        max_connection_pool_size=2, max_transaction_retry_time=5,
    )


def read(driver, query, parameters=None):
    # Only this module's fixed MATCH/RETURN queries are submitted. Credentials
    # never appear in query text, parameters, saved artifacts, or exception text.
    if not query.lstrip().upper().startswith(('MATCH ', 'RETURN ')):
        raise ValueError('not an allowlisted read-query shape')
    with driver.session(database='neo4j', default_access_mode=READ_ACCESS) as session:
        with session.begin_transaction(timeout=30) as tx:
            return [record.data() for record in tx.run(query, parameters or {})]


def probe(driver, start, asof):
    params = {'start': start, 'asof': asof}
    queries = {
        'signal_schema': '''MATCH (s:QuotientSignal)
          WHERE s.createdAt >= datetime($start) AND s.createdAt <= datetime($asof)
          RETURN keys(s) AS properties ORDER BY s.createdAt DESC LIMIT 1''',
        'forecast_schema': '''MATCH (f:Forecast)-[:ON_MARKET]->(m:Market)
          WHERE f.createdAt >= datetime($start) AND f.createdAt <= datetime($asof)
            AND coalesce(f.venue,m.venue,'unknown')='polymarket'
          RETURN keys(f) AS properties, keys(m) AS market_properties
          ORDER BY f.createdAt DESC LIMIT 1''',
        'signal_counts': '''MATCH (s:QuotientSignal)-[:ON_FORECAST]->(f:Forecast)-[:ON_MARKET]->(m:Market)
          WHERE s.createdAt >= datetime($start) AND s.createdAt <= datetime($asof)
            AND coalesce(s.venue,m.venue,'polymarket')='polymarket'
          RETURN count(s) AS signals, count(DISTINCT m) AS markets,
            toString(min(s.createdAt)) AS first_at,toString(max(s.createdAt)) AS last_at''',
        'forecast_counts': '''MATCH (f:Forecast)-[:ON_MARKET]->(m:Market)
          WHERE f.createdAt >= datetime($start) AND f.createdAt <= datetime($asof)
            AND coalesce(f.venue,m.venue,'unknown')='polymarket'
            AND coalesce(f.publicationState,'committed')='committed'
          RETURN count(f) AS forecasts,count(DISTINCT m) AS markets,
            toString(min(f.createdAt)) AS first_at,toString(max(f.createdAt)) AS last_at''',
    }
    return {name: read(driver, query, params) for name, query in queries.items()}


def freshness(driver, asof):
    query = '''MATCH (f:Forecast)-[:ON_MARKET]->(m:Market)
      WHERE coalesce(f.venue,m.venue,'unknown')='polymarket'
        AND m.active=true AND coalesce(m.closed,false)=false
        AND coalesce(f.publicationState,'committed')='committed'
        AND coalesce(f.publicationCommittedAt,f.createdAt)<=datetime($asof)
      WITH m,f ORDER BY m.marketKey,coalesce(f.publicationCommittedAt,f.createdAt) DESC
      WITH m,collect(f)[0] AS f
      OPTIONAL MATCH (m)-[:PREDICTS]->(e:Event)
      OPTIONAL MATCH (e)-[:TAGGED]->(t:Tag)-[:IN_CATEGORY]->(c:Category)
      RETURN m.marketKey AS market_key,m.nativeMarketId AS native_market_id,
        m.conditionId AS condition_id,m.question AS question,
        m.volume24hr AS volume24h_usd,m.yesOdds AS graph_yes_odds,
        toString(m.updatedAt) AS market_updated_at,toString(m.endDate) AS end_date,
        collect(DISTINCT coalesce(e.eventKey,e.id,e.slug))[0] AS event_key,
        collect(DISTINCT c.name) AS categories,f.id AS forecast_id,
        f.probability AS current_q,
        toString(f.createdAt) AS forecast_created_at,
        toString(coalesce(f.publicationCommittedAt,f.createdAt)) AS available_at,
        toString(f.coherenceAt) AS latest_coherence_at
      ORDER BY available_at DESC'''
    rows = read(driver, query, {'asof':asof})
    from scripts.analyze_polymarket_strategy_flow import _primary_category
    from collections import Counter
    asof_dt = datetime.fromisoformat(asof.replace('Z','+00:00'))
    source = Path(__file__).parent / 'q-signals.json'
    active_keys = set()
    if source.exists():
        payload = json.loads(source.read_text())
        for s in payload.get('data',{}).get('signals',[]):
            active_keys.add(s.get('market_key') or s.get('market',{}).get('market_key') or s.get('market',{}).get('marketKey'))
    for row in rows:
        age = (asof_dt-datetime.fromisoformat(row['available_at'].replace('Z','+00:00'))).total_seconds()/3600
        row.update(age_hours=age, age_bucket='<6h' if age<6 else '6-24h' if age<24 else '24-72h' if age<=72 else '>72h',
                   in_active_signal_feed=row['market_key'] in active_keys,
                   primary_category=_primary_category(row['categories'],None))
    summary = {
        'as_of':asof,'active_graph_markets_with_committed_forecasts':len(rows),
        'age_counts':dict(Counter(r['age_bucket'] for r in rows)),
        'active_signal_keys_observed':len(active_keys),
        'active_signal_matched_age_counts':dict(Counter(r['age_bucket'] for r in rows if r['in_active_signal_feed'])),
        'not_in_active_signal_age_counts':dict(Counter(r['age_bucket'] for r in rows if not r['in_active_signal_feed'])),
        'by_category':{cat:dict(Counter(r['age_bucket'] for r in rows if r['primary_category']==cat))
                       for cat in sorted({r['primary_category'] for r in rows})},
    }
    output = Path(__file__).parent
    (output/'graph-current-forecasts.json').write_text(json.dumps({'as_of':asof,'markets':rows},indent=2))
    selected = [r for r in rows if float(r.get('volume24h_usd') or 0)>=1000][:100]
    (output/'graph-current-liquid-sample.json').write_text(json.dumps({'as_of':asof,'markets':selected},indent=2))
    (output/'graph-freshness-summary.json').write_text(json.dumps(summary,indent=2))
    return summary


def fetch_research_rows(driver, start, asof):
    from scripts.analyze_market_maker_utility import FORECAST_QUERY
    from scripts.analyze_polymarket_strategy_flow import SIGNAL_QUERY
    signal_query = SIGNAL_QUERY.replace(
        '  f.id AS source_forecast_id,',
        '''  f.id AS source_forecast_id,
          toString(f.createdAt) AS source_forecast_created_at,
          toString(coalesce(f.publicationCommittedAt,f.createdAt)) AS source_forecast_available_at,''')
    forecast_query = FORECAST_QUERY.replace(
        "WHERE coalesce(f.publicationState, 'committed') = 'committed'",
        '''WHERE coalesce(f.publicationState, 'committed') = 'committed'
          AND coalesce(f.venue,m.venue,'unknown')='polymarket'
          AND coalesce(f.publicationCommittedAt,f.createdAt)>=datetime($startAt)
          AND coalesce(f.publicationCommittedAt,f.createdAt)<=datetime($asOf)
        OPTIONAL MATCH (a:ForecastArtifact {key: f.pipelineRunId+'|'+m.id+'|published'})'''
    ).replace('WITH f, m,','WITH f, m, a,').replace(
        '  f.id AS forecast_id,',
        '''  f.id AS forecast_id,
          a.payloadJson AS publication_payload_json,
          toString(a.completedAt) AS publication_artifact_completed_at,
          toString(f.coherenceAt) AS latest_coherence_at,
          f.probabilityBeforeCoherence AS probability_before_coherence,''')
    params = {'startAt':start,'asOf':asof}
    signals = read(driver,signal_query,params)
    forecasts = read(driver,forecast_query,params)
    for row in signals:
        row['research_cohort']='signal'
    for row in forecasts:
        payload = row.pop('publication_payload_json',None)
        artifact = json.loads(payload) if payload else {}
        original = artifact.get('probability')
        verified = artifact.get('forecastId')==row['forecast_id'] and isinstance(original,(int,float)) and 0<=original<=1
        row['mutable_current_q']=row['q_probability']
        row['q_at_publication_verified']=verified
        if verified:
            row['q_probability']=original
            row['q_source']='atomic-publication-artifact'
        else:
            row['q_source']='mutable-current-forecast-diagnostic-only'
        row['research_cohort']='forecast'
    return signals,forecasts


def stats(frame,column):
    import math
    import numpy as np
    if frame.empty:
        return {'observations':0,'markets':0,'events':0,'mean_pp':None,'ci95_pp':None}
    means=frame.groupby('market_key').agg(value=(column,'mean'),event=('cluster_key','first'))
    mean=float(means.value.mean())
    groups=means.groupby('event').value.apply(lambda values:float((values-mean).sum()))
    se=math.sqrt(len(groups)/(len(groups)-1)*float(np.sum(groups**2))/len(means)**2) if len(groups)>1 else None
    return {'observations':len(frame),'markets':len(means),'events':len(groups),'mean_pp':mean,
            'ci95_pp':[mean-1.96*se,mean+1.96*se] if se is not None else None,
            'median_market_pp':float(means.value.median()),'positive_market_fraction':float((means.value>0).mean())}


def analyze_marks(marks,signals,forecasts,start,asof):
    import numpy as np
    import pandas as pd
    from scripts.analyze_market_maker_utility import _horizon_frame,HORIZON_DELTAS
    from scripts.analyze_polymarket_strategy_flow import derive_signal_fields,build_v1_observable_candidates
    stamp=pd.Timestamp(asof)
    sig=derive_signal_fields(marks.loc[marks.research_cohort.eq('signal')].copy())
    v1,funnel=build_v1_observable_candidates(sig)
    fc=marks.loc[marks.research_cohort.eq('forecast')].copy()
    fc['cluster_key']=fc.event_key.fillna(fc.market_key)
    linked_forecast_ids=set(sig.source_forecast_id)
    cohorts={
        'signal_all':sig,
        'signal_edge_10_30_price_band':sig.loc[sig.eligible_edge_10_to_30pp],
        'signal_original_direction_gate':sig.loc[(sig.signal_side.eq('NO') & sig.abs_edge_pp.between(10,30)) |
                                                    (sig.signal_side.eq('YES') & sig.abs_edge_pp.between(20,30))],
        'signal_original_observable_gates':v1,
    }
    tables={}
    for label,frame in cohorts.items():
        tables[label]={}
        for suffix,delta in HORIZON_DELTAS.items():
            valid=frame.loc[frame[f'price_{suffix}_timing_valid'] & (frame.signal_at+delta<=stamp)
                            & (frame.market_close_at>frame.signal_at+delta)].copy()
            tables[label][suffix]={side:stats(valid if side=='ALL' else valid.loc[valid.signal_side.eq(side)],f'toward_q_markout_{suffix}_pp')
                                   for side in ['ALL','YES','NO']}
    for suffix,delta in HORIZON_DELTAS.items():
        strict=_horizon_frame(fc.loc[fc.signal_at+delta<=stamp],suffix,'maker_clean')
        strict['signal_side']=np.where(strict.edge_direction>0,'YES','NO')
        for label,frame in [('forecast_verified_all',strict.loc[strict.q_at_publication_verified.eq(True)]),
                            ('forecast_verified_edge_ge10',strict.loc[strict.q_at_publication_verified.eq(True) & strict.abs_edge_pp.ge(10)]),
                            ('forecast_verified_edge_10_30',strict.loc[strict.q_at_publication_verified.eq(True) & strict.abs_edge_pp.between(10,30)]),
                            ('forecast_eventually_signaled_descriptive_only',strict.loc[strict.q_at_publication_verified.eq(True) & strict.forecast_id.isin(linked_forecast_ids)])]:
            tables.setdefault(label,{})[suffix]={side:stats(frame if side=='ALL' else frame.loc[frame.signal_side.eq(side)],'toward_q_markout_pp')
                                                 for side in ['ALL','YES','NO']}
    lag=(pd.to_datetime(sig.created_at,utc=True)-pd.to_datetime(sig.source_forecast_available_at,utc=True)).dt.total_seconds()/60
    forecast_df=pd.DataFrame(forecasts)
    cohere=pd.to_datetime(forecast_df.latest_coherence_at,utc=True,errors='coerce')
    available=pd.to_datetime(forecast_df.publication_committed_at.fillna(forecast_df.created_at),utc=True)
    diffs=(pd.to_numeric(forecast_df.mutable_current_q)-pd.to_numeric(forecast_df.q_probability)).abs()*100
    verified=forecast_df.q_at_publication_verified.eq(True)
    ordered=forecast_df.assign(available=available).sort_values(['market_key','available'])
    next_at=ordered.groupby('market_key').available.shift(-1)
    next_hours=(next_at-ordered.available).dt.total_seconds()/3600
    refresh={}
    for hours in [6,24]:
        eligible=ordered.available+pd.Timedelta(hours=hours)<=stamp
        refresh[str(hours)+'h']={'right_censoring_eligible':int(eligible.sum()),
                               'updated_fraction':float((next_hours.loc[eligible]<=hours).mean())}
    summary={
        'start':start,'as_of':asof,
        'raw_signals':{'updates':len(signals),'markets':sig.market_key.nunique(),'events':sig.cluster_key.nunique(),
                       'direction_counts':sig.signal_side.value_counts().to_dict(),
                       'category_counts':sig.primary_category.value_counts().to_dict(),
                       'daily_counts':sig.signal_at.dt.strftime('%Y-%m-%d').value_counts().sort_index().to_dict()},
        'raw_forecasts':{'updates':len(forecasts),'markets':forecast_df.market_key.nunique(),
                         'publication_artifact_q_verified':int(verified.sum()),
                         'coherence_after_publication_count':int((cohere>available).sum()),
                         'current_q_differs_from_publication_q_count':int((verified & (diffs>1e-8)).sum()),
                         'q_revision_abs_pp_quantiles':diffs.loc[verified].quantile([.5,.9,1]).to_dict()},
        'signal_publication_lag_minutes':{'median':float(lag.median()),'p90':float(lag.quantile(.9)),
                                          'max':float(lag.max()),'negative_count':int((lag<0).sum())},
        'forecast_refresh':refresh,
        'v1_observable_gate_funnel':funnel,
        'v1_observable_candidates':{'updates':len(v1),'markets':v1.market_key.nunique(),'events':v1.cluster_key.nunique(),
                                    'daily_counts':v1.signal_at.dt.strftime('%Y-%m-%d').value_counts().sort_index().to_dict()},
        'reference_markouts_equal_market_event_clustered':tables,
        'limitations':[
            'No historical executable BBO, quote queues, own fills or maker P&L. Public prices-history is a reference series.',
            'Signal Q and entry price use immutable rounded publication fields. Forecast Q uses atomic published artifact, before later coherence repairs.',
            'Forecast primary rows require verified artifact Q, timing-valid same-source public entry and future marks, and horizon before market close.',
            'Historical repaired-Q version stream is not reconstructed; initial pre-repair Q is not interchangeable with later canonical served Q.',
            'CIs use event-clustered normal approximation on equal-market means, not multiple-testing adjusted; this short window has limited independent events.',
            'Full OOS universe includes later selected survivors in retained graph; market taxonomy/end dates are current graph metadata.',
            'Eventually-signaled forecast subset is retrospective selection used only to separate lag from market mix; it is not a deployable selection rule.',
            'Original observable funnel omits historical unavailable BBO/depth/stability/queue gates; it is not actual entry count.',
        ]}
    return summary


def refresh(driver,start,asof):
    from scripts.analyze_polymarket_strategy_flow import enrich_marks
    output=Path(__file__).parent/'graph-oos-refresh'
    output.mkdir(parents=True,exist_ok=True)
    signals,forecasts=fetch_research_rows(driver,start,asof)
    (output/'graph-source-rows.json').write_text(json.dumps({'signals':signals,'forecasts':forecasts},indent=2,default=str))
    print(json.dumps({'stage':'graph-read-complete','signals':len(signals),'forecasts':len(forecasts),
                      'publication_q_recovered':sum(f['q_at_publication_verified'] for f in forecasts)}),flush=True)
    marks,coverage,prices=enrich_marks(signals+forecasts,
        as_of=datetime.fromisoformat(asof.replace('Z','+00:00')),cache_dir=output/'graph-public-cache',max_workers=4)
    marks.to_parquet(output/'graph-reference-marks.parquet',index=False)
    coverage.to_csv(output/'graph-coverage.csv',index=False)
    summary=analyze_marks(marks,signals,forecasts,start,asof)
    (output/'graph-summary.json').write_text(json.dumps(summary,indent=2,default=lambda value:value.item()))
    return {'output':str(output/'graph-summary.json'),'raw_signals':summary['raw_signals'],
            'raw_forecasts':summary['raw_forecasts'],'signal_publication_lag_minutes':summary['signal_publication_lag_minutes'],
            'v1_observable_gate_funnel':summary['v1_observable_gate_funnel']}


def original_audit(driver):
    import pandas as pd
    source=ANALYTICS/'research/market_maker_utility/2026-08-31/alltime_prices_pm/forecast_marks.parquet'
    saved=pd.read_parquet(source,columns=['forecast_id','q_probability','created_at'])
    ids=saved.forecast_id.tolist()
    query='''MATCH (f:Forecast)-[:ON_MARKET]->(m:Market)
      WHERE f.id IN $ids
      OPTIONAL MATCH (a:ForecastArtifact {key:f.pipelineRunId+'|'+m.id+'|published'})
      RETURN f.id AS forecast_id,f.probability AS current_q,
        f.probabilityBeforeCoherence AS before_first_coherence_q,
        toString(f.coherenceAt) AS latest_coherence_at,
        toString(f.publicationCommittedAt) AS published_at,
        a.payloadJson AS publication_payload_json'''
    rows=[]
    for offset in range(0,len(ids),1000):
        rows.extend(read(driver,query,{'ids':ids[offset:offset+1000]}))
    for row in rows:
        raw=row.pop('publication_payload_json',None)
        payload=json.loads(raw) if raw else {}
        row['publication_q']=payload.get('probability') if payload.get('forecastId')==row['forecast_id'] else None
    joined=saved.merge(pd.DataFrame(rows),on='forecast_id',how='left')
    initial=pd.to_numeric(joined.publication_q,errors='coerce')
    before=pd.to_numeric(joined.before_first_coherence_q,errors='coerce')
    saved_q=pd.to_numeric(joined.q_probability,errors='coerce')
    current=pd.to_numeric(joined.current_q,errors='coerce')
    out={'source':str(source),'saved_forecast_rows':len(saved),'matched_graph_rows':len(rows),
         'publication_artifact_count':int(initial.notna().sum()),
         'saved_q_differs_from_publication_artifact_count':int((initial.notna() & (abs(initial-saved_q)>1e-8)).sum()),
         'saved_q_vs_publication_max_abs_pp':float((abs(initial-saved_q)*100).max()),
         'before_first_coherence_available_count':int(before.notna().sum()),
         'saved_q_differs_from_before_first_coherence_count':int((before.notna() & (abs(before-saved_q)>1e-8)).sum()),
         'saved_q_differs_from_current_q_count':int((current.notna() & (abs(current-saved_q)>1e-8)).sum()),
         'caveats':['A saved Q differing from initial publication establishes revision exposure, not the exact repaired Q first served at every timestamp.',
                    'Latest coherenceAt is overwritten on later repair, so it cannot date the revision used by the Aug31 saved snapshot.',
                    'Atomic publication payload recovers initial committed Q; no full historical coherent-Q revision stream is available here.']}
    target=Path(__file__).parent/'original-analysis-q-provenance.json'
    target.write_text(json.dumps(out,indent=2))
    joined.to_parquet(Path(__file__).parent/'original-analysis-q-provenance.parquet',index=False)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--start', default='2026-08-31T07:21:03Z')
    parser.add_argument('--as-of', default=datetime.now(timezone.utc).isoformat())
    parser.add_argument('--mode', choices=['probe','freshness','refresh','original-audit','summarize'], default='probe')
    args = parser.parse_args()
    if args.mode=='summarize':
        import pandas as pd
        folder=Path(__file__).parent/'graph-oos-refresh'
        raw=json.loads((folder/'graph-source-rows.json').read_text())
        result=analyze_marks(pd.read_parquet(folder/'graph-reference-marks.parquet'),raw['signals'],raw['forecasts'],args.start,args.as_of)
        (folder/'graph-summary.json').write_text(json.dumps(result,indent=2,default=lambda value:value.item()))
    else:
        with connect() as driver:
            result = (freshness(driver,args.as_of) if args.mode=='freshness' else
                      refresh(driver,args.start,args.as_of) if args.mode=='refresh' else
                      original_audit(driver) if args.mode=='original-audit' else probe(driver,args.start,args.as_of))
    print(json.dumps({'start':args.start,'as_of':args.as_of,**result}, indent=2,default=lambda value:value.item()))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Some driver exception strings include connection information.
        print(json.dumps({'error_type': type(exc).__name__, 'code': getattr(exc,'code',None),
                          'frames': [{'file':Path(f.filename).name,'line':f.lineno,'function':f.name}
                                     for f in traceback.extract_tb(exc.__traceback__)]}))
        raise SystemExit(1)

# research/kalshi-commodities/performance/fetch_readonly.py
"""Snapshot public forecast data with read-only Neo4j sessions; no credentials saved."""
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from dotenv import dotenv_values
from neo4j import GraphDatabase

OUT = Path(__file__).resolve().parent
CONFIG = Path('/Users/jordanolmstead/dev/q-trade-analysis/.env')
ASSETS = ['Bitcoin', 'Copper', 'Gold', 'WTI Crude Oil', 'Silver']
QUERIES = {
    'forecasts': """
MATCH (a:Asset)-[:HAS_MARKET]->(m:Market)<-[:ON_MARKET]-(p:Prediction:Forecast)
WHERE a.name IN $assets AND m.venue = 'kalshi'
  AND p.probability IS NOT NULL
  AND coalesce(p.publicationState, 'committed') = 'committed'
  AND NOT p:ManualForecast AND NOT p:ClaudeManual
RETURN DISTINCT a.name AS asset, a.assetKey AS assetKey, p.id AS forecastId,
 m.id AS marketId, m.question AS question, toString(p.createdAt) AS createdAt,
 p.probability AS qProb, p.rawProbability AS qRaw,
 p.calibratedProbabilityGated AS qCalGated, p.yesOddsAtCreation AS yesOdds,
 p.yesBestAskAtCreation AS bestAsk, p.yesBestBidAtCreation AS bestBid,
 p.captureCapacityAt2c AS cap2c, toString(m.endDate) AS endDate,
 m.closed AS closed, m.outcomePrices AS outcomePrices, m.yesOdds AS currentYesOdds
ORDER BY createdAt
""",
    'outcomes': """
MATCH (c:PriceOutcome)
WHERE c.assetKey IN ['commodity:wti','commodity:gold','commodity:copper','crypto:btc','commodity:silver']
 OR c.displayName IN $assets
RETURN properties(c) AS outcome
""",
    'scored_outlooks': """
MATCH (c:PriceOutcome)-[:SETTLES_OUTLOOK]->(o:PriceOutlook)
WHERE c.assetKey IN ['commodity:wti','commodity:gold','commodity:copper','crypto:btc','commodity:silver']
RETURN c.outcomeId AS outcomeId,o.outlookId AS outlookId,o.assetKey AS assetKey,
 o.seriesId AS seriesId,o.basisId AS basisId,o.referenceBasis AS referenceBasis,
 o.basisStatus AS basisStatus,o.settlementSpecId AS settlementSpecId,
 o.observable AS observable,o.mode AS mode,
 o.legsJson AS legsJson,o.directionalTakeJson AS directionalTakeJson,
 o.spotAtObs AS spotAtObs,o.medianPrice AS medianPrice,o.p10 AS p10,o.p25 AS p25,
 o.p75 AS p75,o.p90 AS p90,o.backfilled AS backfilled,
 toString(o.publishedAt) AS publishedAt,toString(o.observedAt) AS observedAt,
 toString(o.anchorAt) AS anchorAt,o.anchorDate AS anchorDate,
 o.horizonDays AS horizonDays,o.poolVersion AS poolVersion,o.decideVersion AS decideVersion
""",
    'outlook_coverage': """
MATCH (o:PriceOutlook)
WHERE o.assetClass IN ['crypto','commodity']
RETURN o.assetKey AS assetKey, o.displayName AS asset, o.referenceBasis AS referenceBasis,
 o.basisId AS basisId, o.mode AS mode, o.observable AS observable,
 count(o) AS rows, min(toString(o.publishedAt)) AS firstPublished,
 max(toString(o.publishedAt)) AS lastPublished
ORDER BY asset,referenceBasis
""",
    'horizon_outlooks': """
MATCH (c:PriceOutcome)
WHERE c.assetKey IN ['commodity:wti','commodity:gold','commodity:copper','crypto:btc','commodity:silver']
UNWIND [6,24] AS horizonHours
MATCH (o:PriceOutlook {seriesId:c.seriesId,anchorDate:c.anchorDate})
WHERE o.publishedAt <= c.anchorAt-duration({hours:horizonHours})
 AND coalesce(o.backfilled,false)=false
WITH c,horizonHours,o ORDER BY o.publishedAt DESC
WITH c,horizonHours,head(collect(o)) AS o
RETURN c.outcomeId AS outcomeId,c.assetKey AS assetKey,c.settlementBasis AS settlementBasis,
 c.anchorDate AS anchorDate,c.settlePrice AS settlePrice,horizonHours,
 o.outlookId AS outlookId,o.medianPrice AS medianPrice,o.p10 AS p10,o.p25 AS p25,
 o.p75 AS p75,o.p90 AS p90,toString(o.publishedAt) AS publishedAt,
 toString(o.anchorAt) AS anchorAt,o.basisId AS basisId,o.referenceBasis AS referenceBasis,
 o.basisStatus AS basisStatus,o.settlementSpecId AS settlementSpecId
""",
    'outcome_coverage': """
MATCH (c:PriceOutcome)
WHERE c.assetClass IN ['crypto','commodity']
RETURN c.assetKey AS assetKey,c.displayName AS asset,c.settlementBasis AS settlementBasis,
 count(c) AS rows,min(c.anchorDate) AS firstAnchor,max(c.anchorDate) AS lastAnchor
ORDER BY asset,settlementBasis
""",
}


def encode(v):
    if hasattr(v, 'iso_format'):
        return v.iso_format()
    return str(v)


def main():
    config = dotenv_values(CONFIG)
    manifest = {'retrievedAt': datetime.now(timezone.utc).isoformat(), 'assets': ASSETS}
    (OUT / 'queries.json').write_text(json.dumps(QUERIES, indent=2))
    with GraphDatabase.driver(config['NEO4J_URI'],
                             auth=(config['NEO4J_USER'], config['NEO4J_PASSWORD']),
                             connection_timeout=20) as driver:
        with driver.session(database=config.get('NEO4J_DATABASE', 'neo4j'),
                            default_access_mode='READ') as session:
            for name, query in QUERIES.items():
                rows = [record.data() for record in session.run(query, assets=ASSETS)]
                if name == 'forecasts':
                    # Settlement metadata is public venue material; nested JSON is retained.
                    pd.DataFrame(rows).to_csv(OUT / 'forecasts.csv.gz', index=False)
                else:
                    (OUT / f'{name}.json').write_text(json.dumps(rows, default=encode, indent=2))
                manifest[name] = {'rows': len(rows)}
                print(name, len(rows), flush=True)
    (OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()

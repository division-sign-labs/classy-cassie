# research/h200-compute/fetch_forecasts.py
"""Read-only H200 market and forecast audit; credentials stay in sibling .env."""
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from dotenv import dotenv_values
from neo4j import GraphDatabase

OUT = Path(__file__).resolve().parent
QUERIES = {
    'markets': """
MATCH (m:Market)
WHERE toUpper(coalesce(m.question, '')) CONTAINS 'H200'
RETURN m.id AS marketId, m.question AS question, m.venue AS venue,
 toString(m.endDate) AS endDate, m.closed AS closed,
 m.outcomePrices AS outcomePrices, m.yesOdds AS currentYesOdds,
 m.slug AS slug, m.volume AS volume, m.liquidity AS liquidity
ORDER BY endDate,marketId
""",
    'forecasts': """
MATCH (p:Prediction:Forecast)-[:ON_MARKET]->(m:Market)
WHERE m.venue = 'kalshi' AND toUpper(coalesce(m.question, '')) CONTAINS 'H200'
 AND p.probability IS NOT NULL
 AND coalesce(p.publicationState, 'committed') = 'committed'
 AND NOT p:ManualForecast AND NOT p:ClaudeManual
RETURN DISTINCT p.id AS forecastId, m.id AS marketId, m.question AS question,
 toString(p.createdAt) AS createdAt, p.probability AS qProb,
 p.rawProbability AS qRaw, p.calibratedProbabilityGated AS qCalGated,
 p.yesOddsAtCreation AS yesOdds, p.yesBestAskAtCreation AS bestAsk,
 p.yesBestBidAtCreation AS bestBid, p.captureCapacityAt2c AS cap2c,
 toString(m.endDate) AS endDate, m.closed AS closed, m.outcomePrices AS outcomePrices,
 m.yesOdds AS currentYesOdds, p.thesis AS thesis, p.bluf AS bluf,
 p.forecastStatus AS forecastStatus
ORDER BY createdAt,forecastId
""",
}


def main():
    config = dotenv_values('/Users/jordanolmstead/dev/q-trade-analysis/.env')
    manifest = {'retrievedAt': datetime.now(timezone.utc).isoformat(), 'method': 'Neo4j read session, committed non-manual forecasts'}
    (OUT/'queries.json').write_text(json.dumps(QUERIES, indent=2)+'\n')
    with GraphDatabase.driver(config['NEO4J_URI'], auth=(config['NEO4J_USER'], config['NEO4J_PASSWORD']), connection_timeout=20) as driver:
        with driver.session(database=config.get('NEO4J_DATABASE', 'neo4j'), default_access_mode='READ') as session:
            for name, query in QUERIES.items():
                rows = [r.data() for r in session.run(query)]
                if name == 'forecasts':
                    pd.DataFrame(rows).to_csv(OUT/'forecasts.csv.gz', index=False)
                else:
                    (OUT/f'{name}.json').write_text(json.dumps(rows, indent=2, default=str)+'\n')
                manifest[name] = {'rows': len(rows)}
                print(name, len(rows), flush=True)
    (OUT/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')


if __name__ == '__main__':
    main()

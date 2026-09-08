# research/h200-compute/fetch_stages.py
"""Read forecast stage provenance for the already identified H200 cohort."""
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from dotenv import dotenv_values
from neo4j import GraphDatabase

OUT = Path(__file__).resolve().parent
QUERY = """
MATCH (p:Prediction:Forecast)
WHERE p.id IN $ids
RETURN p.id AS forecastId, p.probability AS storedProbabilityNow,
 p.probabilityBeforeCoherence AS probabilityBeforeCoherence,
 p.probabilityCoherent AS probabilityCoherent,
 p.coherenceMethod AS coherenceMethod, p.coherenceVersion AS coherenceVersion,
 toString(p.coherenceAt) AS coherenceAt,
 p.forecasterId AS forecasterId, p.forecastMode AS forecastMode,
 p.adapterModelPath AS adapterModelPath
"""


def main():
    config = dotenv_values('/Users/jordanolmstead/dev/q-trade-analysis/.env')
    ids = pd.read_csv(OUT/'forecasts.csv.gz').forecastId.tolist()
    with GraphDatabase.driver(config['NEO4J_URI'], auth=(config['NEO4J_USER'], config['NEO4J_PASSWORD']), connection_timeout=20) as driver:
        with driver.session(database=config.get('NEO4J_DATABASE', 'neo4j'), default_access_mode='READ') as session:
            rows = [r.data() for r in session.run(QUERY, ids=ids)]
    (OUT/'stages.json').write_text(json.dumps({'retrievedAt': datetime.now(timezone.utc).isoformat(), 'query': QUERY, 'records': rows}, indent=2, default=str)+'\n')
    print('stage rows', len(rows))


if __name__ == '__main__':
    main()

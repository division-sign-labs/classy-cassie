# research/kalshi-commodities/performance/fetch_kalshi_public.py
"""Read public Kalshi metadata for the immutable forecast snapshot."""
import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

OUT = Path(__file__).resolve().parent
BASE = 'https://api.elections.kalshi.com/trade-api/v2'


def get(path):
    for attempt in range(3):
        try:
            request = urllib.request.Request(BASE + path, headers={'User-Agent': 'QuotientResearch/1.0'})
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read())
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def main():
    forecasts = pd.read_csv(OUT / 'forecasts.csv.gz')
    tickers = sorted(forecasts.marketId.str.removeprefix('kalshi:').unique())
    cache = OUT / 'kalshi_markets.json'
    result = {row['ticker']:row for row in json.loads(cache.read_text())} if cache.exists() else {}
    # Resume an export / add assets without repeating successful public API reads.
    todo = [ticker for ticker in tickers if ticker not in result]
    for offset in range(0, len(todo), 50):
        query = urllib.parse.urlencode({'tickers': ','.join(todo[offset:offset+50]), 'limit': 1000})
        for market in get('/markets?' + query).get('markets', []):
            result[market['ticker']] = market
        print('metadata', min(offset + 50, len(todo)), 'of', len(todo), flush=True)
        time.sleep(0.15)
    (OUT / 'kalshi_markets.json').write_text(json.dumps(list(result.values()), indent=2))
    (OUT / 'kalshi_manifest.json').write_text(json.dumps({
        'retrievedAt': datetime.now(timezone.utc).isoformat(),
        'requested': len(tickers), 'returned': len(result),
        'missing': sorted(set(tickers) - result.keys()),
        'endpoint': BASE + '/markets?tickers=<comma-separated-public-tickers>&limit=1000',
    }, indent=2))


if __name__ == '__main__':
    main()

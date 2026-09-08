// research/mm-strategy-review/market-screen.mjs
// Deterministic static screening of saved public books; no network or account calls.
import { readFile, writeFile } from 'node:fs/promises';
const dir = new URL('./', import.meta.url);
const load = async (name) => JSON.parse(await readFile(new URL(name, dir), 'utf8'));
const quotes = await load('market-q-universe.json');
const q = await load('q-signals.json');
const current = await load('market-existing-mm.json');
const graphQuotes = await load('market-graph-liquid.json');
const graph = await load('graph-current-liquid-sample.json');
const fullGraph = await load('graph-current-forecasts.json');
const freshQuotes = await load('market-all-fresh-q.json');
const exactQ = await load('q-live-mm.json');
const exactById = new Map(exactQ.data.results.map(x=>[String(x.nativeMarketId),x]));
const graphRows = new Map(fullGraph.markets.map((x) => [String(x.native_market_id), x]));
const signals = new Map(q.data.signals.map((x) => [String(x.market.nativeMarketId), x]));
const EPS = 1e-9;
const rounded = (n, d = 3) => Number.isFinite(n) ? Number(n.toFixed(d)) : null;
const within = (n, low, high) => Number.isFinite(n) && n + EPS >= low && n <= high + EPS;
const failures = (gates) => Object.entries(gates).filter(([, pass]) => !pass).map(([key]) => key);
function screen(row, graphMode = false) {
  const m = row.market, y = row.yes, n = row.no;
  const now = Date.parse(y?.receivedAt ?? quotes.startedAt);
  const g = graphRows.get(m?.id);
  let s = signals.get(m?.id);
  const empty = !m || !y || !n;
  if (empty) return { id: m?.id ?? row.inputIdentity, question:m?.question, active:m?.active, closed:m?.closed, acceptingOrders:m?.acceptingOrders, errors: row.errors, inactive: row.inactive ?? false };
  const yesMid = (y.bestBid + y.bestAsk) / 2, noMid = (n.bestBid + n.bestAsk) / 2;
  if (graphMode && g) s = { side:Number(g.current_q) >= yesMid ? 'YES' : 'NO', latest_q:g.current_q, forecast_updated_at:g.forecast_created_at, is_active:true };
  const base = {
    id: m.id, question: m.question, url: m.url, group: row.group,
    bookObservedAt:y.receivedAt, reusedFrom:row.reusedFrom??null,
    graphCategory: g?.primary_category ?? null, graphEvent: g?.event_key ?? null,
    inPublishedSignalFeed: signals.has(m.id),
    endDate: m.endDate, hoursToEnd: rounded((Date.parse(m.endDate) - now) / 3600000),
    volume24hUsd: m.volume24hUsd,
    yes: { bid: y.bestBid, ask: y.bestAsk, spreadPp: rounded(y.spread * 100), tick: y.tickSize, minShares: y.minOrderSize, topBidUsd: y.topBidUsd, topAskUsd: y.topAskUsd, depth2cUsd: y.bidDepth2cUsd },
    no: { bid: n.bestBid, ask: n.bestAsk, spreadPp: rounded(n.spread * 100), tick: n.tickSize, minShares: n.minOrderSize, topBidUsd: n.topBidUsd, topAskUsd: n.topAskUsd, depth2cUsd: n.bidDepth2cUsd },
    tradeRows1h: row.trades?.last1h.rows ?? null, tradeNotional1hUsd: row.trades?.last1h.notionalUsd ?? null,
    tradeRows24h: row.trades?.last24h.rows ?? null, tradeWindowTruncated: row.trades?.truncatedAt1000 ?? null,
    lastTradeAt: row.trades?.newestTradeAt ?? null,
    feesEnabled: m.feesEnabled, feeSchedule: m.feeSchedule,
    rewardsDailyUsd: m.currentRewardDailyRate, rewardsMinShares: m.rewardsMinSize,
    rewardsMaxSpreadCents: m.rewardsMaxSpreadCents,
    rewardMinimumPairBuyCostUsd: row.illustration?.rewardMinimumPairBuyCostUsd ?? null,
  };
  const basic = {
    activeBinaryBooks: m.active && !m.closed && !m.archived && m.acceptingOrders && m.enableOrderBook && y.bestBid > 0 && n.bestBid > 0 && y.bestAsk > y.bestBid && n.bestAsk > n.bestBid,
    noSportsMetadata: !m.sportsMetadataPresent || m.feeType?.startsWith('finance_'),
    knownTickMinSize: y.tickSize > 0 && n.tickSize > 0 && y.minOrderSize > 0 && n.minOrderSize > 0,
    atLeast36hToEnd: Date.parse(m.endDate) - now + EPS >= 36 * 3600000,
  };
  const pairedPrice = y.bestBid + n.bestBid;
  const pairShares30 = Math.floor(Math.min(30 / Math.max(y.bestBid, n.bestBid), y.bidDepth2cUsd * .1 / y.bestBid, n.bidDepth2cUsd * .1 / n.bestBid) * 100) / 100;
  const tsGates = {
    ...basic, volume1000: m.volume24hUsd >= 1000,
    bothDepth300: Math.min(y.bidDepth2cUsd, n.bidDepth2cUsd) + EPS >= 300,
    bothMidAtLeast5c: Math.min(yesMid, noMid) + EPS >= .05,
    bothSpreadAtMost6pp: Math.max(y.spread, n.spread) <= .06 + EPS,
    oneTickPairedSpread: 1 - pairedPrice + EPS >= Math.max(y.tickSize, n.tickSize),
    illustrative30TicketClearsMinSize: pairShares30 + EPS >= Math.max(y.minOrderSize, n.minOrderSize),
  };
  base.twoSided = { passStatic: failures(tsGates).length === 0, failedGates: failures(tsGates), gates: tsGates, illustrativeEqualShares: pairShares30, illustrativePairCostUsd: rounded(pairShares30 * pairedPrice, 2), illustrativeCompletePairGrossUsd: rounded(pairShares30 * (1 - pairedPrice), 3), bothRewardSizeQualifiedAtIllustrativeTicket: m.rewardsMinSize > 0 && pairShares30 >= m.rewardsMinSize };
  const exact = exactById.get(m.id);
  const referenceQ = exact?.forecast?.probability ?? g?.current_q ?? s?.latest_q;
  const referenceQAt = exact?.forecast?.created_at ?? g?.forecast_created_at ?? s?.forecast_updated_at;
  if (Number.isFinite(referenceQ)) base.qReference = { qYes:referenceQ, forecastAt:referenceQAt, ageHours:rounded((now-Date.parse(referenceQAt))/3600000), absoluteLiveMidGapPp:rounded(100*Math.abs(referenceQ-yesMid)), source:exact?'exact-current-forecast-API':g?'graph-current-forecast':'published-signal-latest-q' };
  if (s) {
    const side = s.side.toUpperCase(), book = side === 'YES' ? y : n;
    const qSide = side === 'YES' ? Number(s.latest_q) : 1 - Number(s.latest_q);
    const mid = (book.bestBid + book.bestAsk) / 2, edge = 100 * (qSide - mid);
    const forecastAgeHours = (now - Date.parse(s.forecast_updated_at)) / 3600000;
    const minEdge = side === 'YES' ? 20 : 10;
    const gates = {
      ...basic,
      activeSignalOrCounterfactualGraphForecast: s.is_active === true,
      latestForecastWithin6h: within(forecastAgeHours, 0, 6),
      selectedMid12_5to87_5c: within(mid, .125, .875),
      selectedQAtLeast55pct: qSide + EPS >= .55,
      sideSpecificLiveMidEdge: within(edge, minEdge, 30),
      volume2500: m.volume24hUsd >= 2500,
      selectedSpreadAtMost4pp: book.spread <= .04 + EPS,
      selectedDepth100: book.bidDepth2cUsd + EPS >= 100,
    };
    base.original = {
      side, qYes: Number(s.latest_q), selectedQ: rounded(qSide, 6), forecastUpdatedAt: s.forecast_updated_at, forecastAgeHours: rounded(forecastAgeHours),
      discoveryBasis: graphMode ? 'Counterfactual wider graph discovery; original feed-only bot cannot select unpublished forecasts' : 'Actual published active signal feed',
      absoluteQYesToLiveYesMidGapPp: rounded(100*Math.abs(Number(s.latest_q)-yesMid)),
      selectedMid: rounded(mid, 4), edgePpAtMid: rounded(edge), edgePpAtBid: rounded(100 * (qSide - book.bestBid)), edgePpAtAsk: rounded(100 * (qSide - book.bestAsk)),
      drawdownRiskElevated: s.drawdown_risk_elevated, passStatic: failures(gates).length === 0,
      failedGates: failures(gates), gates,
      additionalCassieDepth2500Pass: book.bidDepth2cUsd >= 2500,
      unknownHistoryGates: ['30-second stable entry observation', 'realized volatility/trailing baseline regime', 'shock/cooldown and prior-cycle state', 'live wallet reservations/loss/exposure/diversification controls'],
    };
  }
  return base;
}
const rows = quotes.markets.map((r)=>screen(r)), existing = current.markets.map((r)=>screen(r)), graphScreens = graphQuotes.markets.map((r)=>screen(r,true)), freshScreens=freshQuotes.markets.map(r=>screen(r,true));
const reasons = (strategy) => rows.reduce((counts, r) => { for (const reason of r[strategy]?.failedGates ?? []) counts[reason] = (counts[reason] ?? 0) + 1; return counts; }, {});
const passes = (strategy) => rows.filter((r) => r[strategy]?.passStatic).map((r) => r.id);
const output = {
  analyzedAt: new Date().toISOString(), venueSnapshotAt: quotes.startedAt, qSnapshotAt: q.fetchedAt,
  methodology: {
    original: 'Historical requested policy: NO edge10–30pp, YES20–30pp inclusive; latest_q on YES scale transformed to published signal side; live selected-book midpoint is primary edge/price reference. Bid/ask edge provided as sensitivity, not substituted for midpoint. Static pass is not full strategy eligibility.',
    twoSided: 'Illustrative flat-wallet static screen: >=36h, volume>=1000, both exit bids depth2c>=300, both mids>=.05, both spreads<=6pp, one-tick pair spread, known venue minimums, equal-share tickets capped at $30 maximum per leg and10% depth. No Q gate. Does not run full controller/capacity/generation/reservation logic.',
    economics: 'Paired gross is conditional on both outcome bids filling in equal quantities and eventual capital release. Not an instantaneous arbitrage or a fill-rate/backtest result.',
    incentives: 'A displayed market daily reward is the entire pool, not bot income. Minimum qualifying size is distinct from venue min order size; size-qualified here does not prove all reward-scoring requirements.',
  },
  summary: { markets: rows.length, bothBooks: rows.filter((x) => x.yes && x.no).length, originalStaticPassIds: passes('original'), originalPlusCassie2500Ids: rows.filter((x) => x.original?.passStatic && x.original.additionalCassieDepth2500Pass).map((x) => x.id), twoSidedStaticPassIds: passes('twoSided'), originalFailures: reasons('original'), twoSidedFailures: reasons('twoSided'), zeroTrades1h: rows.filter((x) => x.tradeRows1h === 0).length, latest1000Truncated: rows.filter((x) => x.tradeWindowTruncated).length },
  graphSummary: { sampled:graphScreens.length, activeBothBooks:graphScreens.filter(x=>x.yes&&x.no).length, inactive:graphScreens.filter(x=>x.inactive).length, twoSidedStaticPassIds:graphScreens.filter(x=>x.twoSided?.passStatic).map(x=>x.id), counterfactualOriginalStaticPassIds:graphScreens.filter(x=>x.original?.passStatic).map(x=>x.id), fresh6h:graphScreens.filter(x=>x.original?.forecastAgeHours<=6).length, fresh6hTwoSided:graphScreens.filter(x=>x.original?.forecastAgeHours<=6&&x.twoSided?.passStatic).map(x=>x.id), fresh6hTwoSidedWithin5ppOfQ:graphScreens.filter(x=>x.original?.forecastAgeHours<=6&&x.twoSided?.passStatic&&x.original.absoluteQYesToLiveYesMidGapPp<=5).map(x=>x.id), fresh6hTwoSidedWithin10ppOfQ:graphScreens.filter(x=>x.original?.forecastAgeHours<=6&&x.twoSided?.passStatic&&x.original.absoluteQYesToLiveYesMidGapPp<=10).map(x=>x.id) },
  allFreshSummary: { cohortAsOf:fullGraph.as_of, sampled:freshScreens.length, reused:freshQuotes.reusedMarkets, bothBooks:freshScreens.filter(x=>x.yes&&x.no).length, inactive:freshScreens.filter(x=>x.inactive).length, volume1000Live:freshScreens.filter(x=>x.volume24hUsd>=1000).map(x=>x.id), twoSidedStaticPassIds:freshScreens.filter(x=>x.twoSided?.passStatic).map(x=>x.id), counterfactualOriginalStaticPassIds:freshScreens.filter(x=>x.original?.passStatic).map(x=>x.id), failureCounts:freshScreens.reduce((a,x)=>{for(const r of x.twoSided?.failedGates??[])a[r]=(a[r]??0)+1;return a;},{}) },
  markets: rows, existingMm: existing, graphMarkets: graphScreens, allFreshMarkets:freshScreens,
};
await writeFile(new URL('market-screen-results.json', dir), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output.summary, null, 2));
console.log(JSON.stringify(output.graphSummary,null,2));
console.log(JSON.stringify(output.allFreshSummary,null,2));
console.log(JSON.stringify(rows.filter((x) => x.original?.passStatic).map((x) => ({ id:x.id,question:x.question,original:x.original,twoSided:x.twoSided,yes:x.yes,no:x.no,tradeRows1h:x.tradeRows1h })), null, 2));

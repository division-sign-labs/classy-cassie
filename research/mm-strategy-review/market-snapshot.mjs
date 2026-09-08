// research/mm-strategy-review/market-snapshot.mjs
// Public GETs only. No wallet access, credentials, orders, or SDK dependency.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const flags = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const i = arg.indexOf('=');
  if (i < 0 || !arg.startsWith('--')) throw new Error('Use --input=PATH --label=NAME');
  return [arg.slice(2, i), arg.slice(i + 1)];
}));
if (!/^[a-z0-9-]+$/.test(flags.label ?? '')) throw new Error('Safe output label required');
const limit = Math.min(100, Math.max(1, Number(flags.limit ?? 60)));
if (!Number.isInteger(limit)) throw new Error('Invalid limit');
const startedAt = new Date().toISOString();
const nowSec = Math.floor(Date.now() / 1000);
const today = startedAt.slice(0, 10);
const requests = [];
const num = (v) => v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const round = (v, digits = 6) => v === null || !Number.isFinite(v) ? null : Number(v.toFixed(digits));
const array = (v) => typeof v === 'string' ? JSON.parse(v) : v;

async function get(url) {
  if (!/^https:\/\/(gamma-api|clob|data-api)\.polymarket\.com\//.test(url)) throw new Error('Only public Polymarket hosts allowed');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const began = Date.now();
    try {
      const response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      requests.push({ url, attempt, status: response.status, fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - began });
      if (!response.ok) {
        const e = new Error(`HTTP ${response.status}`);
        e.retryable = response.status === 429 || response.status >= 500;
        throw e;
      }
      return await response.json();
    } catch (e) {
      if (attempt === 3 || e.retryable === false) throw e;
      await new Promise((done) => setTimeout(done, 200 * attempt));
    }
  }
}

function inputRows(raw) {
  if (Array.isArray(raw)) return raw;
  for (const key of ['markets', 'signals', 'items', 'results', 'data']) {
    if (raw?.[key]) { const rows = inputRows(raw[key]); if (rows.length) return rows; }
  }
  return [];
}
function identity(row) {
  if (typeof row === 'string') return /^0x[a-f0-9]{64}$/i.test(row) ? { conditionId: row } : { id: row.replace(/^polymarket:/, '') };
  const candidate = row.market ?? row;
  return {
    id: candidate.nativeMarketId ?? candidate.native_market_id ?? candidate.marketId ?? candidate.market_id ?? candidate.marketKey?.replace(/^polymarket:/, ''),
    conditionId: candidate.conditionId ?? candidate.condition_id ?? row.condition_id,
  };
}
function bookSummary(raw, token) {
  if (String(raw.asset_id) !== token || !Array.isArray(raw.bids) || !Array.isArray(raw.asks)) throw new Error('Book identity/shape mismatch');
  const levels = (rows, sign) => rows.map((x) => ({ price: Number(x.price), size: Number(x.size) }))
    .filter((x) => Number.isFinite(x.price) && x.price > 0 && x.price < 1 && Number.isFinite(x.size) && x.size > 0)
    .sort((a, b) => sign * (a.price - b.price));
  const bids = levels(raw.bids, -1), asks = levels(raw.asks, 1);
  const bid = bids[0] ?? null, ask = asks[0] ?? null;
  const sum = (rows) => round(rows.reduce((s, x) => s + x.price * x.size, 0), 2);
  const spread = bid && ask ? round(ask.price - bid.price) : null;
  return {
    tokenId: token, receivedAt: new Date().toISOString(), timestamp: raw.timestamp,
    minOrderSize: num(raw.min_order_size), tickSize: num(raw.tick_size), lastTradePrice: num(raw.last_trade_price),
    bestBid: bid?.price ?? null, bestAsk: ask?.price ?? null, spread, spreadTicks: spread === null ? null : round(spread / Number(raw.tick_size)),
    topBidShares: bid?.size ?? 0, topAskShares: ask?.size ?? 0,
    topBidUsd: bid ? round(bid.price * bid.size, 2) : 0, topAskUsd: ask ? round(ask.price * ask.size, 2) : 0,
    bidDepth1cUsd: bid ? sum(bids.filter((x) => x.price >= bid.price - .01 - 1e-9)) : 0,
    bidDepth2cUsd: bid ? sum(bids.filter((x) => x.price >= bid.price - .02 - 1e-9)) : 0,
    askDepth2cUsd: ask ? sum(asks.filter((x) => x.price <= ask.price + .02 + 1e-9)) : 0,
    bestTenBids: bids.slice(0, 10), bestTenAsks: asks.slice(0, 10),
  };
}
function tradeSummary(raw, conditionId, tokens) {
  if (!Array.isArray(raw)) throw new Error('Invalid public trades response');
  if (raw.some((x) => x.conditionId?.toLowerCase() !== conditionId.toLowerCase())) throw new Error('Trade condition mismatch');
  const trades = raw.filter((x) => tokens.includes(String(x.asset)) && x.timestamp >= nowSec - 86400 && x.timestamp <= nowSec)
    .map((x) => ({ timestamp: x.timestamp, tokenId: String(x.asset), outcome: x.outcome, side: x.side, size: Number(x.size), price: Number(x.price) }));
  const stats = (rows) => ({ rows: rows.length, shares: round(rows.reduce((s, x) => s + x.size, 0), 2), notionalUsd: round(rows.reduce((s, x) => s + x.size * x.price, 0), 2) });
  return {
    takerOnly: true, requestedWindowHours: 24, returnedRows: raw.length, truncatedAt1000: raw.length >= 1000,
    newestTradeAt: trades.length ? new Date(Math.max(...trades.map((x) => x.timestamp)) * 1000).toISOString() : null,
    oldestTradeAt: trades.length ? new Date(Math.min(...trades.map((x) => x.timestamp)) * 1000).toISOString() : null,
    last15m: stats(trades.filter((x) => x.timestamp >= nowSec - 900)),
    last1h: stats(trades.filter((x) => x.timestamp >= nowSec - 3600)),
    last24h: stats(trades),
    byToken: tokens.map((tokenId) => ({ tokenId, ...stats(trades.filter((x) => x.tokenId === tokenId)), buyRows: trades.filter((x) => x.tokenId === tokenId && x.side === 'BUY').length, sellRows: trades.filter((x) => x.tokenId === tokenId && x.side === 'SELL').length })),
    recentRows: trades.slice(0, 20),
  };
}
async function sample(input) {
  const ref = identity(input);
  const result = { inputIdentity: ref, group: flags.group ?? 'q-linked', errors: [] };
  try {
    let m;
    if (/^\d+$/.test(String(ref.id))) m = await get(`https://gamma-api.polymarket.com/markets/${ref.id}`);
    else if (/^0x[a-f0-9]{64}$/i.test(ref.conditionId ?? '')) {
      const rows = await get(`https://gamma-api.polymarket.com/markets?condition_ids=${ref.conditionId}&limit=2`);
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Expected unique Gamma condition match');
      [m] = rows;
    } else throw new Error('Missing recognized Gamma ID/condition ID');
    if (ref.conditionId && ref.conditionId.toLowerCase() !== m.conditionId?.toLowerCase()) throw new Error('Input/Gamma condition mismatch');
    const outcomes = array(m.outcomes), tokens = array(m.clobTokenIds);
    if (!Array.isArray(outcomes) || !Array.isArray(tokens) || outcomes.length !== 2 || tokens.length !== 2) throw new Error('Not binary');
    const yes = tokens[outcomes.findIndex((x) => x.toUpperCase() === 'YES')];
    const no = tokens[outcomes.findIndex((x) => x.toUpperCase() === 'NO')];
    if (!yes || !no || yes === no) throw new Error('Not explicitly labeled YES/NO');
    result.market = {
      id: String(m.id), conditionId: m.conditionId, question: m.question, slug: m.slug,
      url: `https://polymarket.com/market/${m.slug}`, endDate: m.endDate,
      active: m.active, closed: m.closed, archived: m.archived, acceptingOrders: m.acceptingOrders, enableOrderBook: m.enableOrderBook,
      // Finance price markets also populate gameStartTime; it is not a sports classifier.
      sportsMetadataPresent: Boolean(m.feeType === 'sports_fees' || m.feeType?.startsWith('sports_') || /^(moneyline|spreads|totals|both_teams_to_score|draw_no_bet|double_chance|child_moneyline|tennis_set_handicap|tennis_totals)$/i.test(m.sportsMarketType ?? '')),
      category: m.category ?? null, feeType: m.feeType ?? null,
      eventIds: (m.events ?? []).map((e) => String(e.id)),
      volume24hUsd: num(m.volume24hr), liquidityReportedUsd: num(m.liquidity),
      minOrderSize: num(m.orderMinSize), tickSize: num(m.orderPriceMinTickSize), negRisk: m.negRisk,
      feesEnabled: m.feesEnabled, feeSchedule: m.feeSchedule ?? null,
      rewardsMinSize: num(m.rewardsMinSize), rewardsMaxSpreadCents: num(m.rewardsMaxSpread),
      currentRewardAllocations: (m.clobRewards ?? []).filter((r) => r.startDate <= today && (!r.endDate || r.endDate >= today)),
      currentRewardDailyRate: (m.clobRewards ?? []).filter((r) => r.startDate <= today && (!r.endDate || r.endDate >= today)).reduce((s, r) => s + Number(r.rewardsDailyRate), 0),
    };
    if (!m.active || m.closed || m.archived || !m.acceptingOrders || !m.enableOrderBook) { result.inactive = true; return result; }
    const jobs = [
      ['yes', `https://clob.polymarket.com/book?token_id=${yes}`, (x) => bookSummary(x, yes)],
      ['no', `https://clob.polymarket.com/book?token_id=${no}`, (x) => bookSummary(x, no)],
      ['clobInfo', `https://clob.polymarket.com/clob-markets/${m.conditionId}`, (x) => x],
      ['trades', `https://data-api.polymarket.com/trades?market=${m.conditionId}&takerOnly=true&start=${nowSec - 86400}&end=${nowSec}&limit=1000`, (x) => tradeSummary(x, m.conditionId, [yes, no])],
    ];
    await Promise.all(jobs.map(async ([key, url, normalize]) => {
      try { result[key] = normalize(await get(url)); }
      catch (e) { result.errors.push({ component: key, message: e.message }); }
    }));
    if (result.yes?.bestBid && result.no?.bestBid) {
      const pairCost = result.yes.bestBid + result.no.bestBid;
      result.illustration = {
        label: 'Conditional arithmetic only: same share count on both outcomes must fill; no fill probability or realized return assumed.',
        pairBuyCostAtCurrentBids: round(pairCost), grossPayoffMinusCostPerCompletedPair: round(1 - pairCost),
        rewardMinimumPairBuyCostUsd: round(Number(m.rewardsMinSize ?? 0) * pairCost, 2),
        ticket20UsdShareCountYes: Math.floor(20 / result.yes.bestBid * 100) / 100,
        ticket20UsdShareCountNo: Math.floor(20 / result.no.bestBid * 100) / 100,
      };
    }
  } catch (e) { result.errors.push({ component: 'metadata', message: e.message }); }
  return result;
}

if (!flags.input) throw new Error('Input snapshot required; no implicit top-volume substitute');
const source = JSON.parse(await readFile(resolve(flags.input), 'utf8'));
const allRows = inputRows(source);
const uniqueRows = [...new Map(allRows.map((x) => { const r = identity(x); return [r.conditionId ?? r.id, x]; })).values()];
if (!uniqueRows.length) throw new Error('No input market rows found');
const selected = uniqueRows.slice(0, limit), results = [];
const reusable = new Map();
for (const name of (flags.reuse ?? '').split(',').filter(Boolean)) {
  if (!/^market-[a-z0-9-]+\.json$/.test(name)) throw new Error('Reuse files must be public market snapshots');
  const saved = JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
  for (const row of saved.markets ?? []) if (row.market?.id) reusable.set(row.market.id, { ...row, reusedFrom: name, group:flags.group??'q-linked' });
}
// At most three markets and twelve public GETs in flight; each GET <=3 attempts x10s.
for (let i = 0; i < selected.length; i += 3) {
  results.push(...await Promise.all(selected.slice(i, i + 3).map((row)=>reusable.get(String(identity(row).id)) ?? sample(row))));
  console.error(`Public snapshot: ${results.length}/${selected.length}`);
}
const output = {
  startedAt, finishedAt: new Date().toISOString(), source: resolve(flags.input),
  inputRows: allRows.length, uniqueInputMarkets: uniqueRows.length, sampledMarkets: selected.length, reusedMarkets:results.filter(x=>x.reusedFrom).length,
  caveats: ['Not a backtest or proof of maker fill probability/profitability.', 'Books are sequential REST snapshots, not atomic cross-outcome state.', 'Top-level depth is aggregate displayed size, not known queue priority.', 'Public taker trade rows are bounded to latest 1000 within 24h; truncated windows are lower bounds, not full volume.', 'No private account fields or public trader identities are stored.', 'Gross paired spread requires both outcomes to fill in equal quantities and later capital release; a single fill creates directional inventory.'],
  markets: results, requests,
};
const path = new URL(`market-${flags.label}.json`, import.meta.url);
await writeFile(path, JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ path: path.pathname, sampled: results.length, active: results.filter((x) => x.yes && x.no).length, errors: results.flatMap((x) => x.errors).length }));

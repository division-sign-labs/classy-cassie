// research/kalshi-commodities/performance/reconstruct_contract_gates.mjs
// Offline contract-gate reconstruction; current series metadata is an explicit assumption.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { normalizeCommodityContract } from "../../../packages/runtime-node/dist/commodity-data.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const forecastPath = resolve(here, "scored_forecasts.csv.gz");
const marketPath = resolve(here, "kalshi_markets.json");
const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const forecasts = JSON.parse(execFileSync("python3", ["-c", [
  "import csv,gzip,json,sys",
  "with gzip.open(sys.argv[1], 'rt', newline='') as f:",
  " print(json.dumps(list(csv.DictReader(f))))",
].join("\n"), forecastPath], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
const markets = new Map(JSON.parse(readFileSync(marketPath, "utf8")).map(m => [m.ticker, m]));
const assetKeys = { "WTI Crude Oil": "oil", Gold: "gold", Bitcoin: "btc", Copper: "copper", Silver: "silver" };
const allowed = new Set(["KXWTI", "KXWTIW", "KXGOLDD", "KXGOLDW", "KXGOLDMON", "KXBTCD", "KXBTC",
  "KXCOPPERD", "KXCOPPERW", "KXCOPPERMON", "KXSILVERD", "KXSILVERW", "KXSILVERMON"]);
const series = new Map();
const inputs = { forecasts: sha(forecastPath), markets: sha(marketPath),
  normalizer_source: sha(resolve(root, "packages/runtime-node/src/commodity-data.ts")),
  normalizer_built: sha(resolve(root, "packages/runtime-node/dist/commodity-data.js")), series: {} };
const records = [];
for (const f of forecasts) {
  let result;
  const original = markets.get(f.ticker);
  if (!allowed.has(f.series)) result = "unsupported terminal series";
  else if (!original) result = "frozen venue market unavailable";
  else {
    if (!series.has(f.series)) {
      const path = resolve(here, `../settlement/${f.series}-series.json`);
      const value = JSON.parse(readFileSync(path, "utf8"));
      inputs.series[f.series] = sha(path);
      // Current update timestamps cannot establish whether a past forecast was stale then.
      delete value.series.last_updated_ts;
      series.set(f.series, value);
    }
    const market = { ...original, status: "active" };
    const now = Date.parse(f.createdAt);
    const link = { asset: assetKeys[f.asset], marketRef: f.ticker, eventRef: f.event_ticker,
      series: f.series, qYes: Number(f.qProb), forecastAt: now,
      endAt: Date.parse(f.endDate), odds: Number(f.yesOdds), forecastStatus: null };
    if (!Number.isFinite(now) || !Number.isFinite(link.endAt)) throw new Error(`Invalid forecast dates: ${f.forecastId}`);
    result = normalizeCommodityContract(link, { market }, series.get(f.series), now);
  }
  records.push({ forecastId: f.forecastId, asset: f.asset, marketId: f.marketId, ticker: f.ticker,
    eligible: typeof result !== "string", reason: typeof result === "string" ? result : null,
    ...(typeof result !== "string" ? { takerFeeRate: result.takerFeeRate, makerFeeRate: result.makerFeeRate,
      settlementBasis: result.settlementBasis, rulesHash: result.rulesHash } : {}) });
}
const summarize = rows => ({ forecasts: rows.length, markets: new Set(rows.map(r => r.marketId)).size,
  passed_forecasts: rows.filter(r => r.eligible).length,
  passed_markets: new Set(rows.filter(r => r.eligible).map(r => r.marketId)).size,
  reasons: rows.filter(r => !r.eligible).reduce((out, r) => { out[r.reason] = (out[r.reason] ?? 0) + 1; return out; }, {}) });
const artifact = { source_hashes: inputs, normalizer: "packages/runtime-node/dist/commodity-data.js::normalizeCommodityContract",
  assumptions: [
    "Frozen historical market metadata is evaluated at each forecast.createdAt using the production normalizer.",
    "Market status is assumed active because frozen statuses are final settlement states; actual historical status is unavailable.",
    "Current frozen series metadata supplies source identity, terms URL, product metadata, fee type and multiplier; historical versions are unavailable.",
    "Current series last_updated_ts is omitted because it cannot reconstruct the metadata timestamp visible when each forecast was created.",
    "Forecast timestamps are treated as decision times; API delivery delay and freshness on later trading ticks are not reconstructed.",
    "The allowed terminal-series list is enforced before contract normalization; historical HAS_MARKET links, disputes and warning states are not reconstructed.",
    "This reconstructs static contract gates, not live order books, top-six research selection, portfolio state, fills or realized trading performance.",
  ], summary: summarize(records), by_asset: Object.fromEntries(Object.keys(assetKeys).map(a => [a, summarize(records.filter(r => r.asset === a))])), records };
writeFileSync(resolve(here, "static_contract_gates.json"), JSON.stringify(artifact, null, 2) + "\n");
console.log(JSON.stringify({ summary: artifact.summary, by_asset: artifact.by_asset }, null, 2));

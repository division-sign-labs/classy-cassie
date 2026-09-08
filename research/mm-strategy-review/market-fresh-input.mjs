// research/mm-strategy-review/market-fresh-input.mjs
// Select the complete fresh graph cohort without any graph volume prefilter.
import {readFile,writeFile} from 'node:fs/promises';
const graph=JSON.parse(await readFile(new URL('graph-current-forecasts.json',import.meta.url),'utf8'));
const markets=graph.markets.filter(x=>x.age_hours>=0&&x.age_hours<6);
await writeFile(new URL('market-fresh-input.json',import.meta.url),JSON.stringify({as_of:graph.as_of,selection:'Every graph forecast age_hours>=0 and<6; no volume/depth/price prefilter',markets},null,2)+'\n');
console.log(JSON.stringify({count:markets.length}));

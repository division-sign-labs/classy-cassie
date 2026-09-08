// research/mm-strategy-review/capture-quotient.mjs
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [label, ...args] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(label ?? '')) throw new Error('safe output label required');
if (!['signals', 'forecast', 'performance', 'markets', 'market'].includes(args[0])) throw new Error('read-only research command required');
const result = spawnSync('quotient', [...args, '--json', '--quiet'], { encoding: 'utf8', timeout: 180_000, maxBuffer: 20_000_000 });
if (result.status !== 0) {
  console.error(JSON.stringify({ status: result.status, error: result.error?.message, stderr: result.stderr?.slice(0, 1500), stdout: result.stdout?.slice(0, 1500) }));
  process.exit(1);
}
const data = JSON.parse(result.stdout);
const path = new URL(`q-${label}.json`, import.meta.url);
writeFileSync(path, JSON.stringify({ fetchedAt: new Date().toISOString(), command: args, data }, null, 2) + '\n');
console.log(JSON.stringify({ path: path.pathname, bytes: result.stdout.length, keys: Object.keys(data), stderr: result.stderr?.slice(0, 1500) }));

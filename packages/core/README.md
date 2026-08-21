# @quotient-forecasting/cassie-core

The engine behind [cassie](https://www.npmjs.com/package/@quotient-forecasting/cassie):
venue adapters, the strategy engine, the risk module, the encrypted keystore, the signal
client, and alerting.

Most people want the CLI, not this package:

```sh
npm install --global @quotient-forecasting/cassie
```

Install this one to build a strategy or a runtime against the same primitives.

```sh
npm install @quotient-forecasting/cassie-core
```

```ts
import { Engine, createAdapter, parseBotConfig } from "@quotient-forecasting/cassie-core";

const config = parseBotConfig(JSON.parse(configJson));
const adapter = createAdapter(config.venue, { urls: config.venueUrls, creds });
const engine = new Engine({ botId: config.id, config, adapter, account, strategy, signals, alerter, state, log });

await engine.tick();
```

`Engine.tick` is idempotent: it takes a tick id derived from the interval slot and guards
on a monotonic sequence in the `StateStore`, so a repeated slot is skipped rather than
traded twice. Every order it places passes the risk module first.

Venues: Polymarket, Hyperliquid, Lighter. Each adapter carries a `verifiedAgainst` date;
SDK versions are pinned exactly, and a bump has to be re-verified against live venue docs.

[Source](https://github.com/Quotient-Solutions-Inc/classy-cassie) ·
[Apache-2.0](https://github.com/Quotient-Solutions-Inc/classy-cassie/blob/main/LICENSE)

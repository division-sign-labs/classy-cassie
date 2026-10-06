# @quotient-forecasting/cassie-runtime-node

The process a [cassie](https://www.npmjs.com/package/@quotient-forecasting/cassie) bot runs
in. Engine loop, SQLite state, and a control API on a unix socket. The same code serves
`cassie run` on a laptop and a deployed bot on a droplet.

This is a private workspace module bundled in `@quotient-forecasting/cassie`.
`cassie deploy` installs that package on the droplet, pinned to the CLI's version.
`cassie run` uses the same bundled runtime locally.

For the signals strategy, the engine reconciles positions and re-reads venue odds every
60 seconds. Every five minutes it separately refreshes entry signals and batches the latest
Q forecasts for held markets (up to 10 markets per $0.005 lookup). Convergence exits are
therefore driven by held positions even when their entry signals are stale or no longer
published.

## As a service

`cassie deploy` writes a systemd unit that runs `cassie runtime` with an
environment file:

| | |
|---|---|
| `CASSIE_BOT_ID` | the bot id, which must match the config |
| `CASSIE_BOT_CONFIG` | serialized bot config |
| `CASSIE_BOT_CREDS` | the credential that signs orders |
| `CASSIE_REQUIRED_REGION` | the region the bot is pinned to |
| `QUOTIENT_API_TOKEN` | signals |
| `TELEGRAM_BOT_TOKEN` | optional |
| `CASSIE_DASHBOARD_PORT` | serve the read-only HTTPS dashboard on this port; unset means none |
| `CASSIE_DASHBOARD_AUTH_FILE` | `{"passwordHash": "scrypt$…"}`, re-read when it changes; default `/etc/cassie/<botId>.dashboard.json` |
| `CASSIE_DASHBOARD_TLS_DIR` | holds `cert.pem` and `key.pem`; default `/etc/cassie/tls` |
| `CASSIE_DASHBOARD_SAMPLE_MINUTES` | equity and call-counter sampling cadence; default 5 |

On start it asks DigitalOcean's metadata service which region it is in and refuses to run
anywhere but `CASSIE_REQUIRED_REGION`. Venue access is decided by where orders leave from,
so a host that cannot prove its region does not get to place them.

SIGTERM cancels resting orders before exit. While orders rest, the runtime heartbeats
every five seconds; if it dies, the venue cancels them about ten seconds later.

## As a library

```ts
import { BotService, serveControl, SqliteStateStore } from "@quotient-forecasting/cassie-runtime-node";

const service = new BotService({ config, account, creds, statePath, runtime: "local", quotientToken });
serveControl(service, "/run/cassie/bot-1.sock");
await service.start();
```

[Source](https://github.com/Quotient-Solutions-Inc/classy-cassie) ·
[Apache-2.0](https://github.com/Quotient-Solutions-Inc/classy-cassie/blob/main/LICENSE)

# @quotient-forecasting/cassie-runtime-node

The process a [cassie](https://www.npmjs.com/package/@quotient-forecasting/cassie) bot runs
in. Engine loop, SQLite state, and a control API on a unix socket. The same code serves
`cassie run` on a laptop and a deployed bot on a droplet.

You do not install this by hand. `cassie deploy` installs it on the droplet, pinned to the
CLI's version, and `cassie run` uses the copy that came with the CLI.

## As a service

`cassie deploy` writes a systemd unit that runs the `cassie-runtime` binary with an
environment file:

| | |
|---|---|
| `CASSIE_BOT_ID` | the bot id, which must match the config |
| `CASSIE_BOT_CONFIG` | serialized bot config |
| `CASSIE_BOT_CREDS` | the credential that signs orders |
| `CASSIE_REQUIRED_REGION` | the region the bot is pinned to |
| `QUOTIENT_API_TOKEN` | signals |
| `TELEGRAM_BOT_TOKEN` | optional |
| `ARES_API_KEY` | optional, required when reporting posts |

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

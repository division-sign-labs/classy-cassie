---
name: cassie
description: Operate cassie — self-hosted, non-custodial trading bots for prediction markets (Polymarket) and perps venues (Hyperliquid, Lighter). Use for creating and funding a bot, wallets and keystore, running or deploying a bot locally or to Cloudflare, checking portfolio/orders/logs, placing manual or thesis-driven trades, and the risk module's sizing, stop, and leverage rules.
---

# cassie — operator manual

Agent-agnostic. Works the same whether the operator is a human at a terminal or an agent
(Claude Code, Codex, Hermes) driving the CLI. This skill **wraps** the `cassie` CLI. Numbers (sizes, stops, leverage) come from the CLI.

## 1. What cassie is

An open-source, self-hosted, **non-custodial** trading bot system. One bot = one wallet =
one venue = one strategy. Bots run locally (`cassie run`) or on the operator's own
Cloudflare account (`cassie deploy`). Signals come from the Quotient developer API
(a separate product with its own skill, `quotient-api`). Nothing in this repo routes
orders through Quotient infrastructure, and Quotient never holds keys or funds.

Custody model:

- Per-bot EOA, independently generated (no shared seed). The EOA can be generated locally,
  or—Hyperliquid only—inside a one-use Cloudflare Container and encrypted back to this
  machine. Final keys live in
  `~/.cassie/keys/<botId>.json`, AES-256-GCM encrypted with a scrypt-derived key from the
  operator passphrase, file mode 0600.
- Keys are split by role. Hyperliquid's master and Lighter's L1 key stay local; deployed
  runtimes receive the Hyperliquid agent or Lighter API key. **Polymarket is an explicit
  exception:** the pinned client requires the raw venue signer plus L2 HMAC credentials in
  the runtime. Builder/Relayer credentials remain local, but do not describe the deployed
  Polymarket signer as local-only or reuse it for Splits authority.
- An optional Splits Teams subaccount is an organization-owned treasury association, not a
  replacement for the venue's EOA signing requirement. It is created under the active
  organization and appears alongside its other subaccounts. Cassie stores only its public
  org/account/signer metadata; Splits authentication remains in the official Splits CLI.

**Risk statement.** This software places real orders with real money on venues that can
and do change their APIs, halt, or lose liquidity without notice. Strategies can lose the
entire balance of a bot's account. Synthetic stops (Polymarket) are best-effort at poll
cadence, not guarantees. Nothing here is investment advice. You are responsible for the
venue terms and the laws of your jurisdiction. Start small.

## 2. Install

Prerequisites: Node 20+ (better-sqlite3 native build needs a working toolchain) and
`pnpm` for source checkouts. Cloudflare deploys additionally require a Workers Paid
account, Docker running, and `pnpm exec wrangler login`.

- From source (current path): `pnpm install && pnpm build`, then run
  `node packages/cli/dist/index.js …` or link it with pnpm 10:
  `pnpm --dir packages/cli link`.
- Published (when released): `npx @quotient-forecasting/cassie init` or `npm i -g @quotient-forecasting/cassie`.
  Note the bare `cassie` npm name is taken by an unrelated package — the published names
  are the scoped `@quotient-forecasting/*` packages; the installed binary is still `cassie`.

Environment: `CASSIE_HOME` overrides `~/.cassie`; `CASSIE_PASSPHRASE` supplies the
keystore passphrase non-interactively (testing convenience — prefer the prompt);
`QUOTIENT_API_TOKEN` / `QUOTIENT_API_KEY`, `ARES_API_KEY`, and `ARES_BUILDER_CODE` from
the nearest `.local.env` (preferred and authoritative over stale exported values) or
the exported environment override keystore copies; `TELEGRAM_BOT_TOKEN` overrides its
keystore copy; `CASSIE_DEBUG=1`
prints stack traces; `CASSIE_RUNTIME_CF` points `deploy` at a non-standard runtime-cf dir.

## 3. The wizard (`cassie init`), step by step

Every step happens in the terminal; you only leave it to copy-paste dashboard values.

1. **Bot id** — lowercase, dashes, max 32 chars. Names the config, keystore, and state files.
2. **Venue** — `polymarket`, `hyperliquid`, or `lighter`.
3. **Wallet origin** — Hyperliquid offers two paths:
   - *local* (recommended): generate directly into the encrypted local keystore;
   - *one-use Container*: deploy an EEUR bootstrap-only Worker/Container, generate in
     process memory, RSA-OAEP-encrypt the key to an ephemeral local recipient, verify and
     durably store it locally, prove receipt with an encrypted one-use token, purge the live
     Durable Object value, and delete the bootstrap deployment. Cloudflare and the image are
     trusted during generation; this is logical export-and-delete, not enclave attestation
     or a claim of cryptographic erasure from provider backups/PITR.
     The Container is replaceable compute, not a permanent machine identity.
   Polymarket does not offer this option because its final trading deployment still receives
   the signer; Lighter does not offer it because Lighter is local-runtime-only.
4. **Passphrase** — encrypts the keystore. There is no recovery; losing it means
   re-importing or re-generating keys.
5. **Optional Splits Teams subaccount** — requires the official
   `@splits/splits-cli@0.2.11`. Its API key is bound to one organization; Cassie runs
   `splits auth whoami`, shows the exact org name/id, and asks for confirmation. You choose
   your member and active passkey, then Cassie creates `cassie-<botId>` directly under that
   org's treasury owner. Passkey-only is the safe default. For Hyperliquid/Lighter an
   advanced option can also register the local bot EOA and attach it to this new account
   only at threshold 1: either the passkey or EOA can move that subaccount's funds alone.
   Cassie does not yet sign Splits proposals. Polymarket's deployed signer is never offered.
   Creation is journaled and reconciled by name plus exact signer set before retry, so a
   timeout cannot silently duplicate the account. No existing account is mutated.
6. **Venue account provisioning** (adapter-driven):
   - **Polymarket** — two paths. Polymarket account creation and every gasless op
     (approvals, redemption) require a **Relayer or Builder API key** in the client —
     verified live 2026-08-13; solo derivation without either is rejected by the relayer.
     - *create* (default): create a Polymarket account. The Builder key menu offers
       **Use default Builder key** when one exists (from `~/.cassie/defaults.json` or the
       `POLYMARKET_BUILDER_KEY/SECRET/PASSPHRASE` env vars), `open` to launch
       polymarket.com → **Settings → Builders** (free) for a new one, or a pasted key
       (the wizard offers to save it as the default). A Relayer key works here too when
       the Builder prompt is left blank. This is your Polymarket relationship, not
       Quotient's.
     - *connect*: use an existing Polymarket account. Copy the wallet address from your
       polymarket.com profile, and create a Relayer API key at polymarket.com →
       **Settings → API Keys → Relayer API Keys**. Note the Relayer key is bound to the
       **signer** that created it, not the wallet — the wizard asks for that address.
     Either way the wizard derives CLOB L2 credentials (HMAC key/secret/passphrase) and
     stores them runtime-eligible; the Relayer/Builder key stays **local-only**. It also surfaces the geoblock answer (GET polymarket.com/api/geoblock,
     informational only — if `blocked: true`, reads and funding work but order placement
     is rejected by the venue).
   - **Hyperliquid** — derives the master address from the bot key. Agent approval happens
     in the funding flow, after the account exists on the L1.
   - **Lighter** — derives the L1 address. Account registration and API-key provisioning
     happen in the funding flow.
7. **Strategy** — one strategy: `signals` (follow Quotient signals, hold until the side
   flips). The recommended allocation holds up to 2 positions, prioritizes the widest
   eligible edges for new entries, and requests 50% of the daily entry budget per position;
   the wizard always asks for the
   dollar budget (default $25). The budget resets at 00:00 UTC, counts only entry notional
   actually placed after risk/capacity limits, and does not close positions when it resets.
   Declining the recommendation asks for top N, daily budget, allocation percentage, entry
   edge, minimum viable entry, tick interval, and universe. `cassie strategy <botId>`
   displays or changes the same settings at any time.
8. **Signals** — live Quotient signals. The wizard reuses a key found from the quotient
   CLI or asks for one. `QUOTIENT_API_KEY` and `QUOTIENT_API_TOKEN` are both honoured
   from the environment. Deterministic fixture sources exist only inside the contributor
   test harness; they are not an operator choice.
9. **Telegram alerts** — create a bot with **@BotFather** on Telegram and paste its token;
   get your chat id from **@userinfobot**. The wizard offers a test ping.
10. **Funding** — optionally continues straight into `cassie fund <botId>`.

Non-secret progress is checkpointed at `~/.cassie/setup/<botId>.json` (0600). Rerunning
`cassie init` resumes wallet/Splits/venue steps without repeating completed external writes.
Bootstrap wrapping keys and bearer tokens are encrypted keystore entries, never journal data.

### Funding flows (per venue)

All flows print exactly what to send where, then poll until the venue credits.

- **Polymarket**: the bridge (`bridge.polymarket.com`) issues per-chain deposit addresses
  for the bot's trading address. The wizard labels the trading address **Polygon pUSD
  only.** Do not send funding assets there; send USDC to the bridge-issued `evm` deposit
  address from a supported chain, where it is auto-wrapped to **pUSD**, the Polygon
  collateral token. Deposits over $50k should use a
  third-party bridge (DeBridge/Across/Portal) direct to Polygon USDC to limit slippage.
  After credit, the flow sets trading approvals (one-time, **gasless** via relayer) and
  syncs the CLOB allowance cache. No gas token is ever needed.
- **Hyperliquid**: send **≥5 USDC** (below the minimum is lost — the flow warns) plus
  **~$2 of ETH** for gas to the master address **on Arbitrum**. The CLI then submits the
  bridge deposit from the master EOA, polls the L1 until credited, generates an agent
  keypair, has the master sign `approveAgent` (named `cassie-<botId>`, truncated to 16
  chars), and marks the agent key runtime-eligible. The master key stays local.
- **Lighter**: choose a source chain (Arbitrum / Base / Avalanche C-Chain); the flow
  requests a CCTP intent address, you send **≥5 USDC** to it, it polls until the account
  is credited, resolves the integer `account_index`, provisions an API key at index 2 via
  ChangePubKey (signed by the L1 key, which stays local), and marks the API key
  runtime-eligible. **Lighter is local-runtime-only in MVP** (§8 below).

`cassie fund <botId>` re-enters the flow for top-ups. With a configured treasury,
`--from splits` is automated only for Hyperliquid mainnet: it fixes the source to Arbitrum
One native USDC, asks the amount, and then prints the exact
`splits transactions create transfer --account … --chain-id … --recipient … --token …`
proposal. Approve the returned `signUrl` with the selected passkey. Cassie never reads or
deploys the Splits API key. Hyperliquid still needs ETH at the master for bridge gas.
Polymarket is blocked until its live bridge route can be validated. For Lighter, run the
normal funding wizard and enter the Splits account address as the sender before proposing
the same-chain transfer to its sender-bound intent address.

### Withdrawals

`cassie withdraw <botId> <amount|all> --to <address>` sends collateral back out. It shows
the exact venue, amount, and destination and asks for confirmation. Withdrawals sign with
the master/L1 key, which lives in the local keystore, so the command runs on the machine
that holds it. Per venue: **Polymarket** transfers pUSD from the trading address on Polygon
(gasless, uses the operator's Builder/Relayer key); **Hyperliquid** submits a user-signed
withdrawal of USDC to the destination on Arbitrum ($1 venue fee, arrives in minutes);
**Lighter** is unwired in the MVP — use the Lighter app with the L1 wallet.

## 4. Command reference

```
cassie init                                  # the wizard
cassie wallet create <botId>                 # generate a fresh EOA
cassie wallet import <botId>                 # import a private key via stdin
cassie wallet export <botId> --yes-print-my-key   # print raw key (double confirmation)
cassie wallet list                           # bots, key roles, runtime-eligibility
cassie wallet register-splits <botId>        # register EOA only; grants no account authority
cassie wallet abort-bootstrap <botId>        # delete/reset an unused Container ceremony
cassie fund <botId> [--from splits]          # run/re-run the venue funding flow
cassie withdraw <botId> <amount|all> --to <address>   # send collateral out (signs locally)
cassie run <botId> [--debug]
cassie strategy <botId>                      # view/tune top N, daily budget, allocation, guardrails
cassie strategy <botId> --top 3 --daily-budget 100 --position-budget-pct 33
cassie deploy <botId>                        # EEUR Container + Worker control plane on YOUR CF account
cassie reporting <botId> [--no-post|--off]   # configure Ares for this bot only
cassie portfolio [botId]                     # balances/positions/orders/PnL, per bot + aggregate
cassie orders <botId> [--cancel <id>] [--cancel-all]
cassie trade <botId> buy|sell <marketRef> --size <n> [--limit <px>] [--tif gtc|ioc|fok]
             [--stop <px>] [--trail <bps>] [--tp <px>] [--outcome yes|no] [-y]
cassie trade <botId> --thesis [--save <file>] [--mappings <file>]   # develop a trade from a thesis
cassie trade <botId> --from-thesis <file> [--mappings <file>]       # place a saved thesis
cassie logs <botId> [--level error|warn|info] [--tail <n>]
cassie alerts test <botId>                   # Telegram ping
cassie venue status                          # adapters + verifiedAgainst dates
```

Notes:

- `trade` on Polymarket defaults `--outcome yes`; `marketRef` is always the **YES-token
  CLOB id** — NO-side orders set `--outcome no` and the adapter resolves the sibling token.
- `--stop`/`--tp` map to **native** trigger orders on Hyperliquid and Lighter; on
  Polymarket they arm **synthetic** engine-managed triggers, best-effort at poll cadence
  (the CLI says so when you arm one). `--trail` is engine-managed everywhere.
- Every order — strategy, manual, or thesis-driven — passes the risk module:
  slippage band, depth cap (25% of in-band depth by default), 24h volume floor ($10k),
  spread ceiling, min-viable-notional. Skips raise alerts.
- For a deployed bot, `portfolio`, `trade`, `orders`, and `logs` transparently go through
  the bot's control API using the control token issued at deploy.
- **Agent access.** `cassie deploy` asks whether local agents may reach the bot without the
  keystore passphrase. Answering yes caches the control token at
  `~/.cassie/control/<botId>.token` (mode 0600), so an agent driving the CLI reads logs and
  portfolio without stalling on a prompt it cannot answer. The question is asked on every
  deploy, so answering no later revokes it. The token reaches only that bot's control API —
  which includes `/trade` — so it is a key, just a far smaller one than the passphrase.
  `cassie deploy --rotate-token` invalidates any copy. Resolution order for every control
  call: `CASSIE_CONTROL_TOKEN` → the cache → the keystore (which prompts).

## 5. Wiring Quotient signals

Live signals come from the Quotient gateway
(`https://quotient-api-gateway.onrender.com/api/v1/signals`, authenticated with an
`x-quotient-api-key` header — dev.quotient.social is gateway-only and rejects direct
calls). Get a key at quotient.social; if the **quotient-api** skill/CLI is installed and
logged in, the same key lives in `~/.config/quotient/config.json`. Give it to cassie via
`QUOTIENT_API_TOKEN` / `QUOTIENT_API_KEY` in the environment or nearest `.local.env`,
or let the wizard store it in the keystore by re-running `cassie init`.

The quotient-api skill is a separate product surface (research, forecasts, briefs); cassie
consumes exactly one read endpoint — the published-signals feed — and maps each row onto
its internal contract: Polymarket `condition_id` resolves to the YES-token marketRef,
`latest_q` becomes the side-adjusted model probability, `current_cost_cents` the reference
price. Live forecasts older than three hours fail the freshness check by default and
cause no action; `signals.maxAgeSec` can override that per bot.

Financial fields never flow toward the signal API — the client sends only the API key
header, no query params, and its type surface has no method that accepts account state.

Contributors can run the deterministic offline engine case without creating a bot,
keys, or funds:

```
pnpm exec vitest run packages/core/test/engine-e2e.test.ts
```

The test enters YES with size capped by the thin test book, then flips, exits, and
re-enters NO. The fixture venue and signal source are test doubles, not product options.

## 5b. Trade reporting (opt-in, Polymarket only)

Ares is a social feed, **not a venue** — there is no adapter and nothing to fund. Trades
execute on Polymarket exactly as before; Ares reads Polymarket's builder-attributed trade
feed and renders a position card from the real fill. The bot publishes its trades there
and other Ares traders may copy them, so posts are public-facing. Two halves:

1. **Attribution** — orders carry Ares' builder code, so the trade is visible to them.
2. **Posting** — after the order, a post referencing that trade is published to the feed.

Opt a single bot in with `cassie reporting <botId>`. It discovers
`ARES_BUILDER_CODE` and `ARES_API_KEY` from the nearest `.local.env`, verifies the key
with Ares `/public/v1/me`, and only then saves a `reporting` block to that bot's config:

```jsonc
"reporting": {
  "provider": "ares",                    // the destination; one today
  "builderCode": "0xaca2b076…091c12",    // required — 0x + 64 hex
  "post": true,                          // default true
  "postOn": ["entry", "exit"]            // default both
}
```

Two independent switches: `builderCode` attributes the order on the venue, `post`
governs whether the trade is reported anywhere. `cassie reporting <botId> --no-post`
keeps attribution while disabling posts; `--off` removes both from that bot.

Bots without that block are untouched: no code on their orders, no posts. The code is
applied by the adapter, not by strategy code, so every Polymarket order from an opted-in
bot carries that bot's configured builder code.

The provider key (`ares_sk_live_…` for `provider: "ares"`) comes from the nearest
`.local.env`, exported `ARES_API_KEY`, or the bot's keystore (`ares-api-key` role), in
that order. `cassie deploy` forwards it as an encrypted Worker secret consumed only by
the Container. If posts are enabled, deploy refuses to proceed or resume unless both the
local Ares `/me` check and the deployed Container check accept the same account.

### Captions

Posts are read by people deciding whether to **copy the trade**, so the caption is the
operator's own words. It comes from one place: the `note` on the order.

| Trade path | Caption source |
| --- | --- |
| `--thesis` / `--from-thesis` | the thesis `reasoningSummary`, then the trade's terms |
| `cassie trade … --note "…"` | that text verbatim |
| direct `cassie trade …` without `--note` | the latest Quotient forecast thesis for that Polymarket market |
| strategy tick (signals) | none today — the card posts alone |

`reasoningSummary` is asked for during thesis intake, separately from `notes`, so private
scratch and the public rationale never blur. `captionFromThesis` renders it followed by
side, conviction, timeframe, expected move, and the invalidation level — the terms a
copy-trader needs. Size and price are deliberately left out of the prose: the card
carries those from the real fill, and repeating them invites the two to disagree.

For a direct manual Polymarket trade without `--note`, the CLI maps the traded token to
its condition and fetches the latest reviewable Quotient forecast thesis after the user
confirms the order. The lookup is best-effort and never blocks the fill. If no thesis is
available, Cassie skips the manual Ares post rather than allowing Ares to invent generic
copy. Strategy trades without a note still post the card alone. The engine's internal
`reason` (`signal sig_8f21 spread 12.3pp`) is never published — it's an internal id and
telemetry, meaningless to a reader.

Notes:

- Manual and thesis orders raise the same `entry`/`exit` alert a strategy tick does.
  (They previously raised none at all, so they were invisible to every sink.)
- The card is built server-side from the real trade, so size, price and P&L can't be
  faked and are never sent. cassie only sends the order id, the traded token, and the
  trading address — **the funder, not the signer** (§5.1's classic confusion; sending the
  signer fails to resolve the position).
- Posting runs as an `Alerter` alongside Telegram, wrapped in `SafeAlerter`. An Ares
  outage cannot block, delay, or fail a fill.
- Fresh trades index with a lag, so a 404 on the first attempt is expected; the client
  retries on a backoff before treating it as a real mismatch.
- **Attributed fills pay Polymarket's builder taker fee.** That is the cost of the
  relationship, and it lands on your side of the trade.

## 6. Thesis intake (perps-first)

The split is strict: **elicitation lives here, arithmetic lives in code.** The agent asks
the questions; `cassie trade <botId> --thesis` (or `--from-thesis <file>`) computes every
number. **The agent must never translate a categorical answer into a price, size, or
leverage figure itself.** No figure produced by an LLM ever reaches an order.

The six questions, exactly as the CLI asks them (`cassie trade <botId> --thesis`):

1. a. `Venue (hyperliquid / lighter / polymarket)`
   b. `Instrument (e.g. ETH, or YES-token id)`
   c. `Direction (long/short)` — or `Side (yes/no)` on Polymarket
2. `Confidence (low / medium / high)`
3. `Timeframe (intraday / days / weeks / quarter)`
4. `Magnitude (small / meaningful / repricing)`
5. `Invalidation price (or "none")`
6. `Risk budget, % of equity (soft cap 2)`

Workflow: `cassie trade <botId> --thesis` runs the whole thing in one sitting (add
`--save idea.json` to keep the thesis for reuse; place a saved one later with
`--from-thesis idea.json`). The computed trade prints every field with its provenance
(answer → rule → number), both sizing computations (fixed-fractional and quarter-Kelly,
smaller wins), derived leverage, estimated liquidation price next to the stop, funding-drag
estimate, and any capacity capping. The operator can **approve / edit / reject**; an edit
that breaks a guardrail (risk above the soft cap, stop inside the liquidation buffer, size
above the capacity cap) prints the specific violation and requires a **second explicit
confirm**. Nothing is silently blocked; nothing silently passes.

Policy lives in `skills/cassie/thesis/mappings.json` (confidence edges, ATR specs,
R-multiples, leverage caps, …) — changing policy is a file PR, not a code change.
Alternative files load via `--mappings <file>` or the thesis file's `mappings` field.

**Prediction markets variant** (thin by design): binaries have no meaningful TP/SL.
Confidence maps to an entry-spread threshold (low 12pp / medium 10pp / high 7pp); sizing
reuses min(fixed-fractional, quarter-Kelly) with `p` = model probability and `b` implied by
the share price. When a fresh live Quotient signal covers the market, the CLI takes `p`
from it automatically (mirrored if the signal's side differs from the thesis side);
otherwise it asks the operator. Exit is flip or resolution, owned by flip-flat.

## 7. Rules for the agent operating cassie

1. **Never** print or persist private keys outside Cassie's encrypted keystore. The
   Container-first ceremony may hold a generated key in process memory only long enough to
   encrypt-export it; Workers/DO state, logs, messages, and scratch files must never contain it.
2. **Always** show the operator the exact order — market, side, size, limit — and get
   their confirmation before any live `trade`. (The CLI also asks; `-y` is for the
   operator to decide, not the agent.)
3. **Never** initiate a funding transfer without explicit operator confirmation of the
   destination address and amount.
4. On any error, read `cassie logs <botId> --level error` **before** retrying.
5. Numbers come from the CLI (§6). Categorical answers in, computed figures out.

## 8. Venue support and runtime notes

| venue       | trading | native TP/SL | Cloudflare deploy | dead man's switch |
|-------------|---------|--------------|-------------------|-------------------|
| polymarket  | ✓       | synthetic    | ✓                 | CLOB heartbeat (~10s window) |
| hyperliquid | ✓       | ✓            | ✓                 | scheduleCancel (10-min horizon, refreshed) |
| lighter     | ✓       | ✓            | ✗ local-only      | scheduled cancel-all (15-min, refreshed) |

Lighter remains local-only in this release because its filesystem-backed WASM signer has
not yet been wired and verified in the deployed Container runtime.

Container-first wallet generation is available only for Hyperliquid. Normal Polymarket
Cloudflare deploy remains available, but it prints a custody warning because its raw venue
signer is a Worker secret. Never attach that EOA to a Splits account.

## 9. Troubleshooting

- **Polymarket 401 / "order owner mismatch"** — the classic signer-vs-funder confusion.
  Orders are *signed* by the bot's EOA (`POLY_ADDRESS`, L2 auth); the *funder* is the
  trading address. Check `~/.cassie/bots/<botId>.json`: `account.signerAddress`
  must be the keystore EOA, `account.funder` the trading address.
- **Polymarket "not enough balance/allowance" right after funding or before a first
  sell** — allowance-cache staleness. The funding flow syncs COLLATERAL; the adapter
  syncs CONDITIONAL per token before its first sell. Re-run `cassie fund <botId>` to
  re-sync if a deposit arrived outside the flow.
- **Hyperliquid queries return empty** — you queried by the agent address. All info
  queries (balances, positions, fills, open orders) key on the **master** address; the
  adapter does this, so if you're poking the API manually, use `account.masterAddress`.
- **Hyperliquid deposit never credits** — did you send exactly ≥5 USDC on **Arbitrum** to
  the master address first, and was there ETH for gas? Amounts under 5 USDC are lost by
  the bridge.
- **Lighter nonce errors** — each API key index has its own nonce, incremented by 1 per
  tx and fetched from `next_nonce`. Run one bot process per API key; don't share index 2
  across processes. Auth tokens expire after 8h and are re-derived automatically.
- **Duplicate-looking ticks on Cloudflare** — the Container serializes engine work and
  the engine dedupes by interval-slot `tickId`; a repeated slot logs that it was already
  completed and skips it. That line is normal, not a second trade.
- **Polymarket resting order vanished** — the dead man's switch. While orders rest, the
  runtime heartbeats every ~5s; if the runtime dies (or laptop sleeps), the venue cancels
  all resting orders ~10–15s later. That is the designed behavior (kill-safety), not a bug.
- **"wrong passphrase (or corrupted keystore)"** — scrypt+AES-GCM authentication failed:
  wrong passphrase, or the keystore file was edited. There is no recovery without the
  passphrase; re-import the key (`cassie wallet import`) if you have it elsewhere.
- **`cassie deploy` fails immediately** — verify the account is on Workers Paid, Docker
  is running, and `pnpm exec wrangler login` succeeds. Deploys run against your own
  Cloudflare account. Lighter bots refuse to deploy by design.
- **Splits shows the wrong organization** — `SPLITS_API_KEY` overrides the CLI's saved auth
  and every key belongs to one org. Stop at the org confirmation, unset/change the key,
  and verify with `splits auth whoami`; Cassie has no team-switch command.
- **Container wallet setup was interrupted** — rerun `cassie init`; it retrieves the same
  encrypted envelope and resumes. Only when no master was imported, use
  `cassie wallet abort-bootstrap <botId>` to authenticate a remote abort/purge, delete the
  unused one-use Worker, and reset.

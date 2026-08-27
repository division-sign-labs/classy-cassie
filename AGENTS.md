# AGENTS.md

**Operating cassie (running bots, funding, trading, tickets): read
[`skills/cassie/SKILL.md`](skills/cassie/SKILL.md) first.** It is the operator manual for
humans and agents alike, including the rules an agent must follow (never print keys,
confirm every live order, confirm funding transfers, read `cassie status` and
`cassie logs` before retrying).

## Repo conventions (for coding agents working on this codebase)

- pnpm workspace: `packages/core` (venue adapters, wallet, engine, risk, signals, alerts,
  thesis sizing), `packages/cli` (the `cassie` binary), `packages/runtime-node` (the bot
  process: engine loop, SQLite state, unix-socket control API — the same code for
  `cassie run` and a droplet), `strategies/flip-flat`, `skills/cassie`, `fixtures/`.
- Every code file carries its destination path as a comment on line 1. Keep it that way.
- TypeScript throughout, strict, ESM (`NodeNext`).
- **Never hand-roll signing** (spec §15.6). Venue SDKs are pinned exactly:
  `@polymarket/client@0.6.0`, `@nktkas/hyperliquid@0.33.3`, `lighter-ts-sdk@1.0.13`.
  Version bumps are deliberate PRs that re-verify the adapter against live docs and
  update its `verifiedAgainst` date (surfaced by `cassie venue status`).
  **Documented exception — Kalshi**: Kalshi ships no official TypeScript SDK, so its
  adapter signs requests with `node:crypto` RSA-PSS (SHA-256, salt length = digest
  length) per the venue's documented scheme. The signed-string format is pinned by
  known-vector tests in `packages/core/test/kalshi-signing.test.ts`; any change there is
  a venue-contract change that must re-verify against live docs and bump `verifiedAgainst`.
- `pnpm test` builds the workspace, then runs vitest (`packages/core/test/**`).
  `pnpm -r typecheck` must stay clean.
- Strategies return `Action[]`; they never touch keys and never call `placeOrder` — the
  engine executes through the risk module. Don't add adapter calls to strategy code.
- Master/L1 private keys are local-keystore-only. Anything pushed to a runtime must be a
  trade-scoped credential (`RuntimeCreds`). Don't widen that set.
- Nothing secret goes into droplet user-data (`packages/cli/src/cloud-init.ts`) or into a
  command line. Credentials reach a droplet over SSH on stdin. `cloud-init.test.ts`
  enforces the first half of that.
- Multi-agent etiquette: when several agents work this repo concurrently, each owns an
  explicit file list; don't edit shared files (`packages/core/src/index.ts`, `types.ts`,
  package manifests, the lockfile) from a worker — report needed changes instead.

# AGENTS.md

**Operating cassie (running bots, funding, trading, tickets): read
[`skills/cassie/SKILL.md`](skills/cassie/SKILL.md) first.** It is the operator manual for
humans and agents alike, including the rules an agent must follow (never print keys,
confirm every live order, confirm funding transfers, read `cassie logs` before retrying).

## Repo conventions (for coding agents working on this codebase)

- pnpm workspace: `packages/core` (venue adapters, wallet, engine, risk, signals, alerts,
  thesis sizing), `packages/cli` (the `cassie` binary), `packages/runtime-local`,
  `packages/runtime-cf` (Workers + Durable Object), `strategies/flip-flat`,
  `skills/cassie`, `fixtures/`.
- Every code file carries its destination path as a comment on line 1. Keep it that way.
- TypeScript throughout, strict, ESM (`NodeNext`; runtime-cf uses Bundler resolution).
- **Never hand-roll signing** (spec §15.6). Venue SDKs are pinned exactly:
  `@polymarket/client@0.6.0`, `@nktkas/hyperliquid@0.33.3`, `lighter-ts-sdk@1.0.13`.
  Version bumps are deliberate PRs that re-verify the adapter against live docs and
  update its `verifiedAgainst` date (surfaced by `cassie venue status`).
- `pnpm test` builds the workspace, then runs vitest (`packages/core/test/**`).
  `pnpm -r typecheck` must stay clean.
- Strategies return `Action[]`; they never touch keys and never call `placeOrder` — the
  engine executes through the risk module. Don't add adapter calls to strategy code.
- Master/L1 private keys are local-keystore-only. Anything pushed to a runtime must be a
  trade-scoped credential (`RuntimeCreds`). Don't widen that set.
- Multi-agent etiquette: when several agents work this repo concurrently, each owns an
  explicit file list; don't edit shared files (`packages/core/src/index.ts`, `types.ts`,
  package manifests, the lockfile) from a worker — report needed changes instead.

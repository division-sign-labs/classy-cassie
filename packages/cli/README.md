# Cassie

Cassie is an open-source, self-hosted, non-custodial trading bot for prediction
markets and perps venues.

```sh
npm install --global @quotient-forecasting/cassie
cassie init
```

The package includes the local runtime, the Cloudflare Worker control plane,
the Cloudflare Container deployment assets, and the Cassie operator skill. Its
installer copies the skill to both `~/.agents/skills/cassie` (Codex) and
`~/.claude/skills/cassie` (Claude Code). If lifecycle scripts were disabled,
install it explicitly:

```sh
cassie skill install
```

Run locally with `cassie run <botId>`, or deploy to a Cloudflare Container in
the `EEUR` placement region with `cassie deploy <botId>`. Cloudflare deploys
require Docker and a Workers Paid account; Cassie guides first-time login.

Trading can lose the entire funded balance. Operators remain responsible for
venue terms and applicable law. Cassie never sends master keys to a runtime.

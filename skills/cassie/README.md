# @quotient-forecasting/cassie-skill

The operator manual for [cassie](https://www.npmjs.com/package/@quotient-forecasting/cassie),
packaged as a skill for Claude Code and Codex. Installing the CLI installs this too, so an
agent can drive the same commands a person would.

```sh
npm install --global @quotient-forecasting/cassie
cassie skill install     # if npm lifecycle scripts are disabled
```

It installs [SKILL.md](./SKILL.md) — the wizard step by step, funding and withdrawal flows
per venue, the command reference, deploy and monitoring, signal wiring, thesis intake, and
troubleshooting — plus `thesis/mappings.json`, the policy file behind
`cassie trade <botId> --thesis`. Changing thesis policy is an edit to that file, not a code
change.

Restart an open agent session if it does not discover the skill right away.

[Source](https://github.com/Quotient-Solutions-Inc/classy-cassie) ·
[Apache-2.0](https://github.com/Quotient-Solutions-Inc/classy-cassie/blob/main/LICENSE)

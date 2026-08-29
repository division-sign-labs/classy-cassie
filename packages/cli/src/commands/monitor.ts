// packages/cli/src/commands/monitor.ts
// `cassie status`, `cassie logs`, `cassie ssh`. A deployed bot is a box you can
// log into, so checking on one means reading its journal over SSH.

import pc from "picocolors";
import type { BotConfig, BotPortfolio } from "@quotient-forecasting/cassie-core";
import { SqliteStateStore } from "@quotient-forecasting/cassie-runtime-node";
import { isDeployed, targetFor } from "../context.js";
import { loadBotConfig, statePath } from "../paths.js";
import { ensureDigitalOceanReady, publicIpv4 } from "../digitalocean.js";
import { controlCall, sshExec, sshExecOrThrow, sshInteractive, type Target } from "../ssh.js";
import { money } from "../render.js";

const JOURNAL_UNIT = (botId: string) => `cassie@${botId}`;

export interface LogsOpts {
  tail?: string;
  follow?: boolean;
  since?: string;
  /** Read the engine's persisted error records instead of the journal. */
  errors?: boolean;
  level?: string;
}

export async function showLogs(botId: string, opts: LogsOpts): Promise<void> {
  const cfg = loadBotConfig(botId);
  const tail = opts.tail ?? "200";

  if (isDeployed(cfg) && !opts.errors) {
    const target = targetFor(cfg);
    const args = ["journalctl", "-u", JOURNAL_UNIT(botId), "--no-pager", "-n", String(Number(tail) || 200)];
    if (opts.since) args.push("--since", `'${opts.since}'`);
    if (opts.follow) {
      await sshInteractive(target, [...args, "-f"].join(" "));
      return;
    }
    process.stdout.write(sshExecOrThrow(target, args.join(" ")));
    return;
  }

  if (opts.follow) {
    console.log(pc.yellow("--follow needs a deployed bot; a local run already prints to this terminal"));
    return;
  }

  const errors = isDeployed(cfg)
    ? ((await controlCall(
        targetFor(cfg),
        botId,
        "GET",
        `/logs?tail=${encodeURIComponent(tail)}${opts.level ? `&level=${encodeURIComponent(opts.level)}` : ""}`,
      )) as ErrorRow[])
    : await localErrors(botId, opts);

  if (errors.length === 0) {
    console.log(isDeployed(cfg) ? "no recorded errors" : `no recorded errors — \`cassie logs ${botId}\` after a run`);
    return;
  }
  for (const e of errors) {
    const color = e.level === "error" ? pc.red : e.level === "warn" ? pc.yellow : pc.dim;
    console.log(
      `${new Date(e.ts).toISOString()} ${color(e.level.toUpperCase())} [${e.code}]` +
        `${e.tickSeq !== undefined ? ` tick=${e.tickSeq}` : ""} ${e.message}` +
        (e.context ? pc.dim(` ${JSON.stringify(e.context)}`) : ""),
    );
  }
}

interface ErrorRow {
  ts: number;
  level: string;
  code: string;
  message: string;
  tickSeq?: number;
  context?: unknown;
}

async function localErrors(botId: string, opts: LogsOpts): Promise<ErrorRow[]> {
  const store = new SqliteStateStore(statePath(botId));
  try {
    return (await store.readErrors({
      level: opts.level as never,
      tail: opts.tail ? Number(opts.tail) : 50,
    })) as ErrorRow[];
  } finally {
    store.close();
  }
}

export async function runSsh(botId: string): Promise<void> {
  const cfg = loadBotConfig(botId);
  const target = targetFor(cfg);
  console.log(pc.dim(`${target.user}@${target.host} — the bot runs as cassie@${botId}`));
  const code = await sshInteractive(target);
  if (code !== 0) process.exitCode = code;
}

/** Elapsed time without the "ago" suffix, for durations rather than instants. */
function uptime(iso: number | string | undefined): string {
  const text = ago(iso);
  return text.endsWith(" ago") ? text.slice(0, -4) : text;
}

function ago(iso: number | string | undefined): string {
  if (iso === undefined) return "never";
  const ms =
    Date.now() -
    (typeof iso === "number" ? iso : Date.parse(String(iso).replace(/^[A-Za-z]{3}\s+/, "")));
  if (!Number.isFinite(ms)) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}

interface RuntimeStatus {
  active?: boolean;
  paused?: boolean;
  lastTickAt?: number;
  region?: string;
  version?: string;
}

/** A bot that is down should still print a status page, not a stack trace. */
async function tryControl<T>(target: Target, botId: string, path: string): Promise<T | null> {
  try {
    return (await controlCall(target, botId, "GET", path)) as T;
  } catch {
    return null;
  }
}

function row(label: string, value: string): void {
  console.log(`${pc.dim(label.padEnd(10))}${value}`);
}

function compactNumber(value: number): string {
  return String(Number(value.toFixed(4)));
}

function cadence(cfg: BotConfig): string {
  const signalMin = Number(
    (cfg.strategy.config as Record<string, unknown>).signalPollIntervalMin ?? 5,
  );
  return `positions every ${compactNumber(cfg.tickIntervalMin * 60)}s, signals every ${compactNumber(signalMin)}m`;
}

export async function showStatus(botId: string): Promise<void> {
  const cfg = loadBotConfig(botId);

  // Status reads the box, so it stays out of the keystore. `cassie portfolio`
  // is the command that unlocks keys to price a book.
  if (!isDeployed(cfg)) {
    console.log(pc.bold(`${botId}  ${cfg.venue}  not deployed`));
    console.log("");
    row("strategy", `${cfg.strategy.id}, ${cadence(cfg)}`);
    row("account", accountAddress(cfg) ?? "not provisioned — run cassie init");
    console.log("");
    console.log(pc.dim(`cassie run ${botId} runs it here. cassie deploy ${botId} puts it on a droplet.`));
    return;
  }

  const deployment = cfg.deployment!;
  const target: Target = { host: deployment.host, user: deployment.user };
  const reachable = sshExec(target, "true").ok;

  // Parse by key: `systemctl show --value` emits properties in systemd's own
  // order, not the order they were requested in, so positional reads misalign.
  const service = reachable
    ? sshExec(target, `systemctl show ${JOURNAL_UNIT(botId)} -p ActiveState -p SubState -p NRestarts -p ActiveEnterTimestamp`)
    : null;
  const props = new Map(
    (service?.stdout ?? "")
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");
        return at === -1 ? ["", ""] : [line.slice(0, at), line.slice(at + 1)];
      }) as [string, string][],
  );
  const activeState = props.get("ActiveState");
  const subState = props.get("SubState");
  const restarts = props.get("NRestarts") ?? "0";
  const since = props.get("ActiveEnterTimestamp");

  const runtime = reachable ? await tryControl<RuntimeStatus>(target, botId, "/runtime") : null;

  console.log(
    pc.bold(`${botId}  ${cfg.venue}  ${reachable ? (activeState === "active" ? "running" : (activeState ?? "stopped")) : "unreachable"}`),
  );
  console.log("");

  const { client } = await ensureDigitalOceanReady({ quiet: true }).catch(() => ({ client: null }) as never);
  const droplet = client ? await client.droplet(deployment.dropletId).catch(() => null) : null;
  row(
    "droplet",
    droplet
      ? `${droplet.region.slug}  ${droplet.size_slug}  ${publicIpv4(droplet) ?? deployment.host}  $${droplet.size.price_monthly}/mo  up ${uptime(droplet.created_at)}`
      : `${deployment.region}  ${deployment.size}  ${deployment.host}  (DigitalOcean unreachable)`,
  );
  row(
    "service",
    reachable
      ? `${activeState ?? "unknown"} (${subState ?? "unknown"}), ${restarts} restarts, started ${ago(since)}`
      : "no ssh — check the droplet in the DigitalOcean dashboard",
  );
  row(
    "engine",
    runtime
      ? `${runtime.paused ? "paused" : "live"}, last tick ${ago(runtime.lastTickAt)}, ${cadence(cfg)}`
      : "not answering on the control socket",
  );

  if (runtime && !runtime.paused) {
    const portfolio = await tryControl<BotPortfolio>(target, botId, "/portfolio");
    if (portfolio) row("book", describePortfolio(portfolio));
  }
  row("runtime", `${runtime?.version ?? "unknown"} in ${runtime?.region ?? deployment.region}`);

  if (reachable) {
    const recent = sshExec(target, `journalctl -u ${JOURNAL_UNIT(botId)} --no-pager -n 5 -o short-iso`);
    if (recent.ok && recent.stdout.trim()) {
      console.log("");
      for (const line of recent.stdout.trimEnd().split("\n")) console.log(pc.dim(`  ${line}`));
    }
  }
}

function accountAddress(cfg: BotConfig): string | undefined {
  const account = cfg.account;
  if (!account) return cfg.wallet.address;
  if (account.venue === "polymarket") return account.funder;
  if (account.venue === "hyperliquid") return account.masterAddress;
  if (account.venue === "kalshi") return `kalshi API key ${account.keyId.slice(0, 8)}…`;
  return account.l1Address;
}

function describePortfolio(p: BotPortfolio): string {
  return `equity ${money(p.equity)}, uPnL ${money(p.unrealizedPnl)}, ${p.positions.length} positions, ${p.openOrders.length} resting`;
}

// packages/cli/src/commands/trade.ts
// Manual trading (§10): direct orders and the thesis-ticket entry path.
// Every order goes through the engine's risk module (§9) — CLI → local engine,
// or CLI → control API → deployed bot.

import { readFileSync } from "node:fs";
import pc from "picocolors";
import {
  Engine,
  FixtureSignalSource,
  ConsoleAlerter,
  KeyRoles,
  LiveSignalSource,
  captionFromThesis,
  consoleLogger,
  isSignalFresh,
  type BotConfig,
  type ManualOrderParams,
  type ManualOrderResult,
  type ThesisTicket,
} from "@quotient-forecasting/cassie-core";
import { SqliteStateStore } from "@quotient-forecasting/cassie-runtime-node";
import { adapterFor, confirm, controlFetch, getKeystoreSecret, isDeployed, requireAccount } from "../context.js";
import { loadBotConfig, statePath } from "../paths.js";
import { resolveQuotientToken } from "../quotient-token.js";
import { latestForecastThesis } from "../forecast-note.js";
import { approvalLoop, elicitTicket, loadMappings, predictionSizeFor, saveThesis, snapshotFor } from "./ticket.js";

/**
 * When live Quotient signals are reachable, pull the model probability for the
 * thesis market instead of asking the operator. Returns the probability for the
 * THESIS side (mirroring the signal's side when they differ), or undefined.
 */
async function liveSignalProb(botId: string, cfg: BotConfig, thesis: ThesisTicket): Promise<number | undefined> {
  try {
    const token = (await resolveQuotientToken(botId))?.token;
    if (!token) return undefined;
    const source = new LiveSignalSource(cfg.signals, token);
    const sigs = await source.latest({ venue: "polymarket", marketRef: thesis.instrument });
    const fresh = sigs.filter((s) => isSignalFresh(s, Date.now())).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    const sig = fresh[0];
    if (!sig || sig.prob === undefined) return undefined;
    return sig.side === thesis.side ? sig.prob : 1 - sig.prob;
  } catch {
    return undefined;
  }
}

export interface TradeOpts {
  size?: string;
  limit?: string;
  tif?: string;
  stop?: string;
  trail?: string;
  tp?: string;
  outcome?: string;
  /** Interactive thesis flow: six questions → sized trade → approve → place. */
  thesis?: boolean;
  /** Save the elicited thesis JSON here (with --thesis). */
  save?: string;
  /** Place from a saved thesis JSON. */
  fromThesis?: string;
  mappings?: string;
  yes?: boolean;
  /** Human rationale; the feed caption when the bot publishes (§Ares). */
  note?: string;
  /** Per-order slippage tolerance as a percentage from the touch. */
  slippage?: string;
}

async function localEngine(botId: string): Promise<{ engine: Engine; close: () => void }> {
  const cfg = loadBotConfig(botId);
  const account = requireAccount(cfg);
  const adapter = await adapterFor(cfg, { needCreds: true });
  const state = new SqliteStateStore(statePath(botId));
  const log = consoleLogger(botId);
  const engine = new Engine({
    botId,
    config: cfg,
    adapter,
    account,
    strategy: { id: "manual", tick: async () => [] },
    signals: new FixtureSignalSource("[]"),
    alerter: new ConsoleAlerter(log),
    state,
    log,
  });
  return { engine, close: () => state.close() };
}

async function placeManual(botId: string, params: ManualOrderParams): Promise<ManualOrderResult> {
  const cfg = loadBotConfig(botId);
  if (isDeployed(cfg)) {
    return (await controlFetch(cfg, "/trade", { method: "POST", body: JSON.stringify(params) })) as ManualOrderResult;
  }
  const { engine, close } = await localEngine(botId);
  try {
    return await engine.manualOrder(params);
  } finally {
    close();
  }
}

export async function runTrade(botId: string, sideArg: string | undefined, marketRef: string | undefined, opts: TradeOpts): Promise<void> {
  if (opts.thesis) {
    const cfg = loadBotConfig(botId);
    const thesis = await elicitTicket({ venue: cfg.venue });
    if (opts.save) saveThesis(thesis, opts.save, opts.mappings);
    await tradeFromThesis(botId, thesis, opts);
    return;
  }
  if (opts.fromThesis) {
    const raw = JSON.parse(readFileSync(opts.fromThesis, "utf8")) as ThesisTicket;
    await tradeFromThesis(botId, raw, opts);
    return;
  }
  if (!sideArg || !marketRef) throw new Error("usage: cassie trade <botId> buy|sell <marketRef> --size <n> [...]  (or --thesis, or --from-thesis <file>)");
  const cfg = loadBotConfig(botId);
  const side = sideArg.toUpperCase() === "SELL" ? "SELL" : "BUY";
  const size = Number(opts.size);
  if (!Number.isFinite(size) || size <= 0) throw new Error("--size <n> required (base units: shares/contracts)");
  if (opts.slippage !== undefined) {
    const pct = Number(opts.slippage);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new Error("--slippage <pct> must be between 0 and 100");
  }

  const params: ManualOrderParams = {
    marketRef,
    outcome: opts.outcome ? (opts.outcome.toUpperCase() === "NO" ? "NO" : "YES") : cfg.venue === "polymarket" ? "YES" : undefined,
    side,
    size,
    limitPrice: opts.limit !== undefined ? Number(opts.limit) : undefined,
    tif: opts.tif ? (opts.tif.toUpperCase() as "GTC" | "IOC" | "FOK") : "GTC",
    stopPx: opts.stop !== undefined ? Number(opts.stop) : undefined,
    tpPx: opts.tp !== undefined ? Number(opts.tp) : undefined,
    trailBps: opts.trail !== undefined ? Number(opts.trail) : undefined,
    note: opts.note,
    slippagePct: opts.slippage !== undefined ? Number(opts.slippage) : undefined,
  };

  console.log(pc.bold("order:"));
  console.log(`  ${params.side} ${params.size} ${marketRef}${params.outcome ? ` (${params.outcome})` : ""}`);
  console.log(`  limit: ${params.limitPrice ?? "crossing limit within slippage band"}  tif: ${params.tif}`);
  if (params.stopPx !== undefined || params.tpPx !== undefined || params.trailBps !== undefined) {
    console.log(`  triggers: stop=${params.stopPx ?? "-"} tp=${params.tpPx ?? "-"} trail=${params.trailBps ?? "-"}bps`);
    if (cfg.venue === "polymarket") {
      console.log(pc.yellow("  note: Polymarket stops are synthetic, checked on a timer."));
    }
  }
  if (!opts.yes && !(await confirm("place this order?", false))) return;

  // A widget-only manual post makes Ares invent generic copy such as
  // "manually adding YES". Prefer Q's actual latest published-signal thesis.
  // This is deliberately best-effort and happens only after order
  // confirmation; a read failure never blocks the trade.
  if (params.note === undefined && cfg.venue === "polymarket" && cfg.reporting?.post) {
    try {
      const token = (await resolveQuotientToken(botId))?.token;
      if (token) params.note = await latestForecastThesis(cfg, marketRef, token);
    } catch (error) {
      console.log(pc.dim(`latest forecast thesis unavailable: ${(error as Error).message}`));
    }
    console.log(
      params.note
        ? pc.dim("Ares caption: latest Quotient published-signal thesis")
        : pc.dim("no active published-signal thesis found; skipping the manual Ares post"),
    );
  }

  const result = await placeManual(botId, params);
  printResult(result);
}

function printResult(result: ManualOrderResult): void {
  if (!result.placed) {
    console.log(pc.yellow(`skipped by risk module: ${result.skipReasons.join("; ")}`));
    return;
  }
  console.log(pc.green(`placed ${result.orderId}: size ${result.size} @ ${result.limitPrice}`));
  for (const n of result.notes) console.log(pc.dim(`  ${n}`));
  if (result.syntheticTriggers) {
    console.log(pc.yellow("  synthetic triggers armed"));
  }
}

/** Thesis placement path: `--thesis` (interactive) and `--from-thesis <file>`. */
async function tradeFromThesis(botId: string, raw: ThesisTicket, opts: TradeOpts): Promise<void> {
  const cfg = loadBotConfig(botId);
  const mappings = loadMappings(opts.mappings ?? raw.mappings);
  const adapter = await adapterFor(cfg);
  const account = requireAccount(cfg);

  if (raw.venue !== cfg.venue) {
    throw new Error(`thesis venue "${raw.venue}" does not match bot venue "${cfg.venue}"`);
  }

  if (cfg.venue === "polymarket") {
    // Prediction variant: no meaningful TP/SL; sizing via min(ff, quarter-Kelly).
    const [quote, balances] = await Promise.all([adapter.quote(raw.instrument), adapter.balances(account)]);
    const equity = balances.reduce((s, b) => s + b.total, 0);
    const price = raw.side === "NO" ? 1 - quote.mid : quote.mid;
    const signalProb = await liveSignalProb(botId, cfg, raw);
    const sized = await predictionSizeFor(raw, price, equity, mappings, signalProb);
    if (!(await confirm(`BUY ${sized.size} ${raw.side} shares of ${raw.instrument} (~$${sized.notional})?`, false))) return;
    const result = await placeManual(botId, {
      marketRef: raw.instrument,
      outcome: raw.side === "NO" ? "NO" : "YES",
      side: "BUY",
      size: sized.size,
      note: opts.note ?? captionFromThesis(raw),
    });
    printResult(result);
    return;
  }

  const snap = await snapshotFor(adapter, cfg, raw, mappings);
  const filled = await approvalLoop(raw, snap, mappings);
  if (!filled) {
    console.log("rejected — nothing placed");
    return;
  }
  const result = await placeManual(botId, {
    marketRef: raw.instrument,
    side: filled.ticket.side === "SHORT" ? "SELL" : "BUY",
    size: filled.size,
    stopPx: filled.stopPx,
    tpPx: filled.tpPx,
    trailBps: filled.trailBps,
    note: opts.note ?? captionFromThesis(raw, filled),
  });
  printResult(result);
}

// packages/cli/src/commands/ticket.ts
// Thesis intake (§13). Elicitation wording is mirrored in the skill; the
// arithmetic all happens in core's sizing module. No LLM-produced figure ever
// reaches an order — the numbers below come from buildTicket/buildPredictionSize.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import {
  DEFAULT_MAPPINGS,
  atrEstimator,
  atrSpecFor,
  buildPredictionSize,
  buildTicket,
  parseMappings,
  type BotConfig,
  type FilledTicket,
  type Mappings,
  type MarketSnapshot,
  type ThesisTicket,
  type TicketOverrides,
  type VenueAdapter,
} from "@quotient/cassie-core";
import { ask, confirm } from "../context.js";

export function loadMappings(explicitPath?: string): Mappings {
  const candidates = explicitPath
    ? [explicitPath]
    : [
        // canonical policy file, versioned in the repo (§13)
        join(process.cwd(), "skills/cassie/thesis/mappings.json"),
        join(dirname(fileURLToPath(import.meta.url)), "../../../../skills/cassie/thesis/mappings.json"),
      ];
  for (const p of candidates) {
    if (existsSync(p)) return parseMappings(JSON.parse(readFileSync(p, "utf8")));
  }
  if (explicitPath) throw new Error(`mappings file not found: ${explicitPath}`);
  return DEFAULT_MAPPINGS;
}

/** The six-question flow (§13). Question wording is quoted verbatim by the skill. */
export async function elicitTicket(defaults: Partial<ThesisTicket> = {}): Promise<ThesisTicket> {
  console.log(pc.bold("Thesis intake — six questions; the sizing module does the arithmetic.\n"));
  const venue = (await ask("1a. Venue (hyperliquid / lighter / polymarket)", { default: defaults.venue ?? "hyperliquid" }))
    .trim()
    .toLowerCase() as ThesisTicket["venue"];
  const instrument = (await ask("1b. Instrument (e.g. ETH, or YES-token id)", { default: defaults.instrument })).trim();
  const sideRaw = (await ask(venue === "polymarket" ? "1c. Side (yes/no)" : "1c. Direction (long/short)", {
    default: defaults.side?.toLowerCase() ?? (venue === "polymarket" ? "yes" : "long"),
  }))
    .trim()
    .toUpperCase();
  const confidence = (await ask("2. Confidence (low / medium / high)", { default: "medium" })).trim().toLowerCase() as ThesisTicket["confidence"];
  const timeframe = (await ask("3. Timeframe (intraday / days / weeks / quarter)", { default: "days" })).trim().toLowerCase() as ThesisTicket["timeframe"];
  const magRaw = (await ask("4. Magnitude (small / meaningful / repricing)", { default: "meaningful" })).trim().toLowerCase();
  const magnitude = (magRaw.startsWith("small") ? "small" : magRaw.startsWith("rep") ? "repricing" : "meaningful") as ThesisTicket["magnitude"];
  const invRaw = (await ask('5. Invalidation price (or "none")', { default: "none" })).trim();
  const invalidationPx = invRaw.toLowerCase() === "none" || invRaw === "" ? undefined : Number(invRaw);
  const riskBudgetPct = Number(await ask("6. Risk budget, % of equity (soft cap 2)", { default: "1" }));
  const notes = (await ask("Notes (optional)", { default: "" })).trim() || undefined;
  // Public when the bot publishes to a feed — asked separately from `notes`
  // so private scratch and the copy-trader-facing rationale never blur.
  const reasoningSummary =
    (await ask("Reasoning summary (optional; the caption if this bot posts to a feed)", { default: "" })).trim() ||
    undefined;

  return {
    venue,
    instrument,
    side: (sideRaw === "SHORT" || sideRaw === "NO" ? sideRaw : venue === "polymarket" ? "YES" : "LONG") as ThesisTicket["side"],
    confidence: ["low", "high"].includes(confidence) ? confidence : "medium",
    timeframe: ["intraday", "weeks", "quarter"].includes(timeframe) ? timeframe : "days",
    magnitude,
    invalidationPx: Number.isFinite(invalidationPx) ? invalidationPx : undefined,
    riskBudgetPct: Number.isFinite(riskBudgetPct) && riskBudgetPct > 0 ? riskBudgetPct : 1,
    notes,
    reasoningSummary,
  };
}

export async function snapshotFor(adapter: VenueAdapter, cfg: BotConfig, ticket: ThesisTicket, mappings: Mappings): Promise<MarketSnapshot> {
  const account = cfg.account;
  if (!account) throw new Error("bot has no account");
  const [quote, book, balances] = await Promise.all([
    adapter.quote(ticket.instrument),
    adapter.book(ticket.instrument),
    adapter.balances(account),
  ]);
  const equity = balances.reduce((s, b) => s + b.total, 0);
  let atr = quote.mid * 0.02; // fallback when the venue has no candles (prediction markets)
  if (adapter.candles) {
    const spec = atrSpecFor(mappings, ticket.timeframe);
    const candles = await adapter.candles(ticket.instrument, spec.interval, spec.lookback + 20);
    atr = atrEstimator.estimate(candles, spec.lookback);
  }
  const fundingRate8h = adapter.fundingRate ? await adapter.fundingRate(ticket.instrument).catch(() => undefined) : undefined;
  return { entryPx: quote.mid, atr, equity, fundingRate8h, book, quote, risk: cfg.risk };
}

export function printFilledTicket(t: FilledTicket): void {
  console.log(pc.bold(`\n─── trade: ${t.ticket.side} ${t.ticket.instrument} on ${t.ticket.venue} ───`));
  for (const line of t.lines) {
    const mark = line.warning ? pc.yellow("⚠ ") : "  ";
    console.log(`${mark}${pc.bold(line.field.padEnd(24))} ${line.value}`);
    console.log(`  ${" ".repeat(24)} ${pc.dim(line.provenance)}`);
  }
  console.log(
    `  ${pc.bold("sizing".padEnd(24))} fixed-fractional risk $${t.sizing.fixedFractionalRisk} | quarter-Kelly risk $${t.sizing.quarterKellyRisk} → ${pc.bold(t.sizing.chosen)}`,
  );
  console.log(`  ${pc.bold("order".padEnd(24))} ${t.ticket.side} ${t.size} @ ~${t.entryPx} (notional $${t.notional}, ${t.leverage}x, liq ~${t.liqPx})`);
  if (t.tpPx !== undefined) console.log(`  ${pc.bold("exits".padEnd(24))} stop ${t.stopPx} / take-profit ${t.tpPx}`);
  else if (t.trailBps !== undefined) console.log(`  ${pc.bold("exits".padEnd(24))} stop ${t.stopPx} / trailing ${t.trailBps}bps`);
  else console.log(`  ${pc.bold("exits".padEnd(24))} stop ${t.stopPx}`);
  for (const w of t.warnings) console.log(pc.yellow(`  ⚠ ${w}`));
  for (const v of t.violations) console.log(pc.red(`  ✗ GUARDRAIL: ${v}`));
}

/**
 * Approval loop (§13): approve / edit any field / reject. An edit that breaks a
 * guardrail prints the specific violation and requires a second explicit
 * confirm. Nothing silently blocked, nothing silently passes.
 */
export async function approvalLoop(
  ticket: ThesisTicket,
  snap: MarketSnapshot,
  mappings: Mappings,
): Promise<FilledTicket | null> {
  let overrides: TicketOverrides = {};
  for (;;) {
    const filled = buildTicket(ticket, snap, mappings, overrides);
    printFilledTicket(filled);
    const action = (await ask("approve / edit / reject", { default: filled.violations.length ? "edit" : "approve" }))
      .trim()
      .toLowerCase();
    if (action.startsWith("r")) return null;
    if (action.startsWith("e")) {
      const field = (await ask("edit which field? (stop / tp / size / risk)", { default: "stop" })).trim().toLowerCase();
      const value = Number(await ask(`new value for ${field}`));
      if (!Number.isFinite(value)) {
        console.log(pc.red("not a number"));
        continue;
      }
      if (field.startsWith("stop")) overrides = { ...overrides, stopPx: value };
      else if (field.startsWith("tp") || field.startsWith("t")) overrides = { ...overrides, tpPx: value };
      else if (field.startsWith("si")) overrides = { ...overrides, size: value };
      else if (field.startsWith("r")) overrides = { ...overrides, riskBudgetPct: value };
      continue;
    }
    // approve
    if (filled.violations.length > 0) {
      console.log(pc.red("\nThis trade violates guardrails:"));
      for (const v of filled.violations) console.log(pc.red(`  ✗ ${v}`));
      const second = await confirm(pc.red("Second confirm: place anyway, overriding the guardrails above?"), false);
      if (!second) continue;
    }
    return filled;
  }
}

/** Save a thesis for later placement with `cassie trade <botId> --from-thesis <file>`. */
export function saveThesis(ticket: ThesisTicket, out: string, mappings?: string): void {
  writeFileSync(out, JSON.stringify({ ...ticket, mappings }, null, 2) + "\n");
  console.log(pc.green(`wrote ${out} — place it later with: cassie trade <botId> --from-thesis ${out}`));
}

/**
 * Prediction-markets sizing variant (thin by design). When a live Quotient
 * signal supplies the model probability, it is used directly; otherwise the
 * operator is asked. Either way the arithmetic runs in code.
 */
export async function predictionSizeFor(
  ticket: ThesisTicket,
  price: number,
  equity: number,
  mappings: Mappings,
  signalProb?: number,
) {
  let prob: number;
  if (signalProb !== undefined && signalProb > 0 && signalProb < 1) {
    prob = signalProb;
    console.log(pc.dim(`model probability from the live Quotient signal: ${prob.toFixed(4)}`));
  } else {
    const probRaw = await ask("Model probability for the signaled side (0-1)", { default: "0.6" });
    prob = Number(probRaw);
  }
  if (!(prob > 0 && prob < 1)) throw new Error("probability must be in (0,1)");
  const sized = buildPredictionSize(
    { prob, price, equity, riskBudgetPct: ticket.riskBudgetPct, confidence: ticket.confidence },
    mappings,
  );
  console.log(pc.bold("\nprediction sizing:"));
  for (const a of sized.arithmetic) console.log("  " + pc.dim(a));
  console.log(`  entry threshold for confidence "${ticket.confidence}": ${sized.entrySpreadPp}pp`);
  console.log(`  → ${sized.size} shares (~$${sized.notional}), ${sized.chosen}`);
  return sized;
}

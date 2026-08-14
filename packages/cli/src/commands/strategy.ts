// packages/cli/src/commands/strategy.ts
// The one strategy is `signals`: follow Quotient signals, hold until the side
// flips. The wizard offers the recommended settings in one keystroke; this
// command is the manual flow for tuning them.

import pc from "picocolors";
import { ask, confirm } from "../context.js";
import { loadBotConfig, saveBotConfig } from "../paths.js";

export const RECOMMENDED_STRATEGY = {
  sizing: "quarter-kelly",
  entrySpreadPp: 10,
  maxPositionNotional: 1000,
  minEntryNotional: 1,
  maxOpenPositions: 100,
  reenterOnFlip: true,
  universe: "from-signals",
  tickIntervalMin: 5,
} as const;

export const RECOMMENDED_SUMMARY = "quarter-Kelly sizing, 10pp entry edge, positions until the budget is used";

export async function elicitStrategyConfig(current: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const d = (k: string, fallback: string) => String(current[k] ?? fallback);
  const sizing = (await ask("Sizing (quarter-kelly / fixed)", { default: d("sizing", "quarter-kelly") })).trim();
  const entrySpreadPp = Number(await ask("Entry spread (pp)", { default: d("entrySpreadPp", "10") }));
  const maxPositionNotional = Number(await ask("Max position ($)", { default: d("maxPositionNotional", "1000") }));
  const minEntryNotional = Number(await ask("Minimum entry ($)", { default: d("minEntryNotional", "1") }));
  const maxOpenPositions = Number(await ask("Max open positions", { default: d("maxOpenPositions", "100") }));
  const tickIntervalMin = Number(await ask("Tick interval (min)", { default: d("tickIntervalMin", "5") }));
  const universeRaw = (await ask("Universe (from-signals or marketRefs)", { default: d("universe", "from-signals") })).trim();
  return {
    sizing: sizing === "fixed" ? "fixed" : "quarter-kelly",
    entrySpreadPp,
    maxPositionNotional,
    minEntryNotional,
    maxOpenPositions,
    reenterOnFlip: true,
    universe: universeRaw === "from-signals" ? "from-signals" : universeRaw.split(",").map((s) => s.trim()),
    tickIntervalMin,
  };
}

export interface StrategyOptions {
  minEntryNotional?: string;
  signalMaxAgeHours?: string;
}

/** `cassie strategy <botId>`: view and tune the bot's strategy and signal guardrails. */
export async function runStrategy(botId: string, opts: StrategyOptions = {}): Promise<void> {
  const cfg = loadBotConfig(botId);
  if (opts.minEntryNotional !== undefined || opts.signalMaxAgeHours !== undefined) {
    const strategyConfig = { ...cfg.strategy.config };
    if (opts.minEntryNotional !== undefined) {
      strategyConfig.minEntryNotional = parseNumber("minimum entry notional", opts.minEntryNotional, true);
    }
    const maxAgeSec =
      opts.signalMaxAgeHours === undefined
        ? cfg.signals.maxAgeSec
        : parseNumber("signal max age hours", opts.signalMaxAgeHours, false) * 60 * 60;
    saveBotConfig({
      ...cfg,
      strategy: { ...cfg.strategy, config: strategyConfig },
      signals: { ...cfg.signals, maxAgeSec },
    });
    console.log(pc.green(`saved strategy guardrails for ${botId}`));
    console.log(pc.dim(`minimum entry: $${Number(strategyConfig.minEntryNotional ?? 1).toFixed(2)}`));
    console.log(pc.dim(`signal max age: ${(maxAgeSec / 3600).toFixed(2)}h`));
    return;
  }
  console.log(pc.bold(`strategy: signals`));
  console.log(pc.dim(JSON.stringify(cfg.strategy.config, null, 2)));
  console.log(pc.dim(`signal max age: ${(cfg.signals.maxAgeSec / 3600).toFixed(2)}h`));
  if (await confirm(`Reset to recommended (${RECOMMENDED_SUMMARY})?`, false)) {
    saveStrategy(botId, { ...RECOMMENDED_STRATEGY });
    return;
  }
  const config = await elicitStrategyConfig(cfg.strategy.config as Record<string, unknown>);
  saveStrategy(botId, config);
}

function parseNumber(label: string, raw: string, allowZero: boolean): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${label} must be ${allowZero ? "zero or greater" : "greater than zero"}`);
  }
  return value;
}

function saveStrategy(botId: string, config: Record<string, unknown>): void {
  const cfg = loadBotConfig(botId);
  saveBotConfig({
    ...cfg,
    strategy: { id: "signals", config },
    tickIntervalMin: Number(config.tickIntervalMin ?? cfg.tickIntervalMin),
  });
  console.log(pc.green(`saved strategy settings for ${botId}`));
}

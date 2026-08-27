// packages/cli/src/commands/agent.ts
// The `cassie agent` command group: configure the monitoring-agent strategy's
// prompt and persona, inspect its last wake, and dry-run a full scan+decide
// cycle without placing orders. The persona call costs $1 and is confirmed
// every time; the stored brief is reused across wakes and redeploys.

import { join } from "node:path";
import pc from "picocolors";
import {
  QuotientResearchClient,
  parseBotConfig,
  renderPersonaBrief,
  type BotConfig,
} from "@quotient-forecasting/cassie-core";
import { buildLocalService, SqliteStateStore } from "@quotient-forecasting/cassie-runtime-node";
import { AgentConfigSchema, type AgentRunReport } from "@quotient-forecasting/strategy-agent";
import { ask, buildRuntimeCreds, confirm, controlFetch, isDeployed, requireAccount } from "../context.js";
import { atomicWritePrivateFile, cassieHome, loadBotConfig, safeBotId, saveBotConfig, statePath } from "../paths.js";
import { resolveQuotientToken } from "../quotient-token.js";
import { resolveSurplusApiKey } from "../surplus-config.js";
import { QUOTIENT_CALL_COST_USD } from "@quotient-forecasting/cassie-core";

export const AGENT_STRATEGY_SUMMARY =
  "agent — describe what to look for in plain language; each wake it scans the venue, checks Quotient forecasts, and lets the model pick entries, sized by quarter-Kelly inside your budget";

function requireAgentBot(cfg: BotConfig): void {
  if (cfg.strategy.id !== "agent") {
    throw new Error(`bot "${cfg.id}" runs the "${cfg.strategy.id}" strategy — re-run \`cassie init\` and choose the agent strategy`);
  }
}

function personaRawPath(botId: string): string {
  return join(cassieHome(), "bots", `${safeBotId(botId)}.persona.json`);
}

/** Elicit the agent strategy's config (persona is wired separately, in init). */
export async function elicitAgentConfig(existing: Record<string, unknown>): Promise<Record<string, unknown>> {
  console.log(pc.dim("The model decides what and whether; quarter-Kelly code decides how much. Every order still crosses the risk module."));
  const prompt = (await ask("Agent mandate (plain language: what should it look for?)", {
    default: typeof existing.prompt === "string" ? existing.prompt : undefined,
  })).trim();
  if (!prompt) throw new Error("the agent strategy needs a mandate prompt");
  const existingCriteria = (existing.criteria ?? {}) as Record<string, unknown>;
  const budgetUsd = Number(await ask("Agent bankroll, USD (caps Kelly sizing and total deployed)", {
    default: String(existing.budgetUsd ?? 100),
  }));
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error("bankroll must be a positive dollar amount");
  const riskBudgetPct = Number(await ask("Per-trade risk cap, % of bankroll (quarter-Kelly may size below it)", {
    default: String(existing.riskBudgetPct ?? 5),
  }));
  const maxDaysRaw = (await ask('Only markets ending within how many days? (or "any")', {
    default: existingCriteria.maxDaysToEnd !== undefined ? String(existingCriteria.maxDaysToEnd) : "any",
  })).trim().toLowerCase();
  const minVolume24h = Number(await ask("Minimum 24h volume, USD", {
    default: String(existingCriteria.minVolume24h ?? 10_000),
  }));
  const categoriesRaw = (await ask('Category keywords, comma-separated (or "any")', {
    default: Array.isArray(existingCriteria.categories) && existingCriteria.categories.length > 0
      ? (existingCriteria.categories as string[]).join(", ")
      : "any",
  })).trim();
  const agentIntervalMin = Number(await ask("Wake interval, minutes (paid research runs each wake)", {
    default: String(existing.agentIntervalMin ?? 60),
  }));

  const config: Record<string, unknown> = {
    ...existing,
    prompt,
    criteria: {
      ...(maxDaysRaw !== "any" && Number.isFinite(Number(maxDaysRaw)) ? { maxDaysToEnd: Number(maxDaysRaw) } : {}),
      minVolume24h: Number.isFinite(minVolume24h) ? minVolume24h : 10_000,
      categories:
        categoriesRaw && categoriesRaw.toLowerCase() !== "any"
          ? categoriesRaw.split(",").map((c) => c.trim()).filter(Boolean)
          : [],
    },
    budgetUsd,
    riskBudgetPct: Number.isFinite(riskBudgetPct) && riskBudgetPct > 0 ? riskBudgetPct : 5,
    agentIntervalMin: Number.isFinite(agentIntervalMin) && agentIntervalMin > 0 ? agentIntervalMin : 60,
  };
  // Validate now so a bad answer fails here, not at the first wake.
  AgentConfigSchema.parse(config);
  return config;
}

/**
 * Fetch and store the persona for a bot: one $1 Quotient profile call,
 * confirmed explicitly, rendered to a deterministic brief. Returns the
 * persona config block; the raw profile JSON is kept next to the bot config
 * for refresh diffing.
 */
export async function fetchAndStorePersona(
  botId: string,
  cfg: BotConfig,
  handle: string,
): Promise<{ handle: string; brief: string; fetchedAt: string } | undefined> {
  const cleaned = handle.replace(/^@/, "").trim();
  if (!cleaned) return undefined;
  const token = (await resolveQuotientToken(botId))?.token;
  if (!token) throw new Error("persona profiling needs a Quotient API key (environment, .local.env, or bot keystore)");
  if (!(await confirm(`Profile @${cleaned} via Quotient now? This call costs $${QUOTIENT_CALL_COST_USD.profileX.toFixed(2)}.`, true))) {
    return undefined;
  }
  const research = new QuotientResearchClient({ baseUrl: cfg.signals.baseUrl, token });
  const raw = await research.profileX({ handle: cleaned, lookbackDays: 120, focus: "trading" });
  const brief = renderPersonaBrief({ handle: cleaned, ...(raw as Record<string, unknown>) });
  atomicWritePrivateFile(personaRawPath(botId), JSON.stringify(raw, null, 2) + "\n");
  console.log(pc.green(`persona stored (${brief.length} chars); raw profile at ${personaRawPath(botId)}`));
  return { handle: cleaned, brief, fetchedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

export async function agentPrompt(botId: string, opts: { set?: string }): Promise<void> {
  const cfg = loadBotConfig(botId);
  requireAgentBot(cfg);
  const config = cfg.strategy.config as Record<string, unknown>;
  if (opts.set === undefined) {
    console.log(pc.bold("agent mandate:"));
    console.log(String(config.prompt ?? "(unset)"));
    return;
  }
  const next = { ...config, prompt: opts.set.trim() };
  AgentConfigSchema.parse(next);
  saveBotConfig(parseBotConfig({ ...cfg, strategy: { id: "agent", config: next } }));
  console.log(pc.green("mandate updated"));
  if (cfg.deployment) console.log(pc.yellow(`the droplet still runs the old prompt — apply it with cassie deploy ${botId}`));
}

export async function agentPersona(botId: string, opts: { handle?: string; refresh?: boolean }): Promise<void> {
  const cfg = loadBotConfig(botId);
  requireAgentBot(cfg);
  const config = cfg.strategy.config as Record<string, unknown>;
  const persona = config.persona as { handle: string; brief: string; fetchedAt: string } | undefined;

  if (!opts.handle && !opts.refresh) {
    if (!persona) {
      console.log("no persona configured — add one with: cassie agent persona " + botId + " --handle <x-handle>");
      return;
    }
    console.log(pc.bold(`persona: @${persona.handle} (fetched ${persona.fetchedAt})`));
    console.log(persona.brief);
    return;
  }

  const handle = opts.handle ?? persona?.handle;
  if (!handle) throw new Error("--refresh needs a stored persona or an explicit --handle");
  const fetched = await fetchAndStorePersona(botId, cfg, handle);
  if (!fetched) return;
  const next = { ...config, persona: fetched };
  AgentConfigSchema.parse(next);
  saveBotConfig(parseBotConfig({ ...cfg, strategy: { id: "agent", config: next } }));
  console.log(pc.green(`persona @${fetched.handle} saved to the bot config`));
  if (cfg.deployment) console.log(pc.yellow(`the droplet still runs the old persona — apply it with cassie deploy ${botId}`));
}

export async function agentStatus(botId: string): Promise<void> {
  const cfg = loadBotConfig(botId);
  requireAgentBot(cfg);
  if (isDeployed(cfg)) {
    const status = (await controlFetch(cfg, "/agent/status")) as { config?: unknown; lastRun?: AgentRunReport };
    printAgentStatus(status.config, status.lastRun);
    return;
  }
  const parsed = AgentConfigSchema.parse(cfg.strategy.config);
  const state = new SqliteStateStore(statePath(botId));
  try {
    const raw = await state.get("strategy:agent:lastRun");
    printAgentStatus(
      {
        prompt: parsed.prompt,
        personaHandle: parsed.persona?.handle,
        budgetUsd: parsed.budgetUsd,
        agentIntervalMin: parsed.agentIntervalMin,
        model: parsed.llm.modelPool[0],
      },
      raw ? (JSON.parse(raw) as AgentRunReport) : undefined,
    );
  } finally {
    state.close();
  }
}

export async function agentDryRun(botId: string): Promise<void> {
  const cfg = loadBotConfig(botId);
  requireAgentBot(cfg);
  console.log(pc.dim("dry run: full scan + decide cycle — spends real Quotient/Surplus calls, places nothing, persists nothing."));

  let report: AgentRunReport;
  if (isDeployed(cfg)) {
    report = (await controlFetch(cfg, "/agent/dry-run", { method: "POST" })) as AgentRunReport;
  } else {
    const account = requireAccount(cfg);
    const creds = await buildRuntimeCreds(cfg);
    const quotientToken = (await resolveQuotientToken(botId))?.token;
    const surplus = await resolveSurplusApiKey(botId);
    if (!surplus) throw new Error("no SURPLUS_API_KEY found in the environment, nearest .local.env, or bot keystore");
    console.log(pc.dim(`Surplus credential: ${surplus.origin}`));
    const service = buildLocalService({
      config: cfg,
      account,
      creds,
      statePath: statePath(botId),
      quotientToken,
      surplusApiKey: surplus.value,
    });
    try {
      report = await service.agentDryRun();
    } finally {
      await service.shutdown(false);
    }
  }
  printRunReport(report);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function printAgentStatus(config: unknown, lastRun?: AgentRunReport): void {
  console.log(pc.bold("agent configuration:"));
  for (const [key, value] of Object.entries((config ?? {}) as Record<string, unknown>)) {
    if (value !== undefined) console.log(`  ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  if (!lastRun) {
    console.log(pc.dim("no wake has run yet"));
    return;
  }
  console.log(pc.bold(`\nlast wake (${lastRun.ranAt}):`));
  printRunReport(lastRun);
}

function printRunReport(report: AgentRunReport): void {
  if (report.error) {
    console.log(pc.red(`wake failed: ${report.error}`));
    return;
  }
  console.log(
    `discovered ${report.discovered} markets on ${report.venue}; ${report.candidates.length} candidates to the model; quotient spend $${report.quotientSpendUsd.toFixed(3)}`,
  );
  if (report.model) console.log(pc.dim(`model: ${report.model} (${report.promptTokens ?? 0} in / ${report.completionTokens ?? 0} out tokens)`));
  if (report.assessment) console.log(`\n${pc.bold("assessment:")} ${report.assessment}`);

  if (report.candidates.length > 0) {
    console.log(pc.bold("\ntop candidates:"));
    for (const c of report.candidates.slice(0, 10)) {
      const q = c.qProb !== undefined ? ` q=${(c.qProb * 100).toFixed(0)}%` : "";
      const price = c.price !== undefined ? ` @ ${c.price.toFixed(2)}` : "";
      const spread = c.spreadPp !== undefined ? ` (${c.spreadPp}pp)` : "";
      console.log(`  ${c.marketRef}${price}${q}${spread}  ${c.question.slice(0, 70)}`);
    }
  }

  if (report.executed.length === 0) {
    console.log(pc.dim("\nno decisions to act on"));
    return;
  }
  console.log(pc.bold("\ndecisions:"));
  for (const line of report.executed) {
    if (line.skipped) {
      console.log(pc.yellow(`  skip  ${line.kind} ${line.marketRef}: ${line.skipped}`));
      continue;
    }
    const size = line.notional !== undefined ? ` ~$${line.notional.toFixed(2)}` : "";
    console.log(pc.green(`  ${line.kind}  ${line.marketRef}${line.side ? ` ${line.side}` : ""}${size}`));
    for (const a of line.arithmetic ?? []) console.log(pc.dim(`        ${a}`));
  }
}

// strategies/agent/src/index.ts
// The monitoring-agent strategy: on each paid wake it discovers markets on the
// bot's venue, enriches them with Quotient forecasts (metered, batched,
// cached), asks one structured Surplus completion to select/rank/veto, and
// sizes every accepted entry deterministically (quarter-Kelly via
// buildPredictionSize) inside the configured bankroll. The engine's risk
// module still gates every resulting order — this strategy only returns
// Action[] like any other.
//
// Engine ticks between wakes are free housekeeping (redeems); the paid cycle
// runs at agentIntervalMin gated by a memory timestamp, so restarts never
// double-spend a wake.

import {
  isPredictionVenue,
  type Action,
  type MarketFilter,
  type MarketLister,
  type MarketRow,
  type QuotientMarketRow,
  type Strategy,
  type StrategyActionResult,
  type StrategyContext,
  type StructuredRequest,
  type SurplusCompletion,
} from "@quotient-forecasting/cassie-core";
import {
  AGENT_MEMORY_KEYS,
  AgentConfigSchema,
  AgentDecisionBatchSchema,
  type AgentConfig,
  type AgentRunReport,
  type Candidate,
  type ExecutedLine,
  type HeldBrief,
} from "./schema.js";
import { buildSystemPrompt, buildUserMessage } from "./prompt.js";
import { QuotientCallBudget, cachedForecast, storeForecast } from "./budget.js";
import { gateAndSize, quotientRowMatches, rankCandidates, toCandidate } from "./pipeline.js";
import { QUOTIENT_CALL_COST_USD, QUOTIENT_LOOKUP_BATCH_LIMIT } from "@quotient-forecasting/cassie-core";

export * from "./schema.js";
export * from "./pipeline.js";
export * from "./budget.js";
export { buildSystemPrompt, buildUserMessage } from "./prompt.js";

/** Structural slices of the core clients, so tests inject plain fakes. */
export interface SurplusCompleter {
  completeStructured<T>(req: StructuredRequest<T>): Promise<SurplusCompletion<T>>;
}

export interface QuotientResearch {
  searchMarkets(params: { q: string; venue?: string; limit?: number }): Promise<QuotientMarketRow[]>;
  mispriced(params?: { venue?: string; minSpread?: number; limit?: number }): Promise<QuotientMarketRow[]>;
  lookup(params: { marketKeys?: string[]; conditionIds?: string[]; venue?: string }): Promise<QuotientMarketRow[]>;
}

export interface AgentStrategyDeps {
  surplus: SurplusCompleter;
  research: QuotientResearch;
  lister: MarketLister;
}

/** Implemented by strategies that support a read-only dry-run cycle. */
export interface PreviewableStrategy {
  preview(ctx: StrategyContext): Promise<AgentRunReport>;
}

interface DailyBudgetState {
  utcDay: string;
  placedUsd: number;
}

export class AgentStrategy implements Strategy, PreviewableStrategy {
  readonly id = "agent";

  constructor(private readonly deps: AgentStrategyDeps) {}

  async tick(ctx: StrategyContext): Promise<Action[]> {
    const cfg = AgentConfigSchema.parse(ctx.config ?? {});
    const actions: Action[] = [];

    // Housekeeping every tick, before any paid work: venue-required redemptions.
    for (const pos of ctx.positions) {
      if (pos.redeemable) actions.push({ kind: "redeem", marketRef: pos.marketRef, reason: "market resolved" });
    }

    const now = ctx.now();
    const lastRunAt = (await ctx.memory.get<number>(AGENT_MEMORY_KEYS.lastRunAt)) ?? 0;
    if (now - lastRunAt < cfg.agentIntervalMin * 60_000) return actions;

    // The wake timestamp commits before the cycle: a persistently failing wake
    // must wait out the interval like a successful one, or it would re-buy the
    // same Quotient calls every engine tick.
    await ctx.memory.set(AGENT_MEMORY_KEYS.lastRunAt, now);
    try {
      const { actions: cycleActions, report } = await this.runCycle(ctx, cfg, { commit: true });
      await ctx.memory.set(AGENT_MEMORY_KEYS.lastRun, report);
      actions.push(...cycleActions);
    } catch (err) {
      const message = (err as Error).message;
      ctx.log.error(`agent wake failed: ${message}`);
      await ctx.memory.set<AgentRunReport>(AGENT_MEMORY_KEYS.lastRun, {
        ranAt: new Date(now).toISOString(),
        venue: ctx.venueId,
        discovered: 0,
        candidates: [],
        held: [],
        executed: [],
        quotientSpendUsd: 0,
        error: message,
      });
    }
    return actions;
  }

  /** Full scan+decide cycle with nothing persisted and nothing placed. */
  async preview(ctx: StrategyContext): Promise<AgentRunReport> {
    const cfg = AgentConfigSchema.parse(ctx.config ?? {});
    const { report } = await this.runCycle(ctx, cfg, { commit: false });
    return report;
  }

  async onActionResult(ctx: StrategyContext, action: Action, result: StrategyActionResult): Promise<void> {
    if (action.kind !== "enter" || !result.placed || !(result.placedNotional && result.placedNotional > 0)) return;
    const current = await this.dailyBudgetState(ctx, ctx.now());
    await ctx.memory.set<DailyBudgetState>(AGENT_MEMORY_KEYS.dailyBudget, {
      utcDay: current.utcDay,
      placedUsd: current.placedUsd + result.placedNotional,
    });
  }

  private async dailyBudgetState(ctx: StrategyContext, now: number): Promise<DailyBudgetState> {
    const utcDay = new Date(now).toISOString().slice(0, 10);
    const saved = await ctx.memory.get<DailyBudgetState>(AGENT_MEMORY_KEYS.dailyBudget);
    return saved?.utcDay === utcDay ? saved : { utcDay, placedUsd: 0 };
  }

  private async runCycle(
    ctx: StrategyContext,
    cfg: AgentConfig,
    opts: { commit: boolean },
  ): Promise<{ actions: Action[]; report: AgentRunReport }> {
    if (!isPredictionVenue(ctx.venueId)) {
      throw new Error(`the agent strategy runs on prediction venues; this bot trades ${ctx.venueId}`);
    }
    const now = ctx.now();
    const spend = new QuotientCallBudget(cfg.maxQuotientSpendUsdPerWake);
    const cacheTtlMs = cfg.quotientCacheTtlMin * 60_000;

    // 1. Discovery — free venue catalog reads, filtered deterministically.
    const filter: MarketFilter = {
      maxDaysToEnd: cfg.criteria.maxDaysToEnd,
      minVolume24h: cfg.criteria.minVolume24h,
      categories: cfg.criteria.categories,
    };
    const discovered = await this.deps.lister.list(filter);
    const byRef = new Map<string, MarketRow>(discovered.map((row) => [row.marketRef, row]));

    // 2. Quotient enrichment — metered. Feed calls first (broad, one call
    // each), then targeted lookups for what still lacks a forecast.
    const qByRef = new Map<string, QuotientMarketRow>();
    const attach = (rows: QuotientMarketRow[]): void => {
      for (const q of rows) {
        for (const row of discovered) {
          if (!qByRef.has(row.marketRef) && quotientRowMatches(row, q)) qByRef.set(row.marketRef, q);
        }
      }
    };
    for (const row of discovered) {
      const cached = await cachedForecast(ctx.memory, row.marketRef, cacheTtlMs, now);
      if (cached) qByRef.set(row.marketRef, cached);
    }
    if (spend.canSpend(QUOTIENT_CALL_COST_USD.mispriced)) {
      try {
        attach(await this.deps.research.mispriced({ venue: ctx.venueId }));
        spend.spend(QUOTIENT_CALL_COST_USD.mispriced);
      } catch (err) {
        ctx.log.warn(`mispriced feed unavailable: ${(err as Error).message}`);
      }
    }
    if (spend.canSpend(QUOTIENT_CALL_COST_USD.search)) {
      try {
        attach(await this.deps.research.searchMarkets({ q: cfg.prompt.slice(0, 200), venue: ctx.venueId, limit: 50 }));
        spend.spend(QUOTIENT_CALL_COST_USD.search);
      } catch (err) {
        ctx.log.warn(`market search unavailable: ${(err as Error).message}`);
      }
    }

    const provisional = rankCandidates(
      discovered.map((row) => toCandidate(row, qByRef.get(row.marketRef))),
      cfg.maxCandidates,
    );

    // Targeted lookups: held markets plus top candidates lacking a forecast.
    // Kalshi refs are their own lookup key; Polymarket needs the conditionId,
    // which only discovery rows carry — a Polymarket position absent from the
    // catalog read stays unenriched this wake.
    const needsLookup: string[] = [];
    for (const pos of ctx.positions) {
      if ((pos.side === "YES" || pos.side === "NO") && !qByRef.has(pos.marketRef)) needsLookup.push(pos.marketRef);
    }
    for (const cand of provisional) {
      if (cand.qProb === undefined && !needsLookup.includes(cand.marketRef)) needsLookup.push(cand.marketRef);
    }
    for (let i = 0; i < needsLookup.length; i += QUOTIENT_LOOKUP_BATCH_LIMIT) {
      if (!spend.canSpend(QUOTIENT_CALL_COST_USD.lookup)) {
        ctx.log.info(
          `quotient spend cap $${cfg.maxQuotientSpendUsdPerWake.toFixed(2)} reached; ${needsLookup.length - i} markets stay unenriched this wake`,
        );
        break;
      }
      const chunk = needsLookup.slice(i, i + QUOTIENT_LOOKUP_BATCH_LIMIT);
      try {
        const rows =
          ctx.venueId === "kalshi"
            ? await this.deps.research.lookup({ marketKeys: chunk.map((ref) => `kalshi:${ref}`), venue: "kalshi" })
            : await this.deps.research.lookup({
                conditionIds: chunk
                  .map((ref) => byRef.get(ref)?.conditionId)
                  .filter((c): c is string => Boolean(c)),
                venue: "polymarket",
              });
        spend.spend(QUOTIENT_CALL_COST_USD.lookup);
        attach(rows);
        // Direct key match for rows that didn't join through discovery (held markets).
        for (const q of rows) {
          for (const ref of chunk) {
            if (qByRef.has(ref)) continue;
            if (q.nativeMarketId === ref || q.marketKey?.endsWith(`:${ref}`)) qByRef.set(ref, q);
          }
        }
      } catch (err) {
        ctx.log.warn(`quotient lookup failed: ${(err as Error).message}`);
        break;
      }
    }
    if (opts.commit) {
      for (const [ref, q] of qByRef) await storeForecast(ctx.memory, ref, q, now);
    }

    const candidates = rankCandidates(
      discovered.map((row) => toCandidate(row, qByRef.get(row.marketRef))),
      cfg.maxCandidates,
    );

    const held: HeldBrief[] = ctx.positions
      .filter((p) => (p.side === "YES" || p.side === "NO") && p.size > 0)
      .map((p) => ({
        marketRef: p.marketRef,
        side: p.side,
        size: p.size,
        avgPrice: p.avgPrice,
        qProb: qByRef.get(p.marketRef)?.qProbability,
      }));

    // 3. Budget facts — venue-derived so restarts cannot drift the meter.
    const deployedUsd =
      ctx.positions.reduce((s, p) => s + p.size * p.avgPrice, 0) +
      ctx.openOrders.reduce((s, o) => s + Math.max(0, o.size - o.filledSize) * o.price, 0);
    let headroomUsd = Math.max(0, cfg.budgetUsd - deployedUsd);
    const kellyEquityUsd = Math.min(ctx.equity, cfg.budgetUsd);
    const occupied = new Set([
      ...ctx.positions.filter((p) => p.size > 0).map((p) => p.marketRef),
      ...ctx.openOrders.map((o) => o.marketRef),
    ]);
    let slotsFree = Math.max(0, cfg.maxPositions - occupied.size);
    let dailyRemainingUsd: number | undefined;
    if (cfg.dailyBudgetUsd !== undefined) {
      const daily = await this.dailyBudgetState(ctx, now);
      dailyRemainingUsd = Math.max(0, cfg.dailyBudgetUsd - daily.placedUsd);
    }

    const report: AgentRunReport = {
      ranAt: new Date(now).toISOString(),
      venue: ctx.venueId,
      discovered: discovered.length,
      candidates,
      held,
      executed: [],
      quotientSpendUsd: Number(spend.spentUsd.toFixed(3)),
    };

    if (candidates.length === 0 && held.length === 0) {
      ctx.log.info("agent wake: nothing discovered and nothing held; no model call spent");
      return { actions: [], report };
    }

    // 4. One structured decision call.
    const completion = await this.deps.surplus.completeStructured({
      system: buildSystemPrompt(cfg, { headroomUsd, slotsFree, dailyRemainingUsd }),
      user: buildUserMessage(candidates, held),
      schema: AgentDecisionBatchSchema,
      schemaName: "agent_decisions",
      maxOutputTokens: cfg.llm.maxOutputTokens,
    });
    const batch = completion.parsed;
    report.assessment = batch.assessment;
    report.model = completion.actualModel;
    report.decisions = batch;
    report.promptTokens = completion.promptTokens;
    report.completionTokens = completion.completionTokens;
    ctx.log.info(`agent (${completion.actualModel}): ${batch.assessment}`);

    // 5. Deterministic gate + sizing.
    const actions: Action[] = [];
    const knownRefs = new Set([...candidates.map((c) => c.marketRef), ...held.map((h) => h.marketRef)]);
    const heldByRef = new Map(held.map((h) => [h.marketRef, h]));

    for (const exit of batch.exits) {
      const line: ExecutedLine = { kind: "exit", marketRef: exit.marketRef };
      if (!heldByRef.has(exit.marketRef)) {
        line.skipped = "exit for a market this bot does not hold";
      } else {
        actions.push({ kind: "exit", marketRef: exit.marketRef, reason: `agent: ${exit.reason}` });
      }
      report.executed.push(line);
    }

    for (const decision of batch.enters) {
      const line: ExecutedLine = { kind: "enter", marketRef: decision.marketRef, side: decision.side };
      report.executed.push(line);
      if (!knownRefs.has(decision.marketRef)) {
        // The anti-hallucination gate: refs the model invented never trade.
        line.skipped = "marketRef not in the candidate or held set";
        ctx.log.warn(`agent proposed unknown marketRef ${decision.marketRef}; dropped`);
        continue;
      }
      if (occupied.has(decision.marketRef)) {
        line.skipped = "already held or resting";
        continue;
      }
      if (slotsFree <= 0) {
        line.skipped = `maxPositions ${cfg.maxPositions} reached`;
        continue;
      }
      let liveMid: number;
      try {
        liveMid = (await ctx.venue.quote(decision.marketRef)).mid;
      } catch (err) {
        line.skipped = `no live quote: ${(err as Error).message}`;
        continue;
      }
      const sized = gateAndSize(
        decision,
        liveMid,
        qByRef.get(decision.marketRef)?.qProbability,
        cfg,
        kellyEquityUsd,
        headroomUsd,
        dailyRemainingUsd,
      );
      line.sizingProb = sized.sizingProb;
      line.arithmetic = sized.arithmetic;
      if (!sized.ok || sized.notional === undefined) {
        line.skipped = sized.skipped ?? "not sized";
        ctx.log.info(`agent skip ${decision.marketRef}: ${line.skipped}`);
        continue;
      }
      line.notional = sized.notional;
      actions.push({
        kind: "enter",
        marketRef: decision.marketRef,
        side: decision.side,
        notional: sized.notional,
        minNotional: cfg.minEntryNotional,
        reason: `agent: ${decision.rationale.slice(0, 160)}${decision.personaNote ? ` [persona: ${decision.personaNote.slice(0, 80)}]` : ""}`,
      });
      headroomUsd -= sized.notional;
      if (dailyRemainingUsd !== undefined) dailyRemainingUsd = Math.max(0, dailyRemainingUsd - sized.notional);
      slotsFree -= 1;
      occupied.add(decision.marketRef);
    }

    return { actions, report };
  }
}

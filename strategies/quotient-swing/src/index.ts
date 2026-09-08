// strategies/quotient-swing/src/index.ts
// Strategy adapter: inputs and memory only; the engine owns orders, stops and targets.
import { createHash } from "node:crypto";
import type { Action, Strategy, StrategyActionResult, StrategyContext } from "@quotient-forecasting/cassie-core";
import { QuotientSwingConfigSchema } from "./schema.js";
import { createSwingState, reduceSwing } from "./reducer.js";
import type { SwingDecision, SwingReduction, SwingSnapshotProvider, SwingState } from "./types.js";

export * from "./types.js";
export * from "./schema.js";
export * from "./math.js";
export * from "./selection.js";
export * from "./risk.js";
export * from "./reducer.js";
export * from "./replay.js";

export const SWING_STATE_KEY = "quotient-swing:state";
export const SWING_REPORT_KEY = "quotient-swing:report";

const stableClientId = (seed: string): string => `0x${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;

export function swingDecisionToAction(decision: SwingDecision): Action {
  if (decision.kind === "cancel") return decision;
  if (decision.kind === "target") return { kind: "target", marketRef: decision.marketRef, targetPx: decision.targetPrice, reason: decision.reason };
  if (decision.kind === "exit") return { kind: "exit", marketRef: decision.marketRef, fraction: 1,
    reason: decision.reason, urgent: decision.urgent, tif: decision.postOnly ? "GTC" : "IOC", postOnly: decision.postOnly ?? false,
    ...(decision.limitPrice !== undefined ? { limitPrice: decision.limitPrice } : {}) };
  const c = decision.candidate, clientId = stableClientId(decision.clientId);
  // The executor prices the crossing from its own fresh book; the strategy's entry price only sizes the trade.
  return { kind: "enter", marketRef: c.marketRef, side: c.side, notional: decision.notional,
    minNotional: c.minNotional, tif: "IOC", postOnly: false,
    stopPx: c.stopPrice, targetPx: c.targetPrice, leverage: decision.leverage, clientId,
    anchorAt: c.outlook.anchorAt, themes: c.themes, reason: "quotient_edge",
    provenance: { strategy: "quotient-swing", outlookId: c.outlook.id, basisId: c.outlook.basisId,
      targetFamilyKey: c.outlook.targetFamilyKey, gapSigma: c.gapSigma, scoreSigma: c.outlook.scoreSigma,
      mode: c.outlook.mode, freshnessReason: c.outlook.freshnessReason, netEdge: c.netEdge,
      stopFraction: c.stopFraction, targetPrice: c.targetPrice, marginUsd: decision.marginUsd,
      liquidationPrice: decision.liquidationPrice, fundingFraction: c.fundingFraction,
      record: { ...decision.record, clientId } } };
}

export class QuotientSwingStrategy implements Strategy {
  readonly id = "quotient-swing";
  constructor(private readonly deps: SwingSnapshotProvider) {}

  async preview(ctx: StrategyContext): Promise<SwingReduction> {
    const snapshot = await this.deps.snapshot(ctx);
    const cfg = QuotientSwingConfigSchema.parse(ctx.config ?? {});
    const state = await ctx.memory.get<SwingState>(SWING_STATE_KEY) ?? createSwingState(snapshot.nav);
    return reduceSwing(snapshot, state, cfg);
  }

  async tick(ctx: StrategyContext): Promise<Action[]> {
    if (ctx.venueId !== "hyperliquid" && ctx.venueId !== "fixture") throw new Error("quotient-swing requires Hyperliquid");
    const cfg = QuotientSwingConfigSchema.parse(ctx.config ?? {});
    const snapshot = await this.deps.snapshot(ctx);
    const stored = await ctx.memory.get<SwingState>(SWING_STATE_KEY) ?? createSwingState(snapshot.nav);
    // Restore decision provenance from the engine's durable cycles after an interrupted handoff.
    for (const cycle of ctx.perpExecution?.cycles ?? []) {
      if (cycle.status === "closed") continue;
      const record = cycle.provenance?.record as SwingState["entries"][string] | undefined;
      const existing = stored.entries[cycle.marketRef] ?? (record?.marketRef === cycle.marketRef ? record : undefined);
      if (existing) stored.entries[cycle.marketRef] = { ...existing,
        status: cycle.status === "pending" ? "accepted" : cycle.status === "exiting" ? "exiting" : "held",
        filledAt: cycle.openedAt ?? existing.filledAt, entryPrice: cycle.entryPrice,
        initialStop: cycle.initialStopPx, originalAnchorAt: cycle.anchorAt, stopPrice: cycle.stopPx,
        targetPrice: cycle.targetPx ?? existing.targetPrice, size: cycle.filledSize, leverage: cycle.leverage };
    }
    if (ctx.perpExecution) {
      // The engine owns cash-flow-adjusted live high water and execution halt state.
      stored.halted = ctx.perpExecution.halted;
      stored.highWaterNav = ctx.perpExecution.highWaterEquity;
      // A submitted entry the engine no longer tracks (rejected or failed before placement) frees its slot at once.
      for (const [marketRef, entry] of Object.entries(stored.entries)) {
        if ((entry.status === "planned" || entry.status === "accepted") && !entry.filledAt
          && !ctx.perpExecution.cycles.some(c => c.marketRef === marketRef && c.status !== "closed")) delete stored.entries[marketRef];
      }
    }
    const result = reduceSwing(snapshot, stored, cfg);
    const actions = result.decisions.map(swingDecisionToAction);
    for (const action of actions) if (action.kind === "enter" && action.clientId) result.state.entries[action.marketRef]!.clientId = action.clientId;
    await ctx.memory.set(SWING_REPORT_KEY, result);
    await ctx.memory.set(SWING_STATE_KEY, result.state);
    return actions;
  }

  async onActionResult(ctx: StrategyContext, action: Action, result: StrategyActionResult): Promise<void> {
    const state = await ctx.memory.get<SwingState>(SWING_STATE_KEY);
    if (!state) return;
    const record = "marketRef" in action ? state.entries[action.marketRef] : undefined;
    if (!record) return;
    if (action.kind === "enter") {
      if (!result.placed) delete state.entries[action.marketRef];
      else {
        record.status = "accepted";
        record.orderId = result.orderId;
        record.clientId = result.clientId ?? action.clientId ?? record.clientId;
        record.reservedNotional = result.placedNotional ?? record.reservedNotional;
        record.size = result.placedSize ?? record.size;
        record.entryPrice = result.avgFillPrice ?? result.limitPrice ?? record.entryPrice;
        if ((result.filledSize ?? 0) > 0) record.filledAt = result.placedAt ?? ctx.now();
      }
    } else if (action.kind === "exit") {
      if (!result.placed) { record.status = "held"; delete record.exitSubmittedAt; }
    }
    await ctx.memory.set(SWING_STATE_KEY, state);
  }
}

// packages/runtime-node/src/swing-controller.ts
// Research runs outside the serialized execution lane; a started controller trades live once ready.
import {
  Engine, toCloid, type Alerter, type BotConfig, type Logger, type PerpAccountSnapshot,
  type PerpExecutionState, type TickResult, type VenueAccount, type VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import {
  QuotientSwingConfigSchema, QuotientSwingStrategy, SWING_REPORT_KEY, entryProblem, forecastProblem,
  replaySwing, type SwingMarketSnapshot, type SwingReduction, type SwingSnapshot,
} from "@quotient-forecasting/strategy-quotient-swing";
import { SwingQuotientDataClient, type SwingQuotientSnapshot } from "./swing-data.js";
import { SwingRecordingStore, swingResearchHash } from "./swing-recordings.js";
import type { SqliteStateStore } from "./state.js";

export interface SwingControllerDeps {
  config: BotConfig; adapter: VenueAdapter; account: VenueAccount; state: SqliteStateStore;
  statePath: string; alerter: Alerter; log: Logger; quotientToken: string;
  now?: () => number;
  data?: SwingQuotientDataClient;
}

const cloid = (clientId: string): string | undefined => {
  try { return toCloid(clientId).toLowerCase(); } catch { return undefined; }
};

export class SwingController {
  readonly config;
  readonly configHash: string;
  private readonly engine: Engine;
  private readonly strategy: QuotientSwingStrategy;
  private readonly data: SwingQuotientDataClient;
  private readonly recordings: SwingRecordingStore;
  private readonly now: () => number;
  private markets: SwingMarketSnapshot[] = [];
  private researchTimer?: NodeJS.Timeout;
  private marketTimer?: NodeJS.Timeout;
  private researchPromise?: Promise<void>;
  private inputPromise?: Promise<SwingQuotientSnapshot>;
  private researchInputs?: Promise<SwingQuotientSnapshot>;
  private marketPromise?: Promise<void>;
  private lastResearchAt = 0;
  private lastResearchError?: string;
  private lastResearchErrorLoggedAt = 0;
  private readonly marketFailures = new Map<string, { error: string; failures: number; retryAt: number; deferred?: true }>();
  private lastMarketFailureSummary = "";
  private lastMarketFailureLogAt = 0;
  private stopped = false;
  private lastReport?: SwingReduction;
  private execution?: PerpExecutionState;
  private lastExecutionHaltReason?: string;
  private lastExecutionHaltLogAt = 0;

  constructor(private readonly d: SwingControllerDeps) {
    if (d.config.venue !== "hyperliquid") throw new Error("quotient-swing requires Hyperliquid");
    this.now = d.now ?? Date.now;
    this.config = QuotientSwingConfigSchema.parse(d.config.strategy.config);
    this.configHash = swingResearchHash(this.config);
    this.recordings = new SwingRecordingStore(`${d.statePath}.swing.sqlite`);
    this.data = d.data ?? new SwingQuotientDataClient({ baseUrl: d.config.signals.baseUrl, token: d.quotientToken, now: this.now });
    this.strategy = new QuotientSwingStrategy({ snapshot: ctx => this.snapshot(ctx.perpAccount, ctx.perpExecution) });
    this.engine = new Engine({ botId: d.config.id,
      config: { ...d.config, strategy: { id: "quotient-swing", config: this.config } },
      adapter: d.adapter, account: d.account, strategy: this.strategy, signals: { latest: async () => [] },
      state: d.state, alerter: d.alerter, log: d.log, now: this.now });
  }

  /** Starts research and market polling; execution needs no separate startup step. */
  start(): void {
    if (this.stopped || this.researchTimer) return;
    void this.refreshResearch();
    this.researchTimer = setInterval(() => { void this.refreshResearch(); }, this.config.signalPollIntervalMin * 60_000);
    this.marketTimer = setInterval(() => { void this.refreshMarkets(); }, 15_000);
  }
  /** Share paid input reads between preflight and research. */
  private refreshInputs(): Promise<SwingQuotientSnapshot> {
    if (this.inputPromise) return this.inputPromise;
    this.inputPromise = (async () => {
      const q = await this.data.refresh();
      if (this.stopped) return q;
      this.recordings.recordResearch(q.receivedAt, this.configHash, { kind: "quotient", ...q });
      this.lastResearchAt = q.receivedAt;
      await this.refreshMarkets();
      return q;
    })().finally(() => { this.inputPromise = undefined; });
    return this.inputPromise;
  }
  refreshResearch(): Promise<void> {
    if (this.researchPromise) return this.researchPromise;
    this.researchPromise = (async () => {
      try {
        this.researchInputs = this.refreshInputs();
        await this.researchInputs;
        if (this.stopped) return;
        this.lastResearchError = undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown research error";
        if (message !== this.lastResearchError || this.now() - this.lastResearchErrorLoggedAt >= 5 * 60_000) {
          this.d.log.warn(`swing research refresh failed: ${message}`);
          this.lastResearchErrorLoggedAt = this.now();
        }
        this.lastResearchError = message;
      }
    })().finally(() => { this.researchPromise = undefined; this.researchInputs = undefined; });
    return this.researchPromise;
  }
  refreshMarkets(): Promise<void> {
    if (this.marketPromise) return this.marketPromise;
    this.marketPromise = (async () => {
      const q = this.data.cached();
      if (!this.d.adapter.perpMarketSnapshot) return;
      const markets: SwingMarketSnapshot[] = [];
      // Keep failed symbols' old timestamps: stale data cannot become fresh because a poll failed.
      const assets = (q?.assets ?? []).filter(asset => q?.outlooks.some(o => o.assetKey === asset.assetKey && o.marketRef === asset.marketRef));
      const heldRecords = [
        ...(this.execution?.cycles.filter(c => c.status !== "closed").map(c => c.provenance?.record as { assetKey?: string; marketRef?: string } | undefined) ?? []),
      ];
      for (const held of heldRecords) {
        if (!held?.assetKey || !held.marketRef || assets.some(a => a.marketRef === held.marketRef)) continue;
        const known = this.markets.find(m => m.marketRef === held.marketRef);
        const assetClass = known?.assetClass ?? (held.assetKey.startsWith("company:") ? "equity" : held.assetKey.startsWith("commodity:") ? "commodity" : undefined);
        if (assetClass) assets.push({ assetKey: held.assetKey, marketRef: held.marketRef, name: held.assetKey, assetClass });
      }
      const trackedMarkets = new Set(assets.map(asset => asset.marketRef));
      for (const marketRef of this.marketFailures.keys()) if (!trackedMarkets.has(marketRef)) this.marketFailures.delete(marketRef);
      await Promise.all(Array.from({ length: Math.min(4, assets.length) }, async () => {
        while (assets.length && !this.stopped) {
          const asset = assets.shift()!;
          const previous = this.markets.find(m => m.assetKey === asset.assetKey);
          if ((this.marketFailures.get(asset.marketRef)?.retryAt ?? 0) > this.now()) {
            if (previous) markets.push(previous);
            continue;
          }
          try {
            const m = await this.d.adapter.perpMarketSnapshot!(this.d.account, asset.marketRef);
            const outlooks = q?.outlooks.filter(o => o.assetKey === asset.assetKey && o.marketRef === asset.marketRef) ?? [];
            markets.push({ assetKey: asset.assetKey, marketRef: asset.marketRef, assetClass: asset.assetClass,
              active: m.instrument.active && Boolean(q?.assets.some(a => a.assetKey === asset.assetKey && a.marketRef === asset.marketRef)), isolatedSupported: true, maxLeverage: m.instrument.maxLeverage,
              maintenanceMarginRate: m.instrument.maintenanceMarginRate, marginTiers: m.instrument.marginTiers,
              sizeDecimals: m.instrument.szDecimals, minNotional: m.instrument.minNotional,
              priceTick: 10 ** -Math.max(0, Math.min(6 - m.instrument.szDecimals, 4 - Math.floor(Math.log10(m.markPrice)))),
              book: m.book, markPrice: m.markPrice, oraclePrice: m.oraclePrice, volume24hUsd: m.quote.volume24h,
              fundingHourly: m.fundingRateHourly, fundingObservedAt: m.ts,
              makerFeeRate: m.makerFeeRate, takerFeeRate: m.takerFeeRate, outlooks });
            this.marketFailures.delete(asset.marketRef);
          } catch (error) {
            if (previous) markets.push(previous);
            const message = (error instanceof Error ? error.message : "unknown market-data error").replace(/[\r\n -]/g, " ").slice(0, 240);
            const failures = (this.marketFailures.get(asset.marketRef)?.failures ?? 0) + 1;
            const deferred = message.startsWith("Hyperliquid info deferred: rate-budget");
            const retryAfter = error && typeof error === "object" && "retryAfterMs" in error ? error.retryAfterMs : undefined;
            const retryAfterMs = typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 0;
            const base = /429|rate.?limit|too many requests/i.test(message) ? 60_000 : 15_000;
            const retryAt = this.now() + Math.min(15 * 60_000, Math.max(retryAfterMs, base * 2 ** (deferred ? 0 : Math.min(6, failures - 1))));
            this.marketFailures.set(asset.marketRef, { error: message, failures, retryAt, ...(deferred ? { deferred: true as const } : {}) });
          }
        }
      }));
      if (!this.stopped) {
        this.markets = markets;
        const failures = [...this.marketFailures].sort(([a], [b]) => a.localeCompare(b));
        const summary = JSON.stringify(failures.map(([marketRef, failure]) => [marketRef, failure.error]));
        if (failures.length && (summary !== this.lastMarketFailureSummary || this.now() - this.lastMarketFailureLogAt >= 5 * 60_000)) {
          const unavailable = failures.filter(([, failure]) => !failure.deferred);
          const deferred = failures.length - unavailable.length;
          if (unavailable.length) this.d.log.warn(`swing market refresh: ${unavailable.length} unavailable; ${unavailable.slice(0, 3).map(([marketRef, failure]) => `${marketRef}: ${failure.error}`).join("; ")}`);
          if (deferred) this.d.log.info(`swing market refresh: ${deferred} deferred by request budget`);
          this.lastMarketFailureLogAt = this.now();
        }
        this.lastMarketFailureSummary = summary;
      }
    })().finally(() => { this.marketPromise = undefined; });
    return this.marketPromise;
  }

  private async snapshot(account?: PerpAccountSnapshot, execution?: PerpExecutionState): Promise<SwingSnapshot> {
    const now = this.now();
    if (!account || !Number.isFinite(account.equity) || account.equity < 0 ||
      !Number.isFinite(account.availableCollateral) || account.availableCollateral < 0 || !Number.isFinite(account.ts)) {
      throw new Error("quotient-swing requires an authoritative live account NAV and collateral snapshot");
    }
    // Executor-owned targets are reduce-only limits; the ledger identifies them so the reducer never treats one as a stale exit.
    const cycles = (execution?.cycles ?? []).filter(c => c.status !== "closed") as Array<{ targetOrderId?: string; targetClientId?: string }>;
    const targetOrderIds = new Set(cycles.flatMap(c => c.targetOrderId ? [c.targetOrderId] : []));
    const targetClientIds = new Set(cycles.flatMap(c => { const id = c.targetClientId ? cloid(c.targetClientId) : undefined; return id ? [id] : []; }));
    const snapshot: SwingSnapshot = { now, nav: account.equity,
      netCashFlow: 0, availableMarginUsd: account.availableCollateral,
      coveredAssetKeys: this.data.cached()?.assets.map(a => a.assetKey) ?? [], markets: this.markets,
      positions: account.positions.filter(p => p.side === "LONG" || p.side === "SHORT").map(p => ({ ...p, side: p.side as "LONG" | "SHORT", isolatedMarginUsd: p.marginUsed })),
      openOrders: account.openOrders.map(o => ({ id: o.id, marketRef: o.marketRef, clientId: o.clientId,
        purpose: o.isTrigger && o.reduceOnly ? "stop"
          : o.reduceOnly && (targetOrderIds.has(o.id) || (o.clientId !== undefined && targetClientIds.has(o.clientId.toLowerCase()))) ? "target"
          : o.reduceOnly ? "exit" : "entry",
        size: o.size, filledSize: o.filledSize, price: o.price, createdAt: o.createdAt ?? 0 })),
      accountObservedAt: account.ts, accountReconciled: Boolean(execution?.cashFlowsComplete && execution.lastReconciledAt && now - execution.lastReconciledAt < 60_000) };
    return snapshot;
  }
  private eligibleOutlooks(q: SwingQuotientSnapshot | null): number {
    const now = this.now();
    return q?.outlooks.filter(o => !forecastProblem(o, now, this.config) && !entryProblem(o, this.config)).length ?? 0;
  }
  async supervise(): Promise<void> {
    await this.engine.supervisePerps(); this.execution = await this.engine.perpStatus();
    this.reportExecutionHalt();
  }
  /** One line when entries stop or wait, repeated at most every five minutes, and one when they flow again. */
  private reportExecutionHalt(): void {
    const halted = this.execution?.halted ? (this.execution.haltReason ?? "execution_halted") : undefined;
    const reason = halted ?? this.execution?.entriesPaused;
    if (reason) {
      if (reason !== this.lastExecutionHaltReason || this.now() - this.lastExecutionHaltLogAt >= 5 * 60_000) {
        this.d.log.warn(halted ? `swing entries halted: ${reason}` : `swing entries wait: ${reason}`);
        this.lastExecutionHaltLogAt = this.now();
      }
      this.lastExecutionHaltReason = reason;
    } else if (this.execution && this.lastExecutionHaltReason !== undefined) {
      this.d.log.info("swing entries resumed");
      this.lastExecutionHaltReason = undefined;
    }
  }
  async tick(tickId?: number): Promise<TickResult> {
    if (this.stopped) return { seq: tickId ?? this.now(), skipped: true, actions: 0, ordersPlaced: 0, errors: 0 };
    const result = await this.engine.tick(tickId === undefined ? {} : { tickId });
    this.execution = await this.engine.perpStatus();
    this.reportExecutionHalt();
    const raw = await this.d.state.get(`strategy:${SWING_REPORT_KEY}`);
    this.lastReport = raw ? JSON.parse(raw) as SwingReduction : undefined;
    const ctx = await this.engine.strategyContext();
    const snapshot = await this.snapshot(ctx.perpAccount, ctx.perpExecution);
    this.record(snapshot);
    return result;
  }
  private record(snapshot: SwingSnapshot): void {
    const usable = snapshot.coveredAssetKeys.length > 0 && snapshot.markets.length === snapshot.coveredAssetKeys.length && snapshot.markets.every(m =>
      snapshot.now - m.book.ts <= this.config.maxBookAgeSec * 1000 &&
      m.outlooks.some(o => !forecastProblem(o, snapshot.now, this.config)));
    this.recordings.record(snapshot, "live", this.configHash, usable);
  }
  async dryRun(): Promise<SwingReduction> {
    await this.refreshResearch();
    return this.strategy.preview(await this.engine.strategyContext());
  }
  async status() {
    this.execution = await this.engine.perpStatus();
    const q = this.data.cached();
    const rejectionCounts: Record<string, number> = {};
    for (const rejection of this.lastReport?.rejected ?? []) rejectionCounts[rejection.reason] = (rejectionCounts[rejection.reason] ?? 0) + 1;
    return { strategy: "quotient-swing", mode: this.config.mode, configHash: this.configHash,
      halted: this.execution?.halted ?? true, execution: this.execution, entriesPaused: this.execution?.entriesPaused,
      research: { lastAt: this.lastResearchAt, error: this.lastResearchError, assets: q?.assets.length ?? 0, markets: this.markets.length,
        outlooks: q?.outlooks.length ?? 0, eligibleOutlooks: this.eligibleOutlooks(q), rejectionCounts,
        excludedOutlooks: q?.excluded.length ?? 0, excludedExamples: q?.excluded.slice(0, 10) ?? [],
        marketFailures: [...this.marketFailures].sort(([a], [b]) => a.localeCompare(b)).map(([marketRef, failure]) => ({ marketRef, ...failure })) },
      lastReport: this.lastReport };
  }
  async halt(): Promise<void> {
    await this.engine.haltPerps(); this.execution = await this.engine.perpStatus();
  }
  async resume(acknowledgeLossReset = false): Promise<void> {
    await this.engine.resumePerps(acknowledgeLossReset); this.execution = await this.engine.perpStatus();
  }
  replay(options: { from?: number; until?: number; costMultiplier?: number; fillModel?: "cross" | "touch" } = {}) {
    return replaySwing(this.recordings.read(this.configHash, "live", options.from, options.until), this.config,
      { fillModel: options.fillModel ?? "cross", costMultiplier: options.costMultiplier ?? 1 });
  }
  async check() {
    // Input and account reads only: preflight neither starts nor resumes execution.
    const [q, account] = await Promise.all([
      this.researchInputs ?? this.refreshInputs(),
      this.d.adapter.perpAccountSnapshot!(this.d.account),
    ]);
    await this.snapshot(account);
    return { ok: true, assets: q.assets.length, count: q.outlooks.length, eligibleOutlooks: this.eligibleOutlooks(q), account };
  }
  async shutdown(cancelWorking: boolean): Promise<void> {
    if (cancelWorking) await this.prepareShutdown();
    this.stopped = true;
    if (this.researchTimer) clearInterval(this.researchTimer);
    if (this.marketTimer) clearInterval(this.marketTimer);
    // Each research write checks stopped; in-flight HTTP work cannot write after this close.
    this.recordings.close();
  }
  async prepareShutdown(): Promise<void> {
    await this.engine.cancelAllResting();
  }
}

// packages/runtime-node/src/service.ts
// The long-running trading service. One instance per bot. Owns the engine, the
// tick loop, the dead man's switch heartbeat, and the trigger check.

import { readFileSync } from "node:fs";
import {
  ConsoleAlerter,
  Engine,
  KalshiCommoditiesStrategy,
  CommodityConfigSchema,
  COMMODITY_REPORT_KEY,
  COMMODITY_LEDGER_KEY,
  FanoutAlerter,
  FixtureSignalSource,
  LiveSignalSource,
  MarketMakeQuotientClient,
  PolymarketCatalogClient,
  SafeAlerter,
  TelegramAlerter,
  checkLiveSignalAccess,
  computePortfolio,
  consoleLogger,
  createAdapter,
  defaultMetricsRegistry,
  hyperliquidInfoSchedulerStatsForScope,
  instrumentVenueAdapter,
  type Alerter,
  type HyperliquidInfoSchedulerStats,
  type MetricsRegistry,
  type BotConfig,
  type LogLevel,
  type Logger,
  type ManualOrderParams,
  type RuntimeCreds,
  type PolymarketGaslessAuth,
  type SignalSource,
  type Strategy,
  type CommodityReport,
  type VenueAccount,
  type VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import {
  QuotientResearchClient,
  SurplusClient,
  createMarketLister,
  isTransientVenueError,
} from "@quotient-forecasting/cassie-core";
import { FlipFlatStrategy } from "@quotient-forecasting/strategy-flip-flat";
import {
  AgentConfigSchema,
  AgentStrategy,
  AGENT_MEMORY_KEYS,
  type AgentRunReport,
  type PreviewableStrategy,
} from "@quotient-forecasting/strategy-agent";
import { SqliteStateStore } from "./state.js";
import { CountingAlerter, EngineCounters } from "./dashboard/counters.js";
import { DashboardSampler, type DashboardSamplerStatus } from "./dashboard/sampler.js";
import { DashboardSnapshotCache, buildDashboardSnapshot } from "./dashboard/snapshot.js";
import type { DashboardRange, DashboardSnapshot } from "./dashboard/types.js";
import { SwingController } from "./swing-controller.js";
import { CommodityDataSource } from "./commodity-data.js";
import { CommodityRecordingStore } from "./commodity-recordings.js";
import { MarketMakeStateStore } from "./market-make-state.js";
import {
  MarketMakeController,
} from "./market-make-controller.js";
import { TwoSidedMarketMakeController } from "./two-sided-market-make-controller.js";
import { MarketMakeConfigSchema } from "@quotient-forecasting/strategy-market-make";
import { nextTickAtMs, tickIdAt } from "./tick-schedule.js";
import {
  DEFAULT_SIGNAL_POLL_INTERVAL_MIN,
  PollingSignalSource,
} from "./polling-signal-source.js";

const HEARTBEAT_MS = 5_000;
const PERP_SUPERVISION_MS = 15_000;
const TRIGGER_CHECK_MS = 60_000;

type MarketMaker = MarketMakeController | TwoSidedMarketMakeController;
type MarketMakeControllerStatus = ReturnType<MarketMaker["status"]>;
type MarketMakeDryRunResult = Awaited<ReturnType<MarketMaker["dryRun"]>>;
type MarketMakeReconcileResult = Awaited<ReturnType<MarketMaker["reconcile"]>>;
type MarketMakeTickResult = Awaited<ReturnType<MarketMaker["tick"]>>;

export interface RuntimeIdentity {
  runtime: "droplet" | "local";
  protocol: 2;
  botId: string;
  version: string;
  /** Content identity read from the installed workspace artifact, when present. */
  buildId?: string;
  /** Region the deploy pinned this bot to. Absent when running locally. */
  requiredRegion?: string;
  /** Region the host reports for itself. Must equal requiredRegion to trade. */
  region?: string;
  /** Non-secret identity of the exact deployment/config activation boundary. */
  deploymentId?: string;
}

export interface BotRuntimeOptions {
  config: BotConfig;
  account: VenueAccount;
  creds?: RuntimeCreds;
  polymarketGaslessAuth?: PolymarketGaslessAuth;
  /** SQLite path. One file per bot. */
  statePath: string;
  runtime: RuntimeIdentity["runtime"];
  requiredRegion?: string;
  region?: string;
  deploymentId?: string;
  version?: string;
  buildId?: string;
  quotientToken?: string;
  telegramToken?: string;
  /** Overrides the saved chat id; deploy forwards TELEGRAM_CHAT_ID from the operator's .local.env. */
  telegramChatId?: string;
  /** Surplus Intelligence key (inf_…). Required by the agent strategy only. */
  surplusApiKey?: string;
  /** Shared call counters; defaults to the process-wide registry. */
  metrics?: MetricsRegistry;
  /** Equity/metrics sampling for the dashboard. */
  dashboard?: { sampleMinutes?: number; enabled?: boolean };
  log?: Logger;
  /** Contributor-test hook for a deterministic signal file. */
  signalsFixturePath?: string;
  fixtureBooksPath?: string;
}

export interface ShutdownCancellationResult {
  method: "none" | "engine" | "market-make-venue";
  requested: boolean;
  completed: boolean;
  /** True only after an authoritative venue open-orders read returned empty. */
  verifiedOpenOrders: boolean;
  remainingOpenOrders: number | null;
  /** Swing shutdown deliberately retains verified reduce-only native protection. */
  protectiveOrdersRetained?: boolean;
}

export interface ShutdownResult {
  stopped: true;
  /** Never inferred: true means the selected cancellation path completed. */
  restingOrdersCanceled: boolean;
  cancellation: ShutdownCancellationResult;
}

/**
 * Market making gets a second, controller-independent venue cancellation at
 * process shutdown. A cancel acknowledgement alone is not enough: the venue's
 * authoritative open-orders read must also be empty.
 */
export async function cancelAndVerifyMarketMakeOrders(
  adapter: Pick<VenueAdapter, "cancelAll" | "openOrders">,
  account: VenueAccount,
): Promise<ShutdownCancellationResult> {
  const failures: string[] = [];
  try {
    await adapter.cancelAll(account);
  } catch (error) {
    failures.push(`cancelAll failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let remainingOpenOrders: number | null = null;
  try {
    remainingOpenOrders = (await adapter.openOrders(account)).length;
    if (remainingOpenOrders > 0) {
      failures.push(`authoritative open-orders check found ${remainingOpenOrders} resting order(s)`);
    }
  } catch (error) {
    failures.push(`authoritative open-orders check failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (failures.length > 0) {
    throw new Error(`market-make shutdown cancellation failed: ${failures.join("; ")}`);
  }
  return {
    method: "market-make-venue",
    requested: true,
    completed: true,
    verifiedOpenOrders: true,
    remainingOpenOrders: 0,
  };
}

export function buildStrategy(opts: BotRuntimeOptions): Strategy {
  const id = opts.config.strategy.id;
  // "signals" is the user-facing name; "flip-flat" is the original id.
  if (id === "signals" || id === "flip-flat") return new FlipFlatStrategy();
  if (id === "kalshi-commodities") return new KalshiCommoditiesStrategy();
  if (id === "agent") {
    if (!opts.surplusApiKey) {
      throw new Error("the agent strategy needs SURPLUS_API_KEY (environment, .local.env, or bot keystore)");
    }
    if (!opts.quotientToken) {
      throw new Error("the agent strategy needs a Quotient API key for market research");
    }
    const cfg = AgentConfigSchema.parse(opts.config.strategy.config);
    return new AgentStrategy({
      surplus: new SurplusClient({
        apiKey: opts.surplusApiKey,
        baseUrl: cfg.llm.baseUrl,
        fallbackBaseUrl: cfg.llm.fallbackBaseUrl,
        modelPool: cfg.llm.modelPool,
      }),
      research: new QuotientResearchClient({ baseUrl: opts.config.signals.baseUrl, token: opts.quotientToken }),
      lister: createMarketLister(opts.config.venue, opts.config.venueUrls),
    });
  }
  if (id === "market-make") {
    throw new Error("market-make is event-driven and must be built through BotService's dedicated controller");
  }
  if (id === "quotient-swing") throw new Error("quotient-swing uses BotService's protected swing controller");
  throw new Error(`unknown strategy "${id}" — supported strategies are "signals", "agent", and "market-make"`);
}

export function configuredSignalPollIntervalMin(config: BotConfig): number {
  const raw = (config.strategy.config as Record<string, unknown>).signalPollIntervalMin;
  if (raw === undefined) return DEFAULT_SIGNAL_POLL_INTERVAL_MIN;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error("strategy.config.signalPollIntervalMin must be greater than zero");
  }
  return raw;
}

export function buildSignalSource(opts: BotRuntimeOptions, log: Logger = opts.log ?? consoleLogger(opts.config.id)): SignalSource {
  if (opts.config.strategy.id === "kalshi-commodities") {
    if (!opts.quotientToken) throw new Error("kalshi-commodities requires a Quotient API key");
    const urls = opts.config.venueUrls.kalshi;
    return new CommodityDataSource({ config: CommodityConfigSchema.parse(opts.config.strategy.config),
      apiBase: urls.demo ? urls.demoApi : urls.api, baseUrl: opts.config.signals.baseUrl, token: opts.quotientToken });
  }
  if (opts.signalsFixturePath) {
    return new FixtureSignalSource(readFileSync(opts.signalsFixturePath, "utf8"));
  }
  if (!opts.quotientToken) {
    throw new Error("live signals need a Quotient API key (environment, .local.env, Quotient CLI, or bot keystore)");
  }
  const pollIntervalMin = configuredSignalPollIntervalMin(opts.config);
  return new PollingSignalSource(
    new LiveSignalSource(opts.config.signals, opts.quotientToken),
    Math.max(1_000, Math.round(pollIntervalMin * 60_000)),
    {
      onRefresh: (count) =>
        log.info(`signals refreshed (${count}); next refresh in ${compactNumber(pollIntervalMin)}m`),
      onForecastRefresh: (count) =>
        log.info(`held forecasts refreshed (${count}); next refresh in ${compactNumber(pollIntervalMin)}m`),
      onRefreshFailure: (error, servedFromCache) =>
        log.warn(
          `quotient refresh failed after retries; ${servedFromCache ? "serving the last snapshot" : "no snapshot to serve"}: ` +
            (error instanceof Error ? error.message : String(error)),
        ),
    },
  );
}

function compactNumber(value: number): string {
  return String(Number(value.toFixed(4)));
}

export function buildAlerter(opts: BotRuntimeOptions, log: Logger, counters?: EngineCounters): Alerter {
  // Counting sits inside SafeAlerter so a swallowed delivery failure is still counted.
  const count = (sink: Alerter): Alerter => (counters ? new CountingAlerter(sink, counters) : sink);
  const sinks: Alerter[] = [];
  const chatId = opts.telegramChatId ?? opts.config.alerts.telegram?.chatId;
  if (opts.telegramToken && chatId) {
    sinks.push(new SafeAlerter(count(new TelegramAlerter(opts.telegramToken, chatId)), log));
  }
  if (sinks.length === 0) return count(new ConsoleAlerter(log));
  return sinks.length === 1 ? sinks[0]! : new FanoutAlerter(sinks);
}

export class BotService {
  readonly config: BotConfig;
  readonly account: VenueAccount;
  readonly identity: RuntimeIdentity;
  readonly log: Logger;

  private readonly adapter: VenueAdapter;
  private readonly strategy?: Strategy;
  private readonly engine?: Engine;
  private readonly marketMaker?: MarketMaker;
  private readonly marketMakeState?: MarketMakeStateStore;
  private readonly swing?: SwingController;
  private readonly commodityRecordings?: CommodityRecordingStore;
  private readonly state: SqliteStateStore;
  private readonly opts: BotRuntimeOptions;
  private readonly intervalSeconds: number;
  private operation: Promise<void> = Promise.resolve();
  private heartbeatTimer?: NodeJS.Timeout;
  private triggerTimer?: NodeJS.Timeout;
  private perpSupervisionPending = false;
  private perpSupervisionError?: { message: string; at: number };
  private predictionSupervisionError?: { message: string; at: number };
  private predictionTimer?: NodeJS.Timeout;
  private predictionSupervision?: Promise<void>;
  private predictionHeartbeat?: Promise<void>;
  private predictionExecution?: Awaited<ReturnType<Engine["predictionStatus"]>>;
  private tickTimer?: NodeJS.Timeout;
  private active = false;
  private terminating = false;
  private shutdownPromise?: Promise<ShutdownResult>;
  private lastTickAt?: number;
  readonly startedAt = Date.now();
  readonly metrics: MetricsRegistry;
  readonly counters = new EngineCounters();
  private readonly sampler?: DashboardSampler;
  private snapshotCache?: DashboardSnapshotCache;

  constructor(opts: BotRuntimeOptions) {
    this.opts = opts;
    this.config = opts.config;
    this.account = opts.account;
    this.log = opts.log ?? consoleLogger(opts.config.id);
    this.state = new SqliteStateStore(opts.statePath);
    this.metrics = opts.metrics ?? defaultMetricsRegistry();
    this.intervalSeconds = Math.max(1, Math.round(opts.config.tickIntervalMin * 60));
    this.adapter = instrumentVenueAdapter(createAdapter(opts.config.venue, {
      urls: opts.config.venueUrls,
      creds: opts.creds,
      polymarketGaslessAuth: opts.polymarketGaslessAuth,
      fixtureBooks: opts.fixtureBooksPath ? readFileSync(opts.fixtureBooksPath, "utf8") : undefined,
      perpDex: opts.config.strategy.id === "quotient-swing" ? "xyz" : undefined,
    }), this.metrics);
    const alerter = buildAlerter(opts, this.log, this.counters);
    if (opts.config.strategy.id === "kalshi-commodities") this.commodityRecordings = new CommodityRecordingStore(`${opts.statePath}.commodities.sqlite`);
    if (opts.config.strategy.id === "quotient-swing") {
      if (!opts.quotientToken) throw new Error("quotient-swing needs a Quotient API key");
      this.swing = new SwingController({ config: opts.config, adapter: this.adapter, account: opts.account,
        state: this.state, statePath: opts.statePath, alerter, log: this.log,
        quotientToken: opts.quotientToken });
    } else if (opts.config.strategy.id === "market-make") {
      if (opts.config.venue !== "polymarket" || opts.account.venue !== "polymarket") {
        throw new Error("the market-make controller requires a Polymarket bot and account");
      }
      const config = MarketMakeConfigSchema.parse(opts.config.strategy.config);
      if ((!config.two_sided || config.two_sided.adaptive) && !opts.quotientToken) {
        throw new Error("the market-make strategy needs a Quotient API key");
      }
      const shared = {
        config,
        venue: this.adapter,
        account: opts.account,
        catalog: new PolymarketCatalogClient({ gammaBaseUrl: opts.config.venueUrls.polymarket.gamma }),
        botId: opts.config.id,
        alerter,
        log: this.log,
      };
      const controllerOptions = {
        deploymentId: opts.deploymentId ?? `${opts.runtime}:${opts.config.id}`,
        autoSchedule: false,
        enableSubscriptions: true,
      };
      if (config.two_sided) {
        this.intervalSeconds = Math.max(60, Math.round(config.reconciliation.rest_reconcile_seconds));
        this.marketMaker = new TwoSidedMarketMakeController(
          { ...shared, stateStore: this.state, ...(config.two_sided.adaptive ? {
            quotient: new MarketMakeQuotientClient({ baseUrl: opts.config.signals.baseUrl, signalsPath: opts.config.signals.path, token: opts.quotientToken! }),
          } : {}) }, controllerOptions,
        );
      } else {
        this.marketMakeState = new MarketMakeStateStore(opts.statePath);
        this.marketMaker = new MarketMakeController(
        {
          ...shared,
          stateStore: this.marketMakeState,
          snapshotStore: this.state,
          quotient: new MarketMakeQuotientClient({
            baseUrl: opts.config.signals.baseUrl,
            signalsPath: opts.config.signals.path,
            token: opts.quotientToken!,
          }),
        },
        controllerOptions,
      );
      }
    } else {
      this.strategy = buildStrategy(opts);
      this.engine = new Engine({
        botId: opts.config.id,
        config: opts.config,
        adapter: this.adapter,
        account: opts.account,
        strategy: this.strategy,
        signals: buildSignalSource(opts, this.log),
        alerter,
        state: this.state,
        log: this.log,
      });
    }
    this.identity = {
      runtime: opts.runtime,
      protocol: 2,
      botId: opts.config.id,
      version: opts.version ?? "unknown",
      ...(opts.buildId ? { buildId: opts.buildId } : {}),
      requiredRegion: opts.requiredRegion,
      region: opts.region,
      deploymentId: opts.deploymentId,
    };
    if (opts.dashboard?.enabled !== false) {
      this.sampler = new DashboardSampler({
        store: this.state,
        metrics: this.metrics,
        portfolio: () => this.portfolio(),
        log: this.log,
        intervalMs: (opts.dashboard?.sampleMinutes ?? 5) * 60_000,
      });
    }
  }

  get running(): boolean {
    return this.active;
  }

  status(): RuntimeIdentity & {
    active: boolean;
    lastTickAt?: number;
    tickIntervalMin: number;
    marketMake?: MarketMakeControllerStatus;
    swing?: { mode: "live" };
    execution?: Awaited<ReturnType<Engine["predictionStatus"]>>;
  } {
    return {
      ...this.identity,
      active: this.active,
      lastTickAt: this.lastTickAt,
      tickIntervalMin: this.intervalSeconds / 60,
      ...(this.marketMaker ? { marketMake: this.marketMaker.status() } : {}),
      ...(this.swing ? { swing: { mode: this.swing.config.mode } } : {}),
      ...(this.predictionExecution ? { execution: this.predictionExecution } : {}),
    };
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.operation.then(fn, fn);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Start the tick loop and the auxiliary timers. Idempotent. */
  async start(): Promise<void> {
    if (this.active || this.terminating) return;
    try {
      await this.exclusive(async () => {
        if (this.config.strategy.id === "kalshi-commodities") await this.state.set("engine:paused", "true");
        if (this.marketMaker) await this.marketMaker.start();
        else {
          this.swing?.start();
          await this.engine?.recoverPredictions();
          await this.syncFastLoops();
        }
      });
      this.active = true;
      this.sampler?.start();
      // Tick the current slot right away rather than idling to the next
      // boundary. The slot-derived id makes that a no-op when a restart lands
      // inside a slot the engine already completed.
      this.scheduleTick(0);
      this.log.info(
        this.marketMaker
          ? `market-make loop started ${this.marketMaker.status().halted ? "halted" : "active"}; ` +
              `${this.config.strategy.config.two_sided ? "quote checks" : "reconciliation"} every ${compactNumber(this.intervalSeconds)}s`
          : `loop started; position checks every ${compactNumber(this.intervalSeconds)}s; ` +
              `signals every ${compactNumber(configuredSignalPollIntervalMin(this.config))}m`,
      );
    } catch (error) {
      this.stopTimers();
      throw error;
    }
  }

  private scheduleNextTick(): void {
    const now = Date.now();
    this.scheduleTick(Math.max(1, nextTickAtMs(now, this.intervalSeconds) - now));
  }

  private scheduleTick(delayMs: number): void {
    if (!this.active || this.terminating) return;
    this.tickTimer = setTimeout(() => {
      const id = tickIdAt(Date.now(), this.intervalSeconds);
      void this.tick(id)
        .catch((error) => this.log.error(`tick crashed: ${(error as Error).message}`))
        .finally(() => this.scheduleNextTick());
    }, delayMs);
  }

  private stopTimers(): void {
    this.sampler?.stop();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.triggerTimer) clearInterval(this.triggerTimer);
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.predictionTimer) clearInterval(this.predictionTimer);
    this.heartbeatTimer = undefined;
    this.triggerTimer = undefined;
    this.tickTimer = undefined;
    this.predictionTimer = undefined;
  }

  private async syncFastLoops(): Promise<void> {
    if (this.terminating) return;
    if (this.swing) {
      if (!this.triggerTimer) {
        // Research and market data are refreshed by the controller outside this lane.
        this.triggerTimer = setInterval(() => {
          if (this.terminating || this.perpSupervisionPending) return;
          this.perpSupervisionPending = true;
          void this.exclusive(() => this.swing!.supervise())
            .then(() => { this.perpSupervisionError = undefined; })
            .catch(error => {
              const message = (error as Error).message;
              if (this.perpSupervisionError?.message !== message || Date.now() - this.perpSupervisionError.at >= 300_000) {
                this.log.error(`perp protection reconcile failed: ${message}`);
                this.perpSupervisionError = { message, at: Date.now() };
              }
            })
            .finally(() => { this.perpSupervisionPending = false; });
        }, PERP_SUPERVISION_MS);
      }
      return;
    }
    if (!this.engine) return;
    const engine = this.engine;
    if (engine.adaptivePredictionExecution) {
      this.predictionExecution = await engine.predictionStatus();
      if (this.terminating) return;
      // Neither lane waits for strategy research or the control API's queue.
      // The executor serializes its own state changes; heartbeat remains independent.
      if (!this.predictionTimer) {
        this.predictionTimer = setInterval(() => {
          if (this.terminating || this.predictionSupervision) return;
          this.predictionSupervision = engine.supervisePredictions()
            .then(() => engine.checkTriggers())
            .then(async () => { this.predictionExecution = await engine.predictionStatus(); this.predictionSupervisionError = undefined; })
            .catch(error => {
              // A throttled or slow venue defers supervision; the executor keeps its orders and retries.
              // Log that once a minute per message rather than every five seconds.
              const message = (error as Error).message;
              if (!isTransientVenueError(error)) { this.log.error(`prediction execution failed: ${message}`); return; }
              if (this.predictionSupervisionError?.message !== message || Date.now() - this.predictionSupervisionError.at >= 60_000) {
                this.log.warn(`prediction supervision deferred; retrying: ${message}`);
                this.predictionSupervisionError = { message, at: Date.now() };
              }
            })
            .finally(() => { this.predictionSupervision = undefined; });
        }, HEARTBEAT_MS);
      }
      if (!this.heartbeatTimer) {
        this.heartbeatTimer = setInterval(() => {
          if (this.terminating || this.predictionHeartbeat) return;
          this.predictionHeartbeat = engine.heartbeatIfResting()
            .then(() => undefined)
            .catch(error => this.log.error(`prediction heartbeat failed: ${(error as Error).message}`))
            .finally(() => { this.predictionHeartbeat = undefined; });
        }, HEARTBEAT_MS);
      }
      return;
    }
    const resting = await engine.heartbeatIfResting().catch((error) => {
      this.log.warn(`heartbeat probe failed: ${(error as Error).message}`);
      return false;
    });
    if (this.terminating) return;
    if (resting && !this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        void this.exclusive(async () => {
          const stillResting = await engine.heartbeatIfResting();
          if (!stillResting && this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
          }
        }).catch((error) => this.log.warn(`heartbeat failed: ${(error as Error).message}`));
      }, HEARTBEAT_MS);
    } else if (!resting && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    const armed = await engine.hasArmedTriggers().catch((error) => {
      this.log.warn(`trigger probe failed: ${(error as Error).message}`);
      return false;
    });
    if (armed && !this.triggerTimer) {
      this.triggerTimer = setInterval(() => {
        void this.exclusive(async () => {
          await engine.checkTriggers();
          if (!(await engine.hasArmedTriggers()) && this.triggerTimer) {
            clearInterval(this.triggerTimer);
            this.triggerTimer = undefined;
          }
        }).catch((error) => this.log.warn(`trigger check failed: ${(error as Error).message}`));
      }, TRIGGER_CHECK_MS);
    } else if (!armed && this.triggerTimer) {
      clearInterval(this.triggerTimer);
      this.triggerTimer = undefined;
    }
  }

  shutdown(cancelResting = true): Promise<ShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.swing && (cancelResting || this.active)) {
      // Prove cancellation/protection before stopping the loop. An unknown acknowledgement
      // leaves the bot running with additions halted so late fills can still acquire stops.
      const shutdown = this.exclusive(async (): Promise<ShutdownResult> => {
        await this.swing!.prepareShutdown();
        this.terminating = true; this.active = false; this.stopTimers();
        await this.swing!.shutdown(false);
        this.state.close();
        return { stopped: true, restingOrdersCanceled: true, cancellation: { method: "engine", requested: true,
          completed: true, verifiedOpenOrders: false, remainingOpenOrders: null, protectiveOrdersRetained: true } };
      });
      this.shutdownPromise = shutdown;
      void shutdown.catch(() => { this.shutdownPromise = undefined; });
      return shutdown;
    }
    // Latch the executor before a delayed strategy/signing call can resume.
    const predictionShutdown = this.engine?.beginPredictionShutdown();
    this.terminating = true;
    this.active = false;
    this.stopTimers();

    const shutdown = (async (): Promise<ShutdownResult> => {
      let primaryFailure: unknown;
      try {
        await predictionShutdown;
        await Promise.all([this.predictionSupervision, this.predictionHeartbeat]);
        return await this.exclusive(async () => {
          if (this.swing) {
            await this.swing.shutdown(cancelResting);
            return { stopped: true, restingOrdersCanceled: cancelResting,
              cancellation: { method: cancelResting ? "engine" : "none", requested: cancelResting,
                completed: true, verifiedOpenOrders: false, remainingOpenOrders: null } };
          }
          if (this.marketMaker) {
            let controllerFailure: unknown;
            try {
              await this.marketMaker.shutdown();
            } catch (error) {
              controllerFailure = error;
            }

            let cancellation: ShutdownCancellationResult = {
              method: "none",
              requested: false,
              completed: true,
              verifiedOpenOrders: false,
              remainingOpenOrders: null,
            };
            let cancellationFailure: unknown;
            if (cancelResting) {
              this.log.info("shutdown: independently canceling and verifying market-make venue orders");
              try {
                cancellation = await cancelAndVerifyMarketMakeOrders(this.adapter, this.account);
              } catch (error) {
                cancellationFailure = error;
              }
            }

            const failures = [controllerFailure, cancellationFailure].filter(
              (failure): failure is NonNullable<typeof failure> => failure !== undefined,
            );
            if (failures.length > 0) {
              throw new AggregateError(
                failures,
                failures.map((failure) => failure instanceof Error ? failure.message : String(failure)).join("; "),
              );
            }
            return {
              stopped: true,
              restingOrdersCanceled: cancelResting && cancellation.completed && cancellation.verifiedOpenOrders,
              cancellation,
            };
          }

          if (cancelResting) {
            this.log.info("shutdown: canceling resting orders");
            await this.engine!.cancelAllResting();
          }
          return {
            stopped: true,
            restingOrdersCanceled: cancelResting,
            cancellation: {
              method: cancelResting ? "engine" : "none",
              requested: cancelResting,
              completed: true,
              verifiedOpenOrders: false,
              remainingOpenOrders: null,
            },
          };
        });
      } catch (error) {
        primaryFailure = error;
        throw error;
      } finally {
        const closeStores = () => {
        const closeFailures: unknown[] = [];
        try {
          this.marketMakeState?.close();
        } catch (error) {
          closeFailures.push(error);
        }
        try {
          this.state.close();
          this.commodityRecordings?.close();
        } catch (error) {
          closeFailures.push(error);
        }
        if (closeFailures.length > 0) {
          const message = closeFailures
            .map((error) => error instanceof Error ? error.message : String(error))
            .join("; ");
          if (primaryFailure !== undefined) {
            this.log.error(`shutdown state close also failed: ${message}`);
          } else {
            throw new AggregateError(closeFailures, `shutdown state close failed: ${message}`);
          }
        }
        };
        // A relayer may still be confirming a submitted redemption after the
        // trading tick ends. Preserve SQLite until its receipt/error callbacks
        // finish; bounded shutdown does not close the store underneath them.
        const closing = (this.engine?.drainRedemptions?.() ?? Promise.resolve()).then(closeStores);
        void closing.catch(error => this.log.error(`deferred shutdown state close failed: ${(error as Error).message}`));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([closing, new Promise<void>(resolve => {
            timer = setTimeout(() => {
              this.log.info("redemption confirmation pending; state stays open until receipt writes finish");
              resolve();
            }, 5000);
          })]);
        } finally { if (timer) clearTimeout(timer); }
      }
    })();
    // Keep the exact promise, including rejection, so a concurrent or later
    // retry cannot report success after the stores have already been closed.
    this.shutdownPromise = shutdown;
    return shutdown;
  }

  tick(tickId?: number): Promise<MarketMakeTickResult | import("@quotient-forecasting/cassie-core").TickResult> {
    return this.exclusive(async () => {
      try {
      const result = this.marketMaker
        ? this.marketMaker instanceof TwoSidedMarketMakeController
          ? await this.marketMaker.tick({ scheduled: true })
          : await this.marketMaker.tick()
        : this.swing ? await this.swing.tick(tickId) : await this.engine!.tick(tickId === undefined ? {} : { tickId });
      this.lastTickAt = Date.now();
      if (this.commodityRecordings && !("skipped" in result && result.skipped)) {
        const raw = await this.state.get(`strategy:${COMMODITY_REPORT_KEY}`);
        if (raw) this.commodityRecordings.record(JSON.parse(raw) as CommodityReport, CommodityConfigSchema.parse(this.config.strategy.config));
      }
      if (!this.marketMaker) await this.syncFastLoops();
      return result;
      } catch (error) {
        this.counters.tickErrors += 1;
        throw error;
      } finally {
        this.counters.ticks += 1;
      }
    });
  }

  portfolio() {
    return this.exclusive(() => computePortfolio(this.config.id, this.adapter, this.account));
  }

  orders() {
    return this.exclusive(() => this.adapter.openOrders(this.account));
  }

  async executionStatus() {
    return await this.engine?.predictionStatus() ?? { enabled: false };
  }

  cancelOrder(id: string): Promise<void> {
    if (this.swing) return Promise.reject(new Error("use swing halt; generic cancellation could remove native protection"));
    if (this.marketMaker) {
      return Promise.reject(new Error(
        "generic order cancellation is disabled for market-make bots; use market-make halt and hash-bound reconciliation",
      ));
    }
    return this.exclusive(async () => {
      if (await this.engine?.cancelPredictionOrder(id)) return;
      await this.adapter.cancelOrder(this.account, id);
    });
  }

  cancelAll(): Promise<void> {
    if (this.swing) return Promise.reject(new Error("use swing halt; native protective stops must remain in place"));
    if (this.marketMaker) {
      return Promise.reject(new Error(
        "generic cancel-all is disabled for market-make bots; use market-make halt and hash-bound reconciliation",
      ));
    }
    return this.exclusive(async () => {
      if (this.engine) await this.engine.cancelAllResting();
      else await this.adapter.cancelAll(this.account);
      await this.syncFastLoops();
    });
  }

  manualOrder(params: ManualOrderParams) {
    return this.exclusive(async () => {
      if (this.swing) throw new Error("manual orders are disabled for a swing bot; they bypass its durable exposure ledger");
      if (!this.engine) {
        throw new Error(
          "manual orders are disabled for a market-make bot because they bypass durable inventory reservations",
        );
      }
      const result = await this.engine.manualOrder(params);
      await this.syncFastLoops();
      return result;
    });
  }

  async pause(): Promise<void> {
    if (this.swing) { await this.exclusive(() => this.swing!.halt()); return; }
    if (this.marketMaker) {
      await this.exclusive(async () => this.marketMaker!.halt());
      return;
    }
    await this.state.set("engine:paused", "true");
    await this.engine?.supervisePredictions();
  }

  async resume(): Promise<void> {
    if (this.config.strategy.id === "kalshi-commodities") throw new Error("use commodities resume after reviewing the current dry run");
    if (this.swing) throw new Error("use swing resume to recover an operator or execution halt");
    if (this.marketMaker) {
      throw new Error("use /market-make/resume after reviewing reconciliation and activation state");
    }
    await this.engine?.resumePredictions();
    this.predictionExecution = await this.engine?.predictionStatus();
    await this.state.delete("engine:paused");
  }

  async paused(): Promise<boolean> {
    if (this.swing) return (await this.swing.status()).halted;
    if (this.marketMaker) return this.marketMaker.status().halted;
    return (await this.state.get("engine:paused")) === "true";
  }

  async commodityStatus(): Promise<unknown> {
    if (this.config.strategy.id !== "kalshi-commodities") throw new Error("this bot does not run kalshi-commodities");
    const report = await this.state.get(`strategy:${COMMODITY_REPORT_KEY}`);
    return { paused: await this.paused(), config: this.config.strategy.config, report: report ? JSON.parse(report) as unknown : null,
      execution: await this.engine?.predictionStatus() };
  }

  commodityHistory(options: { from?: number; until?: number; limit?: number } = {}): unknown {
    if (!this.commodityRecordings) throw new Error("this bot does not run kalshi-commodities");
    return this.commodityRecordings.read(options);
  }

  commodityDryRun(): Promise<unknown> {
    return this.exclusive(async () => {
      if (this.config.strategy.id !== "kalshi-commodities" || !this.engine || !this.strategy) throw new Error("this bot does not run kalshi-commodities");
      const ctx = await this.engine.strategyContext(), scratch = new Map<string, unknown>();
      const original = ctx.memory;
      ctx.memory = { get: async <T>(key: string): Promise<T | undefined> => structuredClone((scratch.has(key) ? scratch.get(key) : await original.get<T>(key)) as T | undefined),
        set: async <T>(key: string, value: T): Promise<void> => { scratch.set(key, structuredClone(value)); } };
      await this.strategy.tick(ctx);
      return scratch.get(COMMODITY_REPORT_KEY) ?? { actions: [], reason: "no funded equity" };
    });
  }

  commodityResume(reset: boolean): Promise<unknown> {
    return this.exclusive(async () => {
      if (this.config.strategy.id !== "kalshi-commodities" || !this.engine) throw new Error("this bot does not run kalshi-commodities");
      const key = `strategy:${COMMODITY_LEDGER_KEY}`, raw = await this.state.get(key);
      const ledger = raw ? JSON.parse(raw) as { halted?: boolean } : undefined;
      if (ledger?.halted && !reset) throw new Error("commodity drawdown stop is latched; review losses and explicitly acknowledge reset");
      if (reset) {
        const ctx = await this.engine.strategyContext();
        if (ctx.positions.length || ctx.openOrders.length) throw new Error("drawdown reset requires a flat account with no working orders");
      }
      await this.engine.resumePredictions();
      if (reset) await this.state.delete(key);
      await this.state.delete("engine:paused");
      return this.commodityStatus();
    });
  }

  logs(level?: LogLevel, tail?: number) {
    return this.state.readErrors({ level, tail });
  }

  // --- dashboard reads -------------------------------------------------------

  signalCheckMinutes(): number | undefined {
    return this.engine ? configuredSignalPollIntervalMin(this.config) : undefined;
  }

  samplerStatus(): DashboardSamplerStatus {
    return this.sampler?.status() ?? { errors: 0, intervalMinutes: 0 };
  }

  equitySamples(q: { since?: number } = {}) {
    return this.state.readEquitySamples(q);
  }

  metricTotals(since: number) {
    return this.state.readMetricTotals(since);
  }

  metricHourly(since: number) {
    return this.state.readMetricHourly(since);
  }

  hyperliquidSchedulerStats(): HyperliquidInfoSchedulerStats | undefined {
    return this.config.venue === "hyperliquid" ? hyperliquidInfoSchedulerStatsForScope() : undefined;
  }

  /** Cached for ten seconds per range so several viewers cost one venue read. */
  dashboardSnapshot(range: DashboardRange): Promise<DashboardSnapshot> {
    this.snapshotCache ??= new DashboardSnapshotCache((r) => buildDashboardSnapshot(this, { range: r }));
    return this.snapshotCache.get(range);
  }

  signalCheck() {
    if (this.swing) return this.swing.check();
    if (this.config.strategy.id === "market-make" && this.config.strategy.config.two_sided && !MarketMakeConfigSchema.parse(this.config.strategy.config).two_sided?.adaptive) {
      return Promise.resolve({ ok: true, required: false, count: 0, source: "polymarket-books" });
    }
    if (!this.opts.quotientToken) throw new Error("no Quotient API key in this runtime's environment");
    return checkLiveSignalAccess(this.config.signals, this.opts.quotientToken);
  }

  private requireSwing(): SwingController {
    if (!this.swing) throw new Error("this bot does not run quotient-swing");
    return this.swing;
  }
  swingStatus() { return this.requireSwing().status(); }
  swingCheck() { return this.requireSwing().check(); }
  // Dry-run's async research must not hold the execution/protection mutex.
  swingDryRun() { return this.requireSwing().dryRun(); }
  swingReplay(options: { from?: number; until?: number; costMultiplier?: number; fillModel?: "cross" | "touch" } = {}) {
    return this.requireSwing().replay(options);
  }
  swingHalt() { return this.exclusive(async () => { await this.requireSwing().halt(); return this.requireSwing().status(); }); }
  async swingResume(acknowledgeLossReset = false) {
    await this.requireSwing().refreshResearch();
    return this.exclusive(async () => { await this.requireSwing().resume(acknowledgeLossReset); return this.requireSwing().status(); });
  }

  async geoblockCheck(): Promise<{ blocked?: boolean; country?: string; region?: string }> {
    const response = await fetch("https://polymarket.com/api/geoblock");
    if (!response.ok) throw new Error(`Polymarket geoblock check ${response.status}`);
    return (await response.json()) as { blocked?: boolean; country?: string; region?: string };
  }

  /**
   * Agent-strategy preflight for init/deploy gates: verifies the Surplus key
   * live and reports what the agent is configured with. Key material never
   * appears in the response.
   */
  async agentCheck(): Promise<{ ok: true; enabled: boolean; promptSet?: boolean; personaSet?: boolean; model?: string }> {
    if (this.config.strategy.id !== "agent") return { ok: true, enabled: false };
    if (!this.opts.surplusApiKey) throw new Error("the agent strategy is configured but SURPLUS_API_KEY is missing");
    const cfg = AgentConfigSchema.parse(this.config.strategy.config);
    await new SurplusClient({
      apiKey: this.opts.surplusApiKey,
      baseUrl: cfg.llm.baseUrl,
      fallbackBaseUrl: cfg.llm.fallbackBaseUrl,
      modelPool: cfg.llm.modelPool,
    }).verify();
    return {
      ok: true,
      enabled: true,
      promptSet: cfg.prompt.trim().length > 0,
      personaSet: Boolean(cfg.persona),
      model: cfg.llm.modelPool[0],
    };
  }

  /** Config summary plus the last wake's run report, for `cassie agent status`. */
  async agentStatus(): Promise<{ strategy: string; config?: unknown; lastRun?: AgentRunReport }> {
    if (this.config.strategy.id !== "agent") return { strategy: this.config.strategy.id };
    const cfg = AgentConfigSchema.parse(this.config.strategy.config);
    const raw = await this.state.get(`strategy:${AGENT_MEMORY_KEYS.lastRun}`);
    return {
      strategy: "agent",
      config: {
        prompt: cfg.prompt,
        criteria: cfg.criteria,
        personaHandle: cfg.persona?.handle,
        budgetUsd: cfg.budgetUsd,
        riskBudgetPct: cfg.riskBudgetPct,
        dailyBudgetUsd: cfg.dailyBudgetUsd,
        maxPositions: cfg.maxPositions,
        agentIntervalMin: cfg.agentIntervalMin,
        model: cfg.llm.modelPool[0],
      },
      lastRun: raw ? (JSON.parse(raw) as AgentRunReport) : undefined,
    };
  }

  /**
   * One full scan+decide cycle — discovery, Quotient enrichment, the model
   * call, persona judgment, quarter-Kelly arithmetic — with nothing persisted
   * and no orders placed. Spends real Quotient/Surplus calls.
   */
  agentDryRun(): Promise<AgentRunReport> {
    return this.exclusive(async () => {
      if (!this.strategy || !this.engine) throw new Error(`strategy "${this.config.strategy.id}" has no agent preview`);
      const preview = (this.strategy as Partial<PreviewableStrategy>).preview;
      if (!preview) throw new Error(`strategy "${this.config.strategy.id}" has no dry-run preview`);
      const ctx = await this.engine.strategyContext();
      return preview.call(this.strategy, ctx);
    });
  }

  marketMakeStatus(): MarketMakeControllerStatus {
    if (!this.marketMaker) throw new Error(`strategy "${this.config.strategy.id}" is not market-make`);
    return this.marketMaker.status();
  }

  marketMakeDryRun(): Promise<MarketMakeDryRunResult> {
    if (!this.marketMaker) return Promise.reject(new Error(`strategy "${this.config.strategy.id}" is not market-make`));
    return this.exclusive<MarketMakeDryRunResult>(() => this.marketMaker!.dryRun());
  }

  marketMakeHalt(options: { liquidate?: boolean } = {}): Promise<MarketMakeControllerStatus> {
    if (!this.marketMaker) return Promise.reject(new Error(`strategy "${this.config.strategy.id}" is not market-make`));
    return this.exclusive<MarketMakeControllerStatus>(() => this.marketMaker!.halt(options));
  }

  marketMakeResume(options: { acknowledgeLossReset?: boolean } = {}): Promise<MarketMakeControllerStatus> {
    if (!this.marketMaker) return Promise.reject(new Error(`strategy "${this.config.strategy.id}" is not market-make`));
    return this.exclusive<MarketMakeControllerStatus>(() => this.marketMaker!.resume(options));
  }

  marketMakeReconcile(
    options: { apply?: boolean; expectedProposalHash?: string } = {},
  ): Promise<MarketMakeReconcileResult> {
    if (!this.marketMaker) return Promise.reject(new Error(`strategy "${this.config.strategy.id}" is not market-make`));
    if (options.apply === true && !options.expectedProposalHash) {
      return Promise.reject(new Error("applying reconciliation requires the exact proposal hash from a report-only preview"));
    }
    return this.exclusive<MarketMakeReconcileResult>(() => this.marketMaker!.reconcile(options));
  }

  marketMakeSnapshot(): {
    strategy: ReturnType<MarketMaker["stateSnapshot"]>;
    persistence: ReturnType<MarketMakeStateStore["exportSnapshot"]> | undefined;
  } {
    if (!this.marketMaker) throw new Error(`strategy "${this.config.strategy.id}" is not market-make`);
    return {
      strategy: this.marketMaker.stateSnapshot(),
      persistence: this.marketMakeState?.exportSnapshot(),
    };
  }

  /**
   * Venue-dispatched access check for the deploy gate. Polymarket keeps its
   * geoblock endpoint (blocked = the venue refuses this region); Kalshi is the
   * inverse — an authenticated balance read from here proves the venue accepts
   * this droplet's (US) IP and the credentials.
   */
  async venueAccessCheck(): Promise<{ blocked: boolean; detail?: string; country?: string; region?: string }> {
    if (this.config.venue === "polymarket") {
      const geo = await this.geoblockCheck();
      return { blocked: Boolean(geo.blocked), country: geo.country, region: geo.region };
    }
    if (this.config.venue === "kalshi") {
      try {
        await this.adapter.balances(this.account);
        return { blocked: false };
      } catch (error) {
        return { blocked: true, detail: (error as Error).message.slice(0, 200) };
      }
    }
    return { blocked: false };
  }
}

// packages/runtime-node/src/service.ts
// The long-running trading service. One instance per bot. Owns the engine, the
// tick loop, the dead man's switch heartbeat, and the trigger check.

import { readFileSync } from "node:fs";
import {
  AresClient,
  ConsoleAlerter,
  Engine,
  FanoutAlerter,
  FixtureSignalSource,
  LiveSignalSource,
  MarketMakeQuotientClient,
  PolymarketCatalogClient,
  SafeAlerter,
  TelegramAlerter,
  buildReporter,
  checkLiveSignalAccess,
  computePortfolio,
  consoleLogger,
  createAdapter,
  type Alerter,
  type BotConfig,
  type LogLevel,
  type Logger,
  type ManualOrderParams,
  type RuntimeCreds,
  type SignalSource,
  type Strategy,
  type VenueAccount,
  type VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import {
  QuotientResearchClient,
  SurplusClient,
  createMarketLister,
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
import { MarketMakeStateStore } from "./market-make-state.js";
import {
  MarketMakeController,
  type MarketMakeControllerStatus,
  type MarketMakeDryRunResult,
  type MarketMakeReconcileResult,
  type MarketMakeTickResult,
} from "./market-make-controller.js";
import { MarketMakeConfigSchema } from "@quotient-forecasting/strategy-market-make";
import { nextTickAtMs, tickIdAt } from "./tick-schedule.js";
import {
  DEFAULT_SIGNAL_POLL_INTERVAL_MIN,
  PollingSignalSource,
} from "./polling-signal-source.js";

const HEARTBEAT_MS = 5_000;
const TRIGGER_CHECK_MS = 60_000;

export interface RuntimeIdentity {
  runtime: "droplet" | "local";
  protocol: 2;
  botId: string;
  version: string;
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
  /** SQLite path. One file per bot. */
  statePath: string;
  runtime: RuntimeIdentity["runtime"];
  requiredRegion?: string;
  region?: string;
  deploymentId?: string;
  version?: string;
  quotientToken?: string;
  telegramToken?: string;
  /** Ares authoring key. Absent = attribute orders, publish nothing. */
  reportingApiKey?: string;
  /** Surplus Intelligence key (inf_…). Required by the agent strategy only. */
  surplusApiKey?: string;
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
    },
  );
}

function compactNumber(value: number): string {
  return String(Number(value.toFixed(4)));
}

export function buildAlerter(opts: BotRuntimeOptions, log: Logger): Alerter {
  const sinks: Alerter[] = [];
  const chatId = opts.config.alerts.telegram?.chatId;
  if (opts.telegramToken && chatId) {
    sinks.push(new SafeAlerter(new TelegramAlerter(opts.telegramToken, chatId), log));
  }
  const reporter = buildReporter({ reporting: opts.config.reporting, apiKey: opts.reportingApiKey, log });
  if (reporter) sinks.push(new SafeAlerter(reporter, log));
  if (sinks.length === 0) return new ConsoleAlerter(log);
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
  private readonly marketMaker?: MarketMakeController;
  private readonly marketMakeState?: MarketMakeStateStore;
  private readonly state: SqliteStateStore;
  private readonly opts: BotRuntimeOptions;
  private readonly intervalSeconds: number;
  private operation: Promise<void> = Promise.resolve();
  private heartbeatTimer?: NodeJS.Timeout;
  private triggerTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;
  private active = false;
  private terminating = false;
  private shutdownPromise?: Promise<ShutdownResult>;
  private lastTickAt?: number;

  constructor(opts: BotRuntimeOptions) {
    this.opts = opts;
    this.config = opts.config;
    this.account = opts.account;
    this.log = opts.log ?? consoleLogger(opts.config.id);
    this.state = new SqliteStateStore(opts.statePath);
    this.intervalSeconds = Math.max(1, Math.round(opts.config.tickIntervalMin * 60));
    this.adapter = createAdapter(opts.config.venue, {
      urls: opts.config.venueUrls,
      creds: opts.creds,
      fixtureBooks: opts.fixtureBooksPath ? readFileSync(opts.fixtureBooksPath, "utf8") : undefined,
      builderCode: opts.config.reporting?.builderCode,
    });
    const alerter = buildAlerter(opts, this.log);
    if (opts.config.strategy.id === "market-make") {
      if (opts.config.venue !== "polymarket" || opts.account.venue !== "polymarket") {
        throw new Error("the market-make controller requires a Polymarket bot and account");
      }
      if (!opts.quotientToken) {
        throw new Error("the market-make strategy needs a Quotient API key");
      }
      const config = MarketMakeConfigSchema.parse(opts.config.strategy.config);
      this.marketMakeState = new MarketMakeStateStore(opts.statePath);
      this.marketMaker = new MarketMakeController(
        {
          config,
          stateStore: this.marketMakeState,
          snapshotStore: this.state,
          venue: this.adapter,
          account: opts.account,
          quotient: new MarketMakeQuotientClient({
            baseUrl: opts.config.signals.baseUrl,
            signalsPath: opts.config.signals.path,
            token: opts.quotientToken,
          }),
          catalog: new PolymarketCatalogClient({ gammaBaseUrl: opts.config.venueUrls.polymarket.gamma }),
          botId: opts.config.id,
          alerter,
          log: this.log,
        },
        {
          deploymentId: opts.deploymentId ?? `${opts.runtime}:${opts.config.id}`,
          autoSchedule: false,
          enableSubscriptions: true,
        },
      );
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
      requiredRegion: opts.requiredRegion,
      region: opts.region,
      deploymentId: opts.deploymentId,
    };
  }

  get running(): boolean {
    return this.active;
  }

  status(): RuntimeIdentity & {
    active: boolean;
    lastTickAt?: number;
    tickIntervalMin: number;
    marketMake?: MarketMakeControllerStatus;
  } {
    return {
      ...this.identity,
      active: this.active,
      lastTickAt: this.lastTickAt,
      tickIntervalMin: this.config.tickIntervalMin,
      ...(this.marketMaker ? { marketMake: this.marketMaker.status() } : {}),
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
        if (this.marketMaker) await this.marketMaker.start();
        else await this.syncFastLoops();
      });
      this.active = true;
      // Tick the current slot right away rather than idling to the next
      // boundary. The slot-derived id makes that a no-op when a restart lands
      // inside a slot the engine already completed.
      this.scheduleTick(0);
      this.log.info(
        this.marketMaker
          ? `market-make loop started ${this.marketMaker.status().halted ? "halted" : "active"}; ` +
              `reconciliation every ${compactNumber(this.intervalSeconds)}s`
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
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.triggerTimer) clearInterval(this.triggerTimer);
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.heartbeatTimer = undefined;
    this.triggerTimer = undefined;
    this.tickTimer = undefined;
  }

  private async syncFastLoops(): Promise<void> {
    if (!this.engine) return;
    const engine = this.engine;
    const resting = await engine.heartbeatIfResting().catch((error) => {
      this.log.warn(`heartbeat probe failed: ${(error as Error).message}`);
      return false;
    });
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
    this.terminating = true;
    this.active = false;
    this.stopTimers();

    const shutdown = (async (): Promise<ShutdownResult> => {
      let primaryFailure: unknown;
      try {
        return await this.exclusive(async () => {
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
        const closeFailures: unknown[] = [];
        try {
          this.marketMakeState?.close();
        } catch (error) {
          closeFailures.push(error);
        }
        try {
          this.state.close();
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
      }
    })();
    // Keep the exact promise, including rejection, so a concurrent or later
    // retry cannot report success after the stores have already been closed.
    this.shutdownPromise = shutdown;
    return shutdown;
  }

  tick(tickId?: number): Promise<MarketMakeTickResult | import("@quotient-forecasting/cassie-core").TickResult> {
    return this.exclusive(async () => {
      const result = this.marketMaker
        ? await this.marketMaker.tick()
        : await this.engine!.tick(tickId === undefined ? {} : { tickId });
      this.lastTickAt = Date.now();
      if (!this.marketMaker) await this.syncFastLoops();
      return result;
    });
  }

  portfolio() {
    return this.exclusive(() => computePortfolio(this.config.id, this.adapter, this.account));
  }

  orders() {
    return this.exclusive(() => this.adapter.openOrders(this.account));
  }

  cancelOrder(id: string): Promise<void> {
    if (this.marketMaker) {
      return Promise.reject(new Error(
        "generic order cancellation is disabled for market-make bots; use market-make halt and hash-bound reconciliation",
      ));
    }
    return this.exclusive(async () => {
      await this.adapter.cancelOrder(this.account, id);
    });
  }

  cancelAll(): Promise<void> {
    if (this.marketMaker) {
      return Promise.reject(new Error(
        "generic cancel-all is disabled for market-make bots; use market-make halt and hash-bound reconciliation",
      ));
    }
    return this.exclusive(async () => {
      await this.adapter.cancelAll(this.account);
      await this.syncFastLoops();
    });
  }

  manualOrder(params: ManualOrderParams) {
    return this.exclusive(async () => {
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
    if (this.marketMaker) {
      await this.exclusive(async () => this.marketMaker!.halt());
      return;
    }
    await this.state.set("engine:paused", "true");
  }

  async resume(): Promise<void> {
    if (this.marketMaker) {
      throw new Error("use /market-make/resume after reviewing reconciliation and activation state");
    }
    await this.state.delete("engine:paused");
  }

  async paused(): Promise<boolean> {
    if (this.marketMaker) return this.marketMaker.status().halted;
    return (await this.state.get("engine:paused")) === "true";
  }

  logs(level?: LogLevel, tail?: number) {
    return this.state.readErrors({ level, tail });
  }

  signalCheck() {
    if (!this.opts.quotientToken) throw new Error("no Quotient API key in this runtime's environment");
    return checkLiveSignalAccess(this.config.signals, this.opts.quotientToken);
  }

  async reportingCheck(): Promise<{ ok: true; enabled: boolean; username?: string; builderCodeConfigured: boolean }> {
    const reporting = this.config.reporting;
    if (!reporting) return { ok: true, enabled: false, builderCodeConfigured: false };
    if (!this.opts.reportingApiKey) throw new Error("reporting is enabled but ARES_API_KEY is missing");
    const { username } = await new AresClient({ apiKey: this.opts.reportingApiKey, baseUrl: reporting.baseUrl }).me();
    return { ok: true, enabled: reporting.post, username, builderCodeConfigured: true };
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
    return this.exclusive(() => this.marketMaker!.dryRun());
  }

  marketMakeHalt(options: { liquidate?: boolean } = {}): Promise<MarketMakeControllerStatus> {
    if (!this.marketMaker) return Promise.reject(new Error(`strategy "${this.config.strategy.id}" is not market-make`));
    return this.exclusive(() => this.marketMaker!.halt(options));
  }

  marketMakeResume(options: { acknowledgeLossReset?: boolean } = {}): Promise<MarketMakeControllerStatus> {
    if (!this.marketMaker) return Promise.reject(new Error(`strategy "${this.config.strategy.id}" is not market-make`));
    return this.exclusive(() => this.marketMaker!.resume(options));
  }

  marketMakeReconcile(
    options: { apply?: boolean; expectedProposalHash?: string } = {},
  ): Promise<MarketMakeReconcileResult> {
    if (!this.marketMaker) return Promise.reject(new Error(`strategy "${this.config.strategy.id}" is not market-make`));
    if (options.apply === true && !options.expectedProposalHash) {
      return Promise.reject(new Error("applying reconciliation requires the exact proposal hash from a report-only preview"));
    }
    return this.exclusive(() => this.marketMaker!.reconcile(options));
  }

  marketMakeSnapshot() {
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

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
  type TickResult,
  type VenueAccount,
  type VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import { FlipFlatStrategy } from "@quotient-forecasting/strategy-flip-flat";
import { SqliteStateStore } from "./state.js";
import { nextTickAtMs, tickIdAt } from "./tick-schedule.js";

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
  version?: string;
  quotientToken?: string;
  telegramToken?: string;
  /** Ares authoring key. Absent = attribute orders, publish nothing. */
  reportingApiKey?: string;
  log?: Logger;
  /** Contributor-test hook for a deterministic signal file. */
  signalsFixturePath?: string;
  fixtureBooksPath?: string;
}

export function buildStrategy(id: string): Strategy {
  // "signals" is the user-facing name; "flip-flat" is the original id.
  if (id === "signals" || id === "flip-flat") return new FlipFlatStrategy();
  throw new Error(`unknown strategy "${id}" — the MVP strategy is "signals"`);
}

export function buildSignalSource(opts: BotRuntimeOptions): SignalSource {
  if (opts.signalsFixturePath) {
    return new FixtureSignalSource(readFileSync(opts.signalsFixturePath, "utf8"));
  }
  if (!opts.quotientToken) {
    throw new Error("live signals need a Quotient API key (environment, .local.env, Quotient CLI, or bot keystore)");
  }
  return new LiveSignalSource(opts.config.signals, opts.quotientToken);
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
  private readonly engine: Engine;
  private readonly state: SqliteStateStore;
  private readonly opts: BotRuntimeOptions;
  private readonly intervalSeconds: number;
  private operation: Promise<void> = Promise.resolve();
  private heartbeatTimer?: NodeJS.Timeout;
  private triggerTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;
  private active = false;
  private terminating = false;
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
    this.engine = new Engine({
      botId: opts.config.id,
      config: opts.config,
      adapter: this.adapter,
      account: opts.account,
      strategy: buildStrategy(opts.config.strategy.id),
      signals: buildSignalSource(opts),
      alerter: buildAlerter(opts, this.log),
      state: this.state,
      log: this.log,
    });
    this.identity = {
      runtime: opts.runtime,
      protocol: 2,
      botId: opts.config.id,
      version: opts.version ?? "unknown",
      requiredRegion: opts.requiredRegion,
      region: opts.region,
    };
  }

  get running(): boolean {
    return this.active;
  }

  status(): RuntimeIdentity & { active: boolean; lastTickAt?: number; tickIntervalMin: number } {
    return {
      ...this.identity,
      active: this.active,
      lastTickAt: this.lastTickAt,
      tickIntervalMin: this.config.tickIntervalMin,
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
      await this.exclusive(async () => this.syncFastLoops());
      this.active = true;
      // Tick the current slot right away rather than idling to the next
      // boundary. The slot-derived id makes that a no-op when a restart lands
      // inside a slot the engine already completed.
      this.scheduleTick(0);
      this.log.info(`loop started; tick interval ${this.config.tickIntervalMin}m`);
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
    const resting = await this.engine.heartbeatIfResting().catch((error) => {
      this.log.warn(`heartbeat probe failed: ${(error as Error).message}`);
      return false;
    });
    if (resting && !this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        void this.exclusive(async () => {
          const stillResting = await this.engine.heartbeatIfResting();
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

    const armed = await this.engine.hasArmedTriggers().catch((error) => {
      this.log.warn(`trigger probe failed: ${(error as Error).message}`);
      return false;
    });
    if (armed && !this.triggerTimer) {
      this.triggerTimer = setInterval(() => {
        void this.exclusive(async () => {
          await this.engine.checkTriggers();
          if (!(await this.engine.hasArmedTriggers()) && this.triggerTimer) {
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

  async shutdown(cancelResting = true): Promise<void> {
    if (this.terminating) return this.operation;
    this.terminating = true;
    this.active = false;
    this.stopTimers();
    await this.exclusive(async () => {
      if (cancelResting) {
        this.log.info("shutdown: canceling resting orders");
        await this.engine.cancelAllResting();
      }
    });
    this.state.close();
  }

  tick(tickId?: number): Promise<TickResult> {
    return this.exclusive(async () => {
      const result = await this.engine.tick(tickId === undefined ? {} : { tickId });
      this.lastTickAt = Date.now();
      await this.syncFastLoops();
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
    return this.exclusive(() => this.adapter.cancelOrder(this.account, id));
  }

  cancelAll(): Promise<void> {
    return this.exclusive(async () => {
      await this.adapter.cancelAll(this.account);
      await this.syncFastLoops();
    });
  }

  manualOrder(params: ManualOrderParams) {
    return this.exclusive(async () => {
      const result = await this.engine.manualOrder(params);
      await this.syncFastLoops();
      return result;
    });
  }

  async pause(): Promise<void> {
    await this.state.set("engine:paused", "true");
  }

  async resume(): Promise<void> {
    await this.state.delete("engine:paused");
  }

  async paused(): Promise<boolean> {
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
}

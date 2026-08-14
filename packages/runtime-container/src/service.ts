// packages/runtime-container/src/service.ts
// Long-running trading service hosted inside a Cloudflare Container. Venue and
// signal traffic originates here (and therefore from the constrained region),
// while state is persisted by the container's Durable Object.

import {
  AresClient,
  ConsoleAlerter,
  Engine,
  FanoutAlerter,
  LiveSignalSource,
  SafeAlerter,
  TelegramAlerter,
  buildReporter,
  checkLiveSignalAccess,
  computePortfolio,
  consoleLogger,
  createAdapter,
  parseBotConfig,
  type Alerter,
  type BotConfig,
  type LogLevel,
  type ManualOrderParams,
  type RuntimeCreds,
  type TickResult,
  type VenueAccount,
  type VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import { FlipFlatStrategy } from "@quotient-forecasting/strategy-flip-flat";
import { DurableObjectStateStore } from "./state.js";

const HEARTBEAT_MS = 5_000;
const TRIGGER_CHECK_MS = 60_000;

export interface ContainerIdentity {
  runtime: "cloudflare-container";
  protocol: 1;
  botId: string;
  active: boolean;
  requiredRegion: string;
  region: string;
  location?: string;
  country?: string;
  deploymentId?: string;
  runtimeFingerprint: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing container environment variable ${name}`);
  return value;
}

function buildAlerter(cfg: BotConfig, log: ReturnType<typeof consoleLogger>): Alerter {
  const sinks: Alerter[] = [];
  const chatId = cfg.alerts.telegram?.chatId;
  if (process.env.TELEGRAM_BOT_TOKEN && chatId) {
    sinks.push(new SafeAlerter(new TelegramAlerter(process.env.TELEGRAM_BOT_TOKEN, chatId), log));
  }
  const reporter = buildReporter({ reporting: cfg.reporting, apiKey: process.env.ARES_API_KEY, log });
  if (reporter) sinks.push(new SafeAlerter(reporter, log));
  if (sinks.length === 0) return new ConsoleAlerter(log);
  return sinks.length === 1 ? sinks[0]! : new FanoutAlerter(sinks);
}

export class BotService {
  readonly config: BotConfig;
  readonly account: VenueAccount;
  readonly identity: Omit<ContainerIdentity, "active">;

  private readonly adapter: VenueAdapter;
  private readonly engine: Engine;
  private readonly state = new DurableObjectStateStore();
  private readonly log: ReturnType<typeof consoleLogger>;
  private operation: Promise<void> = Promise.resolve();
  private tickTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private triggerTimer?: NodeJS.Timeout;
  private active = false;
  private terminating = false;

  constructor() {
    const botId = required("CASSIE_BOT_ID");
    this.log = consoleLogger(botId);
    this.config = parseBotConfig(JSON.parse(required("CASSIE_BOT_CONFIG")));
    const creds = JSON.parse(required("CASSIE_BOT_CREDS")) as RuntimeCreds;
    if (this.config.id !== botId) throw new Error(`container bot id mismatch: ${this.config.id} != ${botId}`);
    if (!this.config.account) throw new Error(`bot ${botId} has no venue account configured`);
    if (this.config.signals.source !== "live") throw new Error("Cloudflare Container runtime requires live signals");

    const requiredRegion = required("CASSIE_REQUIRED_REGION");
    const region = required("CLOUDFLARE_REGION");
    if (region !== requiredRegion) {
      throw new Error(`refusing to run outside required region ${requiredRegion}; Cloudflare placed container in ${region}`);
    }
    const quotientToken = required("QUOTIENT_API_TOKEN");
    this.account = this.config.account;
    this.adapter = createAdapter(this.config.venue, {
      urls: this.config.venueUrls,
      creds,
      builderCode: this.config.reporting?.builderCode,
    });
    this.engine = new Engine({
      botId,
      config: this.config,
      adapter: this.adapter,
      account: this.account,
      strategy: new FlipFlatStrategy(),
      signals: new LiveSignalSource(this.config.signals, quotientToken),
      alerter: buildAlerter(this.config, this.log),
      state: this.state,
      log: this.log,
    });
    this.identity = {
      runtime: "cloudflare-container",
      protocol: 1,
      botId,
      requiredRegion,
      region,
      location: process.env.CLOUDFLARE_LOCATION,
      country: process.env.CLOUDFLARE_COUNTRY_A2,
      deploymentId: process.env.CLOUDFLARE_DEPLOYMENT_ID,
      runtimeFingerprint: required("CASSIE_RUNTIME_FINGERPRINT"),
    };
  }

  get running(): boolean {
    return this.active;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.operation.then(fn, fn);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async start(): Promise<void> {
    if (this.active || this.terminating) return;
    this.active = true;
    await this.exclusive(async () => this.syncFastLoops());
    this.scheduleTick();
    this.log.info(`container loop started: every ${this.config.tickIntervalMin}m`);
  }

  private scheduleTick(): void {
    if (!this.active || this.terminating) return;
    clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => {
      void this.exclusive(async () => {
        if (!this.active || this.terminating) return;
        await this.engine.tick();
        await this.syncFastLoops();
      })
        .catch((error) => this.log.error(`tick crashed: ${(error as Error).message}`))
        .finally(() => this.scheduleTick());
    }, this.config.tickIntervalMin * 60_000);
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

    const armed = await this.engine.hasArmedTriggers();
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
    clearTimeout(this.tickTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.triggerTimer) clearInterval(this.triggerTimer);
    this.tickTimer = undefined;
    this.heartbeatTimer = undefined;
    this.triggerTimer = undefined;
    await this.exclusive(async () => {
      if (cancelResting) {
        this.log.info("container shutdown: canceling resting orders");
        await this.engine.cancelAllResting();
      }
    });
  }

  tick(): Promise<TickResult> {
    return this.exclusive(async () => {
      const result = await this.engine.tick();
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

  logs(level?: LogLevel, tail?: number) {
    return this.state.readErrors({ level, tail });
  }

  signalCheck() {
    return checkLiveSignalAccess(this.config.signals, required("QUOTIENT_API_TOKEN"));
  }

  async reportingCheck(): Promise<{ ok: true; enabled: boolean; username?: string; builderCodeConfigured: boolean }> {
    const reporting = this.config.reporting;
    if (!reporting) return { ok: true, enabled: false, builderCodeConfigured: false };
    const apiKey = process.env.ARES_API_KEY;
    if (!apiKey) throw new Error("reporting is enabled but ARES_API_KEY is missing");
    const { username } = await new AresClient({ apiKey, baseUrl: reporting.baseUrl }).me();
    return { ok: true, enabled: reporting.post, username, builderCodeConfigured: true };
  }

  async geoblockCheck(): Promise<{ blocked?: boolean; country?: string; region?: string }> {
    const response = await fetch("https://polymarket.com/api/geoblock");
    if (!response.ok) throw new Error(`Polymarket geoblock check ${response.status}`);
    return (await response.json()) as { blocked?: boolean; country?: string; region?: string };
  }
}

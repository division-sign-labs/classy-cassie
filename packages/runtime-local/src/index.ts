// packages/runtime-local/src/index.ts
// Local Node runtime (§11): same engine, interval timer, state in
// ~/.cassie/state/<botId>.sqlite (better-sqlite3). Ctrl-C cancels resting
// orders before exit; the venue-side dead man's switch covers hard kills.

import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ConsoleAlerter,
  Engine,
  FanoutAlerter,
  FixtureSignalSource,
  LiveSignalSource,
  SafeAlerter,
  TelegramAlerter,
  buildReporter,
  consoleLogger,
  createAdapter,
  type Alerter,
  type BotConfig,
  type ErrorRecord,
  type Logger,
  type LogQuery,
  type RuntimeCreds,
  type SignalSource,
  type StateStore,
  type Strategy,
  type VenueAccount,
} from "@quotient/cassie-core";
import { FlipFlatStrategy } from "@quotient/strategy-flip-flat";

export class SqliteStateStore implements StateStore {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL,
        code TEXT NOT NULL,
        venue TEXT,
        message TEXT NOT NULL,
        context TEXT,
        tick_seq INTEGER
      );
    `);
  }

  async get(key: string): Promise<string | null> {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
  async delete(key: string): Promise<void> {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }
  async appendError(rec: ErrorRecord): Promise<void> {
    this.db
      .prepare("INSERT INTO errors (ts, level, code, venue, message, context, tick_seq) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(rec.ts, rec.level, rec.code, rec.venue ?? null, rec.message, rec.context ? JSON.stringify(rec.context) : null, rec.tickSeq ?? null);
  }
  async readErrors(q?: LogQuery): Promise<ErrorRecord[]> {
    const tail = q?.tail ?? 100;
    const rows = q?.level
      ? this.db.prepare("SELECT * FROM errors WHERE level = ? ORDER BY id DESC LIMIT ?").all(q.level, tail)
      : this.db.prepare("SELECT * FROM errors ORDER BY id DESC LIMIT ?").all(tail);
    return (rows as Record<string, unknown>[]).reverse().map((r) => ({
      ts: Number(r.ts),
      level: String(r.level) as ErrorRecord["level"],
      code: String(r.code),
      venue: (r.venue as ErrorRecord["venue"]) ?? undefined,
      message: String(r.message),
      context: r.context ? JSON.parse(String(r.context)) : undefined,
      tickSeq: r.tick_seq != null ? Number(r.tick_seq) : undefined,
    }));
  }

  close(): void {
    this.db.close();
  }
}

export interface LocalRunOpts {
  config: BotConfig;
  account: VenueAccount;
  creds?: RuntimeCreds;
  statePath: string;
  /** Overrides config.signals — e.g. `--signals fixtures/signals.json`. */
  signalsFixturePath?: string;
  quotientToken?: string;
  telegramToken?: string;
  /** Reporting provider key (e.g. ares_sk_live_…). Absent = attribute orders, report nothing. */
  reportingApiKey?: string;
  fixtureBooksPath?: string;
  log?: Logger;
  /** Test hook: run at most N ticks then return. */
  maxTicks?: number;
}

export function buildStrategy(id: string): Strategy {
  // "signals" is the user-facing name; "flip-flat" is the original id.
  if (id === "signals" || id === "flip-flat") return new FlipFlatStrategy();
  throw new Error(`unknown strategy "${id}" — the MVP strategy is "signals"`);
}

export function buildSignalSource(opts: LocalRunOpts): SignalSource {
  const cfg = opts.config.signals;
  const fixturePath = opts.signalsFixturePath ?? (cfg.source === "fixture" ? cfg.fixturePath : undefined);
  if (fixturePath) {
    return new FixtureSignalSource(readFileSync(fixturePath, "utf8"));
  }
  if (!opts.quotientToken) {
    throw new Error("live signals need QUOTIENT_API_TOKEN (env or keystore) — or pass --signals <fixture>");
  }
  return new LiveSignalSource({ baseUrl: cfg.baseUrl, path: cfg.path }, opts.quotientToken);
}

export function buildAlerter(opts: LocalRunOpts, log: Logger): Alerter {
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

export function buildLocalEngine(opts: LocalRunOpts): { engine: Engine; state: SqliteStateStore } {
  const log = opts.log ?? consoleLogger(opts.config.id);
  const state = new SqliteStateStore(opts.statePath);
  const adapter = createAdapter(opts.config.venue, {
    urls: opts.config.venueUrls,
    creds: opts.creds,
    fixtureBooks: opts.fixtureBooksPath ? readFileSync(opts.fixtureBooksPath, "utf8") : undefined,
    builderCode: opts.config.reporting?.builderCode,
  });
  const engine = new Engine({
    botId: opts.config.id,
    config: opts.config,
    adapter,
    account: opts.account,
    strategy: buildStrategy(opts.config.strategy.id),
    signals: buildSignalSource(opts),
    alerter: buildAlerter(opts, log),
    state,
    log,
  });
  return { engine, state };
}

/** Run the bot loop until SIGINT (or maxTicks, for tests). */
export async function runLocal(opts: LocalRunOpts): Promise<void> {
  const log = opts.log ?? consoleLogger(opts.config.id);
  const { engine, state } = buildLocalEngine({ ...opts, log });
  const intervalMs = opts.config.tickIntervalMin * 60_000;

  let stopping = false;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let triggerTimer: NodeJS.Timeout | undefined;

  const shutdown = async (fromSignal: boolean) => {
    if (stopping) return;
    stopping = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (triggerTimer) clearInterval(triggerTimer);
    if (fromSignal) {
      log.info("shutting down: canceling resting orders…");
      await engine.cancelAllResting().catch((err) => log.warn(`cancelAllResting failed: ${err.message}`));
    }
    state.close();
    if (fromSignal) process.exit(0);
  };
  process.once("SIGINT", () => void shutdown(true));
  process.once("SIGTERM", () => void shutdown(true));

  // Dead man's switch loop: ~5s cadence while orders rest (Polymarket's
  // heartbeat window is 10s; HL's scheduleCancel refresh rides the main tick).
  let resting = false;
  heartbeatTimer = setInterval(() => {
    if (stopping) return;
    void engine
      .heartbeatIfResting()
      .then((r) => (resting = r))
      .catch((err) => log.warn(`heartbeat: ${(err as Error).message}`));
  }, 5_000);
  // Tighter trigger-check schedule while synthetic stops are armed (§10).
  triggerTimer = setInterval(() => {
    if (stopping) return;
    void engine
      .hasArmedTriggers()
      .then((armed) => (armed ? engine.checkTriggers() : undefined))
      .catch((err) => log.warn(`trigger check: ${(err as Error).message}`));
  }, 60_000);

  let ticks = 0;
  for (;;) {
    if (stopping) return;
    const started = Date.now();
    try {
      await engine.tick();
    } catch (err) {
      log.error(`tick crashed: ${(err as Error).message}`);
    }
    ticks += 1;
    if (opts.maxTicks !== undefined && ticks >= opts.maxTicks) {
      await shutdown(false);
      return;
    }
    const elapsed = Date.now() - started;
    await sleep(Math.max(1_000, intervalMs - elapsed));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

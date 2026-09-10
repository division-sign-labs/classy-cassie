// packages/core/src/venues/hyperliquid-info-scheduler.ts
// Read-only IP-budget coordination; exchange/signing clients do not pass through this scheduler.
// Verified 2026-09-05: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
import type { InfoClient } from "@nktkas/hyperliquid";

const MINUTE = 60_000;
const LIGHT = new Set(["l2Book", "allMids", "clearinghouseState", "orderStatus", "spotClearinghouseState", "exchangeStatus"]);
// Execution-path reads (leverage setup, fee schedule, agent verification) are priority: the venue
// rejects an order placed without them, so they must never starve behind background traffic.
const PRIORITY = new Set([...LIGHT, "openOrders", "frontendOpenOrders", "allDexsClearinghouseState", "userAbstraction",
  "perpDexs", "meta", "metaAndAssetCtxs", "userRateLimit", "activeAssetData", "userFees", "extraAgents",
  "userFills", "userFillsByTime", "userFunding", "userNonFundingLedgerUpdates", "nonUserFundingUpdates",
  "userTwapSliceFills", "userTwapSliceFillsByTime"]);
const PER_TWENTY = new Set(["recentTrades", "historicalOrders", "userFills", "userFillsByTime", "fundingHistory", "userFunding",
  "nonUserFundingUpdates", "userNonFundingLedgerUpdates", "twapHistory", "userTwapSliceFills", "userTwapSliceFillsByTime",
  "delegatorHistory", "delegatorRewards", "validatorStats"]);

export interface HyperliquidInfoSchedulerOptions {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Total read weight, including protective calls; leave room below the venue's 1200/IP limit. */
  maxWeightPerMinute?: number;
  reservedPriorityWeight?: number;
  maxConcurrency?: number;
  maxQueueSize?: number;
  maxQueueWaitMs?: number;
  default429CooldownMs?: number;
  max429CooldownMs?: number;
  /** Default wrappers share one process-wide budget. Injected/custom settings are isolated unless explicitly scoped. */
  scope?: string;
}

export interface HyperliquidInfoSchedulerStats {
  queued: number; active: number; backgroundActive: number; weightInWindow: number;
  cooldownRemainingMs: number; requests: number; coalesced: number; rejected: number; rateLimited: number;
}

export class HyperliquidInfoDeferredError extends Error {
  readonly retryable = true;
  constructor(readonly reason: "queue-full" | "queue-expired" | "rate-budget" | "cooldown", readonly retryAfterMs: number) {
    super(`Hyperliquid info deferred: ${reason}; retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "HyperliquidInfoDeferredError";
  }
}

export function hyperliquidInfoResponseWeight(method: string, response: unknown): number {
  const base = LIGHT.has(method) ? 2 : method === "userRole" ? 60 : 20;
  const rows = Array.isArray(response) ? response.length : response && typeof response === "object" &&
    Array.isArray((response as { fills?: unknown }).fills) ? (response as { fills: unknown[] }).fills.length : 0;
  return base + (method === "candleSnapshot" ? Math.ceil(rows / 60) : PER_TWENTY.has(method) ? Math.ceil(rows / 20) : 0);
}

function requestWeight(method: string, args: unknown[], now: number): number {
  if (method !== "candleSnapshot") return hyperliquidInfoResponseWeight(method, undefined);
  const p = args[0] as { interval?: unknown; startTime?: unknown; endTime?: unknown } | undefined;
  const interval = typeof p?.interval === "string" ? /^(\d+)(m|h|d|w|M)$/.exec(p.interval) : null;
  const units: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, M: 28 * 86_400_000 };
  const duration = interval ? Number(interval[1]) * units[interval[2]!]! : NaN;
  const start = Number(p?.startTime), end = p?.endTime === undefined ? now : Number(p.endTime);
  const rows = Number.isFinite(start) && Number.isFinite(end) && duration > 0 && end >= start
    ? Math.min(5000, Math.ceil((end - start) / duration) + 1) : 5000;
  return 20 + Math.ceil(rows / 60);
}

/** Non-plain objects (notably AbortSignal) are not coalesced across callers. */
function canonical(value: unknown, ancestors = new Set<object>()): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (value === undefined) return "undefined";
  if (typeof value !== "object" || ancestors.has(value)) return undefined;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined;
  ancestors.add(value);
  const entries = Array.isArray(value) ? value.map(item => canonical(item, ancestors))
    : Object.keys(value).sort().map(key => {
      const item = canonical((value as Record<string, unknown>)[key], ancestors);
      return item === undefined ? undefined : `${JSON.stringify(key)}:${item}`;
    });
  ancestors.delete(value);
  return entries.some(item => item === undefined) ? undefined : Array.isArray(value) ? `[${entries.join(",")}]` : `{${entries.join(",")}}`;
}

type Job = {
  priority: boolean; method: string; weight: number; deadline: number; key?: string; signal?: AbortSignal;
  run: () => unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void;
};
type Charge = { at: number; weight: number };

class InfoScheduler {
  private readonly now: () => number;
  private readonly maxWeight: number;
  private readonly reserve: number;
  private readonly concurrency: number;
  private readonly queueLimit: number;
  private readonly queueWait: number;
  private readonly initialCooldown: number;
  private readonly maximumCooldown: number;
  private readonly queue: Job[] = [];
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly charges: Charge[] = [];
  private active = 0;
  private backgroundActive = 0;
  private cooldownUntil = 0;
  private rateLimitStreak = 0;
  private requests = 0;
  private coalesced = 0;
  private rejected = 0;
  private rateLimited = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private injectedSleepPending = false;

  constructor(private readonly options: HyperliquidInfoSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.maxWeight = options.maxWeightPerMinute ?? 900;
    this.reserve = options.reservedPriorityWeight ?? Math.min(500, Math.floor(this.maxWeight * 5 / 9));
    this.concurrency = options.maxConcurrency ?? 2;
    this.queueLimit = options.maxQueueSize ?? 256;
    this.queueWait = options.maxQueueWaitMs ?? 10_000;
    this.initialCooldown = options.default429CooldownMs ?? 30_000;
    this.maximumCooldown = options.max429CooldownMs ?? 120_000;
    if (![this.maxWeight, this.concurrency, this.queueLimit, this.queueWait, this.initialCooldown, this.maximumCooldown].every(n => Number.isSafeInteger(n) && n > 0) ||
      !Number.isSafeInteger(this.reserve) || this.reserve < 0 || this.reserve >= this.maxWeight || this.initialCooldown > this.maximumCooldown ||
      this.maxWeight > 900 || this.concurrency > 2 || this.queueWait > 10_000) {
      throw new Error("invalid Hyperliquid info scheduler limits");
    }
  }

  stats(): HyperliquidInfoSchedulerStats {
    const now = this.now(); this.prune(now);
    return { queued: this.queue.length, active: this.active, backgroundActive: this.backgroundActive,
      weightInWindow: this.charges.reduce((sum, c) => sum + c.weight, 0), cooldownRemainingMs: Math.max(0, this.cooldownUntil - now),
      requests: this.requests, coalesced: this.coalesced, rejected: this.rejected, rateLimited: this.rateLimited };
  }

  enqueue(clientId: number, method: string, args: unknown[], run: () => unknown): Promise<unknown> {
    const serialized = canonical(args), key = serialized === undefined ? undefined : `${clientId}:${method}:${serialized}`;
    if (key && this.pending.has(key)) { this.coalesced++; return this.pending.get(key)!; }
    const now = this.now();
    if (now < this.cooldownUntil) return this.defer("cooldown", this.cooldownUntil - now);
    const priority = PRIORITY.has(method);
    if (this.queue.length >= this.queueLimit) {
      let displaced = -1;
      if (priority) for (let index = this.queue.length - 1; index >= 0; index--) {
        if (!this.queue[index]!.priority) { displaced = index; break; }
      }
      if (displaced < 0) return this.defer("queue-full", this.queueWait);
      this.rejectJob(this.queue.splice(displaced, 1)[0]!, new HyperliquidInfoDeferredError("queue-full", this.queueWait));
    }
    const signal = args.find(arg => typeof AbortSignal !== "undefined" && arg instanceof AbortSignal) as AbortSignal | undefined;
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Hyperliquid info request aborted"));
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    if (key) this.pending.set(key, promise);
    this.queue.push({ priority, method, weight: requestWeight(method, args, now), deadline: now + this.queueWait, key, signal, run, resolve, reject });
    this.drain();
    return promise;
  }

  private defer(reason: HyperliquidInfoDeferredError["reason"], retryAfterMs: number): Promise<never> {
    this.rejected++;
    return Promise.reject(new HyperliquidInfoDeferredError(reason, retryAfterMs));
  }
  private rejectJob(job: Job, error: unknown): void {
    this.rejected++; if (job.key) this.pending.delete(job.key); job.reject(error);
  }
  private prune(now: number): void {
    while (this.charges[0] && this.charges[0].at <= now - MINUTE) this.charges.shift();
  }

  private drain(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const now = this.now(); this.prune(now);
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const job = this.queue[index]!;
      const error = job.signal?.aborted ? job.signal.reason ?? new Error("Hyperliquid info request aborted")
        : now < this.cooldownUntil ? new HyperliquidInfoDeferredError("cooldown", this.cooldownUntil - now)
        : now >= job.deadline ? new HyperliquidInfoDeferredError("queue-expired", this.queueWait) : undefined;
      if (error !== undefined) { this.queue.splice(index, 1); this.rejectJob(job, error); }
    }
    this.queue.sort((a, b) => Number(b.priority) - Number(a.priority));
    while (this.active < this.concurrency && this.queue.length) {
      const used = this.charges.reduce((sum, c) => sum + c.weight, 0);
      let selected = -1;
      for (let index = 0; index < this.queue.length; index++) {
        const job = this.queue[index]!;
        if (!job.priority && this.backgroundActive >= Math.max(1, this.concurrency - 1)) continue;
        const limit = this.maxWeight - (job.priority ? 0 : this.reserve);
        if (used + job.weight <= limit) { selected = index; break; }
        // A priority read waits (up to its deadline) for the window to free; an order must not fail
        // because a budget check landed a second early. Background reads are rejected outright so a
        // cold-history backlog never waits a minute inside an execution/read loop.
        if (job.priority) continue;
        this.queue.splice(index--, 1);
        this.rejectJob(job, new HyperliquidInfoDeferredError("rate-budget", Math.max(1, (this.charges[0]?.at ?? now) + MINUTE - now)));
      }
      if (selected < 0) break;
      this.run(this.queue.splice(selected, 1)[0]!);
    }
    if (!this.queue.length) return;
    const budgetFreesAt = this.charges[0] ? this.charges[0].at + MINUTE : now;
    const delay = Math.max(1, Math.min(Math.min(...this.queue.map(job => job.deadline)), budgetFreesAt) - now);
    if (this.options.sleep) {
      if (!this.injectedSleepPending) {
        this.injectedSleepPending = true;
        void Promise.resolve().then(() => this.options.sleep!(delay)).then(() => { this.injectedSleepPending = false; this.drain(); }, error => {
          this.injectedSleepPending = false;
          for (const job of this.queue.splice(0)) this.rejectJob(job, error);
        });
      }
    } else this.timer = setTimeout(() => { this.timer = undefined; this.drain(); }, delay);
  }

  private run(job: Job): void {
    const charge = { at: this.now(), weight: job.weight };
    this.charges.push(charge); this.active++; this.requests++;
    if (!job.priority) this.backgroundActive++;
    void Promise.resolve().then(job.run).then(result => {
      // Unknown list lengths are charged before the next queued request can start.
      charge.weight = Math.max(charge.weight, hyperliquidInfoResponseWeight(job.method, result));
      if (this.now() >= this.cooldownUntil) this.rateLimitStreak = 0;
      if (job.key) this.pending.delete(job.key);
      job.resolve(result);
    }, error => {
      const response = (error as { response?: { status?: number; headers?: { get(name: string): string | null } }; status?: number } | undefined)?.response;
      if (response?.status === 429 || (error as { status?: number } | undefined)?.status === 429) {
        this.rateLimited++; this.rateLimitStreak++;
        const now = this.now();
        const raw = response?.headers?.get("retry-after");
        const seconds = raw === null || raw === undefined || raw.trim() === "" ? NaN : Number(raw);
        const retryAt = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : raw ? Date.parse(raw) : NaN;
        const fallback = Math.min(this.maximumCooldown, this.initialCooldown * 2 ** Math.min(this.rateLimitStreak - 1, 20));
        this.cooldownUntil = Math.max(this.cooldownUntil, now + fallback, Number.isFinite(retryAt) ? retryAt : 0);
      }
      if (job.key) this.pending.delete(job.key);
      job.reject(error);
    }).finally(() => {
      this.active--; if (!job.priority) this.backgroundActive--;
      this.drain();
    });
  }
}

const shared = new Map<string, InfoScheduler>();
const schedulers = new WeakMap<InfoClient, InfoScheduler>();
const wrapped = new WeakMap<InfoClient, InfoClient>();
let nextClientId = 0;

/** All methods belong to the pinned SDK InfoClient: no exchange actions, signatures, or retries. */
export function wrapHyperliquidInfoClient(info: InfoClient, options: HyperliquidInfoSchedulerOptions = {}): InfoClient {
  if (schedulers.has(info)) return info;
  const existing = wrapped.get(info); if (existing) return existing;
  const scope = options.scope ?? (Object.keys(options).length ? undefined : "process-default");
  let scheduler = scope ? shared.get(scope) : undefined;
  if (!scheduler) {
    scheduler = new InfoScheduler(options);
    if (scope) shared.set(scope, scheduler);
  }
  const coordinator = scheduler, clientId = ++nextClientId;
  const methods = new Map<PropertyKey, (...args: unknown[]) => Promise<unknown>>();
  const proxy = new Proxy(info, { get(target, key) {
    const value: unknown = Reflect.get(target, key, target);
    if (typeof key !== "string" || key === "constructor" || typeof value !== "function") return value;
    if (Object.hasOwn(Object.prototype, key)) return value.bind(target);
    let method = methods.get(key);
    if (!method) {
      method = (...args) => coordinator.enqueue(clientId, key, args, () => Reflect.apply(value, target, args));
      methods.set(key, method);
    }
    return method;
  } });
  wrapped.set(info, proxy); schedulers.set(proxy, coordinator);
  return proxy;
}

/** Stats for a shared scheduler scope; the adapter's InfoClient is private, so this is the dashboard's read. */
export function hyperliquidInfoSchedulerStatsForScope(scope = "process-default"): HyperliquidInfoSchedulerStats | undefined {
  return shared.get(scope)?.stats();
}

export function hyperliquidInfoSchedulerStats(info: InfoClient): HyperliquidInfoSchedulerStats | undefined {
  return schedulers.get(info)?.stats();
}

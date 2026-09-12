// packages/core/src/venues/request-budget.ts
// Sliding-window request budget with per-family 429 cooldowns. Reads fail fast
// while a family is blocked instead of stacking timeouts against a throttled venue.
import { VenueRateLimitedError, isRateLimitError, retryAfterMs } from "./transient.js";

export interface RequestWindowSpec {
  /** Maximum charges inside one window. */
  capacity: number;
  windowMs: number;
  /** Charges kept back for priority callers; background callers cannot enter the reserve. */
  reserve?: number;
}

export interface RequestBudgetOptions {
  now?: () => number;
  /** First cooldown after a venue 429 that carried no retry hint. */
  defaultCooldownMs?: number;
  /** Cooldowns double per consecutive 429 up to this ceiling. */
  maxCooldownMs?: number;
}

export interface RequestFamilyStats {
  blockedMs: number;
  used: number;
  capacity?: number;
  streak: number;
}

interface FamilyState {
  spec?: RequestWindowSpec;
  charges: number[];
  blockedUntil: number;
  streak: number;
}

export class RequestBudget {
  private readonly families = new Map<string, FamilyState>();
  private readonly now: () => number;
  private readonly defaultCooldownMs: number;
  private readonly maxCooldownMs: number;

  constructor(options: RequestBudgetOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultCooldownMs = options.defaultCooldownMs ?? 5_000;
    this.maxCooldownMs = options.maxCooldownMs ?? 30_000;
  }

  /** Declare a sliding window for a family; families without one are only subject to cooldowns. */
  window(family: string, spec: RequestWindowSpec): void {
    if (!(spec.capacity > 0) || !(spec.windowMs > 0) || (spec.reserve ?? 0) < 0 || (spec.reserve ?? 0) >= spec.capacity) {
      throw new Error(`invalid request window for ${family}`);
    }
    this.state(family).spec = { ...spec };
  }

  private state(family: string): FamilyState {
    let state = this.families.get(family);
    if (!state) { state = { charges: [], blockedUntil: 0, streak: 0 }; this.families.set(family, state); }
    return state;
  }

  private prune(state: FamilyState, now: number): void {
    if (!state.spec) return;
    const horizon = now - state.spec.windowMs;
    while (state.charges.length && state.charges[0]! <= horizon) state.charges.shift();
  }

  /** Milliseconds left on a venue-imposed cooldown for the family. */
  blockedFor(family: string): number {
    return Math.max(0, this.state(family).blockedUntil - this.now());
  }

  /** Milliseconds until the next charge can succeed. */
  retryInMs(family: string): number {
    const state = this.state(family);
    const now = this.now();
    let wait = Math.max(0, state.blockedUntil - now);
    if (state.spec) {
      this.prune(state, now);
      if (state.charges.length >= state.spec.capacity - (state.spec.reserve ?? 0)) {
        wait = Math.max(wait, state.charges[0]! + state.spec.windowMs - now);
      }
    }
    return Math.max(wait, wait > 0 ? 0 : this.defaultCooldownMs);
  }

  /** Charge one unit if the window and cooldown allow. Background callers cannot use the reserve. */
  tryAcquire(family: string, opts: { priority?: boolean } = {}): boolean {
    const state = this.state(family);
    const now = this.now();
    if (now < state.blockedUntil) return false;
    if (!state.spec) return true;
    this.prune(state, now);
    const limit = state.spec.capacity - (opts.priority ? 0 : state.spec.reserve ?? 0);
    if (state.charges.length >= limit) return false;
    state.charges.push(now);
    return true;
  }

  /** Charge one unit or throw a transient rate-limit error carrying the wait. */
  acquire(family: string, opts: { priority?: boolean } = {}): void {
    if (!this.tryAcquire(family, opts)) throw new VenueRateLimitedError(family, this.retryInMs(family));
  }

  /** Record a venue 429 for the family; consecutive limits back off up to the ceiling. */
  noteRateLimited(family: string, error?: unknown): void {
    const state = this.state(family);
    const now = this.now();
    // A limit long after the previous cooldown ended starts a fresh streak.
    if (state.blockedUntil > 0 && now - state.blockedUntil > this.maxCooldownMs) state.streak = 0;
    if (now >= state.blockedUntil) state.streak += 1;
    const backoff = Math.min(this.maxCooldownMs, this.defaultCooldownMs * 2 ** Math.max(0, state.streak - 1));
    const requested = retryAfterMs(error) ?? 0;
    state.blockedUntil = Math.max(state.blockedUntil, now + Math.max(backoff, requested));
  }

  /** Run a venue call for the family: fail fast while blocked, note an explicit 429, rethrow everything. */
  async run<T>(family: string, fn: () => Promise<T>): Promise<T> {
    const blocked = this.blockedFor(family);
    if (blocked > 0) throw new VenueRateLimitedError(family, blocked);
    try {
      return await fn();
    } catch (error) {
      if (isRateLimitError(error)) this.noteRateLimited(family, error);
      throw error;
    }
  }

  stats(): Record<string, RequestFamilyStats> {
    const now = this.now();
    const out: Record<string, RequestFamilyStats> = {};
    for (const [family, state] of this.families) {
      this.prune(state, now);
      out[family] = { blockedMs: Math.max(0, state.blockedUntil - now), used: state.charges.length, streak: state.streak,
        ...(state.spec ? { capacity: state.spec.capacity } : {}) };
    }
    return out;
  }
}

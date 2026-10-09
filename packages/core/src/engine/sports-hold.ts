// packages/core/src/engine/sports-hold.ts
// Sports lifecycle policy shared by strategy decisions and order supervision.
import type { BotConfig } from "../config.js";
import type { Logger, MarketMetadata, Signal, SignalSource, SportsGameMetadata, StateStore } from "../types.js";
import { getJson, setJson } from "../state.js";

export const SPORTS_HOLD_KEY = "prediction:sports-hold:v1";
export const SPORTS_HOLD_REASON = "sports hold after start; hold to settlement";
interface SavedMarket extends MarketMetadata { started?: boolean }
interface Checkpoint { version: 1; markets: Record<string, SavedMarket> }

export class SportsHoldGuard {
  private checkpoint?: Checkpoint;
  private queue: Promise<unknown> = Promise.resolve();
  private lastFailureAt?: number;
  readonly enabled: boolean;
  constructor(private readonly d: { config: BotConfig; state: StateStore; signals: SignalSource; log: Logger; now: () => number }) {
    this.enabled = ["polymarket", "kalshi"].includes(d.config.venue)
      && ["signals", "flip-flat"].includes(d.config.strategy.id)
      && d.config.strategy.config.sportsHoldAfterStart !== false;
  }

  /** Refresh is serialized because the strategy and fast execution loop share this state. */
  refresh(marketRefs: readonly string[], signals: readonly Signal[] = []): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const work = this.queue.then(async () => {
      this.checkpoint ??= await getJson<Checkpoint>(this.d.state, SPORTS_HOLD_KEY) ?? { version: 1, markets: {} };
      if (this.checkpoint.version !== 1) throw new Error("unsupported sports hold checkpoint");
      const before = JSON.stringify(this.checkpoint);
      // Latch the start before a later observation can change the scheduled time.
      for (const row of Object.values(this.checkpoint.markets)) this.latch(row);
      for (const signal of signals) {
        if (signal.sleeve === "sports" || signal.sports) this.observe({ marketRef: signal.marketRef, sports: signal.sports ?? {} });
      }
      const refs = [...new Set(marketRefs)];
      if (refs.length && this.d.signals.marketMetadata) {
        try {
          const metadata = await this.d.signals.marketMetadata({ venue: this.d.config.venue, marketRefs: refs });
          const wanted = new Set(refs);
          for (const row of metadata) if (wanted.has(row.marketRef)) this.observe(row);
        } catch (error) {
          if (this.lastFailureAt === undefined || this.d.now() - this.lastFailureAt >= 60_000) {
            this.d.log.warn("sports lifecycle lookup failed; retain saved holds and defer unclassified markets", { error: String(error) });
            this.lastFailureAt = this.d.now();
          }
        }
      }
      if (JSON.stringify(this.checkpoint) !== before) await setJson(this.d.state, SPORTS_HOLD_KEY, this.checkpoint);
    });
    this.queue = work.catch(() => {});
    return work;
  }

  private observe(row: MarketMetadata): void {
    const previous = this.checkpoint!.markets[row.marketRef];
    // Missing sports context must not erase an already identified game.
    const sports = row.sports ? { ...previous?.sports, ...row.sports } : previous?.sports;
    const saved: SavedMarket = { marketRef: row.marketRef, ...(sports ? { sports } : {}), ...(previous?.started ? { started: true } : {}) };
    this.latch(saved);
    if (saved.started && !previous?.started) this.d.log.info(SPORTS_HOLD_REASON, { marketRef: row.marketRef, ...saved.sports });
    this.checkpoint!.markets[row.marketRef] = saved;
  }

  private latch(row: SavedMarket): void {
    if (row.sports && (row.sports.inPlay === true || this.started(row.sports))) row.started = true;
  }
  private started(sports: SportsGameMetadata): boolean {
    return typeof sports.kickoffAt === "number" && Number.isFinite(sports.kickoffAt) && this.d.now() >= sports.kickoffAt;
  }
  /** Clock-based checks also run immediately before a signed order can be posted. */
  isHeld(marketRef: string): boolean {
    if (!this.enabled) return false;
    const row = this.checkpoint?.markets[marketRef];
    if (!row) return this.d.signals.marketMetadata !== undefined;
    if (!row.sports) return false;
    return row.started === true || row.sports.inPlay === true || this.started(row.sports)
      || !Number.isFinite(row.sports.kickoffAt);
  }
}

// packages/core/src/quotient/strategy-rules.ts
// Strategy rules are served by Quotient behind a strategy-scoped key
// (qsk_…). The shipped strategy package carries the decision code; the tuned
// thresholds arrive from this endpoint at boot and are refreshed on a slow
// cadence. The last good document is persisted so a Quotient outage keeps the
// bot on its current rules instead of stopping exit evaluation.
//
//   GET {gateway}/api/v1/strategies/{strategyId}/rules
//     header x-quotient-api-key: qsk_…
//     → { strategyId, version, updatedAt, rules: { … } }

import { z } from "zod";
import { boundFetch } from "../http.js";
import type { Logger, StateStore, StrategyRulesSource } from "../types.js";
import { QuotientApiError, withQuotientRetries, type RetryOptions } from "./retry.js";

export const StrategyRulesDocumentSchema = z.object({
  strategyId: z.string().min(1),
  version: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
  rules: z.record(z.string(), z.unknown()),
});
export type StrategyRulesDocument = z.output<typeof StrategyRulesDocumentSchema>;

/** The runtime's strategy id for a bot config; "signals" and "flip-flat" share one rule set. */
export function strategyRulesId(strategyId: string): string {
  return strategyId === "flip-flat" ? "signals" : strategyId;
}

/** Strategies whose runtime needs a strategy-scoped key and a served rule set. */
export function usesStrategyKey(strategyId: string): boolean {
  return strategyId === "signals" || strategyId === "flip-flat";
}

export function strategyRulesPath(strategyId: string): string {
  return `/api/v1/strategies/${encodeURIComponent(strategyRulesId(strategyId))}/rules`;
}

export async function fetchStrategyRules(
  cfg: { baseUrl: string },
  strategyId: string,
  key: string,
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
): Promise<StrategyRulesDocument> {
  const path = strategyRulesPath(strategyId);
  const url = new URL(path, cfg.baseUrl);
  const res = await boundFetch(fetchImpl)(url.toString(), {
    headers: { "x-quotient-api-key": key, accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new QuotientApiError(res.status, path, detail.slice(0, 300));
  }
  return StrategyRulesDocumentSchema.parse(await res.json());
}

/** Read-only credential preflight: the key must be scoped for this strategy. */
export async function checkStrategyKeyAccess(
  cfg: { baseUrl: string },
  strategyId: string,
  key: string,
  fetchImpl?: typeof fetch,
): Promise<{ version: number; updatedAt: string }> {
  const document = await fetchStrategyRules(cfg, strategyId, key, fetchImpl);
  return { version: document.version, updatedAt: document.updatedAt };
}

export interface StrategyRulesClientOptions {
  baseUrl: string;
  strategyId: string;
  key: string;
  /** Persists the last good document across restarts. */
  state?: Pick<StateStore, "get" | "set">;
  /** Re-fetch cadence; one hour by default. */
  refreshMs?: number;
  log?: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  retry?: RetryOptions;
}

export const DEFAULT_RULES_REFRESH_MS = 60 * 60 * 1_000;

export function strategyRulesStateKey(strategyId: string): string {
  return `strategy-rules:${strategyRulesId(strategyId)}`;
}

/**
 * Cached, persisted rules for one strategy. `current()` returns the fresh
 * document when the gateway answers, otherwise the last good document, and
 * only `undefined` when nothing has ever been fetched.
 */
export class StrategyRulesClient implements StrategyRulesSource {
  readonly #opts: StrategyRulesClientOptions;
  readonly #refreshMs: number;
  readonly #now: () => number;
  #cached?: { document: StrategyRulesDocument; fetchedAt: number };
  #loadedPersisted = false;
  #refreshing?: Promise<StrategyRulesDocument | undefined>;
  #lastFailureLoggedVersion?: number;

  constructor(opts: StrategyRulesClientOptions) {
    this.#opts = opts;
    this.#refreshMs = opts.refreshMs ?? DEFAULT_RULES_REFRESH_MS;
    this.#now = opts.now ?? Date.now;
  }

  /** Version of the document in use, for status output. */
  version(): number | undefined {
    return this.#cached?.document.version;
  }

  async current(): Promise<StrategyRulesDocument | undefined> {
    await this.#loadPersisted();
    if (this.#cached && this.#now() - this.#cached.fetchedAt < this.#refreshMs) return this.#cached.document;
    if (this.#refreshing) return this.#refreshing;
    const refresh = this.#refresh();
    this.#refreshing = refresh;
    try {
      return await refresh;
    } finally {
      if (this.#refreshing === refresh) this.#refreshing = undefined;
    }
  }

  /** Fetch now, throwing on failure. Used as a startup precondition. */
  async require(): Promise<StrategyRulesDocument> {
    await this.#loadPersisted();
    const document = await this.#fetch();
    await this.#remember(document);
    return document;
  }

  async #refresh(): Promise<StrategyRulesDocument | undefined> {
    try {
      const document = await this.#fetch();
      await this.#remember(document);
      return document;
    } catch (error) {
      const fallback = this.#cached?.document;
      const message = error instanceof Error ? error.message : String(error);
      if (fallback) {
        if (this.#lastFailureLoggedVersion !== fallback.version) {
          this.#opts.log?.warn(`strategy rules refresh failed; continuing on version ${fallback.version}: ${message}`);
          this.#lastFailureLoggedVersion = fallback.version;
        }
        // Push the next attempt out so a dead gateway is not hammered every tick.
        this.#cached = { document: fallback, fetchedAt: this.#now() - this.#refreshMs + Math.min(this.#refreshMs, 5 * 60_000) };
        return fallback;
      }
      this.#opts.log?.error(`strategy rules unavailable and none persisted: ${message}`);
      return undefined;
    }
  }

  async #fetch(): Promise<StrategyRulesDocument> {
    return withQuotientRetries(
      () => fetchStrategyRules({ baseUrl: this.#opts.baseUrl }, this.#opts.strategyId, this.#opts.key, this.#opts.fetchImpl),
      {
        ...this.#opts.retry,
        onRetry: (attempt, error) => {
          this.#opts.log?.warn(`strategy rules fetch attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
          this.#opts.retry?.onRetry?.(attempt, error);
        },
      },
    );
  }

  async #remember(document: StrategyRulesDocument): Promise<void> {
    const previous = this.#cached?.document.version;
    this.#cached = { document, fetchedAt: this.#now() };
    this.#lastFailureLoggedVersion = undefined;
    if (previous !== undefined && previous !== document.version) {
      this.#opts.log?.info(`strategy rules updated: version ${previous} → ${document.version}`);
    }
    await this.#opts.state?.set(strategyRulesStateKey(this.#opts.strategyId), JSON.stringify(document));
  }

  async #loadPersisted(): Promise<void> {
    if (this.#loadedPersisted) return;
    this.#loadedPersisted = true;
    if (this.#cached || !this.#opts.state) return;
    const raw = await this.#opts.state.get(strategyRulesStateKey(this.#opts.strategyId));
    if (!raw) return;
    const parsed = StrategyRulesDocumentSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    // Persisted documents are always due for a refresh on the next read.
    this.#cached = { document: parsed.data, fetchedAt: this.#now() - this.#refreshMs };
  }
}

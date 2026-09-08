// packages/core/src/quotient/retry.ts
// Bounded retry for Quotient gateway reads. A transient failure (network,
// 5xx, 429) is retried a fixed number of times with short backoff; an
// authorization failure is not, so a revoked or out-of-scope key surfaces on
// the first attempt instead of being masked as an outage.

/** A non-2xx gateway response, carrying the status so callers can classify it. */
export class QuotientApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, detail?: string) {
    super(`quotient ${path} → ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "QuotientApiError";
    this.status = status;
    this.path = path;
  }

  /** 401/403: the key is invalid, revoked, or not scoped for this route. */
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface RetryOptions {
  /** Total attempts including the first. */
  attempts?: number;
  /** Delay before each retry, in milliseconds; the last value repeats. */
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
}

export const QUOTIENT_RETRY_ATTEMPTS = 3;
const DEFAULT_DELAYS_MS = [1_000, 2_000, 4_000];

/** True for errors that a later attempt could plausibly succeed on. */
export function isRetryableQuotientError(error: unknown): boolean {
  if (error instanceof QuotientApiError) {
    if (error.unauthorized) return false;
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  // Network, DNS, timeout, aborted, malformed JSON: retry.
  return true;
}

/**
 * Run `fn` up to `attempts` times. Stops early on a non-retryable error.
 * Rejects with the last error once attempts are exhausted.
 */
export async function withQuotientRetries<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? QUOTIENT_RETRY_ATTEMPTS);
  const delays = options.delaysMs ?? DEFAULT_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryableQuotientError(error)) throw error;
      options.onRetry?.(attempt, error);
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0);
    }
  }
  throw lastError;
}

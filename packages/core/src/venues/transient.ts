// packages/core/src/venues/transient.ts
// Venue-agnostic classification of transient failures. A transient failure defers
// work and is retried; it never cancels orders or latches a halt by itself.

const TRANSIENT_NAMES = new Set([
  "RateLimitError", "TimeoutError", "TransportError", "ConnectionLostError", "AbortError",
  "VenueCooldownError", "HyperliquidInfoDeferredError",
]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);
// Union of the wire-level patterns the market-make controllers relied on, plus the
// executor's own rpc deadline wording ("<label> exceeded four seconds").
const TRANSIENT_MESSAGE =
  /\b429\b|\b5\d\d\b|rate.?limit|too many requests|timeout|timed out|fetch failed|ECONN|ENET|EAI_AGAIN|socket|network|bad gateway|service unavailable|gateway time-?out|internal server error|heartbeat exceeded|exceeded (?:four|\d+(?:\.\d+)?) seconds/i;
const MAX_CAUSE_DEPTH = 5;

interface ErrorShape {
  name?: unknown;
  status?: unknown;
  code?: unknown;
  retryAfter?: unknown;
  retryAfterMs?: unknown;
  retryable?: unknown;
  cause?: unknown;
  message?: unknown;
}

function shape(error: unknown): ErrorShape | undefined {
  return typeof error === "object" && error !== null ? (error as ErrorShape) : undefined;
}

/** True when a venue call failed for a reason that a later retry can reasonably clear. */
export function isTransientVenueError(error: unknown, depth = 0): boolean {
  const row = shape(error);
  if (row && depth <= MAX_CAUSE_DEPTH) {
    const status = Number(row.status);
    if (Number.isFinite(status) && status >= 400) {
      if (status === 408 || status === 429 || status >= 500) return true;
      // A definitive 4xx is only retryable when the venue itself asked for a retry.
      if (row.retryAfter === undefined && row.retryAfterMs === undefined) return false;
      return true;
    }
    if (row.retryable === true) return true;
    if (row.retryAfter !== undefined || row.retryAfterMs !== undefined) return true;
    if (TRANSIENT_NAMES.has(String(row.name))) return true;
    if (typeof row.code === "string" && TRANSIENT_CODES.has(row.code)) return true;
    if (row.cause !== undefined && row.cause !== error && isTransientVenueError(row.cause, depth + 1)) return true;
  }
  const message = error instanceof Error ? error.message : typeof row?.message === "string" ? row.message : String(error);
  return TRANSIENT_MESSAGE.test(message);
}

/** True when the venue explicitly rejected the call for exceeding a rate limit. */
export function isRateLimitError(error: unknown, depth = 0): boolean {
  const row = shape(error);
  if (!row || depth > MAX_CAUSE_DEPTH) return false;
  if (Number(row.status) === 429 || row.name === "RateLimitError") return true;
  return row.cause !== undefined && row.cause !== error && isRateLimitError(row.cause, depth + 1);
}

/** Venue-requested retry delay in milliseconds, when the failure carried one. */
export function retryAfterMs(error: unknown, depth = 0): number | undefined {
  const row = shape(error);
  if (!row || depth > MAX_CAUSE_DEPTH) return undefined;
  const direct = Number(row.retryAfterMs);
  if (Number.isFinite(direct) && direct > 0) return direct;
  // The pinned Polymarket SDK exposes retryAfter in seconds.
  const seconds = Number(row.retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000;
  return row.cause !== undefined && row.cause !== error ? retryAfterMs(row.cause, depth + 1) : undefined;
}

/** Raised locally when a request family is on cooldown or its window is exhausted. */
export class VenueRateLimitedError extends Error {
  readonly status = 429;
  /** Seconds, mirroring the SDK's own rate-limit error shape. */
  readonly retryAfter: number;
  constructor(readonly family: string, readonly retryAfterMs: number, message?: string) {
    super(message ?? `${family} requests are rate limited locally; retry after ${Math.ceil(Math.max(0, retryAfterMs) / 1_000)}s`);
    this.name = "RateLimitError";
    this.retryAfter = Math.ceil(Math.max(0, retryAfterMs) / 1_000);
  }
}

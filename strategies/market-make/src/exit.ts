// strategies/market-make/src/exit.ts
// Forecast/convergence/time exit policy and bounded passive-to-FAK terms.

import type { MarketMakeConfig } from "./schema.js";
import { bestAsk, bestBid, bookMid, freeSellQuantity } from "./math.js";
import type { ExitDecision, ExitUrgency, InventoryCycle, NormalizedSignal, TokenBook } from "./types.js";

const EPSILON = 1e-9;

export function qProbabilityForOutcome(qYes: number, outcome: "YES" | "NO"): number {
  return outcome === "YES" ? qYes : 1 - qYes;
}

export interface ExitEvaluationInput {
  inventory: InventoryCycle;
  signal: NormalizedSignal;
  selectedBook: TokenBook;
  now: number;
}

function result(urgency: ExitUrgency, reason: string | undefined, cancelAdds: boolean, remainingEdgePp: number, capturedFraction: number): ExitDecision {
  return { urgency, reason, cancelAdds, remainingEdgePp, capturedFraction };
}

export function evaluateExit(input: ExitEvaluationInput, config: MarketMakeConfig): ExitDecision {
  const { inventory, signal, selectedBook, now } = input;
  const mid = bookMid(selectedBook);
  if (mid === undefined) return result("none", "selected book unavailable", true, Number.NaN, Number.NaN);
  const qSide = qProbabilityForOutcome(signal.qYes, inventory.outcome);
  const remainingEdgePp = 100 * (qSide - mid);
  const capturedFraction = inventory.initialEdgePp > 0 ? (inventory.initialEdgePp - remainingEdgePp) / inventory.initialEdgePp : Number.NaN;
  const heldMs = now - inventory.firstFillAt;
  const absoluteMs = config.exit_policy.absolute_max_hold_seconds * 1_000;
  const hardMs = config.exit_policy.default_hard_hold_seconds * 1_000;
  const extensionMs = config.exit_policy.maximum_extension_seconds * 1_000;
  const renewalThreshold = config.cassie_overrides.renewal_min_edge_pp[inventory.outcome];
  const newerQ = signal.qAsOf > inventory.anchorQAsOf;
  const qStillFavorsHeldSide = remainingEdgePp >= 0;
  const qualifyingRenewal = newerQ && qStillFavorsHeldSide && remainingEdgePp + EPSILON >= renewalThreshold;

  if (heldMs + EPSILON >= absoluteMs) return result("urgent", "absolute 36h hold ceiling", true, remainingEdgePp, capturedFraction);
  if (signal.retiredReason === "flipped" || signal.retiredReason === "fading_q") {
    return result("urgent", `Q ${signal.retiredReason}`, true, remainingEdgePp, capturedFraction);
  }
  if (!qStillFavorsHeldSide) return result("urgent", "Q no longer favors held outcome", true, remainingEdgePp, capturedFraction);
  if (signal.forecastStatus === "warning") return result("urgent", "Q forecast warning", true, remainingEdgePp, capturedFraction);
  if (signal.forecastStatus === "converged") return result("normal", "Q forecast converged", true, remainingEdgePp, capturedFraction);
  if (remainingEdgePp <= config.exit_policy.remaining_live_q_edge_exit_pp + EPSILON) {
    return result("normal", "remaining Q edge converged", true, remainingEdgePp, capturedFraction);
  }
  if (capturedFraction + EPSILON >= config.exit_policy.captured_initial_gap_fraction_exit) {
    return result("normal", "captured 75% of first-fill gap", true, remainingEdgePp, capturedFraction);
  }
  if (now - signal.qAsOf + EPSILON >= config.quotient_feed.stale_forecast_exit_seconds * 1_000) {
    return result("normal", "Q forecast stale", true, remainingEdgePp, capturedFraction);
  }
  if (newerQ && remainingEdgePp + EPSILON < config.direction_policy[inventory.outcome].minimum_edge_pp) {
    return result("normal", "new Q edge below direction minimum", true, remainingEdgePp, capturedFraction);
  }
  if (signal.forecastStatus === "caution") return result("normal", "Q forecast caution", true, remainingEdgePp, capturedFraction);
  if (signal.retiredReason === "expired" && !qualifyingRenewal) {
    return result("normal", "published signal expired without qualifying renewal", true, remainingEdgePp, capturedFraction);
  }
  if (heldMs + EPSILON >= hardMs) {
    if (inventory.renewalUsed) {
      if (inventory.extensionUntil !== undefined && now + EPSILON < inventory.extensionUntil) {
        return result("none", "single Q renewal active", true, remainingEdgePp, capturedFraction);
      }
      return result("normal", "single Q renewal expired", true, remainingEdgePp, capturedFraction);
    }
    if (config.exit_policy.forecast_refresh_can_extend_once && qualifyingRenewal) {
      return {
        ...result("none", "newer same-side Q authorized one extension", true, remainingEdgePp, capturedFraction),
        renewal: { extensionUntil: Math.min(inventory.firstFillAt + absoluteMs, inventory.firstFillAt + hardMs + extensionMs), qAsOf: signal.qAsOf },
      };
    }
    return result("normal", "24h hold ceiling", true, remainingEdgePp, capturedFraction);
  }
  if (signal.forecastStatus === "diverging") return result("none", "Q forecast diverging", true, remainingEdgePp, capturedFraction);
  // Six hours is deliberately absent: it is a review/telemetry boundary only.
  return result("none", undefined, false, remainingEdgePp, capturedFraction);
}

export interface ExitOrderTerms {
  size: number;
  limitPrice: number;
  tif: "GTC" | "FAK";
  postOnly: boolean;
}

export function buildExitOrderTerms(
  urgency: Exclude<ExitUrgency, "none">,
  inventory: InventoryCycle,
  book: TokenBook,
  now: number,
  tickSize: number,
  config: MarketMakeConfig,
): ExitOrderTerms | null {
  const size = freeSellQuantity(inventory.freeQuantity, inventory.reservedSellQuantity);
  const bid = bestBid(book);
  const ask = bestAsk(book);
  if (!(size > 0) || bid === undefined || ask === undefined || bid >= ask) return null;
  const exitAgeMs = inventory.exitStartedAt === undefined ? 0 : now - inventory.exitStartedAt;
  const passiveForMs = urgency === "urgent" ? 60_000 : config.exit_policy.normal_exit_max_rest_seconds * 1_000;
  if (exitAgeMs < passiveForMs) {
    const inside = ask - bid + EPSILON >= 2 * tickSize ? ask - tickSize : ask;
    return { size, limitPrice: Math.max(bid + tickSize, inside), tif: "GTC", postOnly: true };
  }
  if (urgency === "urgent" && inventory.urgentAttempts >= config.exit_policy.urgent_exit_max_attempts) return null;
  const concessionPp = urgency === "urgent"
    ? config.exit_policy.urgent_exit_max_concession_pp
    : config.exit_policy.normal_exit_then_fak_max_concession_pp;
  return { size, limitPrice: Math.max(0.001, bid - concessionPp / 100), tif: "FAK", postOnly: false };
}

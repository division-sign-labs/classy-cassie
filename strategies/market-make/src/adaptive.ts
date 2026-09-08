// strategies/market-make/src/adaptive.ts
import { AdaptivePolicySchema, type AdaptiveForecast, type AdaptiveMovement, type AdaptiveQuoteContext, type AdaptiveInventoryControl } from "./adaptive-policy.js";
import { planTwoSidedQuotes, type TwoSidedPlan, type TwoSidedPlanInput, type TwoSidedQuote } from "./two-sided.js";
import type { TokenBook } from "./types.js";

export type { AdaptiveForecast, AdaptiveMovement } from "./adaptive-policy.js";

const EPSILON = 1e-9;
const validPrice = (price: number): boolean => Number.isFinite(price) && price > 0 && price < 1;
const floorTick = (price: number, tick: number): number => Number((Math.floor((price + EPSILON) / tick) * tick).toFixed(12));
const ceilTick = (price: number, tick: number): number => Number((Math.ceil((price - EPSILON) / tick) * tick).toFixed(12));

function bookView(book: TokenBook, tokenId: string, now: number, maxAge: number, skew: number): { bid: number; ask: number; mid: number } | undefined {
  if (book.tokenId !== tokenId || !Number.isFinite(book.ts) || !Number.isFinite(now)
    || book.ts > now + skew * 1_000 || now - book.ts > maxAge * 1_000) return undefined;
  const valid = (level: TokenBook["bids"][number]) => validPrice(level.price) && Number.isFinite(level.size) && level.size > 0;
  if (!book.bids.length || !book.asks.length || !book.bids.every(valid) || !book.asks.every(valid)) return undefined;
  const bid = Math.max(...book.bids.map((level) => level.price));
  const ask = Math.min(...book.asks.map((level) => level.price));
  return bid < ask - EPSILON ? { bid, ask, mid: (bid + ask) / 2 } : undefined;
}

/** A SELL is not necessarily a reduction: SELL NO can increase net YES exposure. */
function reductionQuantity(quote: TwoSidedQuote, input: TwoSidedPlanInput): number {
  if (quote.side !== "SELL") return 0;
  const excess = quote.outcome === "YES"
    ? input.inventory.yesQuantity - input.inventory.noQuantity
    : input.inventory.noQuantity - input.inventory.yesQuantity;
  return Math.max(0, Math.min(quote.size, excess));
}

/**
 * Q changes risk appetite and lane selection, not the venue midpoint or an invented
 * fill-value estimate. The controller supplies durable inventory evidence and
 * owns reservations, size normalization, reconciliation and post-only submission.
 * Q-supported surplus follows its thesis clock and convergence rules. Forced
 * reductions offer only unpaired excess; both complete-set SELLs may not fill.
 */
export function planAdaptiveQuotes(input: TwoSidedPlanInput, forecast: AdaptiveForecast | undefined, movement?: AdaptiveMovement, inventoryControl?: AdaptiveInventoryControl): TwoSidedPlan {
  if (input.policy.adaptive === undefined) return planTwoSidedQuotes(input);
  const parsed = AdaptivePolicySchema.safeParse(input.policy.adaptive);
  // Fail closed even for unvalidated callers; a malformed opt-in cannot silently
  // become the non-adaptive strategy. Valid venue-based reductions remain usable.
  const policy = parsed.success ? parsed.data : AdaptivePolicySchema.parse({});
  const yes = bookView(input.yesBook, input.market.yesTokenId, input.now, policy.book_max_age_seconds, policy.clock_skew_seconds);
  const no = bookView(input.noBook, input.market.noTokenId, input.now, policy.book_max_age_seconds, policy.clock_skew_seconds);
  const cleaned: TwoSidedPlanInput = {
    ...input,
    yesBook: yes ? input.yesBook : { tokenId: input.market.yesTokenId, bids: [], asks: [], ts: input.now },
    noBook: no ? input.noBook : { tokenId: input.market.noTokenId, bids: [], asks: [], ts: input.now },
  };
  const base = planTwoSidedQuotes(cleaned);
  const diagnostic: AdaptiveQuoteContext = {
    regime: "reduce-only", quoteBufferTicks: 0, sizeMultiplier: 0, reason: "adaptive-forecast-missing",
  };
  const finish = (quotes: TwoSidedQuote[], eligible: boolean, reason: string): TwoSidedPlan => ({
    ...base, quotes, eligible,
    reasons: [...base.reasons, reason],
    context: { ...base.context, adaptive: { ...diagnostic, reason, targetShareQuantity: quotes.length ? Math.max(...quotes.map((quote) => quote.size)) : 0 } },
  });
  const reduce = (reason: string): TwoSidedPlan => {
    diagnostic.regime = "reduce-only";
    diagnostic.quoteBufferTicks = 0;
    diagnostic.sizeMultiplier = 0;
    if (Math.abs(input.inventory.yesQuantity - input.inventory.noQuantity) > EPSILON) {
      diagnostic.inventoryAction = "exit";
      diagnostic.inventoryReason = reason;
    }
    return finish(base.quotes.flatMap((quote) => {
      const size = reductionQuantity(quote, input);
      const view = quote.outcome === "YES" ? yes : no;
      return view && size + EPSILON >= input.market.minOrderSize
        ? [{ ...quote, size, reason: `${reason}: reduce unpaired ${quote.outcome}` }] : [];
    }), false, reason);
  };

  if (inventoryControl?.forceReduceReason) return reduce(inventoryControl.forceReduceReason);
  const excess = input.inventory.yesQuantity - input.inventory.noQuantity;
  if (inventoryControl && Math.abs(excess) > EPSILON) {
    if (!Number.isFinite(inventoryControl.firstHeldAt) || inventoryControl.firstHeldAt! > input.now
      || (inventoryControl.initialEdgePp !== undefined && !Number.isFinite(inventoryControl.initialEdgePp))
      || ![inventoryControl.maximumHoldSeconds, inventoryControl.minimumHoldEdgePp, inventoryControl.remainingEdgeExitPp, inventoryControl.capturedGapFraction].every(Number.isFinite)
      || inventoryControl.maximumHoldSeconds <= 0 || inventoryControl.minimumHoldEdgePp < 0 || inventoryControl.remainingEdgeExitPp < 0
      || inventoryControl.capturedGapFraction <= 0 || inventoryControl.capturedGapFraction > 1) return reduce("adaptive-inventory-policy-invalid");
    diagnostic.holdDeadlineAt = inventoryControl.firstHeldAt! + inventoryControl.maximumHoldSeconds * 1_000;
    if (input.now >= diagnostic.holdDeadlineAt) return reduce("adaptive-inventory-hold-ceiling");
  }

  if (!parsed.success) return reduce("adaptive-policy-invalid");
  if (!Number.isFinite(input.now)) return reduce("adaptive-clock-invalid");
  if (!forecast) return reduce("adaptive-forecast-missing");
  if (forecast.marketKey !== input.market.marketKey) return reduce("adaptive-forecast-identity-mismatch");
  if (!Number.isFinite(forecast.qYes) || forecast.qYes < 0 || forecast.qYes > 1 || !Number.isFinite(forecast.forecastAt)) {
    return reduce("adaptive-forecast-invalid");
  }
  const rawAge = (input.now - forecast.forecastAt) / 1_000;
  diagnostic.forecastAgeSeconds = Math.max(0, rawAge);
  if (rawAge < -policy.clock_skew_seconds) return reduce("adaptive-forecast-from-future");
  if (rawAge > policy.forecast_max_age_seconds) return reduce("adaptive-forecast-stale");
  const status = forecast.forecastStatus?.toLowerCase();
  if (forecast.drawdownRiskElevated === true || status === "warning") return reduce("adaptive-forecast-warning");
  if (status !== undefined && !["converged", "converging", "sideways", "diverging", "caution"].includes(status)) {
    return reduce("adaptive-forecast-status-unknown");
  }
  if (!yes || !no) return reduce("adaptive-books-stale-or-invalid");
  if (Math.abs(yes.mid + no.mid - 1) * 100 > policy.maximum_complement_deviation_pp + EPSILON) {
    return reduce("adaptive-complement-inconsistent");
  }
  const gapPp = (forecast.qYes - yes.mid) * 100;
  const magnitude = Math.abs(gapPp);
  diagnostic.gapPp = gapPp;
  const aged = rawAge > policy.forecast_full_weight_seconds;
  const caution = status === "caution" || status === "diverging";
  const defensive = magnitude + EPSILON >= policy.defensive_gap_pp || aged || caution;
  const buffer = defensive
    ? Math.min(policy.maximum_quote_buffer_ticks, Math.max(1, Math.ceil((magnitude - policy.defensive_gap_pp) / policy.gap_buffer_pp_per_tick))) : 0;
  const ageWeight = aged ? Math.max(policy.minimum_size_multiplier,
    (policy.forecast_max_age_seconds - rawAge) / Math.max(1, policy.forecast_max_age_seconds - policy.forecast_full_weight_seconds)) : 1;
  const sizeMultiplier = Math.min(1, ageWeight, caution ? Math.max(policy.minimum_size_multiplier, 0.5) : 1,
    defensive ? Math.max(policy.minimum_size_multiplier, 1 - policy.size_reduction_per_10pp * magnitude / 10) : 1);
  const currentMovement = movement && [movement.observedAt, movement.referenceAt, movement.referenceYesMid, movement.yesMid].every(Number.isFinite)
    && validPrice(movement.referenceYesMid) && validPrice(movement.yesMid)
    && movement.observedAt <= input.now + policy.clock_skew_seconds * 1_000
    && input.now - movement.observedAt <= policy.book_max_age_seconds * 1_000
    && movement.observedAt - movement.referenceAt >= policy.movement_minimum_seconds * 1_000
    && input.now - movement.referenceAt <= policy.movement_window_seconds * 1_000
    && Math.abs(movement.yesMid - yes.mid) <= input.market.tickSize / 2 + EPSILON;
  const movingTowardQ = Boolean(currentMovement && movement
    && (movement.yesMid - movement.referenceYesMid) * gapPp > 0
    && Math.abs(movement.yesMid - movement.referenceYesMid) + EPSILON >= policy.movement_minimum_ticks * input.market.tickSize
    && Math.abs(forecast.qYes - movement.yesMid) < Math.abs(forecast.qYes - movement.referenceYesMid));
  const directional = !aged && !caution && magnitude + EPSILON >= policy.directional_minimum_gap_pp
    && magnitude <= policy.directional_maximum_gap_pp + EPSILON && movingTowardQ;
  diagnostic.regime = directional ? "directional" : defensive ? "defensive" : "balanced";
  diagnostic.quoteBufferTicks = directional ? 0 : buffer;
  diagnostic.sizeMultiplier = directional ? 1 : sizeMultiplier;
  const favoredLane = gapPp > 0 ? "bid" : "ask";
  if (directional) diagnostic.favoredOutcome = gapPp > 0 ? "YES" : "NO";
  const reason = directional ? "adaptive-confirmed-directional-lane"
    : aged ? "adaptive-forecast-aging" : caution ? "adaptive-forecast-caution"
      : defensive ? "adaptive-gap-defensive" : "adaptive-balanced";
  const tick = input.market.tickSize;
  let protectedOutcome: "YES" | "NO" | undefined;
  if (inventoryControl && Math.abs(excess) > EPSILON) {
    const outcome = excess > 0 ? "YES" : "NO";
    const heldView = outcome === "YES" ? yes : no;
    const qHeld = outcome === "YES" ? forecast.qYes : 1 - forecast.qYes;
    const remainingEdge = (qHeld - heldView.bid) * 100;
    diagnostic.remainingEdgePp = remainingEdge;
    const qBacked = inventoryControl.qBacked === true
      || (inventoryControl.initialEdgePp ?? 0) + EPSILON >= inventoryControl.minimumHoldEdgePp
      || remainingEdge + EPSILON >= inventoryControl.minimumHoldEdgePp;
    if (qBacked) {
      if (remainingEdge < 0) return reduce("adaptive-inventory-q-invalidated");
      if (remainingEdge <= inventoryControl.remainingEdgeExitPp + EPSILON) return reduce("adaptive-inventory-converged");
      if (inventoryControl.initialEdgePp !== undefined && inventoryControl.initialEdgePp > 0
        && 1 - remainingEdge / inventoryControl.initialEdgePp + EPSILON >= inventoryControl.capturedGapFraction) {
        return reduce("adaptive-inventory-gap-captured");
      }
      protectedOutcome = outcome;
      diagnostic.inventoryAction = "hold";
      diagnostic.inventoryReason = "adaptive-inventory-q-supported";
    }
  }
  const quotes = base.quotes.flatMap((quote) => {
    if (directional && quote.lane !== favoredLane) return [];
    // Do not sell or hedge away Q-supported surplus just to recycle inventory.
    // The paired portion may still be sold through ordinary maker quotes.
    let available = quote.size;
    if (protectedOutcome && quote.lane === (protectedOutcome === "YES" ? "ask" : "bid")) {
      if (quote.side !== "SELL") return [];
      available = Math.min(available, input.inventory.yesQuantity, input.inventory.noQuantity);
    }
    // Withholding the unfavorable lane is the directional tilt. Do not also
    // retreat the favored lane or make a net-reducing exit less competitive.
    const netReducing = reductionQuantity(quote, input) + EPSILON >= quote.size;
    const quoteBuffer = directional || netReducing ? 0 : buffer;
    const quoteSizeMultiplier = directional || netReducing ? 1 : sizeMultiplier;
    const limitPrice = quote.side === "BUY"
      ? floorTick(quote.limitPrice - quoteBuffer * tick, tick)
      : ceilTick(quote.limitPrice + quoteBuffer * tick, tick);
    const size = Math.min(available * quoteSizeMultiplier, Math.min(input.baseOrderUsd, input.maxOrderUsd) / limitPrice);
    const view = quote.outcome === "YES" ? yes : no;
    if (!validPrice(limitPrice) || !Number.isFinite(size) || size + EPSILON < input.market.minOrderSize
      || (quote.side === "BUY" ? limitPrice >= view.ask - EPSILON : limitPrice <= view.bid + EPSILON)) return [];
    return [{ ...quote, size, limitPrice, reason: `${reason}: ${quote.lane} ${quote.side} ${quote.outcome}` }];
  });
  return finish(quotes, base.eligible && quotes.length > 0, reason);
}

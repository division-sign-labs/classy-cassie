// strategies/quotient-swing/src/math.ts
// Arithmetic has no clocks, I/O, fitted win probabilities, or account credentials.
import type { SwingSide } from "./types.js";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const signOf = (side: SwingSide): 1 | -1 => side === "LONG" ? 1 : -1;
export const finitePositive = (n: number): boolean => Number.isFinite(n) && n > 0;
export const clamp = (x: number, low: number, high: number): number => Math.max(low, Math.min(high, x));

/** Adverse funding over the remaining hold from the current rate; favorable funding is never credited. */
export function fundingReserve(fundingHourly: number, side: SwingSide, hours: number, multiple: number): number {
  if (!Number.isFinite(fundingHourly)) return 0;
  return Math.max(0, signOf(side) * fundingHourly) * Math.max(0, hours) * multiple;
}

/** Stop level a fixed multiple of the outlook's horizon uncertainty away, scaled to the remaining horizon. */
export function sigmaStop(entryPrice: number, side: SwingSide, sigmaTotal: number, remainingHours: number, horizonHours: number, multiple: number): number {
  const scale = horizonHours > 0 ? Math.sqrt(clamp(remainingHours / horizonHours, 0, 1)) : 1;
  return entryPrice * Math.exp(-signOf(side) * multiple * sigmaTotal * scale);
}

export function liquidationDistance(side: SwingSide, leverage: number, maintenanceRate: number): number {
  if (!finitePositive(leverage) || maintenanceRate < 0 || maintenanceRate >= 1) return 0;
  return Math.max(0, (1 / leverage - maintenanceRate) / (1 - signOf(side) * maintenanceRate));
}

export function floorSize(size: number, decimals: number): number {
  return Math.floor((size + 1e-12) * 10 ** decimals) / 10 ** decimals;
}

export function quotePrice(price: number, tick: number, side: SwingSide, passive: boolean): number {
  const up = passive ? side === "SHORT" : side === "LONG";
  return (up ? Math.ceil(price / tick - 1e-10) : Math.floor(price / tick + 1e-10)) * tick;
}

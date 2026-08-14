// packages/runtime-cf/src/tick-schedule.ts
// Pure cadence helpers shared by the durable tick scheduler and its tests.

export function tickIntervalSeconds(configJson: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    throw new Error("runtime bot config is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("runtime bot config must be an object");
  }
  const minutes = (parsed as Record<string, unknown>).tickIntervalMin;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("runtime bot config requires a positive tickIntervalMin");
  }
  return Math.max(1, Math.round(minutes * 60));
}

export function nextTickAtMs(now: number, intervalSeconds: number): number {
  const intervalMs = intervalSeconds * 1_000;
  return (Math.floor(now / intervalMs) + 1) * intervalMs;
}

export function tickIdAt(now: number, intervalSeconds: number): number {
  return Math.floor(now / (intervalSeconds * 1_000));
}

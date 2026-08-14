// packages/core/src/logging.ts
// Minimal structured logger. Console-backed; runtimes may wrap it.

import type { Logger, LogLevel } from "./types.js";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function consoleLogger(prefix: string, minLevel: LogLevel = "info"): Logger {
  const min = LEVELS[minLevel];
  const emit = (level: LogLevel, msg: string, data?: unknown) => {
    if (LEVELS[level] < min) return;
    const line = `[${new Date().toISOString()}] [${prefix}] ${level.toUpperCase()} ${msg}`;
    const args: unknown[] = data === undefined ? [line] : [line, JSON.stringify(data)];
    if (level === "error") console.error(...args);
    else if (level === "warn") console.warn(...args);
    else console.log(...args);
  };
  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

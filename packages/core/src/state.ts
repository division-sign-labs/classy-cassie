// packages/core/src/state.ts
// In-memory StateStore (tests, dry runs) plus typed key helpers shared by all
// StateStore implementations.

import type { ErrorRecord, LogQuery, StateStore } from "./types.js";

export class MemoryStateStore implements StateStore {
  private kv = new Map<string, string>();
  private errors: ErrorRecord[] = [];

  async get(key: string): Promise<string | null> {
    return this.kv.has(key) ? this.kv.get(key)! : null;
  }
  async set(key: string, value: string): Promise<void> {
    this.kv.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.kv.delete(key);
  }
  async appendError(rec: ErrorRecord): Promise<void> {
    this.errors.push(rec);
  }
  async readErrors(q?: LogQuery): Promise<ErrorRecord[]> {
    let out = this.errors;
    if (q?.level) out = out.filter((e) => e.level === q.level);
    if (q?.tail) out = out.slice(-q.tail);
    return out;
  }
}

// Well-known state keys, so runtimes and the engine agree.
export const StateKeys = {
  tickSeq: "engine:tick-seq",
  tickLock: "engine:tick-lock",
  lastFillTs: "engine:last-fill-ts",
  triggers: "engine:triggers",
  alertFingerprints: "alerts:fingerprints",
  strategyMemory: (k: string) => `strategy:${k}`,
  paused: "engine:paused",
} as const;

export async function getJson<T>(store: StateStore, key: string): Promise<T | undefined> {
  const raw = await store.get(key);
  if (raw === null) return undefined;
  return JSON.parse(raw) as T;
}

export async function setJson(store: StateStore, key: string, value: unknown): Promise<void> {
  await store.set(key, JSON.stringify(value));
}

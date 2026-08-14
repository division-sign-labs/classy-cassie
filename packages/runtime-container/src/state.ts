// packages/runtime-container/src/state.ts
// StateStore client for the container process. Requests to the virtual hostname
// are intercepted beside the container and resolved against its Durable Object's
// persistent SQLite; no public endpoint or database credential is involved.

import type { ErrorRecord, LogQuery, StateStore } from "@quotient-forecasting/cassie-core";

type StateOperation =
  | { op: "get"; key: string }
  | { op: "set"; key: string; value: string }
  | { op: "delete"; key: string }
  | { op: "append-error"; record: ErrorRecord }
  | { op: "read-errors"; query?: LogQuery };

export class DurableObjectStateStore implements StateStore {
  constructor(private readonly endpoint = "http://cassie.state/") {}

  private async call<T>(operation: StateOperation): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(operation),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`container state ${response.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  async get(key: string): Promise<string | null> {
    return (await this.call<{ value: string | null }>({ op: "get", key })).value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.call({ op: "set", key, value });
  }

  async delete(key: string): Promise<void> {
    await this.call({ op: "delete", key });
  }

  async appendError(record: ErrorRecord): Promise<void> {
    await this.call({ op: "append-error", record });
  }

  async readErrors(query?: LogQuery): Promise<ErrorRecord[]> {
    return (await this.call<{ errors: ErrorRecord[] }>({ op: "read-errors", query })).errors;
  }
}

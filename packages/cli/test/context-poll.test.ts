// packages/cli/test/context-poll.test.ts

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSetupContext } from "../src/context.js";

const stdinDescriptors = {
  isTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
  isRaw: Object.getOwnPropertyDescriptor(process.stdin, "isRaw"),
  setRawMode: Object.getOwnPropertyDescriptor(process.stdin, "setRawMode"),
};

function restoreStdinProperty(name: keyof typeof stdinDescriptors): void {
  const descriptor = stdinDescriptors[name];
  if (descriptor) Object.defineProperty(process.stdin, name, descriptor);
  else delete (process.stdin as unknown as Record<string, unknown>)[name];
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreStdinProperty("isTTY");
  restoreStdinProperty("isRaw");
  restoreStdinProperty("setRawMode");
});

describe("SetupContext.pollSkippable", () => {
  it("returns a credit immediately without enabling raw input on a headless host", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const check = vi.fn(async () => 500.15);

    const result = await makeSetupContext("bot-1").pollSkippable!("waiting for bridge credit", check, {
      intervalMs: 15_000,
    });

    expect(result).toBe(500.15);
    expect(check).toHaveBeenCalledOnce();
    expect(output.mock.calls.flat().join("")).toContain("Ctrl-C aborts; polling every 15s");
    expect(output.mock.calls.flat().join("")).not.toContain("press s to skip");
  });

  it("returns null promptly on s and restores the terminal state", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "isRaw", { configurable: true, value: false });
    const setRawMode = vi.fn();
    Object.defineProperty(process.stdin, "setRawMode", { configurable: true, value: setRawMode });
    vi.spyOn(process.stdin, "isPaused").mockReturnValue(true);
    vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    const pause = vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const initialDataListeners = process.stdin.listenerCount("data");

    const pending = makeSetupContext("bot-1").pollSkippable!(
      "waiting for bridge credit",
      async () => null,
      { intervalMs: 60_000 },
    );
    process.stdin.emit("data", Buffer.from("s"));

    await expect(pending).resolves.toBeNull();
    expect(setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(setRawMode).toHaveBeenLastCalledWith(false);
    expect(pause).toHaveBeenCalledOnce();
    expect(process.stdin.listenerCount("data")).toBe(initialDataListeners);
    expect(output.mock.calls.flat().join("")).toContain("press s to skip");
  });
});

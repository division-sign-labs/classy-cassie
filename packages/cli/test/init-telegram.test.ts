// packages/cli/test/init-telegram.test.ts
// The wizard's Telegram step: use .local.env values, defer to .local.env, or enter them now.

import { describe, expect, it, vi } from "vitest";
import { configureInitTelegram, type InitTelegramDependencies } from "../src/commands/init.js";

function dependencies(overrides: Partial<InitTelegramDependencies> & { choice?: string; answers?: string[] } = {}) {
  const messages: string[] = [];
  const answers = [...(overrides.answers ?? [])];
  const deps = {
    ask: vi.fn(async () => answers.shift() ?? ""),
    confirm: vi.fn(async () => true),
    select: vi.fn(async () => overrides.choice ?? "enter"),
    print: (message: string) => { messages.push(message); },
    send: vi.fn(async () => {}),
    saveToken: vi.fn(),
    ...(overrides.local ? { local: overrides.local } : {}),
  } as unknown as InitTelegramDependencies & { ask: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; saveToken: ReturnType<typeof vi.fn> };
  return { deps, messages };
}

describe("init telegram step", () => {
  it("offers the .local.env values when both are present and tests them without saving anything", async () => {
    const { deps, messages } = dependencies({ choice: "local", local: { token: "t", chatId: "c", tokenOrigin: "/x/.local.env (TELEGRAM_BOT_TOKEN)", chatIdOrigin: "/x/.local.env (TELEGRAM_USER_ID)" } });
    const result = await configureInitTelegram({ chatId: "old" }, deps);
    const options = (deps.select.mock.calls[0]![1] as Array<{ value: string }>).map(option => option.value);
    expect(options).toEqual(["local", "enter", "none"]);
    expect(deps.send).toHaveBeenCalledWith("t", "c");
    expect(deps.saveToken).not.toHaveBeenCalled();
    expect(deps.ask).not.toHaveBeenCalled();
    expect(result).toEqual({ chatId: "old" });
    expect(messages).toContain("Telegram test sent.");
    expect(messages.join("\n")).not.toContain("t\n");
  });

  it("lets the operator defer both values to .local.env with a one-line hint", async () => {
    const { deps, messages } = dependencies({ choice: "later" });
    const result = await configureInitTelegram(undefined, deps);
    const options = (deps.select.mock.calls[0]![1] as Array<{ value: string; title: string }>);
    expect(options.map(option => option.value)).toEqual(["enter", "later", "none"]);
    expect(options.find(option => option.value === "later")!.title).toMatch(/\.local\.env later/);
    expect(result).toBeUndefined();
    expect(deps.ask).not.toHaveBeenCalled();
    expect(messages).toEqual([expect.stringContaining("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from the nearest .local.env")]);
  });

  it("still takes a token and chat id typed in, tests them, and saves the token", async () => {
    const { deps, messages } = dependencies({ choice: "enter", answers: ["123:abc", "4242"] });
    const result = await configureInitTelegram(undefined, deps);
    expect(deps.send).toHaveBeenCalledWith("123:abc", "4242");
    expect(deps.saveToken).toHaveBeenCalledWith("123:abc");
    expect(result).toEqual({ chatId: "4242" });
    expect(messages).toContain("Telegram test sent.");
  });

  it("keeps the saved settings when the operator declines", async () => {
    const { deps } = dependencies({ choice: "none" });
    expect(await configureInitTelegram({ chatId: "old" }, deps)).toEqual({ chatId: "old" });
    expect(await configureInitTelegram(undefined, dependencies({ choice: "none" }).deps)).toBeUndefined();
  });

  it("reports a failed test of the .local.env values without aborting the wizard", async () => {
    const { deps, messages } = dependencies({ choice: "local", local: { token: "t", chatId: "c", tokenOrigin: "a", chatIdOrigin: "b" } });
    deps.send.mockRejectedValueOnce(new Error("Bad Request: chat not found"));
    const result = await configureInitTelegram(undefined, deps);
    expect(result).toBeUndefined();
    expect(messages.join("\n")).toMatch(/cannot reach that chat.*cassie alerts test/s);
  });
});

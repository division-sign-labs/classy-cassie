// packages/cli/test/telegram-settings.test.ts
// Telegram values come from the nearest .local.env first, then the environment,
// then the bot's keystore token and saved chat id; origins never include values.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const keystore = vi.hoisted(() => ({ getKeystoreSecret: vi.fn() }));
vi.mock("../src/context.js", () => ({ getKeystoreSecret: keystore.getKeystoreSecret }));

import { describeTelegramSettings, localTelegramSettings, resolveTelegramSettings } from "../src/telegram-settings.js";

const saved = { TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID, TELEGRAM_USER_ID: process.env.TELEGRAM_USER_ID };
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  keystore.getKeystoreSecret.mockReset();
});

function envDir(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cassie-telegram-"));
  writeFileSync(join(dir, ".local.env"), contents);
  return dir;
}

describe("telegram settings", () => {
  it("reads the token and either chat id name from the nearest .local.env", () => {
    const dir = envDir("TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_USER_ID=4242\n");
    const local = localTelegramSettings(dir);
    expect(local.token).toMatchObject({ value: "123:abc", source: "local-env", name: "TELEGRAM_BOT_TOKEN" });
    expect(local.chatId).toMatchObject({ value: "4242", source: "local-env", name: "TELEGRAM_USER_ID" });
    expect(local.chatId!.origin).not.toContain("4242");
    expect(localTelegramSettings(envDir("TELEGRAM_CHAT_ID=7\n")).chatId).toMatchObject({ value: "7", name: "TELEGRAM_CHAT_ID" });
  });

  it("falls back to the exported environment, then the keystore token and saved chat id", async () => {
    const empty = mkdtempSync(join(tmpdir(), "cassie-telegram-empty-"));
    delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID; delete process.env.TELEGRAM_USER_ID;
    keystore.getKeystoreSecret.mockResolvedValue("ks-token");
    const stored = await resolveTelegramSettings("bot-1", { chatId: "99" }, empty);
    expect(stored).toEqual({ token: "ks-token", tokenOrigin: "bot bot-1 keystore entry telegram-token", chatId: "99", chatIdOrigin: "bot bot-1 config alerts.telegram.chatId" });
    process.env.TELEGRAM_BOT_TOKEN = "env-token"; process.env.TELEGRAM_CHAT_ID = "55";
    const fromEnv = await resolveTelegramSettings("bot-1", { chatId: "99" }, empty);
    expect(fromEnv).toMatchObject({ token: "env-token", tokenOrigin: "exported TELEGRAM_BOT_TOKEN", chatId: "55", chatIdOrigin: "exported TELEGRAM_CHAT_ID" });
  });

  it("does not open the keystore when .local.env carries the token", async () => {
    const dir = envDir("TELEGRAM_BOT_TOKEN=local-token\nTELEGRAM_CHAT_ID=1\n");
    const settings = await resolveTelegramSettings("bot-1", undefined, dir);
    expect(settings.token).toBe("local-token");
    expect(settings.tokenOrigin).toContain(".local.env (TELEGRAM_BOT_TOKEN)");
    expect(keystore.getKeystoreSecret).not.toHaveBeenCalled();
  });

  it("describes what is missing without echoing values", async () => {
    const dir = envDir("TELEGRAM_BOT_TOKEN=local-token\n");
    keystore.getKeystoreSecret.mockResolvedValue(null);
    const settings = await resolveTelegramSettings("bot-1", undefined, dir);
    expect(describeTelegramSettings(settings)).toBe("Telegram alerts off: TELEGRAM_CHAT_ID not set (nearest .local.env, environment, or cassie init)");
    expect(describeTelegramSettings({})).toContain("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID not set");
    const complete = describeTelegramSettings({ token: "t", chatId: "c", tokenOrigin: "a", chatIdOrigin: "b" });
    expect(complete).toBe("Telegram: token from a; chat id from b");
  });
});

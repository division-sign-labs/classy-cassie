// packages/cli/test/webhook-settings.test.ts
// Webhook values come from the nearest .local.env, then the environment, then
// the bot's keystore. Origins and descriptions never include the URL or secret.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const keystore = vi.hoisted(() => ({ getKeystoreSecret: vi.fn() }));
vi.mock("../src/context.js", () => ({ getKeystoreSecret: keystore.getKeystoreSecret }));

import {
  checkWebhookUrl,
  describeWebhookSettings,
  localWebhookSettings,
  parseAlertKinds,
  parseWebhookFormat,
  resolveWebhookSettings,
} from "../src/webhook-settings.js";

const saved = { CASSIE_WEBHOOK_URL: process.env.CASSIE_WEBHOOK_URL, CASSIE_WEBHOOK_SECRET: process.env.CASSIE_WEBHOOK_SECRET };
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  keystore.getKeystoreSecret.mockReset();
});

function envDir(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cassie-webhook-"));
  writeFileSync(join(dir, ".local.env"), contents);
  return dir;
}

describe("webhook settings", () => {
  it("reads both values from the nearest .local.env without the keystore", async () => {
    const dir = envDir("CASSIE_WEBHOOK_URL=https://hooks.slack.com/services/T/B/xyz\nCASSIE_WEBHOOK_SECRET=shh\n");
    const settings = await resolveWebhookSettings("bot-1", dir);
    expect(settings).toMatchObject({ url: "https://hooks.slack.com/services/T/B/xyz", secret: "shh" });
    expect(keystore.getKeystoreSecret).not.toHaveBeenCalled();
    const line = describeWebhookSettings(settings);
    expect(line).not.toContain("xyz");
    expect(line).not.toContain("shh");
    expect(line).toContain("signed");
  });

  it("falls back to the keystore entries", async () => {
    delete process.env.CASSIE_WEBHOOK_URL; delete process.env.CASSIE_WEBHOOK_SECRET;
    const empty = mkdtempSync(join(tmpdir(), "cassie-webhook-empty-"));
    keystore.getKeystoreSecret.mockImplementation(async (_bot: string, role: string) => (role === "webhook-url" ? "https://example.com/h" : null));
    const settings = await resolveWebhookSettings("bot-1", empty);
    expect(settings).toEqual({ url: "https://example.com/h", urlOrigin: "bot bot-1 keystore entry webhook-url" });
    expect(describeWebhookSettings(settings)).toContain("unsigned");
  });

  it("reports the sink off when no URL resolves", () => {
    delete process.env.CASSIE_WEBHOOK_URL;
    expect(localWebhookSettings(mkdtempSync(join(tmpdir(), "cassie-webhook-none-"))).url).toBeUndefined();
    expect(describeWebhookSettings({})).toMatch(/^Webhook alerts off/);
  });

  it("accepts https and loopback http only", () => {
    expect(checkWebhookUrl(" https://example.com/x ")).toBe("https://example.com/x");
    expect(checkWebhookUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787/");
    expect(() => checkWebhookUrl("http://example.com/x")).toThrow(/https/);
    expect(() => checkWebhookUrl("https://user:pw@example.com/x")).toThrow(/credentials/);
    expect(() => checkWebhookUrl("not a url")).toThrow(/valid URL/);
  });

  it("validates formats and kinds", () => {
    expect(parseWebhookFormat("slack")).toBe("slack");
    expect(() => parseWebhookFormat("teams")).toThrow(/json, slack, discord/);
    expect(parseAlertKinds("entry, exit,entry")).toEqual(["entry", "exit"]);
    expect(() => parseAlertKinds("entry,nope")).toThrow(/nope/);
    expect(parseAlertKinds(undefined)).toBeUndefined();
  });
});

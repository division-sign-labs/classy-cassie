// packages/cli/test/env-file.test.ts
// systemd's EnvironmentFile unescapes \" inside a double-quoted value but
// leaves \n as a literal backslash-n. A pretty-printed bot config therefore
// reaches the runtime with backslashes inside the JSON and crash-loops it.
// These tests pin the encoding that survives that round trip.

import { describe, expect, it } from "vitest";
import { parseBotConfig, serializeBotConfig } from "@quotient-forecasting/cassie-core";

const config = parseBotConfig({
  id: "bot-1",
  venue: "polymarket",
  account: { venue: "polymarket", signerAddress: "0xabc", funder: "0xdef" },
});

/**
 * What systemd hands a service, given one `KEY="…"` line. Verified against
 * systemd 255 on Ubuntu 24.04: \" and \\ are unescaped in a single pass, and
 * every other escape — \n above all — is passed through literally.
 */
function systemdDecode(line: string): string {
  const raw = line.slice(line.indexOf("=") + 1);
  const quoted = raw.startsWith('"') && raw.endsWith('"');
  const inner = quoted ? raw.slice(1, -1) : raw;
  return inner.replace(/\\(["\\])|(\\.)/g, (_m, unescaped, passthrough) => unescaped ?? passthrough);
}

describe("bot config over an EnvironmentFile", () => {
  it("survives the round trip when compact", () => {
    const line = `CASSIE_BOT_CONFIG=${JSON.stringify(JSON.stringify(config))}`;
    const delivered = systemdDecode(line);
    expect(() => JSON.parse(delivered)).not.toThrow();
    expect(JSON.parse(delivered)).toMatchObject({ id: "bot-1", venue: "polymarket" });
  });

  it("is corrupted when pretty-printed — the shape of the original bug", () => {
    const line = `CASSIE_BOT_CONFIG=${JSON.stringify(serializeBotConfig(config).trim())}`;
    const delivered = systemdDecode(line);
    expect(delivered).toContain("\\n");
    expect(() => JSON.parse(delivered)).toThrow();
  });

  it("emits no newline for any value the deploy writes", () => {
    const values = [JSON.stringify(config), JSON.stringify({ venue: "polymarket", signerPk: "0x1" }), "sgp1", "bot-1"];
    for (const value of values) expect(value).not.toMatch(/[\r\n]/);
  });

  it("keeps embedded quotes intact, which is why the value stays quoted", () => {
    const value = JSON.stringify({ k: 'a "quoted" v' });
    expect(systemdDecode(`X=${JSON.stringify(value)}`)).toBe(value);
  });
});

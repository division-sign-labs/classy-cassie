// packages/runtime-node/test/signal-credential.test.ts
// The signals strategy runs on its strategy-scoped key alone; the other
// strategies keep their developer key.

import { describe, expect, it } from "vitest";
import { parseBotConfig } from "@quotient-forecasting/cassie-core";
import { signalCredential } from "../src/service.js";

function config(strategyId: string, venue = "polymarket") {
  return parseBotConfig({ id: "bot", venue, strategy: { id: strategyId, config: {} } });
}

describe("signalCredential", () => {
  it("uses the strategy key for the signals strategy and never a developer key", () => {
    expect(signalCredential({ config: config("signals"), strategyKey: "qsk_x", quotientToken: "qt_y" })).toBe("qsk_x");
    expect(signalCredential({ config: config("flip-flat"), strategyKey: "qsk_x" })).toBe("qsk_x");
    expect(() => signalCredential({ config: config("signals"), quotientToken: "qt_y" })).toThrow(/strategy key/);
  });

  it("keeps the developer key for strategies that research on it", () => {
    expect(signalCredential({ config: config("agent"), quotientToken: "qt_y", strategyKey: "qsk_x" })).toBe("qt_y");
    expect(() => signalCredential({ config: config("agent"), strategyKey: "qsk_x" })).toThrow(/Quotient API key/);
  });
});

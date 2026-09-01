// packages/core/test/market-make-config.test.ts

import { describe, expect, it } from "vitest";
import { parseBotConfig } from "../src/config.js";

describe("market-make bot configuration", () => {
  it("accepts the strategy on Polymarket", () => {
    expect(
      parseBotConfig({ id: "maker", venue: "polymarket", strategy: { id: "market-make", config: {} } })
        .strategy.id,
    ).toBe("market-make");
  });

  it("rejects the strategy on every other venue", () => {
    expect(() =>
      parseBotConfig({ id: "maker", venue: "kalshi", strategy: { id: "market-make", config: {} } }),
    ).toThrow(/only on Polymarket/);
  });
});

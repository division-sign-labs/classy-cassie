// packages/core/test/hyperliquid-helpers.test.ts
import { describe, expect, it } from "vitest";
import { classifyHyperliquidAgent, formatHlPrice, formatSize, toCloid } from "@quotient-forecasting/cassie-core";

describe("formatHlPrice", () => {
  it("passes integers through untouched", () => {
    expect(formatHlPrice(50_000, 3)).toBe("50000");
    expect(formatHlPrice(2, 4)).toBe("2");
  });

  it("limits to 5 significant figures", () => {
    expect(formatHlPrice(1234.5678, 1)).toBe("1234.6");
    expect(formatHlPrice(27.34567, 2)).toBe("27.346");
  });

  it("limits decimals to 6 − szDecimals", () => {
    // 5 sig figs would give 0.0012346, but szDecimals 0 → max 6 decimals.
    expect(formatHlPrice(0.0012345678, 0)).toBe("0.001235");
    // szDecimals 4 → max 2 decimals.
    expect(formatHlPrice(1.23456, 4)).toBe("1.23");
  });

  it("throws on non-positive prices", () => {
    expect(() => formatHlPrice(0, 2)).toThrow();
    expect(() => formatHlPrice(-1, 2)).toThrow();
  });
});

describe("formatSize", () => {
  it("rounds DOWN to szDecimals so the intent is never exceeded", () => {
    expect(formatSize(1.23456, 2)).toBe("1.23");
    expect(formatSize(1.999, 0)).toBe("1");
  });

  it("trims trailing zeros", () => {
    expect(formatSize(0.5, 3)).toBe("0.5");
    expect(formatSize(2.0, 2)).toBe("2");
  });
});

describe("toCloid", () => {
  it("is deterministic and shaped 0x + 32 hex chars", () => {
    const a = toCloid("fxbot-1755100000000-123456");
    expect(a).toMatch(/^0x[0-9a-f]{32}$/);
    expect(toCloid("fxbot-1755100000000-123456")).toBe(a);
  });

  it("distinct inputs give distinct cloids", () => {
    expect(toCloid("abc")).not.toBe(toCloid("abd"));
    expect(toCloid("")).not.toBe(toCloid("a"));
  });
});

describe("classifyHyperliquidAgent", () => {
  const address = "0x1111111111111111111111111111111111111111";

  it("makes retries idempotent for the same persisted agent key", () => {
    expect(classifyHyperliquidAgent([{ address: address.toUpperCase(), name: "cassie-bot" }], address, "cassie-bot")).toBe(
      "approved",
    );
  });

  it("blocks a same-name slot collision and permits a fresh slot", () => {
    expect(
      classifyHyperliquidAgent(
        [{ address: "0x2222222222222222222222222222222222222222", name: "cassie-bot" }],
        address,
        "cassie-bot",
      ),
    ).toBe("name-conflict");
    expect(classifyHyperliquidAgent([], address, "cassie-bot")).toBe("available");
  });
});

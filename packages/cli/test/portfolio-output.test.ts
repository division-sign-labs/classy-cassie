// packages/cli/test/portfolio-output.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotPortfolio, Order } from "@quotient-forecasting/cassie-core";

const dependencies = vi.hoisted(() => ({
  adapterFor: vi.fn(),
  controlFetch: vi.fn(),
  getKeystoreSecret: vi.fn(),
  isDeployed: vi.fn(),
  requireAccount: vi.fn(),
  listBotIds: vi.fn(),
  loadBotConfig: vi.fn(),
}));

vi.mock("../src/context.js", () => ({
  adapterFor: dependencies.adapterFor,
  controlFetch: dependencies.controlFetch,
  getKeystoreSecret: dependencies.getKeystoreSecret,
  isDeployed: dependencies.isDeployed,
  requireAccount: dependencies.requireAccount,
}));

vi.mock("../src/paths.js", () => ({
  listBotIds: dependencies.listBotIds,
  loadBotConfig: dependencies.loadBotConfig,
}));

import { showPortfolio } from "../src/commands/ops.js";

const portfolios = new Map<string, BotPortfolio>();

function openOrder(): Order {
  return {
    id: "order-1",
    marketRef: "market-order",
    side: "BUY",
    size: 100_000,
    filledSize: 0,
    price: 0.99,
    status: "open",
  };
}

function portfolio(
  botId: string,
  overrides: Partial<BotPortfolio> = {},
): BotPortfolio {
  return {
    botId,
    venue: "polymarket",
    balances: [],
    positions: [],
    openOrders: [],
    equity: 0,
    unrealizedPnl: 0,
    realizedPnl: 0,
    ...overrides,
  };
}

function captureOutput(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  });
  return lines;
}

beforeEach(() => {
  portfolios.clear();
  dependencies.listBotIds.mockReset();
  dependencies.loadBotConfig.mockReset();
  dependencies.controlFetch.mockReset();
  dependencies.isDeployed.mockReset();
  dependencies.listBotIds.mockImplementation(() => [...portfolios.keys()]);
  dependencies.loadBotConfig.mockImplementation((id: string) => ({ id }));
  dependencies.isDeployed.mockReturnValue(true);
  dependencies.controlFetch.mockImplementation(async (config: { id: string }) => portfolios.get(config.id));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("portfolio output breakdown", () => {
  it("labels cash, position value, equity, and uPnL for one bot without counting open orders", async () => {
    portfolios.set(
      "solo",
      portfolio("solo", {
        balances: [
          { asset: "pUSD", total: 100, available: 90 },
          { asset: "USDC", total: 25, available: 25 },
        ],
        positions: [
          { marketRef: "market-a", side: "YES", size: 40, avgPrice: 0.5, value: 24, unrealizedPnl: 4 },
        ],
        openOrders: [openOrder()],
        equity: 149,
        unrealizedPnl: 4,
      }),
    );
    const output = captureOutput();

    await showPortfolio("solo");

    expect(output.join("\n")).toContain(
      "solo (polymarket)  cash $125.00  positions $24.00  equity $149.00  uPnL $4.00",
    );
  });

  it("sums the four labeled values in the multi-bot TOTAL", async () => {
    portfolios.set(
      "one",
      portfolio("one", {
        balances: [{ asset: "pUSD", total: 100, available: 100 }],
        positions: [{ marketRef: "m-1", side: "YES", size: 40, avgPrice: 0.5, value: 20 }],
        equity: 120,
        unrealizedPnl: 2,
      }),
    );
    portfolios.set(
      "two",
      portfolio("two", {
        balances: [{ asset: "pUSD", total: 50, available: 50 }],
        positions: [{ marketRef: "m-2", side: "NO", size: 50, avgPrice: 0.5, value: 25 }],
        equity: 75,
        unrealizedPnl: -1,
      }),
    );
    const output = captureOutput();

    await showPortfolio();

    expect(output.join("\n")).toContain(
      "TOTAL  cash $150.00  positions $45.00  equity $195.00  uPnL $1.00",
    );
  });

  it("shows a finite zero breakdown for a flat bot", async () => {
    portfolios.set("flat", portfolio("flat"));
    const output = captureOutput();

    await showPortfolio("flat");

    expect(output.join("\n")).toContain(
      "flat (polymarket)  cash $0.00  positions $0.00  equity $0.00  uPnL $0.00",
    );
    expect(output.join("\n")).toContain("flat, no orders");
  });

  it("uses equity minus finite cash when any position value is missing or non-finite", async () => {
    portfolios.set(
      "partial",
      portfolio("partial", {
        balances: [
          { asset: "pUSD", total: 100, available: 100 },
          { asset: "bad", total: Number.NaN, available: 0 },
          { asset: "also-bad", total: Number.POSITIVE_INFINITY, available: 0 },
        ],
        positions: [
          { marketRef: "m-known", side: "YES", size: 40, avgPrice: 0.5, value: 30, unrealizedPnl: 1.5 },
          { marketRef: "m-missing", side: "NO", size: 20, avgPrice: 0.5 },
          { marketRef: "m-invalid", side: "YES", size: 10, avgPrice: 0.5, value: Number.NaN },
        ],
        equity: 160,
        unrealizedPnl: Number.NaN,
      }),
    );
    const output = captureOutput();

    await showPortfolio("partial");

    const rendered = output.join("\n");
    expect(rendered).toContain(
      "partial (polymarket)  cash $100.00  positions $60.00  equity $160.00  uPnL $1.50",
    );
    expect(rendered).not.toContain("NaN");
  });
});

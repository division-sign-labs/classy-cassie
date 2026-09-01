// packages/cli/test/market-make-argv.test.ts

import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { addMarketMakeConfigureOptions, program } from "../src/index.js";

function configureCommand(): Command {
  return addMarketMakeConfigureOptions(new Command("configure").argument("<botId>"))
    .exitOverride()
    .configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
}

function parseConfigure(argv: string[]): Record<string, unknown> {
  const command = configureCommand();
  command.parse(["test-bot", ...argv], { from: "user" });
  return command.opts();
}

describe("market-make configure argv", () => {
  it("parses NO-direction and liquidity participation flags as values, not negated booleans", () => {
    const opts = parseConfigure([
      "--target-no-usd", "44",
      "--min-no-edge-pp", "11",
      "--renewal-no-edge-pp", "12",
      "--max-order-depth-1c-pct", "2.5",
      "--max-order-depth-2c-pct", "0.9",
      "--max-market-depth-1c-pct", "5",
      "--max-market-depth-2c-pct", "1.8",
      "--gap-capture-pct", "75",
      "--max-edge-pp", "30",
    ]);

    expect(opts).toEqual({
      targetNoUsd: "44",
      minNoEdgePp: "11",
      renewalNoEdgePp: "12",
      maxOrderDepth1cPct: "2.5",
      maxOrderDepth2cPct: "0.9",
      maxMarketDepth1cPct: "5",
      maxMarketDepth2cPct: "1.8",
      gapCapturePct: "75",
      maxEdgePp: "30",
    });
  });

  it("rejects an edge ceiling above the fixed 30pp sanity bound during argv parsing", () => {
    expect(() => parseConfigure(["--max-edge-pp", "30.01"])).toThrow(/hard 30pp sanity bound/);
    expect(() => parseConfigure(["--max-edge-pp", "0"])).toThrow(/positive number/);
  });

  it("parses automatic-bankroll controls explicitly", () => {
    expect(parseConfigure(["--bankroll-ceiling-usd", "10000"])).toEqual({
      bankrollCeilingUsd: "10000",
    });
    expect(parseConfigure(["--bankroll-ceiling-usd", "unlimited"])).toEqual({
      bankrollCeilingUsd: "unlimited",
    });
    expect(parseConfigure(["--live-bankroll"])).toEqual({ liveBankroll: true });
  });

  it("describes percentage input and dry-run persistence accurately in help", () => {
    const gapCapture = configureCommand().options.find((option) => option.long === "--gap-capture-pct");
    expect(gapCapture?.description).toBe("percentage of the first-fill gap captured at exit (75 = 75%)");
    const marketMake = program.commands.find((command) => command.name() === "market-make");
    const dryRun = marketMake?.commands.find((command) => command.name() === "dry-run");
    expect(dryRun?.description()).toContain("without placing orders; API spend is still metered");
  });
});

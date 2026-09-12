// packages/core/test/polymarket-outcome-tokens.test.ts
import { describe, expect, it } from "vitest";
import { outcomeTokensOf } from "../src/venues/polymarket.js";

describe("Polymarket outcome token mapping", () => {
  it("uses the explicit Yes/No labels whatever their order", () => {
    expect(outcomeTokensOf([{ tokenId: "n", outcome: " No " }, { tokenId: "y", outcome: "YES" }])).toEqual({ yes: "y", no: "n" });
  });
  it("treats the first listed outcome of a two-way matchup as YES, matching the question and the published signal", () => {
    expect(outcomeTokensOf([{ tokenId: 17538918577045757318444194668211148943610591693537184656815548450079156080092n, outcome: "Aryna Sabalenka" },
      { tokenId: "64703197063795243847360183645307109446147801518759459137324323079702380490951", outcome: "Elena Rybakina" }]))
      .toEqual({ yes: "17538918577045757318444194668211148943610591693537184656815548450079156080092", no: "64703197063795243847360183645307109446147801518759459137324323079702380490951" });
  });
  it("refuses a market whose outcomes cannot be paired", () => {
    expect(() => outcomeTokensOf([{ tokenId: "a", outcome: "Yes" }, { tokenId: "b", outcome: "Maybe" }])).toThrow(/do not form a YES\/NO pair/);
    expect(() => outcomeTokensOf([{ tokenId: "a", outcome: "A" }, { tokenId: "b", outcome: "B" }, { tokenId: "c", outcome: "C" }])).toThrow(/do not form a YES\/NO pair/);
  });
});

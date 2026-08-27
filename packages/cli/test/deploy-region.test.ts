// packages/cli/test/deploy-region.test.ts
// Kalshi accepts API access from US IPs only, so deploy must refuse a non-US
// droplet region for a kalshi bot before anything is provisioned.

import { describe, expect, it } from "vitest";
import { KALSHI_DEFAULT_REGION, US_REGION_SLUGS, assertRegionForVenue } from "../src/commands/deploy.js";

describe("deploy region gate", () => {
  it("accepts every US slug for kalshi", () => {
    for (const slug of US_REGION_SLUGS) {
      expect(() => assertRegionForVenue("kalshi", slug)).not.toThrow();
    }
  });

  it("refuses a non-US region for kalshi, naming the alternatives", () => {
    expect(() => assertRegionForVenue("kalshi", "sgp1")).toThrow(/US droplet/);
    expect(() => assertRegionForVenue("kalshi", "blr1")).toThrow(/nyc3/);
  });

  it("leaves other venues unconstrained", () => {
    expect(() => assertRegionForVenue("polymarket", "sgp1")).not.toThrow();
    expect(() => assertRegionForVenue("hyperliquid", "blr1")).not.toThrow();
  });

  it("kalshi's default region is itself a US slug", () => {
    expect(US_REGION_SLUGS).toContain(KALSHI_DEFAULT_REGION);
  });
});

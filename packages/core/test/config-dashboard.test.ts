// packages/core/test/config-dashboard.test.ts
import { describe, expect, it } from "vitest";
import { DashboardConfigSchema, parseBotConfig } from "@quotient-forecasting/cassie-core";

describe("dashboard config", () => {
  it("defaults to enabled on 8443 and is absent unless set", () => {
    expect(parseBotConfig({ id: "b", venue: "polymarket" }).dashboard).toBeUndefined();
    expect(parseBotConfig({ id: "b", venue: "polymarket", dashboard: {} }).dashboard).toEqual({ enabled: true, port: 8443 });
    expect(parseBotConfig({ id: "b", venue: "polymarket", dashboard: { enabled: false, port: 9443, passwordHash: "scrypt$1$2$3" } }).dashboard)
      .toEqual({ enabled: false, port: 9443, passwordHash: "scrypt$1$2$3" });
  });

  it("rejects privileged ports and a plaintext password key", () => {
    expect(() => parseBotConfig({ id: "b", venue: "polymarket", dashboard: { port: 80 } })).toThrow();
    expect(() => parseBotConfig({ id: "b", venue: "polymarket", dashboard: { password: "hunter22" } })).toThrow();
    expect(DashboardConfigSchema.safeParse({ port: 70000 }).success).toBe(false);
  });
});

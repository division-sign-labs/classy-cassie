// packages/runtime-node/test/dashboard-password.test.ts
import { describe, expect, it } from "vitest";
import { hashDashboardPassword, parseDashboardAuthFile, verifyDashboardPassword } from "../src/dashboard/password.js";

describe("dashboard password", () => {
  it("hashes with scrypt and verifies only the right password", async () => {
    const stored = await hashDashboardPassword("correct horse battery");
    expect(stored).toMatch(/^scrypt\$32768\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(stored).not.toContain("correct horse");
    expect(await verifyDashboardPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyDashboardPassword("correct horse batter", stored)).toBe(false);
    expect(await hashDashboardPassword("correct horse battery")).not.toBe(stored);
  });

  it("refuses an empty password", async () => {
    await expect(hashDashboardPassword("")).rejects.toThrow(/empty/);
  });

  it("returns false for malformed stored values without throwing", async () => {
    for (const bad of ["", "plain", "scrypt$abc$x$y", "scrypt$8192$" + "A".repeat(24) + "$" + "B".repeat(44), "scrypt$32768$AA$BB", "bcrypt$1$2$3"]) {
      expect(await verifyDashboardPassword("x", bad)).toBe(false);
    }
    expect(await verifyDashboardPassword(undefined as unknown as string, "scrypt$32768$AAAA$BBBB")).toBe(false);
  });

  it("parses the auth file and rejects other shapes", () => {
    expect(parseDashboardAuthFile('{"passwordHash":"scrypt$1$2$3"}')).toEqual({ passwordHash: "scrypt$1$2$3" });
    expect(() => parseDashboardAuthFile("[]")).toThrow();
    expect(() => parseDashboardAuthFile('{"password":"x"}')).toThrow(/passwordHash/);
    expect(() => parseDashboardAuthFile("nope")).toThrow();
  });
});

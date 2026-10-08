// packages/cli/test/deploy-swing.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBotConfig, type BotConfig } from "@quotient-forecasting/cassie-core";
import type { Droplet } from "../src/digitalocean.js";
import { marketMakeStateSource, preserveRuntimeState, quiesce, restoreRuntimeState } from "../src/commands/deploy.js";

const CONFIG: BotConfig = parseBotConfig({
  id: "swing-deploy", venue: "hyperliquid", strategy: { id: "quotient-swing", config: { mode: "live" } },
  deployment: { provider: "digitalocean", dropletId: 123, host: "203.0.113.8", region: "sgp1", size: "s-1vcpu-1gb", user: "root", deployedAt: "2026-09-05T00:00:00.000Z" },
});
const SUCCESS = { ok: true, code: 0, stdout: "", stderr: "" };
function protectedShutdown() {
  return { stopped: true, restingOrdersCanceled: true, cancellation: {
    method: "engine", requested: true, completed: true, verifiedOpenOrders: false,
    remainingOpenOrders: null, protectiveOrdersRetained: true,
  } };
}
beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe("swing deployment durability", () => {
  it("preserves execution state for same-droplet redeploys and replacements", () => {
    expect(marketMakeStateSource(CONFIG, true, null)).toBe(CONFIG);
    expect(marketMakeStateSource(CONFIG, false, null)).toBe(CONFIG);
  });

  it("preserves a same-name swing droplet even when the local deployment pointer is absent", () => {
    const { deployment: _deployment, ...local } = CONFIG;
    const droplet = { id: 456, created_at: "2026-09-05T01:00:00.000Z", region: { slug: "sgp1" },
      size_slug: "s-1vcpu-1gb", networks: { v4: [{ type: "public", ip_address: "203.0.113.9" }] } } as unknown as Droplet;
    expect(marketMakeStateSource(local, false, droplet)?.deployment).toMatchObject({ dropletId: 456, host: "203.0.113.9" });
    expect(marketMakeStateSource(local, false, null)).toBeNull();
  });

  it("accepts the engine's native-protection proof without demanding empty protective orders", async () => {
    const exec = vi.fn(() => SUCCESS);
    const control = vi.fn((_target, _botId, _method, path) => {
      if (path !== "/shutdown") throw new Error("native-stop-aware shutdown must not require an empty order book");
      return protectedShutdown();
    });
    await quiesce(CONFIG, false, { exec, control });
    expect(exec.mock.calls.map(call => call[1])).toEqual(["true", "systemctl stop cassie@swing-deploy"]);
    expect(control).toHaveBeenCalledExactlyOnceWith({ host: "203.0.113.8", user: "root" }, "swing-deploy", "POST", "/shutdown");
  });

  it("treats swing as strict even when the caller does not request strict quiescence", async () => {
    const exec = vi.fn(() => SUCCESS);
    const control = vi.fn(() => { throw new Error("Shutdown not confirmed: order acknowledgement unresolved"); });
    await expect(quiesce(CONFIG, false, { exec, control })).rejects.toThrow("protected shutdown was not verified");
    expect(exec.mock.calls.map(call => call[1])).toEqual(["true"]);
  });

  it("does not treat an inactive service as proof that uncertain fills are safe", async () => {
    const exec = vi.fn((_target, command) => ({ ...SUCCESS, ok: !command.startsWith("systemctl is-active") }));
    const control = vi.fn(() => { throw new Error("connection refused"); });
    await expect(quiesce(CONFIG, true, { exec, control })).rejects.toThrow("protected shutdown was not verified");
    expect(exec.mock.calls.map(call => call[1])).toEqual(["true"]);
  });

  it("refuses to replace an unreachable swing host", async () => {
    const exec = vi.fn(() => ({ ...SUCCESS, ok: false })); const control = vi.fn();
    await expect(quiesce(CONFIG, false, { exec, control })).rejects.toThrow("existing host is unreachable");
    expect(control).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledOnce();
  });

  it.each([
    { stopped: true, restingOrdersCanceled: true },
    { ...protectedShutdown(), stopped: false },
    { ...protectedShutdown(), restingOrdersCanceled: false },
    { ...protectedShutdown(), cancellation: { ...protectedShutdown().cancellation, method: "adapter" } },
    { ...protectedShutdown(), cancellation: { ...protectedShutdown().cancellation, requested: false } },
    { ...protectedShutdown(), cancellation: { ...protectedShutdown().cancellation, completed: false } },
    { ...protectedShutdown(), cancellation: { ...protectedShutdown().cancellation, protectiveOrdersRetained: false } },
  ])("rejects incomplete or generic shutdown evidence before stopping systemd", async response => {
    const exec = vi.fn(() => SUCCESS); const control = vi.fn(() => response);
    await expect(quiesce(CONFIG, false, { exec, control })).rejects.toThrow("protected shutdown was not verified");
    expect(exec.mock.calls.map(call => call[1])).toEqual(["true"]);
  });

  it("refuses to continue if systemd cannot stop the verified runtime", async () => {
    const exec = vi.fn((_target, command) => ({ ...SUCCESS, ok: command === "true", stderr: command === "true" ? "" : "denied" }));
    await expect(quiesce(CONFIG, false, { exec, control: vi.fn(() => protectedShutdown()) })).rejects.toThrow("could not stop its runtime cleanly");
  });

  it("archives the execution database, its sidecars, and swing recordings for recovery", () => {
    const exec = vi.fn(() => ({ ...SUCCESS, stdout: "encoded-archive" })); const write = vi.fn();
    const result = preserveRuntimeState(CONFIG, { exec, write });
    const command = exec.mock.calls[0]![1];
    expect(command).toContain("'swing-deploy.sqlite'");
    for (const suffix of [".sqlite-wal", ".sqlite-shm", ".sqlite.swing.sqlite", ".sqlite.swing.sqlite-wal", ".sqlite.swing.sqlite-shm"]) {
      expect(command).toContain(`'swing-deploy${suffix}'`);
    }
    expect(result?.payload).toBe("encoded-archive");
    expect(write).toHaveBeenCalledWith(expect.stringContaining("deployment-snapshots"), "encoded-archive\n");
  });

  it("refuses replacement when the existing execution checkpoint is missing", () => {
    const exec = vi.fn(() => ({ ...SUCCESS, stdout: "__CASSIE_NO_RUNTIME_STATE__" })); const write = vi.fn();
    expect(() => preserveRuntimeState(CONFIG, { exec, write })).toThrow("execution checkpoint cannot be preserved");
    expect(write).not.toHaveBeenCalled();
  });

  it("restores the preserved archive over stdin before startup", () => {
    const exec = vi.fn(() => SUCCESS);
    restoreRuntimeState({ host: "203.0.113.8", user: "root" }, CONFIG.id,
      { path: "/test-only/recovery.b64", payload: "encoded-archive" }, { exec });
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0]![1]).toContain("base64 --decode | tar -xzf - -C /var/lib/cassie");
    expect(exec.mock.calls[0]![1]).not.toContain("encoded-archive");
    expect(exec.mock.calls[0]![2]).toBe("encoded-archive");
  });
});

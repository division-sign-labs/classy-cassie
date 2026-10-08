// packages/cli/test/deploy-prediction.test.ts
// Adaptive execution must preserve its checkpoint and reconcile it before deploy activation.

import { describe, expect, it, vi } from "vitest";
import { parseBotConfig, type BotConfig } from "@quotient-forecasting/cassie-core";
import type { Droplet } from "../src/digitalocean.js";
import type { ExecResult, sshExec, sshExecOrThrow } from "../src/ssh.js";
import { ControlApiError } from "../src/ssh.js";
import {
  deploymentIdFor,
  isAdaptivePredictionDeployment,
  marketMakeStateSource,
  preparePredictionModeChange,
  preserveRuntimeState,
  quiesce,
  restoreRuntimeState,
  runtimeAutostartBeforePreflights,
  startRuntimeAfterPreflights,
} from "../src/commands/deploy.js";

const deployment = {
  provider: "digitalocean" as const,
  dropletId: 1234,
  host: "203.0.113.8",
  region: "sgp1",
  size: "s-1vcpu-1gb",
  user: "root",
  deployedAt: "2026-09-04T12:00:00.000Z",
};
const target = { host: deployment.host, user: deployment.user };

function bot(options: {
  strategy?: string;
  venue?: BotConfig["venue"];
  mode?: "adaptive" | "legacy";
  deployed?: boolean;
} = {}): BotConfig {
  return parseBotConfig({
    id: "prediction-1",
    venue: options.venue ?? "polymarket",
    strategy: { id: options.strategy ?? "signals", config: {} },
    ...(options.mode ? { execution: { mode: options.mode } } : {}),
    ...(options.deployed ? { deployment } : {}),
  });
}

function executed(ok = true, stdout = "", stderr = ""): ExecResult {
  return { ok, code: ok ? 0 : 1, stdout, stderr };
}

function orphan(): Droplet {
  return {
    id: 5678,
    name: "cassie-prediction-1",
    status: "active",
    region: { slug: "sgp1", name: "Singapore" },
    size_slug: "s-1vcpu-1gb",
    size: { price_monthly: 6 },
    created_at: "2026-09-03T12:00:00.000Z",
    networks: { v4: [{ ip_address: "203.0.113.9", type: "public" }] },
    tags: [],
  };
}

describe("adaptive prediction deployment", () => {
  it("recognizes default and explicit adaptive execution only for supported Polymarket strategies", () => {
    for (const strategy of ["signals", "flip-flat"]) {
      expect(isAdaptivePredictionDeployment(bot({ strategy }))).toBe(true);
      expect(isAdaptivePredictionDeployment(bot({ strategy, mode: "adaptive" }))).toBe(true);
      expect(isAdaptivePredictionDeployment(bot({ strategy, mode: "legacy" }))).toBe(false);
      expect(isAdaptivePredictionDeployment(bot({ strategy, venue: "kalshi", mode: "adaptive" }))).toBe(false);
    }
    expect(isAdaptivePredictionDeployment(bot({ strategy: "agent" }))).toBe(false);
    expect(isAdaptivePredictionDeployment(bot({ strategy: "market-make" }))).toBe(false);
  });

  it("keeps protected runtimes stopped until preflights finish", () => {
    for (const strategy of ["signals", "flip-flat", "market-make"]) {
      expect(runtimeAutostartBeforePreflights(bot({ strategy }))).toBe("0");
    }
    expect(runtimeAutostartBeforePreflights(bot({ strategy: "quotient-swing", venue: "hyperliquid" }))).toBe("0");
    expect(runtimeAutostartBeforePreflights(bot({ mode: "legacy" }))).toBe("0");
    expect(runtimeAutostartBeforePreflights(bot({ venue: "kalshi" }))).toBe("1");
    expect(runtimeAutostartBeforePreflights(bot({ strategy: "agent" }))).toBe("1");
  });

  it("preserves the saved source for both same-host and replacement deployments", () => {
    const cfg = bot({ deployed: true });
    expect(marketMakeStateSource(cfg, true, null)).toBe(cfg);
    expect(marketMakeStateSource(cfg, false, orphan())).toBe(cfg);
    expect(marketMakeStateSource(bot(), true, null)).toBeNull();
    const legacy = bot({ deployed: true, mode: "legacy" });
    expect(marketMakeStateSource(legacy, false, orphan())).toBe(legacy);
  });

  it("recovers a same-name orphan's address when no deployment was saved", () => {
    const source = marketMakeStateSource(bot(), false, orphan());
    expect(source?.deployment).toMatchObject({
      dropletId: 5678,
      host: "203.0.113.9",
      user: "root",
      deployedAt: "2026-09-03T12:00:00.000Z",
    });
    expect(source?.execution).toBeUndefined();
    expect(marketMakeStateSource(bot(), false, null)).toBeNull();
    expect(() => marketMakeStateSource(bot(), false, {
      ...orphan(), networks: { v4: [] },
    })).toThrow(/public IPv4/);
  });

  it("refuses to replace an unreachable adaptive deployment before calling control", async () => {
    const control = vi.fn();
    await expect(quiesce(bot({ deployed: true }), true, {
      exec: () => executed(false), control,
    })).rejects.toThrow(/unreachable/);
    expect(control).not.toHaveBeenCalled();
  });

  it("refuses when the control API is down but the service is still running", async () => {
    const commands: string[] = [];
    const venueOrders = vi.fn(async () => []);
    await expect(quiesce(bot({ deployed: true }), true, {
      exec: (_target, command) => { commands.push(command); return executed(); },
      control: () => { throw new Error("connect ECONNREFUSED"); },
      venueOrders,
    })).rejects.toThrow(/shutdown cancellation was not verified/);
    expect(commands).toEqual(["true", "systemctl is-active --quiet cassie@prediction-1"]);
    expect(venueOrders).not.toHaveBeenCalled();
  });

  it("continues past a stopped runtime only after the venue reports no resting orders", async () => {
    const calls: string[] = [];
    await quiesce(bot({ deployed: true }), true, {
      exec: (_target, command) => {
        calls.push(command);
        return executed(!command.startsWith("systemctl is-active"));
      },
      control: () => { throw new Error("connect ECONNREFUSED"); },
      venueOrders: async (cfg) => { calls.push(`venue ${cfg.id}`); return []; },
    });
    // The unit is held stopped before the venue read so an auto-restart cannot race it.
    expect(calls).toEqual([
      "true",
      "systemctl is-active --quiet cassie@prediction-1",
      "systemctl stop cassie@prediction-1",
      "venue prediction-1",
    ]);
  });

  it("does not accept an inactive service as proof that venue orders were canceled", async () => {
    const stopped = (_target: unknown, command: string) => executed(!command.startsWith("systemctl is-active"));
    const control = () => { throw new Error("connect ECONNREFUSED"); };
    for (const [venueOrders, message] of [
      [async () => [{ id: "still-resting" }], /left 1 resting order\(s\) on polymarket/],
      [async () => ({ orders: [] }), /non-array response/],
      [async () => { throw new Error("fetch failed"); }, /order check failed \(fetch failed\)/],
    ] as const) {
      await expect(quiesce(bot({ deployed: true }), true, { exec: stopped, control, venueOrders }))
        .rejects.toThrow(message);
    }
  });

  it("refuses a stopped runtime that systemd cannot hold stopped", async () => {
    const venueOrders = vi.fn(async () => []);
    await expect(quiesce(bot({ deployed: true }), true, {
      exec: (_target, command) => executed(command === "true", "", "unit busy"),
      control: () => { throw new Error("connect ECONNREFUSED"); },
      venueOrders,
    })).rejects.toThrow(/could not be held stopped \(unit busy\)/);
    expect(venueOrders).not.toHaveBeenCalled();
  });

  it("cannot bypass strict shutdown by saving legacy execution or passing best-effort mode", async () => {
    const control = vi.fn(() => { throw new Error("old adaptive runtime unreachable"); });
    await expect(quiesce(bot({ deployed: true, mode: "legacy" }), false, {
      exec: () => executed(), control,
    })).rejects.toThrow(/shutdown cancellation was not verified/);
  });

  it("pauses and drains the old adaptive ledger before permitting a legacy replacement", async () => {
    const paths: string[] = [];
    const sleep = vi.fn(async () => {});
    let observations = 0;
    await preparePredictionModeChange(bot({ deployed: true, mode: "legacy" }), {
      sleep,
      control: (_target, _id, method, path) => {
        paths.push(`${method} ${path}`);
        if (path === "/pause") return { ok: true, paused: true };
        observations++;
        return { blocked: false, parents: [{ status: observations < 3 ? "canceling" : "canceled" }] };
      },
    });
    expect(paths).toEqual([
      "GET /execution/status", "POST /pause", "GET /execution/status", "GET /execution/status",
    ]);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(5_000);
  });

  it("keeps an ambiguous old submission paused and refuses legacy replacement", async () => {
    const paths: string[] = [];
    await expect(preparePredictionModeChange(bot({ deployed: true, mode: "legacy" }), {
      sleep: async () => {},
      control: (_target, _id, _method, path) => {
        paths.push(path);
        return path === "/pause" ? { ok: true } : {
          blocked: true, haltReason: "ambiguous POST", parents: [{ status: "blocked" }],
        };
      },
    })).rejects.toThrow(/ambiguous POST/);
    expect(paths).toContain("/pause");
    expect(paths).not.toContain("/shutdown");
    expect(paths).not.toContain("/resume");
  });

  it("refuses legacy replacement while queued exits or unconfirmed fills remain after parents terminate", async () => {
    for (const pending of [{ queuedExitCount: 1, unsettledFillCount: 0 }, { queuedExitCount: 0, unsettledFillCount: 1 }]) {
      await expect(preparePredictionModeChange(bot({ deployed: true, mode: "legacy" }), {
        sleep: async () => {},
        control: (_target, _id, _method, path) => path === "/pause" ? { ok: true } : {
          blocked: false, parents: [{ status: "canceled" }], ...pending,
        },
      })).rejects.toThrow(/queued exits or settlements/);
    }
  });

  it("recognizes old legacy runtimes only from disabled execution or their exact missing-route response", async () => {
    for (const disabled of [false, true]) {
      const control = vi.fn(() => {
        if (disabled) return { enabled: false };
        throw new ControlApiError("control API: unknown route", { error: "unknown route GET /execution/status" });
      });
      await expect(preparePredictionModeChange(bot({ deployed: true, mode: "legacy" }), {
        control, sleep: async () => {},
      })).resolves.toBeUndefined();
      expect(control).toHaveBeenCalledOnce();
    }
  });

  it("refuses malformed, unavailable, or unrelated failed execution reads during a legacy switch", async () => {
    for (const result of [
      {}, { enabled: true }, { parents: [], blocked: "unknown" },
      new Error("connection refused"), new ControlApiError("control API error", { error: "state read failed" }),
    ]) {
      const control = vi.fn(() => { if (result instanceof Error) throw result; return result; });
      await expect(preparePredictionModeChange(bot({ deployed: true, mode: "legacy" }), {
        control, sleep: async () => {},
      })).rejects.toThrow();
      expect(control).toHaveBeenCalledOnce();
    }
  });

  it("does not run a mode-change preflight for first deploys, adaptive settings, or other venues", async () => {
    const control = vi.fn();
    for (const cfg of [bot({ mode: "legacy" }), bot({ deployed: true }), bot({ deployed: true, venue: "kalshi", mode: "legacy" })]) {
      await preparePredictionModeChange(cfg, { control, sleep: async () => {} });
    }
    expect(control).not.toHaveBeenCalled();
  });

  it("rejects incomplete shutdown acknowledgments without proceeding to replacement", async () => {
    for (const shutdown of [
      { stopped: true, restingOrdersCanceled: false },
      { stopped: false, restingOrdersCanceled: true },
      {},
    ]) {
      const commands: string[] = [];
      await expect(quiesce(bot({ deployed: true }), true, {
        exec: (_target, command) => { commands.push(command); return executed(); },
        control: () => shutdown,
      })).rejects.toThrow(/shutdown cancellation was not verified/);
      expect(commands).not.toContain("systemctl stop cassie@prediction-1");
    }
  });

  it("requires an authoritative empty orders array even after successful shutdown", async () => {
    for (const orders of [[{ id: "still-resting" }], { orders: [] }, null]) {
      const commands: string[] = [];
      await expect(quiesce(bot({ deployed: true }), true, {
        exec: (_target, command) => { commands.push(command); return executed(); },
        control: (_target, _id, _method, path) => path === "/shutdown"
          ? { stopped: true, restingOrdersCanceled: true }
          : orders,
      })).rejects.toThrow(/shutdown cancellation was not verified/);
      expect(commands).not.toContain("systemctl stop cassie@prediction-1");
    }
  });

  it("verifies shutdown and venue orders before stopping the service", async () => {
    const calls: string[] = [];
    await quiesce(bot({ deployed: true }), true, {
      exec: (_target, command) => { calls.push(command); return executed(); },
      control: (_target, id, method, path) => {
        expect(id).toBe("prediction-1");
        calls.push(`${method} ${path}`);
        return path === "/shutdown" ? { stopped: true, restingOrdersCanceled: true } : [];
      },
    });
    expect(calls).toEqual([
      "true", "POST /shutdown", "GET /orders", "systemctl stop cassie@prediction-1",
    ]);
  });

  it("fails when systemd cannot stop the verified runtime", async () => {
    await expect(quiesce(bot({ deployed: true }), true, {
      exec: (_target, command) => executed(!command.startsWith("systemctl stop"), "", "stop failed"),
      control: (_target, _id, _method, path) => path === "/shutdown"
        ? { stopped: true, restingOrdersCanceled: true }
        : [],
    })).rejects.toThrow(/could not stop.*cleanly/);
  });

  it("initializes paused and verifies recovery before resuming adaptive execution", async () => {
    const calls: string[] = [];
    const started = { ok: true, running: true };
    const result = await startRuntimeAfterPreflights(bot(), (method, path) => {
      calls.push(`${method} ${path}`);
      return path === "/execution/status" ? { blocked: false, parents: [] } : started;
    });
    expect(calls).toEqual([
      "POST /pause", "POST /init", "GET /execution/status", "POST /resume", "GET /execution/status",
    ]);
    expect(result.started).toEqual(started);
    expect(result.executionStatus).toEqual({ blocked: false, parents: [] });
  });

  it("waits for terminal parent reconciliation and permits resume to clear a recoverable halt", async () => {
    const calls: string[] = [];
    const sleep = vi.fn(async () => {});
    let observations = 0;
    const result = await startRuntimeAfterPreflights(bot(), (method, path) => {
      calls.push(`${method} ${path}`);
      if (path !== "/execution/status") return { ok: true };
      observations++;
      if (observations === 1) return { blocked: false, parents: [{ status: "canceling" }] };
      if (observations === 2) return { blocked: true, haltReason: "shutdown", parents: [{ status: "canceled" }] };
      return { blocked: false, parents: [{ status: "canceled" }] };
    }, { sleep });
    expect(sleep).toHaveBeenCalled();
    expect(calls).toEqual([
      "POST /pause", "POST /init", "GET /execution/status", "GET /execution/status",
      "POST /resume", "GET /execution/status",
    ]);
    expect(result.executionStatus?.blocked).toBe(false);
  });

  it("never resumes while parent acknowledgments or cancellations remain unresolved", async () => {
    const paths: string[] = [];
    await expect(startRuntimeAfterPreflights(bot(), (_method, path) => {
      paths.push(path);
      return path === "/execution/status"
        ? { blocked: true, haltReason: "unresolved POST outcome", parents: [{ status: "blocked" }] }
        : { ok: true };
    }, { sleep: async () => {} })).rejects.toThrow(/unresolved POST outcome/);
    expect(paths).not.toContain("/resume");
  });

  it("rejects missing or malformed execution status before granting runtime authority", async () => {
    for (const status of [
      {},
      null,
      [],
      { blocked: false },
      { blocked: "false", parents: [] },
      { blocked: false, parents: {} },
    ]) {
      const paths: string[] = [];
      await expect(startRuntimeAfterPreflights(bot(), (_method, path) => {
        paths.push(path);
        return path === "/execution/status" ? status : { ok: true };
      }, { sleep: async () => {} })).rejects.toThrow();
      expect(paths).not.toContain("/resume");
    }
  });

  it("refuses activation when resume fails or leaves execution blocked", async () => {
    await expect(startRuntimeAfterPreflights(bot(), (_method, path) => {
      if (path === "/execution/status") return { blocked: false, parents: [] };
      if (path === "/resume") throw new Error("venue reconciliation unavailable");
      return { ok: true };
    })).rejects.toThrow(/venue reconciliation unavailable/);
    await expect(startRuntimeAfterPreflights(bot(), (_method, path) => {
      if (path === "/execution/status") return { blocked: true, haltReason: "venue orders unresolved", parents: [] };
      return { ok: true };
    })).rejects.toThrow(/venue orders unresolved/);
  });

  it("pauses again if post-resume checkpoint verification fails", async () => {
    for (const malformed of [false, true]) {
      const paths: string[] = [];
      let resumed = false;
      await expect(startRuntimeAfterPreflights(bot(), (_method, path) => {
        paths.push(path);
        if (path === "/resume") resumed = true;
        if (path !== "/execution/status") return { ok: true };
        if (!resumed) return { blocked: false, parents: [] };
        if (malformed) return { blocked: "unknown", parents: [] };
        throw new Error("checkpoint read failed");
      })).rejects.toThrow();
      expect(paths.at(-1)).toBe("/pause");
    }
  });

  it("retains resume and init without an adaptive checkpoint requirement in legacy mode", async () => {
    const calls: string[] = [];
    await startRuntimeAfterPreflights(bot({ mode: "legacy" }), (method, path) => {
      calls.push(`${method} ${path}`);
      return { ok: true };
    });
    expect(calls).toEqual(["POST /resume", "POST /init"]);
  });

  it("captures SQLite and sidecars into a retained private recovery artifact", () => {
    const cfg = bot({ deployed: true });
    const exec = vi.fn<typeof sshExec>(() => executed(true, "Y2hlY2twb2ludA==\n"));
    const write = vi.fn();
    const snapshot = preserveRuntimeState(cfg, { exec, write });
    expect(snapshot?.payload).toBe("Y2hlY2twb2ludA==");
    expect(snapshot?.path).toContain(`prediction-1-${deploymentIdFor(deployment)}.sqlite.tar.gz.b64`);
    expect(write).toHaveBeenCalledWith(snapshot?.path, "Y2hlY2twb2ludA==\n");
    expect(exec).toHaveBeenCalledWith(target, expect.stringContaining("prediction-1.sqlite-wal"), undefined,
      expect.objectContaining({ maxBufferBytes: 1024 * 1024 * 1024 }));
    expect(exec.mock.calls[0]?.[1]).toContain("prediction-1.sqlite-shm");
  });

  it("refuses missing, empty, or failed adaptive snapshots without writing a recovery artifact", () => {
    for (const result of [
      executed(true, "__CASSIE_NO_RUNTIME_STATE__"),
      executed(true, "\n"),
      executed(false, "", "archive failed"),
    ]) {
      const write = vi.fn();
      expect(() => preserveRuntimeState(bot({ deployed: true }), {
        exec: () => result, write,
      })).toThrow();
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("does not forget the prior adaptive ledger when a legacy deployment has no SQLite file", () => {
    expect(() => preserveRuntimeState(bot({ deployed: true, mode: "legacy" }), {
      exec: () => executed(true, "__CASSIE_NO_RUNTIME_STATE__"), write: vi.fn(),
    })).toThrow(/checkpoint cannot be preserved/);
  });

  it("preserves the market-maker missing-state exception and skips undeployed bots", () => {
    const exec = vi.fn(() => executed(true, "__CASSIE_NO_RUNTIME_STATE__"));
    const write = vi.fn();
    expect(preserveRuntimeState(bot(), { exec, write })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
    expect(preserveRuntimeState(bot({ strategy: "market-make", deployed: true }), { exec, write })).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("restores snapshot bytes through stdin and limits restored files to the runtime owner", () => {
    const snapshot = { path: "/tmp/prediction-checkpoint.sqlite.tar.gz.b64", payload: "Y2hlY2twb2ludA==" };
    const exec = vi.fn<typeof sshExecOrThrow>(() => "");
    restoreRuntimeState(target, "prediction-1", snapshot, { exec });
    expect(exec).toHaveBeenCalledWith(target, expect.stringContaining("base64 --decode | tar -xzf -"), snapshot.payload);
    const command = exec.mock.calls[0]?.[1];
    expect(command).toContain("chown cassie:cassie");
    expect(command).toContain("chmod 0600");
    expect(command).not.toContain(snapshot.payload);
  });

  it("retains the local recovery path in restore errors", () => {
    const snapshot = { path: "/tmp/prediction-checkpoint.sqlite.tar.gz.b64", payload: "Y2hlY2twb2ludA==" };
    expect(() => restoreRuntimeState(target, "prediction-1", snapshot, {
      exec: () => { throw new Error("restore failed"); },
    })).toThrow(/recoverable snapshot remains at \/tmp\/prediction-checkpoint\.sqlite\.tar\.gz\.b64: restore failed/);
  });
});

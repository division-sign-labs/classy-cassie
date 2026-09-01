// packages/cli/test/deploy-market-make.test.ts
// Market-making deploys reconcile and start their controller without ever
// activating entries; a saved deployment also has a stable unique identity.

import { describe, expect, it } from "vitest";
import { parseBotConfig, type BotConfig } from "@quotient-forecasting/cassie-core";
import {
  deploymentIdFor,
  marketMakeStateSource,
  quiesce,
  startRuntimeAfterPreflights,
} from "../src/commands/deploy.js";

function bot(strategyId: string): BotConfig {
  return parseBotConfig({
    id: "maker-1",
    venue: "polymarket",
    strategy: { id: strategyId, config: {} },
  });
}

describe("market-make deploy safety", () => {
  it("derives a stable non-secret identity from the exact saved deployment", () => {
    const deployment = {
      provider: "digitalocean" as const,
      dropletId: 1234,
      host: "203.0.113.8",
      region: "sgp1",
      size: "s-1vcpu-1gb",
      user: "root",
      deployedAt: "2026-08-31T12:00:00.000Z",
    };
    const first = deploymentIdFor(deployment);

    expect(first).toMatch(/^do-1234-[0-9a-f]{24}$/);
    expect(deploymentIdFor({ ...deployment })).toBe(first);
    expect(deploymentIdFor({ ...deployment, deployedAt: "2026-08-31T12:01:00.000Z" })).not.toBe(first);
  });

  it("starts halted and leaves reconciliation unapplied for later hash-bound operator review", () => {
    const calls: Array<{ method: string; path: string; body?: string }> = [];
    const result = startRuntimeAfterPreflights(bot("market-make"), (method, path, body) => {
      calls.push({ method, path, body });
      if (path === "/init") return { ok: true };
      if (path === "/market-make/status") return { lifecycle: "HALTED" };
      throw new Error(`unexpected route ${path}`);
    });

    expect(calls).toEqual([
      { method: "POST", path: "/init", body: undefined },
      { method: "GET", path: "/market-make/status", body: undefined },
    ]);
    expect(result.marketMakeStatus?.lifecycle).toBe("HALTED");
  });

  it("fails closed if startup activates a market-maker", () => {
    expect(() =>
      startRuntimeAfterPreflights(bot("market-make"), (_method, path) => {
        if (path === "/init") return { ok: true };
        return { lifecycle: "ACTIVE" };
      }),
    ).toThrow(/expected HALTED/);
  });

  it("retains resume-then-init behavior for other strategies", () => {
    const paths: string[] = [];
    startRuntimeAfterPreflights(bot("signals"), (_method, path) => {
      paths.push(path);
      return { ok: true };
    });
    expect(paths).toEqual(["/resume", "/init"]);
  });

  it("refuses strict replacement before systemd stop when control shutdown fails", () => {
    const cfg: BotConfig = {
      ...bot("market-make"),
      deployment: {
        provider: "digitalocean",
        dropletId: 1234,
        host: "203.0.113.8",
        region: "sgp1",
        size: "s-1vcpu-1gb",
        user: "root",
        deployedAt: "2026-08-31T12:00:00.000Z",
      },
    };
    const commands: string[] = [];

    expect(() => quiesce(cfg, true, {
      exec: (_target, command) => {
        commands.push(command);
        return { ok: true, code: 0, stdout: "", stderr: "" };
      },
      control: () => {
        throw new Error("shutdown returned HTTP 500");
      },
    })).toThrow(/shutdown cancellation was not verified/);
    // Reachability probe, then the liveness probe that distinguishes a still
    // running service from one an earlier interrupted redeploy already stopped.
    expect(commands).toEqual(["true", "systemctl is-active --quiet cassie@maker-1"]);
  });

  it("continues a strict replacement when the service was already stopped by an earlier redeploy", () => {
    const cfg: BotConfig = {
      ...bot("market-make"),
      deployment: {
        provider: "digitalocean",
        dropletId: 1234,
        host: "203.0.113.8",
        region: "sgp1",
        size: "s-1vcpu-1gb",
        user: "root",
        deployedAt: "2026-08-31T12:00:00.000Z",
      },
    };
    const commands: string[] = [];

    expect(() => quiesce(cfg, true, {
      exec: (_target, command) => {
        commands.push(command);
        const ok = !command.startsWith("systemctl is-active");
        return { ok, code: ok ? 0 : 3, stdout: "", stderr: "" };
      },
      control: () => {
        throw new Error("connect ECONNREFUSED");
      },
    })).not.toThrow();
    expect(commands).toEqual([
      "true",
      "systemctl is-active --quiet cassie@maker-1",
      "systemctl stop cassie@maker-1",
    ]);
  });

  it("includes same-droplet market-make redeploys in durable state preservation", () => {
    const cfg: BotConfig = {
      ...bot("market-make"),
      deployment: {
        provider: "digitalocean",
        dropletId: 1234,
        host: "203.0.113.8",
        region: "sgp1",
        size: "s-1vcpu-1gb",
        user: "root",
        deployedAt: "2026-08-31T12:00:00.000Z",
      },
    };

    expect(marketMakeStateSource(cfg, true, null)).toBe(cfg);
    expect(marketMakeStateSource(bot("signals"), true, null)).toBeNull();
  });
});

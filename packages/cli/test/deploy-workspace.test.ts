// packages/cli/test/deploy-workspace.test.ts
// Workspace activation preserves deployment safety without registry installs on code updates.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseBotConfig } from "@quotient-forecasting/cassie-core";

const f = vi.hoisted(() => ({
  events: [] as string[],
  commands: [] as string[],
  environments: [] as string[],
  cfg: undefined as unknown,
  existing: true,
  dropletRegion: "sgp1",
  namedDropletId: null as number | null,
  surplusReady: false,
  buildFails: false,
  stageFails: false,
  buildId: "a".repeat(64),
  artifact: { id: "a".repeat(64), dependencyId: "b".repeat(64), version: "1.2.3", pnpmVersion: "10.15.0", archiveBase64: "YXJ0aWZhY3Q=" },
  createdUserData: "",
}));

vi.mock("../src/context.js", () => ({
  buildRuntimeCreds: async () => ({ venue: "fixture" }),
  confirm: async () => true,
  getKeystoreSecret: async () => null,
}));
vi.mock("../src/paths.js", () => ({
  dirs: { state: () => "/tmp/cassie-deploy-test" },
  loadBotConfig: () => f.cfg,
  saveBotConfig: (cfg: unknown) => { f.cfg = cfg; f.events.push("save-config"); },
  atomicWritePrivateFile: () => { f.events.push("preserve-state"); },
}));
vi.mock("../src/quotient-token.js", () => ({ resolveQuotientToken: async () => ({ token: "test-token", origin: "test" }) }));
vi.mock("../src/polymarket-gasless.js", () => ({ resolvePolymarketGaslessAuth: async () => ({ kind: "builder", key: "gasless-key", secret: "gasless-secret", passphrase: "gasless-passphrase" }) }));
vi.mock("../src/surplus-config.js", () => ({ resolveSurplusApiKey: async () => f.surplusReady ? { value: "fixture-surplus-key", origin: "test" } : null, verifySurplusApiKey: async () => {} }));
vi.mock("../src/version.js", () => ({ cliVersion: () => "1.2.3" }));
vi.mock("../src/workspace-runtime.js", () => ({
  buildWorkspaceRuntime: () => {
    f.events.push("build");
    if (f.buildFails) throw new Error("local build failed");
    return f.artifact;
  },
  stageWorkspaceRuntime: () => {
    f.events.push("stage");
    if (f.stageFails) throw new Error("staged import failed");
    return { releasePath: `/opt/cassie/releases/${f.artifact.id}`, id: f.artifact.id };
  },
  activateWorkspaceRuntime: () => { f.events.push("activate"); },
}));
vi.mock("../src/digitalocean.js", () => {
  const droplet = (id: number) => ({
    id, name: "cassie-workspace-bot", status: "active", region: { slug: f.dropletRegion, name: "Singapore" },
    size_slug: "s-1vcpu-1gb", created_at: "2026-09-04T00:00:00Z",
    networks: { v4: [{ type: "public", ip_address: "203.0.113.10" }] },
  });
  return {
    DigitalOcean: class {},
    publicIpv4: () => "203.0.113.10",
    ensureDigitalOceanReady: async () => {
      f.events.push("digitalocean");
      return { client: {
        regions: async () => [{ slug: "sgp1", name: "Singapore", sizes: ["s-1vcpu-1gb"] }],
        droplet: async (id: number) => droplet(id),
        dropletByName: async () => f.namedDropletId === null ? null : droplet(f.namedDropletId),
        upsertSshKey: async () => 1,
        createDroplet: async (args: { userData: string }) => {
          f.events.push("create"); f.createdUserData = args.userData; return droplet(2);
        },
        deleteDroplet: async () => { f.events.push("delete"); },
        upsertFirewall: async () => {},
      } };
    },
  };
});
vi.mock("../src/ssh.js", () => ({
  ControlApiError: class extends Error { constructor(message: string, readonly body?: unknown) { super(message); } },
  ensureKeypair: () => ({ publicKey: "test-public-key" }),
  forgetHostKey: () => {}, pinHostKey: async () => {},
  sshExec: (_target: unknown, command: string) => {
    f.commands.push(command);
    if (command.startsWith("systemctl stop")) f.events.push("stop");
    return { ok: true, code: 0, stderr: "", stdout: command.includes("tar -C /var/lib/cassie") ? "c3RhdGU=" :
      command.includes("--version") ? "1.2.3" : command.includes("/health") ? '{"ok":true}' : "" };
  },
  sshExecOrThrow: (_target: unknown, command: string, stdin?: string) => {
    f.commands.push(command);
    if (command.includes("enable --now")) f.events.push("start");
    if (command.includes("base64 --decode | tar -xzf")) f.events.push("restore-state");
    if (command.includes("workspace-bot.env.tmp") && stdin) f.environments.push(stdin);
    return "";
  },
  controlCall: (_target: unknown, _bot: string, method: string, path: string) => {
    f.events.push(`${method} ${path}`);
    if (path === "/shutdown") return { stopped: true, restingOrdersCanceled: true };
    if (path === "/orders") return [];
    if (path === "/runtime") return { runtime: "droplet", region: "sgp1", requiredRegion: "sgp1", version: "1.2.3", buildId: f.buildId };
    if (path === "/execution/status") return { parents: [], blocked: false };
    if (path === "/geoblock/check") return { blocked: false, country: "SG" };
    if (path === "/signals/check") return { count: 0 };
    return { ok: true, tickIntervalMin: 1 };
  },
}));

import { runDeploy } from "../src/commands/deploy.js";

function config(deployed = true) {
  return parseBotConfig({
    id: "workspace-bot", venue: "polymarket", strategy: { id: "signals", config: {} },
    account: { venue: "polymarket", signerAddress: "test-signer", funder: "test-funder" },
    ...(deployed ? { deployment: {
      provider: "digitalocean", dropletId: 1, host: "203.0.113.10", region: "sgp1", size: "s-1vcpu-1gb", user: "root",
    } } : {}),
  });
}

beforeEach(() => {
  f.events.length = 0; f.commands.length = 0; f.environments.length = 0;
  f.cfg = config(); f.existing = true; f.buildFails = false; f.stageFails = false;
  f.dropletRegion = "sgp1"; f.namedDropletId = null; f.surplusReady = false;
  f.buildId = f.artifact.id; f.createdUserData = "";
});

describe("workspace deployment integration", () => {
  it.each(["signals", "quotient-swing"])("refuses conflicting saved and same-name droplets before touching either %s runtime", async strategy => {
    f.cfg = parseBotConfig({ ...config(), ...(strategy === "quotient-swing" ? {
      venue: "hyperliquid", strategy: { id: strategy, config: {} },
      account: { venue: "hyperliquid", masterAddress: "0x0000000000000000000000000000000000000001" },
    } : {}) });
    f.dropletRegion = "nyc1"; f.namedDropletId = 2; f.surplusReady = true;
    await expect(runDeploy("workspace-bot", { fromWorkspace: true, yes: true, region: "sgp1" })).rejects.toThrow("saved deployment and same-name droplet differ");
    for (const event of ["stage", "POST /shutdown", "stop", "preserve-state", "delete", "create", "activate", "save-config"]) {
      expect(f.events).not.toContain(event);
    }
    expect(f.commands).toEqual([]);
  });

  it("builds locally before remote work and leaves the running bot alone on build failure", async () => {
    f.buildFails = true;
    await expect(runDeploy("workspace-bot", { fromWorkspace: true, yes: true })).rejects.toThrow("local build failed");
    expect(f.events).toEqual(["build"]);
    expect(f.commands).toEqual([]);
  });

  it("leaves the old runtime running if staging or smoke validation fails", async () => {
    f.stageFails = true;
    await expect(runDeploy("workspace-bot", { fromWorkspace: true, yes: true })).rejects.toThrow("staged import failed");
    expect(f.events).toContain("stage");
    expect(f.events).not.toContain("POST /shutdown");
    expect(f.events).not.toContain("activate");
  });

  it("stages before shutdown, preserves state, then activates without an npm install", async () => {
    await runDeploy("workspace-bot", { fromWorkspace: true, yes: true });
    const order = ["build", "digitalocean", "stage", "POST /shutdown", "GET /orders", "stop", "preserve-state", "activate", "start", "GET /runtime", "POST /resume"];
    for (let i = 1; i < order.length; i++) expect(f.events.indexOf(order[i]!)).toBeGreaterThan(f.events.indexOf(order[i - 1]!));
    expect(f.commands.join("\n")).not.toContain("npm install");
    expect(f.commands.join("\n")).toContain("cassie@workspace-bot.service.d/workspace-runtime.conf");
    expect(f.environments[0]).toContain('CASSIE_AUTOSTART="0"');
    expect(f.environments.at(-1)).toContain('CASSIE_AUTOSTART="1"');
    expect(f.environments.join("\n")).not.toContain("CASSIE_RUNTIME_BUILD");
    expect(f.environments[0]).toContain("CASSIE_POLYMARKET_GASLESS_AUTH=");
    expect(f.environments.at(-1)).toContain("gasless-secret");
    expect(JSON.stringify(f.cfg)).not.toContain("gasless-secret");
    expect(f.commands.join("\n")).not.toContain("gasless-secret");
    expect(f.createdUserData).not.toContain("gasless-secret");
  });

  it("refuses a mismatched runtime artifact before granting trading authority", async () => {
    f.buildId = "c".repeat(64);
    await expect(runDeploy("workspace-bot", { fromWorkspace: true, yes: true })).rejects.toThrow(/expected workspace build/);
    expect(f.events).not.toContain("POST /resume");
    expect(f.events).not.toContain("POST /init");
    expect(f.environments).toHaveLength(1);
    expect(f.environments[0]).toContain('CASSIE_AUTOSTART="0"');
    expect(f.commands.some(command => command.includes("rm") && command.includes("/opt/cassie"))).toBe(false);
  });

  it("bootstraps a new host without requiring an npm runtime binary before staging", async () => {
    f.cfg = config(false);
    await runDeploy("workspace-bot", { fromWorkspace: true, yes: true, region: "sgp1" });
    expect(f.createdUserData).toContain("awaiting workspace runtime");
    expect(f.createdUserData).not.toContain("npm install");
    expect(f.commands.some(command => command.includes(".provisioned") && command.includes("command -v node"))).toBe(true);
    expect(f.commands.some(command => command.includes(".provisioned") && command.includes("command -v cassie-runtime"))).toBe(false);
    expect(f.events.indexOf("stage")).toBeGreaterThan(f.events.indexOf("create"));
    expect(f.events.indexOf("start")).toBeGreaterThan(f.events.indexOf("activate"));
  });

  it("returns npm deployment to its base executable by removing only this bot's override", async () => {
    await runDeploy("workspace-bot", { yes: true });
    expect(f.events).not.toContain("build");
    expect(f.events).not.toContain("stage");
    expect(f.events).not.toContain("activate");
    expect(f.commands).toContain("rm -f '/etc/systemd/system/cassie@workspace-bot.service.d/workspace-runtime.conf'");
    expect(f.commands.filter(command => command.startsWith("rm"))).toHaveLength(1);
  });
});

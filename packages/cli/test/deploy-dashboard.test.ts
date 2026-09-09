// packages/cli/test/deploy-dashboard.test.ts
// The deploy-side dashboard helpers: shell strings carry no secret, env lines
// appear only when the dashboard is on, and the password resolves in order.

import { describe, expect, it } from "vitest";
import { parseBotConfig } from "@quotient-forecasting/cassie-core";
import {
  assertIpv4,
  authFilePath,
  dashboardAuthFile,
  dashboardDisableCommands,
  dashboardEnvLines,
  dashboardOn,
  dashboardProvisionCommands,
  dashboardStatusText,
  parseFingerprint,
  resolveDashboardConfig,
  verifyDashboardCommand,
  type ResolveDashboardDeps,
} from "../src/dashboard/provision.js";

const HASH = "scrypt$32768$c2FsdA==$aGFzaA==";
const SECRET = "hunter22-hunter22";

function cfg(dashboard?: Record<string, unknown>, deployed = false) {
  return parseBotConfig({
    id: "bot-1", venue: "polymarket",
    ...(dashboard ? { dashboard } : {}),
    ...(deployed ? { deployment: { provider: "digitalocean", dropletId: 1, host: "203.0.113.10", region: "blr1", size: "s-1vcpu-1gb" } } : {}),
  });
}

function fakeDeps(over: Partial<ResolveDashboardDeps> = {}): ResolveDashboardDeps & { asked: string[]; hashed: string[] } {
  const asked: string[] = [];
  const hashed: string[] = [];
  return {
    asked, hashed,
    resolveLocal: () => null,
    ask: async (message) => { asked.push(message); return SECRET; },
    isTty: () => true,
    hash: async (password) => { hashed.push(password); return HASH; },
    ...over,
  };
}

describe("provisioning commands", () => {
  it("creates the certificate once, opens the port, and never mentions a secret", () => {
    const commands = dashboardProvisionCommands("bot-1", "203.0.113.10", 8443);
    expect(commands[0]).toBe("install -d -m 0750 -o cassie -g cassie /etc/cassie/tls");
    expect(commands[1]).toMatch(/^test -s \/etc\/cassie\/tls\/cert\.pem && test -s \/etc\/cassie\/tls\/key\.pem \|\| openssl req -x509 /);
    expect(commands[1]).toContain("-subj '/CN=cassie-bot-1' -addext 'subjectAltName=IP:203.0.113.10'");
    expect(commands[2]).toContain("chmod 0600 /etc/cassie/tls/key.pem");
    expect(commands.at(-1)).toBe("ufw allow 8443/tcp");
    expect(commands.join("\n")).not.toMatch(/scrypt|passwordHash|hunter/);
    expect(dashboardProvisionCommands("bot-1", "203.0.113.10", 9443, { previousPort: 8443 })).toContain("ufw delete allow 8443/tcp || true");
    expect(dashboardProvisionCommands("bot-1", "203.0.113.10", 8443, { previousPort: 8443 })).not.toContain("ufw delete allow 8443/tcp || true");
  });

  it("rejects hosts, ports and ids that could reach the shell", () => {
    expect(() => assertIpv4("203.0.113.10; rm -rf /")).toThrow(/IPv4/);
    expect(() => assertIpv4("999.0.0.1")).toThrow(/IPv4/);
    expect(() => dashboardProvisionCommands("bot-1", "203.0.113.10", 80)).toThrow(/1024 to 65535/);
    expect(() => dashboardProvisionCommands("Bot;1", "203.0.113.10", 8443)).toThrow(/bot id/);
    expect(() => authFilePath("../x")).toThrow(/bot id/);
  });

  it("disables by closing the port and removing the hash, keeping the certificate", () => {
    expect(dashboardDisableCommands("bot-1", 8443)).toEqual(["ufw delete allow 8443/tcp || true", "rm -f /etc/cassie/bot-1.dashboard.json"]);
  });

  it("formats the auth file, the probe, and the fingerprint", () => {
    expect(dashboardAuthFile(HASH)).toBe(`{"passwordHash":"${HASH}"}\n`);
    expect(verifyDashboardCommand(8443)).toBe("curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/api/session");
    expect(parseFingerprint("sha256 Fingerprint=ab:cd:ef\n")).toBe("SHA256:AB:CD:EF");
    expect(parseFingerprint("")).toBeNull();
  });
});

describe("env lines and status", () => {
  it("emits the three variables only when enabled with a hash", () => {
    expect(dashboardEnvLines(cfg({ enabled: true, passwordHash: HASH }))).toEqual([
      ["CASSIE_DASHBOARD_PORT", "8443"],
      ["CASSIE_DASHBOARD_AUTH_FILE", "/etc/cassie/bot-1.dashboard.json"],
      ["CASSIE_DASHBOARD_TLS_DIR", "/etc/cassie/tls"],
    ]);
    expect(dashboardEnvLines(cfg({ enabled: false, passwordHash: HASH }))).toEqual([]);
    expect(dashboardEnvLines(cfg({ enabled: true }))).toEqual([]);
    expect(dashboardEnvLines(cfg())).toEqual([]);
    expect(dashboardOn(cfg({ passwordHash: HASH, port: 9443 }))).toBe(true);
  });

  it("describes the dashboard for cassie status", () => {
    expect(dashboardStatusText(cfg({ enabled: false }))).toBe("off");
    expect(dashboardStatusText(cfg())).toBe("not provisioned; cassie deploy bot-1");
    expect(dashboardStatusText(cfg({ passwordHash: HASH, port: 9443 }, true))).toBe("https://203.0.113.10:9443");
    expect(dashboardStatusText(cfg({ passwordHash: HASH }))).toBe("set; deploy to serve it");
  });
});

describe("resolveDashboardConfig", () => {
  it("prefers the local env value and re-hashes it", async () => {
    const deps = fakeDeps({ resolveLocal: () => ({ value: SECRET, origin: "~/.local.env", source: "local-env", name: "CASSIE_DASHBOARD_PASSWORD" }) });
    const out = await resolveDashboardConfig(cfg({ passwordHash: "old" }), {}, deps);
    expect(out).toEqual({ config: { enabled: true, port: 8443, passwordHash: HASH }, passwordOrigin: "~/.local.env" });
    expect(deps.hashed).toEqual([SECRET]);
    expect(deps.asked).toEqual([]);
  });

  it("reuses a saved hash without prompting", async () => {
    const deps = fakeDeps();
    const out = await resolveDashboardConfig(cfg({ passwordHash: "saved-hash", port: 9443 }), {}, deps);
    expect(out).toEqual({ config: { enabled: true, port: 9443, passwordHash: "saved-hash" }, passwordOrigin: "saved" });
    expect(deps.asked).toEqual([]);
  });

  it("prompts twice in a terminal and checks length and agreement", async () => {
    const deps = fakeDeps();
    const out = await resolveDashboardConfig(cfg(), {}, deps);
    expect(out).toEqual({ config: { enabled: true, port: 8443, passwordHash: HASH }, passwordOrigin: "prompt" });
    expect(deps.asked).toHaveLength(2);

    let answers = ["short", "short"];
    const short = fakeDeps({ ask: async () => answers.shift()! });
    await expect(resolveDashboardConfig(cfg(), {}, short)).rejects.toThrow(/at least 8/);

    answers = [SECRET, "different-secret"];
    const mismatch = fakeDeps({ ask: async () => answers.shift()! });
    await expect(resolveDashboardConfig(cfg(), {}, mismatch)).rejects.toThrow(/do not match/);

    const blank = fakeDeps({ ask: async () => "" });
    expect(await resolveDashboardConfig(cfg(), {}, blank)).toEqual({ config: { enabled: true, port: 8443 }, skipped: "no dashboard password given" });
  });

  it("skips without persisting a disable when there is no terminal and no password", async () => {
    const out = await resolveDashboardConfig(cfg(), {}, fakeDeps({ isTty: () => false }));
    expect(out.config).toEqual({ enabled: true, port: 8443 });
    expect(out.skipped).toMatch(/CASSIE_DASHBOARD_PASSWORD/);
  });

  it("honours --no-dashboard, keeps the hash, and lets --dashboard-port re-enable", async () => {
    const deps = fakeDeps();
    expect(await resolveDashboardConfig(cfg({ passwordHash: "h" }), { dashboard: false }, deps)).toEqual({ config: { enabled: false, port: 8443, passwordHash: "h" } });
    expect(deps.asked).toEqual([]);
    expect(await resolveDashboardConfig(cfg({ enabled: false, passwordHash: "h" }), {}, deps)).toEqual({ config: { enabled: false, port: 8443, passwordHash: "h" } });
    expect(await resolveDashboardConfig(cfg({ enabled: false, passwordHash: "h" }), { dashboardPort: 9443 }, deps)).toEqual({ config: { enabled: true, port: 9443, passwordHash: "h" }, passwordOrigin: "saved" });
    expect(await resolveDashboardConfig(cfg({ enabled: false, passwordHash: "h" }), { dashboard: true }, deps)).toMatchObject({ config: { enabled: true } });
  });
});

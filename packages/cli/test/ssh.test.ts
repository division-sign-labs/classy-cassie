// packages/cli/test/ssh.test.ts

import { describe, expect, it } from "vitest";
import { controlSocketPath, knownHostsPath, keyPath, sshArgs } from "../src/ssh.js";

const target = { host: "203.0.113.10", user: "root" };

describe("sshArgs", () => {
  const args = sshArgs(target);

  it("refuses an unrecognized host key instead of prompting", () => {
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain(`UserKnownHostsFile=${knownHostsPath()}`);
  });

  it("uses only cassie's own key", () => {
    expect(args).toContain("IdentitiesOnly=yes");
    expect(args[args.indexOf("-i") + 1]).toBe(keyPath());
  });

  it("puts the destination last", () => {
    expect(args.at(-1)).toBe("root@203.0.113.10");
  });

  it("keeps extra options ahead of the destination", () => {
    const withExtra = sshArgs(target, ["-t"]);
    expect(withExtra.indexOf("-t")).toBeLessThan(withExtra.length - 1);
    expect(withExtra.at(-1)).toBe("root@203.0.113.10");
  });
});

describe("controlSocketPath", () => {
  it("gives each bot its own socket", () => {
    expect(controlSocketPath("bot-1")).toBe("/run/cassie/bot-1.sock");
    expect(controlSocketPath("bot-2")).not.toBe(controlSocketPath("bot-1"));
  });
});

describe("control API over curl", () => {
  it("builds the curl command with the status write-out on stderr", async () => {
    const { controlCurlCommand } = await import("../src/ssh.js");
    const get = controlCurlCommand("bot-1", "GET", "/dashboard?range=7d", false);
    expect(get).toContain("--fail-with-body");
    expect(get).toContain("--unix-socket /run/cassie/bot-1.sock");
    expect(get).toContain("-w '%{stderr}cassie-http-status=%{http_code}\\n'");
    expect(get).toContain("'http://localhost/dashboard?range=7d'");
    expect(get).not.toContain("--data-binary");
    expect(controlCurlCommand("bot-1", "POST", "pause", true)).toContain("--data-binary @- 'http://localhost/pause'");
  });

  it("parses a success body, and a failure into ControlApiError with status and body", async () => {
    const { ControlApiError, parseControlResult } = await import("../src/ssh.js");
    expect(parseControlResult({ ok: true, code: 0, stdout: '{"ok":true}\n', stderr: "cassie-http-status=200\n" })).toEqual({ ok: true });
    expect(parseControlResult({ ok: true, code: 0, stdout: "plain", stderr: "" })).toBe("plain");
    let error: unknown;
    try {
      parseControlResult({ ok: false, code: 22, stdout: '{"error":"unknown route GET /dashboard"}', stderr: "curl: (22) The requested URL returned error: 404\ncassie-http-status=404\n" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ControlApiError);
    expect((error as InstanceType<typeof ControlApiError>).status).toBe(404);
    expect((error as InstanceType<typeof ControlApiError>).body).toEqual({ error: "unknown route GET /dashboard" });
    expect((error as Error).message).not.toContain("cassie-http-status");
    expect(() => parseControlResult({ ok: false, code: null, stdout: "", stderr: "ssh failed: timed out after 25s" })).toThrow(/ssh failed: timed out/);
    try {
      parseControlResult({ ok: false, code: 22, stdout: "not json", stderr: "" });
    } catch (e) {
      expect((e as InstanceType<typeof ControlApiError>).body).toBeUndefined();
      expect((e as InstanceType<typeof ControlApiError>).status).toBeUndefined();
    }
  });
});

describe("remoteWriteCommand", () => {
  it("writes through a temporary path and keeps the content on stdin", async () => {
    const { remoteWriteCommand } = await import("../src/remote-write.js");
    expect(remoteWriteCommand("/etc/cassie/bot-1.env", "0600", "cassie:cassie")).toBe(
      "umask 077 && cat > '/etc/cassie/bot-1.env.tmp' && chown cassie:cassie '/etc/cassie/bot-1.env.tmp' && chmod 0600 '/etc/cassie/bot-1.env.tmp' && mv '/etc/cassie/bot-1.env.tmp' '/etc/cassie/bot-1.env'",
    );
  });
});

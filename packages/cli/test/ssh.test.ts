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

// packages/cli/test/cloud-init.test.ts

import { describe, expect, it } from "vitest";
import { DEFAULT_REGION, DEFAULT_SIZE, READY_MARKER, RUNTIME_PACKAGE, renderCloudInit } from "../src/cloud-init.js";

describe("renderCloudInit", () => {
  const rendered = renderCloudInit({ runtimeVersion: "1.2.3" });

  it("pins the runtime to the version it was given", () => {
    expect(rendered).toContain(`${RUNTIME_PACKAGE}@1.2.3`);
    expect(rendered).toContain("Environment=CASSIE_RUNTIME_VERSION=1.2.3");
  });

  it("carries no credential", () => {
    // Droplet user-data is served by the metadata service to anything on the
    // box, so a secret here would be readable by every process it runs.
    for (const name of [
      "CASSIE_BOT_CREDS",
      "QUOTIENT_API_TOKEN",
      "TELEGRAM_BOT_TOKEN",
      "ARES_API_KEY",
      "PRIVATE",
      "signerPk",
    ]) {
      expect(rendered).not.toContain(name);
    }
    expect(rendered).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  it("runs the bot as an unprivileged user under a template unit", () => {
    expect(rendered).toContain("/etc/systemd/system/cassie@.service");
    expect(rendered).toContain("User=cassie");
    expect(rendered).toContain("NoNewPrivileges=true");
    expect(rendered).toContain("EnvironmentFile=/etc/cassie/%i.env");
  });

  it("leaves the stop path enough time to cancel resting orders", () => {
    expect(rendered).toContain("KillSignal=SIGTERM");
    const timeout = Number(rendered.match(/TimeoutStopSec=(\d+)/)?.[1]);
    expect(timeout).toBeGreaterThanOrEqual(30);
  });

  it("opens ssh and nothing else", () => {
    expect(rendered).toContain("ufw default deny incoming");
    expect(rendered).toContain("ufw allow 22/tcp");
    expect(rendered).toContain("PasswordAuthentication no");
  });

  it("keeps the journal across reboots so `cassie logs` has history", () => {
    expect(rendered).toContain("Storage=persistent");
  });

  it("signals completion with a marker the deploy polls for", () => {
    expect(rendered).toContain(READY_MARKER);
  });

  it("defaults to a Singapore droplet", () => {
    // DigitalOcean has no Japan region; sgp1 is the nearest.
    expect(DEFAULT_REGION).toBe("sgp1");
    expect(DEFAULT_SIZE).toBe("s-1vcpu-1gb");
  });
});

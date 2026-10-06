// packages/cli/test/release-script.test.ts
import { describe, expect, it, vi } from "vitest";
import { publishRelease, registryVersion, waitForConsumerVisibility } from "../../../scripts/release.mjs";

const pkg = { name: "@quotient-forecasting/cassie", version: "0.4.20", bundled: ["@quotient-forecasting/cassie-core"] };
const registry = "https://registry.npmjs.org/";
const archive = { path: "/tmp/cassie.tgz", integrity: "sha512-checked-archive" };

describe("single-package release", () => {
  it("uploads once, waits for install visibility, then verifies the installed package", async () => {
    const events: string[] = [];
    await publishRelease(pkg, archive, registry, [], {
      lookup: async () => undefined,
      publish: async () => { events.push("publish"); },
      wait: async () => { events.push("visible"); },
      smoke: async () => { events.push("installed"); },
      log: (message: string) => { if (message.startsWith("release ready:")) events.push("ready"); },
    });
    expect(events).toEqual(["publish", "visible", "installed", "ready"]);
  });

  it("resumes an accepted archive without another publish or authentication prompt", async () => {
    const publish = vi.fn(), smoke = vi.fn();
    await publishRelease(pkg, archive, registry, [], {
      lookup: async () => ({ dist: { integrity: archive.integrity } }),
      publish, wait: vi.fn(), smoke, log: vi.fn(),
    });
    expect(publish).not.toHaveBeenCalled();
    expect(smoke).toHaveBeenCalledOnce();
  });

  it("rejects a version already published with different contents", async () => {
    const publish = vi.fn(), smoke = vi.fn();
    await expect(publishRelease(pkg, archive, registry, [], {
      lookup: async () => ({ dist: { integrity: "sha512-old-split-release" } }),
      publish, wait: vi.fn(), smoke, log: vi.fn(),
    })).rejects.toThrow("Bump the CLI version");
    expect(publish).not.toHaveBeenCalled();
    expect(smoke).not.toHaveBeenCalled();
  });

  it("does not report readiness when propagation or installation fails", async () => {
    for (const failAt of ["publish", "wait", "smoke"]) {
      const log = vi.fn();
      const operation = (name: string) => async () => { if (name === failAt) throw new Error(name); };
      await expect(publishRelease(pkg, archive, registry, [], {
        lookup: async () => undefined,
        publish: operation("publish"), wait: operation("wait"), smoke: operation("smoke"), log,
      })).rejects.toThrow(failAt);
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining("release ready:"));
    }
  });
});

describe("registry visibility", () => {
  it("uses fresh metadata to identify an already accepted version", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ versions: { [pkg.version]: { dist: { integrity: archive.integrity } } } })));
    await expect(registryVersion(registry, pkg, { fetchImpl })).resolves.toEqual({ dist: { integrity: archive.integrity } });
    const [url] = fetchImpl.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.has("cassie_release_check")).toBe(true);
  });

  it("checks npm install metadata without bypassing its registry cache URL", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ versions: {} })));
    await expect(registryVersion(registry, pkg, { consumer: true, fetchImpl })).resolves.toBeUndefined();
    const [url, options] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://registry.npmjs.org/@quotient-forecasting%2fcassie");
    expect(options.headers).toMatchObject({ accept: "application/vnd.npm.install-v1+json" });
  });

  it("distinguishes an unpublished package from registry errors", async () => {
    await expect(registryVersion(registry, pkg, {
      fetchImpl: async () => new Response("not found", { status: 404 }),
    })).resolves.toBeUndefined();
    await expect(registryVersion(registry, pkg, {
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    })).rejects.toThrow("HTTP 503");
  });

  it("waits through stale metadata and temporary network errors", async () => {
    let time = 0;
    const check = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ version: pkg.version });
    await waitForConsumerVisibility(registry, pkg, {
      timeoutMs: 10_000, check, now: () => time,
      sleep: async (ms: number) => { time += ms; }, log: vi.fn(),
    });
    expect(time).toBe(4_000);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("bounds the wait and gives a resumable failure", async () => {
    let time = 0;
    await expect(waitForConsumerVisibility(registry, pkg, {
      timeoutMs: 3_000, check: async () => undefined, now: () => time,
      sleep: async (ms: number) => { time += ms; }, log: vi.fn(),
    })).rejects.toThrow("Re-run pnpm release:publish");
    expect(time).toBe(3_000);
  });
});

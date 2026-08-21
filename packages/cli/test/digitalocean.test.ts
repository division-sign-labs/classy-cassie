// packages/cli/test/digitalocean.test.ts

import { afterEach, describe, expect, it, vi } from "vitest";
import { DigitalOcean, DigitalOceanError, publicIpv4, type Droplet } from "../src/digitalocean.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler: (url: string, init: RequestInit) => Response): ReturnType<typeof vi.fn> {
  const spy = vi.fn((url: string | URL | Request, init: RequestInit = {}) =>
    Promise.resolve(handler(String(url), init)),
  );
  vi.stubGlobal("fetch", spy);
  return spy as never;
}

const droplet = (over: Partial<Droplet> = {}): Droplet => ({
  id: 42,
  name: "cassie-bot-1",
  status: "active",
  region: { slug: "sgp1", name: "Singapore 1" },
  size_slug: "s-1vcpu-1gb",
  size: { price_monthly: 6 },
  created_at: "2026-08-20T00:00:00Z",
  networks: { v4: [{ ip_address: "10.0.0.1", type: "private" }, { ip_address: "203.0.113.10", type: "public" }] },
  tags: ["cassie"],
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("DigitalOcean.call", () => {
  it("sends the token as a bearer credential", async () => {
    const spy = stubFetch(() => jsonResponse(200, { account: { email: "a@b.c" } }));
    await new DigitalOcean("tok_123").account();
    const headers = (spy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok_123");
  });

  it("surfaces DigitalOcean's own message rather than raw JSON", async () => {
    stubFetch(() => jsonResponse(422, { id: "unprocessable_entity", message: "size is not available" }));
    await expect(new DigitalOcean("t").droplet(1)).rejects.toThrow("DigitalOcean 422: size is not available");
  });

  it("keeps the status code on the error so callers can branch on 401", async () => {
    stubFetch(() => jsonResponse(401, { message: "Unable to authenticate you" }));
    const error = await new DigitalOcean("t").account().catch((e) => e);
    expect(error).toBeInstanceOf(DigitalOceanError);
    expect((error as DigitalOceanError).status).toBe(401);
  });

  it("handles a 204 with no body", async () => {
    stubFetch(() => jsonResponse(204, null));
    await expect(new DigitalOcean("t").deleteDroplet(42)).resolves.toBeUndefined();
  });

  it("does not choke on a non-JSON error body from a proxy", async () => {
    stubFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    await expect(new DigitalOcean("t").droplet(1)).rejects.toThrow("DigitalOcean 502");
  });
});

describe("upsertSshKey", () => {
  it("reuses a key the account already carries", async () => {
    const spy = stubFetch((url) => {
      if (url.includes("/account/keys")) {
        return jsonResponse(200, {
          ssh_keys: [{ id: 7, name: "laptop", public_key: "ssh-ed25519 AAAAC3Nz cassie" }],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const id = await new DigitalOcean("t").upsertSshKey("cassie", "ssh-ed25519 AAAAC3Nz someone-else@host");
    expect(id).toBe(7);
    expect(spy).toHaveBeenCalledTimes(1); // no POST
  });

  it("registers the key when the account has none matching", async () => {
    const calls: string[] = [];
    stubFetch((url, init) => {
      calls.push(`${(init.method ?? "GET").toUpperCase()} ${url}`);
      if ((init.method ?? "GET") === "GET") return jsonResponse(200, { ssh_keys: [] });
      return jsonResponse(201, { ssh_key: { id: 99 } });
    });
    const id = await new DigitalOcean("t").upsertSshKey("cassie", "ssh-ed25519 AAAAC3Nz cassie\n");
    expect(id).toBe(99);
    expect(calls[1]).toContain("POST");
  });
});

describe("createDroplet", () => {
  it("passes region, size, key, and user-data through", async () => {
    const spy = stubFetch(() => jsonResponse(202, { droplet: droplet({ status: "new" }) }));
    await new DigitalOcean("t").createDroplet({
      name: "cassie-bot-1",
      region: "sgp1",
      size: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      sshKeyIds: [7],
      userData: "#cloud-config\n",
      tags: ["cassie"],
    });
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      name: "cassie-bot-1",
      region: "sgp1",
      size: "s-1vcpu-1gb",
      ssh_keys: [7],
      user_data: "#cloud-config\n",
      backups: false,
    });
  });
});

describe("firewall", () => {
  it("attaches an existing firewall rather than creating a second one", async () => {
    const calls: string[] = [];
    stubFetch((url, init) => {
      calls.push(`${(init.method ?? "GET").toUpperCase()} ${url}`);
      if (url.includes("/firewalls?")) return jsonResponse(200, { firewalls: [{ id: "fw-1", name: "cassie-bot-1" }] });
      return jsonResponse(204, null);
    });
    await new DigitalOcean("t").upsertFirewall("cassie-bot-1", 42);
    expect(calls[1]).toBe("POST https://api.digitalocean.com/v2/firewalls/fw-1/droplets");
  });

  it("opens ssh inbound and nothing else", async () => {
    const spy = stubFetch((url, init) => {
      if (url.includes("/firewalls?")) return jsonResponse(200, { firewalls: [] });
      return jsonResponse(202, { firewall: { id: "fw-2" } });
    });
    await new DigitalOcean("t").upsertFirewall("cassie-bot-1", 42);
    const body = JSON.parse((spy.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.inbound_rules).toHaveLength(1);
    expect(body.inbound_rules[0]).toMatchObject({ protocol: "tcp", ports: "22" });
  });
});

describe("publicIpv4", () => {
  it("picks the public address, not the private one", () => {
    expect(publicIpv4(droplet())).toBe("203.0.113.10");
  });

  it("returns null while the droplet is still provisioning", () => {
    expect(publicIpv4(droplet({ networks: { v4: [] } }))).toBeNull();
  });
});

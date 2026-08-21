// packages/cli/src/digitalocean.ts
// DigitalOcean API v2, over fetch. No doctl dependency: the CLI should work on
// a machine that has never installed anything but node.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import { ask, confirm, openUrl } from "./context.js";
import { atomicWritePrivateFile, dirs } from "./paths.js";

const API = "https://api.digitalocean.com/v2";
const TOKEN_PAGE = "https://cloud.digitalocean.com/account/api/tokens";

export interface Droplet {
  id: number;
  name: string;
  status: "new" | "active" | "off" | "archive";
  region: { slug: string; name: string };
  size_slug: string;
  size: { price_monthly: number };
  created_at: string;
  networks: { v4: Array<{ ip_address: string; type: "public" | "private" }> };
  tags: string[];
}

export interface Region {
  slug: string;
  name: string;
  available: boolean;
  sizes: string[];
}

export class DigitalOceanError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DigitalOceanError";
  }
}

export function tokenPath(): string {
  return join(dirs.home(), "digitalocean.token");
}

/** doctl stores its token in a YAML file; read it rather than making the user paste again. */
function tokenFromDoctl(): string | null {
  const path = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "doctl", "config.yaml");
  if (!existsSync(path)) return null;
  const match = readFileSync(path, "utf8").match(/^access-token:\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/m);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value && value.length > 0 ? value : null;
}

export function findToken(): { token: string; origin: string } | null {
  const fromEnv = process.env.DIGITALOCEAN_TOKEN ?? process.env.DIGITALOCEAN_ACCESS_TOKEN;
  if (fromEnv) return { token: fromEnv, origin: "environment" };
  const path = tokenPath();
  if (existsSync(path)) {
    const stored = readFileSync(path, "utf8").trim();
    if (stored.length > 0) return { token: stored, origin: path };
  }
  const fromDoctl = tokenFromDoctl();
  if (fromDoctl) return { token: fromDoctl, origin: "doctl config" };
  return null;
}

export class DigitalOcean {
  constructor(private readonly token: string) {}

  async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) detail = parsed.message;
      } catch {
        // Non-JSON error bodies (proxies, rate limiters) pass through as text.
      }
      throw new DigitalOceanError(response.status, `DigitalOcean ${response.status}: ${detail}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  account(): Promise<{ account: { email: string; status: string; droplet_limit: number } }> {
    return this.call("/account");
  }

  async regions(): Promise<Region[]> {
    const { regions } = await this.call<{ regions: Region[] }>("/regions?per_page=200");
    return regions.filter((r) => r.available);
  }

  /** Register the public key if the account does not already carry it. */
  async upsertSshKey(name: string, publicKey: string): Promise<number> {
    const { ssh_keys } = await this.call<{ ssh_keys: Array<{ id: number; public_key: string; name: string }> }>(
      "/account/keys?per_page=200",
    );
    const body = publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
    const existing = ssh_keys.find((k) => k.public_key.trim().split(/\s+/).slice(0, 2).join(" ") === body);
    if (existing) return existing.id;
    const created = await this.call<{ ssh_key: { id: number } }>("/account/keys", {
      method: "POST",
      body: JSON.stringify({ name, public_key: publicKey.trim() }),
    });
    return created.ssh_key.id;
  }

  async createDroplet(params: {
    name: string;
    region: string;
    size: string;
    image: string;
    sshKeyIds: number[];
    userData: string;
    tags: string[];
  }): Promise<Droplet> {
    const { droplet } = await this.call<{ droplet: Droplet }>("/droplets", {
      method: "POST",
      body: JSON.stringify({
        name: params.name,
        region: params.region,
        size: params.size,
        image: params.image,
        ssh_keys: params.sshKeyIds,
        user_data: params.userData,
        tags: params.tags,
        ipv6: true,
        monitoring: true,
        backups: false,
      }),
    });
    return droplet;
  }

  async droplet(id: number): Promise<Droplet> {
    const { droplet } = await this.call<{ droplet: Droplet }>(`/droplets/${id}`);
    return droplet;
  }

  async dropletByName(name: string): Promise<Droplet | null> {
    const { droplets } = await this.call<{ droplets: Droplet[] }>(`/droplets?per_page=200`);
    return droplets.find((d) => d.name === name) ?? null;
  }

  deleteDroplet(id: number): Promise<void> {
    return this.call(`/droplets/${id}`, { method: "DELETE" });
  }

  /** SSH in, everything out. The bot needs no inbound port of its own. */
  async upsertFirewall(name: string, dropletId: number): Promise<void> {
    const { firewalls } = await this.call<{ firewalls: Array<{ id: string; name: string }> }>("/firewalls?per_page=200");
    const existing = firewalls.find((f) => f.name === name);
    if (existing) {
      await this.call(`/firewalls/${existing.id}/droplets`, {
        method: "POST",
        body: JSON.stringify({ droplet_ids: [dropletId] }),
      });
      return;
    }
    await this.call("/firewalls", {
      method: "POST",
      body: JSON.stringify({
        name,
        droplet_ids: [dropletId],
        inbound_rules: [
          { protocol: "tcp", ports: "22", sources: { addresses: ["0.0.0.0/0", "::/0"] } },
        ],
        outbound_rules: [
          { protocol: "tcp", ports: "all", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
          { protocol: "udp", ports: "all", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
          { protocol: "icmp", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
        ],
      }),
    });
  }

  async deleteFirewall(name: string): Promise<void> {
    const { firewalls } = await this.call<{ firewalls: Array<{ id: string; name: string }> }>("/firewalls?per_page=200");
    const existing = firewalls.find((f) => f.name === name);
    if (existing) await this.call(`/firewalls/${existing.id}`, { method: "DELETE" });
  }
}

export function publicIpv4(droplet: Droplet): string | null {
  return droplet.networks?.v4?.find((n) => n.type === "public")?.ip_address ?? null;
}

/**
 * Get the operator from "I have never touched DigitalOcean" to a verified
 * token, before anything asks for the keystore passphrase.
 */
export async function ensureDigitalOceanReady(): Promise<{ client: DigitalOcean; email: string }> {
  const found = findToken();
  if (found) {
    const client = new DigitalOcean(found.token);
    try {
      const { account } = await client.account();
      console.log(pc.dim(`DigitalOcean account ${account.email} (token from ${found.origin})`));
      return { client, email: account.email };
    } catch (error) {
      if (!(error instanceof DigitalOceanError) || error.status !== 401) throw error;
      console.log(pc.yellow(`the DigitalOcean token from ${found.origin} was rejected`));
    }
  }

  console.log("");
  console.log(pc.bold("cassie needs a DigitalOcean API token."));
  console.log("Your bot runs on a droplet in an account you own and pay for.");
  console.log(pc.dim("cassie holds no infrastructure on your behalf. Your account, your bill, your kill switch."));
  console.log("");
  console.log(`Create a token with read and write scope at ${pc.cyan(TOKEN_PAGE)}`);
  if (await confirm("Open that page now?", true)) openUrl(TOKEN_PAGE);

  const token = (await ask("Paste the token", { secret: true })).trim();
  if (!token) throw new Error("no token entered — run `cassie deploy` again when you have one");
  const client = new DigitalOcean(token);
  const { account } = await client.account();
  const at = tokenPath();
  atomicWritePrivateFile(at, token);
  console.log(pc.green(`token accepted for ${account.email}`));
  console.log(pc.dim(`stored at ${at} (0600)`));
  return { client, email: account.email };
}

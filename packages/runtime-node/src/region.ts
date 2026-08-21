// packages/runtime-node/src/region.ts
// Where this host says it is. DigitalOcean's metadata service answers on a
// link-local address reachable only from inside the droplet, so the answer is
// the platform's, not something the deploy handed us.

const METADATA_REGION = "http://169.254.169.254/metadata/v1/region";
const METADATA_ID = "http://169.254.169.254/metadata/v1/id";

async function metadata(url: string, timeoutMs: number): Promise<string | null> {
  const abort = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { signal: abort });
    if (!response.ok) return null;
    const text = (await response.text()).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export async function dropletRegion(timeoutMs = 3_000): Promise<string | null> {
  return metadata(METADATA_REGION, timeoutMs);
}

export async function dropletId(timeoutMs = 3_000): Promise<string | null> {
  return metadata(METADATA_ID, timeoutMs);
}

/**
 * Refuse to trade from anywhere but the region the deploy pinned. Venue access
 * is decided by where the orders leave from, so a host that cannot prove its
 * region does not get to place them.
 */
export async function requireRegion(required: string): Promise<string> {
  const actual = await dropletRegion();
  if (actual === null) {
    throw new Error(
      `cannot confirm this host's region (DigitalOcean metadata unreachable); ${required} was required`,
    );
  }
  if (actual !== required) {
    throw new Error(`refusing to run outside required region ${required}; this droplet is in ${actual}`);
  }
  return actual;
}

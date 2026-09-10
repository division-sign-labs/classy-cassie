// packages/runtime-node/src/dashboard/password.ts
// scrypt hashing for the hosted dashboard password. The hash lives in the bot
// config locally and in /etc/cassie/<botId>.dashboard.json on the droplet; the
// password itself is never written anywhere.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const DASHBOARD_SCRYPT = { N: 1 << 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32, maxmem: 128 * 1024 * 1024 } as const;
const MIN_N = 1 << 14;
const MAX_N = 1 << 20;

function derive(password: string, salt: Buffer, N: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, { N, r: DASHBOARD_SCRYPT.r, p: DASHBOARD_SCRYPT.p, maxmem: DASHBOARD_SCRYPT.maxmem }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** `scrypt$<N>$<saltB64>$<hashB64>` */
export async function hashDashboardPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length === 0) throw new Error("dashboard password must not be empty");
  const salt = randomBytes(DASHBOARD_SCRYPT.saltBytes);
  const key = await derive(password, salt, DASHBOARD_SCRYPT.N, DASHBOARD_SCRYPT.keyBytes);
  return `scrypt$${DASHBOARD_SCRYPT.N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** False for a wrong password and for any malformed stored value; never throws. */
export async function verifyDashboardPassword(password: string, stored: string): Promise<boolean> {
  try {
    if (typeof password !== "string" || typeof stored !== "string") return false;
    const parts = stored.split("$");
    if (parts.length !== 4 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    if (!Number.isInteger(N) || N < MIN_N || N > MAX_N || (N & (N - 1)) !== 0) return false;
    const salt = Buffer.from(parts[2]!, "base64");
    const expected = Buffer.from(parts[3]!, "base64");
    if (salt.length < 8 || expected.length < 16) return false;
    const actual = await derive(password, salt, N, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function parseDashboardAuthFile(text: string): { passwordHash: string } {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object") throw new Error("dashboard auth file must be a JSON object");
  const hash = (value as { passwordHash?: unknown }).passwordHash;
  if (typeof hash !== "string" || hash.length === 0) throw new Error("dashboard auth file needs a passwordHash string");
  return { passwordHash: hash };
}

// packages/core/src/polymarket/gasless-auth.ts
// Service authorization for Polymarket redemption, separate from trading credentials.
import { z } from "zod";

const secret = z.string().trim().min(1).regex(/^[^\r\n]+$/);
const schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builder"), key: secret, secret, passphrase: secret }).strict(),
  z.object({ kind: z.literal("relayer"), key: secret, address: z.string().regex(/^0x[\da-fA-F]{40}$/) }).strict(),
]);

export type PolymarketGaslessAuth = z.infer<typeof schema>;

/** Do not include malformed secret input or Zod diagnostics in errors. */
export function parsePolymarketGaslessAuth(raw: string): PolymarketGaslessAuth {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch { /* Report only the credential type. */ }
  throw new Error("invalid Polymarket Builder/Relayer credential");
}

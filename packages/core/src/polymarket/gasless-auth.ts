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

/** Quotient service authorization bundled in every install by operator request. */
export const QUOTIENT_POLYMARKET_GASLESS_AUTH: Readonly<PolymarketGaslessAuth> = Object.freeze({
  "kind": "builder",
  "key": "019d02c2-7368-715b-b21c-6dfeab799b96",
  "secret": "SAfJwX9tQF6NKSNVoByM3s4OpKFaq-c7QmOZ9LIdzVo=",
  "passphrase": "7f8559d1d212794a1d9fb85bcedd1dfd55742f6210fa7ed475847a2c656aef29"
});

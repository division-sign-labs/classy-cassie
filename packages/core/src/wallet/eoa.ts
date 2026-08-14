// packages/core/src/wallet/eoa.ts
// Per-bot EOA generation (§4): independently generated, no HD derivation from
// a shared seed — one key = one bot = trivial export semantics.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export interface GeneratedEoa {
  privateKey: string;
  address: string;
}

export function generateEoa(): GeneratedEoa {
  const pk = generatePrivateKey();
  return { privateKey: pk, address: privateKeyToAccount(pk).address };
}

export function addressFromPk(pk: string): string {
  return privateKeyToAccount(pk as `0x${string}`).address;
}

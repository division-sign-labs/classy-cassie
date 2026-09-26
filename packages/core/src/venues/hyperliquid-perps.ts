// packages/core/src/venues/hyperliquid-perps.ts
// Pure Hyperliquid contract normalization. Signing stays in the pinned SDK.

/** Preserve the complete HIP-3 name: a symbol on another DEX is another market. */
export function hyperliquidDex(coin: string): string {
  if (!coin || coin.trim() !== coin) throw new Error("invalid Hyperliquid instrument name");
  const parts = coin.split(":");
  if (parts.length === 1) return "";
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid Hyperliquid instrument name");
  return parts[0];
}

export function hyperliquidAssetId(dexIndex: number, indexInMeta: number): number {
  if (!Number.isSafeInteger(dexIndex) || dexIndex < 0 || !Number.isSafeInteger(indexInMeta) || indexInMeta < 0 || indexInMeta >= 10_000) {
    throw new Error("invalid Hyperliquid asset index");
  }
  return dexIndex === 0 ? indexInMeta : 100_000 + dexIndex * 10_000 + indexInMeta;
}

export function finiteNumber(value: unknown, label: string): number {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && value.trim() === "")) throw new Error(`invalid Hyperliquid ${label}`);
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`invalid Hyperliquid ${label}`);
  return n;
}

export function nonnegativeNumber(value: unknown, label: string): number {
  const n = finiteNumber(value, label);
  if (n < 0) throw new Error(`invalid Hyperliquid ${label}`);
  return n;
}

export function positiveNumber(value: unknown, label: string): number {
  const n = finiteNumber(value, label);
  if (n <= 0) throw new Error(`invalid Hyperliquid ${label}`);
  return n;
}

/** Round toward the allowed side of a price bound, never increasing slippage. */
export function formatBoundedHlPrice(px: number, szDecimals: number, side: "BUY" | "SELL"): string {
  positiveNumber(px, "price");
  if (!Number.isInteger(szDecimals) || szDecimals < 0 || szDecimals > 6) throw new Error("invalid Hyperliquid size decimals");
  const decimals = Math.max(0, Math.min(6 - szDecimals, 4 - Math.floor(Math.log10(px))));
  const scale = 10 ** decimals;
  const rounded = (side === "BUY" ? Math.floor(px * scale) : Math.ceil(px * scale)) / scale;
  if (rounded <= 0) throw new Error("Hyperliquid price rounds to zero");
  return String(Number(rounded.toFixed(decimals)));
}

/** Fee rates are decimal not percentages; never credit a speculative maker rebate. */
export function hyperliquidFeeRates(input: {
  maker: number;
  taker: number;
  referralDiscount: number;
  dexIndex: number;
  deployerFeeScale: number;
  growthMode: boolean;
}): { maker: number; taker: number } {
  const { maker, taker, referralDiscount, dexIndex, deployerFeeScale, growthMode } = input;
  finiteNumber(maker, "maker fee");
  nonnegativeNumber(taker, "taker fee");
  nonnegativeNumber(deployerFeeScale, "deployer fee scale");
  if (!Number.isFinite(referralDiscount) || referralDiscount < 0 || referralDiscount > 1 || deployerFeeScale > 3) {
    throw new Error("invalid Hyperliquid fee configuration");
  }
  const hip3Scale = dexIndex === 0 ? 1 : deployerFeeScale < 1 ? 1 + deployerFeeScale : 2 * deployerFeeScale;
  const scale = hip3Scale * (growthMode ? 0.1 : 1) * (1 - referralDiscount);
  return { maker: Math.max(0, maker) * scale, taker: taker * scale };
}

/** Funding and trading P&L are deliberately not external strategy cash flows. */
export function hyperliquidDexCashFlow(delta: Record<string, unknown>, user: string, dex: string): number | undefined {
  const same = (a: unknown) => typeof a === "string" && a.toLowerCase() === user.toLowerCase();
  const amount = () => nonnegativeNumber(delta.amount ?? delta.usdc, "cash flow amount");
  if (delta.type === "send") {
    if (typeof delta.sourceDex !== "string" || typeof delta.destinationDex !== "string" || typeof delta.user !== "string" || typeof delta.destination !== "string") {
      throw new Error("invalid Hyperliquid cash-flow identity");
    }
    const incoming = same(delta.destination) && delta.destinationDex === dex;
    const outgoing = same(delta.user) && delta.sourceDex === dex;
    if (!incoming && !outgoing) return undefined;
    if (typeof delta.token !== "string" || delta.token.split(":")[0] !== "USDC") throw new Error("unsupported Hyperliquid strategy cash-flow collateral");
    return (Number(incoming) - Number(outgoing)) * amount();
  }
  if (delta.type === "activateDexAbstraction") {
    if (delta.dex === dex) throw new Error("Hyperliquid account abstraction changed within the cash-flow interval");
    return undefined;
  }
  const known = ["deposit", "withdraw", "accountClassTransfer", "internalTransfer", "subAccountTransfer", "liquidation", "rewardsClaim", "spotTransfer", "vaultCreate", "vaultDeposit", "vaultDistribution", "vaultWithdraw", "deployGasAuction", "cStakingTransfer", "borrowLend", "spotGenesis", "vaultLeaderCommission"];
  if (!known.includes(String(delta.type))) throw new Error("unsupported Hyperliquid cash-flow type");
  // The older transfer variants apply to the validator-operated USDC DEX only.
  if (dex !== "") return undefined;
  if (delta.type === "deposit") return amount();
  if (delta.type === "withdraw") return -amount();
  if (delta.type === "accountClassTransfer") {
    if (typeof delta.toPerp !== "boolean") throw new Error("invalid Hyperliquid cash-flow direction");
    return (delta.toPerp ? 1 : -1) * amount();
  }
  if (delta.type === "internalTransfer" || delta.type === "subAccountTransfer") {
    return (Number(same(delta.destination)) - Number(same(delta.user))) * amount();
  }
  // These legacy account operations are outside the scoped HIP-3 strategy.
  // Do not certify default-DEX accounting without a verified cash-flow mapping.
  if (["vaultCreate", "vaultDeposit", "vaultDistribution", "vaultWithdraw", "vaultLeaderCommission", "rewardsClaim"].includes(String(delta.type))) {
    throw new Error("unsupported Hyperliquid default-DEX cash-flow operation");
  }
  return undefined;
}

/** Unified USDC includes spot and every USDC perp DEX; transfers within it are not capital flows. */
export function hyperliquidUnifiedCashFlow(delta: Record<string, unknown>, user: string): number | undefined {
  const same = (a: unknown) => typeof a === "string" && a.toLowerCase() === user.toLowerCase();
  const usdc = () => typeof delta.token === "string" && delta.token.split(":")[0] === "USDC";
  if (delta.type === "send" || delta.type === "spotTransfer") {
    if (typeof delta.user !== "string" || typeof delta.destination !== "string" || typeof delta.token !== "string") throw new Error("invalid unified cash-flow identity");
    if (!usdc()) return undefined;
    return (Number(same(delta.destination)) - Number(same(delta.user))) * nonnegativeNumber(delta.amount, "cash flow amount");
  }
  if (delta.type === "accountClassTransfer" || delta.type === "activateDexAbstraction") return 0;
  if (delta.type === "liquidation") return undefined;
  if (["deposit", "withdraw", "internalTransfer", "subAccountTransfer"].includes(String(delta.type))) return hyperliquidDexCashFlow(delta, user, "");
  // Do not certify an interval with unrelated treasury, lending or vault operations.
  throw new Error("unsupported Hyperliquid unified cash-flow operation");
}

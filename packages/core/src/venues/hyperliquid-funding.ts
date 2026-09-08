// packages/core/src/venues/hyperliquid-funding.ts
// Reviewed 2026-09-05 against Hyperliquid's account-mode/Send Asset docs and SDK 0.33.3.
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
import type { ExchangeClient, InfoClient } from "@nktkas/hyperliquid";
import type { SetupContext } from "../types.js";

type FundingInfo = Pick<InfoClient, "userAbstraction" | "perpDexs" | "meta" | "spotMeta" |
  "clearinghouseState" | "openOrders" | "spotClearinghouseState" | "userNonFundingLedgerUpdates">;
export interface HyperliquidPerpFundingOptions {
  info: FundingInfo;
  /** Principal-signed SDK client; callers keep its master key local. */
  exchange: Pick<ExchangeClient, "userSetAbstraction" | "sendAsset">;
  context: Pick<SetupContext, "confirm" | "print">;
  masterAddress: `0x${string}`;
  destinationDex: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export interface HyperliquidPerpFundingResult {
  status: "ready" | "canceled";
  modeChanged: boolean;
  movedUsdc: string;
  nativeUsdc: string;
  destinationUsdc: string;
}
interface BalanceState {
  equity: bigint;
  withdrawable: bigint;
  occupied: boolean;
}
interface FundingView {
  mode: "default" | "disabled";
  native: BalanceState;
  destination: BalanceState;
}
const SCALE = 1_000_000n;

function usdc(value: unknown, label: string): bigint {
  if (typeof value !== "string" || value.length > 64 || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  const [whole, fractional = ""] = value.split(".");
  if (/[1-9]/.test(fractional.slice(6))) throw new Error(`Unsupported precision in ${label}.`);
  return BigInt(whole!) * SCALE + BigInt(fractional.slice(0, 6).padEnd(6, "0"));
}
function decimal(value: bigint): string {
  const fraction = (value % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${value / SCALE}${fraction ? `.${fraction}` : ""}`;
}
function finite(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
    throw new Error(`Invalid ${label}.`);
  }
  return Number(value);
}

/**
 * Move only the confirmed native withdrawable balance to the same user's DEX.
 * This never deposits from an external wallet, starts a bot, or retries a write.
 */
export async function prepareHyperliquidPerpFunding(options: HyperliquidPerpFundingOptions): Promise<HyperliquidPerpFundingResult> {
  const { info, exchange, context, masterAddress: user, destinationDex: dex } = options;
  const now = options.now ?? Date.now;
  if (!/^0x[0-9a-fA-F]{40}$/.test(user) || /^0x0{40}$/.test(user)) throw new Error("Invalid Hyperliquid master address.");
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(dex) || dex === "spot") throw new Error("Invalid destination perpetual DEX.");

  const [dexRows, metadata, spotMetadata] = await Promise.all([info.perpDexs(), info.meta({ dex }), info.spotMeta()]);
  if (!Array.isArray(dexRows) || dexRows[0] !== null || !dexRows.some(row => row?.name === dex)) throw new Error(`Unknown Hyperliquid DEX: ${dex}.`);
  if (metadata.collateralToken !== 0 || !Array.isArray(metadata.universe) || !metadata.universe.length ||
    metadata.universe.some(asset => !asset.name.startsWith(`${dex}:`))) throw new Error("Destination DEX must use USDC collateral.");
  const collateral = spotMetadata.tokens.filter(token => token.index === 0);
  if (collateral.length !== 1 || collateral[0]!.name !== "USDC" || !/^0x[0-9a-fA-F]{32}$/.test(collateral[0]!.tokenId)) {
    throw new Error("USDC token identity is not confirmed.");
  }
  const token = `USDC:${collateral[0]!.tokenId}`;

  const readBalance = async (targetDex: string): Promise<BalanceState> => {
    const [state, orders] = await Promise.all([
      info.clearinghouseState({ user, dex: targetDex }), info.openOrders({ user, dex: targetDex }),
    ]);
    if (!Number.isFinite(state.time) || now() - state.time > 60_000 || state.time > now() + 5_000) throw new Error("Hyperliquid funding state is stale.");
    if (!Array.isArray(state.assetPositions) || !Array.isArray(orders)) throw new Error("Hyperliquid exposure is not confirmed.");
    const occupied = orders.length > 0 || state.assetPositions.some(row => finite(row.position.szi, "position size") !== 0) ||
      finite(state.marginSummary.totalMarginUsed, "margin used") !== 0 || finite(state.marginSummary.totalNtlPos, "position notional") !== 0;
    return { equity: usdc(state.marginSummary.accountValue, "account equity"),
      withdrawable: usdc(state.withdrawable, "withdrawable USDC"), occupied };
  };
  const readView = async (): Promise<FundingView> => {
    const mode = await info.userAbstraction({ user });
    if (mode !== "default" && mode !== "disabled") throw new Error(`Automatic funding setup cannot migrate account mode: ${mode}.`);
    const [native, destination] = await Promise.all([readBalance(""), readBalance(dex)]);
    if (native.withdrawable > native.equity || destination.withdrawable > destination.equity) throw new Error("Hyperliquid balances are inconsistent.");
    return { mode, native, destination };
  };
  const assertIdle = async (view: FundingView): Promise<void> => {
    // A collateral transfer between the user's own DEXs leaves open positions and
    // their protection untouched; the executor books it as a cash flow. Only the
    // account-wide mode change needs an idle account.
    if (view.mode !== "default") return;
    if (view.native.occupied || view.destination.occupied) throw new Error("Stop trading and reconcile positions and orders before the account-mode change.");
    // Mode is account-wide. Unrelated DEX exposure and spot liabilities must
    // not be hidden by looking only at native and destination balances.
    const otherDexs = [...new Set(dexRows.flatMap(row => row && row.name !== dex ? [row.name] : []))];
    // Keep global-account checks sequential; the injected info client's rate
    // limiter must not receive an unbounded burst of DEX reads.
    for (const otherDex of otherDexs) {
      if ((await readBalance(otherDex)).occupied) throw new Error("Account-mode change requires no positions or orders on any DEX.");
    }
    const spot = await info.spotClearinghouseState({ user });
    if (!Array.isArray(spot.balances) || spot.portfolioMarginEnabled === true || spot.balances.some(balance =>
      finite(balance.total, "spot balance") !== 0 || finite(balance.hold, "spot hold") !== 0 ||
      ("borrowed" in balance && balance.borrowed !== undefined && finite(balance.borrowed, "spot borrowing") !== 0) ||
      ("supplied" in balance && balance.supplied !== undefined && finite(balance.supplied, "spot supply") !== 0))) {
      throw new Error("Account-mode change requires empty spot balances and no borrowing.");
    }
  };
  const result = (view: FundingView, modeChanged = false, moved = 0n, status: "ready" | "canceled" = "ready"): HyperliquidPerpFundingResult => ({
    status, modeChanged, movedUsdc: decimal(moved), nativeUsdc: decimal(view.native.equity), destinationUsdc: decimal(view.destination.equity),
  });
  const initial = await readView();
  if (initial.mode === "disabled" && initial.native.withdrawable === 0n) return result(initial);
  await assertIdle(initial);
  const amount = initial.native.withdrawable;
  context.print("Hyperliquid account");
  context.print(user);
  const actions = [
    ...(initial.mode === "default" ? ["Enable Standard mode"] : []),
    ...(amount > 0n ? [`move ${decimal(amount)} USDC from native perps to ${dex}`] : []),
  ];
  if (!(await context.confirm(`${actions.join(" and ")}?`, false))) return result(initial, false, 0n, "canceled");

  // With positions open on the destination, its equity moves with mark prices; the native
  // side (always idle for a transfer) is the invariant that must hold.
  const destinationSteady = (view: FundingView) => view.destination.occupied || view.destination.equity === initial.destination.equity;
  let current = await readView();
  await assertIdle(current);
  if (current.mode !== initial.mode || current.native.equity !== initial.native.equity ||
    current.native.withdrawable !== amount || !destinationSteady(current)) {
    throw new Error("Account changed during confirmation. No settings or transfer were submitted.");
  }
  let modeChanged = false;
  if (current.mode === "default") {
    try { await exchange.userSetAbstraction({ user, abstraction: "disabled" }); }
    catch (error) { throw new Error("Account-mode acknowledgement is uncertain. Check account mode before retrying; no transfer was sent.", { cause: error }); }
    if (await info.userAbstraction({ user }) !== "disabled") throw new Error("Standard mode is not confirmed. No transfer was sent.");
    modeChanged = true;
    current = await readView();
    await assertIdle(current);
    if (current.mode !== "disabled" || current.native.withdrawable !== amount || current.native.equity !== initial.native.equity ||
      !destinationSteady(current)) throw new Error("Account changed after enabling Standard mode. No transfer was sent.");
  }
  if (amount === 0n) return result(current, modeChanged);
  const sentAt = now();
  try {
    await exchange.sendAsset({ destination: user, sourceDex: "", destinationDex: dex, token, amount: decimal(amount), fromSubAccount: "" });
  } catch (error) {
    throw new Error("Transfer acknowledgement is uncertain. Check native and destination balances before retrying.", { cause: error });
  }
  // With positions open on the destination its equity is not a fixed target, so the
  // arrival is confirmed from the venue ledger: one incoming send of exactly this amount.
  const ledgerShowsArrival = async (): Promise<boolean> => {
    const rows = await info.userNonFundingLedgerUpdates({ user, startTime: sentAt - 60_000, endTime: now() + 5_000 });
    return rows.some(row => {
      const delta = row.delta as Record<string, unknown>;
      return delta.type === "send" && String(delta.destination).toLowerCase() === user.toLowerCase() && delta.destinationDex === dex
        && typeof delta.amount === "string" && usdc(delta.amount, "ledger amount") === amount && row.time >= sentAt - 60_000;
    });
  };
  // Only reads may repeat while indexing catches up. An ack alone does not
  // prove the target received collateral, and a slow read never causes resend.
  for (let attempt = 0; attempt < 5; attempt++) {
    current = await readView();
    const nativeSettled = current.mode === "disabled" && current.native.equity === initial.native.equity - amount;
    const destinationSettled = current.destination.occupied ? await ledgerShowsArrival()
      : current.destination.equity === initial.destination.equity + amount;
    if (nativeSettled && destinationSettled) return result(current, modeChanged, amount);
    if (attempt < 4) await (options.sleep?.(250) ?? new Promise(resolve => setTimeout(resolve, 250)));
  }
  throw new Error("Transfer submitted but balances are not confirmed. Check balances before retrying; no second transfer was sent.");
}

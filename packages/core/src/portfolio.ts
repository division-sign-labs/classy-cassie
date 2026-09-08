// packages/core/src/portfolio.ts
// Portfolio report computation (§10). Rendering lives in the CLI so the render
// layer stays separable (TUI is post-MVP).

import type { Balance, Order, PerpPortfolioScope, Position, VenueAccount, VenueAdapter, VenueId } from "./types.js";

export interface BotPortfolio {
  botId: string;
  venue: VenueId;
  balances: Balance[];
  positions: (Position & { markPrice?: number; value?: number })[];
  openOrders: Order[];
  equity: number;
  unrealizedPnl: number;
  realizedPnl: number;
  perpScope?: PerpPortfolioScope;
}

export async function computePortfolio(
  botId: string,
  adapter: VenueAdapter,
  account: VenueAccount,
): Promise<BotPortfolio> {
  const [balances, positions, openOrders, perpScope] = await Promise.all([
    adapter.balances(account),
    adapter.positions(account),
    adapter.openOrders(account),
    adapter.portfolioScope?.(account),
  ]);

  const priced = await Promise.all(
    positions.map(async (p) => {
      // Resolved markets often have no CLOB quote. A losing token is worth zero,
      // not its original cost while it waits for the redemption index to catch up.
      if (p.redeemable && p.currentPrice !== undefined && Number.isFinite(p.currentPrice)) {
        return { ...p, markPrice: p.currentPrice, value: p.size * p.currentPrice,
          unrealizedPnl: (p.currentPrice - p.avgPrice) * p.size };
      }
      try {
        const q = await adapter.quote(p.marketRef);
        const bullishMark = p.side === "NO" ? 1 - q.mid : q.mid;
        const value = p.size * bullishMark;
        const upnl =
          p.unrealizedPnl ??
          (p.side === "SHORT" ? (p.avgPrice - q.mid) * p.size : (bullishMark - p.avgPrice) * p.size);
        return { ...p, markPrice: bullishMark, value, unrealizedPnl: upnl };
      } catch {
        return { ...p, value: p.size * p.avgPrice };
      }
    }),
  );

  const collateral = balances.reduce((s, b) => s + b.total, 0);
  const posValue = priced.reduce((s, p) => s + (p.value ?? 0), 0);
  return {
    botId,
    venue: adapter.id,
    balances,
    positions: priced,
    openOrders,
    ...(perpScope ? { perpScope } : {}),
    // Hyperliquid accountValue already contains unrealized P&L; notional is exposure, not an asset balance.
    equity: adapter.id === "hyperliquid" ? collateral : collateral + posValue,
    unrealizedPnl: priced.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0),
    realizedPnl: priced.reduce((s, p) => s + (p.realizedPnl ?? 0), 0),
  };
}

export interface AggregatePortfolio {
  bots: BotPortfolio[];
  totalEquity: number;
  totalUnrealizedPnl: number;
}

export function aggregatePortfolios(bots: BotPortfolio[]): AggregatePortfolio {
  return {
    bots,
    totalEquity: bots.reduce((s, b) => s + b.equity, 0),
    totalUnrealizedPnl: bots.reduce((s, b) => s + b.unrealizedPnl, 0),
  };
}

// packages/core/src/portfolio.ts
// Portfolio report computation (§10). Rendering lives in the CLI so the render
// layer stays separable (TUI is post-MVP).

import type { Balance, Order, Position, VenueAccount, VenueAdapter, VenueId } from "./types.js";

export interface BotPortfolio {
  botId: string;
  venue: VenueId;
  balances: Balance[];
  positions: (Position & { markPrice?: number; value?: number })[];
  openOrders: Order[];
  equity: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

export async function computePortfolio(
  botId: string,
  adapter: VenueAdapter,
  account: VenueAccount,
): Promise<BotPortfolio> {
  const [balances, positions, openOrders] = await Promise.all([
    adapter.balances(account),
    adapter.positions(account),
    adapter.openOrders(account),
  ]);

  const priced = await Promise.all(
    positions.map(async (p) => {
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
    equity: collateral + posValue,
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

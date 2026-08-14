// packages/core/src/engine/mirror.ts
// Binary-market mirroring: adapters expose the YES-token book/quote (marketRef
// is the YES token per §7); trading the NO side prices against the mirror,
// where price_no = 1 - price_yes and bids/asks swap.

import type { OrderBook, Quote } from "../types.js";

export function mirrorBookForNo(book: OrderBook): OrderBook {
  return {
    marketRef: book.marketRef,
    ts: book.ts,
    // A YES bid at p is willingness to sell NO at 1-p, i.e. a NO ask.
    asks: book.bids.map((l) => ({ price: 1 - l.price, size: l.size })),
    bids: book.asks.map((l) => ({ price: 1 - l.price, size: l.size })),
  };
}

export function mirrorQuoteForNo(quote: Quote): Quote {
  const bid = 1 - quote.ask;
  const ask = 1 - quote.bid;
  return {
    ...quote,
    bid,
    ask,
    mid: 1 - quote.mid,
    spreadBps: quote.mid > 0 && quote.mid < 1 ? ((ask - bid) / (1 - quote.mid)) * 10_000 : quote.spreadBps,
  };
}

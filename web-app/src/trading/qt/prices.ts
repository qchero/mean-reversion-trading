/**
 * Price sourcing for qt — IBKR streaming market data (same feed we execute
 * against), isolated from the pure rebalance logic so logic.ts stays testable.
 *
 * Quotes come from `IBKRClient.subscribeMarketData` / `getQuote`. The sizing
 * price is the bid/ask mid, falling back to the last trade; bid/ask/last are
 * surfaced per ticker (see engine logging) so the choice can be reviewed.
 */

import type { IBKRClient } from '../ibkr';

export interface QuoteLine {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  /** Sizing price chosen from the quote; null when nothing usable yet. */
  price: number | null;
  /** Which field `price` came from. */
  source: 'last' | 'mid' | 'none';
}

/**
 * Pick the sizing price from a quote: the bid/ask mid, falling back to the last
 * trade when bid/ask is incomplete. Null when neither is available (e.g. ticks
 * haven't arrived yet).
 */
export function pickQuotePrice(
  tick: { bid: number; ask: number; last: number } | undefined,
): { price: number | null; source: 'last' | 'mid' | 'none' } {
  if (tick && tick.bid > 0 && tick.ask > 0) {
    return { price: (tick.bid + tick.ask) / 2, source: 'mid' };
  }
  if (tick && tick.last > 0) return { price: tick.last, source: 'last' };
  return { price: null, source: 'none' };
}

/** Snapshot the latest IBKR quotes for the given symbols. */
export function readQuotes(ibkr: IBKRClient, symbols: string[]): QuoteLine[] {
  return symbols.map((symbol) => {
    const tick = ibkr.getQuote(symbol);
    const { price, source } = pickQuotePrice(tick);
    return {
      symbol,
      bid: tick?.bid ?? 0,
      ask: tick?.ask ?? 0,
      last: tick?.last ?? 0,
      price,
      source,
    };
  });
}

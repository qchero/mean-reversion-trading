/**
 * Price sourcing for qt — Yahoo quotes, isolated from the pure rebalance logic so logic.ts stays
 * testable. IBKR is only used to place orders.
 *
 * Quotes come from `fetchLiveQuotes`: the most recent of the pre-market, regular and post-market
 * prices. qt sizes at the 09:20 trigger, so that's normally the pre-market price, falling back to
 * the prior post-market / close when a ticker hasn't traded pre-market yet.
 */

import { LiveQuote, QuoteSession, fetchLiveQuotes } from '../quotes';

export interface QuoteLine {
  symbol: string;
  /** Sizing price; null when Yahoo returned nothing usable. */
  price: number | null;
  /** Which session `price` came from. */
  session: QuoteSession | null;
  /** When `price` traded. */
  time: Date | null;
}

/** Attempts per cycle — a transient failure at the trigger would otherwise skip every buy. */
const QUOTE_ATTEMPTS = 3;
const QUOTE_RETRY_MS = 5000;

/**
 * Fetch the latest quotes for the given symbols, retrying transient failures. If every attempt
 * fails, all prices are null.
 */
export async function readQuotes(symbols: string[]): Promise<QuoteLine[]> {
  let quotes = new Map<string, LiveQuote>();
  for (let attempt = 1; attempt <= QUOTE_ATTEMPTS; attempt++) {
    try {
      quotes = await fetchLiveQuotes(symbols);
      break;
    } catch (e) {
      console.error(`[qt] Yahoo quote request failed (attempt ${attempt}/${QUOTE_ATTEMPTS}):`, (e as Error).message);
      if (attempt < QUOTE_ATTEMPTS) await new Promise((r) => setTimeout(r, QUOTE_RETRY_MS));
    }
  }
  return symbols.map((symbol) => {
    const q = quotes.get(symbol);
    return { symbol, price: q?.price ?? null, session: q?.session ?? null, time: q?.time ?? null };
  });
}

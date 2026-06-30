/**
 * Latest-price fetch for qt, isolated from the pure logic so logic.ts stays testable.
 *
 * Around the 9:20 ET trigger the regular-session price is still yesterday's close,
 * so we prefer the pre-market (or post-market) print when the market is in that
 * state — a better estimate of where the opening auction will land.
 */

import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();

/** Fetch latest price per symbol. Returns null for any symbol that fails. */
export async function fetchPrices(symbols: string[]): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};

  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const q = await yahooFinance.quote(symbol);
        out[symbol] = pickPrice({
          marketState: q.marketState,
          regularMarketPrice: q.regularMarketPrice,
          preMarketPrice: q.preMarketPrice,
          postMarketPrice: q.postMarketPrice,
        });
      } catch (error) {
        console.error(`[qt] price fetch failed for ${symbol}:`, (error as Error).message);
        out[symbol] = null;
      }
    }),
  );

  return out;
}

type QuoteLike = {
  marketState?: string;
  regularMarketPrice?: number;
  preMarketPrice?: number;
  postMarketPrice?: number;
};

/** Choose the most relevant price for the current market state. */
export function pickPrice(q: QuoteLike): number | null {
  const { marketState, regularMarketPrice, preMarketPrice, postMarketPrice } = q;

  if ((marketState === 'PRE' || marketState === 'PREPRE') && preMarketPrice && preMarketPrice > 0) {
    return preMarketPrice;
  }
  if ((marketState === 'POST' || marketState === 'POSTPOST') && postMarketPrice && postMarketPrice > 0) {
    return postMarketPrice;
  }
  if (regularMarketPrice && regularMarketPrice > 0) return regularMarketPrice;

  // Last resort: any non-regular print we have.
  return preMarketPrice ?? postMarketPrice ?? null;
}

/**
 * Live quotes from Yahoo Finance, covering the pre-market, regular and post-market sessions.
 *
 * Yahoo reports a separate price + timestamp per session; we take whichever traded most recently,
 * so the price follows pre-market before 9:30, the regular session, then post-market after 16:00
 * (and overnight / weekends, until the next pre-market).
 */

import YahooFinance from 'yahoo-finance2';
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

export type QuoteSession = 'pre' | 'regular' | 'post';

export interface LiveQuote {
  symbol: string;
  price: number;
  session: QuoteSession;
  /** When `price` traded (Yahoo's per-session timestamp). */
  time: Date;
  dayHigh: number | null;
  dayLow: number | null;
}

/** The per-session fields of a Yahoo quote. */
export interface SessionFields {
  preMarketPrice?: number;
  preMarketTime?: Date;
  regularMarketPrice?: number;
  regularMarketTime?: Date;
  postMarketPrice?: number;
  postMarketTime?: Date;
}

/**
 * Pick the most recently traded of the pre / regular / post-market prices. A price without a
 * timestamp only wins when nothing else is usable; ties go to the regular session.
 */
export function pickSessionPrice(q: SessionFields): { price: number; session: QuoteSession; time: Date } | null {
  const candidates: { session: QuoteSession; price?: number; time?: Date }[] = [
    { session: 'regular', price: q.regularMarketPrice, time: q.regularMarketTime },
    { session: 'pre', price: q.preMarketPrice, time: q.preMarketTime },
    { session: 'post', price: q.postMarketPrice, time: q.postMarketTime },
  ];

  let best: { price: number; session: QuoteSession; time: Date } | null = null;
  for (const c of candidates) {
    if (!c.price || c.price <= 0) continue;
    const time = c.time ?? new Date(0);
    if (!best || time.getTime() > best.time.getTime()) best = { price: c.price, session: c.session, time };
  }
  return best;
}

/** Latest quote per symbol in one batched request. Symbols Yahoo returns nothing usable for are absent. */
export async function fetchLiveQuotes(symbols: string[]): Promise<Map<string, LiveQuote>> {
  const out = new Map<string, LiveQuote>();
  if (symbols.length === 0) return out;

  const quotes = await yahooFinance.quote(symbols);
  for (const q of quotes) {
    // Cast: the Quote union includes types (e.g. ECN quotes) that lack the session fields entirely
    const picked = pickSessionPrice(q as SessionFields);
    if (!picked) continue;
    out.set(q.symbol, {
      symbol: q.symbol,
      ...picked,
      dayHigh: q.regularMarketDayHigh ?? null,
      dayLow: q.regularMarketDayLow ?? null,
    });
  }
  return out;
}

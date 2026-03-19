import prisma from './prisma';

const POLYGON_API_KEY = process.env.POLYGON_API_KEY || '';

export interface PolygonCandle {
  v: number;   // volume
  vw: number;  // volume weighted average price
  o: number;   // open
  c: number;   // close
  h: number;   // high
  l: number;   // low
  t: number;   // timestamp
  n: number;   // number of transactions
}

export interface PolygonResponse {
  ticker: string;
  queryCount: number;
  resultsCount: number;
  adjusted: boolean;
  results: PolygonCandle[];
  status: string;
  request_id: string;
  count: number;
}

/**
 * Convert a Date to YYYY-MM-DD in Eastern Time (market timezone).
 * Polygon timestamps represent market time, so we must interpret them in ET.
 */
export function formatDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return parts; // 'en-CA' locale already returns YYYY-MM-DD
}

/**
 * Calculates start date (200 *trading* days usually means roughly 290 calendar days)
 */
function getStartDateFor200TradingDays(endDate: Date): Date {
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 300); // Pad to ensure we get 200 trading days
  return startDate;
}

/**
 * Fetches the required history for a symbol (up to yesterday's close),
 * storing missing daily candles into the database to minimize Polygon API calls.
 */
export async function getOrFetchHistoricalData(symbol: string) {
  const normalizedSymbol = symbol.toUpperCase();
  
  // 1. Determine the latest trading day with finalized data.
  //    Market closes at 4pm ET; we consider data final 1 hour later (5pm ET).
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hourET = nowET.getHours();
  const dayOfWeek = nowET.getDay(); // 0=Sun, 6=Sat

  let endDate = new Date(nowET);
  endDate.setHours(0, 0, 0, 0);

  if (dayOfWeek === 0) {
    // Sunday → Friday
    endDate.setDate(endDate.getDate() - 2);
  } else if (dayOfWeek === 6) {
    // Saturday → Friday
    endDate.setDate(endDate.getDate() - 1);
  } else if (hourET < 17) {
    // Weekday but before 5pm ET → previous trading day
    if (dayOfWeek === 1) {
      endDate.setDate(endDate.getDate() - 3); // Mon before 5pm → Friday
    } else {
      endDate.setDate(endDate.getDate() - 1);
    }
  }
  // else: weekday after 5pm ET → endDate = today (data is final)

  const startDate = getStartDateFor200TradingDays(endDate);
  const startDateStr = formatDate(startDate);
  const endDateStr = formatDate(endDate);

  // 2. See what we already have in the database for this range
  const cachedCandles = await prisma.dailyCandle.findMany({
    where: {
      symbol: normalizedSymbol,
      date: {
        gte: startDateStr,
        lte: endDateStr,
      }
    },
    orderBy: {
      date: 'asc'
    }
  });

  // If we have at least 200 candles, and the most recent one is yesterday's date (or Friday, if weekend), we're fully cached
  // Note: Polygon might not have data exactly on 'yesterday' if it was a holiday, so this check could be more robust in production.
  // We will assume 200 results is sufficient for now just to limit complexity for a visualizer.
  if (cachedCandles.length >= 200 && cachedCandles[cachedCandles.length - 1].date >= endDateStr) {
    // Return only the last 200
    return cachedCandles.slice(-200);
  }

  // 3. We are missing data, fetch from Polygon
  // For simplicity and avoiding complex gap-filling logic, if we miss anything, we'll fetch the whole range from Polygon 
  // and upsert it into the DB.
  const url = `https://api.polygon.io/v2/aggs/ticker/${normalizedSymbol}/range/1/day/${startDateStr}/${endDateStr}?adjusted=true&apiKey=${POLYGON_API_KEY}`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Polygon API error: Unauthorized — check your POLYGON_API_KEY in .env`);
      }
      throw new Error(`Polygon API error: ${response.statusText} (${response.status})`);
    }
    
    const data: PolygonResponse = await response.json();
    
    if (!data.results || data.results.length === 0) {
      throw new Error(`No data returned from Polygon for ${normalizedSymbol}. Please check the symbol.`);
    }

    // 4. Save/Upsert directly to the database
    // We use a transaction to upsert efficiently
    const candlesToInsert = data.results.map(c => ({
      symbol: normalizedSymbol,
      date: formatDate(new Date(c.t)),
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
      volume: c.v
    }));

    await prisma.$transaction(
      candlesToInsert.map(c => 
        prisma.dailyCandle.upsert({
          where: {
            symbol_date: {
              symbol: c.symbol,
              date: c.date
            }
          },
          update: {
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume
          },
          create: c
        })
      )
    );

    // 5. Query the database one final time to return the guaranteed last 200 trading days
    const updatedCandles = await prisma.dailyCandle.findMany({
      where: {
        symbol: normalizedSymbol,
        date: {
          gte: startDateStr,
          lte: endDateStr,
        }
      },
      orderBy: {
        date: 'asc'
      }
    });

    return updatedCandles.slice(-200);
  } catch (error) {
    console.error("Error fetching data from Polygon:", error);
    throw error;
  }
}

/**
 * Core math calculations for Mean Reversion Strategy
 */
export function calculateStrategyMetrics(candles: { close: number; date: string }[]) {
  if (!candles || candles.length < 2) {
    return { sma200: 0, dailyVolatility: 0, latestPrice: 0, lastDate: '' };
  }

  // Ensure we use exactly up to 200
  const last200 = candles.slice(-200);

  // Latest price and date = most recent candle
  const latestPrice = last200[last200.length - 1].close;
  const lastDate = last200[last200.length - 1].date;

  // Calculate SMA 200
  const sum = last200.reduce((acc, curr) => acc + curr.close, 0);
  const sma200 = sum / last200.length;

  // Calculate Daily Percentage Changes
  const percentageChanges: number[] = [];
  for (let i = 1; i < last200.length; i++) {
    const prevClose = last200[i - 1].close;
    const currentClose = last200[i].close;

    if (prevClose > 0) {
      percentageChanges.push((currentClose - prevClose) / prevClose);
    } else {
      percentageChanges.push(0);
    }
  }

  // Calculate Mean of Percentage Changes
  const meanPctChange = percentageChanges.reduce((acc, val) => acc + val, 0) / percentageChanges.length;

  // Calculate Variance
  const variance = percentageChanges.reduce((acc, val) => acc + Math.pow(val - meanPctChange, 2), 0) / percentageChanges.length;

  // Calculate Standard Deviation (Daily Volatility)
  const dailyVolatility = Math.sqrt(variance);

  return {
    sma200,
    dailyVolatility,
    latestPrice,
    lastDate,
  };
}

/**
 * Fetches the real-time or most recent price snapshot for a symbol.
 */
export async function getLatestPrice(symbol: string): Promise<number | null> {
  const normalizedSymbol = symbol.toUpperCase();
  const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${normalizedSymbol}?apiKey=${POLYGON_API_KEY}`;

  try {
    const response = await fetch(url, { next: { revalidate: 60 } }); // Cache for 60 seconds
    if (!response.ok) {
      console.warn(`Polygon snapshot API error: ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    if (!data.ticker) {
      return null;
    }

    // Try to get the absolute most recent trade price, fallback to minute close, day close, previous day close.
    const ticker = data.ticker;
    const price = ticker.lastTrade?.p || ticker.min?.c || ticker.day?.c || ticker.prevDay?.c;
    
    return price ?? null;
  } catch (error) {
    console.error("Error fetching latest price snapshot:", error);
    return null;
  }
}


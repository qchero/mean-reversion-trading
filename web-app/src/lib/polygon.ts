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
 * Helper to get date strings in YYYY-MM-DD format
 */
export function formatDate(date: Date): string {
  const d = new Date(date);
  let month = '' + (d.getMonth() + 1);
  let day = '' + d.getDate();
  const year = d.getFullYear();

  if (month.length < 2) month = '0' + month;
  if (day.length < 2) day = '0' + day;

  return [year, month, day].join('-');
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
  
  // 1. Determine "yesterday"
  const today = new Date();
  today.setHours(0, 0, 0, 0); // normalize today to midnight
  
  // Determine yesterday based on weekend rules (basic logic: if Monday, yesterday is Friday)
  const yesterday = new Date(today);
  if (today.getDay() === 1) { // Monday
    yesterday.setDate(today.getDate() - 3); // Friday
  } else if (today.getDay() === 0) { // Sunday
    yesterday.setDate(today.getDate() - 2); // Friday
  } else {
    yesterday.setDate(today.getDate() - 1);
  }

  const startDate = getStartDateFor200TradingDays(yesterday);
  const startDateStr = formatDate(startDate);
  const endDateStr = formatDate(yesterday);

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


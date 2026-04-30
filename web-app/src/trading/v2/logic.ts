import YahooFinance from 'yahoo-finance2';
const yahooFinance = new YahooFinance();

export interface LinearData {
  sma100: number;
  sma200: number;
  sma300: number;
  sigma: number;
  lastClose: number; // For reference
  lastDate: string;
}

export async function fetchAndComputeMetrics(symbol: string): Promise<LinearData | null> {
  // We need 301 trading days. We fetch 450 calendar days to be safe.
  const now = new Date();
  const past = new Date();
  past.setDate(past.getDate() - 450);

  const queryOptions = {
    period1: past,
    period2: now,
    interval: '1d' as const,
  };

  try {
    const chartResult = await yahooFinance.chart(symbol, queryOptions);
    const data: any[] = chartResult.quotes;
    if (!data || data.length < 201) {
      console.warn(`[Logic] Not enough historical data for ${symbol} (${data?.length || 0} days found)`);
      return null;
    }

    // Get the last 201 days to match `close.pct_change().rolling(200).std()` exactly.
    // The very last item in `data` might be today's incomplete candle if market is open.
    // We only want data UP TO YESTERDAY for the SMA and sigma to avoid look-ahead bias.
    // To be strictly correct, we should exclude "today".
    // A reliable way is to filter out any candle that matches today's local date (EST).
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const todayStr = `${nowET.getFullYear()}-${String(nowET.getMonth() + 1).padStart(2, '0')}-${String(nowET.getDate()).padStart(2, '0')}`;
    
    // Sort chronologically just in case, though yahoo-finance2 does.
    data.sort((a, b) => a.date.getTime() - b.date.getTime());

    // Filter out today and any entries with null close (e.g. incomplete intraday candles)
    const pastData = data.filter(d => {
      if ((d.adjclose ?? d.close) == null) return false;
      const dStr = `${d.date.getFullYear()}-${String(d.date.getMonth() + 1).padStart(2, '0')}-${String(d.date.getDate()).padStart(2, '0')}`;
      return dStr < todayStr;
    });

    if (pastData.length < 301) {
      console.warn(`[Logic] Not enough historical data for ${symbol} after excluding today`);
      return null;
    }

    // Grab the exact 301 most recent days from pastData
    const recent = pastData.slice(-301);
    const closes = recent.map(d => d.adjclose ?? d.close); // prefer split/div adjusted

    // 1. Calculate SMAs (ignoring the oldest day which is only used for the first pct return of sigma)
    const exact300 = closes.slice(1);
    const sma100 = exact300.slice(-100).reduce((acc, val) => acc + val, 0) / 100;
    const sma200 = exact300.slice(-200).reduce((acc, val) => acc + val, 0) / 200;
    const sma300 = exact300.reduce((acc, val) => acc + val, 0) / 300;

    // 2. Calculate daily returns mapping only the last 200 days for sigma
    const recent201 = closes.slice(-201);
    const returns: number[] = [];
    for (let i = 1; i < recent201.length; i++) {
        returns.push((recent201[i] - recent201[i-1]) / recent201[i-1]);
    }

    // 3. Compute sample standard deviation of the 200 returns
    const meanReturn = returns.reduce((acc, val) => acc + val, 0) / 200;
    const varianceSq = returns.reduce((acc, val) => acc + Math.pow(val - meanReturn, 2), 0) / (200 - 1); // Sample std uses N-1
    const sigma = Math.sqrt(varianceSq);

    const lastClose = closes[closes.length - 1];

    const lastDateObj = recent[recent.length - 1].date;
    const lastDate = `${lastDateObj.getFullYear()}-${String(lastDateObj.getMonth() + 1).padStart(2, '0')}-${String(lastDateObj.getDate()).padStart(2, '0')}`;

    return { sma100, sma200, sma300, sigma, lastClose, lastDate };
  } catch (error) {
    console.error(`[Logic] Failed to fetch data for ${symbol}:`, error);
    return null;
  }
}

export function evaluateLinearTarget(
  price: number,
  sma200: number,
  sigma: number,
  bandLo: number,
  bandHi: number,
  maxBudget: number,
  minTradeAmount: number,
  currentShares: number
): {
  action: 'BUY' | 'SELL' | null;
  targetShares: number;
  unclampedTargetShares: number;
  clampedDiff: number;
  unclampedDiff: number;
  sigmaBelow: number;
  targetValue: number;
} {
  // Step 1: Compute sigma_below
  const sigmaBelow = (sma200 - price) / (sma200 * sigma);

  // Step 2: Unclamped target logic
  const linearTargetValue = maxBudget * (sigmaBelow - bandLo) / (bandHi - bandLo);
  const unclampedTargetShares = Math.round(linearTargetValue / price);
  const unclampedDiff = unclampedTargetShares - currentShares;

  // Step 3: Clamp target
  const maxShares = Math.round(maxBudget / price);
  const targetShares = Math.max(0, Math.min(maxShares, unclampedTargetShares));
  const diff = targetShares - currentShares;

  const targetValue = targetShares * price;

  // Step 4: Gate check — use diff against min threshold, but fall back to
  // unclampedDiff when budget cap or near-zero position makes diff too small
  // AND both agree on direction (prevents unclamped BUY qualifying a budget-cap SELL)
  const minShares = minTradeAmount > 0 ? Math.round(minTradeAmount / price) : 1;
  const minGate = Math.max(1, minShares);
  const sameSign = diff > 0 ? unclampedDiff > 0 : unclampedDiff < 0;
  const satisfiesMinTrade = Math.abs(diff) >= minGate
    || (Math.abs(unclampedDiff) >= minGate && sameSign);

  let action: 'BUY' | 'SELL' | null = null;
  if (diff !== 0 && satisfiesMinTrade) {
    action = diff > 0 ? 'BUY' : 'SELL';
  }

  return {
    action,
    targetShares,
    unclampedTargetShares,
    clampedDiff: diff,
    unclampedDiff,
    sigmaBelow,
    targetValue
  };
}

export interface PriceSnapshot {
  price: number | null;
  dayHigh: number | null;
  dayLow: number | null;
}

export async function getLatestPrice(symbol: string): Promise<PriceSnapshot> {
  try {
    const q = await yahooFinance.quote(symbol);
    return {
      price: q.regularMarketPrice ?? null,
      dayHigh: q.regularMarketDayHigh ?? null,
      dayLow: q.regularMarketDayLow ?? null,
    };
  } catch (error) {
    console.error(`[Logic] getLatestPrice failed for ${symbol}:`, error);
    return { price: null, dayHigh: null, dayLow: null };
  }
}

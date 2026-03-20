/**
 * Pure trading logic — no DB or IBKR dependencies.
 *
 * Extracted from engine.ts so it can be unit-tested directly.
 */

export interface StepLevel {
  step: number;
  buyPrice: number;
  sellPrice: number;
  shares: number; // shares to buy (stepAmount / buyPrice)
}

export interface StrategyParams {
  initialParamJ: number;
  stepParamK: number;
  maxSteps: number;
  stepAmount: number;
}

export interface OpenPosition {
  step: number;
  shares: number;
  buyPrice: number;
}

export interface TradeAction {
  step: number;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
}

/**
 * Calculate buy/sell price levels for a strategy.
 *
 * Buy price[i]  = SMA200 * (1 - (j + i*k) * sigma)
 * Sell price[i] = SMA200 * (1 - (j + (i-1)*k) * sigma)
 */
export function calculateLevels(
  params: StrategyParams,
  sma200: number,
  dailyVolatility: number,
): StepLevel[] {
  const { initialParamJ: j, stepParamK: k, maxSteps, stepAmount } = params;
  const levels: StepLevel[] = [];

  for (let i = 0; i < maxSteps; i++) {
    const stepNum = i + 1;
    const buyPrice = sma200 * (1 - (j + i * k) * dailyVolatility);
    const sellPrice = sma200 * (1 - (j + (i - 1) * k) * dailyVolatility);
    const shares = stepAmount / buyPrice;

    levels.push({ step: stepNum, buyPrice, sellPrice, shares });
  }

  return levels;
}

/**
 * Evaluate a tick against strategy levels and open positions.
 *
 * Returns the first triggered action (buy or sell), or null if nothing triggers.
 * - BUY when ask <= level.buyPrice AND no open position for that step
 * - SELL when bid >= level.sellPrice AND there IS an open position for that step
 */
export function evaluateTick(
  bid: number,
  ask: number,
  levels: StepLevel[],
  openPositions: OpenPosition[],
): TradeAction | null {
  for (const level of levels) {
    const openPos = openPositions.find((p) => p.step === level.step);

    if (openPos) {
      // Holding this step — check sell
      if (bid >= level.sellPrice) {
        return { step: level.step, side: 'SELL', price: level.sellPrice, qty: openPos.shares };
      }
    } else {
      // Not holding — check buy
      if (ask <= level.buyPrice) {
        return { step: level.step, side: 'BUY', price: level.buyPrice, qty: level.shares };
      }
    }
  }

  return null;
}

/**
 * Round share quantity to whole shares (IBKR doesn't support fractional via API).
 * Returns 0 if quantity rounds to 0 or less.
 */
export function roundShares(quantity: number): number {
  return Math.max(0, Math.round(quantity));
}

import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateLevels,
  evaluateTick,
  roundShares,
  StepLevel,
  OpenPosition,
} from './trading-logic';

// ── Test fixtures ──

const SMA200 = 200;
const SIGMA = 0.015; // 1.5% daily volatility

const defaultParams = {
  initialParamJ: 6,
  stepParamK: 1.5,
  maxSteps: 4,
  stepAmount: 5000,
};

function getLevels() {
  return calculateLevels(defaultParams, SMA200, SIGMA);
}

// ── calculateLevels ──

describe('calculateLevels', () => {
  it('returns the correct number of steps', () => {
    const levels = getLevels();
    expect(levels).toHaveLength(4);
    expect(levels.map((l) => l.step)).toEqual([1, 2, 3, 4]);
  });

  it('step 1 buy price = SMA200 * (1 - j * sigma)', () => {
    const levels = getLevels();
    // j=6, sigma=0.015 → 1 - 6*0.015 = 0.91 → 200 * 0.91 = 182
    expect(levels[0].buyPrice).toBeCloseTo(182, 2);
  });

  it('step 1 sell price = SMA200 * (1 - (j - k) * sigma)', () => {
    const levels = getLevels();
    // j=6, k=1.5, sigma=0.015 → 1 - (6 + (-1)*1.5)*0.015 = 1 - 4.5*0.015 = 0.9325 → 186.50
    expect(levels[0].sellPrice).toBeCloseTo(186.5, 2);
  });

  it('step 2 buy price is lower than step 1', () => {
    const levels = getLevels();
    // j + 1*k = 7.5 → 1 - 7.5*0.015 = 0.8875 → 177.50
    expect(levels[1].buyPrice).toBeCloseTo(177.5, 2);
    expect(levels[1].buyPrice).toBeLessThan(levels[0].buyPrice);
  });

  it('step 2 sell price equals step 1 buy price', () => {
    const levels = getLevels();
    // sell[2] = SMA * (1 - (j + 0*k) * sigma) = same as buy[1] formula with i=0
    expect(levels[1].sellPrice).toBeCloseTo(levels[0].buyPrice, 10);
  });

  it('each subsequent buy price is lower', () => {
    const levels = getLevels();
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i].buyPrice).toBeLessThan(levels[i - 1].buyPrice);
    }
  });

  it('each subsequent sell price is lower', () => {
    const levels = getLevels();
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i].sellPrice).toBeLessThan(levels[i - 1].sellPrice);
    }
  });

  it('shares = stepAmount / buyPrice', () => {
    const levels = getLevels();
    for (const level of levels) {
      expect(level.shares).toBeCloseTo(defaultParams.stepAmount / level.buyPrice, 10);
    }
  });

  it('buy price is always below sell price for the same step', () => {
    const levels = getLevels();
    for (const level of levels) {
      expect(level.buyPrice).toBeLessThan(level.sellPrice);
    }
  });

  it('works with different j/k params', () => {
    const levels = calculateLevels(
      { initialParamJ: 3, stepParamK: 1, maxSteps: 2, stepAmount: 1000 },
      100,
      0.02,
    );
    // Step 1: buy = 100 * (1 - 3*0.02) = 94, sell = 100 * (1 - (3-1)*0.02) = 96
    expect(levels[0].buyPrice).toBeCloseTo(94, 2);
    expect(levels[0].sellPrice).toBeCloseTo(96, 2);
    // Step 2: buy = 100 * (1 - 4*0.02) = 92, sell = 100 * (1 - 3*0.02) = 94
    expect(levels[1].buyPrice).toBeCloseTo(92, 2);
    expect(levels[1].sellPrice).toBeCloseTo(94, 2);
  });
});

// ── evaluateTick ──

describe('evaluateTick', () => {
  let levels: StepLevel[];

  beforeEach(() => {
    levels = getLevels();
  });

  it('returns null when price is above all buy levels', () => {
    const result = evaluateTick(195, 195, levels, []);
    expect(result).toBeNull();
  });

  it('triggers BUY when ask <= step 1 buy price', () => {
    const result = evaluateTick(181, 182, levels, []);
    expect(result).not.toBeNull();
    expect(result!.side).toBe('BUY');
    expect(result!.step).toBe(1);
    expect(result!.price).toBeCloseTo(182, 2);
  });

  it('triggers BUY when ask is exactly at buy price', () => {
    const result = evaluateTick(180, levels[0].buyPrice, levels, []);
    expect(result).not.toBeNull();
    expect(result!.side).toBe('BUY');
    expect(result!.step).toBe(1);
  });

  it('does NOT trigger buy when ask is just above buy price', () => {
    const result = evaluateTick(180, levels[0].buyPrice + 0.01, levels, []);
    expect(result).toBeNull();
  });

  it('triggers step 1 buy even when both step 1 and step 2 would trigger', () => {
    // Price low enough to trigger both steps
    const result = evaluateTick(170, 170, levels, []);
    expect(result).not.toBeNull();
    expect(result!.step).toBe(1);
    expect(result!.side).toBe('BUY');
  });

  it('triggers step 2 buy when step 1 already has an open position', () => {
    const openPositions: OpenPosition[] = [
      { step: 1, shares: 27, buyPrice: 182 },
    ];
    // Price low enough to trigger step 2 buy (177.50)
    const result = evaluateTick(175, 177, levels, openPositions);
    expect(result).not.toBeNull();
    expect(result!.step).toBe(2);
    expect(result!.side).toBe('BUY');
  });

  it('triggers SELL when bid >= step sell price and position is open', () => {
    const openPositions: OpenPosition[] = [
      { step: 1, shares: 27, buyPrice: 182 },
    ];
    // Step 1 sell target is ~186.50
    const result = evaluateTick(187, 188, levels, openPositions);
    expect(result).not.toBeNull();
    expect(result!.side).toBe('SELL');
    expect(result!.step).toBe(1);
    expect(result!.qty).toBe(27);
  });

  it('triggers SELL at exact sell price', () => {
    const openPositions: OpenPosition[] = [
      { step: 1, shares: 27, buyPrice: 182 },
    ];
    const result = evaluateTick(levels[0].sellPrice, levels[0].sellPrice + 1, levels, openPositions);
    expect(result).not.toBeNull();
    expect(result!.side).toBe('SELL');
  });

  it('does NOT trigger sell when bid is just below sell price', () => {
    const openPositions: OpenPosition[] = [
      { step: 1, shares: 27, buyPrice: 182 },
    ];
    const result = evaluateTick(levels[0].sellPrice - 0.01, 190, levels, openPositions);
    expect(result).toBeNull();
  });

  it('does NOT trigger buy for a step that already has an open position', () => {
    const openPositions: OpenPosition[] = [
      { step: 1, shares: 27, buyPrice: 182 },
    ];
    // Price is at step 1 buy level but we already hold step 1
    // Sell target is higher, so bid at 180 won't trigger sell
    const result = evaluateTick(180, 182, levels, openPositions);
    expect(result).toBeNull();
  });

  it('sell uses open position shares, not level shares', () => {
    const openPositions: OpenPosition[] = [
      { step: 1, shares: 30, buyPrice: 180 }, // different from level.shares
    ];
    const result = evaluateTick(187, 188, levels, openPositions);
    expect(result!.qty).toBe(30);
  });

  it('buy uses level shares (fractional, pre-rounding)', () => {
    const result = evaluateTick(170, 170, levels, []);
    expect(result!.qty).toBeCloseTo(defaultParams.stepAmount / levels[0].buyPrice, 5);
  });

  it('prioritizes sell over buy when both could trigger on different steps', () => {
    // Step 1 is held and at sell target, step 2 is at buy target
    const openPositions: OpenPosition[] = [
      { step: 1, shares: 27, buyPrice: 182 },
    ];
    // Sell target step 1 ≈ 186.50, buy target step 2 ≈ 177.50
    // This can't actually happen with these levels since sell > buy,
    // but test that evaluation returns the first match (step order)
    const result = evaluateTick(187, 177, levels, openPositions);
    expect(result).not.toBeNull();
    expect(result!.step).toBe(1);
    expect(result!.side).toBe('SELL');
  });

  it('returns null with empty levels', () => {
    const result = evaluateTick(100, 100, [], []);
    expect(result).toBeNull();
  });
});

// ── roundShares ──

describe('roundShares', () => {
  it('rounds 27.4 to 27', () => {
    expect(roundShares(27.4)).toBe(27);
  });

  it('rounds 27.5 to 28', () => {
    expect(roundShares(27.5)).toBe(28);
  });

  it('rounds 27.6 to 28', () => {
    expect(roundShares(27.6)).toBe(28);
  });

  it('returns 0 for very small quantities', () => {
    expect(roundShares(0.3)).toBe(0);
  });

  it('returns 0 for negative quantities', () => {
    expect(roundShares(-5)).toBe(0);
  });

  it('returns 1 for 0.5', () => {
    expect(roundShares(0.5)).toBe(1);
  });

  it('passes through whole numbers unchanged', () => {
    expect(roundShares(100)).toBe(100);
  });
});

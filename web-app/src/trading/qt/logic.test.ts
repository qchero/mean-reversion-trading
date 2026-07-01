import { describe, it, expect } from 'vitest';
import {
  targetSharesFor,
  computeRebalancePlan,
  applyFillToPositions,
  allocationPerPick,
  evaluateTrigger,
} from './logic';
import type { QtConfig } from './config';

// Default fixture: $20k total across 2 picks → $10k per pick.
function makeConfig(over: Partial<QtConfig> = {}): QtConfig {
  return {
    totalUsd: 20000,
    tickers: ['AAA', 'BBB'],
    positions: {},
    lastPlacedDate: null,
    ...over,
  };
}

function findItem(items: ReturnType<typeof computeRebalancePlan>, sym: string) {
  const it = items.find((i) => i.symbol === sym);
  if (!it) throw new Error(`no item for ${sym}`);
  return it;
}

describe('targetSharesFor', () => {
  it('rounds to whole shares', () => {
    expect(targetSharesFor(10000, 100)).toBe(100);
    expect(targetSharesFor(10000, 99)).toBe(101); // 101.01 -> 101
    expect(targetSharesFor(10000, 101)).toBe(99); // 99.0099 -> 99
    expect(targetSharesFor(10000, 333)).toBe(30); // 30.03 -> 30
  });

  it('returns 0 for non-positive price', () => {
    expect(targetSharesFor(10000, 0)).toBe(0);
    expect(targetSharesFor(10000, -5)).toBe(0);
  });
});

describe('computeRebalancePlan', () => {
  it('first run (no positions) is all pure buys', () => {
    const cfg = makeConfig({ tickers: ['AAA', 'BBB'], positions: {} });
    const plan = computeRebalancePlan(cfg, { AAA: 100, BBB: 50 });

    const aaa = findItem(plan, 'AAA');
    expect(aaa.target).toBe(100);
    expect(aaa.current).toBe(0);
    expect(aaa.delta).toBe(100);
    expect(aaa.action).toBe('BUY');

    const bbb = findItem(plan, 'BBB');
    expect(bbb.target).toBe(200);
    expect(bbb.delta).toBe(200);
    expect(bbb.action).toBe('BUY');
  });

  it('adjusts existing positions up and down', () => {
    const cfg = makeConfig({ tickers: ['AAA', 'BBB'], positions: { AAA: 80, BBB: 250 } });
    const plan = computeRebalancePlan(cfg, { AAA: 100, BBB: 50 });

    expect(findItem(plan, 'AAA').delta).toBe(20); // 80 -> 100 BUY 20
    expect(findItem(plan, 'AAA').action).toBe('BUY');
    expect(findItem(plan, 'BBB').delta).toBe(-50); // 250 -> 200 SELL 50
    expect(findItem(plan, 'BBB').action).toBe('SELL');
  });

  it('exits tickers dropped from this month (sell to zero), even without a price', () => {
    const cfg = makeConfig({ tickers: ['AAA'], positions: { AAA: 100, OLD: 40 } });
    const plan = computeRebalancePlan(cfg, { AAA: 100 }); // no price for OLD

    const old = findItem(plan, 'OLD');
    expect(old.target).toBe(0);
    expect(old.delta).toBe(-40);
    expect(old.action).toBe('SELL');
    expect(old.note).toMatch(/exit/);
  });

  it('only acts on its own universe — never an untracked symbol', () => {
    const cfg = makeConfig({ tickers: ['AAA'], positions: { AAA: 100 } });
    const plan = computeRebalancePlan(cfg, { AAA: 100, ZZZ: 10 });
    expect(plan.find((i) => i.symbol === 'ZZZ')).toBeUndefined();
  });

  it('no-op when already at target', () => {
    // $10k total over 1 pick → $10k/pick → 100 shares at $100.
    const cfg = makeConfig({ totalUsd: 10000, tickers: ['AAA'], positions: { AAA: 100 } });
    const plan = computeRebalancePlan(cfg, { AAA: 100 });
    expect(findItem(plan, 'AAA').delta).toBe(0);
    expect(findItem(plan, 'AAA').action).toBeNull();
  });

  it('splits the total budget evenly across the picks', () => {
    // $30k / 3 picks = $10k per pick.
    const cfg = makeConfig({ totalUsd: 30000, tickers: ['AAA', 'BBB', 'CCC'], positions: {} });
    const plan = computeRebalancePlan(cfg, { AAA: 100, BBB: 200, CCC: 50 });
    expect(findItem(plan, 'AAA').target).toBe(100); // 10000 / 100
    expect(findItem(plan, 'BBB').target).toBe(50); //  10000 / 200
    expect(findItem(plan, 'CCC').target).toBe(200); // 10000 / 50
  });

  it('per-pick allocation excludes dropped holdings', () => {
    // $120k / 5 picks = $24k each; the held-but-dropped OLD does not dilute it.
    const cfg = makeConfig({
      totalUsd: 120000,
      tickers: ['A', 'B', 'C', 'D', 'E'],
      positions: { OLD: 10 },
    });
    expect(allocationPerPick(cfg)).toBe(24000);
  });

  it('skips a pick with no price (cannot size a buy)', () => {
    const cfg = makeConfig({ tickers: ['AAA'], positions: {} });
    const plan = computeRebalancePlan(cfg, { AAA: null });
    const aaa = findItem(plan, 'AAA');
    expect(aaa.target).toBeNull();
    expect(aaa.delta).toBe(0);
    expect(aaa.action).toBeNull();
    expect(aaa.note).toMatch(/no price/);
  });
});

describe('applyFillToPositions', () => {
  it('adds on buy', () => {
    expect(applyFillToPositions({ AAA: 10 }, 'AAA', 'BUY', 5)).toEqual({ AAA: 15 });
    expect(applyFillToPositions({}, 'BBB', 'BUY', 7)).toEqual({ BBB: 7 });
  });

  it('subtracts on sell and removes at zero', () => {
    expect(applyFillToPositions({ AAA: 10 }, 'AAA', 'SELL', 4)).toEqual({ AAA: 6 });
    expect(applyFillToPositions({ AAA: 10 }, 'AAA', 'SELL', 10)).toEqual({});
    expect(applyFillToPositions({ AAA: 10, BBB: 3 }, 'AAA', 'SELL', 10)).toEqual({ BBB: 3 });
  });

  it('does not mutate the input', () => {
    const input = { AAA: 10 };
    applyFillToPositions(input, 'AAA', 'BUY', 5);
    expect(input).toEqual({ AAA: 10 });
  });
});

describe('evaluateTrigger', () => {
  // 2026-07-06 is a Monday; 2026-07-04/05 are weekend.
  const monday = (h: number, m: number) => new Date(2026, 6, 6, h, m, 0);

  it('fires inside the pre-open window on a weekday', () => {
    const d = evaluateTrigger(monday(9, 22), '09:20', null);
    expect(d.fire).toBe(true);
    expect(d.targetDate).toBe('2026-07-06');
  });

  it('does not fire before the trigger time', () => {
    expect(evaluateTrigger(monday(9, 10), '09:20', null).fire).toBe(false);
  });

  it('does not fire after the open (waits for next session)', () => {
    const d = evaluateTrigger(monday(9, 31), '09:20', null);
    expect(d.fire).toBe(false);
    expect(d.reason).toMatch(/after open/);
  });

  it('does not fire at/after the open boundary (9:30)', () => {
    expect(evaluateTrigger(monday(9, 30), '09:20', null).fire).toBe(false);
  });

  it('respects the lastPlacedDate idempotency guard', () => {
    const d = evaluateTrigger(monday(9, 22), '09:20', '2026-07-06');
    expect(d.fire).toBe(false);
    expect(d.reason).toMatch(/already placed/);
  });

  it('does not fire on weekends', () => {
    const saturday = new Date(2026, 6, 4, 9, 22, 0);
    expect(evaluateTrigger(saturday, '09:20', null).fire).toBe(false);
  });
});

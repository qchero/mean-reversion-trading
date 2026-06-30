/**
 * Pure rebalance math for the QuantGT monthly strategy. No IO — fully unit-testable.
 * See SPEC.md §2 (math) and §4 (trigger).
 */

import type { QtConfig } from './config';

export type Action = 'BUY' | 'SELL';

export interface RebalanceItem {
  symbol: string;
  /** Latest price used for sizing; null if unavailable. */
  price: number | null;
  /** Shares currently held (from config.positions). */
  current: number;
  /** Desired shares; null when a buy-side target can't be sized (no price). */
  target: number | null;
  /** target - current; 0 when target is null. */
  delta: number;
  action: Action | null;
  /** Human-readable note for the preview, e.g. "exit (dropped)" or "no price". */
  note: string;
}

/** Target share count for a fixed dollar allocation. Whole shares. */
export function targetSharesFor(perTickerUsd: number, price: number): number {
  if (!(price > 0)) return 0;
  return Math.round(perTickerUsd / price);
}

/**
 * Build the rebalance plan over the union of this month's tickers and any held
 * positions. Tickers held but not in this month's picks are exited (target 0).
 */
export function computeRebalancePlan(
  config: QtConfig,
  prices: Record<string, number | null>,
): RebalanceItem[] {
  const inPicks = new Set(config.tickers);
  const universe = [...new Set([...config.tickers, ...Object.keys(config.positions)])];

  const items: RebalanceItem[] = [];
  for (const symbol of universe) {
    const current = config.positions[symbol] ?? 0;
    const price = prices[symbol] ?? null;

    let target: number | null;
    let note = '';

    if (inPicks.has(symbol)) {
      if (price !== null && price > 0) {
        target = targetSharesFor(config.perTickerUsd, price);
      } else {
        // Can't size a buy/adjust without a price — skip this ticker this cycle.
        target = null;
        note = 'no price';
      }
    } else {
      // Held but dropped from this month's picks → full exit. No price needed.
      target = 0;
      note = 'exit (dropped)';
    }

    const delta = target === null ? 0 : target - current;
    const action: Action | null = delta > 0 ? 'BUY' : delta < 0 ? 'SELL' : null;
    if (!note) {
      if (action === null) note = current === 0 ? 'skip (zero)' : 'hold';
    }

    items.push({ symbol, price, current, target, delta, action, note });
  }

  return items;
}

/**
 * Apply an actual fill to the positions map (pure — returns a new map).
 * BUY adds shares, SELL subtracts; a symbol reaching 0 is removed.
 */
export function applyFillToPositions(
  positions: Record<string, number>,
  symbol: string,
  action: Action,
  filledQty: number,
): Record<string, number> {
  const next = { ...positions };
  const current = next[symbol] ?? 0;
  const updated = action === 'BUY' ? current + filledQty : current - filledQty;
  if (updated > 0) {
    next[symbol] = updated;
  } else {
    delete next[symbol];
  }
  return next;
}

// ── Trigger timing (SPEC.md §4) ──

/** Minutes since ET midnight for the regular-session open (9:30). */
export const MARKET_OPEN_MINUTES = 9 * 60 + 30;

export interface TriggerDecision {
  fire: boolean;
  /** Trading date (YYYY-MM-DD) the order targets — used for the idempotency guard. */
  targetDate: string;
  reason: string;
}

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseHHMM(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Decide whether to submit MOO orders now.
 *
 * `nowEt` must be a Date whose local fields represent ET wall-clock time.
 * Fires only inside the pre-open window [triggerEtTime, 9:30) on a weekday, and
 * never twice for the same trading date (lastPlacedDate guard). A late start
 * (after the open) simply doesn't fire — the caller keeps polling until the
 * next session's window.
 */
export function evaluateTrigger(
  nowEt: Date,
  triggerEtTime: string,
  lastPlacedDate: string | null,
): TriggerDecision {
  const targetDate = dateStr(nowEt);
  const day = nowEt.getDay();
  const minutes = nowEt.getHours() * 60 + nowEt.getMinutes();
  const triggerMinutes = parseHHMM(triggerEtTime);

  if (day === 0 || day === 6) {
    return { fire: false, targetDate, reason: 'weekend — waiting for next session' };
  }
  if (lastPlacedDate === targetDate) {
    return { fire: false, targetDate, reason: `already placed for ${targetDate}` };
  }
  if (minutes < triggerMinutes) {
    return { fire: false, targetDate, reason: `before trigger (${triggerEtTime} ET)` };
  }
  if (minutes >= MARKET_OPEN_MINUTES) {
    return { fire: false, targetDate, reason: 'after open — waiting for next session' };
  }
  return { fire: true, targetDate, reason: 'in pre-open window' };
}

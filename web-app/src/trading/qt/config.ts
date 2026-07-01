/**
 * QuantGT monthly-rebalance config + state.
 *
 * A single JSON file holds both the user-maintained plan (totalUsd, tickers)
 * and the machine-maintained state (positions, lastPlacedDate). See SPEC.md §5.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

export interface QtConfig {
  /** Total dollar budget, split evenly across this month's picks. */
  totalUsd: number;
  /** This month's picks (the rebalance universe). */
  tickers: string[];

  // ── Machine-maintained (do not hand-edit) ──
  /** qt's current holdings: symbol -> shares. Source of truth for deltas. */
  positions: Record<string, number>;
  /** Trading date (YYYY-MM-DD ET) qt last placed orders for. Idempotency guard. */
  lastPlacedDate: string | null;
}

/** Default config path, relative to the process cwd (web-app/). */
export const DEFAULT_CONFIG_PATH = 'src/trading/qt/config.json';

export function loadConfig(path = DEFAULT_CONFIG_PATH): { config: QtConfig; path: string } {
  const abs = resolve(process.cwd(), path);

  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch {
    throw new Error(`qt config not found at ${abs} — copy config.example.json to config.json`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`qt config is not valid JSON (${abs}): ${(e as Error).message}`);
  }

  const config = validate(parsed, abs);
  return { config, path: abs };
}

function validate(raw: unknown, abs: string): QtConfig {
  const fail = (msg: string): never => {
    throw new Error(`qt config invalid (${abs}): ${msg}`);
  };

  if (typeof raw !== 'object' || raw === null) fail('expected a JSON object');
  const o = raw as Record<string, unknown>;

  if (typeof o.totalUsd !== 'number' || !(o.totalUsd > 0)) {
    fail('totalUsd must be a positive number');
  }

  if (!Array.isArray(o.tickers) || o.tickers.length === 0 || !o.tickers.every((t) => typeof t === 'string' && t.trim())) {
    fail('tickers must be a non-empty array of symbol strings');
  }
  const tickers = (o.tickers as string[]).map((t) => t.trim().toUpperCase());
  const dupes = tickers.filter((t, i) => tickers.indexOf(t) !== i);
  if (dupes.length) fail(`duplicate tickers: ${[...new Set(dupes)].join(', ')}`);

  // positions: optional, default {}. Validate shape if present.
  let positions: Record<string, number> = {};
  if (o.positions !== undefined) {
    if (typeof o.positions !== 'object' || o.positions === null || Array.isArray(o.positions)) {
      fail('positions must be an object of symbol -> shares');
    }
    for (const [sym, qty] of Object.entries(o.positions as Record<string, unknown>)) {
      if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 0) {
        fail(`positions.${sym} must be a non-negative integer`);
      }
      positions[sym.toUpperCase()] = qty as number;
    }
  }

  const lastPlacedDate =
    o.lastPlacedDate === undefined || o.lastPlacedDate === null ? null : String(o.lastPlacedDate);

  return {
    totalUsd: o.totalUsd as number,
    tickers,
    positions,
    lastPlacedDate,
  };
}

/**
 * Persist config back to disk. Only `positions` and `lastPlacedDate` change at
 * runtime, but we re-serialize the whole object (2-space indent, trailing newline).
 */
export function saveConfig(path: string, config: QtConfig): void {
  const abs = resolve(process.cwd(), path);
  writeFileSync(abs, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

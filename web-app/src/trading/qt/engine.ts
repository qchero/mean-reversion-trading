/**
 * QuantGT monthly-rebalance engine.
 *
 * Lifecycle (one run = one rebalance):
 *   poll every POLL_INTERVAL_SEC → preview the plan → once inside the pre-open
 *   window (evaluateTrigger), submit MOO orders exactly once → assume they fill,
 *   write the target positions back to the config → exit (fire-and-forget).
 *
 * A late start (after 9:30) simply keeps polling until the next session's window.
 * See SPEC.md.
 */

import { IBKRClient } from '../ibkr';
import { QtConfig, loadConfig, saveConfig } from './config';
import { QuoteLine, readQuotes } from './prices';
import {
  RebalanceItem,
  computeRebalancePlan,
  applyFillToPositions,
  allocationPerPick,
  evaluateTrigger,
} from './logic';

function etNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function etClock(): string {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/** Grace period after subscribing for the first IBKR ticks to arrive. */
const WARMUP_MS = 3000;

/** ET wall-clock time the MOO submit window opens; orders fire in [TRIGGER_ET_TIME, 9:30). */
const TRIGGER_ET_TIME = '09:20';
/** Preview + trigger-check cadence. */
const POLL_INTERVAL_SEC = 300;

/** Brief pause after submitting so the orders flush to IBKR before we disconnect. */
const TRANSMIT_FLUSH_MS = 2000;

export class QtEngine {
  private config!: QtConfig;
  private configPath!: string;

  private placed = false; // in-process guard (one submit per run)
  private stopped = false;

  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepResolve: (() => void) | null = null;

  constructor(
    private ibkr: IBKRClient,
    private path: string,
    private opts: { simulate?: boolean } = {},
  ) {}

  private get simulate(): boolean {
    return this.opts.simulate ?? false;
  }

  /** Run until orders are placed (or there's nothing to do), then resolve. */
  async run(): Promise<void> {
    const loaded = loadConfig(this.path);
    this.config = loaded.config;
    this.configPath = loaded.path;

    console.log(`[qt] Config: $${fmtUsd(this.config.totalUsd)} total ÷ ${this.config.tickers.length} = $${fmtUsd(allocationPerPick(this.config))}/pick | ${this.config.tickers.join(', ')}`);
    console.log(`[qt] Trigger: ${TRIGGER_ET_TIME} ET | poll every ${POLL_INTERVAL_SEC}s | mode: ${this.simulate ? 'SIMULATE' : 'LIVE'}`);
    console.log(`[qt] Current positions: ${this.describePositions()}`);
    if (this.config.lastPlacedDate) {
      console.log(`[qt] Last placed: ${this.config.lastPlacedDate}`);
    }

    // Both modes connect + stream IBKR quotes; only placement + write-back are
    // gated on live (simulate = live minus the side effects).
    const universe = [...new Set([...this.config.tickers, ...Object.keys(this.config.positions)])];
    await this.ibkr.connect();
    for (const sym of universe) this.ibkr.subscribeMarketData(sym);
    console.log(`[qt] Subscribed to IBKR market data for ${universe.length} symbol(s); warming up...`);
    await this.sleep(WARMUP_MS);

    while (!this.stopped) {
      const quotes = readQuotes(this.ibkr, universe);
      this.logQuotes(quotes);
      const prices = Object.fromEntries(quotes.map((q) => [q.symbol, q.price]));
      const plan = computeRebalancePlan(this.config, prices);

      this.printPreview(plan);

      const decision = evaluateTrigger(etNow(), TRIGGER_ET_TIME, this.config.lastPlacedDate);
      if (decision.fire && !this.placed) {
        await this.placeAndSettle(plan, decision.targetDate);
        return;
      }

      console.log(`[qt] holding — ${decision.reason}`);
      await this.sleep(POLL_INTERVAL_SEC * 1000);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sleepResolve) this.sleepResolve();
    this.ibkr.disconnect();
  }

  // ── Placement + settlement ──

  private async placeAndSettle(plan: RebalanceItem[], targetDate: string): Promise<void> {
    this.placed = true;
    const actionable = plan.filter((i) => i.action && i.delta !== 0);

    console.log(`\n[${etClock()} ET] ═══ TRIGGER — rebalancing for ${targetDate} ═══`);

    if (actionable.length === 0) {
      console.log('[qt] Already at target — no orders to place.');
      if (!this.simulate) {
        this.config.lastPlacedDate = targetDate;
        saveConfig(this.configPath, this.config);
        console.log(`[qt] Marked ${targetDate} as placed (no-op).`);
      }
      await this.finish();
      return;
    }

    if (this.simulate) {
      for (const item of actionable) {
        console.log(`  WOULD ${item.action} ${Math.abs(item.delta)} ${item.symbol} (MOO)`);
      }
      console.log(`[qt] (simulate) projected positions: ${this.describePositions(this.projectFills(actionable))}`);
      console.log('[qt] (simulate) no orders placed, no state written.');
      await this.finish();
      return;
    }

    // ── Live: fire-and-forget. Submit the MOO orders, assume each fills in full at
    // the open, write the resulting portfolio + idempotency guard, then quit. We do
    // not wait for or track fills; the orders stay live at IBKR after we disconnect. ──
    for (const item of actionable) {
      const qty = Math.abs(item.delta);
      const orderId = this.ibkr.placeMOOOrder(item.symbol, item.action!, qty);
      console.log(`  ${item.action} ${qty} ${item.symbol} → order #${orderId}`);
    }

    this.config.positions = this.projectFills(actionable);
    this.config.lastPlacedDate = targetDate;
    saveConfig(this.configPath, this.config);

    console.log(`[qt] ${actionable.length} MOO order(s) submitted (fire-and-forget; assumed filled).`);
    console.log(`[qt] New positions: ${this.describePositions()}`);
    console.log('[qt] Rebalance complete.');

    await this.sleep(TRANSMIT_FLUSH_MS); // let the orders flush to IBKR before disconnecting
    await this.finish();
  }

  /** Positions after applying the intended order deltas (assumes each order fills in full). */
  private projectFills(actionable: RebalanceItem[]): Record<string, number> {
    let positions = { ...this.config.positions };
    for (const item of actionable) {
      positions = applyFillToPositions(positions, item.symbol, item.action!, Math.abs(item.delta));
    }
    return positions;
  }

  private async finish(): Promise<void> {
    this.stopped = true;
    this.ibkr.disconnect();
  }

  // ── Helpers ──

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepResolve = resolve;
      this.sleepTimer = setTimeout(() => {
        this.sleepResolve = null;
        resolve();
      }, ms);
    });
  }

  private describePositions(positions: Record<string, number> = this.config.positions): string {
    const entries = Object.entries(positions);
    if (entries.length === 0) return '(none)';
    return entries.map(([s, q]) => `${s}:${q}`).join('  ');
  }

  /** Log raw bid/ask/last per ticker so the best sizing field can be judged. */
  private logQuotes(quotes: QuoteLine[]): void {
    const f = (n: number) => (n > 0 ? `$${n.toFixed(2)}` : '--');
    console.log(`\n[${etClock()} ET] IBKR quotes (bid / ask / last → sizing):`);
    for (const q of quotes) {
      const chosen = q.price !== null ? `$${q.price.toFixed(2)} (${q.source})` : '-- (no quote)';
      console.log(
        `  ${q.symbol.padEnd(6)} ` +
        `bid ${f(q.bid).padStart(9)}  ask ${f(q.ask).padStart(9)}  last ${f(q.last).padStart(9)}` +
        `  →  ${chosen}`,
      );
    }
  }

  private printPreview(plan: RebalanceItem[]): void {
    console.log(`\n[${etClock()} ET] preview — $${fmtUsd(allocationPerPick(this.config))}/pick ($${fmtUsd(this.config.totalUsd)} total)`);
    for (const item of plan) {
      const priceStr = item.price !== null ? `$${item.price.toFixed(2)}` : '$  --';
      const targetStr = item.target !== null ? String(item.target) : '?';
      const deltaStr = item.delta > 0 ? `+${item.delta}` : `${item.delta}`;
      const act = item.action ?? 'HOLD';
      console.log(
        `  ${item.symbol.padEnd(6)} ${priceStr.padStart(9)} | ` +
        `${String(item.current).padStart(4)} → ${targetStr.padStart(4)} (${deltaStr.padStart(5)}) | ` +
        `${act.padEnd(4)}${item.note ? '  ' + item.note : ''}`,
      );
    }
  }
}

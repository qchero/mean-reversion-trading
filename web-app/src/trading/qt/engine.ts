/**
 * QuantGT monthly-rebalance engine.
 *
 * Lifecycle (one run = one rebalance):
 *   poll every pollIntervalSec → preview the plan → once inside the pre-open
 *   window (evaluateTrigger), submit MOO orders exactly once → wait for the
 *   opening-auction fills → write the new positions back to the config → exit.
 *
 * A late start (after 9:30) simply keeps polling until the next session's window.
 * See SPEC.md.
 */

import { IBKRClient, OrderFill } from '../ibkr';
import { QtConfig, loadConfig, saveConfig } from './config';
import { fetchPrices } from './prices';
import {
  Action,
  RebalanceItem,
  computeRebalancePlan,
  applyFillToPositions,
  evaluateTrigger,
} from './logic';

interface PendingOrder {
  symbol: string;
  action: Action;
  qty: number;
}

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

export class QtEngine {
  private config!: QtConfig;
  private configPath!: string;

  private placed = false; // in-process guard (one submit per run)
  private stopped = false;

  private pendingOrders = new Map<number, PendingOrder>();
  private orderFills = new Map<number, { filledQty: number; status: string }>();
  private processedTerminal = new Set<number>();

  private fillWaitResolve: (() => void) | null = null;
  private fillWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepResolve: (() => void) | null = null;

  constructor(
    private ibkr: IBKRClient,
    private path: string,
    private opts: { simulate?: boolean; fillTimeoutMs?: number } = {},
  ) {}

  private get simulate(): boolean {
    return this.opts.simulate ?? false;
  }

  /** Run until the rebalance completes (orders placed + settled + written), then resolve. */
  async run(): Promise<void> {
    const loaded = loadConfig(this.path);
    this.config = loaded.config;
    this.configPath = loaded.path;

    console.log(`[qt] Config: ${this.config.month} | $${fmtUsd(this.config.perTickerUsd)}/ticker | ${this.config.tickers.join(', ')}`);
    console.log(`[qt] Trigger: ${this.config.triggerEtTime} ET | poll every ${this.config.pollIntervalSec}s | mode: ${this.simulate ? 'SIMULATE' : 'LIVE'}`);
    console.log(`[qt] Current positions: ${this.describePositions()}`);
    if (this.config.lastPlacedDate) {
      console.log(`[qt] Last placed: ${this.config.lastPlacedDate}`);
    }

    if (!this.simulate) {
      await this.ibkr.connect();
      this.ibkr.setOnOrderStatus((fill) => this.handleOrderStatus(fill));
    }

    while (!this.stopped) {
      const universe = [...new Set([...this.config.tickers, ...Object.keys(this.config.positions)])];
      const prices = await fetchPrices(universe);
      const plan = computeRebalancePlan(this.config, prices);

      this.printPreview(plan);

      const decision = evaluateTrigger(etNow(), this.config.triggerEtTime, this.config.lastPlacedDate);
      if (decision.fire && !this.placed) {
        await this.placeAndSettle(plan, decision.targetDate);
        return;
      }

      console.log(`[qt] holding — ${decision.reason}`);
      await this.sleep(this.config.pollIntervalSec * 1000);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sleepResolve) this.sleepResolve();
    this.resolveFillWait();
    if (!this.simulate) this.ibkr.disconnect();
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
      // Show the resulting portfolio without writing anything.
      let projected = { ...this.config.positions };
      for (const item of actionable) {
        projected = applyFillToPositions(projected, item.symbol, item.action!, Math.abs(item.delta));
      }
      console.log(`[qt] (simulate) projected positions: ${this.describePositions(projected)}`);
      console.log('[qt] (simulate) no orders placed, no state written.');
      await this.finish();
      return;
    }

    // ── Live: submit MOO orders ──
    for (const item of actionable) {
      const qty = Math.abs(item.delta);
      const orderId = this.ibkr.placeMOOOrder(item.symbol, item.action!, qty);
      this.pendingOrders.set(orderId, { symbol: item.symbol, action: item.action!, qty });
      console.log(`  ${item.action} ${qty} ${item.symbol} → order #${orderId}`);
    }

    // Persist the idempotency guard BEFORE waiting for fills: if we're killed
    // mid-wait, a restart won't double-place (positions may then be stale until
    // reconciled — orders are already live at IBKR).
    this.config.lastPlacedDate = targetDate;
    saveConfig(this.configPath, this.config);

    console.log(`[qt] ${actionable.length} MOO order(s) submitted. Waiting for the opening-auction fills...`);
    await this.waitForFills(this.opts.fillTimeoutMs ?? 60 * 60 * 1000);

    this.recordFills();
    saveConfig(this.configPath, this.config);
    console.log(`[qt] New positions: ${this.describePositions()}`);
    console.log('[qt] Rebalance complete.');

    await this.finish();
  }

  /** Fold the actual fills into config.positions. */
  private recordFills(): void {
    let positions = { ...this.config.positions };
    let unfilled = 0;

    for (const [orderId, ctx] of this.pendingOrders) {
      const res = this.orderFills.get(orderId);
      const filled = res?.filledQty ?? 0;
      if (filled > 0) {
        positions = applyFillToPositions(positions, ctx.symbol, ctx.action, filled);
        if (filled < ctx.qty) {
          console.warn(`[qt] ⚠️  ${ctx.symbol} partial fill: ${filled}/${ctx.qty} (status ${res?.status})`);
        }
      } else {
        unfilled++;
        console.warn(`[qt] ⚠️  ${ctx.symbol} order #${orderId} did not fill (status ${res?.status ?? 'unknown'})`);
      }
    }

    if (unfilled > 0) {
      console.warn(`[qt] ⚠️  ${unfilled} order(s) unfilled — positions reflect actual fills only.`);
    }
    this.config.positions = positions;
  }

  private handleOrderStatus(fill: OrderFill): void {
    const ctx = this.pendingOrders.get(fill.ibkrOrderId);
    if (!ctx) return;

    const isTerminal = fill.status === 'Filled' || fill.status === 'Cancelled' || fill.status === 'Inactive';
    if (!isTerminal) {
      console.log(`[qt] #${fill.ibkrOrderId} ${ctx.symbol}: ${fill.status} (filled ${fill.filled}/${ctx.qty})`);
      return;
    }
    if (this.processedTerminal.has(fill.ibkrOrderId)) return; // IBKR repeats terminal callbacks
    this.processedTerminal.add(fill.ibkrOrderId);

    this.orderFills.set(fill.ibkrOrderId, { filledQty: fill.filled, status: fill.status });
    console.log(`[qt] #${fill.ibkrOrderId} ${ctx.symbol}: ${fill.status} — filled ${fill.filled} @ $${fill.avgFillPrice.toFixed(2)}`);

    if (this.processedTerminal.size >= this.pendingOrders.size) {
      this.resolveFillWait();
    }
  }

  private waitForFills(maxWaitMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.pendingOrders.size === 0 || this.processedTerminal.size >= this.pendingOrders.size) {
        return resolve();
      }
      this.fillWaitResolve = resolve;
      this.fillWaitTimer = setTimeout(() => {
        console.warn('[qt] ⚠️  Fill wait timed out — proceeding with fills received so far.');
        this.resolveFillWait();
      }, maxWaitMs);
    });
  }

  private resolveFillWait(): void {
    if (this.fillWaitTimer) {
      clearTimeout(this.fillWaitTimer);
      this.fillWaitTimer = null;
    }
    const r = this.fillWaitResolve;
    this.fillWaitResolve = null;
    if (r) r();
  }

  private async finish(): Promise<void> {
    this.stopped = true;
    if (!this.simulate) this.ibkr.disconnect();
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

  private printPreview(plan: RebalanceItem[]): void {
    console.log(`\n[${etClock()} ET] preview — $${fmtUsd(this.config.perTickerUsd)}/ticker`);
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

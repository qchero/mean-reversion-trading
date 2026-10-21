import { PrismaClient, LinearLot, LinearStrategy } from '@prisma/client';
import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { IBKRClient, MarketTick, OrderFill } from '../ibkr';
import { fetchAndComputeMetrics, evaluateLinearTarget, getLatestPrice, LinearData } from './logic';

const prisma = new PrismaClient();
const STRATEGY_RELOAD_MS = 60 * 1000;
// Reload + tick cadence while the market is closed — nothing executes, so keep DB traffic minimal
const MARKET_CLOSED_INTERVAL_MS = 15 * 60 * 1000;

// Fills that could not be written to the DB are appended here; their symbols stop trading until reconciled
const UNRECORDED_FILLS_PATH = path.join(process.cwd(), 'unrecorded-fills.jsonl');
// Retry delays for fill writes (~16 min total) to ride out DB outages before falling back to the journal
const FILL_WRITE_RETRY_DELAYS_MS = [5, 15, 30, 60, 120, 240, 480].map(s => s * 1000);

// The exact minute of the day to execute real trades (15:45 ET)
const EXEC_HOUR = 15;
const EXEC_MINUTE = 48;

type EvalResult = ReturnType<typeof evaluateLinearTarget>;

interface StrategyState {
  strategy: LinearStrategy;
  lots: LinearLot[];
  metrics: LinearData;
}

interface PendingContext {
  state: StrategyState;
  action: 'BUY' | 'SELL';
  evalResult: EvalResult;
  targetPrice: number;
}

function timestamp(): string {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function todayStr(): string {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

function isMarketOpen(): boolean {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 570 && minutes < 960;
}

function isExecutionTime(): boolean {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const minutes = et.getHours() * 60 + et.getMinutes();
  return isMarketOpen() && minutes >= EXEC_HOUR * 60 + EXEC_MINUTE;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Symbols with entries in the unrecorded-fills journal — their DB lots no longer match IBKR */
function loadBlockedSymbols(): Set<string> {
  if (!existsSync(UNRECORDED_FILLS_PATH)) return new Set();
  const lines = readFileSync(UNRECORDED_FILLS_PATH, 'utf8').split('\n').filter(Boolean);
  return new Set(lines.map(line => JSON.parse(line).symbol as string));
}

function sameMetrics(a: LinearData, b: LinearData): boolean {
  return a.sma100 === b.sma100 && a.sma200 === b.sma200 && a.sma300 === b.sma300 && a.sigma === b.sigma;
}

export class LinearTradingEngine {
  private ibkr: IBKRClient;
  private strategies = new Map<string, StrategyState>();
  private running = false;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private metricsRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private executionTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly EXECUTION_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20 hours
  private lastBatchExecutedAt: number | null = null;
  private pendingOrders = new Map<number, PendingContext>();
  private processedOrders = new Set<number>();
  private tickRunning = false;

  // DB write throttling: skip unchanged prices, heartbeat at most every 5 min
  // (well under the UI's 20-min stale threshold).
  private static readonly HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
  private lastPersistedPrice = new Map<string, number>();
  private lastHeartbeatAt = 0;

  private simulate = false;

  constructor(client: IBKRClient, simulate = false) {
    this.ibkr = client;
    this.simulate = simulate;
  }

  async start() {
    console.log('[LinearEngine] Starting...');
    await this.ibkr.connect();

    this.ibkr.setOnTick((tick) => this.handleTick(tick));
    this.ibkr.setOnOrderStatus((fill) => {
      this.handleOrderFill(fill).catch(e => console.error(`[LinearEngine] Fallback error handling order fill:`, e));
    });

    const blocked = loadBlockedSymbols();
    if (blocked.size > 0) {
      console.error(`[LinearEngine] ‼️ Unrecorded fills for ${[...blocked].join(', ')} in ${UNRECORDED_FILLS_PATH} — these symbols will not trade until reconciled.`);
    }

    await this.loadStrategies();
    this.running = true;

    // Strategy reload: 60s when market open, 15min when closed
    const scheduleReload = () => {
      if (!this.running) return;
      const interval = isMarketOpen() ? STRATEGY_RELOAD_MS : MARKET_CLOSED_INTERVAL_MS;
      this.reloadTimer = setTimeout(() => {
        this.loadStrategies().finally(scheduleReload);
      }, interval);
    };
    scheduleReload();
    this.metricsRefreshTimer = setInterval(() => this.refreshMetrics(), 60 * 60 * 1000);

    // Tick loop: 60s when market open, 15min when closed
    const scheduleNext = () => {
      const interval = isMarketOpen() ? 60_000 : MARKET_CLOSED_INTERVAL_MS;
      this.executionTimer = setTimeout(() => {
        this.tick()
          .catch(e => console.error(`[LinearEngine] Execution loop error:`, e))
          .finally(scheduleNext);
      }, interval);
    };
    // First tick immediately, then schedule recurring
    this.tick().catch(e => console.error(`[LinearEngine] Execution loop error:`, e)).finally(scheduleNext);

    console.log('[LinearEngine] Running. Press Ctrl+C to stop.');
  }

  // ── Public REPL methods ──

  async injectTick(tick: MarketTick) {
    this.handleTick(tick);
    this.lastBatchExecutedAt = null;
    await this.tick();
  }

  previewTrade(symbol: string, overridePrice?: number) {
    const state = this.strategies.get(symbol);
    if (!state) {
      console.log(`  [Preview] No active strategy for ${symbol}`);
      return null;
    }

    const ev = this.evaluateState(state, overridePrice);
    if (!ev) {
      console.log(`  [Preview] No price available for ${symbol}. Inject a price first (e.g. ${symbol} 170)`);
      return null;
    }

    const { price, currentShares, evalResult } = ev;

    // LIFO cost basis for sell context
    let lifoCostBasis: number | null = null;
    let sellPlan: { qty: number; limitPrice: number; skippedShares: number } | null = null;
    if (evalResult.action === 'SELL' || evalResult.clampedDiff < 0) {
      sellPlan = this.computeSellPlan(state, Math.abs(evalResult.clampedDiff), price, false);
      lifoCostBasis = sellPlan.limitPrice > 0 ? sellPlan.limitPrice / 1.001 : null;
      if (sellPlan.qty === 0) {
        console.log(`  ⛔ NO-LOSS RULE: all lots unprofitable at $${price.toFixed(2)}`);
      } else if (sellPlan.skippedShares > 0) {
        console.log(`  ⚠️  Partial sell: ${sellPlan.qty}/${Math.abs(evalResult.clampedDiff)} shares profitable (${sellPlan.skippedShares} skipped)`);
      }
    }

    console.log(`\n  ┌─── Preview: ${symbol} @ $${price.toFixed(2)} ───`);
    console.log(`  │ SMA200:         $${state.metrics.sma200.toFixed(2)}`);
    console.log(`  │ Volatility:     ${(state.metrics.sigma * 100).toFixed(2)}%`);
    console.log(`  │ Sigma Below:    ${evalResult.sigmaBelow.toFixed(2)}σ`);
    console.log(`  │ Band:           [${state.strategy.bandLo}σ → ${state.strategy.bandHi}σ]`);
    console.log(`  │ Current Shares: ${currentShares}`);
    console.log(`  │ Target Shares:  ${evalResult.targetShares}`);
    console.log(`  │ Target Value:   $${evalResult.targetValue.toFixed(2)}`);
    console.log(`  │ Clamped Diff:   ${evalResult.clampedDiff > 0 ? '+' : ''}${evalResult.clampedDiff}`);
    console.log(`  │ Unclamped Diff: ${evalResult.unclampedDiff > 0 ? '+' : ''}${evalResult.unclampedDiff}`);
    console.log(`  │ Action:         ${evalResult.action ?? 'HOLD (below threshold)'}`);
    if (lifoCostBasis !== null) {
      console.log(`  │ LIFO AvgCost:   $${lifoCostBasis.toFixed(2)}`);
    }
    console.log(`  └───────────────────────────\n`);

    return evalResult;
  }

  async placeRealOrder(symbol: string, overridePrice?: number) {
    const state = this.strategies.get(symbol);
    if (!state) {
      console.log(`  [Order] No active strategy for ${symbol}`);
      return;
    }
    if (loadBlockedSymbols().has(symbol)) {
      console.log(`  [Order] ${symbol} is blocked — unrecorded fill in ${UNRECORDED_FILLS_PATH}`);
      return;
    }

    const ev = this.evaluateState(state, overridePrice);
    if (!ev) {
      console.log(`  [Order] No price available for ${symbol}. Inject a price first (e.g. ${symbol} 170)`);
      return;
    }

    if (!ev.evalResult.action) {
      console.log(`  [Order] No action needed for ${symbol} at $${ev.price.toFixed(2)}`);
      return;
    }

    const { action } = ev.evalResult;
    let qty = Math.abs(ev.evalResult.clampedDiff);

    let ibkrOrderId: number;
    if (action === 'BUY') {
      console.log(`  [Order] Placing REAL MOC BUY for ${qty} shares of ${symbol}`);
      ibkrOrderId = this.ibkr.placeMOCOrder(symbol, 'BUY', qty);
    } else {
      const plan = this.computeSellPlan(state, qty, ev.price);
      if (plan.qty === 0) {
        console.log(`  [Order] No profitable lots to sell for ${symbol}`);
        return;
      }
      qty = plan.qty;
      console.log(`  [Order] Placing REAL LOC SELL for ${qty} shares of ${symbol} @ $${plan.limitPrice.toFixed(2)}`);
      ibkrOrderId = this.ibkr.placeLOCOrder(symbol, 'SELL', qty, plan.limitPrice);
    }
    this.pendingOrders.set(ibkrOrderId, { state, action, evalResult: ev.evalResult, targetPrice: ev.price });
    console.log(`  [Order] ✅ Order ID: ${ibkrOrderId}`);
  }

  listStrategies() {
    if (this.strategies.size === 0) {
      console.log('  No active strategies loaded.');
      return;
    }
    for (const [sym, state] of this.strategies) {
      const shares = state.lots.reduce((acc, l) => acc + l.shares, 0);
      const lotCount = state.lots.filter(l => l.shares > 0).length;
      console.log(`  ${sym}: ${shares} shares across ${lotCount} lots | Band [${state.strategy.bandLo}σ→${state.strategy.bandHi}σ] | Budget $${state.strategy.maxBudget}`);
    }
  }

  async stop() {
    this.running = false;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    if (this.metricsRefreshTimer) clearInterval(this.metricsRefreshTimer);
    if (this.executionTimer) clearTimeout(this.executionTimer);
    this.ibkr.disconnect();
    await prisma.$disconnect();
  }

  // ── Data loading ──

  async loadStrategies() {
    try {
      const strategies = await prisma.linearStrategy.findMany({
        include: { lots: true },
      });

      const currentSymbols = new Set(strategies.map((s) => s.symbol));
      const prevSymbols = new Set(this.strategies.keys());

      for (const sym of prevSymbols) {
        if (!currentSymbols.has(sym)) {
          if (!this.simulate) this.ibkr.unsubscribeMarketData(sym);
          this.strategies.delete(sym);
          console.log(`[LinearEngine] Removed: ${sym}`);
        }
      }

      for (const strat of strategies) {
        let state = this.strategies.get(strat.symbol);

        // Mirror the DB's current price so persistPricesAndHeartbeat() only writes real changes
        if (strat.latestPrice != null) this.lastPersistedPrice.set(strat.id, strat.latestPrice);
        else this.lastPersistedPrice.delete(strat.id);

        if (!state) {
          console.log(`[LinearEngine] Fetching initial metrics for ${strat.symbol}...`);
          const metrics = await fetchAndComputeMetrics(strat.symbol);
          if (!metrics) {
            console.error(`[LinearEngine] Could not bootstrap metrics for ${strat.symbol}.`);
            continue;
          }
          state = { strategy: strat, lots: strat.lots, metrics };
          this.strategies.set(strat.symbol, state);
          await this.persistMetrics(strat.id, metrics);

          // Seed price from Yahoo so previews work before IBKR ticks arrive
          if (!strat.latestPrice) {
            const snap = await getLatestPrice(strat.symbol);
            if (snap.price) {
              state.strategy.latestPrice = snap.price;
              state.strategy.latestPriceAt = new Date();
            }
          }

          if (!this.simulate) this.ibkr.subscribeMarketData(strat.symbol);
          console.log(`[LinearEngine] Added: ${strat.symbol} | SMA200: $${metrics.sma200.toFixed(2)} | Price: $${state.strategy.latestPrice?.toFixed(2) ?? '?'}`);
        } else {
          state.strategy = strat;
          state.lots = strat.lots;
        }
      }
    } catch (err: any) {
      console.error('[LinearEngine] Failed to load strategies:', err.message);
    }
  }

  async refreshMetrics() {
    console.log('[LinearEngine] Performing hourly metric refresh...');
    for (const [sym, state] of this.strategies) {
      const metrics = await fetchAndComputeMetrics(sym);
      if (metrics) {
        // Metrics only move once a day (new close), so skip the hourly no-op writes
        const changed = !sameMetrics(metrics, state.metrics);
        state.metrics = metrics;
        if (changed) await this.persistMetrics(state.strategy.id, metrics);
      }
    }
  }

  // ── Private helpers ──

  private evaluateState(state: StrategyState, overridePrice?: number) {
    const price = overridePrice ?? state.strategy.latestPrice;
    if (!price || price <= 0) return null;

    const currentShares = state.lots.reduce((acc, l) => acc + l.shares, 0);
    const evalResult = evaluateLinearTarget(
      price,
      state.metrics.sma200,
      state.metrics.sigma,
      state.strategy.bandLo,
      state.strategy.bandHi,
      state.strategy.maxBudget,
      state.strategy.minTradeAmount,
      currentShares
    );

    return { price, currentShares, evalResult };
  }

  /** Sort lots by cost ascending — sell cheapest (most profitable) first */
  private sortedLotsForSell(state: StrategyState): LinearLot[] {
    return [...state.lots].sort((a, b) => a.price - b.price);
  }

  private async persistMetrics(strategyId: string, metrics: LinearData) {
    await prisma.linearStrategy.update({
      where: { id: strategyId },
      data: { sma100: metrics.sma100, sma200: metrics.sma200, sma300: metrics.sma300, dailyVolatility: metrics.sigma }
    }).catch(() => {});
  }

  /**
   * Write changed latestPrice values + (throttled) heartbeat in ONE transaction (called every tick loop).
   * One commit per tick instead of one per symbol; unchanged prices are skipped, and when nothing changed
   * and no heartbeat is due, nothing is written at all.
   */
  private async persistPricesAndHeartbeat() {
    // Snapshot now: ticks can update latestPrice while the transaction is in flight
    const changed = [...this.strategies.values()]
      .map(s => ({ id: s.strategy.id, latestPrice: s.strategy.latestPrice, latestPriceAt: s.strategy.latestPriceAt }))
      .filter(p => p.latestPrice && p.latestPrice !== this.lastPersistedPrice.get(p.id));
    const now = Date.now();
    const heartbeatDue = now - this.lastHeartbeatAt >= LinearTradingEngine.HEARTBEAT_INTERVAL_MS;
    if (changed.length === 0 && !heartbeatDue) return;

    try {
      await prisma.$transaction([
        ...changed.map(({ id, latestPrice, latestPriceAt }) => prisma.linearStrategy.update({
          where: { id },
          data: { latestPrice, latestPriceAt },
        })),
        ...(heartbeatDue ? [prisma.engineHeartbeat.upsert({
          where: { id: 'singleton' },
          update: { timestamp: new Date(now) },
          create: { id: 'singleton', timestamp: new Date(now) },
        })] : []),
      ]);
      for (const p of changed) this.lastPersistedPrice.set(p.id, p.latestPrice!);
      if (heartbeatDue) this.lastHeartbeatAt = now;
    } catch (e) {
      console.error(`[LinearEngine] Failed to persist prices/heartbeat:`, (e as Error).message);
    }
  }

  private handleTick(tick: MarketTick) {
    const state = this.strategies.get(tick.symbol);
    if (!state) return;

    const currentPrice = tick.last > 0 ? tick.last : ((tick.bid + tick.ask) / 2);
    if (currentPrice <= 0) return;

    state.strategy.latestPrice = currentPrice;
    state.strategy.latestPriceAt = new Date();
  }

  /**
   * Tick loop: called on interval (60s market open, 15min closed).
   * Always previews evaluations. Places orders ONCE at >= 15:45 ET, then locks via 20h cooldown.
   */
  private async tick() {
    if (!this.running) return;
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      await this.tickInner();
    } finally {
      this.tickRunning = false;
    }
  }

  private async tickInner() {
    // ── Preview: evaluate all strategies ──
    const actionable: { state: StrategyState; price: number; evalResult: EvalResult }[] = [];

    console.log(`\n[${timestamp()}]`);
    for (const [symbol, state] of this.strategies) {
      if (!state.strategy.autoExecute) continue;

      const ev = this.evaluateState(state);
      if (!ev) {
        console.log(`  ${symbol.padEnd(5)} — awaiting price`);
        continue;
      }

      const { price, currentShares, evalResult } = ev;
      const diffStr = evalResult.clampedDiff >= 0 ? `+${evalResult.clampedDiff}` : `${evalResult.clampedDiff}`;
      let actionStr = 'HOLD';
      if (evalResult.action === 'BUY') {
        actionStr = `BUY ${Math.abs(evalResult.clampedDiff)}`;
      } else if (evalResult.action === 'SELL') {
        const plan = this.computeSellPlan(state, Math.abs(evalResult.clampedDiff), price, false);
        if (plan.qty === 0) {
          actionStr = `SELL BLOCKED (all ${Math.abs(evalResult.clampedDiff)} lots unprofitable)`;
        } else if (plan.skippedShares > 0) {
          actionStr = `SELL ${plan.qty} (limit $${plan.limitPrice.toFixed(2)}, ${plan.skippedShares} skipped)`;
        } else {
          actionStr = `SELL ${plan.qty} (limit $${plan.limitPrice.toFixed(2)})`;
        }
      }
      const unclampedStr = evalResult.unclampedTargetShares !== evalResult.targetShares ? ` [unc ${evalResult.unclampedTargetShares}]` : '';
      console.log(`  ${symbol.padEnd(5)} $${price.toFixed(2).padStart(8)} | ${evalResult.sigmaBelow.toFixed(2).padStart(6)}σ | ${String(currentShares).padStart(3)}→${String(evalResult.targetShares).padStart(3)} (${diffStr.padStart(4)})${unclampedStr} | ${actionStr}`);

      if (evalResult.action) {
        actionable.push({ state, price, evalResult });
      }
    }

    // ── Persist changed prices + (throttled) heartbeat to DB so the UI stays in sync ──
    await this.persistPricesAndHeartbeat();

    // ── Execute: place orders at >= 15:45 ET (once per day via cooldown) ──
    if (this.lastBatchExecutedAt &&
        (Date.now() - this.lastBatchExecutedAt < LinearTradingEngine.EXECUTION_COOLDOWN_MS)) {
      return;
    }
    if (!this.simulate && !isExecutionTime()) return;

    console.log(`\n[${timestamp()}] ═══ EXECUTION TRIGGERED (${actionable.length} orders) ═══`);
    let ordersPlaced = 0;
    const blocked = loadBlockedSymbols();

    for (const { state, price, evalResult } of actionable) {
      const symbol = state.strategy.symbol;
      if (blocked.has(symbol)) {
        console.error(`  !! ${symbol} BLOCKED — unrecorded fill in ${UNRECORDED_FILLS_PATH}. Record it in the DB and remove the line to resume.`);
        continue;
      }
      const qty = Math.abs(evalResult.clampedDiff);
      console.log(`  >> ${evalResult.action} ${qty} ${symbol} @ $${price.toFixed(2)}`);
      try {
        await this.executeTrade(state, price, evalResult.action!, qty, evalResult);
        ordersPlaced++;
      } catch (e) {
        console.error(`  !! ${symbol} FAILED:`, e);
      }
    }

    this.lastBatchExecutedAt = Date.now();
    console.log(`[${timestamp()}] ═══ Batch complete. ${ordersPlaced} orders placed. Locked for 20h. ═══\n`);
  }

  // ── Order execution ──

  /**
   * Walk lots lowest-cost-first, collecting profitable shares up to targetQty.
   * Stops at first unprofitable lot (all remaining are more expensive).
   */
  private computeSellPlan(state: StrategyState, targetQty: number, currentPrice: number, log = true): { qty: number; limitPrice: number; skippedShares: number } {
    const sortedLots = this.sortedLotsForSell(state);
    let remaining = targetQty;
    let maxCostBasis = 0;
    let profitableQty = 0;

    for (const lot of sortedLots) {
      if (remaining <= 0) break;
      if (currentPrice < lot.price) break; // sorted ascending — all remaining are worse
      const take = Math.min(lot.shares, remaining);
      maxCostBasis = lot.price; // ascending, so last taken is always the max
      profitableQty += take;
      remaining -= take;
    }

    const skippedShares = targetQty - profitableQty;
    const limitPrice = maxCostBasis > 0 ? Math.round(maxCostBasis * 1.001 * 100) / 100 : 0;
    if (log) console.log(`[LinearEngine] SELL plan: ${profitableQty}/${targetQty} shares profitable (${skippedShares} skipped), limit $${limitPrice.toFixed(2)}`);
    return { qty: profitableQty, limitPrice, skippedShares };
  }

  private async executeTrade(state: StrategyState, price: number, action: 'BUY' | 'SELL', qty: number, evalResult: EvalResult) {
    const symbol = state.strategy.symbol;

    if (action === 'SELL') {
      const plan = this.computeSellPlan(state, qty, price);
      if (plan.qty === 0) {
        console.log(`[LinearEngine] ${symbol}: No profitable lots to sell — skipping`);
        return;
      }
      qty = plan.qty;

      if (!this.simulate) {
        const ibkrOrderId = this.ibkr.placeLOCOrder(symbol, action, qty, plan.limitPrice);
        console.log(`[LinearEngine] -> Pending LOC SELL Order ID: ${ibkrOrderId} (${qty} shares @ limit $${plan.limitPrice.toFixed(2)})`);
        this.pendingOrders.set(ibkrOrderId, { state, action, evalResult, targetPrice: plan.limitPrice });
      } else {
        console.log(`[LinearEngine] SIMULATED FILL: SELL ${qty} shares of ${symbol} @ $${plan.limitPrice.toFixed(2)}`);
        await this.handleOrderFill(
          { ibkrOrderId: -1, status: 'Filled', filled: qty, remaining: 0, avgFillPrice: plan.limitPrice },
          { state, action, evalResult, targetPrice: plan.limitPrice }
        );
      }
    } else {
      if (!this.simulate) {
        const ibkrOrderId = this.ibkr.placeMOCOrder(symbol, action, qty);
        console.log(`[LinearEngine] -> Pending MOC BUY Order ID: ${ibkrOrderId}`);
        this.pendingOrders.set(ibkrOrderId, { state, action, evalResult, targetPrice: price });
      } else {
        const fillPrice = Math.round(price * 100) / 100;
        console.log(`[LinearEngine] SIMULATED FILL: BUY ${qty} shares of ${symbol} @ $${fillPrice.toFixed(2)}`);
        await this.handleOrderFill(
          { ibkrOrderId: -1, status: 'Filled', filled: qty, remaining: 0, avgFillPrice: fillPrice },
          { state, action, evalResult, targetPrice: fillPrice }
        );
      }
    }
  }

  private async handleOrderFill(fill: OrderFill, simulateCtx?: PendingContext) {
    const ctx = simulateCtx || this.pendingOrders.get(fill.ibkrOrderId);

    if (ctx && fill.status !== 'Filled') {
      console.log(`[LinearEngine] Order #${fill.ibkrOrderId} status: ${fill.status} | filled=${fill.filled} remaining=${fill.remaining}`);
    }

    const hasFills = fill.filled > 0;
    const isTerminal = fill.status === 'Filled' || fill.status === 'Cancelled' || fill.status === 'Inactive';
    if (!hasFills || !isTerminal) return;
    if (!ctx) return;

    // Dedup: IBKR fires Filled callbacks multiple times for the same order
    if (!simulateCtx && this.processedOrders.has(fill.ibkrOrderId)) {
      console.log(`[LinearEngine] Order #${fill.ibkrOrderId} already processed — ignoring duplicate fill`);
      return;
    }
    if (!simulateCtx) this.processedOrders.add(fill.ibkrOrderId);

    const { state, action, evalResult } = ctx;
    const fillPrice = fill.avgFillPrice > 0 ? fill.avgFillPrice : ctx.targetPrice;
    const qty = fill.filled;

    console.log(`[LinearEngine] ORDER FILLED! Booking ${qty} shares at $${fillPrice.toFixed(2)}...`);

    const symbol = state.strategy.symbol;
    const strategyId = state.strategy.id;
    const date = todayStr();
    const tradeId = randomUUID(); // generated up front so retries can detect an earlier commit (see recordFill)
    const journalEntry = { ibkrOrderId: fill.ibkrOrderId, symbol, strategyId, action, filledQty: qty, fillPrice, date };

    if (action === 'BUY') {
      const lot = { id: randomUUID(), strategyId, date, price: fillPrice, shares: qty };
      const recorded = await this.recordFill(symbol, tradeId, journalEntry, () => prisma.$transaction([
        prisma.linearTrade.create({
          data: {
            id: tradeId, strategyId, date, action, price: fillPrice, shares: qty,
            targetValue: evalResult.targetValue, sigmaBelow: evalResult.sigmaBelow
          }
        }),
        prisma.linearLot.create({ data: lot }),
      ]));
      if (recorded) state.lots.push({ ...lot, createdAt: new Date(), updatedAt: new Date() });
    } else if (action === 'SELL') {
      const sortedLots = this.sortedLotsForSell(state);

      // Phase 1: Walk lots lowest-cost-first, stop at first unprofitable lot
      let remaining = qty;
      const plan: { lot: LinearLot; sellQty: number }[] = [];

      for (const lot of sortedLots) {
        if (remaining <= 0) break;
        if (fillPrice < lot.price) {
          console.log(`[LinearEngine] NO-LOSS STOP: lot @ $${lot.price.toFixed(2)} (fill $${fillPrice.toFixed(2)}) — remaining ${remaining} shares not sold`);
          break;
        }
        const take = Math.min(lot.shares, remaining);
        plan.push({ lot, sellQty: take });
        remaining -= take;
      }

      // Phase 2: Book profitable lots — trade row + lot changes commit together or not at all
      if (plan.length > 0) {
        let sellPnl = 0;
        let sellCostBasis = 0;
        let actuallySold = 0;

        for (const { lot, sellQty } of plan) {
          sellPnl += (fillPrice - lot.price) * sellQty;
          sellCostBasis += lot.price * sellQty;
          actuallySold += sellQty;
        }

        const avgCost = sellCostBasis / actuallySold;
        const recorded = await this.recordFill(
          symbol, tradeId,
          { ...journalEntry, lots: plan.map(({ lot, sellQty }) => ({ lotId: lot.id, lotPrice: lot.price, sellQty })) },
          () => prisma.$transaction([
            prisma.linearTrade.create({
              data: {
                id: tradeId, strategyId, date, action, price: fillPrice, shares: actuallySold,
                targetValue: evalResult.targetValue, sigmaBelow: evalResult.sigmaBelow,
                pnl: sellPnl, costBasis: avgCost
              }
            }),
            ...plan.map(({ lot, sellQty }) => lot.shares === sellQty
              ? prisma.linearLot.delete({ where: { id: lot.id } })
              : prisma.linearLot.update({ where: { id: lot.id }, data: { shares: lot.shares - sellQty } })),
          ])
        );

        if (recorded) {
          for (const { lot, sellQty } of plan) lot.shares -= sellQty;
          state.lots = state.lots.filter(l => l.shares > 0);
        }
      }
    }

    if (!simulateCtx) {
      this.pendingOrders.delete(fill.ibkrOrderId);
    }
  }

  /**
   * Run a fill's DB write, retrying through DB outages. A retry first checks whether `tradeId` already
   * exists — an attempt can commit and still error (e.g. timeout on the response) and must not be re-applied.
   * If every attempt fails, the fill is appended to UNRECORDED_FILLS_PATH, which blocks the symbol from
   * trading until it is reconciled by hand. Returns whether the fill is in the DB.
   */
  private async recordFill(
    symbol: string,
    tradeId: string,
    journalEntry: Record<string, unknown>,
    write: () => Promise<unknown>,
  ): Promise<boolean> {
    const attempts = FILL_WRITE_RETRY_DELAYS_MS.length + 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        if (attempt > 1 && await prisma.linearTrade.findUnique({ where: { id: tradeId } })) return true;
        await write();
        return true;
      } catch (e) {
        console.error(`[LinearEngine] Recording ${symbol} fill failed (attempt ${attempt}/${attempts}):`, (e as Error).message);
        if (attempt < attempts) await sleep(FILL_WRITE_RETRY_DELAYS_MS[attempt - 1]);
      }
    }

    appendFileSync(UNRECORDED_FILLS_PATH, JSON.stringify({ ...journalEntry, tradeId, at: new Date().toISOString() }) + '\n');
    console.error(`[LinearEngine] ‼️ ${symbol} fill NOT recorded in DB — saved to ${UNRECORDED_FILLS_PATH}. ${symbol} will not trade until it is recorded and the line removed.`);
    return false;
  }
}

import { PrismaClient, LinearLot, LinearStrategy } from '@prisma/client';
import { IBKRClient, MarketTick, OrderFill } from '../ibkr';
import { fetchAndComputeMetrics, evaluateLinearTarget, getLatestPrice, LinearData } from './logic';

const prisma = new PrismaClient();
const STRATEGY_RELOAD_MS = 60 * 1000;

// The exact minute of the day to execute real trades (15:45 ET)
const EXEC_HOUR = 15;
const EXEC_MINUTE = 40;

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

export class LinearTradingEngine {
  private ibkr: IBKRClient;
  private strategies = new Map<string, StrategyState>();
  private running = false;
  private reloadTimer: ReturnType<typeof setInterval> | null = null;
  private metricsRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private executionTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly EXECUTION_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20 hours
  private lastBatchExecutedAt: number | null = null;
  private pendingOrders = new Map<number, PendingContext>();
  private tickRunning = false;

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

    await this.loadStrategies();
    this.running = true;

    this.reloadTimer = setInterval(() => this.loadStrategies(), STRATEGY_RELOAD_MS);
    this.metricsRefreshTimer = setInterval(() => this.refreshMetrics(), 60 * 60 * 1000);

    // Tick loop: 60s when market open, 15min when closed
    const scheduleNext = () => {
      const interval = isMarketOpen() ? 60_000 : 15 * 60_000;
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
    if (evalResult.action === 'SELL' || evalResult.clampedDiff < 0) {
      const sortedLots = this.lifoLots(state);
      let remaining = Math.abs(evalResult.clampedDiff);
      let totalCost = 0, totalShares = 0;
      let blocked = false;
      for (const lot of sortedLots) {
        if (remaining <= 0) break;
        const qty = Math.min(lot.shares, remaining);
        if (price < lot.price) { blocked = true; }
        totalCost += lot.price * qty;
        totalShares += qty;
        remaining -= qty;
      }
      lifoCostBasis = totalShares > 0 ? totalCost / totalShares : null;
      if (blocked) {
        console.log(`  ⛔ NO-LOSS RULE would BLOCK this sell (LIFO floor: $${lifoCostBasis?.toFixed(2)})`);
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
    const qty = Math.abs(ev.evalResult.clampedDiff);

    let ibkrOrderId: number;
    if (action === 'BUY') {
      console.log(`  [Order] Placing REAL MOC BUY for ${qty} shares of ${symbol}`);
      ibkrOrderId = this.ibkr.placeMOCOrder(symbol, 'BUY', qty);
    } else {
      const limitPrice = this.computeSellLimitPrice(state, qty);
      console.log(`  [Order] Placing REAL LOC SELL for ${qty} shares of ${symbol} @ $${limitPrice.toFixed(2)}`);
      ibkrOrderId = this.ibkr.placeLOCOrder(symbol, 'SELL', qty, limitPrice);
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
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    if (this.metricsRefreshTimer) clearInterval(this.metricsRefreshTimer);
    if (this.executionTimer) clearTimeout(this.executionTimer);
    this.ibkr.disconnect();
    await prisma.$disconnect();
  }

  // ── Data loading ──

  async loadStrategies() {
    try {
      const strategies = await prisma.linearStrategy.findMany({
        where: { autoExecute: true },
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
        state.metrics = metrics;
        await this.persistMetrics(state.strategy.id, metrics);
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

  private lifoLots(state: StrategyState): LinearLot[] {
    return [...state.lots].sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  private async persistMetrics(strategyId: string, metrics: LinearData) {
    await prisma.linearStrategy.update({
      where: { id: strategyId },
      data: { sma100: metrics.sma100, sma200: metrics.sma200, sma300: metrics.sma300, dailyVolatility: metrics.sigma }
    }).catch(() => {});
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
        const limit = this.computeSellLimitPrice(state, Math.abs(evalResult.clampedDiff), false);
        actionStr = `SELL ${Math.abs(evalResult.clampedDiff)} (limit $${limit.toFixed(2)})`;
      }
      console.log(`  ${symbol.padEnd(5)} $${price.toFixed(2).padStart(8)} | ${evalResult.sigmaBelow.toFixed(2).padStart(6)}σ | ${String(currentShares).padStart(3)}→${String(evalResult.targetShares).padStart(3)} (${diffStr.padStart(4)}) | ${actionStr}`);

      if (evalResult.action) {
        actionable.push({ state, price, evalResult });
      }
    }

    // ── Execute: place orders at >= 15:45 ET (once per day via cooldown) ──
    if (this.lastBatchExecutedAt &&
        (Date.now() - this.lastBatchExecutedAt < LinearTradingEngine.EXECUTION_COOLDOWN_MS)) {
      return;
    }
    if (!this.simulate && !isExecutionTime()) return;

    console.log(`\n[${timestamp()}] ═══ EXECUTION TRIGGERED (${actionable.length} orders) ═══`);
    let ordersPlaced = 0;

    for (const { state, price, evalResult } of actionable) {
      const symbol = state.strategy.symbol;
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

  private computeSellLimitPrice(state: StrategyState, qty: number, log = true): number {
    const sortedLots = this.lifoLots(state);
    let remaining = qty;
    let maxCostBasis = 0;
    for (const lot of sortedLots) {
      if (remaining <= 0) break;
      maxCostBasis = Math.max(maxCostBasis, lot.price);
      remaining -= Math.min(lot.shares, remaining);
    }

    const sellLimit = Math.round(maxCostBasis * 1.001 * 100) / 100;
    if (log) console.log(`[LinearEngine] SELL limit: max lot cost $${maxCostBasis.toFixed(2)} × 1.001 = $${sellLimit.toFixed(2)}`);
    return sellLimit;
  }

  private async executeTrade(state: StrategyState, price: number, action: 'BUY' | 'SELL', qty: number, evalResult: EvalResult) {
    const symbol = state.strategy.symbol;

    if (!this.simulate) {
      let ibkrOrderId: number;
      let targetPrice: number;
      if (action === 'BUY') {
        ibkrOrderId = this.ibkr.placeMOCOrder(symbol, action, qty);
        targetPrice = price;
        console.log(`[LinearEngine] -> Pending MOC BUY Order ID: ${ibkrOrderId}`);
      } else {
        const limitPrice = this.computeSellLimitPrice(state, qty);
        ibkrOrderId = this.ibkr.placeLOCOrder(symbol, action, qty, limitPrice);
        targetPrice = limitPrice;
        console.log(`[LinearEngine] -> Pending LOC SELL Order ID: ${ibkrOrderId}`);
      }
      this.pendingOrders.set(ibkrOrderId, { state, action, evalResult, targetPrice });
    } else {
      const fillPrice = action === 'BUY' ? Math.round(price * 100) / 100 : this.computeSellLimitPrice(state, qty);
      console.log(`[LinearEngine] SIMULATED FULL FILL: ${action} ${qty} shares of ${symbol} @ $${fillPrice.toFixed(2)}`);
      await this.handleOrderFill(
        { ibkrOrderId: -1, status: 'Filled', filled: qty, remaining: 0, avgFillPrice: fillPrice },
        { state, action, evalResult, targetPrice: fillPrice }
      );
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

    const { state, action, evalResult } = ctx;
    const fillPrice = fill.avgFillPrice > 0 ? fill.avgFillPrice : ctx.targetPrice;
    const qty = fill.filled;

    console.log(`[LinearEngine] ORDER FILLED! Booking ${qty} shares at $${fillPrice.toFixed(2)}...`);

    if (action === 'BUY') {
      const lot = await prisma.linearLot.create({
        data: { strategyId: state.strategy.id, date: todayStr(), price: fillPrice, shares: qty }
      });
      state.lots.push(lot);

      await prisma.linearTrade.create({
        data: {
          strategyId: state.strategy.id, date: todayStr(), action, price: fillPrice, shares: qty,
          targetValue: evalResult.targetValue, sigmaBelow: evalResult.sigmaBelow
        }
      });
    } else if (action === 'SELL') {
      const sortedLots = this.lifoLots(state);

      // Phase 1: Pre-scan — if ANY LIFO lot is unprofitable, reject entire sale (spec §5)
      let remaining = qty;
      const plan: { lot: LinearLot; sellQty: number }[] = [];

      for (const lot of sortedLots) {
        if (remaining <= 0) break;

        if (fillPrice < lot.price) {
          console.log(`[LinearEngine] NO-LOSS RULE: ENTIRE sell of ${qty} shares REJECTED. ` +
            `Fill $${fillPrice.toFixed(2)} < Lot cost $${lot.price.toFixed(2)} (date: ${lot.date})`);
          plan.length = 0;
          break;
        }

        const sellQty = Math.min(lot.shares, remaining);
        plan.push({ lot, sellQty });
        remaining -= sellQty;
      }

      // Phase 2: Execute only if every lot passed
      if (plan.length > 0) {
        let sellPnl = 0;
        let sellCostBasis = 0;
        let actuallySold = 0;

        for (const { lot, sellQty } of plan) {
          sellPnl += (fillPrice - lot.price) * sellQty;
          sellCostBasis += lot.price * sellQty;
          actuallySold += sellQty;

          lot.shares -= sellQty;
          if (lot.shares === 0) {
            await prisma.linearLot.delete({ where: { id: lot.id } });
          } else {
            await prisma.linearLot.update({ where: { id: lot.id }, data: { shares: lot.shares } });
          }
        }

        state.lots = state.lots.filter(l => l.shares > 0);

        const avgCost = sellCostBasis / actuallySold;
        await prisma.linearTrade.create({
          data: {
            strategyId: state.strategy.id, date: todayStr(), action, price: fillPrice, shares: actuallySold,
            targetValue: evalResult.targetValue, sigmaBelow: evalResult.sigmaBelow,
            pnl: sellPnl, costBasis: avgCost
          }
        });
      }
    }

    if (!simulateCtx) {
      this.pendingOrders.delete(fill.ibkrOrderId);
    }
  }
}

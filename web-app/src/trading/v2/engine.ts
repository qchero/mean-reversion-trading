import { PrismaClient, LinearLot, LinearStrategy } from '@prisma/client';
import { IBKRClient, MarketTick, OrderFill } from '../ibkr';
import { fetchAndComputeMetrics, evaluateLinearTarget, LinearData } from './logic';

const prisma = new PrismaClient();
const STRATEGY_RELOAD_MS = 60 * 1000; 

// The exact minute of the day to execute real trades (15:45 ET)
const EXEC_HOUR = 15;
const EXEC_MINUTE = 45;

interface StrategyState {
  strategy: LinearStrategy;
  lots: LinearLot[];
  metrics: LinearData;
}

interface PendingContext {
  state: StrategyState;
  action: 'BUY' | 'SELL';
  evalResult: any;
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
  return new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }).slice(0, 10);
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
  return isMarketOpen() && et.getHours() === EXEC_HOUR && et.getMinutes() === EXEC_MINUTE;
}

export class LinearTradingEngine {
  private ibkr: IBKRClient;
  private strategies = new Map<string, StrategyState>();
  private lockedTickers = new Set<string>();
  private running = false;
  private reloadTimer: ReturnType<typeof setInterval> | null = null;
  private metricsRefreshTimer: ReturnType<typeof setInterval> | null = null;
  
  // Track execution logic
  private hasExecutedToday = new Set<string>(); 
  private pendingOrders = new Map<number, PendingContext>();

  // In sim mode, we inject ticks
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

    // Reload active strategies from DB every minute
    this.reloadTimer = setInterval(() => this.loadStrategies(), STRATEGY_RELOAD_MS);

    // Re-fetch daily metrics every hour (in case market closes and we enter a new day)
    this.metricsRefreshTimer = setInterval(() => this.refreshMetrics(), 60 * 60 * 1000);

    // Reset daily execution locks exactly at midnight ET
    setInterval(() => {
      const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      if (et.getHours() === 0 && et.getMinutes() === 0) {
        console.log(`[LinearEngine] Midnight ET! Resetting daily execution locks.`);
        this.hasExecutedToday.clear();
      }
    }, 60000);

    console.log('[LinearEngine] Running. Press Ctrl+C to stop.');
  }

  async stop() {
    this.running = false;
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    if (this.metricsRefreshTimer) clearInterval(this.metricsRefreshTimer);
    this.ibkr.disconnect();
    await prisma.$disconnect();
  }

  async loadStrategies() {
    try {
      const strategies = await prisma.linearStrategy.findMany({
        where: { autoExecute: true },
        include: { lots: true },
      });

      const currentSymbols = new Set(strategies.map((s) => s.symbol));
      const prevSymbols = new Set(this.strategies.keys());

      // Cleanup removed
      for (const sym of prevSymbols) {
        if (!currentSymbols.has(sym)) {
          if (!this.simulate) this.ibkr.unsubscribeMarketData(sym);
          this.strategies.delete(sym);
          console.log(`[LinearEngine] Removed: ${sym}`);
        }
      }

      // Add & Update Wait... if new, fetch metrics!
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
          
          await prisma.linearStrategy.update({
            where: { id: strat.id },
            data: {
              sma100: metrics.sma100,
              sma200: metrics.sma200,
              sma300: metrics.sma300,
              dailyVolatility: metrics.sigma,
            }
          });

          if (!this.simulate) this.ibkr.subscribeMarketData(strat.symbol);
          console.log(`[LinearEngine] Added: ${strat.symbol} | SMA200: $${metrics.sma200.toFixed(2)}`);
        } else {
          // Just update DB objects
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
          await prisma.linearStrategy.update({
            where: { id: state.strategy.id },
            data: {
              sma100: metrics.sma100,
              sma200: metrics.sma200,
              sma300: metrics.sma300,
              dailyVolatility: metrics.sigma,
            }
          });
       }
    }
  }

  private async handleTick(tick: MarketTick) {
    if (!this.running) return;

    const state = this.strategies.get(tick.symbol);
    if (!state) return;

    // We make evaluation based on bid for SELLs, ask for BUYs, but close is single price. 
    // Average them like typical midprice.
    const currentPrice = tick.last > 0 ? tick.last : ((tick.bid + tick.ask) / 2);
    if (currentPrice <= 0) return;

    const currentShares = state.lots.reduce((acc, l) => acc + l.shares, 0);

    // Save latest price if not updated in the last minute to avoid DB spam
    const now = new Date();
    if (!state.strategy.latestPriceAt || (now.getTime() - state.strategy.latestPriceAt.getTime()) > 60000) {
       state.strategy.latestPrice = currentPrice;
       state.strategy.latestPriceAt = now;
       await prisma.linearStrategy.update({
         where: { id: state.strategy.id },
         data: { latestPrice: currentPrice, latestPriceAt: now }
       }).catch(() => {});
    }

    const evalResult = evaluateLinearTarget(
        currentPrice,
        state.metrics.sma200,
        state.metrics.sigma,
        state.strategy.bandLo,
        state.strategy.bandHi,
        state.strategy.maxBudget,
        state.strategy.minTradeAmount,
        currentShares
    );

    // Logging behavior (Log periodically or on massive changes, but here we keep it silent to avoid spam,
    // unless execution window is open).
    // Actually, only log exactly on the minute 15:45
    const isExecTime = this.simulate && typeof (tick as any)._simTime !== 'undefined' 
        ? true 
        : isExecutionTime();

    if (isExecTime) {
      if (!this.hasExecutedToday.has(tick.symbol) && !this.lockedTickers.has(tick.symbol)) {
        console.log(`[${timestamp()}] EVAL: ${tick.symbol} Price=$${currentPrice.toFixed(2)} | TargetShares=${evalResult.targetShares} | Diff=${evalResult.clampedDiff} | UnclampedDiff=${evalResult.unclampedDiff}`);
        
        if (evalResult.action) {
           this.lockedTickers.add(tick.symbol);
           this.hasExecutedToday.add(tick.symbol);
           
           try {
             await this.executeTrade(state, currentPrice, evalResult.action, Math.abs(evalResult.clampedDiff), evalResult);
           } catch(e) {
             console.error(`[LinearEngine] Fallback error executing trade:`, e);
           }
           
           this.lockedTickers.delete(tick.symbol);
        } else {
           // No action needed, but mark as evaluated so we don't spam 
           this.hasExecutedToday.add(tick.symbol);
        }
      }
    }
  }

  private async executeTrade(state: StrategyState, price: number, action: 'BUY'|'SELL', qty: number, evalResult: any) {
     const symbol = state.strategy.symbol;
     const limitPrice = Math.round(price * 100) / 100;
     console.log(`[LinearEngine] -> PLACING ${action} ORDER for ${qty} shares of ${symbol} @ $${limitPrice.toFixed(2)}`);

     if (!this.simulate) {
        // Dispatch IBKR limit-on-close order
        const ibkrOrderId = this.ibkr.placeLOCOrder(symbol, action, qty, limitPrice);
        this.pendingOrders.set(ibkrOrderId, { state, action, evalResult, targetPrice: limitPrice });
        console.log(`[LinearEngine] -> Pending LOC Order ID: ${ibkrOrderId}`);
     } else {
        // Simulate immediate fill for test hooks
        console.log(`[LinearEngine] SIMULATED FULL FILL of ${qty} shares`);
        await this.handleOrderFill({ ibkrOrderId: -1, status: 'Filled', filled: qty, remaining: 0, avgFillPrice: limitPrice }, { state, action, evalResult, targetPrice: limitPrice });
     }
  }

  private async handleOrderFill(fill: OrderFill, simulateCtx?: PendingContext) {
      if (fill.status !== 'Filled') return;

      const ctx = simulateCtx || this.pendingOrders.get(fill.ibkrOrderId);
      if (!ctx) return; // Unknown or already processed

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
         let remainingToSell = qty;
         let sellPnl = 0;
         let sellCostBasis = 0;
         let actuallySold = 0;

         // Sort lots descending by date (LIFO)
         state.lots.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

         for (let i = 0; i < state.lots.length; i++) {
             const lot = state.lots[i];
             if (remainingToSell <= 0) break;
             
             if (fillPrice < lot.price) {
                 console.log(`[LinearEngine] NO-LOSS RULE blocking lot sell. Fill $${fillPrice.toFixed(2)} vs Cost $${lot.price.toFixed(2)}`);
                 break; 
             }

             const sold = Math.min(lot.shares, remainingToSell);
             sellPnl += (fillPrice - lot.price) * sold;
             sellCostBasis += lot.price * sold;

             lot.shares -= sold;
             remainingToSell -= sold;
             actuallySold += sold;

             if (lot.shares === 0) {
                 await prisma.linearLot.delete({ where: { id: lot.id } });
             } else {
                 await prisma.linearLot.update({ where: { id: lot.id }, data: { shares: lot.shares } });
             }
         }
         
         // Clean array
         state.lots = state.lots.filter(l => l.shares > 0);

         if (actuallySold > 0) {
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

      // Cleanup pending context
      if (!simulateCtx) {
          this.pendingOrders.delete(fill.ibkrOrderId);
      }
  }
}

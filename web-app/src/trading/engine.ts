/**
 * Auto-trading engine.
 *
 * Connects to IB Gateway, monitors prices for all auto-execute strategies,
 * and places market orders (whole shares) when thresholds are crossed.
 *
 * Run with: npx tsx src/trading/run.ts
 */

import { PrismaClient, Strategy, Order, Trade } from '@prisma/client';
import { IBKRClient, MarketTick, OrderFill } from './ibkr';

const prisma = new PrismaClient();

const STRATEGY_RELOAD_MS = 60 * 1000; // reload strategies every minute

// ── Types ──

interface StepLevel {
  step: number;
  buyPrice: number;
  sellPrice: number;
  shares: number;  // shares to buy (stepAmount / buyPrice)
}

interface StrategyState {
  strategy: Strategy;
  levels: StepLevel[];
  trades: Trade[];
  sma200: number;
  dailyVolatility: number;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Engine ──

export class TradingEngine {
  private ibkr: IBKRClient;
  private strategies = new Map<string, StrategyState>(); // symbol → state
  private lockedTickers = new Set<string>();              // tickers with active orders
  private activeOrders = new Map<string, Order>();        // order.id → DB order
  private running = false;
  private reloadTimer: ReturnType<typeof setInterval> | null = null;
  private simulate = false;

  constructor(client: IBKRClient, simulate = false) {
    this.ibkr = client;
    this.simulate = simulate;
  }

  /** Inject a tick manually (simulate mode). Skips real market data subscription. */
  injectTick(tick: MarketTick) {
    this.handleTick(tick);
  }

  async start() {
    console.log('[Engine] Starting...');

    // Connect to IB Gateway
    await this.ibkr.connect();

    // Set up callbacks
    this.ibkr.setOnTick((tick) => this.handleTick(tick));
    this.ibkr.setOnOrderStatus((fill) => this.handleOrderStatus(fill));

    // Load strategies and subscribe to market data
    await this.loadStrategies();

    // Reconcile any orders left from a previous session
    if (this.activeOrders.size > 0) {
      console.log(`[Engine] Reconciling ${this.activeOrders.size} pending order(s) with IBKR...`);
      this.ibkr.reqAllOpenOrders();

      // After 5s, any DB orders that IBKR didn't report back on have
      // filled or been cancelled while we were down — clean them up
      setTimeout(async () => {
        for (const [id, order] of this.activeOrders) {
          if (order.status === 'filled' || order.status === 'cancelled') continue;

          console.log(`[Engine] Order #${order.ibkrOrderId} not found on IBKR — marking cancelled`);
          await prisma.order.update({
            where: { id },
            data: { status: 'cancelled', cancelledAt: new Date() },
          });
          this.activeOrders.delete(id);
          await this.unlockTicker(order.strategyId);
        }
      }, 5000);
    }

    // Periodic strategy reload
    this.running = true;
    this.reloadTimer = setInterval(() => this.loadStrategies(), STRATEGY_RELOAD_MS);

    console.log('[Engine] Running. Press Ctrl+C to stop.');
  }

  async stop() {
    console.log('[Engine] Stopping...');
    this.running = false;

    if (this.reloadTimer) clearInterval(this.reloadTimer);

    this.ibkr.disconnect();
    await prisma.$disconnect();
    console.log('[Engine] Stopped.');
  }

  // ── Strategy Loading ──

  async loadStrategies() {
    const strategies = await prisma.strategy.findMany({
      where: { autoExecute: true },
    });

    const currentSymbols = new Set(strategies.map((s) => s.symbol));
    const prevSymbols = new Set(this.strategies.keys());

    // Unsubscribe removed symbols
    for (const sym of prevSymbols) {
      if (!currentSymbols.has(sym)) {
        if (!this.simulate) {
          this.ibkr.unsubscribeMarketData(sym);
        }
        this.strategies.delete(sym);
        console.log(`[Engine] Removed: ${sym}`);
      }
    }

    // Load/update each strategy
    for (const strategy of strategies) {
      const isNew = !prevSymbols.has(strategy.symbol);

      // Calculate levels from cached metrics
      const cache = await prisma.symbolCache.findUnique({
        where: { symbol: strategy.symbol },
      });

      if (!cache) {
        console.warn(`[Engine] No cached metrics for ${strategy.symbol}, skipping`);
        continue;
      }

      const levels = this.calculateLevels(strategy, cache.sma200, cache.dailyVolatility);
      const trades = await prisma.trade.findMany({
        where: { strategyId: strategy.id },
      });

      this.strategies.set(strategy.symbol, {
        strategy,
        levels,
        trades,
        sma200: cache.sma200,
        dailyVolatility: cache.dailyVolatility,
      });

      if (isNew) {
        if (!this.simulate) {
          this.ibkr.subscribeMarketData(strategy.symbol);
        }
        console.log(`[Engine] Added: ${strategy.symbol} (${levels.length} levels)`);
        for (const l of levels) {
          console.log(`  Step ${l.step}: buy ≤ $${l.buyPrice.toFixed(2)}, sell ≥ $${l.sellPrice.toFixed(2)}, ~${Math.round(l.shares)} shares`);
        }
      }
    }

    // Reload active orders from DB
    const dbOrders = await prisma.order.findMany({
      where: { status: { in: ['pending', 'submitted'] } },
    });
    this.activeOrders.clear();
    for (const o of dbOrders) {
      this.activeOrders.set(o.id, o);
      const sym = strategies.find((s) => s.id === o.strategyId)?.symbol;
      if (sym) this.lockedTickers.add(sym);
    }
  }

  private calculateLevels(
    strategy: Strategy,
    sma200: number,
    dailyVolatility: number,
  ): StepLevel[] {
    const j = strategy.initialParamJ;
    const k = strategy.stepParamK;
    const levels: StepLevel[] = [];

    for (let i = 0; i < strategy.maxSteps; i++) {
      const stepNum = i + 1;
      const buyPrice = sma200 * (1 - (j + i * k) * dailyVolatility);
      const sellPrice = sma200 * (1 - (j + (i - 1) * k) * dailyVolatility);
      const shares = strategy.stepAmount / buyPrice;

      levels.push({ step: stepNum, buyPrice, sellPrice, shares });
    }

    return levels;
  }

  // ── Price Handling ──

  private async handleTick(tick: MarketTick) {
    if (!this.running) return;

    const symbol = tick.symbol;

    if (this.lockedTickers.has(symbol)) {
      console.log(`[Tick] ${symbol} bid=$${tick.bid.toFixed(2)} ask=$${tick.ask.toFixed(2)} — LOCKED (active order)`);
      return;
    }

    const state = this.strategies.get(symbol);
    if (!state) return;

    const lines: string[] = [];
    lines.push(`[Tick] ${symbol} bid=$${tick.bid.toFixed(2)} ask=$${tick.ask.toFixed(2)} | SMA200=$${state.sma200.toFixed(2)} σ=${(state.dailyVolatility * 100).toFixed(2)}%`);

    let action: { step: number; side: 'BUY' | 'SELL'; price: number; qty: number } | null = null;

    for (const level of state.levels) {
      const openTrade = state.trades.find(
        (t) => t.step === level.step && t.sellPrice == null,
      );

      if (openTrade) {
        const sellHit = tick.bid >= level.sellPrice;
        lines.push(`  Step ${level.step}: SELL target=$${level.sellPrice.toFixed(2)} bid=$${tick.bid.toFixed(2)} ${sellHit ? '→ TRIGGERED' : `gap=$${(level.sellPrice - tick.bid).toFixed(2)}`} (holding ${openTrade.shares} shares @ $${openTrade.buyPrice.toFixed(2)})`);
        if (sellHit && !action) {
          action = { step: level.step, side: 'SELL', price: level.sellPrice, qty: openTrade.shares };
        }
      } else {
        const buyHit = tick.ask <= level.buyPrice;
        lines.push(`  Step ${level.step}: BUY  target=$${level.buyPrice.toFixed(2)} ask=$${tick.ask.toFixed(2)} ${buyHit ? '→ TRIGGERED' : `gap=$${(tick.ask - level.buyPrice).toFixed(2)}`}`);
        if (buyHit && !action) {
          action = { step: level.step, side: 'BUY', price: level.buyPrice, qty: level.shares };
        }
      }
    }

    console.log(lines.join('\n'));

    if (action) {
      await this.placeOrder(state, action.step, action.side, action.price, action.qty);
    }
  }

  // ── Order Management ──

  private async placeOrder(
    state: StrategyState,
    step: number,
    side: 'BUY' | 'SELL',
    targetPrice: number,
    quantity: number,
  ) {
    const symbol = state.strategy.symbol;
    const roundedQty = Math.round(quantity); // whole shares only
    if (roundedQty <= 0) return;

    const roundedPrice = Math.round(targetPrice * 100) / 100;

    // Place market order via IBKR
    const ibkrOrderId = this.ibkr.placeMarketOrder(symbol, side, roundedQty);

    // Persist to DB (limitPrice stores the trigger price for reference)
    const order = await prisma.order.create({
      data: {
        strategyId: state.strategy.id,
        step,
        side,
        ibkrOrderId,
        status: 'submitted',
        limitPrice: roundedPrice,
        totalQty: roundedQty,
      },
    });

    this.activeOrders.set(order.id, order);
    this.lockedTickers.add(symbol);

    console.log(
      `[Engine] ${side} MKT order: ${symbol} step ${step} | ${roundedQty} shares (trigger $${roundedPrice})`,
    );
  }

  private async handleOrderStatus(fill: OrderFill) {
    // Find the DB order by IBKR order ID
    let dbOrder: Order | undefined;
    for (const o of this.activeOrders.values()) {
      if (o.ibkrOrderId === fill.ibkrOrderId) {
        dbOrder = o;
        break;
      }
    }
    if (!dbOrder) return;

    const isFilled = fill.status === 'Filled';
    const isCancelled = fill.status === 'Cancelled' || fill.status === 'Inactive';

    if (!isFilled && !isCancelled) return; // ignore intermediate statuses

    const newStatus = isFilled ? 'filled' : 'cancelled';

    // Update DB
    const updated = await prisma.order.update({
      where: { id: dbOrder.id },
      data: {
        status: newStatus,
        filledQty: fill.filled,
        avgFillPrice: fill.avgFillPrice > 0 ? fill.avgFillPrice : undefined,
        filledAt: isFilled ? new Date() : undefined,
        cancelledAt: isCancelled ? new Date() : undefined,
      },
    });
    this.activeOrders.set(dbOrder.id, updated);

    if (isFilled && fill.filled > 0) {
      await this.recordTrade(updated);
    }

    await this.unlockTicker(updated.strategyId);
  }

  private async recordTrade(order: Order) {
    const strategy = await prisma.strategy.findUnique({ where: { id: order.strategyId } });
    if (!strategy) return;

    const fillPrice = order.avgFillPrice || order.limitPrice;
    const state = this.strategies.get(strategy.symbol);

    if (order.side === 'BUY') {
      const trade = await prisma.trade.create({
        data: {
          strategyId: order.strategyId,
          step: order.step,
          shares: order.filledQty,
          buyPrice: fillPrice,
          buyDate: todayStr(),
        },
      });
      console.log(
        `[Engine] BUY filled: ${strategy.symbol} step ${order.step} | ${order.filledQty} shares @ $${fillPrice.toFixed(2)}`,
      );
      if (state) state.trades.push(trade);
    } else {
      // SELL: close the open trade for this step
      const openTrade = state?.trades.find(
        (t) => t.step === order.step && t.sellPrice == null,
      );
      if (openTrade) {
        const updated = await prisma.trade.update({
          where: { id: openTrade.id },
          data: { sellPrice: fillPrice, sellDate: todayStr() },
        });
        console.log(
          `[Engine] SELL filled: ${strategy.symbol} step ${order.step} | ${order.filledQty} shares @ $${fillPrice.toFixed(2)}`,
        );
        if (state) {
          const idx = state.trades.findIndex((t) => t.id === openTrade.id);
          if (idx >= 0) state.trades[idx] = updated;
        }
      }
    }
  }

  private async unlockTicker(strategyId: string) {
    const strategy = await prisma.strategy.findUnique({ where: { id: strategyId } });
    if (strategy) {
      this.lockedTickers.delete(strategy.symbol);
    }

    // Remove from active orders
    for (const [id, o] of this.activeOrders) {
      if (o.strategyId === strategyId && (o.status === 'filled' || o.status === 'cancelled')) {
        this.activeOrders.delete(id);
      }
    }
  }
}

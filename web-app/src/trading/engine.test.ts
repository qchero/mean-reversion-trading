import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock Prisma ──
// vi.hoisted ensures the mock object is available before vi.mock (which is hoisted)

const mockPrisma = vi.hoisted(() => ({
  strategy: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  symbolCache: {
    findUnique: vi.fn(),
  },
  order: {
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
  },
  trade: {
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
  },
  $disconnect: vi.fn(),
}));

vi.mock('@prisma/client', () => {
  class MockPrismaClient {
    strategy = mockPrisma.strategy;
    symbolCache = mockPrisma.symbolCache;
    order = mockPrisma.order;
    trade = mockPrisma.trade;
    $disconnect = mockPrisma.$disconnect;
  }
  return { PrismaClient: MockPrismaClient };
});

// ── Mock IBKR ──

import type { IBKRClient, OrderFill } from './ibkr';
import { TradingEngine } from './engine';

function createMockIBKR(): IBKRClient & {
  _onTick: ((tick: any) => void) | null;
  _onOrderStatus: ((fill: OrderFill) => void) | null;
} {
  const mock: any = {
    _onTick: null,
    _onOrderStatus: null,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    setOnTick: vi.fn((cb: any) => { mock._onTick = cb; }),
    setOnOrderStatus: vi.fn((cb: any) => { mock._onOrderStatus = cb; }),
    placeMarketOrder: vi.fn().mockReturnValue(100),
    subscribeMarketData: vi.fn(),
    unsubscribeMarketData: vi.fn(),
    reqAllOpenOrders: vi.fn(),
  };
  return mock;
}

// ── Test fixtures ──

const STRATEGY = {
  id: 'strat-1',
  symbol: 'MA',
  autoExecute: true,
  initialParamJ: 6,
  stepParamK: 1.5,
  maxSteps: 2,
  stepAmount: 5000,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const SYMBOL_CACHE = {
  symbol: 'MA',
  sma200: 500,
  dailyVolatility: 0.015,
  updatedAt: new Date(),
};

function makeOrder(overrides: Record<string, any> = {}) {
  return {
    id: 'order-1',
    strategyId: 'strat-1',
    step: 1,
    side: 'BUY',
    ibkrOrderId: 100,
    status: 'submitted',
    limitPrice: 455,
    totalQty: 10,
    filledQty: 0,
    avgFillPrice: 0,
    expiresAt: null,
    filledAt: null,
    cancelledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeTrade(overrides: Record<string, any> = {}) {
  return {
    id: 'trade-1',
    strategyId: 'strat-1',
    step: 1,
    shares: 10,
    buyPrice: 455,
    buyDate: '2026-03-23',
    sellPrice: null,
    sellDate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ── Helpers ──

/** Set up mocks so loadStrategies() succeeds and populates the engine state. */
function setupLoadMocks(trades: any[] = []) {
  mockPrisma.strategy.findMany.mockResolvedValue([STRATEGY]);
  mockPrisma.symbolCache.findUnique.mockResolvedValue(SYMBOL_CACHE);
  mockPrisma.trade.findMany.mockResolvedValue(trades);
  mockPrisma.order.findMany.mockResolvedValue([]);
}

async function startEngine(ibkr: ReturnType<typeof createMockIBKR>, trades: any[] = []) {
  setupLoadMocks(trades);
  const engine = new TradingEngine(ibkr as any, true); // simulate=true
  await engine.start();
  return engine;
}

// ── Tests ──

describe('TradingEngine', () => {
  let ibkr: ReturnType<typeof createMockIBKR>;

  beforeEach(() => {
    vi.clearAllMocks();
    ibkr = createMockIBKR();
    // Increment order IDs per call
    let orderId = 100;
    ibkr.placeMarketOrder = vi.fn(() => orderId++);
  });

  describe('duplicate order prevention (tick race condition)', () => {
    it('places only one order when multiple ticks arrive during async DB write', async () => {
      // Make order.create slow — simulates the DB write that yields the event loop
      let resolveCreate!: (v: any) => void;
      mockPrisma.order.create.mockImplementation(
        () => new Promise((resolve) => { resolveCreate = resolve; }),
      );

      const engine = await startEngine(ibkr);

      // Buy level for step 1: SMA * (1 - j * sigma) = 500 * (1 - 6 * 0.015) = 455
      // Send tick at buy price
      const tick = { symbol: 'MA', bid: 454, ask: 455, last: 455 };

      // Fire 5 rapid ticks (simulating what IBKR does)
      engine.injectTick(tick);
      engine.injectTick(tick);
      engine.injectTick(tick);
      engine.injectTick(tick);
      engine.injectTick(tick);

      // Only ONE placeMarketOrder call should have gone through
      expect(ibkr.placeMarketOrder).toHaveBeenCalledTimes(1);
      expect(ibkr.placeMarketOrder).toHaveBeenCalledWith('MA', 'BUY', 11);

      // Resolve the pending DB write
      resolveCreate(makeOrder());
      await vi.waitFor(() => {
        // give microtasks a chance
      });

      // Still only one order
      expect(ibkr.placeMarketOrder).toHaveBeenCalledTimes(1);

      await engine.stop();
    });

    it('unlocks ticker after order DB write fails, allowing retry on next tick', async () => {
      mockPrisma.order.create.mockRejectedValue(new Error('DB connection lost'));

      const engine = await startEngine(ibkr);

      const tick = { symbol: 'MA', bid: 454, ask: 455, last: 455 };
      engine.injectTick(tick);

      // IBKR order was placed (happens before DB write)
      expect(ibkr.placeMarketOrder).toHaveBeenCalledTimes(1);

      // Wait for the async rejection to propagate and unlock the ticker
      await new Promise((r) => setTimeout(r, 50));

      // Now send another tick — should work because lock was released on error
      mockPrisma.order.create.mockResolvedValue(makeOrder({ id: 'order-2' }));
      engine.injectTick(tick);

      expect(ibkr.placeMarketOrder).toHaveBeenCalledTimes(2);

      await engine.stop();
    });

    it('does not place sell order twice for the same step', async () => {
      const openTrade = makeTrade({ step: 1, shares: 10, buyPrice: 455 });
      mockPrisma.order.create.mockImplementation(() =>
        new Promise((resolve) => {
          // slow but will resolve
          setTimeout(() => resolve(makeOrder({ side: 'SELL', step: 1 })), 50);
        }),
      );

      const engine = await startEngine(ibkr, [openTrade]);

      // Sell level for step 1: SMA * (1 - (j + (0-1)*k) * sigma) = 500 * (1 - 4.5*0.015) = 466.25
      const tick = { symbol: 'MA', bid: 467, ask: 468, last: 468 };

      // Fire multiple sell ticks
      engine.injectTick(tick);
      engine.injectTick(tick);
      engine.injectTick(tick);

      expect(ibkr.placeMarketOrder).toHaveBeenCalledTimes(1);
      expect(ibkr.placeMarketOrder).toHaveBeenCalledWith('MA', 'SELL', 10);

      await engine.stop();
    });
  });

  describe('duplicate fill prevention (IBKR callback race condition)', () => {
    it('processes only one fill when IBKR sends duplicate Filled callbacks', async () => {
      const openTrade = makeTrade({ step: 1, shares: 10, buyPrice: 455 });
      mockPrisma.order.create.mockResolvedValue(makeOrder({ side: 'SELL', step: 1 }));

      const engine = await startEngine(ibkr, [openTrade]);

      // Trigger a sell order
      const tick = { symbol: 'MA', bid: 467, ask: 468, last: 468 };
      engine.injectTick(tick);

      // Allow the order.create to resolve
      await vi.waitFor(() => {
        expect(ibkr.placeMarketOrder).toHaveBeenCalledTimes(1);
      });

      // Set up mocks for fill processing
      const updatedOrder = makeOrder({
        side: 'SELL',
        step: 1,
        status: 'filled',
        filledQty: 10,
        avgFillPrice: 467,
      });
      mockPrisma.order.update.mockResolvedValue(updatedOrder);
      mockPrisma.strategy.findUnique.mockResolvedValue(STRATEGY);
      mockPrisma.trade.update.mockResolvedValue({
        ...openTrade,
        sellPrice: 467,
        sellDate: '2026-03-23',
      });

      // Simulate IBKR sending duplicate Filled callbacks (as seen in logs)
      const fill: OrderFill = {
        ibkrOrderId: 100,
        status: 'Filled',
        filled: 10,
        remaining: 0,
        avgFillPrice: 467,
      };

      // Get the onOrderStatus callback
      const onOrderStatus = ibkr._onOrderStatus!;

      // Fire duplicate callbacks
      onOrderStatus(fill);
      onOrderStatus(fill);

      // Wait for async processing
      await new Promise((r) => setTimeout(r, 100));

      // order.update should be called only ONCE (not twice)
      expect(mockPrisma.order.update).toHaveBeenCalledTimes(1);
      // trade.update (for closing the sell) should be called only ONCE
      expect(mockPrisma.trade.update).toHaveBeenCalledTimes(1);

      await engine.stop();
    });

    it('processes only one fill for BUY (prevents duplicate trade creation)', async () => {
      mockPrisma.order.create.mockResolvedValue(makeOrder({ side: 'BUY', step: 1 }));

      const engine = await startEngine(ibkr);

      // Trigger a buy order
      const tick = { symbol: 'MA', bid: 454, ask: 455, last: 455 };
      engine.injectTick(tick);

      await vi.waitFor(() => {
        expect(ibkr.placeMarketOrder).toHaveBeenCalledTimes(1);
      });

      // Set up fill processing mocks
      const updatedOrder = makeOrder({
        side: 'BUY',
        step: 1,
        status: 'filled',
        filledQty: 11,
        avgFillPrice: 455,
      });
      mockPrisma.order.update.mockResolvedValue(updatedOrder);
      mockPrisma.strategy.findUnique.mockResolvedValue(STRATEGY);
      mockPrisma.trade.create.mockResolvedValue(makeTrade());

      const fill: OrderFill = {
        ibkrOrderId: 100,
        status: 'Filled',
        filled: 11,
        remaining: 0,
        avgFillPrice: 455,
      };

      const onOrderStatus = ibkr._onOrderStatus!;

      // Fire duplicate callbacks (IBKR sends each twice)
      onOrderStatus(fill);
      onOrderStatus(fill);

      await new Promise((r) => setTimeout(r, 100));

      // trade.create should be called only ONCE (not twice — this was creating duplicate trades)
      expect(mockPrisma.trade.create).toHaveBeenCalledTimes(1);

      await engine.stop();
    });
  });

  describe('lock lifecycle', () => {
    it('ticker is locked during order placement and unlocked after fill', async () => {
      let resolveCreate!: (v: any) => void;
      mockPrisma.order.create.mockImplementation(
        () => new Promise((resolve) => { resolveCreate = resolve; }),
      );

      const engine = await startEngine(ibkr);

      const buyTick = { symbol: 'MA', bid: 454, ask: 455, last: 455 };
      engine.injectTick(buyTick);

      // First tick triggered a buy — subsequent ticks should be blocked
      expect(ibkr.placeMarketOrder).toHaveBeenCalledTimes(1);

      // Tick at sell price should be blocked while locked
      const sellTick = { symbol: 'MA', bid: 467, ask: 468, last: 468 };
      engine.injectTick(sellTick);
      expect(ibkr.placeMarketOrder).toHaveBeenCalledTimes(1); // still 1

      // Resolve the order creation
      const order = makeOrder();
      resolveCreate(order);
      await new Promise((r) => setTimeout(r, 10));

      // Set up fill mocks
      mockPrisma.order.update.mockResolvedValue({ ...order, status: 'filled', filledQty: 11, avgFillPrice: 455 });
      mockPrisma.strategy.findUnique.mockResolvedValue(STRATEGY);
      mockPrisma.trade.create.mockResolvedValue(makeTrade());

      // Simulate fill
      ibkr._onOrderStatus!({
        ibkrOrderId: 100,
        status: 'Filled',
        filled: 11,
        remaining: 0,
        avgFillPrice: 455,
      });

      // Wait for unlock
      await new Promise((r) => setTimeout(r, 100));

      // Now a new tick should be able to trigger an order
      // Reload strategies to pick up the new trade
      setupLoadMocks([makeTrade()]);
      await (engine as any).loadStrategies();

      // Sell tick should now work (step 1 held, bid >= sell price)
      mockPrisma.order.create.mockResolvedValue(makeOrder({ id: 'order-2', side: 'SELL', step: 1 }));
      engine.injectTick(sellTick);
      expect(ibkr.placeMarketOrder).toHaveBeenCalledTimes(2);

      await engine.stop();
    });
  });
});

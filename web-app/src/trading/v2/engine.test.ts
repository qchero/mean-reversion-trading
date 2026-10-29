import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock Prisma ──
// Model methods return a promise tagged with the op name, so tests can inspect what each
// $transaction batch contained while direct calls (e.g. persistMetrics) still await normally.

const mockPrisma = vi.hoisted(() => {
  const op = (name: string) => vi.fn((args: { data?: Record<string, unknown> }) => Object.assign(Promise.resolve({}), { op: name, args }));
  return {
    linearStrategy: { findMany: vi.fn(), update: op('strategy.update') },
    linearLot: { create: op('lot.create'), update: op('lot.update'), delete: op('lot.delete') },
    linearTrade: { create: op('trade.create'), findUnique: vi.fn() },
    engineHeartbeat: { upsert: op('heartbeat.upsert') },
    $transaction: vi.fn(),
    $disconnect: vi.fn(),
  };
});

vi.mock('@prisma/client', () => {
  class MockPrismaClient {
    linearStrategy = mockPrisma.linearStrategy;
    linearLot = mockPrisma.linearLot;
    linearTrade = mockPrisma.linearTrade;
    engineHeartbeat = mockPrisma.engineHeartbeat;
    $transaction = mockPrisma.$transaction;
    $disconnect = mockPrisma.$disconnect;
  }
  return { PrismaClient: MockPrismaClient };
});

const mockFs = vi.hoisted(() => ({
  appendFileSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()), ...mockFs }));

vi.mock('./logic', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./logic')>()),
  fetchAndComputeMetrics: vi.fn(),
  getLatestPrice: vi.fn(),
}));

import type { IBKRClient } from '../ibkr';
import { LinearTradingEngine } from './engine';
import { fetchAndComputeMetrics, getLatestPrice } from './logic';

// sma200=100, sigma=2%, band [1σ → 3σ], $10k budget: at $96 (2σ below) the target is 52 shares
const STRATEGY = {
  id: 's1', symbol: 'AAPL', bandLo: 1, bandHi: 3, maxBudget: 10_000, minTradeAmount: 0, autoExecute: true,
  sma100: null, sma200: null, sma300: null, dailyVolatility: null,
  latestPrice: null, latestPriceAt: null, dayHigh: null, dayLow: null,
  createdAt: new Date(), updatedAt: new Date(), lots: [],
};
const METRICS = { sma100: 100, sma200: 100, sma300: 100, sigma: 0.02, lastClose: 100, lastDate: '2026-10-16' };
const TICK_96 = { symbol: 'AAPL', bid: 96, ask: 96, last: 96 };
const TOTAL_RETRY_MS = [5, 15, 30, 60, 120, 240, 480].reduce((a, b) => a + b, 0) * 1000;

function createMockIBKR(): IBKRClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    setOnOrderStatus: vi.fn(),
    placeMOCOrder: vi.fn(),
    placeLOCOrder: vi.fn(),
  } as unknown as IBKRClient;
}

const opsOf = (call: unknown[]) => (call[0] as { op: string }[]).map(o => o.op);
const fillTransactions = () => mockPrisma.$transaction.mock.calls.filter(c => opsOf(c).includes('trade.create'));

/** Start a simulated engine with one strategy and let the startup tick (no price yet) finish */
async function startEngine() {
  const engine = new LinearTradingEngine(createMockIBKR(), true);
  await engine.start();
  await vi.advanceTimersByTimeAsync(0);
  return engine;
}

describe('LinearTradingEngine fill recording', () => {
  let engine: LinearTradingEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T16:00:00Z')); // Saturday — market closed
    mockPrisma.linearStrategy.findMany.mockResolvedValue([structuredClone(STRATEGY)]);
    mockPrisma.linearTrade.findUnique.mockResolvedValue(null);
    mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);
    mockFs.existsSync.mockReturnValue(false);
    vi.mocked(fetchAndComputeMetrics).mockResolvedValue(METRICS);
    vi.mocked(getLatestPrice).mockResolvedValue({ price: null, dayHigh: null, dayLow: null });
  });

  afterEach(async () => {
    await engine?.stop();
    vi.useRealTimers();
  });

  it('books a BUY fill as one transaction with a pre-generated trade id', async () => {
    engine = await startEngine();
    await engine.injectTick(TICK_96);

    const fills = fillTransactions();
    expect(fills).toHaveLength(1);
    expect(opsOf(fills[0])).toEqual(['trade.create', 'lot.create']);
    const tradeArgs = mockPrisma.linearTrade.create.mock.calls[0][0].data;
    expect(tradeArgs).toMatchObject({ action: 'BUY', shares: 52, price: 96 });
    expect(tradeArgs?.id).toEqual(expect.any(String));
    expect(mockFs.appendFileSync).not.toHaveBeenCalled();
  });

  it('retries a failed fill write until the DB comes back', async () => {
    let failures = 2;
    mockPrisma.$transaction.mockImplementation(async (ops: { op: string }[]) => {
      if (ops.some(o => o.op === 'trade.create') && failures-- > 0) throw new Error('ECHECKOUTTIMEOUT');
      return ops;
    });
    engine = await startEngine();

    const done = engine.injectTick(TICK_96);
    await vi.advanceTimersByTimeAsync(5_000 + 15_000);
    await done;

    expect(fillTransactions()).toHaveLength(3);
    expect(mockFs.appendFileSync).not.toHaveBeenCalled();
  });

  it('does not re-apply a fill whose failed attempt actually committed', async () => {
    let failed = false;
    mockPrisma.$transaction.mockImplementation(async (ops: { op: string }[]) => {
      if (ops.some(o => o.op === 'trade.create') && !failed) { failed = true; throw new Error('timeout after commit'); }
      return ops;
    });
    mockPrisma.linearTrade.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
    engine = await startEngine();

    const done = engine.injectTick(TICK_96);
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(fillTransactions()).toHaveLength(1);
    const tradeId = mockPrisma.linearTrade.create.mock.calls[0][0].data?.id;
    expect(mockPrisma.linearTrade.findUnique).toHaveBeenCalledWith({ where: { id: tradeId } });
    expect(mockFs.appendFileSync).not.toHaveBeenCalled();
  });

  it('journals the fill after all retries fail and blocks the symbol from trading', async () => {
    mockPrisma.$transaction.mockImplementation(async (ops: { op: string }[]) => {
      if (ops.some(o => o.op === 'trade.create')) throw new Error('ECHECKOUTTIMEOUT');
      return ops;
    });
    engine = await startEngine();

    const done = engine.injectTick(TICK_96);
    await vi.advanceTimersByTimeAsync(TOTAL_RETRY_MS);
    await done;

    expect(fillTransactions()).toHaveLength(8);
    expect(mockFs.appendFileSync).toHaveBeenCalledTimes(1);
    const [journalPath, line] = mockFs.appendFileSync.mock.calls[0];
    expect(journalPath).toMatch(/unrecorded-fills\.jsonl$/);
    expect(JSON.parse(line)).toMatchObject({ symbol: 'AAPL', action: 'BUY', filledQty: 52, fillPrice: 96 });

    // Next execution sees the journal entry and refuses to trade AAPL again
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(line);
    await engine.injectTick(TICK_96);
    expect(fillTransactions()).toHaveLength(8);
  });
});

describe('LinearTradingEngine DB writes per tick', () => {
  let engine: LinearTradingEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T16:00:00Z'));
    mockPrisma.linearStrategy.findMany.mockResolvedValue([structuredClone({ ...STRATEGY, autoExecute: false })]);
    mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);
    mockFs.existsSync.mockReturnValue(false);
    vi.mocked(fetchAndComputeMetrics).mockResolvedValue(METRICS);
    vi.mocked(getLatestPrice).mockResolvedValue({ price: null, dayHigh: null, dayLow: null });
  });

  afterEach(async () => {
    await engine?.stop();
    vi.useRealTimers();
  });

  it('writes prices and heartbeat in one transaction, skips unchanged prices, and throttles the heartbeat', async () => {
    engine = await startEngine(); // startup tick writes the first heartbeat
    mockPrisma.$transaction.mockClear();

    await engine.injectTick(TICK_96);                                  // new price, heartbeat not due
    await engine.injectTick(TICK_96);                                  // nothing changed → no write at all
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await engine.injectTick({ ...TICK_96, last: 95, bid: 95, ask: 95 }); // new price + heartbeat due

    const batches = mockPrisma.$transaction.mock.calls.map(opsOf);
    expect(batches).toEqual([
      ['strategy.update'],
      ['strategy.update', 'heartbeat.upsert'],
    ]);
  });
});

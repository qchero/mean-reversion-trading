"use server";

import prisma from '@/lib/prisma';
import { fetchAndComputeMetrics, getLatestPrice } from '../trading/v2/logic';
import { revalidatePath } from 'next/cache';

export async function createStrategy(data: {
  symbol: string;
  initialParamJ: number;
  stepParamK: number;
  maxSteps: number;
  stepAmount: number;
}) {
  // Reject duplicate symbols
  const existing = await prisma.strategy.findFirst({
    where: { symbol: data.symbol.toUpperCase() },
  });
  if (existing) {
    throw new Error(`A strategy for ${data.symbol.toUpperCase()} already exists.`);
  }

  await fetchAndComputeMetrics(data.symbol);

  const strategy = await prisma.strategy.create({
    data,
  });

  revalidatePath('/v1');
  return strategy;
}

export async function updateStrategy(id: string, data: {
  symbol?: string;
  initialParamJ?: number;
  stepParamK?: number;
  maxSteps?: number;
  stepAmount?: number;
  autoExecute?: boolean;
}) {
  const strategy = await prisma.strategy.update({
    where: { id },
    data,
  });

  if (data.symbol) {
    await fetchAndComputeMetrics(data.symbol);
  }
  
  revalidatePath('/v1');
  return strategy;
}

export async function getStrategies() {
  return prisma.strategy.findMany({
    orderBy: { createdAt: 'desc' }
  });
}

export async function getStrategyPreviewData(symbol: string) {
  try {
    const normalizedSymbol = symbol.toUpperCase();

    // Cache is valid if it was updated within the last 1 hour
    const CACHE_LIFETIME_MS = 60 * 60 * 1000;
    const isCacheValid = (cached: any) => {
      if (!cached) return false;
      return (Date.now() - new Date(cached.updatedAt).getTime()) < CACHE_LIFETIME_MS;
    };

    // Concurrently try fetching the live snapshot
    const defaultSnap = { price: null, dayHigh: null, dayLow: null };
    const snapPromise = getLatestPrice(normalizedSymbol).catch(() => defaultSnap);

    // 1. Fast path: hit SymbolCache first — single tiny DB query, no candle work needed
    const cached = await prisma.symbolCache.findUnique({
      where: { symbol: normalizedSymbol },
    });

    if (cached && isCacheValid(cached)) {
      const snap = await snapPromise;
      return {
        success: true,
        data: {
          sma100: cached.sma100,
          sma200: cached.sma200,
          sma300: cached.sma300,
          dailyVolatility: cached.dailyVolatility,
          latestPrice: snap.price !== null ? snap.price : cached.latestPrice,
          lastDate: cached.lastDate,
          dayHigh: snap.dayHigh,
          dayLow: snap.dayLow,
          sigma: cached.dailyVolatility // alias for compatibility
        },
      };
    }

    // 2. Cache miss — fetch + calculate + upsert
    const metrics = await fetchAndComputeMetrics(normalizedSymbol);
    if (!metrics) throw new Error('No metric data available');
    const snap = await snapPromise;
    const resolvedLatestPrice = snap.price !== null ? snap.price : metrics.lastClose;

    await prisma.symbolCache.upsert({
      where: { symbol: normalizedSymbol },
      update: {
        lastDate: metrics.lastDate,
        sma100: metrics.sma100,
        sma200: metrics.sma200,
        sma300: metrics.sma300,
        dailyVolatility: metrics.sigma,
        latestPrice: resolvedLatestPrice,
      },
      create: {
        symbol: normalizedSymbol,
        lastDate: metrics.lastDate,
        sma100: metrics.sma100,
        sma200: metrics.sma200,
        sma300: metrics.sma300,
        dailyVolatility: metrics.sigma,
        latestPrice: resolvedLatestPrice,
      },
    });

    return { success: true, data: { ...metrics, dailyVolatility: metrics.sigma, latestPrice: resolvedLatestPrice, dayHigh: snap.dayHigh, dayLow: snap.dayLow } };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to fetch strategy metrics',
    };
  }
}

export async function getBatchPreviewData(symbols: string[]) {
  const normalized = symbols.map(s => s.toUpperCase());

  // Cache is valid if it was updated within the last 1 hour
  const CACHE_LIFETIME_MS = 60 * 60 * 1000;
  const isCacheValid = (cached: any) => {
    if (!cached) return false;
    return (Date.now() - new Date(cached.updatedAt).getTime()) < CACHE_LIFETIME_MS;
  };

  // Single DB query for all symbol caches
  const caches = await prisma.symbolCache.findMany({
    where: { symbol: { in: normalized } },
  });
  const cacheMap = new Map(caches.map(c => [c.symbol, c]));

  // Fetch live snapshots in parallel
  const defaultSnap = { price: null, dayHigh: null, dayLow: null };
  const snapResults = await Promise.all(
    normalized.map(s => getLatestPrice(s).catch(() => defaultSnap))
  );
  const snapMap = new Map(normalized.map((s, i) => [s, snapResults[i] ?? defaultSnap]));

  const results: Record<string, { sma100: number; sma200: number; sma300: number; dailyVolatility: number; latestPrice: number; lastDate: string; dayHigh: number | null; dayLow: number | null }> = {};

  // Process each symbol: use cache if fresh, else recalculate
  // (each fetchAndComputeMetrics dynamically checks Yahoo without DB load)
  for (const symbol of normalized) {
    const cached = cacheMap.get(symbol);
    const snap = snapMap.get(symbol) ?? defaultSnap;

    if (cached && isCacheValid(cached)) {
      results[symbol] = {
        sma100: cached.sma100,
        sma200: cached.sma200,
        sma300: cached.sma300,
        dailyVolatility: cached.dailyVolatility,
        latestPrice: snap.price !== null ? snap.price : cached.latestPrice,
        lastDate: cached.lastDate,
        dayHigh: snap.dayHigh,
        dayLow: snap.dayLow,
      };
      continue;
    }

    // Cache miss — fetch + calculate + upsert
    try {
      const metrics = await fetchAndComputeMetrics(symbol);
      if (!metrics) continue;
      const resolvedPrice = snap.price !== null ? snap.price : metrics.lastClose;

      await prisma.symbolCache.upsert({
        where: { symbol },
        update: { lastDate: metrics.lastDate, sma100: metrics.sma100, sma200: metrics.sma200, sma300: metrics.sma300, dailyVolatility: metrics.sigma, latestPrice: resolvedPrice },
        create: { symbol, lastDate: metrics.lastDate, sma100: metrics.sma100, sma200: metrics.sma200, sma300: metrics.sma300, dailyVolatility: metrics.sigma, latestPrice: resolvedPrice },
      });

      results[symbol] = { ...metrics, dailyVolatility: metrics.sigma, latestPrice: resolvedPrice, dayHigh: snap.dayHigh, dayLow: snap.dayLow };
    } catch {
      // skip failed symbols
    }
  }

  return results;
}

export async function deleteStrategy(id: string) {
  await prisma.strategy.delete({
    where: { id }
  });
  revalidatePath('/v1');
}

export async function getStrategyTrades(strategyId: string) {
  return prisma.trade.findMany({
    where: { strategyId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getAllTrades() {
  const trades = await prisma.trade.findMany({
    orderBy: { createdAt: 'desc' },
  });
  const map: Record<string, typeof trades> = {};
  for (const t of trades) {
    (map[t.strategyId] ||= []).push(t);
  }
  return map;
}

export async function createTrade(data: {
  strategyId: string;
  step: number;
  shares: number;
  buyPrice: number;
  buyDate: string;
}) {
  const trade = await prisma.trade.create({ data });
  revalidatePath('/v1');
  return trade;
}

export async function updateTrade(id: string, data: {
  sellPrice?: number;
  sellDate?: string;
}) {
  const trade = await prisma.trade.update({ where: { id }, data });
  revalidatePath('/v1');
  return trade;
}

export async function deleteTrade(id: string) {
  await prisma.trade.delete({ where: { id } });
  revalidatePath('/v1');
}

export async function getStrategyOrders(strategyId: string) {
  return prisma.order.findMany({
    where: { strategyId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
}

export async function deleteOrder(id: string) {
  // Only allow deleting completed orders to avoid orphaning live IBKR orders
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw new Error('Order not found');
  if (order.status !== 'filled' && order.status !== 'cancelled') {
    throw new Error('Cannot delete an active order');
  }
  await prisma.order.delete({ where: { id } });
  revalidatePath('/v1');
}

export async function getEngineHeartbeat(): Promise<Date | null> {
  const row = await prisma.engineHeartbeat.findUnique({ where: { id: 'singleton' } });
  return row?.timestamp ?? null;
}

export async function getRecentOrderEvents(sinceMs: number) {
  const since = new Date(sinceMs);
  return prisma.order.findMany({
    where: {
      updatedAt: { gte: since },
      status: { in: ['filled', 'cancelled'] },
    },
    include: { strategy: { select: { symbol: true } } },
    orderBy: { updatedAt: 'desc' },
  });
}

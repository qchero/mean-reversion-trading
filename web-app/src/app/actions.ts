"use server";

import prisma from '@/lib/prisma';
import { getOrFetchHistoricalData, calculateStrategyMetrics, getLatestPrice } from '@/lib/polygon';
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

  // Fetch & cache historical data first — if Polygon fails, we won't create a broken strategy
  await getOrFetchHistoricalData(data.symbol);

  const strategy = await prisma.strategy.create({
    data,
  });

  revalidatePath('/');
  return strategy;
}

export async function updateStrategy(id: string, data: {
  symbol?: string;
  initialParamJ?: number;
  stepParamK?: number;
  maxSteps?: number;
  stepAmount?: number;
  autoExecute?: boolean;
  executions?: string;
}) {
  const strategy = await prisma.strategy.update({
    where: { id },
    data,
  });

  if (data.symbol) {
    await getOrFetchHistoricalData(data.symbol);
  }
  
  revalidatePath('/');
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

    // Compute the latest trading day with finalized data (same logic as polygon.ts)
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hourET = nowET.getHours();
    const dayOfWeek = nowET.getDay();

    const expectedEnd = new Date(nowET);
    expectedEnd.setHours(0, 0, 0, 0);

    if (dayOfWeek === 0) expectedEnd.setDate(expectedEnd.getDate() - 2);        // Sun → Fri
    else if (dayOfWeek === 6) expectedEnd.setDate(expectedEnd.getDate() - 1);   // Sat → Fri
    else if (hourET < 17) {
      if (dayOfWeek === 1) expectedEnd.setDate(expectedEnd.getDate() - 3);      // Mon < 5pm → Fri
      else expectedEnd.setDate(expectedEnd.getDate() - 1);
    }

    const year = expectedEnd.getFullYear();
    const month = String(expectedEnd.getMonth() + 1).padStart(2, '0');
    const day = String(expectedEnd.getDate()).padStart(2, '0');
    const expectedDate = `${year}-${month}-${day}`;

    // Concurrently try fetching the live snapshot price
    const livePricePromise = getLatestPrice(normalizedSymbol).catch(() => null);

    // 1. Fast path: hit SymbolCache first — single tiny DB query, no candle work needed
    const cached = await prisma.symbolCache.findUnique({
      where: { symbol: normalizedSymbol },
    });

    if (cached && cached.lastDate >= expectedDate) {
      const livePrice = await livePricePromise;
      return {
        success: true,
        data: {
          sma200: cached.sma200,
          dailyVolatility: cached.dailyVolatility,
          latestPrice: livePrice !== null ? livePrice : cached.latestPrice,
          lastDate: cached.lastDate,
        },
      };
    }

    // 2. Cache miss — fetch + calculate + upsert
    const candles = await getOrFetchHistoricalData(normalizedSymbol);
    if (!candles || candles.length === 0) throw new Error('No candle data available');

    const metrics = calculateStrategyMetrics(candles);
    const livePrice = await livePricePromise;
    const resolvedLatestPrice = livePrice !== null ? livePrice : metrics.latestPrice;

    await prisma.symbolCache.upsert({
      where: { symbol: normalizedSymbol },
      update: {
        lastDate: metrics.lastDate,
        sma200: metrics.sma200,
        dailyVolatility: metrics.dailyVolatility,
        latestPrice: resolvedLatestPrice,
      },
      create: {
        symbol: normalizedSymbol,
        lastDate: metrics.lastDate,
        sma200: metrics.sma200,
        dailyVolatility: metrics.dailyVolatility,
        latestPrice: resolvedLatestPrice,
      },
    });

    return { success: true, data: { ...metrics, latestPrice: resolvedLatestPrice } };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to fetch strategy metrics',
    };
  }
}

export async function deleteStrategy(id: string) {
  await prisma.strategy.delete({
    where: { id }
  });
  revalidatePath('/');
}

"use server";

import prisma from '@/lib/prisma';
import { getOrFetchHistoricalData, calculateStrategyMetrics } from '@/lib/polygon';
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

    // Compute the expected last trading day (yesterday, weekend-aware)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    if (today.getDay() === 1) yesterday.setDate(today.getDate() - 3);       // Mon → Fri
    else if (today.getDay() === 0) yesterday.setDate(today.getDate() - 2);  // Sun → Fri
    else yesterday.setDate(today.getDate() - 1);
    const expectedDate = yesterday.toISOString().split('T')[0];

    // 1. Fast path: hit SymbolCache first — single tiny DB query, no candle work needed
    const cached = await prisma.symbolCache.findUnique({
      where: { symbol: normalizedSymbol },
    });

    if (cached && cached.lastDate >= expectedDate) {
      return {
        success: true,
        data: {
          sma200: cached.sma200,
          dailyVolatility: cached.dailyVolatility,
          latestPrice: cached.latestPrice,
          lastDate: cached.lastDate,
        },
      };
    }

    // 2. Cache miss — fetch + calculate + upsert
    const candles = await getOrFetchHistoricalData(normalizedSymbol);
    if (!candles || candles.length === 0) throw new Error('No candle data available');

    const metrics = calculateStrategyMetrics(candles);

    await prisma.symbolCache.upsert({
      where: { symbol: normalizedSymbol },
      update: {
        lastDate: metrics.lastDate,
        sma200: metrics.sma200,
        dailyVolatility: metrics.dailyVolatility,
        latestPrice: metrics.latestPrice,
      },
      create: {
        symbol: normalizedSymbol,
        lastDate: metrics.lastDate,
        sma200: metrics.sma200,
        dailyVolatility: metrics.dailyVolatility,
        latestPrice: metrics.latestPrice,
      },
    });

    return { success: true, data: metrics };
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

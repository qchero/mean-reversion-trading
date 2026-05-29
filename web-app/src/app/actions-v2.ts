"use server";

import prisma from '@/lib/prisma';
import { revalidatePath } from 'next/cache';
import { fetchAndComputeMetrics, getLatestPrice } from '@/trading/v2/logic';

export async function createLinearStrategy(data: {
  symbol: string;
  bandLo: number;
  bandHi: number;
  maxBudget: number;
  minTradeAmount: number;
}) {
  const existing = await prisma.linearStrategy.findFirst({
    where: { symbol: data.symbol.toUpperCase() },
  });
  if (existing) {
    throw new Error(`A strategy for ${data.symbol.toUpperCase()} already exists.`);
  }

  const symbol = data.symbol.toUpperCase();

  const strategy = await prisma.linearStrategy.create({
    data: {
      ...data,
      symbol,
    },
  });

  // Fetch initial metrics and price so the card isn't empty
  const [metrics, priceSnap] = await Promise.all([
    fetchAndComputeMetrics(symbol),
    getLatestPrice(symbol),
  ]);

  if (metrics || priceSnap.price) {
    await prisma.linearStrategy.update({
      where: { id: strategy.id },
      data: {
        ...(metrics && { sma100: metrics.sma100, sma200: metrics.sma200, sma300: metrics.sma300, dailyVolatility: metrics.sigma }),
        ...(priceSnap.price && { latestPrice: priceSnap.price, latestPriceAt: new Date() }),
      },
    });
  }

  revalidatePath('/');
  return strategy;
}

export async function updateLinearStrategy(id: string, data: {
  symbol?: string;
  bandLo?: number;
  bandHi?: number;
  maxBudget?: number;
  minTradeAmount?: number;
  autoExecute?: boolean;
}) {
  const strategy = await prisma.linearStrategy.update({
    where: { id },
    data,
  });
  
  revalidatePath('/');
  return strategy;
}

export async function getLinearStrategies() {
  const strats = await prisma.linearStrategy.findMany({
    include: {
      lots: {
        orderBy: { date: 'desc' }
      },
      trades: {
        orderBy: { date: 'desc' }
      },
    },
  });

  return strats.sort((a: any, b: any) => {
    const sigmaA = a.sma200 && a.latestPrice && a.dailyVolatility 
      ? (a.sma200 - a.latestPrice) / (a.sma200 * a.dailyVolatility) 
      : -999;
    const sigmaB = b.sma200 && b.latestPrice && b.dailyVolatility 
      ? (b.sma200 - b.latestPrice) / (b.sma200 * b.dailyVolatility) 
      : -999;
    
    // Sort descending (highest sigmaBelow first)
    return sigmaB - sigmaA;
  });
}

export async function deleteLinearStrategy(id: string) {
  await prisma.linearStrategy.delete({
    where: { id }
  });
  revalidatePath('/');
}

export async function getEngineHeartbeatV2(): Promise<Date | null> {
  const row = await prisma.engineHeartbeat.findUnique({ where: { id: 'singleton' } });
  return row?.timestamp ?? null;
}

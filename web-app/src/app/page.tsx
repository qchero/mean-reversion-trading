"use client";

import { useEffect, useState, useRef, useCallback } from 'react';
import { Container, Title, Text, Grid } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import StrategyForm from '@/components/StrategyForm';
import StrategyCard from '@/components/StrategyCard';
import { getStrategies, getBatchPreviewData, getAllTrades, getRecentOrderEvents } from '@/app/actions';
import { Strategy, Trade } from '@prisma/client';

interface StrategyMetrics {
  sma200: number;
  dailyVolatility: number;
  latestPrice: number;
  lastDate: string;
}

export default function Home() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [metricsMap, setMetricsMap] = useState<Record<string, StrategyMetrics>>({});
  const [tradesMap, setTradesMap] = useState<Record<string, Trade[]>>({});
  const notifiedOrderIds = useRef(new Set<string>());
  const lastPollTime = useRef(Date.now());

  const loadStrategies = async () => {
    const data = await getStrategies();

    // Batch fetch metrics and trades in parallel
    const uniqueSymbols = [...new Set(data.map(s => s.symbol))];
    const [metricsResult, tradesResult] = await Promise.all([
      uniqueSymbols.length > 0 ? getBatchPreviewData(uniqueSymbols) : {} as Record<string, StrategyMetrics>,
      getAllTrades(),
    ]);
    setMetricsMap(metricsResult);
    setTradesMap(tradesResult);

    // Sort by σ-normalized deviation ASC (most negative σ = furthest below SMA = most triggered)
    const sorted = [...data].sort((a, b) => {
      const mA = metricsResult[a.symbol];
      const mB = metricsResult[b.symbol];
      const sigmaA = mA && mA.sma200 > 0 && mA.dailyVolatility > 0
        ? (mA.latestPrice / mA.sma200 - 1) / mA.dailyVolatility : 0;
      const sigmaB = mB && mB.sma200 > 0 && mB.dailyVolatility > 0
        ? (mB.latestPrice / mB.sma200 - 1) / mB.dailyVolatility : 0;
      return sigmaA - sigmaB;
    });

    setStrategies(sorted);
  };

  // Poll for order events and show toast notifications
  const pollOrderEvents = useCallback(async () => {
    try {
      const events = await getRecentOrderEvents(lastPollTime.current);
      lastPollTime.current = Date.now();

      for (const event of events) {
        if (notifiedOrderIds.current.has(event.id)) continue;
        notifiedOrderIds.current.add(event.id);

        const symbol = (event as any).strategy?.symbol || '???';
        const isFilled = event.status === 'filled';
        const filledInfo = event.filledQty > 0
          ? `${event.filledQty}/${event.totalQty} shares @ $${event.avgFillPrice?.toFixed(2) || event.limitPrice.toFixed(2)}`
          : 'not filled';

        notifications.show({
          title: `${symbol} Step ${event.step}: ${event.side} ${isFilled ? 'Filled' : 'Cancelled'}`,
          message: filledInfo,
          color: isFilled ? 'teal' : 'gray',
          autoClose: 8000,
        });
      }

      // If there were fills, refresh strategies to pick up new trade records
      if (events.some(e => e.status === 'filled' && e.filledQty > 0)) {
        loadStrategies();
      }
    } catch {
      // silently ignore poll errors
    }
  }, []);

  useEffect(() => {
    loadStrategies();

    // Poll for order notifications every 5 seconds
    const interval = setInterval(pollOrderEvents, 5000);
    return () => clearInterval(interval);
  }, [pollOrderEvents]);

  return (
    <Container size="lg" py="xl">
      <Title order={1} mb="xs" c="teal">Mean Reversion Dashboard</Title>
      <Text c="dimmed" mb="xl">Design &amp; monitor your automated trading rules.</Text>

      <Grid>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <StrategyForm onStrategyCreated={loadStrategies} />
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 8 }}>
          {strategies.length === 0 ? (
            <Text c="dimmed" fs="italic" ta="center" mt="xl">
              No strategies created yet. Add one from the sidebar.
            </Text>
          ) : (
            strategies.map(s => (
              <StrategyCard
                key={s.id}
                strategy={s}
                metrics={metricsMap[s.symbol] ?? null}
                trades={tradesMap[s.id] ?? []}
                onUpdate={loadStrategies}
              />
            ))
          )}
        </Grid.Col>
      </Grid>
    </Container>
  );
}

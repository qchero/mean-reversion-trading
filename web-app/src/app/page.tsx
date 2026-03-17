"use client";

import { useEffect, useState } from 'react';
import { Container, Title, Text, Grid } from '@mantine/core';
import StrategyForm from '@/components/StrategyForm';
import StrategyCard from '@/components/StrategyCard';
import { getStrategies, getStrategyPreviewData } from '@/app/actions';
import { Strategy } from '@prisma/client';

interface StrategyMetrics {
  sma200: number;
  dailyVolatility: number;
  latestPrice: number;
  lastDate: string;
}

export default function Home() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [metricsMap, setMetricsMap] = useState<Record<string, StrategyMetrics>>({});

  const loadStrategies = async () => {
    const data = await getStrategies();

    // Fetch metrics for all unique symbols in parallel
    const uniqueSymbols = [...new Set(data.map(s => s.symbol))];
    const results = await Promise.all(
      uniqueSymbols.map(async (symbol) => {
        const res = await getStrategyPreviewData(symbol);
        return { symbol, metrics: res.success && res.data ? res.data : null };
      })
    );

    const map: Record<string, StrategyMetrics> = {};
    for (const { symbol, metrics } of results) {
      if (metrics) map[symbol] = metrics;
    }
    setMetricsMap(map);

    // Sort by latestPrice / sma200 ASC (lowest ratio = furthest below SMA = most triggered)
    const sorted = [...data].sort((a, b) => {
      const mA = map[a.symbol];
      const mB = map[b.symbol];
      const ratioA = mA && mA.sma200 > 0 ? mA.latestPrice / mA.sma200 : 1;
      const ratioB = mB && mB.sma200 > 0 ? mB.latestPrice / mB.sma200 : 1;
      return ratioA - ratioB;
    });

    setStrategies(sorted);
  };

  useEffect(() => {
    loadStrategies();
  }, []);

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
                onUpdate={loadStrategies}
              />
            ))
          )}
        </Grid.Col>
      </Grid>
    </Container>
  );
}

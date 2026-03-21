"use client";

import { useEffect, useState, useRef, useCallback } from 'react';
import { ActionIcon, Box, Container, Drawer, Group, Loader, Title, Text, Grid } from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { IconLogout, IconPlus } from '@tabler/icons-react';
import { signOut } from 'next-auth/react';
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
  const [loading, setLoading] = useState(true);
  const [drawerOpened, { open: openDrawer, close: closeDrawer }] = useDisclosure(false);
  const isMobile = useMediaQuery('(max-width: 768px)');
  const notifiedOrderIds = useRef(new Set<string>());
  const lastPollTime = useRef(Date.now());

  const loadStrategies = async () => {
    try {
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
    } finally {
      setLoading(false);
    }
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
      <Group justify="space-between" align="center" mb="xs" wrap="nowrap">
        <Title order={3} c="teal">Mean Reversion Dashboard</Title>
        <ActionIcon variant="subtle" color="gray" size="lg" onClick={() => signOut()} title="Sign out">
          <IconLogout size={20} />
        </ActionIcon>
      </Group>
      {(() => {
        const firstDate = Object.values(metricsMap)[0]?.lastDate;
        return firstDate ? <Text size="xs" c="dimmed" mb="md">{firstDate}</Text> : <Box mb="md" />;
      })()}

      <Grid>
        <Grid.Col span={4} visibleFrom="md">
          <StrategyForm onStrategyCreated={loadStrategies} />
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 8 }}>
          {loading ? (
            <Loader color="teal" display="block" mx="auto" mt="xl" />
          ) : strategies.length === 0 ? (
            <Text c="dimmed" fs="italic" ta="center" mt="xl">
              No strategies created yet.{isMobile ? ' Tap + to add one.' : ' Add one from the sidebar.'}
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

      {/* Mobile: FAB + Drawer for new strategy form */}
      {isMobile && (
        <>
          <ActionIcon
            color="teal"
            size={50}
            radius="xl"
            variant="filled"
            onClick={openDrawer}
            style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 100 }}
          >
            <IconPlus size={24} />
          </ActionIcon>
          <Drawer opened={drawerOpened} onClose={closeDrawer} title="New Strategy" position="bottom" size="auto">
            <Box pb="md">
              <StrategyForm onStrategyCreated={() => { loadStrategies(); closeDrawer(); }} />
            </Box>
          </Drawer>
        </>
      )}
    </Container>
  );
}

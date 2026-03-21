"use client";

import { useState, useEffect } from 'react';
import {
  Paper, Title, Text, Group, Grid, Switch, Badge, Table, Box,
  ActionIcon, NumberInput, Button, Collapse, UnstyledButton, Skeleton, Modal,
  TextInput, Divider, Tooltip,
} from '@mantine/core';
import { IconTrash, IconChevronDown, IconChevronUp, IconEdit, IconCurrencyDollar } from '@tabler/icons-react';
import {
  updateStrategy, deleteStrategy, deleteOrder,
  getStrategyPreviewData, getStrategyOrders,
  createTrade, updateTrade, deleteTrade,
} from '@/app/actions';
import { Strategy, Order, Trade } from '@prisma/client';

interface Metrics {
  sma200: number;
  dailyVolatility: number;
  latestPrice: number;
  lastDate: string;
}

interface StrategyCardProps {
  strategy: Strategy;
  metrics: Metrics | null;
  trades: Trade[];
  onUpdate: () => void;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function StrategyCard({ strategy, metrics: metricsProp, trades: tradesProp, onUpdate }: StrategyCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [autoExecute, setAutoExecute] = useState(strategy.autoExecute);
  const [metrics, setMetrics] = useState<Metrics | null>(metricsProp);
  const [metricsLoading, setMetricsLoading] = useState(!metricsProp);

  const [trades, setTrades] = useState<Trade[]>(tradesProp);

  // Sync trades when parent re-fetches
  useEffect(() => {
    setTrades(tradesProp);
  }, [tradesProp]);

  // Modal state
  const [buyModal, setBuyModal] = useState<{
    step: number; shares: number | string; price: number | string; date: string;
  } | null>(null);

  const [sellModal, setSellModal] = useState<{
    trade: Trade; price: number | string; date: string;
  } | null>(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteTradeId, setDeleteTradeId] = useState<string | null>(null);

  // Poll orders when expanded
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    const fetchOrders = async () => {
      const data = await getStrategyOrders(strategy.id);
      if (!cancelled) setOrders(data);
    };
    fetchOrders();
    const interval = setInterval(fetchOrders, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [expanded, strategy.id]);

  const handleSaveBuy = async () => {
    if (!buyModal) return;
    const data = {
      strategyId: strategy.id,
      step: buyModal.step,
      shares: Number(buyModal.shares),
      buyPrice: Number(buyModal.price),
      buyDate: buyModal.date || todayStr(),
    };
    setBuyModal(null);
    const newTrade = await createTrade(data);
    setTrades(prev => [newTrade, ...prev]);
  };

  const handleSaveSell = async () => {
    if (!sellModal) return;
    const updated = await updateTrade(sellModal.trade.id, {
      sellPrice: Number(sellModal.price),
      sellDate: sellModal.date || todayStr(),
    });
    setSellModal(null);
    setTrades(prev => prev.map(t => t.id === updated.id ? updated : t));
  };

  const handleDeleteTrade = async (tradeId: string) => {
    setDeleteTradeId(null);
    setBuyModal(null);
    setSellModal(null);
    await deleteTrade(tradeId);
    setTrades(prev => prev.filter(t => t.id !== tradeId));
  };

  // If parent didn't provide metrics (still loading), self-fetch as fallback
  useEffect(() => {
    if (metricsProp) {
      setMetrics(metricsProp);
      setMetricsLoading(false);
      return;
    }
    let cancelled = false;
    async function fetchMetrics() {
      setMetricsLoading(true);
      const res = await getStrategyPreviewData(strategy.symbol);
      if (!cancelled && res.success && res.data) {
        setMetrics(res.data);
      }
      if (!cancelled) setMetricsLoading(false);
    }
    fetchMetrics();
    return () => { cancelled = true; };
  }, [metricsProp, strategy.symbol]);

  // Live Editable states
  const [j, setJ] = useState<number | string>(strategy.initialParamJ);
  const [k, setK] = useState<number | string>(strategy.stepParamK);
  const [maxSteps, setMaxSteps] = useState<number | string>(strategy.maxSteps);
  const [amount, setAmount] = useState<number | string>(strategy.stepAmount);

  // Debounced save to DB
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;
    const saveChanges = async () => {
      if (
        j === strategy.initialParamJ && k === strategy.stepParamK &&
        maxSteps === strategy.maxSteps && amount === strategy.stepAmount
      ) return;
      if (!j || !k || !maxSteps || !amount) return;

      await updateStrategy(strategy.id, {
        initialParamJ: Number(j),
        stepParamK: Number(k),
        maxSteps: Number(maxSteps),
        stepAmount: Number(amount),
      });
    };
    timeoutId = setTimeout(saveChanges, 1000);
    return () => clearTimeout(timeoutId);
  }, [j, k, maxSteps, amount, strategy.id, strategy]);

  const toggleAutoExecute = async () => {
    const next = !autoExecute;
    setAutoExecute(next); // optimistic
    try {
      await updateStrategy(strategy.id, { autoExecute: next });
      onUpdate();
    } catch {
      setAutoExecute(!next); // revert
    }
  };

  const handleDelete = async () => {
    setDeleteConfirm(false);
    await deleteStrategy(strategy.id);
    onUpdate();
  };

  // Derived trade lists
  const openTrades = trades.filter(t => t.sellPrice == null);
  const closedTrades = trades.filter(t => t.sellPrice != null);
  const totalClosedPnl = closedTrades.reduce((sum, t) => sum + (t.sellPrice! - t.buyPrice) * t.shares, 0);

  const generatePreviewSteps = () => {
    if (!metrics?.sma200 || !j || !k || !maxSteps || !amount) return [];
    const steps = [];
    const _j = Number(j);
    const _k = Number(k);
    const _max = Number(maxSteps);
    const _amount = Number(amount);

    for (let i = 0; i < _max; i++) {
      const stepNum = i + 1;
      const multiplier = _j + i * _k;
      const theoBuyPrice = metrics.sma200 * (1 - multiplier * metrics.dailyVolatility);
      const prevMultiplier = _j + (i - 1) * _k;
      const theoSellPrice = metrics.sma200 * (1 - prevMultiplier * metrics.dailyVolatility);
      const triggered = metrics.latestPrice > 0 && metrics.latestPrice <= theoBuyPrice;

      // Find the open trade for this step (if any)
      const openTrade = trades.find(t => t.step === stepNum && t.sellPrice == null);
      const isBought = !!openTrade;

      const buyPrice = openTrade ? openTrade.buyPrice : theoBuyPrice;
      const rawShares = openTrade ? openTrade.shares : (_amount / theoBuyPrice);
      const shares = openTrade ? rawShares : Math.round(rawShares);
      const costBasis = openTrade ? (openTrade.buyPrice * openTrade.shares) : (shares * theoBuyPrice);

      const estProfit = shares * (theoSellPrice - buyPrice);
      const estProfitPct = (estProfit / costBasis) * 100;

      // Find active order for this step
      const activeOrder = orders.find(
        o => o.step === stepNum && (o.status === 'submitted' || o.status === 'partial' || o.status === 'pending')
      );

      steps.push({
        step: stepNum,
        buyPrice: buyPrice.toFixed(2),
        sellPrice: theoSellPrice.toFixed(2),
        shares: openTrade ? shares.toFixed(2) : String(shares),
        amount: costBasis.toFixed(2),
        estProfit: estProfit.toFixed(2),
        estProfitPct: estProfitPct.toFixed(2),
        triggered,
        isBought,
        openTrade: openTrade || null,
        activeOrder: activeOrder || null,
      });
    }
    return steps;
  };

  const steps = generatePreviewSteps();
  const ratio = metrics && metrics.sma200 > 0 ? metrics.latestPrice / metrics.sma200 : null;
  const currentSigma = ratio !== null && metrics && metrics.dailyVolatility > 0
    ? (ratio - 1) / metrics.dailyVolatility : null;

  const jError =
    metrics && metrics.dailyVolatility > 0 && Number(j) * metrics.dailyVolatility >= 1
      ? `Initial Multiplier × σ = ${(Number(j) * metrics.dailyVolatility * 100).toFixed(1)}% — must be < 100%`
      : undefined;

  const lastStepPct =
    metrics && metrics.dailyVolatility > 0
      ? (Number(j) + Number(k) * (Number(maxSteps) - 1)) * metrics.dailyVolatility
      : 0;

  const lastStepError =
    lastStepPct >= 1
      ? `Last step = ${(lastStepPct * 100).toFixed(1)}% — must be < 100%`
      : undefined;

  return (
    <Paper shadow="sm" radius="md" p={{ base: 'sm', sm: 'xl' }} className="glass-card" mb="lg" style={{ overflow: 'hidden' }}>
      {/* Header row — always visible */}
      <Group justify="space-between" wrap="nowrap">
        <UnstyledButton onClick={() => setExpanded(v => !v)} style={{ flex: 1, minWidth: 0 }}>
          <Group gap="xs" wrap="nowrap">
            <Title order={3}>{strategy.symbol}</Title>
            <Badge color={autoExecute ? 'green' : 'gray'} size="sm">
              {autoExecute ? 'Auto' : 'Manual'}
            </Badge>
            {expanded ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
          </Group>
        </UnstyledButton>
        <Group gap="xs" wrap="nowrap">
          <Switch
            label="Auto Execute"
            checked={autoExecute}
            onChange={toggleAutoExecute}
            color="teal"
            styles={{ label: { paddingLeft: 6 } }}
            visibleFrom="sm"
          />
          <Switch
            checked={autoExecute}
            onChange={toggleAutoExecute}
            color="teal"
            hiddenFrom="sm"
          />
          <ActionIcon color="red" variant="subtle" onClick={() => setDeleteConfirm(true)}>
            <IconTrash size={18} />
          </ActionIcon>
        </Group>
      </Group>

      {/* Metrics summary — always visible */}
      {metrics && (
        <>
          <Group mt="sm" justify="space-between" wrap="nowrap">
            <div>
              <Text size="xs" c="dimmed">SMA 200</Text>
              <Text fw={600}>${metrics.sma200.toFixed(2)}</Text>
            </div>
            <div>
              <Text size="xs" c="dimmed">Latest Price</Text>
              <Text fw={600} c={metrics.latestPrice < metrics.sma200 ? 'red' : 'teal'}>
                ${metrics.latestPrice.toFixed(2)}
                {ratio !== null && (
                  <Text span size="xs" c="dimmed" ml={4}>
                    ({ratio >= 1 ? '+' : ''}{((ratio - 1) * 100).toFixed(1)}%)
                  </Text>
                )}
              </Text>
            </div>
            <div>
              <Text size="xs" c="dimmed" visibleFrom="sm">Daily Volatility (σ)</Text>
              <Text size="xs" c="dimmed" hiddenFrom="sm">σ</Text>
              <Text fw={600}>{(metrics.dailyVolatility * 100).toFixed(2)}%</Text>
            </div>
          </Group>

          {/* σ Gauge — left is positive (high price), right is negative (low price / buy zone) */}
          {currentSigma !== null && steps.length > 0 && (() => {
            const _j = Number(j);
            const _k = Number(k);
            const _max = Number(maxSteps);
            // Step buy σ values (negative): step i has σ = -(j + i*k)
            const stepSigmas = Array.from({ length: _max }, (_, i) => -(_j + i * _k));
            // Step sell σ values (negative, less negative than buy): step i sell σ = -(j + (i-1)*k)
            const sellSigmas = Array.from({ length: _max }, (_, i) => -(_j + (i - 1) * _k));
            // Left edge: include sell targets for bought steps
            const boughtSellSigmas = sellSigmas.filter((_, i) => steps[i]?.isBought);
            const allPoints = [currentSigma, stepSigmas[0], ...boughtSellSigmas];
            const leftSigma = Math.max(...allPoints) + 1;
            // Right edge: max of current σ and last step σ, plus padding
            const rightSigma = Math.min(currentSigma, stepSigmas[stepSigmas.length - 1]) - 1;
            const range = leftSigma - rightSigma; // leftSigma > rightSigma (positive to negative)
            // Map σ value to % position (left=0%, right=100%)
            const toPercent = (sigma: number) =>
              Math.max(0, Math.min(100, ((leftSigma - sigma) / range) * 100));
            const currentPos = toPercent(currentSigma);

            return (
              <Box mt="sm" px="md" pb="xs">
                <Box style={{ position: 'relative', height: 40 }}>
                  {/* Track */}
                  <Box style={{
                    position: 'absolute', top: 16, left: 0, right: 0, height: 4,
                    backgroundColor: 'var(--mantine-color-dark-5)', borderRadius: 2,
                  }} />

                  {/* 0σ separator line */}
                  {currentSigma > 0 && (
                    <Box style={{
                      position: 'absolute', top: 12, left: `${toPercent(0)}%`, transform: 'translateX(-50%)',
                    }}>
                      <Box style={{ width: 2, height: 12, backgroundColor: 'var(--mantine-color-dark-3)' }} />
                      <Text size="9px" c="dimmed" ta="center" mt={2}>0σ</Text>
                    </Box>
                  )}

                  {/* Step markers */}
                  {stepSigmas.map((sigma, i) => {
                    const isBought = steps[i]?.isBought;
                    const pos = toPercent(sigma);
                    return (
                      <Tooltip key={i} label={`Step ${i + 1}: ${sigma.toFixed(1)}σ ($${steps[i]?.buyPrice})`} withArrow>
                        <Box style={{
                          position: 'absolute', top: 11, left: `${pos}%`, transform: 'translateX(-50%)',
                          cursor: 'default',
                        }}>
                          <Box style={{
                            width: 14, height: 14, borderRadius: '50%',
                            border: `2px solid ${isBought ? 'var(--mantine-color-blue-6)' : 'var(--mantine-color-dark-3)'}`,
                            backgroundColor: isBought ? 'var(--mantine-color-blue-6)' : 'transparent',
                          }} />
                          <Text size="9px" c="dimmed" ta="center" mt={2}>{sigma.toFixed(1)}σ</Text>
                        </Box>
                      </Tooltip>
                    );
                  })}

                  {/* Sell target marker (diamond, only for step 1 when bought) */}
                  {sellSigmas.map((sigma, i) => {
                    if (i !== 0 || !steps[i]?.isBought || currentSigma <= stepSigmas[0]) return null;
                    const pos = toPercent(sigma);
                    return (
                      <Tooltip key={`sell-${i}`} label={`Step ${i + 1} sell: ${sigma.toFixed(1)}σ ($${steps[i]?.sellPrice})`} withArrow>
                        <Box style={{
                          position: 'absolute', top: 12, left: `${pos}%`, transform: 'translateX(-50%)',
                          cursor: 'default',
                        }}>
                          <Box style={{ width: 2, height: 12, backgroundColor: 'var(--mantine-color-teal-6)' }} />
                          <Text size="9px" c="teal" ta="center" mt={2}>{sigma.toFixed(1)}σ</Text>
                        </Box>
                      </Tooltip>
                    );
                  })}

                  {/* Current price marker (triangle + σ label) */}
                  <Tooltip label={`Current: ${currentSigma.toFixed(1)}σ ($${metrics.latestPrice.toFixed(2)})`} withArrow>
                    <Box style={{
                      position: 'absolute', top: 11, left: `${currentPos}%`, transform: 'translateX(-50%)',
                      cursor: 'default',
                    }}>
                      <Box style={{
                        width: 0, height: 0, margin: '0 auto',
                        borderLeft: '7px solid transparent', borderRight: '7px solid transparent',
                        borderTop: '14px solid var(--mantine-color-orange-5)',
                      }} />
                      <Text size="9px" fw={600} c="orange" ta="center" mt={2}>
                        {currentSigma.toFixed(1)}σ
                      </Text>
                    </Box>
                  </Tooltip>
                </Box>
              </Box>
            );
          })()}
        </>
      )}

      {/* Expanded detail */}
      <Collapse in={expanded}>
        {metrics ? (
          <>
            <Grid mt="md" mb="xl">
              <Grid.Col span={{ base: 6, sm: 3 }}>
                <NumberInput
                  label="Initial Mult."
                  value={j}
                  onChange={setJ}
                  min={0.01}
                  step={0.1}
                  disabled={autoExecute}
                  error={jError}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 6, sm: 3 }}>
                <NumberInput
                  label="Step Drop Mult."
                  value={k}
                  onChange={setK}
                  min={0.01}
                  step={0.1}
                  disabled={autoExecute}
                  error={lastStepError}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 6, sm: 3 }}>
                <NumberInput
                  label="Max Steps"
                  value={maxSteps}
                  onChange={setMaxSteps}
                  min={1}
                  disabled={autoExecute}
                  error={lastStepError ? 'Reduce steps or k' : undefined}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 6, sm: 3 }}>
                <NumberInput
                  label="Amount ($)"
                  value={amount}
                  onChange={setAmount}
                  prefix="$"
                  min={1}
                  disabled={autoExecute}
                />
              </Grid.Col>
            </Grid>

            <Title order={5} mb="sm">Preview Steps</Title>
            <Table striped highlightOnHover fz={{ base: 'xs', sm: 'sm' }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Step</Table.Th>
                  <Table.Th>Buy</Table.Th>
                  <Table.Th>Sell</Table.Th>
                  <Table.Th>Shares</Table.Th>
                  <Table.Th visibleFrom="sm">Allocated</Table.Th>
                  <Table.Th>Profit</Table.Th>
                  <Table.Th></Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {steps.map((row) => (
                  <Table.Tr
                    key={row.step}
                    bg={row.isBought ? 'var(--mantine-color-blue-light)' : row.triggered ? 'var(--mantine-color-green-light)' : undefined}
                  >
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        {row.step}
                        <Box visibleFrom="sm">
                          {row.activeOrder ? (
                            <Badge size="xs" color="yellow" variant="filled">
                              {row.activeOrder.side === 'BUY' ? 'buying' : 'selling'}
                            </Badge>
                          ) : row.isBought ? (
                            <Badge size="xs" color="blue" variant="filled">held</Badge>
                          ) : row.triggered ? (
                            <Badge size="xs" color="green" variant="filled">hit</Badge>
                          ) : null}
                        </Box>
                      </Group>
                    </Table.Td>
                    <Table.Td c={row.isBought ? "blue" : "green"} fw={500}>${row.buyPrice}</Table.Td>
                    <Table.Td c="blue" fw={500}>${row.sellPrice}</Table.Td>
                    <Table.Td>{row.shares}</Table.Td>
                    <Table.Td visibleFrom="sm">${row.amount}</Table.Td>
                    <Table.Td c="teal" fw={500}>
                      ${row.estProfit}
                      <Text span size="xs" c="dimmed" ml={4} visibleFrom="sm">({row.estProfitPct}%)</Text>
                    </Table.Td>
                    <Table.Td>
                      {row.isBought && row.openTrade ? (
                        <ActionIcon variant="subtle" color="teal" onClick={() => setSellModal({
                          trade: row.openTrade!,
                          price: row.sellPrice,
                          date: todayStr(),
                        })} style={{ visibility: autoExecute ? 'hidden' : 'visible' }}>
                          <IconCurrencyDollar size={16} />
                        </ActionIcon>
                      ) : (
                        <ActionIcon variant="subtle" color="gray" onClick={() => setBuyModal({
                          step: row.step,
                          shares: row.shares,
                          price: row.buyPrice,
                          date: todayStr(),
                        })} style={{ visibility: autoExecute ? 'hidden' : 'visible' }}>
                          <IconEdit size={16} />
                        </ActionIcon>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>

            {/* Trade History & Order Activity */}
            {(closedTrades.length > 0 || orders.length > 0) && (
              <Divider my="lg" />
            )}

            {closedTrades.length > 0 && (
              <>
                <UnstyledButton onClick={() => setHistoryOpen(v => !v)} mb="xs">
                  <Group gap={6}>
                    <Title order={5}>
                      Trade History ({closedTrades.length})
                    </Title>
                    <Text span size="sm" fw={600} c={totalClosedPnl >= 0 ? 'teal' : 'red'}>
                      ${totalClosedPnl.toFixed(2)}
                    </Text>
                    {historyOpen ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
                  </Group>
                </UnstyledButton>
                <Collapse in={historyOpen}>
                  <Table striped highlightOnHover mb="md">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Step</Table.Th>
                        <Table.Th>Shares</Table.Th>
                        <Table.Th>Buy</Table.Th>
                        <Table.Th>Sell</Table.Th>
                        <Table.Th>P&L</Table.Th>
                        <Table.Th></Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {[...closedTrades].reverse().map(t => {
                        const pnl = (t.sellPrice! - t.buyPrice) * t.shares;
                        const pnlPct = ((t.sellPrice! / t.buyPrice) - 1) * 100;
                        return (
                          <Table.Tr key={t.id}>
                            <Table.Td>{t.step}</Table.Td>
                            <Table.Td>{t.shares.toFixed(4)}</Table.Td>
                            <Table.Td>
                              ${t.buyPrice.toFixed(2)}
                              {t.buyDate && <Text span size="xs" c="dimmed" ml={4}>{t.buyDate}</Text>}
                            </Table.Td>
                            <Table.Td>
                              ${t.sellPrice!.toFixed(2)}
                              {t.sellDate && <Text span size="xs" c="dimmed" ml={4}>{t.sellDate}</Text>}
                            </Table.Td>
                            <Table.Td c={pnl >= 0 ? 'teal' : 'red'} fw={500}>
                              ${pnl.toFixed(2)}
                              <Text span size="xs" c="dimmed" ml={4}>({pnlPct.toFixed(2)}%)</Text>
                            </Table.Td>
                            <Table.Td>
                              <ActionIcon variant="subtle" color="red" size="sm" onClick={() => setDeleteTradeId(t.id)}>
                                <IconTrash size={14} />
                              </ActionIcon>
                            </Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </Collapse>
              </>
            )}

            {orders.length > 0 && (
              <>
                <UnstyledButton onClick={() => setOrdersOpen(v => !v)} mb="xs">
                  <Group gap={6}>
                    <Title order={5}>Order Activity ({orders.length})</Title>
                    {ordersOpen ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
                  </Group>
                </UnstyledButton>
                <Collapse in={ordersOpen}>
                  <Table striped highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Step</Table.Th>
                        <Table.Th>Side</Table.Th>
                        <Table.Th>Qty</Table.Th>
                        <Table.Th>Limit</Table.Th>
                        <Table.Th>Filled</Table.Th>
                        <Table.Th>Status</Table.Th>
                        <Table.Th>Time</Table.Th>
                        <Table.Th></Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {orders.map(o => (
                        <Table.Tr key={o.id}>
                          <Table.Td>{o.step}</Table.Td>
                          <Table.Td>
                            <Badge size="xs" color={o.side === 'BUY' ? 'green' : 'red'} variant="light">
                              {o.side}
                            </Badge>
                          </Table.Td>
                          <Table.Td>{o.totalQty}</Table.Td>
                          <Table.Td>${o.limitPrice.toFixed(2)}</Table.Td>
                          <Table.Td>
                            {o.filledQty}/{o.totalQty}
                            {o.avgFillPrice && (
                              <Text span size="xs" c="dimmed" ml={4}>@ ${o.avgFillPrice.toFixed(2)}</Text>
                            )}
                          </Table.Td>
                          <Table.Td>
                            <Badge
                              size="xs"
                              variant="light"
                              color={
                                o.status === 'filled' ? 'teal' :
                                o.status === 'cancelled' ? 'gray' :
                                o.status === 'partial' ? 'yellow' :
                                'blue'
                              }
                            >
                              {o.status}
                            </Badge>
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" c="dimmed">
                              {new Date(o.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            {(o.status === 'filled' || o.status === 'cancelled') && (
                              <ActionIcon variant="subtle" color="red" size="sm" onClick={async () => {
                                await deleteOrder(o.id);
                                setOrders(prev => prev.filter(x => x.id !== o.id));
                              }}>
                                <IconTrash size={14} />
                              </ActionIcon>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Collapse>
              </>
            )}

          </>
        ) : (
          <Grid mt="md" gutter="xs">
            {[1, 2, 3].map(i => (
              <Grid.Col span={4} key={i}><Skeleton height={48} radius="sm" /></Grid.Col>
            ))}
          </Grid>
        )}
      </Collapse>

      {/* Buy Modal */}
      <Modal opened={!!buyModal} onClose={() => setBuyModal(null)} title={`Record Buy — Step ${buyModal?.step}`}>
        {buyModal && (
          <>
            <NumberInput
              label="Shares"
              value={buyModal.shares}
              onChange={(v) => setBuyModal(m => m ? { ...m, shares: v } : null)}
              mb="sm"
              min={0}
            />
            <NumberInput
              label="Buy Price"
              value={buyModal.price}
              onChange={(v) => setBuyModal(m => m ? { ...m, price: v } : null)}
              mb="sm"
              min={0}
              decimalScale={4}
              prefix="$"
            />
            <TextInput
              label="Date"
              type="date"
              value={buyModal.date}
              onChange={(e) => setBuyModal(m => m ? { ...m, date: e.target.value } : null)}
              mb="xl"
            />
            <Button fullWidth color="blue" onClick={handleSaveBuy}>
              Save Buy
            </Button>
          </>
        )}
      </Modal>

      {/* Sell Modal */}
      <Modal opened={!!sellModal} onClose={() => setSellModal(null)} title={`Close Trade — Step ${sellModal?.trade.step}`}>
        {sellModal && (
          <>
            <Text size="sm" c="dimmed" mb="md">
              Bought {sellModal.trade.shares.toFixed(4)} shares @ ${sellModal.trade.buyPrice.toFixed(2)}
              {sellModal.trade.buyDate && ` on ${sellModal.trade.buyDate}`}
            </Text>
            <NumberInput
              label="Sell Price"
              value={sellModal.price}
              onChange={(v) => setSellModal(m => m ? { ...m, price: v } : null)}
              mb="sm"
              min={0}
              decimalScale={4}
              prefix="$"
            />
            <TextInput
              label="Date"
              type="date"
              value={sellModal.date}
              onChange={(e) => setSellModal(m => m ? { ...m, date: e.target.value } : null)}
              mb="xl"
            />
            <Group grow>
              <Button color="teal" onClick={handleSaveSell}>
                Record Sale
              </Button>
              <Button color="red" variant="light" onClick={() => { setSellModal(null); setDeleteTradeId(sellModal.trade.id); }}>
                Delete Trade
              </Button>
            </Group>
          </>
        )}
      </Modal>
      {/* Delete Strategy Confirm */}
      <Modal opened={deleteConfirm} onClose={() => setDeleteConfirm(false)} title="Delete Strategy" size="sm">
        <Text mb="xl">Delete strategy for <Text span fw={700}>{strategy.symbol}</Text>? This will remove all trade records.</Text>
        <Group grow>
          <Button variant="default" onClick={() => setDeleteConfirm(false)}>Cancel</Button>
          <Button color="red" onClick={handleDelete}>Delete</Button>
        </Group>
      </Modal>

      {/* Delete Trade Confirm */}
      <Modal opened={!!deleteTradeId} onClose={() => setDeleteTradeId(null)} title="Delete Trade" size="sm">
        <Text mb="xl">Delete this trade record?</Text>
        <Group grow>
          <Button variant="default" onClick={() => setDeleteTradeId(null)}>Cancel</Button>
          <Button color="red" onClick={() => deleteTradeId && handleDeleteTrade(deleteTradeId)}>Delete</Button>
        </Group>
      </Modal>
    </Paper>
  );
}

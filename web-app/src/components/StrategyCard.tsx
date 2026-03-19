"use client";

import { useState, useEffect } from 'react';
import {
  Paper, Title, Text, Group, Grid, Switch, Badge, Table,
  ActionIcon, NumberInput, Button, Collapse, UnstyledButton, Skeleton, Modal,
} from '@mantine/core';
import { IconTrash, IconChevronDown, IconChevronUp, IconEdit } from '@tabler/icons-react';
import { updateStrategy, deleteStrategy, getStrategyPreviewData } from '@/app/actions';
import { Strategy } from '@prisma/client';

interface Metrics {
  sma200: number;
  dailyVolatility: number;
  latestPrice: number;
  lastDate: string;
}

interface StrategyCardProps {
  strategy: Strategy;
  metrics: Metrics | null;
  onUpdate: () => void;
}

export default function StrategyCard({ strategy, metrics: metricsProp, onUpdate }: StrategyCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [metrics, setMetrics] = useState<Metrics | null>(metricsProp);
  const [metricsLoading, setMetricsLoading] = useState(!metricsProp);

  const [executions, setExecutions] = useState<any[]>(() => {
    try {
      return JSON.parse((strategy as any).executions || "[]");
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      setExecutions(JSON.parse((strategy as any).executions || "[]"));
    } catch {
      setExecutions([]);
    }
  }, [strategy.id, (strategy as any).executions]);
  
  const [execModal, setExecModal] = useState<{ step: number; shares: number | string; price: number | string } | null>(null);

  const handleSaveExecution = async () => {
    if (!execModal) return;
    const newExecs = [...executions];
    const idx = newExecs.findIndex(e => e.step === execModal.step);
    const payload = { step: execModal.step, shares: Number(execModal.shares), price: Number(execModal.price) };
    if (idx >= 0) newExecs[idx] = payload;
    else newExecs.push(payload);
    
    setExecutions(newExecs);
    setExecModal(null);
    await updateStrategy(strategy.id, { executions: JSON.stringify(newExecs) });
    onUpdate();
  };

  const handleClearExecution = async () => {
    if (!execModal) return;
    const newExecs = executions.filter(e => e.step !== execModal.step);
    
    setExecutions(newExecs);
    setExecModal(null);
    await updateStrategy(strategy.id, { executions: JSON.stringify(newExecs) });
    onUpdate();
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
    await updateStrategy(strategy.id, { autoExecute: !strategy.autoExecute });
    onUpdate();
  };

  const handleDelete = async () => {
    await deleteStrategy(strategy.id);
    onUpdate();
  };

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
      const sellPrice = metrics.sma200 * (1 - prevMultiplier * metrics.dailyVolatility);
      const triggered = metrics.latestPrice > 0 && metrics.latestPrice <= theoBuyPrice;

      const exec = executions.find(e => e.step === stepNum);
      const isBought = !!exec;

      const buyPrice = exec && exec.price > 0 ? exec.price : theoBuyPrice;
      const shares = exec && exec.shares > 0 ? exec.shares : (_amount / theoBuyPrice);
      const costBasis = exec && exec.shares > 0 && exec.price > 0 ? (exec.price * exec.shares) : _amount;

      const estProfit = shares * (sellPrice - buyPrice);
      const estProfitPct = (estProfit / costBasis) * 100;

      steps.push({
        step: stepNum,
        buyPrice: buyPrice.toFixed(2),
        sellPrice: sellPrice.toFixed(2),
        shares: shares.toFixed(4),
        amount: costBasis.toFixed(2),
        estProfit: estProfit.toFixed(2),
        estProfitPct: estProfitPct.toFixed(2),
        triggered,
        isBought,
      });
    }
    return steps;
  };

  const steps = generatePreviewSteps();
  const triggeredCount = steps.filter(s => s.triggered).length;
  const ratio = metrics && metrics.sma200 > 0 ? metrics.latestPrice / metrics.sma200 : null;

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
    <Paper shadow="sm" radius="md" p="xl" className="glass-card" mb="lg">
      {/* Header row — always visible */}
      <Group justify="space-between" mb={expanded ? 'md' : 0}>
        <UnstyledButton onClick={() => setExpanded(v => !v)} style={{ flex: 1 }}>
          <Group>
            <Title order={3}>{strategy.symbol}</Title>
            <Badge color={strategy.autoExecute ? 'green' : 'gray'}>
              {strategy.autoExecute ? 'Auto Active' : 'Manual'}
            </Badge>
            {expanded ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
          </Group>
        </UnstyledButton>
        <Group>
          <Switch
            label="Auto Execute"
            checked={strategy.autoExecute}
            onChange={toggleAutoExecute}
            color="teal"
          />
          <ActionIcon color="red" variant="subtle" onClick={handleDelete}>
            <IconTrash size={18} />
          </ActionIcon>
        </Group>
      </Group>

      {/* Collapsed summary — show when not expanded */}
      {!expanded && metrics && (
        <>
          <Grid mt="sm" align="center">
            <Grid.Col span={3}>
              <Text size="xs" c="dimmed">SMA 200</Text>
              <Text fw={600}>${metrics.sma200.toFixed(2)}</Text>
            </Grid.Col>
            <Grid.Col span={3}>
              <Text size="xs" c="dimmed">Latest Price</Text>
              <Text fw={600} c={metrics.latestPrice < metrics.sma200 ? 'red' : 'teal'}>
                ${metrics.latestPrice.toFixed(2)}
                {ratio !== null && (
                  <Text span size="xs" c="dimmed" ml={4}>
                    ({ratio >= 1 ? '+' : ''}{((ratio - 1) * 100).toFixed(1)}%)
                  </Text>
                )}
              </Text>
            </Grid.Col>
            <Grid.Col span={3}>
              <Text size="xs" c="dimmed">Daily Volatility (σ)</Text>
              <Text fw={600}>{(metrics.dailyVolatility * 100).toFixed(2)}%</Text>
            </Grid.Col>
            <Grid.Col span={3}>
              <Text size="xs" c="dimmed">Steps Reached</Text>
              <Text fw={600} c={triggeredCount > 0 ? 'orange' : 'dimmed'}>
                {triggeredCount} / {strategy.maxSteps}
              </Text>
            </Grid.Col>
          </Grid>
          <Text size="xs" c="dimmed" mt={4}>Data as of {metrics.lastDate}</Text>
        </>
      )}

      {/* Expanded detail */}
      <Collapse in={expanded}>
        {metrics ? (
          <>
            <Grid align="flex-end" mb="lg" mt="md">
              <Grid.Col span={4}>
                <Text size="sm" c="dimmed">SMA 200</Text>
                <Text fw={700} size="xl">${metrics.sma200.toFixed(2)}</Text>
              </Grid.Col>
              <Grid.Col span={4}>
                <Text size="sm" c="dimmed">Latest Price</Text>
                <Text fw={700} size="xl" c={metrics.latestPrice < metrics.sma200 ? 'red' : 'teal'}>
                  ${metrics.latestPrice.toFixed(2)}
                </Text>
              </Grid.Col>
              <Grid.Col span={4}>
                <Text size="sm" c="dimmed">Daily Volatility (σ)</Text>
                <Text fw={700} size="xl">{(metrics.dailyVolatility * 100).toFixed(2)}%</Text>
              </Grid.Col>
            </Grid>
            <Text size="xs" c="dimmed" mb="md">Data as of {metrics.lastDate}</Text>

            <Title order={6} mb="sm" c="dimmed">Live Parameters</Title>
            {strategy.autoExecute && (
              <Text size="xs" c="orange" mb="sm">⚠ Parameters are locked while Auto Execute is active.</Text>
            )}
            <Grid mb="xl">
              <Grid.Col span={3}>
                <NumberInput
                  label="Initial Multiplier"
                  value={j}
                  onChange={setJ}
                  min={0.01}
                  step={0.1}
                  disabled={strategy.autoExecute}
                  error={jError}
                />
              </Grid.Col>
              <Grid.Col span={3}>
                <NumberInput
                  label="Step Drop Multiplier"
                  value={k}
                  onChange={setK}
                  min={0.01}
                  step={0.1}
                  disabled={strategy.autoExecute}
                  error={lastStepError}
                />
              </Grid.Col>
              <Grid.Col span={3}>
                <NumberInput
                  label="Max Steps"
                  value={maxSteps}
                  onChange={setMaxSteps}
                  min={1}
                  disabled={strategy.autoExecute}
                  error={lastStepError ? 'Reduce steps or k' : undefined}
                />
              </Grid.Col>
              <Grid.Col span={3}>
                <NumberInput
                  label="Amount ($)"
                  value={amount}
                  onChange={setAmount}
                  prefix="$"
                  min={1}
                  disabled={strategy.autoExecute}
                />
              </Grid.Col>
            </Grid>

            <Title order={5} mb="sm">Preview Steps</Title>
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Step</Table.Th>
                  <Table.Th>Buy Limit</Table.Th>
                  <Table.Th>Take Profit</Table.Th>
                  <Table.Th>Est. Shares</Table.Th>
                  <Table.Th>Allocated</Table.Th>
                  <Table.Th>Est. Profit</Table.Th>
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
                      <Group gap={6}>
                        {row.step}
                        {row.isBought ? (
                          <Badge size="xs" color="blue" variant="filled">bought</Badge>
                        ) : row.triggered ? (
                          <Badge size="xs" color="green" variant="filled">triggered</Badge>
                        ) : null}
                      </Group>
                    </Table.Td>
                    <Table.Td c={row.isBought ? "blue" : "green"} fw={500}>${row.buyPrice}</Table.Td>
                    <Table.Td c="blue" fw={500}>${row.sellPrice}</Table.Td>
                    <Table.Td>{row.shares}</Table.Td>
                    <Table.Td>${row.amount}</Table.Td>
                    <Table.Td c="teal" fw={500}>
                      ${row.estProfit}
                      <Text span size="xs" c="dimmed" ml={4}>({row.estProfitPct}%)</Text>
                    </Table.Td>
                    <Table.Td>
                      <ActionIcon variant="subtle" color="gray" onClick={() => setExecModal({ step: row.step, shares: row.shares, price: row.buyPrice })}>
                        <IconEdit size={16} />
                      </ActionIcon>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>

            {!strategy.autoExecute && (
              <Button mt="lg" fullWidth color="teal" variant="light" onClick={() => alert('Execute simulated!')}>
                Execute Now
              </Button>
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

      <Modal opened={!!execModal} onClose={() => setExecModal(null)} title={`Record Trade for Step ${execModal?.step}`}>
        <NumberInput
          label="Shares Bought"
          value={execModal?.shares}
          onChange={(v) => setExecModal(m => m ? { ...m, shares: v } : null)}
          mb="sm"
          min={0}
        />
        <NumberInput
          label="Average Price"
          value={execModal?.price}
          onChange={(v) => setExecModal(m => m ? { ...m, price: v } : null)}
          mb="xl"
          min={0}
          decimalScale={4}
          prefix="$"
        />
        <Group grow>
          <Button color="blue" onClick={handleSaveExecution}>
            Save Execution
          </Button>
          {executions.some(e => e.step === execModal?.step) && (
            <Button color="red" variant="light" onClick={handleClearExecution}>
              Clear
            </Button>
          )}
        </Group>
      </Modal>
    </Paper>
  );
}

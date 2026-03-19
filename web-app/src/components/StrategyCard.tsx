"use client";

import { useState, useEffect } from 'react';
import {
  Paper, Title, Text, Group, Grid, Switch, Badge, Table,
  ActionIcon, NumberInput, Button, Collapse, UnstyledButton, Skeleton, Modal,
  TextInput, Divider,
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
      const shares = openTrade ? openTrade.shares : (_amount / theoBuyPrice);
      const costBasis = openTrade ? (openTrade.buyPrice * openTrade.shares) : _amount;

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
        shares: shares.toFixed(4),
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
  const triggeredCount = steps.filter(s => s.triggered).length;
  const boughtCount = steps.filter(s => s.isBought).length;
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
      <Group justify="space-between">
        <UnstyledButton onClick={() => setExpanded(v => !v)} style={{ flex: 1 }}>
          <Group>
            <Title order={3}>{strategy.symbol}</Title>
            <Badge color={autoExecute ? 'green' : 'gray'}>
              {autoExecute ? 'Auto Active' : 'Manual'}
            </Badge>
            {expanded ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
          </Group>
        </UnstyledButton>
        <Group>
          <Switch
            label="Auto Execute"
            checked={autoExecute}
            onChange={toggleAutoExecute}
            color="teal"
          />
          <ActionIcon color="red" variant="subtle" onClick={() => setDeleteConfirm(true)}>
            <IconTrash size={18} />
          </ActionIcon>
        </Group>
      </Group>

      {/* Metrics summary — always visible */}
      {metrics && (
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
            <Grid.Col span={1.5}>
              <Text size="xs" c="dimmed">Reached</Text>
              <Text fw={600} c={triggeredCount > 0 ? 'orange' : 'dimmed'}>
                {triggeredCount} / {maxSteps}
              </Text>
            </Grid.Col>
            <Grid.Col span={1.5}>
              <Text size="xs" c="dimmed">Bought</Text>
              <Text fw={600} c={boughtCount > 0 ? 'blue' : 'dimmed'}>
                {boughtCount} / {maxSteps}
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
            <Title order={6} mt="md" mb="sm" c="dimmed">Live Parameters</Title>
            {autoExecute && (
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
                  disabled={autoExecute}
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
                  disabled={autoExecute}
                  error={lastStepError}
                />
              </Grid.Col>
              <Grid.Col span={3}>
                <NumberInput
                  label="Max Steps"
                  value={maxSteps}
                  onChange={setMaxSteps}
                  min={1}
                  disabled={autoExecute}
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
                  disabled={autoExecute}
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
                        {row.activeOrder ? (
                          <Badge size="xs" color="yellow" variant="filled">
                            {row.activeOrder.side === 'BUY' ? 'buying' : 'selling'}
                            {row.activeOrder.filledQty > 0 && ` ${row.activeOrder.filledQty}/${row.activeOrder.totalQty}`}
                          </Badge>
                        ) : row.isBought ? (
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
                      {!autoExecute && (
                        row.isBought && row.openTrade ? (
                          <ActionIcon variant="subtle" color="teal" onClick={() => setSellModal({
                            trade: row.openTrade!,
                            price: row.sellPrice,
                            date: todayStr(),
                          })}>
                            <IconCurrencyDollar size={16} />
                          </ActionIcon>
                        ) : (
                          <ActionIcon variant="subtle" color="gray" onClick={() => setBuyModal({
                            step: row.step,
                            shares: row.shares,
                            price: row.buyPrice,
                            date: todayStr(),
                          })}>
                            <IconEdit size={16} />
                          </ActionIcon>
                        )
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

            {!autoExecute && (
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

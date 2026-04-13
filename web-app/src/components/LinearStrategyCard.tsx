"use client";

import { useState } from "react";
import { LinearStrategy, LinearLot } from "@prisma/client";
import { Card, Text, Group, Switch, Badge, Progress, Button, Modal, NumberInput, ActionIcon, Stack, Tabs, Table } from "@mantine/core";
import { IconSettings, IconTrash, IconListDetails } from "@tabler/icons-react";
import { updateLinearStrategy, deleteLinearStrategy } from "@/app/actions-v2";

type StrategyWithLots = LinearStrategy & { lots: LinearLot[], trades: any[] };

export function LinearStrategyCard({ strategy }: { strategy: StrategyWithLots }) {
  const [opened, setOpened] = useState(false);
  const [ledgerOpened, setLedgerOpened] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [form, setForm] = useState({
    bandLo: strategy.bandLo,
    bandHi: strategy.bandHi,
    maxBudget: strategy.maxBudget,
    minTradeAmount: strategy.minTradeAmount,
  });

  const currentShares = strategy.lots.reduce((acc: number, lot: any) => acc + lot.shares, 0);
  const invested = strategy.lots.reduce((acc: number, lot: any) => acc + lot.shares * lot.price, 0);
  const budgetUsedPct = (invested / strategy.maxBudget) * 100;
  
  const realizedPnl = strategy.trades ? strategy.trades.reduce((acc: number, t: any) => acc + (t.pnl || 0), 0) : 0;
  const unrealizedPnl = strategy.lots.reduce((acc: number, l: any) => acc + ((strategy.latestPrice || l.price) - l.price) * l.shares, 0);
  const pricePctChange = strategy.latestPrice && strategy.sma200 ? ((strategy.latestPrice - strategy.sma200) / strategy.sma200) * 100 : 0;

  // Derived metrics
  const bandLoPrice = strategy.sma200 && strategy.dailyVolatility 
    ? strategy.sma200 - (strategy.bandLo * strategy.sma200 * strategy.dailyVolatility) 
    : 0;
  const bandHiPrice = strategy.sma200 && strategy.dailyVolatility 
    ? strategy.sma200 - (strategy.bandHi * strategy.sma200 * strategy.dailyVolatility) 
    : 0;
  
  const currentSigma = strategy.latestPrice && strategy.sma200 && strategy.dailyVolatility
    ? (strategy.sma200 - strategy.latestPrice) / (strategy.sma200 * strategy.dailyVolatility)
    : 0;

  // Target Shares Math
  let targetShares = 0;
  let unclampedTargetShares = 0;
  if (strategy.latestPrice) {
    const progress = (currentSigma - strategy.bandLo) / (strategy.bandHi - strategy.bandLo);
    const linearTargetValue = strategy.maxBudget * progress;
    unclampedTargetShares = Math.round(linearTargetValue / strategy.latestPrice);

    if (currentSigma >= strategy.bandHi) {
      targetShares = Math.round(strategy.maxBudget / strategy.latestPrice);
    } else if (currentSigma <= strategy.bandLo) {
      targetShares = 0;
    } else {
      targetShares = unclampedTargetShares;
    }
  }

  const sharesDelta = targetShares - currentShares;
  const unclampedDelta = unclampedTargetShares - currentShares;
  const tradeThreshold = strategy.latestPrice ? Math.max(1, Math.ceil(strategy.minTradeAmount / strategy.latestPrice)) : 0;
  const sameDirection = (sharesDelta > 0 && unclampedDelta > 0) || (sharesDelta < 0 && unclampedDelta < 0);
  let isActionable = Math.abs(unclampedDelta) >= tradeThreshold && sharesDelta !== 0 && sameDirection;
  const isBuyPosture = sharesDelta > 0;

  // LIFO Cost Basis Math for Sells — skip unprofitable lots, allow partial sells
  let lifoBlockerPrice: number | null = null;
  let isLifoBlocked = false;
  let isLifoPartial = false;
  let profitableSellQty = 0;
  if (!isBuyPosture && currentShares > 0) {
      const sharesToEvaluateForSell = isActionable ? Math.abs(sharesDelta) : tradeThreshold;
      // Sort by cost ascending — sell cheapest (most profitable) first
      const sortedLots = [...strategy.lots].sort((a, b) => a.price - b.price);

      let remaining = sharesToEvaluateForSell;
      let highestProfitableBasis = 0;
      for (const lot of sortedLots) {
          if (remaining <= 0) break;
          if (strategy.latestPrice! < lot.price) break; // ascending — all remaining are worse
          const take = Math.min(lot.shares, remaining);
          profitableSellQty += take;
          highestProfitableBasis = lot.price; // ascending, last taken is max
          remaining -= take;
      }
      lifoBlockerPrice = highestProfitableBasis > 0 ? highestProfitableBasis : null;

      if (isActionable && profitableSellQty < Math.abs(sharesDelta)) {
          if (profitableSellQty >= tradeThreshold) {
              // Partial sell: only the profitable lots
              isLifoPartial = true;
          } else {
              // Not enough profitable shares to meet min trade
              isActionable = false;
              isLifoBlocked = true;
          }
      }
  }

  // Exact target price prediction helper
  const calculatePriceForShares = (sReq: number) => {
    if (!strategy.sma200 || !strategy.dailyVolatility || strategy.maxBudget <= 0) return null;
    const M = strategy.maxBudget;
    const S200 = strategy.sma200;
    const vol = strategy.dailyVolatility;
    const L = strategy.bandLo;
    const H = strategy.bandHi;

    const numerator = M * S200 * (1 - L * vol);
    const denominator = sReq * (H - L) * S200 * vol + M;
    if (denominator === 0) return null;
    return numerator / denominator;
  };

  // If LIFO blocked, we technically target the original targetShares mathematically
  let awaitingShares = isLifoBlocked 
      ? targetShares 
      : (isBuyPosture || sharesDelta === 0) ? currentShares + tradeThreshold : Math.max(0, currentShares - tradeThreshold);
      
  const crossoverTarget = (isBuyPosture || sharesDelta === 0) ? Math.max(0, awaitingShares - 0.5) : awaitingShares + 0.5;
  let awaitingPrice = calculatePriceForShares(crossoverTarget);
  let isAwaitingLifoFloor = false;

  if (!isBuyPosture && lifoBlockerPrice !== null) {
      // If math suggests we cross at $500, but LIFO blocks until $510, we must await $510!
      if (!awaitingPrice || lifoBlockerPrice > awaitingPrice) {
          awaitingPrice = lifoBlockerPrice;
          isAwaitingLifoFloor = true;
      }
  }

  // Visual Gauge Math
  const visualMin = Math.min(currentSigma, strategy.bandLo);
  const visualMax = Math.max(currentSigma, strategy.bandHi);
  const range = (visualMax - visualMin) || 1; 
  const minScale = visualMin - (range * 0.10); // 10% buffer
  const maxScale = visualMax + (range * 0.15); // 15% right buffer to ensure labels don't get chopped off edge
  
  const pct = (sigma: number) => Math.max(0, Math.min(100, ((sigma - minScale) / (maxScale - minScale)) * 100));

  const bandLeftPct = pct(strategy.bandLo);
  const bandRightPct = pct(strategy.bandHi);
  const bandWidthPct = Math.max(0, bandRightPct - bandLeftPct);
  const indicatorPercent = pct(currentSigma);

  // Candlestick Wick Math (Day High / Day Low)
  let wickLeftPct: number | null = null;
  let wickRightPct: number | null = null;
  
  if (strategy.sma200 && strategy.dailyVolatility && strategy.dayHigh && strategy.dayLow) {
    // Highest price = lowest sigma (leftmost)
    const dayHighSigma = (strategy.sma200 - strategy.dayHigh) / (strategy.sma200 * strategy.dailyVolatility);
    // Lowest price = highest sigma (rightmost)
    const dayLowSigma = (strategy.sma200 - strategy.dayLow) / (strategy.sma200 * strategy.dailyVolatility);
    
    wickLeftPct = pct(dayHighSigma);
    wickRightPct = pct(dayLowSigma);
  }

  const handleToggle = async (val: boolean) => {
    setIsUpdating(true);
    await updateLinearStrategy(strategy.id, { autoExecute: val });
    setIsUpdating(false);
  };

  const handleSave = async () => {
    setIsUpdating(true);
    await updateLinearStrategy(strategy.id, form);
    setOpened(false);
    setIsUpdating(false);
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    await deleteLinearStrategy(strategy.id);
  };

  return (
    <>
      <Card shadow="sm" padding="lg" radius="md" withBorder style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'rgba(255, 255, 255, 0.03)', backdropFilter: 'blur(10px)', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
        <Group justify="space-between" mb="xs">
          <Group gap="xs">
            <Text fw={700} size="xl">{strategy.symbol}</Text>
            {strategy.autoExecute ? (
              <Badge color="green" variant="light">Active</Badge>
            ) : (
              <Badge color="gray" variant="light">Paused</Badge>
            )}
          </Group>
          <Group gap="sm">
            <ActionIcon variant="subtle" color="gray" onClick={() => setOpened(true)} disabled={strategy.autoExecute}>
              <IconSettings size={18} />
            </ActionIcon>
            <Switch 
              checked={strategy.autoExecute} 
              onChange={(e) => handleToggle(e.currentTarget.checked)} 
              disabled={isUpdating}
              color="teal"
            />
          </Group>
        </Group>

        <Text size="sm" c="dimmed" mb="md">
          Band: {strategy.bandLo}σ - {strategy.bandHi}σ • Min Trade: ${strategy.minTradeAmount.toLocaleString()}
        </Text>

        <Group grow mb="md" mt="xs">
          <div>
            <Text size="xs" c="dimmed">SMA 100</Text>
            <Text size="sm" fw={600}>{strategy.sma100 ? `$${strategy.sma100.toFixed(2)}` : '--'}</Text>
          </div>
          <div>
            <Text size="xs" c="dimmed">SMA 200</Text>
            <Text size="sm" fw={600}>{strategy.sma200 ? `$${strategy.sma200.toFixed(2)}` : '--'}</Text>
          </div>
          <div>
            <Text size="xs" c="dimmed">SMA 300</Text>
            <Text size="sm" fw={600}>{strategy.sma300 ? `$${strategy.sma300.toFixed(2)}` : '--'}</Text>
          </div>
          <div>
            <Text size="xs" c="dimmed">Daily Vol (σ)</Text>
            <Text size="sm" fw={600}>{strategy.dailyVolatility ? `${(strategy.dailyVolatility * 100).toFixed(2)}%` : '--'}</Text>
          </div>
        </Group>

        {/* PRICE BAND GAUGE */}
        <div style={{ position: 'relative', height: '60px', marginBottom: '1.5rem', marginTop: '1.5rem', display: 'flex', alignItems: 'center' }}>
          <div style={{ position: 'relative', width: '100%', height: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px' }}>
            
            {/* The active band background */}
            <div style={{ position: 'absolute', left: `${bandLeftPct}%`, top: 0, bottom: 0, width: `${bandWidthPct}%`, background: 'rgba(51, 154, 240, 0.15)', borderRadius: '4px' }} />
            
            {/* The Daily Volatility Candlestick Wick */}
            {wickLeftPct !== null && wickRightPct !== null && (
               <div style={{
                  position: 'absolute',
                  left: `${wickLeftPct}%`,
                  width: `${Math.max(0, wickRightPct - wickLeftPct)}%`,
                  top: '3px',
                  height: '2px',
                  background: 'rgba(255, 255, 255, 0.4)',
                  zIndex: 2,
               }}>
                  {/* Left tick cap */}
                  <div style={{ position: 'absolute', left: 0, top: '-3px', bottom: '-3px', width: '2px', background: 'rgba(255, 255, 255, 0.6)' }} />
                  {/* Right tick cap */}
                  <div style={{ position: 'absolute', right: 0, top: '-3px', bottom: '-3px', width: '2px', background: 'rgba(255, 255, 255, 0.6)' }} />
               </div>
            )}
            
            {/* Collision Logic for Labels */
             (() => {
               const isNearLo = Math.abs(indicatorPercent - bandLeftPct) < 18;
               const isNearHi = Math.abs(indicatorPercent - (bandLeftPct + bandWidthPct)) < 18;
               const alignLabel = (pct: number) => pct < 10 ? '0' : pct > 90 ? '-100%' : '-50%';

               return (
                 <>
                  {/* === BAND LOW MARKERS === */}
                  <div style={{ position: 'absolute', left: `${bandLeftPct}%`, top: '-4px', bottom: '-4px', width: '2px', background: 'rgba(255,255,255,0.2)' }} />
                  <div style={{ position: 'absolute', left: `${bandLeftPct}%`, top: isNearLo ? '-34px' : '-20px', transform: `translateX(${alignLabel(bandLeftPct)})`, whiteSpace: 'nowrap', transition: 'top 0.2s' }}>
                    <Text size="10px" c="dimmed" fw={600}>${bandLoPrice.toFixed(0)}</Text>
                  </div>
                  <div style={{ position: 'absolute', left: `${bandLeftPct}%`, bottom: isNearLo ? '-32px' : '-18px', transform: `translateX(${alignLabel(bandLeftPct)})`, whiteSpace: 'nowrap', transition: 'bottom 0.2s' }}>
                    <Text size="10px" c="dimmed" fw={600}>{strategy.bandLo === 0 ? 0 : -strategy.bandLo}σ</Text>
                  </div>

                  {/* === BAND HIGH MARKERS === */}
                  <div style={{ position: 'absolute', left: `${bandLeftPct + bandWidthPct}%`, top: '-4px', bottom: '-4px', width: '2px', background: 'rgba(255,255,255,0.2)' }} />
                  <div style={{ position: 'absolute', left: `${bandLeftPct + bandWidthPct}%`, top: isNearHi ? '-34px' : '-20px', transform: `translateX(${alignLabel(bandLeftPct + bandWidthPct)})`, whiteSpace: 'nowrap', transition: 'top 0.2s' }}>
                    <Text size="10px" c="dimmed" fw={600}>${bandHiPrice.toFixed(0)}</Text>
                  </div>
                  <div style={{ position: 'absolute', left: `${bandLeftPct + bandWidthPct}%`, bottom: isNearHi ? '-32px' : '-18px', transform: `translateX(${alignLabel(bandLeftPct + bandWidthPct)})`, whiteSpace: 'nowrap', transition: 'bottom 0.2s' }}>
                    <Text size="10px" c="dimmed" fw={600}>{strategy.bandHi === 0 ? 0 : -strategy.bandHi}σ</Text>
                  </div>

                  {/* === CURRENT MARKER === */}
                  {strategy.latestPrice && (
                    <>
                      <div style={{ 
                        position: 'absolute', 
                        left: `${indicatorPercent}%`, 
                        top: '-4px', 
                        width: '16px', 
                        height: '16px', 
                        background: currentSigma < strategy.bandLo || currentSigma > strategy.bandHi ? '#f59f00' : '#339af0', 
                        borderRadius: '50%', 
                        transform: 'translateX(-50%)',
                        boxShadow: currentSigma < strategy.bandLo || currentSigma > strategy.bandHi ? '0 0 10px rgba(245, 159, 0, 0.5)' : '0 0 10px rgba(51, 154, 240, 0.5)',
                        zIndex: 3
                      }} />
                      <div style={{ position: 'absolute', left: `${indicatorPercent}%`, top: '-22px', transform: `translateX(${alignLabel(indicatorPercent)})`, zIndex: 4, whiteSpace: 'nowrap' }}>
                        <Text size="11px" fw={800} c={currentSigma < strategy.bandLo || currentSigma > strategy.bandHi ? 'orange' : 'blue'}>${strategy.latestPrice.toFixed(2)}</Text>
                      </div>
                      <div style={{ position: 'absolute', left: `${indicatorPercent}%`, bottom: '-20px', transform: `translateX(${alignLabel(indicatorPercent)})`, zIndex: 4, whiteSpace: 'nowrap' }}>
                        <Text size="11px" fw={800} c={currentSigma < strategy.bandLo || currentSigma > strategy.bandHi ? 'orange' : 'blue'}>{(Math.abs(currentSigma) < 0.05 ? 0 : -currentSigma).toFixed(1)}σ</Text>
                      </div>
                    </>
                  )}
                 </>
               );
             })()
            }
          </div>
        </div>

        <div style={{ flex: 1, background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.04)', marginTop: '20px' }}>
          <Group justify="space-between" mb={10}>
            <Text size="sm" c="dimmed">Shares</Text>
            <Text size="sm" fw={500}>
              <span style={{ fontWeight: 800 }}>{currentShares}</span> 
              {currentShares !== targetShares || currentShares === 0 ? (
                <>
                  <span style={{ color: 'rgba(255,255,255,0.5)', margin: '0 6px' }}>→</span>
                  <span style={{ fontWeight: 800 }}>{isActionable ? targetShares : <>{targetShares}<span style={{ color: 'rgba(255,255,255,0.5)', margin: '0 6px' }}>→</span>{awaitingShares}</>}</span>
                  {isActionable && Math.abs(sharesDelta) < tradeThreshold && Math.abs(unclampedDelta) >= tradeThreshold && (
                    <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '11px', marginLeft: '4px' }}>[unc {unclampedTargetShares}]</span>
                  )}
                  <span style={{ color: isActionable ? (sharesDelta > 0 ? '#4caf50' : '#f44336') : 'rgba(255,255,255,0.4)', marginLeft: '8px' }}>
                    ({isActionable
                      ? isLifoPartial
                        ? `Sell ${profitableSellQty} of ${Math.abs(sharesDelta)} (${Math.abs(sharesDelta) - profitableSellQty} LIFO skip)`
                        : `${sharesDelta > 0 ? 'Buy' : 'Sell'} ${Math.abs(sharesDelta)}`
                      : `Awaiting ${awaitingPrice ? '$' + awaitingPrice.toFixed(2) : '--'}${isAwaitingLifoFloor ? ' (LIFO)' : ''}`})
                  </span>
                </>
              ) : (
                 <span style={{ color: 'rgba(255,255,255,0.4)', marginLeft: '8px' }}>(On Target)</span>
              )}
            </Text>
          </Group>

          <Group justify="space-between" mb={10}>
            <Text size="sm" c="dimmed">Allocated</Text>
            <Text size="sm" fw={600}>${invested.toLocaleString(undefined, {maximumFractionDigits:0})} <span style={{ color: 'rgba(255,255,255,0.3)', margin: '0 2px' }}>/</span> ${strategy.maxBudget.toLocaleString(undefined, {maximumFractionDigits:0})}</Text>
          </Group>

          <Group justify="space-between" mb={10}>
            <Text size="sm" c="dimmed">Realized</Text>
            <Text size="sm" fw={600} c={realizedPnl >= 0 ? 'green' : 'red'}>{realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2)}</Text>
          </Group>
          
          <Group justify="space-between">
            <Text size="sm" c="dimmed">Unrealized</Text>
            <Text size="sm" fw={600} c={unrealizedPnl >= 0 ? 'green' : 'red'}>{unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)}</Text>
          </Group>
        </div>

        <Button 
          variant="light" 
          color="gray" 
          fullWidth 
          mt="md" 
          leftSection={<IconListDetails size={16} />}
          onClick={() => setLedgerOpened(true)}
        >
          View Ledger
        </Button>
      </Card>

      <Modal opened={ledgerOpened} onClose={() => setLedgerOpened(false)} title={`${strategy.symbol} Ledger`} size="xl">
        <Tabs defaultValue="lots">
          <Tabs.List>
            <Tabs.Tab value="lots">Open Lots ({strategy.lots.length})</Tabs.Tab>
            <Tabs.Tab value="trades">Trade History ({strategy.trades?.length || 0})</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="lots" pt="xs">
            {strategy.lots.length === 0 ? (
              <Text c="dimmed" fs="italic" mt="md" size="sm">No open lots.</Text>
            ) : (
              <Table striped highlightOnHover mt="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Date</Table.Th>
                    <Table.Th>Days</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Price</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Shares</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Cost</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Unrealized</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>%</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {strategy.lots.map(lot => {
                    const cost = lot.shares * lot.price;
                    const lotUnrealized = strategy.latestPrice ? (strategy.latestPrice - lot.price) * lot.shares : 0;
                    const lotUnrealizedPct = strategy.latestPrice ? ((strategy.latestPrice - lot.price) / lot.price) * 100 : 0;
                    const daysHeld = Math.floor((Date.now() - new Date(lot.createdAt).getTime()) / (1000 * 60 * 60 * 24));
                    return (
                      <Table.Tr key={lot.id}>
                        <Table.Td>{new Date(lot.createdAt).toLocaleDateString()}</Table.Td>
                        <Table.Td>{daysHeld}</Table.Td>
                        <Table.Td style={{ textAlign: 'right' }}>${lot.price.toFixed(2)}</Table.Td>
                        <Table.Td style={{ textAlign: 'right' }}>{lot.shares}</Table.Td>
                        <Table.Td style={{ textAlign: 'right' }}>${cost.toFixed(2)}</Table.Td>
                        <Table.Td style={{ textAlign: 'right' }}>
                          <Text size="sm" fw={600} c={lotUnrealized >= 0 ? 'green' : 'red'} span>
                            {lotUnrealized >= 0 ? '+' : ''}${lotUnrealized.toFixed(2)}
                          </Text>
                        </Table.Td>
                        <Table.Td style={{ textAlign: 'right' }}>
                          <Text size="sm" c={lotUnrealizedPct >= 0 ? 'green' : 'red'} span>
                            {lotUnrealizedPct >= 0 ? '+' : ''}{lotUnrealizedPct.toFixed(1)}%
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
                <Table.Tfoot>
                  <Table.Tr style={{ borderTop: '2px solid rgba(255,255,255,0.15)' }}>
                    <Table.Td colSpan={3} style={{ fontWeight: 700 }}>Total</Table.Td>
                    <Table.Td style={{ textAlign: 'right', fontWeight: 700 }}>{currentShares}</Table.Td>
                    <Table.Td style={{ textAlign: 'right', fontWeight: 700 }}>${invested.toFixed(2)}</Table.Td>
                    <Table.Td style={{ textAlign: 'right' }}>
                      <Text size="sm" fw={700} c={unrealizedPnl >= 0 ? 'green' : 'red'} span>
                        {unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)}
                      </Text>
                    </Table.Td>
                    <Table.Td style={{ textAlign: 'right' }}>
                      <Text size="sm" fw={700} c={unrealizedPnl >= 0 ? 'green' : 'red'} span>
                        {invested > 0 ? `${unrealizedPnl >= 0 ? '+' : ''}${((unrealizedPnl / invested) * 100).toFixed(1)}%` : '--'}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                </Table.Tfoot>
              </Table>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="trades" pt="xs">
            {(!strategy.trades || strategy.trades.length === 0) ? (
              <Text c="dimmed" fs="italic" mt="md" size="sm">No trade history.</Text>
            ) : (
              <Table striped highlightOnHover mt="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Date</Table.Th>
                    <Table.Th>Action</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Sigma</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Price</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Shares</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Total</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Basis</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>PnL</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {strategy.trades.slice().reverse().map((t: any) => (
                    <Table.Tr key={t.id}>
                      <Table.Td>{new Date(t.createdAt).toLocaleDateString()}</Table.Td>
                      <Table.Td>
                        <Badge color={t.action === 'BUY' ? 'blue' : 'gray'} variant="light">{t.action}</Badge>
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}>
                        {t.sigmaBelow != null ? `${t.sigmaBelow.toFixed(1)}σ` : '--'}
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}>${t.price.toFixed(2)}</Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}>{t.shares}</Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}>${(t.price * t.shares).toFixed(2)}</Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}>
                        {t.costBasis != null ? `$${t.costBasis.toFixed(2)}` : '--'}
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}>
                        {t.pnl != null ? (
                          <Text c={t.pnl >= 0 ? 'green' : 'red'} size="sm" fw={600} span>
                            {t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(2)}
                          </Text>
                        ) : '--'}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
                <Table.Tfoot>
                  <Table.Tr style={{ borderTop: '2px solid rgba(255,255,255,0.15)' }}>
                    <Table.Td colSpan={7} style={{ fontWeight: 700 }}>Total Realized</Table.Td>
                    <Table.Td style={{ textAlign: 'right' }}>
                      <Text size="sm" fw={700} c={realizedPnl >= 0 ? 'green' : 'red'} span>
                        {realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2)}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                </Table.Tfoot>
              </Table>
            )}
          </Tabs.Panel>
        </Tabs>
      </Modal>

      <Modal opened={opened} onClose={() => setOpened(false)} title={`Configure ${strategy.symbol}`} centered>
        <Stack>
          <NumberInput 
            label="Band Low (σ)" 
            value={form.bandLo} 
            onChange={(v) => setForm({...form, bandLo: Number(v) || form.bandLo})} 
            step={0.5}
          />
          <NumberInput 
            label="Band High (σ)" 
            value={form.bandHi} 
            onChange={(v) => setForm({...form, bandHi: Number(v) || form.bandHi})} 
            step={0.5}
          />
          <NumberInput 
            label="Max Budget ($)" 
            value={form.maxBudget} 
            onChange={(v) => setForm({...form, maxBudget: Number(v) || form.maxBudget})} 
            step={1000}
            leftSection="$"
          />
          <NumberInput 
            label="Min Trade Amount ($)" 
            value={form.minTradeAmount} 
            onChange={(v) => setForm({...form, minTradeAmount: Number(v) || form.minTradeAmount})} 
            step={100}
            leftSection="$"
          />
          <Group justify="space-between" mt="md">
            <Button color="red" variant="outline" onClick={handleDelete} loading={isDeleting}>
              <IconTrash size={16} /> Delete
            </Button>
            <Button onClick={handleSave} loading={isUpdating} color="blue">
              Save Changes
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

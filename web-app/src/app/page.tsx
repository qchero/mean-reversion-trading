import { LinearStrategyCard } from "@/components/LinearStrategyCard";
import { getLinearStrategies, getEngineHeartbeatV2 } from "./actions-v2";
import { Container, Title, SimpleGrid, Paper, Text } from "@mantine/core";
import { NewStrategyModal } from "@/components/NewStrategyModal";
import { LogoutButton } from "@/components/LogoutButton";
import { EngineStatus } from "@/components/EngineStatus";
import { DailyChart } from "@/components/DailyChart";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

// Opt out of caching so we see DB state instantly
export const revalidate = 0;

export default async function V2Dashboard() {
  const session = await auth();
  if (!session) {
    redirect("/api/auth/signin");
  }

  const [strategies, heartbeat] = await Promise.all([
    getLinearStrategies(),
    getEngineHeartbeatV2(),
  ]);
  
  const totalUnrealized = strategies.reduce((sum: number, s: any) => sum + s.lots.reduce((acc: number, l: any) => acc + ((s.latestPrice || l.price) - l.price) * l.shares, 0), 0);

  // Average Capital Deployed: replay ALL strategies on a single shared timeline
  const todayET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const todayStr = `${todayET.getFullYear()}-${String(todayET.getMonth() + 1).padStart(2, '0')}-${String(todayET.getDate()).padStart(2, '0')}`;

  // Build per-strategy trade maps and find the global first trade date
  let globalFirstDate: string | null = null;
  const strategyTradeMaps: Map<string, { action: string; shares: number; price: number; pnl: number | null }[]>[] = [];
  for (const s of strategies) {
    const trades = (s.trades || []).slice().sort((a: any, b: any) => a.date.localeCompare(b.date));
    const tradesByDate = new Map<string, { action: string; shares: number; price: number; pnl: number | null }[]>();
    for (const t of trades) {
      const list = tradesByDate.get(t.date) || [];
      list.push(t);
      tradesByDate.set(t.date, list);
    }
    strategyTradeMaps.push(tradesByDate);
    if (trades.length > 0 && (!globalFirstDate || trades[0].date < globalFirstDate)) {
      globalFirstDate = trades[0].date;
    }
  }

  let totalCapitalDays = 0;
  let totalDays = 0;
  const dailySnapshots: { date: string; capitalDeployed: number; realizedPnl: number; marginInterest: number }[] = [];
  if (globalFirstDate) {
    const stratLots: { shares: number; price: number }[][] = strategies.map(() => []);
    let cumulativeRealizedPnl = 0;
    let cumulativeMarginInterest = 0;
    let d = new Date(globalFirstDate + 'T12:00:00');
    const end = new Date(todayStr + 'T12:00:00');
    while (d <= end) {
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      let dayCapital = 0;
      for (let i = 0; i < strategies.length; i++) {
        const dayTrades = strategyTradeMaps[i].get(dateStr) || [];
        for (const t of dayTrades) {
          if (t.action === 'BUY') {
            stratLots[i].push({ shares: t.shares, price: t.price });
          } else {
            stratLots[i].sort((a, b) => a.price - b.price);
            let remaining = t.shares;
            stratLots[i] = stratLots[i].filter(lot => {
              if (remaining <= 0) return true;
              if (lot.shares <= remaining) { remaining -= lot.shares; return false; }
              lot.shares -= remaining; remaining = 0; return true;
            });
          }
          if (t.pnl) cumulativeRealizedPnl += t.pnl;
        }
        dayCapital += stratLots[i].reduce((acc, l) => acc + l.shares * l.price, 0);
      }
      cumulativeMarginInterest += dayCapital * 0.05 / 360;
      dailySnapshots.push({
        date: dateStr,
        capitalDeployed: Math.round(dayCapital),
        realizedPnl: Math.round(cumulativeRealizedPnl * 100) / 100,
        marginInterest: Math.round(cumulativeMarginInterest * 100) / 100,
      });
      totalCapitalDays += dayCapital;
      totalDays++;
      d.setDate(d.getDate() + 1);
    }
  }
  const avgCapitalDeployed = totalDays > 0 ? totalCapitalDays / totalDays : 0;

  return (
    <Container size="xl" py="xl">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <Title order={1} style={{ fontWeight: 900, letterSpacing: '-0.02em', background: 'linear-gradient(45deg, #eee, #aaa)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Linear Engine
          </Title>
          <Text c="dimmed" size="sm">Automated position scaling & mean reversion</Text>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <EngineStatus heartbeat={heartbeat} />
          <NewStrategyModal />
          <LogoutButton />
        </div>
      </div>

      {dailySnapshots.length > 0 && (
        <Paper p="xs" radius="md" mb="xl" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
          <Text c="dimmed" size="xs" tt="uppercase" fw={700} ta="center" mt={4}>Capital Deployed & P&L</Text>
          <DailyChart data={dailySnapshots} avgCapitalDeployed={Math.round(avgCapitalDeployed)} unrealizedPnl={Math.round(totalUnrealized * 100) / 100} />
        </Paper>
      )}

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="lg">
        {strategies.map(s => (
          <LinearStrategyCard key={s.id} strategy={s} />
        ))}
      </SimpleGrid>
      
      {strategies.length === 0 && (
        <Paper p="xl" style={{ textAlign: 'center', background: 'transparent' }}>
          <Text c="dimmed">No strategies configured yet. Click "Add Strategy" to get started.</Text>
        </Paper>
      )}
    </Container>
  );
}

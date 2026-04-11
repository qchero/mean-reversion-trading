import { LinearStrategyCard } from "@/components/LinearStrategyCard";
import { getLinearStrategies, getEngineHeartbeatV2 } from "./actions-v2";
import { Container, Title, SimpleGrid, Paper, Text } from "@mantine/core";
import { NewStrategyModal } from "@/components/NewStrategyModal";
import { LogoutButton } from "@/components/LogoutButton";
import { EngineStatus } from "@/components/EngineStatus";
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
  
  const totalInvested = strategies.reduce((sum: number, s: any) => sum + s.lots.reduce((acc: number, lot: any) => acc + lot.shares * lot.price, 0), 0);
  const totalBudget = strategies.reduce((sum: number, s: any) => sum + s.maxBudget, 0);

  const totalRealized = strategies.reduce((sum: number, s: any) => sum + (s.trades ? s.trades.reduce((acc: number, t: any) => acc + (t.pnl || 0), 0) : 0), 0);
  const totalUnrealized = strategies.reduce((sum: number, s: any) => sum + s.lots.reduce((acc: number, l: any) => acc + ((s.latestPrice || l.price) - l.price) * l.shares, 0), 0);

  return (
    <Container size="xl" py="xl">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <Title order={1} style={{ fontWeight: 900, letterSpacing: '-0.02em', background: 'linear-gradient(45deg, #eee, #aaa)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Linear Engine
          </Title>
          <Text c="dimmed" size="sm">Automated position scaling & mean reversion</Text>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <EngineStatus heartbeat={heartbeat} />
          <NewStrategyModal />
          <LogoutButton />
        </div>
      </div>

      <Paper p="md" radius="md" mb="xl" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ display: 'flex', gap: '2rem' }}>
          <div>
            <Text c="dimmed" size="xs" tt="uppercase" fw={700}>Total Capital Deployed</Text>
            <Text fw={700} size="xl">${totalInvested.toLocaleString('en-US', {maximumFractionDigits:0})}</Text>
          </div>
          <div>
            <Text c="dimmed" size="xs" tt="uppercase" fw={700}>Total Capital Configured</Text>
            <Text fw={700} size="xl">${totalBudget.toLocaleString('en-US', {maximumFractionDigits:0})}</Text>
          </div>
          <div>
            <Text c="dimmed" size="xs" tt="uppercase" fw={700}>Realized P&L</Text>
            <Text fw={700} size="xl" c={totalRealized >= 0 ? 'green' : 'red'}>
              {totalRealized >= 0 ? '+' : ''}${totalRealized.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}
            </Text>
          </div>
          <div>
            <Text c="dimmed" size="xs" tt="uppercase" fw={700}>Unrealized P&L</Text>
            <Text fw={700} size="xl" c={totalUnrealized >= 0 ? 'green' : 'red'}>
              {totalUnrealized >= 0 ? '+' : ''}${totalUnrealized.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}
            </Text>
          </div>
        </div>
      </Paper>

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

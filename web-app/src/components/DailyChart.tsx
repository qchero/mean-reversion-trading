"use client";

import { useState } from "react";
import { Paper, Text, UnstyledButton } from "@mantine/core";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

type Snapshot = { date: string; capitalDeployed: number; realizedPnl: number };

export function DailyChartToggle({ data }: { data: Snapshot[] }) {
  const [open, setOpen] = useState(false);
  if (data.length === 0) return null;

  return (
    <Paper p="md" radius="md" mb="xl" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
      <UnstyledButton onClick={() => setOpen(!open)} style={{ width: '100%' }}>
        <Text c="dimmed" size="xs" tt="uppercase" fw={700}>
          {open ? '▾' : '▸'} Daily Capital Deployed & Realized P&L
        </Text>
      </UnstyledButton>
      {open && (
        <div style={{ marginTop: 12, width: '100%' }}>
          <DailyChart data={data} />
        </div>
      )}
    </Paper>
  );
}

export function DailyChart({ data }: { data: Snapshot[] }) {
  if (data.length === 0) return null;

  const formatDate = (d: string) => {
    const [, m, day] = d.split("-");
    return `${parseInt(m)}/${parseInt(day)}`;
  };

  const formatDollar = (v: number) =>
    `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis
          dataKey="date"
          tickFormatter={formatDate}
          tick={{ fill: "#888", fontSize: 11 }}
          axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
        />
        <YAxis
          yAxisId="left"
          tickFormatter={formatDollar}
          tick={{ fill: "#888", fontSize: 11 }}
          axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
          width={80}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tickFormatter={formatDollar}
          tick={{ fill: "#888", fontSize: 11 }}
          axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
          width={80}
        />
        <Tooltip
          contentStyle={{
            background: "rgba(30,30,30,0.95)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8,
            fontSize: 12,
          }}
          labelFormatter={(label) => formatDate(String(label))}
          formatter={(value, name) => [
            formatDollar(Number(value)),
            String(name),
          ]}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, color: "#aaa" }}
        />
        <Area
          yAxisId="left"
          type="stepAfter"
          dataKey="capitalDeployed"
          name="Capital Deployed"
          stroke="#4dabf7"
          fill="rgba(77,171,247,0.15)"
          strokeWidth={2}
        />
        <Line
          yAxisId="right"
          type="stepAfter"
          dataKey="realizedPnl"
          name="Realized P&L"
          stroke="#51cf66"
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

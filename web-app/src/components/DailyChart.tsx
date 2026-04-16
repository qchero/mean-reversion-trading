"use client";

import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from "recharts";

type Snapshot = { date: string; capitalDeployed: number; realizedPnl: number; marginInterest: number; unrealizedPnl?: number };

interface ChartProps {
  data: Snapshot[];
  avgCapitalDeployed?: number;
  unrealizedPnl?: number;
}

const formatDollar = (v: number) =>
  `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export function DailyChart({ data, avgCapitalDeployed, unrealizedPnl }: ChartProps) {
  if (data.length === 0) return null;

  const formatDate = (d: string) => {
    const [, m, day] = d.split("-");
    return `${parseInt(m)}/${parseInt(day)}`;
  };

  const chartData = data.map((d, i) =>
    i === data.length - 1 && unrealizedPnl != null
      ? { ...d, unrealizedPnl }
      : d
  );

  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
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
          width={72}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tickFormatter={formatDollar}
          tick={{ fill: "#888", fontSize: 11 }}
          axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
          width={72}
        />
        <Tooltip
          contentStyle={{
            background: "rgba(30,30,30,0.95)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8,
            fontSize: 12,
          }}
          labelFormatter={(label) => formatDate(String(label))}
          formatter={(value, name) => {
            const num = Number(value);
            if (isNaN(num)) return [null, null];
            return [formatDollar(num), String(name)];
          }}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, color: "#aaa" }}
        />
        {avgCapitalDeployed != null && (
          <ReferenceLine
            yAxisId="left"
            y={avgCapitalDeployed}
            stroke="#4dabf7"
            strokeDasharray="6 4"
            strokeOpacity={0.5}
            label={{ value: `Avg: ${formatDollar(avgCapitalDeployed)}`, fill: '#4dabf7', fontSize: 10, position: 'insideTopLeft' }}
          />
        )}
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
        <Line
          yAxisId="right"
          type="stepAfter"
          dataKey="marginInterest"
          name="Margin Interest"
          stroke="#ff6b6b"
          strokeWidth={2}
          dot={false}
        />
        <Scatter
          yAxisId="right"
          dataKey="unrealizedPnl"
          name="Unrealized P&L"
          fill="#da77f2"
          shape="diamond"
          legendType="diamond"
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

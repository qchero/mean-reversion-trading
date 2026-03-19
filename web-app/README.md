# Mean Reversion Trading Dashboard

A Next.js web app for designing, monitoring, and auto-executing volatility-scaled mean reversion strategies on US equities via Interactive Brokers.

## How It Works

The strategy buys when a stock drops far enough below its 200-day SMA, measured in units of daily volatility (sigma). It sells when price recovers one step up.

**Parameters per strategy:**
- **Symbol** — ticker (e.g. AAPL, TSLA)
- **j (Initial Multiplier)** — first buy level = `SMA200 * (1 - j * sigma)`
- **k (Step Drop Multiplier)** — spacing between levels = `k * sigma`
- **Max Steps** — number of buy levels
- **Step Amount ($)** — capital per buy step

**Example:** j=6, k=1.5, 4 steps on a stock with SMA=$200, sigma=1.5%
- Step 1 buy at $200 * (1 - 6*0.015) = $182.00, sell at $200 * (1 - 4.5*0.015) = $186.50
- Step 2 buy at $200 * (1 - 7.5*0.015) = $177.50, sell at $182.00
- ...and so on

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, Server Actions) |
| UI | Mantine v8 + Tabler Icons |
| ORM | Prisma 6 |
| Database | Supabase Postgres (cloud) |
| Market Data | Polygon.io REST API (daily candles + snapshots) |
| Broker | Interactive Brokers TWS API via `@stoqey/ib` |
| Language | TypeScript (strict) |

## Quick Start

```bash
cd web-app
cp .env.example .env        # Add POLYGON_API_KEY and DATABASE_URL
npm install
npx prisma db push           # Sync schema to database
npm run dev                   # http://localhost:3000
```

## Auto-Trading

The trading engine runs as a separate process alongside the web server, connecting to IB Gateway via the TWS API.

```bash
# Live trading (connects to IB Gateway on port 4001)
npm run trade

# Simulation mode (connects to IB Gateway paper account, manual price injection via stdin)
npm run trade:sim
```

### Simulate mode commands

```
AAPL 170 171    Set bid=170 ask=171 for AAPL (triggers buy/sell check)
AAPL 170        Shorthand (bid=ask)
reload          Reload strategies from DB (picks up auto-execute changes)
help            Show all commands
```

### How it works

1. Engine loads all strategies with Auto Execute enabled
2. Subscribes to real-time market data (live mode) or accepts manual price injection (simulate mode)
3. When ask <= step buy price → places market order (whole shares)
4. When bid >= step sell price → places market order to close position
5. On fill, records a Trade in the database
6. Ticker is locked while an order is pending (no duplicate orders)
7. On restart, reconciles pending orders with IBKR

### Prerequisites

1. IB Gateway running with API enabled (port 4001)
2. At least one strategy with "Auto Execute" toggled on in the dashboard

## Project Structure

```
web-app/
├── prisma/
│   └── schema.prisma          # Strategy, Trade, Order, DailyCandle, SymbolCache
├── src/
│   ├── app/
│   │   ├── page.tsx           # Dashboard — strategy list sorted by price/SMA ratio
│   │   ├── actions.ts         # Server actions: CRUD strategies/trades/orders, fetch metrics
│   │   ├── layout.tsx         # Mantine provider, notifications, theme config
│   │   └── globals.css        # Dark/light mode, glass-card styles
│   ├── components/
│   │   ├── StrategyForm.tsx   # New strategy form (symbol, j, k, steps, amount)
│   │   └── StrategyCard.tsx   # Strategy card: metrics, live params, step table, trade/order history
│   ├── trading/
│   │   ├── run.ts             # Entry point: CLI args, connects to IBKR, starts engine
│   │   ├── engine.ts          # Trading logic: price monitoring, order placement, trade recording
│   │   ├── ibkr.ts            # IBKR TWS API wrapper: connection, market data, orders
│   │   └── sim-repl.ts        # Simulate mode stdin REPL for price injection
│   └── lib/
│       ├── polygon.ts         # Polygon API: fetch candles, cache, SMA/sigma calc, snapshots
│       └── prisma.ts          # Prisma singleton client
├── prisma.config.ts           # Prisma datasource config
├── package.json
└── DEVELOPMENT.md             # Architecture deep-dive
```

## Related: Python Backtesting Engine

The `analysis/` directory contains a Python backtesting engine used for parameter sweep research.

**Key finding from backtesting:** `j=6sigma, k=1.5sigma` dominates across most configurations, yielding ~37-41% annualized ROC over the 2022-2026 period with sufficient trade frequency.

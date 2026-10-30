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
| Market Data | Yahoo Finance via `yahoo-finance2` (daily history + live quotes) |
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

The trading engines run as separate processes alongside the web server. Prices come from Yahoo (`src/trading/quotes.ts`: the most recent of the pre-market / regular / post-market prices); IB Gateway is only used to place orders and receive fills, so no IBKR market data subscription is needed.

```bash
# Linear strategy engine (v2) — live, places real orders via IB Gateway on port 4001
npm run trade

# v2 simulation mode — manual price injection via stdin REPL
npm run trade:sim

# QuantGT monthly rebalancer — see src/trading/qt/SPEC.md
npm run qt
npm run qt:sim
```

### Simulate mode commands (`trade:sim`)

```
AAPL 170          Set price → evaluate → simulate fill if actionable
preview AAPL      Preview evaluation using last set price (dry run)
order AAPL        Place a REAL LOC order via IBKR using last set price
list              Show all active strategies and positions
reload            Reload strategies from DB
help              Show all commands
```

### How v2 works

1. Engine loads Linear strategies from the DB every 60s (15 min while the market is closed)
2. Each tick polls Yahoo for every strategy's latest price (live mode) or uses REPL-injected prices (simulate mode)
3. Target shares scale linearly with how far price is below SMA200 (in σ, between the strategy's band)
4. Once daily at 15:48 ET: buys go out as Market-on-Close, sells as Limit-on-Close just above (+0.1%) the sold lots' max cost basis (no-loss rule)
5. On fill, records the trade + lots in the database (fills that can't be written are journaled to `unrecorded-fills.jsonl`)

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
│   │   ├── ibkr.ts            # IBKR TWS API wrapper: connection, reconnect, orders, fill callbacks
│   │   ├── quotes.ts          # Yahoo quotes (pre / regular / post-market) shared by v2, qt and the UI
│   │   ├── v2/                # Linear strategy engine (`npm run trade`)
│   │   └── qt/                # QuantGT monthly rebalancer (`npm run qt`)
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

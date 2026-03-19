# Mean Reversion Trading Dashboard

A Next.js web app for designing, monitoring, and (soon) auto-executing volatility-scaled mean reversion strategies on US equities.

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
| Database | SQLite (local) — migrating to cloud Postgres |
| Market Data | Polygon.io REST API (daily candles + snapshots) |
| Language | TypeScript (strict) |

## Quick Start

```bash
cd web-app
cp .env.example .env        # Add your POLYGON_API_KEY
npm install
npx prisma db push           # Create/sync SQLite database
npm run dev                   # http://localhost:3000
```

## Project Structure

```
web-app/
├── prisma/
│   └── schema.prisma          # Strategy, DailyCandle, SymbolCache models
├── src/
│   ├── app/
│   │   ├── page.tsx           # Dashboard — strategy list sorted by price/SMA ratio
│   │   ├── actions.ts         # Server actions: CRUD strategies, fetch metrics
│   │   ├── layout.tsx         # Mantine provider, theme config
│   │   └── globals.css        # Dark/light mode, glass-card styles
│   ├── components/
│   │   ├── StrategyForm.tsx   # New strategy form (symbol, j, k, steps, amount)
│   │   └── StrategyCard.tsx   # Strategy card: metrics, live params, step table, trade recording
│   └── lib/
│       ├── polygon.ts         # Polygon API: fetch candles, cache, SMA/sigma calc, snapshots
│       └── prisma.ts          # Prisma singleton client
├── prisma.config.ts           # Prisma datasource config
├── package.json
└── DEVELOPMENT.md             # Architecture deep-dive and roadmap
```

## Related: Python Backtesting Engine

The `analysis/` directory contains a Python backtesting engine used for parameter sweep research:

```
analysis/
├── config.py          # Tickers, default params (j, k, levels, budget)
├── data.py            # Polygon 15-min bar fetcher with parquet cache
├── strategy.py        # Volatility-scaled simulation (15-min resolution)
├── backtest.py        # Performance summary metrics
├── main.py            # Run single-config sim across all tickers
├── sweep_vol.py       # Parameter sweep (parallel, sorted by P&L or ROC)
├── sweep_yearly.py    # Yearly sweep with per-ticker detail + min-ops constraint
├── plot.py            # Matplotlib visualization
├── sweep_plan.md      # Sweep methodology and results (Rounds 1-4)
└── sweep_results_*.md # Detailed per-ticker per-year results
```

**Key finding from backtesting:** `j=6sigma, k=1.5sigma` dominates across most configurations, yielding ~37-41% annualized ROC over the 2022-2026 period with sufficient trade frequency.

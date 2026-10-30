# Development Guide

## Architecture Overview

```
Browser (React/Mantine)
   │
   │  Server Actions (actions.ts)
   │    ├── createStrategy / updateStrategy / deleteStrategy
   │    ├── getStrategies / getBatchPreviewData / getAllTrades
   │    ├── createTrade / updateTrade / deleteTrade
   │    └── getStrategyOrders / deleteOrder / getRecentOrderEvents
   │
   ▼
Polygon.io API                    Prisma ORM (Supabase Postgres)
   │                                 │
   ├── Daily candles (/v2/aggs)      ├── Strategy      — user configs
   └── Snapshot (/v2/snapshot)       ├── Trade         — buy/sell positions (manual + auto)
                                     ├── Order         — IBKR order activity log
                                     ├── DailyCandle   — cached OHLCV (symbol+date unique)
                                     └── SymbolCache   — SMA200, sigma, latest price per symbol

Trading engines (separate processes: v2 `npm run trade`, qt `npm run qt`)
   │
   ├── Yahoo quotes (quotes.ts) — polled each tick (live) / injectPrice (v2 simulate)
   │
   │  @stoqey/ib (TWS API)
   │    ├── placeMOCOrder / placeLOCOrder (v2), placeMOOOrder (qt)
   │    └── orderStatus callbacks
   │
   ▼
IB Gateway (port 4001)
```

### Data Flow

1. **Strategy creation:** User submits form → `createStrategy` → fetches/caches candles from Polygon → saves Strategy row
2. **Dashboard load:** `getStrategies` + `getBatchPreviewData` + `getAllTrades` in parallel → single DB query each → passed as props to cards
3. **Live price:** `getLatestPrice` fetches Polygon snapshot (cached 60s via Next.js `revalidate`)
4. **Parameter editing:** Debounced (1s) auto-save via `updateStrategy` — no page reload needed. Locked when Auto Execute is on.
5. **Manual trade recording:** Buy/sell modals in StrategyCard → `createTrade` / `updateTrade` → Trade table. Disabled when Auto Execute is on.
6. **Auto trading:** v2 engine polls Yahoo prices → places MOC/LOC orders once daily at 15:48 ET → IBKR fills → trade + lots written to LinearTrade / LinearLot
7. **Order notifications:** Dashboard polls `getRecentOrderEvents` every 5s → toast notifications for fills/cancels

### Key Math (polygon.ts)

```
SMA200         = mean(last 200 daily closes)
Daily sigma    = stddev(last 200 daily % changes)
Buy price[i]   = SMA200 * (1 - (j + i*k) * sigma)
Sell price[i]  = SMA200 * (1 - (j + (i-1)*k) * sigma)
```

### Trading Day Logic

The system determines the latest finalized trading day based on Eastern Time:
- Weekday after 5pm ET → today (data finalized after market close + 1hr buffer)
- Weekday before 5pm ET → previous trading day
- Weekend → most recent Friday
- This logic is duplicated in `polygon.ts:getOrFetchHistoricalData()` and `actions.ts:getStrategyPreviewData()` — keep in sync

---

## Database

**Provider:** Supabase Postgres (cloud-hosted)

**Models:**
- **Strategy** — symbol, parameters (j, k, maxSteps, stepAmount), autoExecute flag
- **Trade** — step positions: strategyId, step, shares, buyPrice, buyDate, sellPrice?, sellDate?
- **Order** — IBKR order log: strategyId, step, side, ibkrOrderId, status, limitPrice, totalQty, filledQty, avgFillPrice
- **DailyCandle** — cached OHLCV data per symbol+date
- **SymbolCache** — pre-calculated SMA200/sigma/latestPrice per symbol

When modifying `prisma/schema.prisma`:
1. Edit the schema
2. Push changes: `npx prisma db push`
3. **Restart the Next.js dev server** — critical due to HMR caching the old Prisma Client types

---

## Trading Engine

The engines (`src/trading/`) run as standalone Node.js processes sharing the same database. Prices come
from Yahoo; IBKR is only used for order placement and fill callbacks (no market data subscription).

### Components

| File | Purpose |
|------|---------|
| `quotes.ts` | Batched Yahoo quotes; picks the most recent of the pre-market / regular / post-market prices. Shared by v2, qt and the web app (`getLatestPrice`). |
| `ibkr.ts` | TWS API wrapper. Socket connection + auto-reconnect, MOC / LOC / MOO order placement, order status callbacks. |
| `v2/run.ts` | v2 entry point. Parses CLI args, connects IBKRClient, starts engine. `--simulate` enables the price injection REPL. |
| `v2/engine.ts` | Linear strategy engine. Reloads strategies every 60s, polls prices each tick, places orders once daily at 15:48 ET, records fills. |
| `v2/sim-repl.ts` | Stdin REPL for simulate mode. Injects prices into the engine. |
| `qt/` | QuantGT monthly rebalancer — see `qt/SPEC.md`. |

### Tick evaluation logging (v2)

Every tick logs one line per auto-execute strategy, including which session the price came from:
```
  GOOGL $  287.40 regular |   7.83σ |   0→ 40 ( +40) | BUY 40
```

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | Supabase Postgres connection string | Yes |
| `POLYGON_API_KEY` | Polygon.io API key for market data | Yes |

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `prisma/schema.prisma` | Database models (Strategy, Trade, Order, DailyCandle, SymbolCache) |
| `src/app/actions.ts` | All server actions (CRUD + data fetching) |
| `src/lib/polygon.ts` | Polygon API integration, caching, SMA/sigma math |
| `src/lib/prisma.ts` | Prisma client singleton (avoids connection leaks in dev) |
| `src/app/page.tsx` | Dashboard page — batch loads strategies, metrics, trades |
| `src/components/StrategyCard.tsx` | Strategy detail card with live params, step preview, trade/order history |
| `src/components/StrategyForm.tsx` | New strategy creation form |
| `src/trading/quotes.ts` | Yahoo pre / regular / post-market quotes |
| `src/trading/ibkr.ts` | IBKR TWS API connection wrapper (orders + fills) |
| `src/trading/v2/` | Linear strategy engine (`npm run trade`, `npm run trade:sim`) |
| `src/trading/qt/` | QuantGT monthly rebalancer (`npm run qt`, `npm run qt:sim`) |

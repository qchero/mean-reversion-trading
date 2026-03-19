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

Trading Engine (separate process)
   │
   │  @stoqey/ib (TWS API)
   │    ├── subscribeMarketData (live) / injectTick (simulate)
   │    ├── placeMarketOrder
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
6. **Auto trading:** Engine monitors prices → places market orders → IBKR fills → `recordTrade` writes to Trade table
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

The engine (`src/trading/`) runs as a standalone Node.js process sharing the same database.

### Components

| File | Purpose |
|------|---------|
| `run.ts` | Entry point. Parses CLI args, connects IBKRClient, starts engine. `--simulate` enables price injection REPL. |
| `engine.ts` | Core logic. Loads auto-execute strategies every 60s, evaluates ticks, places orders, records trades. |
| `ibkr.ts` | TWS API wrapper. Socket connection, market data streaming, market order placement, order status callbacks, error→cancel propagation. |
| `sim-repl.ts` | Stdin REPL for simulate mode. Injects ticks into the engine. |

### Order lifecycle

1. Price crosses threshold → engine places market order via IBKR
2. Ticker is locked (no duplicate orders for same symbol)
3. IBKR fills → `handleOrderStatus` fires → DB Order updated → Trade recorded → ticker unlocked
4. IBKR error/reject → treated as cancellation → ticker unlocked
5. On engine restart → reconciles pending DB orders with IBKR via `reqAllOpenOrders`; orphaned orders marked cancelled after 5s

### Tick evaluation logging

Every tick logs detailed evaluation for each step:
```
[Tick] AAPL bid=$172.50 ask=$172.55 | SMA200=$178.30 σ=1.42%
  Step 1: BUY  target=$160.58 ask=$172.55 gap=$11.97
  Step 2: BUY  target=$155.52 ask=$172.55 gap=$17.03
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
| `src/trading/engine.ts` | Auto-trading engine with market orders |
| `src/trading/ibkr.ts` | IBKR TWS API connection wrapper |
| `src/trading/run.ts` | Trading engine entry point (live + simulate modes) |
| `src/trading/sim-repl.ts` | Simulate mode price injection REPL |

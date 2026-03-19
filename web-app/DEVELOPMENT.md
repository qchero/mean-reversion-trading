# Development Guide

## Architecture Overview

```
Browser (React/Mantine)
   │
   │  Server Actions (actions.ts)
   │    ├── createStrategy / updateStrategy / deleteStrategy
   │    ├── getStrategies
   │    └── getStrategyPreviewData  ← fast-path: SymbolCache hit
   │
   ▼
Polygon.io API                    Prisma ORM (SQLite)
   │                                 │
   ├── Daily candles (/v2/aggs)      ├── Strategy      — user configs + execution records
   └── Snapshot (/v2/snapshot)       ├── DailyCandle   — cached OHLCV (symbol+date unique)
                                     └── SymbolCache   — SMA200, sigma, latest price per symbol
```

### Data Flow

1. **Strategy creation:** User submits form → `createStrategy` server action → fetches/caches candles from Polygon → saves Strategy row
2. **Dashboard load:** `getStrategies` returns all strategies → `getStrategyPreviewData` called per symbol → hits `SymbolCache` (fast path) or recalculates from candles → returns SMA200, sigma, latest price
3. **Live price:** `getLatestPrice` fetches Polygon snapshot (cached 60s via Next.js `revalidate`)
4. **Parameter editing:** Debounced (1s) auto-save via `updateStrategy` — no page reload needed
5. **Trade recording:** Manual entry via edit icon per step → stored as JSON in `Strategy.executions`

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

## Database & Prisma Workflow

When modifying `prisma/schema.prisma`:

1. Edit the schema
2. Push changes: `npx prisma db push`
3. **Restart the Next.js dev server** — critical due to HMR caching the old Prisma Client types. Without restart, you get `PrismaClientValidationError: Unknown argument`

---

## Roadmap

### 1. Cloud Database (Postgres)

**Goal:** Replace local SQLite with cloud-hosted Postgres so the localhost web app works across devices without losing data.

**Current state:**
- SQLite file at `prisma/dev.db` (gitignored)
- Prisma schema uses `provider = "sqlite"` and `url = env("DATABASE_URL")` with value `"file:./dev.db"`
- `prisma.config.ts` reads `DATABASE_URL` from `.env`

**Migration plan:**
1. **Provision a Postgres instance** — options:
   - [Supabase](https://supabase.com) (free tier: 500MB, 2 projects) — simplest, direct Postgres connection string
   - [Neon](https://neon.tech) (free tier: 512MB, serverless) — branching support, good for dev/prod split
   - [Railway](https://railway.app) (free trial, then $5/mo) — simplest provisioning
   - [Vercel Postgres](https://vercel.com/storage/postgres) (if deploying to Vercel later)
2. **Update Prisma schema:**
   ```prisma
   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
   }
   ```
3. **Update `.env`:**
   ```
   DATABASE_URL="postgresql://user:pass@host:5432/dbname?sslmode=require"
   ```
4. **Generate migration:** `npx prisma migrate dev --name init`
5. **Seed existing data** (if any local strategies worth preserving)

**Schema considerations for Postgres:**
- No changes needed to models — Prisma handles SQLite → Postgres type mapping
- `Float` maps to `double precision`, `String` to `text`, `DateTime` to `timestamp(3)`
- `@@unique([symbol, date])` on DailyCandle works identically
- The `cuid()` default IDs work on both

**Performance note:** The SymbolCache fast-path is even more important with a remote DB to minimize round trips. Consider adding connection pooling (PgBouncer or Prisma Accelerate) if latency is noticeable.

---

### 2. IBKR Integration (Interactive Brokers API)

**Goal:** Connect the "Auto Execute" toggle to real order placement via Interactive Brokers, turning the dashboard from a visualizer into an automated trading system.

**Current state:**
- `Strategy.autoExecute` boolean exists (toggle in UI)
- "Execute Now" button shows `alert('Execute simulated!')`
- `Strategy.executions` stores manual trade records as JSON
- No broker connection code exists yet

**IBKR API options:**

| Approach | Protocol | Pros | Cons |
|----------|----------|------|------|
| **Client Portal API** | REST/WebSocket | No TWS needed, cloud-friendly | Requires gateway process, session expires |
| **TWS API** | Socket (port 7496/7497) | Full feature set, most documented | Requires TWS/IB Gateway running locally |
| **IBKR Web API (newer)** | REST + OAuth | Cloud-native, no local process | Newer, less community support |

**Recommended approach: Client Portal API** — REST-based, works with IB Gateway running on the same machine or a server.

**Implementation plan:**

#### Phase 1: Order Placement (Manual Execute)
- Create `src/lib/ibkr.ts` — IBKR Client Portal API client
  - Authentication/session management
  - Place limit buy orders
  - Place limit sell orders (OCO or GTC)
  - Query order status
  - Query positions and account info
- Wire "Execute Now" button to place real limit orders for all triggered steps
- Add order confirmation modal before execution

#### Phase 2: Order Tracking
- New Prisma model for order state:
  ```prisma
  model Order {
    id            String   @id @default(cuid())
    strategyId    String
    strategy      Strategy @relation(fields: [strategyId], references: [id])
    step          Int
    side          String   // "BUY" or "SELL"
    ibkrOrderId   String?  // IBKR's order ID
    status        String   // "pending", "submitted", "filled", "cancelled"
    limitPrice    Float
    quantity      Float
    filledPrice   Float?
    filledAt      DateTime?
    createdAt     DateTime @default(now())
    updatedAt     DateTime @updatedAt
  }
  ```
- Replace `Strategy.executions` JSON with proper Order records
- Display order status per step in StrategyCard

#### Phase 3: Auto Execution
- Background job/cron that runs during market hours:
  1. Recalculate buy/sell levels for each auto-execute strategy
  2. Check which steps are triggered by current price
  3. Place or update limit orders accordingly
  4. Cancel stale orders when levels shift (SMA/sigma updates daily)
- Add safeguards:
  - Max daily order count
  - Position size limits
  - Kill switch (disable all auto-execute)
  - Notification on order fills (email/webhook)

#### Phase 4: Reconciliation
- Sync IBKR positions with local DB
- Handle partial fills, order rejections, corporate actions
- P&L tracking from actual fills vs theoretical

**Key IBKR API endpoints needed:**
```
POST /iserver/account/{id}/orders          — place order
GET  /iserver/account/{id}/orders          — list open orders
DELETE /iserver/account/{id}/order/{orderId} — cancel order
GET  /portfolio/{id}/positions             — current positions
GET  /iserver/marketdata/snapshot           — real-time quotes
POST /iserver/auth/ssodh/init             — session init
GET  /tickle                               — keep session alive
```

**Authentication flow:**
1. IB Gateway must be running (can be headless on a server)
2. Client Portal API authenticates via `POST /iserver/auth/ssodh/init`
3. Sessions expire — need a keepalive mechanism (`GET /tickle` every few minutes)
4. Consider a lightweight server-side process that maintains the IBKR session

**Risk considerations:**
- Paper trading account first (`port 5000` for paper, `5001` for live)
- All order placement should require explicit confirmation in live mode
- Rate limits: IBKR limits to ~50 messages/second
- Market hours only: don't submit orders when market is closed
- The strategy recalculates SMA/sigma daily — orders placed with yesterday's levels are valid for the full trading day

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | Prisma connection string. SQLite: `file:./dev.db`, Postgres: `postgresql://...` | Yes |
| `POLYGON_API_KEY` | Polygon.io API key for market data | Yes |

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `prisma/schema.prisma` | Database models (Strategy, DailyCandle, SymbolCache) |
| `src/app/actions.ts` | All server actions (CRUD + data fetching) |
| `src/lib/polygon.ts` | Polygon API integration, caching, SMA/sigma math |
| `src/lib/prisma.ts` | Prisma client singleton (avoids connection leaks in dev) |
| `src/app/page.tsx` | Dashboard page — loads strategies, sorts by price/SMA ratio |
| `src/components/StrategyCard.tsx` | Strategy detail card with live params, step preview, trade recording |
| `src/components/StrategyForm.tsx` | New strategy creation form |

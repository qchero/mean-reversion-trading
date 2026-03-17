# Mean Reversion Trading App - Design Document

This document outlines the architecture, data flow, and technical stack for the local mean reversion trading web application. 

## Terminology & Core Logic
- **SMA 200**: Simple Moving Average over the last 200 trading days (using daily data up to yesterday's market close).
- **Daily Volatility (σ)**: The standard deviation of the daily percentage change over the last 200 days (ending yesterday's close). This measures how much % the stock's price normally changes in a single day. A higher σ means a more volatile stock.
- **Initial Multiplier (j)**: Determines the first buy price, calculated as `SMA_200 - (j * σ)`.
- **Step Drop Multiplier (k)**: Determines the subsequent buy steps. 
  - Step 1: `SMA_200 - (j * σ)`
  - Step 2: `SMA_200 - ((j + k) * σ)`
  - Step 3: `SMA_200 - ((j + 2k) * σ)`, etc.
- **Max Steps**: Maximum number of buy orders to generate.
- **Step Amount ($)**: Total dollar amount to allocate per buy step.
- **Sell Steps (Take Profit)**: Each buy step comes with a corresponding sell limit order set at the adjacent higher step's price.
  - Step 1 Buy is sold at Step 0 Price: `SMA_200 - ((j - k) * σ)`
  - Step 2 Buy is sold at Step 1 Price: `SMA_200 - (j * σ)`
  - Step 3 Buy is sold at Step 2 Price: `SMA_200 - ((j + k) * σ)`, etc.
- **Execution Mode**: Strategies will have "Execute" (manual run) and "Auto execute" (toggle for automated trading connected to future brokerages like IBKR or Robinhood).

## Edge Cases (Documented for Future)
- **Partial Fills**: Not handled in this local visualizer, but will need logic later when connecting to real brokers.
- **Whipsaws / Falling Knives**: The strategy deploys capital mechanically. Capital exhaustion and rapid drops are risks accepted by the parameters (limited buys/amounts).
- **Corporate Actions (Splits/Dividends)**: Not handled in V1. Assuming typical adjusted historical data for simplicity.

## Tech Stack & Architecture
- **Framework**: Next.js (App Router)
  - *Why*: Excellent for both local execution and easy zero-config deployment to Vercel. 
- **Styling & Components**: Mantine UI (or similar mature, minimalist component library) instead of Vanilla CSS to provide responsive, built-in components quickly. (*Note: If you prefer shadcn/ui, we must use TailwindCSS, let me know which Tailwind version if so*).
- **Data Fetching / Caching**: Polygon.io REST API. 
  - *Caching Strategy*: Fetched daily candle data will be cached locally in our database. We will only fetch missing daily candles for a specific stock rather than refetching the entire 200-day window on every calculation.
- **Persistence**: 
  - We will use Prisma ORM with a local PostgreSQL (Docker/Local) or SQLite for now, which can easily be migrated to Vercel Postgres when you deploy.

## Proposed Changes
### Foundation
#### [NEW] project initialization
- Initialize Next.js project with Prisma and UI component library.
- Setup PostgreSQL or SQLite local database schema for Strategy and DailyCandle storage.

### Frontend Components
#### [NEW] Strategy Form
- Input fields for Symbol, `j`, `k`, Max Steps, and Step Amount.
- Submission handles triggering the calculation and preview.

#### [NEW] Strategy Preview / Dashboard
- Displays calculated SMA 200 and Daily Volatility (σ).
- Renders an interactive table of the calculated buy limits.
- **Live Updating**: Parameters (`j`, `k`, max steps, amount) are fully editable after creation, and the preview recalculates dynamically.
- **Execution Controls**: An "Execute" button to batch-run trades and an "Auto execute" toggle (mocked for now, placeholder for IBKR/Robinhood).

### Backend APIs (Next.js server actions / API routes)
#### [NEW] Polygon Integration & Caching
- Server-side logic to fetch daily aggregates from Polygon.
- Implements database caching for candles (`DailyCandle` table) to prevent redundant network calls.

#### [NEW] Strategy Storage
- API to Save, Read, and Delete strategies from the database.

## Verification Plan
### Automated Tests
- Unit test the math logic for SMA 200 and Standard Deviation calculations.
- Test step generator math logic.
### Manual Verification
- Run Next.js server locally.
- Input sample tickers, verifying that cached DB queries correctly avoid redundant Polygon calls.
- Toggle "Auto execute" buttons to verify state changes saving.

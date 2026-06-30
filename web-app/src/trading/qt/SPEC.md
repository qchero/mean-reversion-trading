# QuantGT Monthly Rebalance — `npm run qt`

Status: **DRAFT — pending review.** Items marked **[ASSUMPTION]** are my defaults; **[OPEN]** needs your decision.

## 1. Goal

A standalone monthly-rebalance auto-trader following the [quantgt.io](https://quantgt.io/) strategy.

Each month, 5 tickers are picked and a fixed dollar amount is allocated to each. Some of those
tickers may already be held from last month — so a run only needs to *adjust* each position to its
target share count. Orders are placed **Market-on-Open** once per run.

## 2. Strategy / math

For each ticker in this month's config:

```
targetShares = round(perTickerUsd / latestPrice)
delta        = targetShares - currentShares
```

- `delta > 0` → **BUY** `delta` shares
- `delta < 0` → **SELL** `|delta|` shares
- `delta == 0` → no order

Tickers currently held but **not** in this month's 5 → `targetShares = 0` (full exit). **[OPEN Q2]**

Whole shares only (`round`). No fractional shares.

## 3. Run lifecycle

`npm run qt` is meant to be started before market open. While running it:

1. Connects to IB Gateway (paper port `4002` by default; clientId `3` to avoid colliding with v1/v2).
2. Loads + validates the JSON config.
3. Reads current holdings (see **[OPEN Q1]**).
4. **Poll loop every 5 min** (`pollIntervalSec`, default 300s):
   - Fetch latest price per ticker (Yahoo `getLatestPrice`).
   - Compute target + delta; print a **preview table** (no orders placed).
5. **Trigger:** once the clock passes **09:20 America/New_York** AND orders not yet placed:
   - Place all non-zero-delta orders as Market-on-Open, **exactly once** per process.
   - Set `placed = true`; further loop iterations never re-place.
6. After placing: keep listening for IBKR order-status callbacks, log fills, then idle until
   SIGINT. **[ASSUMPTION — could exit after fills instead]**

### Why poll before the trigger?
The open price isn't known until 9:30. The pre-9:20 loop is a live preview using pre-market
prices. The share counts actually submitted are computed at the 9:20 trigger from the
then-latest price. The dollar allocation is therefore approximate (inherent to MOO).

## 4. Order type — Market-on-Open

IBKR MOO = `OrderType.MKT` + `TimeInForce.OPG`. Fills in the 9:30 opening auction. Submitting at
9:20 leaves a safe buffer before the OPG entry cutoff. **[ASSUMPTION — confirm Q3]**

New method needed on `IBKRClient`: `placeMOOOrder(symbol, action, qty)`. Everything else (connect,
reconnect, order-status callbacks) is reused as-is.

### Started-late behavior — **DECIDED: fill at the next open** (with a caveat)

Your intent: a late start should still result in a MOO fill at the *next* opening auction.

Important nuance about OPG: an OPG order is good **only for the next opening auction**, and IBKR
**rejects an OPG order submitted during regular trading hours** (it can't join an auction that's
already happened). So we **cannot** just fire an OPG order at, say, 11:00 AM and expect it to roll
to tomorrow — it gets rejected, not queued.

To genuinely achieve "filled at the next open," `qt` therefore computes the **next valid trigger
window** and waits for it instead of skipping:

| Start time (ET)        | Trigger fires at                          |
| ---------------------- | ----------------------------------------- |
| before 09:20           | today 09:20 (fills at today's 9:30 open)  |
| 09:20 – 09:30          | immediately (still pre-open, OPG valid)   |
| after 09:30 (in-hours) | **next trading day 09:20** (process stays running until then) |

**CONFIRMED:** on the "after 09:30" path the process **stays alive overnight** until the next
pre-open, re-evaluating prices/positions at that point. (I'll still verify the exact `@stoqey/ib`
/ IBKR OPG cutoff behavior during implementation.)

## 5. Config + state (single JSON file)

`src/trading/qt/config.json` holds both the user-maintained plan **and** machine-maintained state.
It is **gitignored** (it carries your live positions); a committed `config.example.json` is the
template — copy it to `config.json` on first setup.

```json
{
  "month": "2026-07",
  "perTickerUsd": 10000,
  "tickers": ["NVDA", "MSFT", "AAPL", "GOOGL", "AMZN"],
  "triggerEtTime": "09:20",
  "pollIntervalSec": 300,

  "positions": { "NVDA": 50, "MSFT": 30, "AAPL": 80, "GOOGL": 60, "AMZN": 40 },
  "lastPlacedDate": "2026-06-02"
}
```

**You edit (monthly):**
- `perTickerUsd`: single fixed amount applied to all 5 tickers. **[ASSUMPTION — vs per-ticker map]**
- `tickers`: this month's 5 picks. Just swap these each month; leave `positions` alone.
- `month`: sanity label, logged on startup so you can confirm the right config loaded.

**`qt` writes (do not hand-edit):**
- `positions`: qt's current holdings, the source of truth for computing deltas (§6).
- `lastPlacedDate`: the trading date qt last placed orders for — the idempotency guard (§8).

`config.ts` loads + validates (fail fast on missing/invalid fields, wrong ticker count, etc.).
First run: `positions` may be omitted/`{}` → all 5 are pure buys.

### State write-back (the key lifecycle step)

After orders are placed and fills settle, `qt` **rewrites the JSON** with the new position data:

- For each filled order, apply the **actual filled quantity** (from the IBKR order-status
  callback), not the assumed delta: `positions[sym] += filledBuy` / `-= filledSell`.
- Tickers that were sold to zero are **removed** from `positions`.
- `lastPlacedDate` is set to the trading date just executed.
- Write happens **once, after fills settle** (whole file re-serialized, 2-space indent).

So the end state of `positions` after a run equals the new target portfolio — ready for next month,
where you only change `tickers` / `perTickerUsd`.

## 6. Positions source — **DECIDED: local state in the config file**

`qt` tracks **only the shares it manages** in a `positions` map inside the config file (§5). This
is the source of truth for current share counts, updated from order fills.

> ### Why local state (and why a shared IBKR account is now safe)
> `reqPositions` would return the *whole* account's holdings; combined with sell-to-zero (§2),
> that would liquidate v1/v2 positions sharing the account. By tracking only qt's own tickers
> locally, **sell-to-zero is scoped to qt's holdings** — it never sees or touches other
> strategies' positions. So `qt` can run in the **same IBKR account** (clientId 3 to avoid
> stream collisions). ✅ This is the chosen approach.

**Drift caveat:** local state can diverge from the real account (manual trades, partial fills,
a crash between placing and writing back). Mitigations:
- After fills settle, write the *actual filled* quantities back to `positions` (not assumed).
- `lastPlacedDate` guard (§8) prevents double-placing across a restart.
- *Optional, log-only:* call `reqPositions` at startup and **warn** if a qt-tracked ticker's
  account quantity doesn't match the file — but never auto-act on it. (Enhancement, not v1-blocking.)

## 7. Folder layout

```
src/trading/qt/
  SPEC.md             # this doc
  config.example.json # committed template — copy to config.json to start
  config.json         # the month's 5 tickers + $ amount (gitignored: holds positions/state)
  config.ts           # load + validate config
  logic.ts         # pure: targetShares, rebalance plan (unit-testable, no IO)
  logic.test.ts    # tests for the math
  engine.ts        # connect, poll loop, 9:20 trigger, place-once
  run.ts           # entrypoint (npm run qt)
```

`package.json` scripts:
```
"qt":     "tsx src/trading/qt/run.ts",
"qt:sim": "tsx src/trading/qt/run.ts --simulate"
```

## 8. Safety

- **Paper-first.** Default port `4002` (paper). Live (`4001`) requires an explicit `--live` flag.
  **[ASSUMPTION]**
- `--simulate` / dry-run: compute + print the plan, never call `placeOrder`, never write state.
- **Idempotency (per trading date):** in-process `placed` flag guards a single submit per run; the
  persisted `lastPlacedDate` (§5) guards across restarts — if it equals the target trading date,
  `qt` refuses to place again. Together: orders go out **once per trading date**, even if the
  process is killed and restarted after the trigger.

## 9. Decisions & remaining questions

Decided:
- **Q1** Positions: **local state** in the config JSON; **same IBKR account** as v1/v2 (safe
  because qt only tracks/acts on its own tickers). Written back from fills after each run.
- **Q2** Dropped tickers: **sell to zero** (full exit).
- **Q3** **True MOO** (MKT + TIF=OPG), **09:20 ET** trigger.
- **Q4** Started-late: **stays running overnight**, fires at the next valid pre-open window.

Still need your confirmation (defaults are fine to accept):
1. `perTickerUsd` the same for all 5, or a per-ticker map?
2. After placing + write-back: exit, or idle until Ctrl-C?

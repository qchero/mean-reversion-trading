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
perPickUsd   = totalUsd / numberOfPicks        # e.g. $120,000 / 5 = $24,000
targetShares = round(perPickUsd / latestPrice)
delta        = targetShares - currentShares
```

The budget is split evenly across this month's picks (`tickers`). Held-but-dropped tickers are
exited, not funded, so they don't dilute the per-pick amount.

- `delta > 0` → **BUY** `delta` shares
- `delta < 0` → **SELL** `|delta|` shares
- `delta == 0` → no order

Tickers currently held but **not** in this month's 5 → `targetShares = 0` (full exit). **[OPEN Q2]**

Whole shares only (`round`). No fractional shares.

## 3. Run lifecycle

`npm run qt` is meant to be started before market open. While running it:

1. Connects to IB Gateway (port `4001`, shared with v1/v2; clientId `3` to avoid colliding with them)
   and subscribes to streaming market data for the universe.
2. Loads + validates the JSON config.
3. Reads current holdings (see **[OPEN Q1]**).
4. **Poll loop every 5 min** (`POLL_INTERVAL_SEC`, hard-coded 300s in `engine.ts`):
   - Read each ticker's latest **IBKR** quote (`getQuote`); size off the bid/ask **mid**, falling
     back to `last`. bid/ask/last are logged per ticker for inspection.
   - Compute target + delta; print a **preview table** (no orders placed).
5. **Trigger:** once the clock passes **09:20 America/New_York** (`TRIGGER_ET_TIME`) AND not yet placed:
   - Place all non-zero-delta orders as Market-on-Open, **exactly once** per process.
   - Set `placed = true`; further loop iterations never re-place.
6. **Fire-and-forget:** write the target positions (assume each order fills in full) and
   `lastPlacedDate` to the config, then **exit immediately** — no fill tracking, no waiting. The
   orders remain live at IBKR and fill in the 9:30 auction after we disconnect.

### Why poll before the trigger?
The open price isn't known until 9:30. The pre-9:20 loop is a live preview using the latest
IBKR quote (pre-market). The share counts actually submitted are computed at the 9:20 trigger
from the then-latest quote. The dollar allocation is therefore approximate (inherent to MOO).

### Price source
Quotes come from **IBKR streaming market data** (`subscribeMarketData` / `getQuote`) — the same
feed we execute against (replacing the earlier Yahoo fetch). Sizing uses the bid/ask mid when
present, else `last`; bid/ask/last are logged each cycle. Requires a live US-equity market-data
subscription on the account. `--simulate` connects and prices identically — it only skips order
placement and the state write-back.

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
  "totalUsd": 50000,
  "tickers": ["NVDA", "MSFT", "AAPL", "GOOGL", "AMZN"],

  "positions": { "NVDA": 50, "MSFT": 30, "AAPL": 80, "GOOGL": 60, "AMZN": 40 },
  "lastPlacedDate": "2026-06-02"
}
```

**You edit (monthly):**
- `totalUsd`: total dollar budget, split evenly across the picks (`totalUsd / tickers.length`).
- `tickers`: this month's 5 picks. Just swap these each month; leave `positions` alone.

The trigger time (`09:20` ET) and poll cadence (`300s`) are **hard-coded constants in `engine.ts`**
(`TRIGGER_ET_TIME` / `POLL_INTERVAL_SEC`), not config fields.

**`qt` writes (do not hand-edit):**
- `positions`: qt's current holdings, the source of truth for computing deltas (§6).
- `lastPlacedDate`: the trading date qt last placed orders for — the idempotency guard (§8).

`config.ts` loads + validates (fail fast on missing/invalid fields, wrong ticker count, etc.).
First run: `positions` may be omitted/`{}` → all 5 are pure buys.

### State write-back (the key lifecycle step)

Right after submitting (fire-and-forget), `qt` **rewrites the JSON** with the new position data:

- **Assume placed = filled:** apply each order's intended delta to `positions`
  (`positions[sym] += buyQty` / `-= sellQty`). qt does **not** wait for or read actual fills.
- Tickers that were sold to zero are **removed** from `positions`.
- `lastPlacedDate` is set to the trading date just executed.
- Write happens **once, immediately after placing** (whole file re-serialized, 2-space indent),
  then the process exits.

So the end state of `positions` after a run equals the new target portfolio — ready for next month,
where you only change `tickers` / `totalUsd`. **Tradeoff:** because fills aren't reconciled, a
partial/failed opening-auction fill leaves `positions` optimistic until manually corrected (§6).

## 6. Positions source — **DECIDED: local state in the config file**

`qt` tracks **only the shares it manages** in a `positions` map inside the config file (§5). This
is the source of truth for current share counts, updated from order fills.

> ### Why local state (and why a shared IBKR account is now safe)
> `reqPositions` would return the *whole* account's holdings; combined with sell-to-zero (§2),
> that would liquidate v1/v2 positions sharing the account. By tracking only qt's own tickers
> locally, **sell-to-zero is scoped to qt's holdings** — it never sees or touches other
> strategies' positions. So `qt` can run in the **same IBKR account** (clientId 3 to avoid
> stream collisions). ✅ This is the chosen approach.

**Drift caveat:** local state can diverge from the real account (manual trades, partial/failed
fills). With fire-and-forget (§5) qt writes **assumed** fills, so drift is more likely than with
fill reconciliation. Mitigations:
- `lastPlacedDate` guard (§8) prevents double-placing across a restart.
- *Optional, log-only:* call `reqPositions` at startup and **warn** if a qt-tracked ticker's
  account quantity doesn't match the file — but never auto-act on it. This becomes the primary
  drift check under fire-and-forget. (Enhancement, not v1-blocking.)

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

- **Safety is `--simulate`** (same model as v2's `npm run trade`). Connection is hard-coded to
  `127.0.0.1:4001` (the shared IB Gateway), clientId `3`. `npm run qt` connects there and places
  **real** MOO orders; only `npm run qt:sim` is a safe preview. No CLI flags.
- `--simulate` / dry-run: connects + streams quotes like live, computes + prints the plan, but
  never calls `placeMOOOrder` and never writes state.
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
- **Q5** Sizing: a single **`totalUsd`** budget **split evenly** across the picks
  (`totalUsd / tickers.length`) — not a per-ticker amount or map.

Still need your confirmation (defaults are fine to accept):
1. After placing + write-back: exit, or idle until Ctrl-C?

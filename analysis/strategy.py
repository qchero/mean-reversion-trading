"""Volatility-scaled mean reversion strategy on 15-min bars.

Levels are spaced below the 200-day SMA using daily σ as the unit.
Buy $X at each level when touched. Sell (LIFO) when price recovers one step.
Only ONE action (buy or sell) per 15-min candle. Sells take priority.
SMA and σ are based on the previous day's close (no intraday look-ahead).
"""

import pandas as pd
from dataclasses import dataclass

from config import SMA_PERIOD, ENTRY_SIGMA, STEP_SIGMA, NUM_LEVELS, TOTAL_BUDGET


@dataclass
class Tranche:
    level: int
    buy_date: pd.Timestamp
    buy_price: float
    shares: float


@dataclass
class Trade:
    level: int
    buy_date: pd.Timestamp
    buy_price: float
    sell_date: pd.Timestamp
    sell_price: float
    shares: float

    @property
    def pnl(self) -> float:
        return (self.sell_price - self.buy_price) * self.shares

    @property
    def pnl_pct(self) -> float:
        return self.sell_price / self.buy_price - 1

    @property
    def cost(self) -> float:
        return self.buy_price * self.shares


def prepare_data(df: pd.DataFrame, sma_period: int = SMA_PERIOD) -> pd.DataFrame:
    """Derive daily OHLCV, SMA, and rolling daily σ from 15-min bars."""
    daily = df.groupby(df.index.date).agg(
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
        volume=("volume", "sum"),
    )
    daily.index = pd.to_datetime(daily.index)
    daily["sma"] = daily["close"].rolling(window=sma_period).mean()
    daily["sigma"] = daily["close"].pct_change().rolling(window=sma_period).std()
    return daily


def simulate(df: pd.DataFrame, daily: pd.DataFrame,
             eval_start_date: str,
             j: float = None, k: float = None,
             num_levels: int = None, tranche_amount: float = None,
             round_shares: bool = False):
    """Volatility-scaled simulation using daily σ for level spacing.

    Levels recalculated each day using previous day's SMA and σ:
        buy[i]  = sma * (1 - σ * (j + i * k))
        sell[i] = sma * (1 - σ * (j + (i-1) * k))
    """
    j = j if j is not None else ENTRY_SIGMA
    k = k if k is not None else STEP_SIGMA
    nlevels = num_levels if num_levels is not None else NUM_LEVELS
    tranche = tranche_amount if tranche_amount is not None else TOTAL_BUDGET / nlevels
    eval_start = pd.Timestamp(eval_start_date)

    prev_sma = daily["sma"].shift(1)
    prev_sigma = daily["sigma"].shift(1)
    sma_lookup = {d.date(): v for d, v in prev_sma.items() if pd.notna(v)}
    sigma_lookup = {d.date(): v for d, v in prev_sigma.items() if pd.notna(v)}

    level_active = [False] * nlevels
    stack: list[Tranche] = []
    closed_trades: list[Trade] = []
    daily_records = []

    current_date = None
    sma = None
    sigma = None
    buy_prices = None
    sell_prices = None
    last_close = None

    for timestamp, bar in df.iterrows():
        trading_date = timestamp.date()

        if trading_date != current_date:
            if current_date is not None and sma is not None and last_close is not None:
                active = [s for s in stack if s is not None]
                invested = sum(s.buy_price * s.shares for s in active)
                mkt_val = sum(last_close * s.shares for s in active)
                realized = sum(t.pnl for t in closed_trades)
                daily_records.append({
                    "date": pd.Timestamp(current_date),
                    "close": last_close, "sma": sma,
                    "pct_below_sma": (last_close / sma - 1) * 100,
                    "num_tranches": len(active), "invested": invested,
                    "market_value": mkt_val, "unrealized_pnl": mkt_val - invested,
                    "realized_pnl": realized, "total_pnl": realized + (mkt_val - invested),
                })

            current_date = trading_date
            sma = sma_lookup.get(trading_date)
            sigma = sigma_lookup.get(trading_date)
            if sma is not None and sigma is not None and sigma > 0:
                buy_prices = [sma * (1 - sigma * (j + i * k)) for i in range(nlevels)]
                sell_prices = [sma * (1 - sigma * (j + (i - 1) * k)) for i in range(nlevels)]
            else:
                buy_prices = None
                sell_prices = None

        if sma is None or buy_prices is None or pd.Timestamp(trading_date) < eval_start:
            last_close = bar["close"]
            continue

        lo, hi = bar["low"], bar["high"]
        last_close = bar["close"]
        action_taken = False

        # --- Sells first (LIFO), deepest level first ---
        # Limit sell: fill at target if candle spans it, or at Low if gapped above
        for i in range(nlevels - 1, -1, -1):
            if not level_active[i]:
                continue
            if lo <= sell_prices[i] <= hi:
                fill = sell_prices[i]
            elif lo > sell_prices[i]:
                fill = lo
            else:
                continue
            level_active[i] = False
            if stack:
                t = stack.pop()
                closed_trades.append(Trade(
                    t.level, t.buy_date, t.buy_price,
                    timestamp, fill, t.shares,
                ))
            action_taken = True
            break

        # --- Buys (only if no sell happened), shallowest first ---
        # Limit buy: fill at target if candle spans it, or at High if gapped below
        if not action_taken:
            for i in range(nlevels):
                if level_active[i]:
                    continue
                if lo <= buy_prices[i] <= hi:
                    fill = buy_prices[i]
                elif hi < buy_prices[i]:
                    fill = hi
                else:
                    continue
                level_active[i] = True
                shares = tranche / fill
                if round_shares:
                    shares = int(shares)
                    if shares == 0:
                        continue
                stack.append(Tranche(i, timestamp, fill, shares))
                action_taken = True
                break

    # Record the final day
    if current_date is not None and sma is not None and last_close is not None:
        active = [s for s in stack if s is not None]
        invested = sum(s.buy_price * s.shares for s in active)
        mkt_val = sum(last_close * s.shares for s in active)
        realized = sum(t.pnl for t in closed_trades)
        daily_records.append({
            "date": pd.Timestamp(current_date),
            "close": last_close, "sma": sma,
            "pct_below_sma": (last_close / sma - 1) * 100,
            "num_tranches": len(active), "invested": invested,
            "market_value": mkt_val, "unrealized_pnl": mkt_val - invested,
            "realized_pnl": realized, "total_pnl": realized + (mkt_val - invested),
        })

    if daily_records:
        daily_df = pd.DataFrame(daily_records).set_index("date")
    else:
        daily_df = pd.DataFrame(columns=[
            "close", "sma", "pct_below_sma", "num_tranches",
            "invested", "market_value", "unrealized_pnl", "realized_pnl", "total_pnl",
        ])
        daily_df.index.name = "date"
    return daily_df, closed_trades, list(stack)

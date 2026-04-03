"""Linear mean reversion strategy — daily rebalance at close.

Target $ deployed is linearly interpolated between 0 and max_budget
based on how many σ below SMA the closing price is:

    sigma_below = (sma - close) / (sma * sigma)

    band_lo = mid - radius   (e.g. 6σ — fully out)
    band_hi = mid + radius   (e.g. 14σ — fully in)

    target_value = max_budget * clamp((sigma_below - band_lo) / (band_hi - band_lo), 0, 1)
    target_shares = round(target_value / close)

Trade rules:
  - Uses previous day's SMA and σ (no look-ahead bias).
  - Min trade threshold uses unclamped (extrapolated) target to avoid stranding
    small residual positions when price moves far outside the band.
  - Never sell at a loss: skip LIFO lots where close < lot.price.
"""

import pandas as pd
from dataclasses import dataclass

@dataclass
class LinearTrade:
    date: pd.Timestamp
    action: str  # "BUY" or "SELL"
    price: float
    shares: int
    target_value: float
    sigma_below: float
    # For sells: LIFO cost basis tracking
    pnl: float = 0.0
    pnl_pct: float = 0.0
    cost_basis: float = 0.0


@dataclass
class Lot:
    """A LIFO lot for cost basis tracking."""
    date: pd.Timestamp
    price: float
    shares: int


def _evaluate_and_trade(price, sma, sigma, band_lo, band_hi, max_budget,
                        min_trade_amount, lots, trades, trading_date,
                        realized_total):
    """Evaluate target at a given price and execute any trade.

    Returns (realized_total, sigma_below, target_value).
    """
    sigma_below = (sma - price) / (sma * sigma)

    # Unclamped linear target (extrapolates beyond band)
    linear_target_value = max_budget * (sigma_below - band_lo) / (band_hi - band_lo)
    unclamped_target_shares = round(linear_target_value / price)
    current_shares = sum(lot.shares for lot in lots)
    unclamped_diff = unclamped_target_shares - current_shares

    # Clamp target to [0, max_budget] worth of shares
    max_shares = round(max_budget / price)
    target_shares = max(0, min(max_shares, unclamped_target_shares))
    target_value = target_shares * price
    diff = target_shares - current_shares

    # Gate: only trade if unclamped diff exceeds min trade threshold
    min_shares = round(min_trade_amount / price) if min_trade_amount > 0 else 1
    if diff != 0 and abs(unclamped_diff) >= max(1, min_shares):
        if diff > 0:
            # BUY
            lots.append(Lot(date=pd.Timestamp(trading_date), price=price,
                            shares=diff))
            trades.append(LinearTrade(
                date=pd.Timestamp(trading_date),
                action="BUY", price=price, shares=diff,
                target_value=target_value, sigma_below=sigma_below,
            ))
        else:
            # SELL (LIFO) — never sell at a loss
            remaining = abs(diff)
            sell_pnl = 0.0
            sell_cost_basis = 0.0
            actually_sold = 0
            while remaining > 0 and lots:
                lot = lots[-1]
                if price < lot.price:
                    break
                sold = min(lot.shares, remaining)
                sell_pnl += (price - lot.price) * sold
                sell_cost_basis += lot.price * sold
                lot.shares -= sold
                remaining -= sold
                actually_sold += sold
                if lot.shares == 0:
                    lots.pop()

            if actually_sold > 0:
                avg_cost = sell_cost_basis / actually_sold
                trades.append(LinearTrade(
                    date=pd.Timestamp(trading_date),
                    action="SELL", price=price, shares=actually_sold,
                    target_value=target_value, sigma_below=sigma_below,
                    pnl=sell_pnl,
                    pnl_pct=(price / avg_cost - 1) if avg_cost else 0,
                    cost_basis=avg_cost,
                ))
                realized_total += sell_pnl

    return realized_total, sigma_below, target_value


def simulate_linear(daily: pd.DataFrame,
                    eval_start_date: str,
                    band_lo: float = 6, band_hi: float = 14,
                    max_budget: float = 15000,
                    min_trade_amount: float = 0):
    """Run the linear daily-rebalance strategy.

    Args:
        daily: DataFrame with columns [close, sma, sigma] indexed by date.
        eval_start_date: Start date for evaluation.

    Returns (daily_df, trades, lots_held).
    """

    eval_start = pd.Timestamp(eval_start_date)

    prev_sma = daily["sma"].shift(1)
    prev_sigma = daily["sigma"].shift(1)
    sma_lookup = {d: v for d, v in prev_sma.items() if pd.notna(v)}
    sigma_lookup = {d: v for d, v in prev_sigma.items() if pd.notna(v)}

    lots: list[Lot] = []  # LIFO stack
    trades: list[LinearTrade] = []
    daily_records = []
    realized_total = 0.0

    for date_ts, row in daily.iterrows():
        close = row["close"]
        sma = sma_lookup.get(date_ts)
        sigma = sigma_lookup.get(date_ts)

        if sma is None or sigma is None or sigma <= 0:
            continue
        if date_ts < eval_start:
            continue

        realized_total, sigma_below, target_value = _evaluate_and_trade(
            close, sma, sigma, band_lo, band_hi, max_budget,
            min_trade_amount, lots, trades, date_ts, realized_total)

        current_shares_after = sum(lot.shares for lot in lots)
        invested = sum(lot.price * lot.shares for lot in lots)
        mkt_val = close * current_shares_after
        daily_records.append({
            "date": date_ts,
            "close": close, "sma": sma, "sigma_below": sigma_below,
            "target_value": target_value,
            "shares": current_shares_after,
            "invested": invested,
            "market_value": mkt_val,
            "unrealized_pnl": mkt_val - invested,
            "realized_pnl": realized_total,
            "total_pnl": realized_total + (mkt_val - invested),
        })

    if daily_records:
        daily_df = pd.DataFrame(daily_records).set_index("date")
    else:
        daily_df = pd.DataFrame()
        daily_df.index.name = "date"

    return daily_df, trades, lots

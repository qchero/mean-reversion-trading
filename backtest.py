"""Performance metrics from simulation results."""


def performance_summary(
    daily_df,
    closed_trades: list,
    open_tranches: list,
) -> dict:
    total_realized = sum(t.pnl for t in closed_trades)
    total_unrealized = daily_df["unrealized_pnl"].iloc[-1]
    total_pnl = total_realized + total_unrealized

    n = len(closed_trades)
    winners = [t for t in closed_trades if t.pnl > 0]
    losers = [t for t in closed_trades if t.pnl <= 0]

    win_rate = len(winners) / n if n else 0
    avg_win = sum(t.pnl for t in winners) / len(winners) if winners else 0
    avg_loss = sum(t.pnl for t in losers) / len(losers) if losers else 0
    avg_return = sum(t.pnl_pct for t in closed_trades) / n if n else 0

    if closed_trades:
        hold_days = [(t.sell_date - t.buy_date).days for t in closed_trades]
        avg_hold = sum(hold_days) / len(hold_days)
        max_hold = max(hold_days)
    else:
        avg_hold = max_hold = 0

    max_tranches = int(daily_df["num_tranches"].max())

    return {
        "total_pnl": f"${total_pnl:,.2f}",
        "realized_pnl": f"${total_realized:,.2f}",
        "unrealized_pnl": f"${total_unrealized:,.2f}",
        "closed_trades": n,
        "open_positions": len(open_tranches),
        "win_rate": f"{win_rate:.1%}",
        "avg_win": f"${avg_win:,.2f}",
        "avg_loss": f"${avg_loss:,.2f}",
        "avg_return_per_trade": f"{avg_return:.2%}",
        "avg_holding_days": f"{avg_hold:.1f}",
        "max_holding_days": f"{max_hold}",
        "max_concurrent_tranches": max_tranches,
    }

"""Visualisation helpers."""

import os

import matplotlib.pyplot as plt

from config import NUM_LEVELS


def plot_results(daily_df, closed_trades, save_path="output/backtest.png"):
    os.makedirs(os.path.dirname(save_path), exist_ok=True)

    fig, axes = plt.subplots(3, 1, figsize=(14, 10), sharex=True)

    # --- Panel 1: Price + SMA + trade markers ---
    ax = axes[0]
    ax.plot(daily_df.index, daily_df["close"], label="Close", linewidth=0.7)
    ax.plot(daily_df.index, daily_df["sma"], label="200-SMA", linewidth=0.7, color="orange")

    for t in closed_trades:
        ax.scatter(t.buy_date, t.buy_price, marker="^", color="green", s=18, zorder=5)
        ax.scatter(t.sell_date, t.sell_price, marker="v", color="red", s=18, zorder=5)

    ax.legend(loc="upper left", fontsize=7, ncol=2)
    ax.set_ylabel("Price")
    ax.set_title("Mean Reversion Strategy — Volatility-Scaled Levels off 200-SMA")

    # --- Panel 2: Active tranches ---
    ax = axes[1]
    ax.fill_between(daily_df.index, daily_df["num_tranches"],
                    step="post", alpha=0.4, color="steelblue")
    ax.set_ylabel("Active Tranches")
    ax.set_ylim(-0.2, NUM_LEVELS + 0.5)
    ax.set_yticks(range(NUM_LEVELS + 1))

    # --- Panel 3: Cumulative P&L ---
    ax = axes[2]
    ax.plot(daily_df.index, daily_df["realized_pnl"],
            label="Realized P&L", linewidth=0.8)
    ax.plot(daily_df.index, daily_df["total_pnl"],
            label="Total P&L (incl. unrealized)", linewidth=0.8, alpha=0.8)
    ax.axhline(0, color="grey", linewidth=0.4)
    ax.set_ylabel("P&L ($)")
    ax.legend(loc="upper left", fontsize=8)
    ax.set_xlabel("Date")

    plt.tight_layout()
    plt.savefig(save_path, dpi=150)
    plt.close()
    print(f"Chart saved to {save_path}")

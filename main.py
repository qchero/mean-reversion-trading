"""Entry point: fetch data -> simulate -> report for multiple tickers."""

import argparse

from config import TICKERS
from data import fetch_bars
from strategy import prepare_data, simulate
from backtest import performance_summary


def run_ticker(ticker: str, data_start: str, end: str, eval_start: str):
    print(f"\n{'='*70}")
    print(f"  {ticker}")
    print(f"{'='*70}")

    df = fetch_bars(ticker, data_start, end)
    print(f"  {len(df)} 15-min bars loaded.\n")

    daily = prepare_data(df)
    daily_df, closed_trades, open_tranches = simulate(df, daily, eval_start_date=eval_start)

    # Print every trade
    if closed_trades:
        print(f"  Closed Trades ({len(closed_trades)}):")
        for t in closed_trades:
            hold = (t.sell_date - t.buy_date).days
            print(f"    Buy {t.buy_date.strftime('%Y-%m-%d %H:%M')} @ ${t.buy_price:>8.2f}  ->  "
                  f"Sell {t.sell_date.strftime('%Y-%m-%d %H:%M')} @ ${t.sell_price:>8.2f}  |  "
                  f"P&L ${t.pnl:>+8.2f} ({t.pnl_pct:>+6.1%})  |  {hold:>3d}d")

    if open_tranches:
        last_close = daily_df["close"].iloc[-1]
        print(f"\n  Open Positions ({len(open_tranches)}):")
        for t in open_tranches:
            unrealized = (last_close - t.buy_price) * t.shares
            pct = last_close / t.buy_price - 1
            hold = (daily_df.index[-1] - t.buy_date.normalize()).days
            print(f"    Buy {t.buy_date.strftime('%Y-%m-%d %H:%M')} @ ${t.buy_price:>8.2f}  |  "
                  f"Unrealized ${unrealized:>+8.2f} ({pct:>+6.1%})  |  {hold:>3d}d")

    stats = performance_summary(daily_df, closed_trades, open_tranches)
    print(f"\n  Summary:")
    for k, v in stats.items():
        print(f"    {k:28s}: {v}")

    return stats


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-start", required=True, help="Data start date")
    parser.add_argument("--eval-start", required=True, help="Eval start date")
    parser.add_argument("--end", required=True, help="End date")
    args = parser.parse_args()

    print(f"Eval period: {args.eval_start} -> {args.end}")
    print(f"Tickers: {', '.join(TICKERS)}")

    all_stats = {}
    for ticker in TICKERS:
        all_stats[ticker] = run_ticker(ticker, args.data_start, args.end, args.eval_start)

    # Final comparison table
    print(f"\n\n{'='*70}")
    print(f"  COMPARISON")
    print(f"{'='*70}")
    print(f"  {'Ticker':<8} {'Total P&L':>12} {'Realized':>12} {'Unrealized':>12} "
          f"{'Trades':>7} {'Open':>5} {'Win%':>6} {'Avg Ret':>8}")
    print(f"  {'-'*8} {'-'*12} {'-'*12} {'-'*12} {'-'*7} {'-'*5} {'-'*6} {'-'*8}")
    for ticker, s in all_stats.items():
        print(f"  {ticker:<8} {s['total_pnl']:>12} {s['realized_pnl']:>12} {s['unrealized_pnl']:>12} "
              f"{s['closed_trades']:>7} {s['open_positions']:>5} {s['win_rate']:>6} {s['avg_return_per_trade']:>8}")


if __name__ == "__main__":
    main()

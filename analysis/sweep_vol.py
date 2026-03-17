"""Volatility-scaled parameter sweep using daily σ for level spacing.

Usage:
    python sweep_vol.py --data-start 2021-03-13 --eval-start 2022-01-01 --end 2026-03-13
    python sweep_vol.py --data-start 2021-03-13 --eval-start 2024-01-01 --end 2026-03-13 --sort roc
    python sweep_vol.py --data-start 2021-03-13 --eval-start 2022-01-01 --end 2026-03-13 --j 8 9 10 --k 1 2 3 --levels 2 3 4
"""

import argparse
import itertools
import multiprocessing
import sys
import pandas as pd

from config import TICKERS, TOTAL_BUDGET
from data import fetch_bars
from strategy import prepare_data, simulate


# --- Default parameter grid ---
J_VALUES = [3, 4, 5, 6, 7, 8]          # first level = j × σ below SMA
K_VALUES = [1, 1.5, 2, 2.5, 3, 4]      # step = k × σ between levels
NUM_LEVELS_LIST = [1, 2, 3, 4]

# Module-level stores for worker processes
_worker_data = None
_worker_eval_start = None


def load_all_data(data_start, end):
    """Pre-load and prepare data for all tickers (hits cache)."""
    data = {}
    for i, ticker in enumerate(TICKERS, 1):
        print(f"  [{i}/{len(TICKERS)}] {ticker}...")
        df = fetch_bars(ticker, data_start, end)
        daily = prepare_data(df)
        data[ticker] = (df, daily)
        print(f"         {len(df)} bars, {len(daily)} days")
    return data


def _init_worker(data, eval_start):
    """Initializer for pool workers — stores shared data in module global."""
    global _worker_data, _worker_eval_start
    _worker_data = data
    _worker_eval_start = eval_start


def _evaluate_combo(args):
    """Worker function: evaluate one (j, k, num_levels) combo."""
    j, k, num_levels = args
    tranche_amount = TOTAL_BUDGET / num_levels
    total_realized = 0.0
    total_unrealized = 0.0
    total_trades = 0
    total_open = 0
    current_invested = 0.0
    invested_by_date = {}

    for ticker, (df, daily) in _worker_data.items():
        daily_df, closed_trades, open_tranches = simulate(
            df, daily,
            eval_start_date=_worker_eval_start,
            j=j, k=k,
            num_levels=num_levels,
            tranche_amount=tranche_amount,
        )
        total_realized += sum(t.pnl for t in closed_trades)
        total_unrealized += daily_df["unrealized_pnl"].iloc[-1] if len(daily_df) > 0 else 0
        total_trades += len(closed_trades)
        total_open += len(open_tranches)
        current_invested += sum(t.buy_price * t.shares for t in open_tranches)
        if len(daily_df) > 0:
            for date, row in daily_df.iterrows():
                invested_by_date[date] = invested_by_date.get(date, 0) + row["invested"]

    n_days = len(invested_by_date)
    avg_deployed = sum(invested_by_date.values()) / n_days if n_days > 0 else 0
    total_pnl = total_realized + total_unrealized
    return {
        "j": j,
        "k": k,
        "levels": num_levels,
        "tranche": int(tranche_amount),
        "realized": total_realized,
        "unrealized": total_unrealized,
        "total_pnl": total_pnl,
        "trades": total_trades,
        "open": total_open,
        "avg_deployed": avg_deployed,
        "cur_invested": current_invested,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-start", required=True, help="Data start date (e.g. 2021-03-13)")
    parser.add_argument("--eval-start", required=True, help="Eval start date (e.g. 2022-01-01)")
    parser.add_argument("--end", required=True, help="End date (e.g. 2026-03-13)")
    parser.add_argument("--j", nargs="+", type=float, default=None, help="j values to sweep")
    parser.add_argument("--k", nargs="+", type=float, default=None, help="k values to sweep")
    parser.add_argument("--levels", nargs="+", type=int, default=None, help="num_levels to sweep")
    parser.add_argument("--sort", choices=["pnl", "roc"], default="pnl", help="Sort by total P&L or ROC")
    args = parser.parse_args()

    j_vals = args.j or J_VALUES
    k_vals = args.k or K_VALUES
    lvl_vals = args.levels or NUM_LEVELS_LIST

    print(f"Data: {args.data_start} -> {args.end} | Eval: {args.eval_start} -> {args.end}")
    print("Loading 15-min data for all tickers...")
    data = load_all_data(args.data_start, args.end)
    print(f"  {len(data)} tickers loaded.\n")

    combos = list(itertools.product(j_vals, k_vals, lvl_vals))
    n = len(combos)
    ncpu = multiprocessing.cpu_count()
    print(f"Running {n} parameter combinations across {ncpu} workers...\n")

    results = []
    with multiprocessing.Pool(ncpu, initializer=_init_worker, initargs=(data, args.eval_start)) as pool:
        for i, result in enumerate(pool.imap_unordered(_evaluate_combo, combos)):
            pct = (i + 1) / n * 100
            sys.stdout.write(f"\r  Sweeping ... {i+1}/{n} ({pct:.0f}%)")
            sys.stdout.flush()
            results.append(result)

    print("\r  Done.                                        ")

    # Compute annualized ROC for each result
    eval_years = (pd.Timestamp(args.end) - pd.Timestamp(args.eval_start)).days / 365.25
    for r in results:
        roc = r["total_pnl"] / r["avg_deployed"] if r["avg_deployed"] > 0 else 0
        r["roc_ann"] = roc / eval_years * 100

    if args.sort == "roc":
        results.sort(key=lambda r: r["roc_ann"], reverse=True)
    else:
        results.sort(key=lambda r: r["total_pnl"], reverse=True)

    # Full table — top 30
    print(f"\n{'j':>5} {'k':>5} {'Lvls':>5} {'Trnch':>7} "
          f"{'Realized':>12} {'Unrealized':>12} {'Total P&L':>12} {'Trades':>7} {'Open':>5} "
          f"{'CurDepl':>10} {'AvgDepl':>10} {'ROC/yr':>8}")
    print(f"{'─'*5} {'─'*5} {'─'*5} {'─'*7} {'─'*12} {'─'*12} {'─'*12} {'─'*7} {'─'*5} "
          f"{'─'*10} {'─'*10} {'─'*8}")

    for i, r in enumerate(results[:30]):
        marker = " ***" if i < 5 else ""
        print(f"{r['j']:>4}σ {r['k']:>4}σ {r['levels']:>5} "
              f"${r['tranche']:>5,} "
              f"${r['realized']:>+11,.0f} ${r['unrealized']:>+11,.0f} ${r['total_pnl']:>+11,.0f} "
              f"{r['trades']:>7} {r['open']:>5} "
              f"${r['cur_invested']:>9,.0f} ${r['avg_deployed']:>9,.0f} {r['roc_ann']:>7.1f}%{marker}")

    # Top 20 detailed
    print(f"\n{'='*80}")
    print(f"TOP 20 CONFIGURATIONS (eval {eval_years:.1f} years):")
    print(f"{'='*80}")
    for i, r in enumerate(results[:20], 1):
        print(f"  #{i:>2}: j={r['j']}σ k={r['k']}σ levels={r['levels']} "
              f"(first buy at {r['j']}σ below SMA, step {r['k']}σ)")
        print(f"       Realized ${r['realized']:+,.2f} | Unrealized ${r['unrealized']:+,.2f} "
              f"| Total ${r['total_pnl']:+,.2f} | {r['trades']} trades, {r['open']} open")
        print(f"       Current deployed ${r['cur_invested']:,.0f} | Avg deployed ${r['avg_deployed']:,.0f}/day "
              f"| ROC/yr {r['roc_ann']:.1f}%")


if __name__ == "__main__":
    main()

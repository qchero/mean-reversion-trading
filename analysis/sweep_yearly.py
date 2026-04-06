"""Yearly parameter sweep with per-ticker detail.

Finds the parameter combination that maximizes average annualized ROC
across all calendar years while ensuring >= min-ops operations per full year.

Usage:
    python sweep_yearly.py --data-start 2021-03-13 --end 2026-04-01
    python sweep_yearly.py --data-start 2021-03-13 --end 2026-04-01 --eval-start-year 2024 --min-ops 0 --top 20
"""

import argparse
import itertools
import multiprocessing
import sys

import pandas as pd

from config import TICKERS, TOTAL_BUDGET
from data import fetch_bars
from strategy import prepare_data, simulate

J_VALUES = [4, 5, 6, 7, 8]
K_VALUES = [0.5, 1, 1.5, 2, 2.5]
NUM_LEVELS_LIST = [2, 3, 4, 5, 6, 7, 8]

_worker_data = None
_worker_end_date = None
_worker_years = None


def load_all_data(data_start, end):
    data = {}
    for i, ticker in enumerate(TICKERS, 1):
        print(f"  [{i}/{len(TICKERS)}] {ticker}...")
        df = fetch_bars(ticker, data_start, end)
        daily = prepare_data(df)
        data[ticker] = (df, daily)
        print(f"         {len(df)} bars, {len(daily)} days")
    return data


def _init_worker(data, end_date, years):
    global _worker_data, _worker_end_date, _worker_years
    _worker_data = data
    _worker_end_date = end_date
    _worker_years = years


def _evaluate_combo(args):
    """Evaluate one (j, k, num_levels) combo — continuous simulation, results split by year.

    Positions carry over across years: a position opened in Dec 2022 stays open
    into 2023. Yearly P&L = change in (cumulative realized + unrealized) during
    that year. Operations count actual buy/sell events per year.
    """
    j, k, num_levels = args
    tranche_amount = TOTAL_BUDGET / num_levels
    eval_start = f"{_worker_years[0]}-01-01"
    last_year = _worker_years[-1]

    # Per-year accumulators
    yearly_agg = {}
    for year in _worker_years:
        yearly_agg[year] = {
            "realized": 0.0, "unrealized": 0.0, "total_pnl": 0.0,
            "closed": 0, "open": 0, "buys": 0, "sells": 0,
            "invested_by_date": {}, "ticker_details": [],
        }
    # Overall accumulators for the full-period ROC
    overall_invested_by_date = {}
    overall_total_pnl = 0.0

    for ticker, (df, daily) in _worker_data.items():
        # One continuous simulation for the full period
        daily_df, closed_trades, open_tranches = simulate(
            df, daily,
            eval_start_date=eval_start,
            j=j, k=k,
            num_levels=num_levels,
            tranche_amount=tranche_amount,
        )

        for year in _worker_years:
            year_start = pd.Timestamp(f"{year}-01-01")
            year_end = pd.Timestamp(
                _worker_end_date if year == last_year else f"{year}-12-31")

            # Trades closed (sold) in this year
            year_closed = [t for t in closed_trades
                           if year_start <= t.sell_date <= year_end]
            t_realized = sum(t.pnl for t in year_closed)
            t_closed = len(year_closed)

            # Buys that happened in this year (from closed trades + still-open tranches)
            t_buys = sum(1 for t in closed_trades
                         if year_start <= t.buy_date <= year_end)
            t_buys += sum(1 for t in open_tranches
                          if year_start <= t.buy_date <= year_end)
            t_sells = t_closed
            t_ops = t_buys + t_sells

            # Year-end snapshot from daily_df
            year_daily = daily_df[
                (daily_df.index >= year_start) & (daily_df.index <= year_end)]
            t_unrealized = (year_daily["unrealized_pnl"].iloc[-1]
                            if len(year_daily) > 0 else 0)
            t_open = (int(year_daily["num_tranches"].iloc[-1])
                      if len(year_daily) > 0 else 0)

            # Year P&L = change in total_pnl (cumulative realized + unrealized)
            year_end_total = (year_daily["total_pnl"].iloc[-1]
                              if len(year_daily) > 0 else 0)
            prev_daily = daily_df[daily_df.index < year_start]
            prev_end_total = (prev_daily["total_pnl"].iloc[-1]
                              if len(prev_daily) > 0 else 0)
            t_year_pnl = year_end_total - prev_end_total

            # Invested per date for avg deployed calculation
            if len(year_daily) > 0:
                for date, inv in year_daily["invested"].items():
                    ya = yearly_agg[year]
                    ya["invested_by_date"][date] = (
                        ya["invested_by_date"].get(date, 0) + inv)

            ya = yearly_agg[year]
            ya["realized"] += t_realized
            ya["unrealized"] += t_unrealized
            ya["total_pnl"] += t_year_pnl
            ya["closed"] += t_closed
            ya["open"] += t_open
            ya["buys"] += t_buys
            ya["sells"] += t_sells
            ya["ticker_details"].append({
                "ticker": ticker,
                "realized": t_realized,
                "unrealized": t_unrealized,
                "total_pnl": t_year_pnl,
                "closed": t_closed,
                "open": t_open,
                "ops": t_ops,
            })

    # Merge all per-year invested_by_date into overall, sum total_pnl
    for year in _worker_years:
        ya = yearly_agg[year]
        overall_total_pnl += ya["total_pnl"]
        for date, inv in ya["invested_by_date"].items():
            overall_invested_by_date[date] = (
                overall_invested_by_date.get(date, 0) + inv)

    overall_n_days = len(overall_invested_by_date)
    overall_avg_deployed = (sum(overall_invested_by_date.values()) / overall_n_days
                            if overall_n_days > 0 else 0)
    # Full-period span in years
    full_start = pd.Timestamp(f"{_worker_years[0]}-01-01")
    full_end = pd.Timestamp(_worker_end_date)
    full_years = (full_end - full_start).days / 365.25
    overall_roc_ann = (overall_total_pnl / overall_avg_deployed / full_years * 100
                       if overall_avg_deployed > 0 and full_years > 0 else 0)

    yearly_results = []
    for year in _worker_years:
        ya = yearly_agg[year]
        n_days = len(ya["invested_by_date"])
        avg_deployed = (sum(ya["invested_by_date"].values()) / n_days
                        if n_days > 0 else 0)

        year_start_ts = pd.Timestamp(f"{year}-01-01")
        year_end_ts = pd.Timestamp(
            _worker_end_date if year == last_year else f"{year}-12-31")
        year_frac = (year_end_ts - year_start_ts).days / 365.25

        total_pnl = ya["total_pnl"]
        roc_ann = (total_pnl / avg_deployed / year_frac * 100
                   if avg_deployed > 0 and year_frac > 0 else 0)
        operations = ya["buys"] + ya["sells"]

        yearly_results.append({
            "year": year,
            "year_frac": year_frac,
            "realized": ya["realized"],
            "unrealized": ya["unrealized"],
            "total_pnl": total_pnl,
            "closed": ya["closed"],
            "open": ya["open"],
            "operations": operations,
            "avg_deployed": avg_deployed,
            "roc_ann": roc_ann,
            "ticker_details": ya["ticker_details"],
        })

    return {
        "j": j, "k": k, "levels": num_levels,
        "tranche": int(tranche_amount),
        "yearly": yearly_results,
        "overall_total_pnl": overall_total_pnl,
        "overall_avg_deployed": overall_avg_deployed,
        "overall_roc_ann": overall_roc_ann,
    }


def write_detailed_md(filepath, configs, min_ops):
    """Write detailed per-ticker per-year results to markdown."""
    with open(filepath, "w") as f:
        f.write("# Detailed Yearly Sweep Results\n\n")
        f.write(f"Constraint: >= {min_ops} operations per full year "
                f"(pro-rated for partial years)\n\n")

        for rank, r in enumerate(configs, 1):
            f.write(f"## #{rank}: j={r['j']}σ k={r['k']}σ levels={r['levels']} "
                    f"(tranche=${r['tranche']:,}) | Total P&L ${r['overall_total_pnl']:+,.0f} | "
                    f"Avg deployed ${r['overall_avg_deployed']:,.0f}/day | "
                    f"Overall ROC/yr {r['overall_roc_ann']:.1f}%\n\n")

            for yr in r["yearly"]:
                ops_min = min_ops * yr["year_frac"]
                tag = "PASS" if yr["operations"] >= ops_min else "FAIL"
                f.write(f"### {yr['year']} ({yr['year_frac']:.2f} yr) — "
                        f"P&L ${yr['total_pnl']:+,.0f} | ROC/yr {yr['roc_ann']:.1f}% | "
                        f"{yr['operations']} ops [{tag}] | "
                        f"Avg deployed ${yr['avg_deployed']:,.0f}\n\n")

                f.write("| Ticker | Realized | Unreal EOY | Year P&L | Closed | Open EOY | Ops |\n")
                f.write("|--------|----------|------------|----------|--------|----------|-----|\n")
                for td in yr["ticker_details"]:
                    f.write(f"| {td['ticker']:<6} "
                            f"| ${td['realized']:>+9,.0f} "
                            f"| ${td['unrealized']:>+9,.0f} "
                            f"| ${td['total_pnl']:>+9,.0f} "
                            f"| {td['closed']:>6} "
                            f"| {td['open']:>4} "
                            f"| {td['ops']:>3} |\n")
                # Totals row
                f.write(f"| **TOTAL** "
                        f"| **${yr['realized']:>+9,.0f}** "
                        f"| **${yr['unrealized']:>+9,.0f}** "
                        f"| **${yr['total_pnl']:>+9,.0f}** "
                        f"| **{yr['closed']:>6}** "
                        f"| **{yr['open']:>4}** "
                        f"| **{yr['operations']:>3}** |\n\n")

            f.write("---\n\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--min-ops", type=int, default=24,
                        help="Min operations per full year (pro-rated for partial years)")
    parser.add_argument("--output", default="sweep_results_detailed.md",
                        help="Output file for detailed per-ticker results")
    parser.add_argument("--eval-start-year", type=int, default=2022,
                        help="First year of evaluation (default: 2022)")
    parser.add_argument("--top", type=int, default=20,
                        help="Number of top results to show (default: 20)")
    args = parser.parse_args()

    end_year = int(args.end[:4])
    years = list(range(args.eval_start_year, end_year + 1))

    print(f"Data: {args.data_start} -> {args.end}")
    print(f"Years: {years}")
    print(f"Grid: j={J_VALUES} k={K_VALUES} levels={NUM_LEVELS_LIST}")
    print(f"Min ops/year: {args.min_ops} (pro-rated for partial years)\n")

    print("Loading 15-min data for all tickers...")
    data = load_all_data(args.data_start, args.end)
    print(f"  {len(data)} tickers loaded.\n")

    combos = list(itertools.product(J_VALUES, K_VALUES, NUM_LEVELS_LIST))
    n = len(combos)
    ncpu = multiprocessing.cpu_count()
    print(f"Running {n} combos × {len(years)} years across {ncpu} workers...\n")

    results = []
    with multiprocessing.Pool(ncpu, initializer=_init_worker, initargs=(data, args.end, years)) as pool:
        for i, result in enumerate(pool.imap_unordered(_evaluate_combo, combos)):
            pct = (i + 1) / n * 100
            sys.stdout.write(f"\r  Sweeping ... {i+1}/{n} ({pct:.0f}%)")
            sys.stdout.flush()
            results.append(result)

    print("\r  Done.                                        \n")

    # Check operations constraint per year, rank by overall ROC
    qualified = []
    disqualified = []
    for r in results:
        passes = True
        for yr in r["yearly"]:
            min_ops = args.min_ops * yr["year_frac"]
            if yr["operations"] < min_ops:
                passes = False

        if passes:
            qualified.append(r)
        else:
            disqualified.append(r)

    qualified.sort(key=lambda r: r["overall_roc_ann"], reverse=True)
    disqualified.sort(key=lambda r: r["overall_roc_ann"], reverse=True)

    # --- Summary table ---
    def print_table(rows, label):
        print(f"\n{label} ({len(rows)} combos)")
        print(f"{'─'*145}")
        print(f"{'j':>4} {'k':>4} {'Lvls':>4} ", end="")
        for year in years:
            print(f"│ {year:>8} {'Ops':>4} ", end="")
        print(f"│ {'TotP&L':>10} {'AvgDepl':>10} {'ROC/yr':>8}")
        print(f"{'─'*4} {'─'*4} {'─'*4} ", end="")
        for _ in years:
            print(f"│ {'─'*8} {'─'*4} ", end="")
        print(f"│ {'─'*10} {'─'*10} {'─'*8}")

        for i, r in enumerate(rows):
            marker = " ***" if i < 5 else ""
            print(f"{r['j']:>3}σ {r['k']:>3}σ {r['levels']:>4} ", end="")
            for yr in r["yearly"]:
                print(f"│ ${yr['total_pnl']:>+7,.0f} {yr['operations']:>4} ", end="")
            print(f"│ ${r['overall_total_pnl']:>+9,.0f} "
                  f"${r['overall_avg_deployed']:>9,.0f} "
                  f"{r['overall_roc_ann']:>7.1f}%{marker}")

    print(f"\n{'='*145}")
    print(f"RESULTS: {len(qualified)}/{len(results)} combos pass min-ops constraint (>= {args.min_ops}/yr)")
    print(f"Ranking by overall ROC = total P&L / avg daily deployed / years × 100")
    print(f"{'='*145}")

    top_n = args.top

    if qualified:
        print_table(qualified[:top_n + 10], "QUALIFIED (sorted by overall annualized ROC)")

    if disqualified:
        print_table(disqualified[:15], "\nDISQUALIFIED (top 15 by overall ROC, shown for reference)")

    # --- Top N detailed (stdout) ---
    show = qualified if qualified else disqualified
    print(f"\n{'='*145}")
    print(f"TOP {top_n} {'QUALIFIED ' if qualified else ''}CONFIGURATIONS:")
    print(f"{'='*145}")
    for i, r in enumerate(show[:top_n], 1):
        print(f"\n  #{i}: j={r['j']}σ k={r['k']}σ levels={r['levels']} │ "
              f"Total P&L ${r['overall_total_pnl']:+,.0f} │ "
              f"Avg deployed ${r['overall_avg_deployed']:,.0f}/day │ "
              f"Overall ROC/yr {r['overall_roc_ann']:.1f}%")
        for yr in r["yearly"]:
            flag = "" if yr["operations"] >= args.min_ops * yr["year_frac"] else " ← BELOW MIN"
            print(f"    {yr['year']}: P&L ${yr['total_pnl']:>+9,.0f} │ "
                  f"{yr['closed']:>3} closed + {yr['open']:>2} open = {yr['operations']:>3} ops │ "
                  f"Avg deployed ${yr['avg_deployed']:>9,.0f}{flag}")

    # Write detailed per-ticker results to markdown
    write_detailed_md(args.output, show[:top_n], args.min_ops)
    print(f"\nDetailed per-ticker results written to {args.output}")


if __name__ == "__main__":
    main()

"""Parameter sweep for the linear mean reversion strategy.

Sweeps mid and radius across one or more SMA periods.
Outputs terminal summary + optional markdown file.

Usage:
    python sweep.py
    python sweep.py --sma 200 300 --mid 5-15 --radius 2-7
    python sweep.py --eval-start 2016-04-01 --end 2026-04-01 --out sweep.md
"""

import argparse
import itertools
import sys

import pandas as pd

from config import TICKERS
from data_daily import fetch_daily, prepare_daily
from strategy_linear import simulate_linear


def parse_range(s):
    """Parse '5-15' into [5, 6, ..., 15]."""
    if "-" in s:
        lo, hi = s.split("-", 1)
        return list(range(int(lo), int(hi) + 1))
    return [int(x) for x in s.split(",")]


def load_data(data_start, end):
    raw = {}
    for i, ticker in enumerate(TICKERS, 1):
        raw[ticker] = fetch_daily(ticker, data_start, end)
        print(f"  [{i}/{len(TICKERS)}] {ticker}: {len(raw[ticker])} days")
    return raw


def evaluate_combo(mid, radius, data, eval_start, end, max_budget, min_trade):
    band_lo = mid - radius
    band_hi = mid + radius
    if band_lo < 0:
        return None

    ticker_invested = {}
    total_realized = 0.0
    total_unrealized = 0.0
    total_buys = 0
    total_sells = 0
    total_held = 0

    for ticker, daily in data.items():
        ddf, trades, lots = simulate_linear(
            daily, eval_start_date=eval_start,
            band_lo=band_lo, band_hi=band_hi,
            max_budget=max_budget, min_trade_amount=min_trade)

        if len(ddf) == 0:
            continue

        ticker_invested[ticker] = dict(ddf["invested"].items())
        last_close = ddf["close"].iloc[-1]
        realized = ddf["realized_pnl"].iloc[-1]
        held = sum(lot.shares for lot in lots)
        invested = sum(lot.price * lot.shares for lot in lots)
        unrealized = (last_close * held) - invested

        total_realized += realized
        total_unrealized += unrealized
        total_buys += sum(1 for t in trades if t.action == "BUY")
        total_sells += sum(1 for t in trades if t.action == "SELL")
        total_held += held

    all_invested = {}
    for inv_map in ticker_invested.values():
        for date, inv in inv_map.items():
            all_invested[date] = all_invested.get(date, 0) + inv

    total_pnl = total_realized + total_unrealized
    n_days = len(all_invested)
    avg_deployed = sum(all_invested.values()) / n_days if n_days else 0
    max_deployed = max(all_invested.values()) if all_invested else 0
    years = (pd.Timestamp(end) - pd.Timestamp(eval_start)).days / 365.25
    roc_ann = (total_pnl / avg_deployed / years * 100
               if avg_deployed > 0 and years > 0 else 0)

    return {
        "mid": mid, "radius": radius,
        "band_lo": band_lo, "band_hi": band_hi,
        "total_pnl": total_pnl,
        "realized": total_realized, "unrealized": total_unrealized,
        "avg_deployed": avg_deployed, "max_deployed": max_deployed,
        "roc_ann": roc_ann,
        "trades": total_buys + total_sells, "held": total_held,
    }


def run_sweep(raw, sma_period, mid_values, radius_values,
              eval_start, end, max_budget, min_trade):
    data = {t: prepare_daily(df, sma_period=sma_period) for t, df in raw.items()}
    combos = [(m, r) for m, r in itertools.product(mid_values, radius_values)
              if m - r >= 0]
    results = []
    for i, (mid, radius) in enumerate(combos):
        if (i + 1) % 10 == 0:
            sys.stdout.write(f"\r  SMA-{sma_period}: {i+1}/{len(combos)}")
            sys.stdout.flush()
        result = evaluate_combo(mid, radius, data, eval_start, end,
                                max_budget, min_trade)
        if result is not None:
            results.append(result)
    print(f"\r  SMA-{sma_period}: {len(combos)}/{len(combos)} done")
    results.sort(key=lambda r: r["roc_ann"], reverse=True)
    return results


def print_results(sma_period, results, top_n, eval_start, end):
    years = (pd.Timestamp(end) - pd.Timestamp(eval_start)).days / 365.25
    print(f"\n{'=' * 130}")
    print(f"SMA-{sma_period} | TOP {top_n} | "
          f"Eval: {eval_start} -> {end} ({years:.1f} years)")
    print(f"{'=' * 130}")
    print(f"{'Rank':>4} {'Mid':>4} {'Rad':>4} {'Band':>12} "
          f"{'Total P&L':>12} {'Realized':>12} {'Unrealized':>12} "
          f"{'Avg Deploy':>12} {'Max Deploy':>12} {'ROC/yr':>8} "
          f"{'Trades':>7} {'Held':>5}")
    for i, r in enumerate(results[:top_n], 1):
        band = f"[{r['band_lo']}σ,{r['band_hi']}σ]"
        print(f"{i:>4} {r['mid']:>3}σ {r['radius']:>3}σ {band:>12} "
              f"${r['total_pnl']:>+10,.0f} ${r['realized']:>+10,.0f} "
              f"${r['unrealized']:>+10,.0f} ${r['avg_deployed']:>10,.0f} "
              f"${r['max_deployed']:>10,.0f} {r['roc_ann']:>7.1f}% "
              f"{r['trades']:>7} {r['held']:>5}")


def print_heatmap(results, mid_values, radius_values):
    roc_map = {(r["mid"], r["radius"]): r["roc_ann"] for r in results}
    print(f"\n{'mid\\rad':>8}", end="")
    for rad in radius_values:
        print(f" {rad:>7}σ", end="")
    print()
    for mid in mid_values:
        print(f"{mid:>7}σ", end="")
        for rad in radius_values:
            val = roc_map.get((mid, rad))
            if val is not None:
                print(f" {val:>7.1f}%", end="")
            else:
                print(f"       —", end="")
        print()


def format_markdown(sma_period, results, top_n, mid_values, radius_values):
    lines = []
    w = lines.append
    w(f"## SMA-{sma_period}\n")
    w(f"### Top {top_n} Configurations\n")
    w("| Rank | Mid | Rad | Band | Total P&L | Realized | Unrealized "
      "| Avg Deploy | Max Deploy | ROC/yr | Trades | Held |")
    w("|------|-----|-----|------|-----------|----------|------------|"
      "------------|------------|--------|--------|------|")
    for i, r in enumerate(results[:top_n], 1):
        band = f"[{r['band_lo']}σ,{r['band_hi']}σ]"
        w(f"| {i} | {r['mid']}σ | {r['radius']}σ | {band} "
          f"| ${r['total_pnl']:+,.0f} | ${r['realized']:+,.0f} "
          f"| ${r['unrealized']:+,.0f} | ${r['avg_deployed']:,.0f} "
          f"| ${r['max_deployed']:,.0f} | {r['roc_ann']:.1f}% "
          f"| {r['trades']} | {r['held']} |")

    w(f"\n### ROC Heatmap (annualized %)\n")
    roc_map = {(r["mid"], r["radius"]): r["roc_ann"] for r in results}
    header = "| mid\\rad |"
    sep = "|---------|"
    for rad in radius_values:
        header += f" {rad}σ |"
        sep += "------|"
    w(header)
    w(sep)
    for mid in mid_values:
        row = f"| **{mid}σ** |"
        for rad in radius_values:
            val = roc_map.get((mid, rad))
            row += f" {val:.1f}% |" if val is not None else " — |"
        w(row)
    w("")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Linear strategy parameter sweep")
    parser.add_argument("--data-start", default="2014-06-01")
    parser.add_argument("--eval-start", default="2016-04-01")
    parser.add_argument("--end", default="2026-04-01")
    parser.add_argument("--sma", nargs="+", type=int, default=[200, 300])
    parser.add_argument("--mid", default="5-15", help="mid range, e.g. 5-15")
    parser.add_argument("--radius", default="2-7", help="radius range, e.g. 2-7")
    parser.add_argument("--budget", type=float, default=15000)
    parser.add_argument("--min-trade", type=float, default=1000)
    parser.add_argument("--top", type=int, default=20)
    parser.add_argument("--out", help="Write markdown output to file")
    args = parser.parse_args()

    mid_values = parse_range(args.mid)
    radius_values = parse_range(args.radius)

    print(f"Eval: {args.eval_start} -> {args.end}")
    print(f"SMA: {args.sma} | Mid: {mid_values} | Radius: {radius_values}")
    print(f"Budget: ${args.budget:,.0f} | Min trade: ${args.min_trade:,.0f}\n")

    print("Loading daily data...")
    raw = load_data(args.data_start, args.end)

    md_sections = []
    for sma_period in args.sma:
        results = run_sweep(raw, sma_period, mid_values, radius_values,
                            args.eval_start, args.end, args.budget, args.min_trade)
        print_results(sma_period, results, args.top, args.eval_start, args.end)
        print_heatmap(results, mid_values, radius_values)
        if args.out:
            md_sections.append(format_markdown(sma_period, results, args.top,
                                               mid_values, radius_values))

    if args.out:
        header = (f"# Parameter Sweep\n\n"
                  f"**Eval:** {args.eval_start} → {args.end} | "
                  f"**Tickers:** {len(TICKERS)} | "
                  f"**Budget:** ${args.budget:,.0f} | "
                  f"**Min trade:** ${args.min_trade:,.0f}\n\n---\n\n")
        with open(args.out, "w") as f:
            f.write(header + "\n".join(md_sections))
        print(f"\nMarkdown written to {args.out}")


if __name__ == "__main__":
    main()

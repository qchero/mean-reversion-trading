"""Detailed trade log for a pinned configuration.

Usage:
    python trade_log.py
    python trade_log.py --sma 200 --mid 10 --radius 4
    python trade_log.py --eval-start 2016-04-01 --end 2026-04-01
"""

import argparse

from config import TICKERS
from data_daily import fetch_daily, prepare_daily
from strategy_linear import simulate_linear


def run(tickers, data_start, eval_start, end, sma_period,
        mid, radius, max_budget, min_trade):
    band_lo = mid - radius
    band_hi = mid + radius
    lines = []
    w = lines.append

    w(f"# Trade Log: SMA-{sma_period} mid={mid}σ radius={radius}σ "
      f"[{band_lo}σ, {band_hi}σ]")
    w(f"Budget: ${max_budget:,}/ticker | Min trade: ${min_trade:,} | "
      f"Eval: {eval_start} -> {end}\n")

    grand_realized = 0.0
    grand_unrealized = 0.0
    grand_buys = 0
    grand_sells = 0
    ticker_summaries = []

    for ticker in tickers:
        df = fetch_daily(ticker, data_start, end)
        daily = prepare_daily(df, sma_period=sma_period)
        ddf, trades, lots = simulate_linear(
            daily, eval_start_date=eval_start,
            band_lo=band_lo, band_hi=band_hi,
            max_budget=max_budget, min_trade_amount=min_trade)

        last_close = ddf["close"].iloc[-1] if len(ddf) else 0
        realized = ddf["realized_pnl"].iloc[-1] if len(ddf) else 0
        held_shares = sum(lot.shares for lot in lots)
        invested = sum(lot.price * lot.shares for lot in lots)
        unrealized = (last_close * held_shares) - invested

        n_buys = sum(1 for t in trades if t.action == "BUY")
        n_sells = sum(1 for t in trades if t.action == "SELL")
        grand_realized += realized
        grand_unrealized += unrealized
        grand_buys += n_buys
        grand_sells += n_sells

        w(f"---\n## {ticker}\n")

        if not trades:
            w("No trades.\n")
            ticker_summaries.append(
                f"| {ticker:<6} | {'--':>10} | {'--':>10} | {'--':>10} "
                f"| {'0':>5} | {'0':>5} | {'0':>5} |")
            continue

        w("| # | Date | Action | Price | Shares | Amount "
          "| P&L | P&L% | Cost Basis | σ Below | Deployed |")
        w("|---|------|--------|-------|--------|--------"
          "|-----|------|------------|---------|----------|")

        deployed = 0.0
        for idx, t in enumerate(trades, 1):
            amount = t.price * t.shares
            if t.action == "BUY":
                deployed += amount
                pnl_str = pct_str = cb_str = ""
            else:
                deployed -= amount
                pnl_str = f"${t.pnl:+,.2f}"
                pct_str = f"{t.pnl_pct:+.1%}"
                cb_str = f"${t.cost_basis:,.2f}"

            w(f"| {idx} | {t.date.strftime('%Y-%m-%d')} | {t.action} "
              f"| ${t.price:,.2f} | {t.shares} | ${amount:,.2f} "
              f"| {pnl_str} | {pct_str} | {cb_str} "
              f"| {t.sigma_below:.1f}σ | ${deployed:,.2f} |")

        w("")

        if lots:
            w(f"**Open lots ({len(lots)}, {held_shares} shares):**\n")
            w("| Bought | Price | Shares | Cost | Current | Unrealized | P&L% |")
            w("|--------|-------|--------|------|---------|------------|------|")
            for lot in lots:
                cost = lot.price * lot.shares
                unr = (last_close - lot.price) * lot.shares
                pct = last_close / lot.price - 1
                w(f"| {lot.date.strftime('%Y-%m-%d')} "
                  f"| ${lot.price:,.2f} | {lot.shares} | ${cost:,.2f} "
                  f"| ${last_close:,.2f} | ${unr:+,.2f} | {pct:+.1%} |")
            w("")

        w(f"**Summary:** Realized ${realized:+,.2f} | Unrealized ${unrealized:+,.2f} "
          f"| Total ${realized + unrealized:+,.2f} | "
          f"Buys {n_buys} | Sells {n_sells}\n")

        ticker_summaries.append(
            f"| {ticker:<6} | ${realized:>+9,.2f} | ${unrealized:>+9,.2f} "
            f"| ${realized + unrealized:>+9,.2f} "
            f"| {n_buys:>5} | {n_sells:>5} | {held_shares:>5} |")

    w(f"\n---\n## Overall Summary\n")
    w("| Ticker | Realized | Unrealized | Total P&L | Buys | Sells | Held |")
    w("|--------|----------|------------|-----------|------|-------|------|")
    for s in ticker_summaries:
        w(s)
    w(f"| **TOTAL** | **${grand_realized:>+9,.2f}** | **${grand_unrealized:>+9,.2f}** "
      f"| **${grand_realized + grand_unrealized:>+9,.2f}** "
      f"| **{grand_buys:>5}** | **{grand_sells:>5}** | |")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Trade log for linear strategy")
    parser.add_argument("--data-start", default="2014-06-01")
    parser.add_argument("--eval-start", default="2016-04-01")
    parser.add_argument("--end", default="2026-04-01")
    parser.add_argument("--sma", type=int, default=200)
    parser.add_argument("--mid", type=float, default=10)
    parser.add_argument("--radius", type=float, default=4)
    parser.add_argument("--budget", type=float, default=15000)
    parser.add_argument("--min-trade", type=float, default=1000)
    parser.add_argument("--out", default="trade_log.md")
    args = parser.parse_args()

    band_lo = args.mid - args.radius
    band_hi = args.mid + args.radius
    print(f"SMA-{args.sma} | [{band_lo}σ, {band_hi}σ] | "
          f"${args.budget:,.0f}/ticker")
    print(f"Eval: {args.eval_start} -> {args.end}")
    print(f"Tickers: {', '.join(TICKERS)}\n")

    output = run(TICKERS, args.data_start, args.eval_start, args.end,
                 args.sma, args.mid, args.radius, args.budget, args.min_trade)

    with open(args.out, "w") as f:
        f.write(output)
    print(f"Trade log written to {args.out}")


if __name__ == "__main__":
    main()

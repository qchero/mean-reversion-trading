"""Fetch split-adjusted daily data from yfinance with local parquet cache.

All prices are split- and dividend-adjusted by yfinance.
Cache stores raw yfinance data; derived columns (SMA, σ) are computed on read.
"""

import os

import pandas as pd
import yfinance as yf

CACHE_DIR = "cache"

# yfinance columns → snake_case
_COLUMN_MAP = {
    "Open": "open",
    "High": "high",
    "Low": "low",
    "Close": "close",
    "Volume": "volume",
    "Dividends": "dividends",
    "Stock Splits": "stock_splits",
}


def _cache_path(ticker: str) -> str:
    return os.path.join(CACHE_DIR, f"{ticker}_daily.parquet")


def _fetch_from_yfinance(ticker: str, start: str, end: str) -> pd.DataFrame:
    """Fetch daily bars from yfinance, keeping all fields."""
    hist = yf.Ticker(ticker).history(start=start, end=end)
    if hist.empty:
        raise ValueError(f"No data returned for {ticker} ({start} to {end})")

    hist.index = hist.index.tz_localize(None)
    hist = hist.rename(columns=_COLUMN_MAP)
    hist.index.name = "date"
    return hist


def fetch_daily(ticker: str, start: str, end: str) -> pd.DataFrame:
    """Fetch daily OHLCV with local parquet cache."""
    start_dt = pd.Timestamp(start)
    end_dt = pd.Timestamp(end)
    cache = _cache_path(ticker)

    if os.path.exists(cache):
        cached = pd.read_parquet(cache)
        cached_start = cached.index.min().normalize()
        cached_end = cached.index.max().normalize()

        if cached_start <= start_dt and cached_end >= end_dt:
            print(f"  [cache hit] {ticker}")
            return cached[start:end]

        # Fetch full range and replace cache
        print(f"  [cache partial] re-fetching {ticker}...")
        fetch_start = str(min(start_dt, cached_start).date())
        fetch_end = str(max(end_dt, cached_end + pd.Timedelta(days=1)).date())
        df = _fetch_from_yfinance(ticker, fetch_start, fetch_end)
        os.makedirs(CACHE_DIR, exist_ok=True)
        df.to_parquet(cache)
        return df[start:end]

    print(f"  [cache miss] fetching {ticker}...")
    df = _fetch_from_yfinance(ticker, start, end)
    os.makedirs(CACHE_DIR, exist_ok=True)
    df.to_parquet(cache)
    return df[start:end]


def prepare_daily(df: pd.DataFrame, sma_period: int = 300) -> pd.DataFrame:
    """Add SMA and rolling σ to daily data."""
    daily = df.copy()
    daily["sma"] = daily["close"].rolling(window=sma_period).mean()
    daily["sigma"] = daily["close"].pct_change().rolling(window=sma_period).std()
    return daily

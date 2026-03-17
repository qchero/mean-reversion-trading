"""Fetch 15-min price bars from Polygon.io with local file cache."""

import os
import time

import pandas as pd
from dotenv import load_dotenv
from polygon import RESTClient

load_dotenv()

CACHE_DIR = "cache"


def get_client() -> RESTClient:
    api_key = os.environ.get("POLYGON_API_KEY")
    if not api_key:
        raise RuntimeError("Set POLYGON_API_KEY in your .env file")
    return RESTClient(api_key)


def _cache_path(ticker: str) -> str:
    return os.path.join(CACHE_DIR, f"{ticker}_15min.parquet")


def _load_cache(ticker: str) -> pd.DataFrame | None:
    path = _cache_path(ticker)
    if os.path.exists(path):
        return pd.read_parquet(path)
    return None


def _save_cache(ticker: str, df: pd.DataFrame):
    os.makedirs(CACHE_DIR, exist_ok=True)
    df.to_parquet(_cache_path(ticker))


def _fetch_chunk(client, ticker, chunk_start, chunk_end, max_retries=8):
    """Fetch one chunk of 15-min bars with aggressive retry."""
    for attempt in range(max_retries):
        try:
            return client.get_aggs(
                ticker=ticker,
                multiplier=15,
                timespan="minute",
                from_=chunk_start,
                to=chunk_end,
                limit=50_000,
            )
        except Exception as e:
            if attempt == max_retries - 1:
                raise
            wait = 4 * 2 ** attempt  # 4s, 8s, 16s, 32s, ...
            print(f"    [retry] {e} — waiting {wait}s (attempt {attempt + 1}/{max_retries})")
            time.sleep(wait)


def _bars_to_df(all_bars):
    """Convert a list of Polygon Agg objects to a DataFrame."""
    df = pd.DataFrame([{
        k: v for k, v in vars(b).items() if v is not None
    } for b in all_bars])

    df["datetime"] = (
        pd.to_datetime(df["timestamp"], unit="ms", utc=True)
        .dt.tz_convert("US/Eastern")
        .dt.tz_localize(None)
    )
    df = df.drop(columns=["timestamp"]).set_index("datetime").sort_index()

    # Keep regular trading hours only (bar start times 9:30 to 15:45)
    df = df.between_time("09:30", "15:45")
    return df


def _fetch_from_polygon(ticker: str, start: str, end: str) -> pd.DataFrame:
    """Fetch 15-min bars in 3-month chunks to respect free-tier rate limits."""
    client = get_client()
    all_bars = []

    # Split into 3-month chunks to minimise API calls
    chunks = []
    current = pd.Timestamp(start)
    end_ts = pd.Timestamp(end)
    while current < end_ts:
        chunk_end = min(current + pd.DateOffset(months=3), end_ts)
        chunks.append((str(current.date()), str(chunk_end.date())))
        current = chunk_end

    for i, (cs, ce) in enumerate(chunks):
        if i > 0:
            time.sleep(1)
        bars = _fetch_chunk(client, ticker, cs, ce)
        n = len(bars) if bars else 0
        if bars:
            all_bars.extend(bars)
        print(f"    [chunk {i+1}/{len(chunks)}] {cs} to {ce}: {n} bars")

    if not all_bars:
        raise ValueError(f"No data returned for {ticker} ({start} to {end})")

    return _bars_to_df(all_bars)


def fetch_bars(ticker: str, start: str, end: str) -> pd.DataFrame:
    """Fetch 15-min OHLCV bars with local parquet cache."""
    start_dt = pd.Timestamp(start)
    end_dt = pd.Timestamp(end)

    cached = _load_cache(ticker)

    if cached is not None:
        cached_start = cached.index.min().normalize()
        cached_end = cached.index.max().normalize()

        if cached_start <= start_dt and cached_end >= end_dt:
            print(f"  [cache hit] {ticker}")
            return cached[start:end]

        parts = [cached]

        if start_dt < cached_start:
            print(f"  [cache partial] fetching {ticker} pre-range...")
            pre = _fetch_from_polygon(ticker, start, str(cached_start.date()))
            parts.append(pre)

        if end_dt > cached_end:
            print(f"  [cache partial] fetching {ticker} post-range...")
            post = _fetch_from_polygon(ticker, str(cached_end.date()), end)
            parts.append(post)

        merged = pd.concat(parts)
        merged = merged[~merged.index.duplicated(keep="last")].sort_index()
        _save_cache(ticker, merged)
        return merged[start:end]

    print(f"  [cache miss] fetching {ticker}...")
    df = _fetch_from_polygon(ticker, start, end)
    _save_cache(ticker, df)
    return df


if __name__ == "__main__":
    import argparse
    from config import TICKERS

    parser = argparse.ArgumentParser()
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    args = parser.parse_args()

    ticker = TICKERS[0]
    df = fetch_bars(ticker, args.start, args.end)
    print(f"Fetched {len(df)} 15-min bars for {ticker}")
    print(f"Date range: {df.index.min()} to {df.index.max()}")
    print(f"Trading days: {df.groupby(df.index.date).ngroups}")

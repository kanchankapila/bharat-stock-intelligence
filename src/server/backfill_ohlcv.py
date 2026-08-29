import polars as pl
import asyncio

from db_compat import connect
from datetime import date as _date_type


# ── Market holiday helpers ────────────────────────────────────────────────────

_holiday_cache: set[str] | None = None


def _load_holidays(conn) -> set[str]:
    """Load NSE market holidays from DB into a date-string set (YYYY-MM-DD)."""
    global _holiday_cache
    if _holiday_cache is not None:
        return _holiday_cache
    try:
        rows = conn.execute(
            "SELECT date FROM market_holidays WHERE exchange='NSE'"
        ).fetchall()
        _holiday_cache = {str(r[0])[:10] for r in rows}
    except Exception:
        _holiday_cache = set()
    return _holiday_cache


def is_market_holiday(date_str: str, conn) -> bool:
    """Return True if date_str (YYYY-MM-DD) is a known NSE holiday."""
    return date_str in _load_holidays(conn)


def filter_holiday_records(records: list, conn) -> tuple[list, list]:
    """Split records into (trading_day_records, holiday_records)."""
    holidays = _load_holidays(conn)
    trading, skipped = [], []
    for rec in records:
        (skipped if rec[1] in holidays else trading).append(rec)
    return trading, skipped


def _run_async(coro):
    """Run a coroutine safely whether or not an event loop is already running."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(asyncio.run, coro)
            return future.result()
    else:
        return asyncio.run(coro)
import yfinance as yf
import httpx
import pandas as pd
import os
import time
from tqdm import tqdm

DB_PATH = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'database.sqlite'))

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Accept": "application/json",
}

# Max concurrent YF chart requests during gap-fill. The Semaphore itself is created
# inside _gap_fill_async (within the running loop) — a module-level Semaphore binds to
# the import-time loop and breaks across asyncio.run() calls.
_GAP_FILL_CONCURRENCY = 20
def _date_to_unix(date_str: str) -> int:
    """Convert YYYY-MM-DD string to Unix timestamp for YF API."""
    from datetime import datetime
    return int(datetime.strptime(date_str, "%Y-%m-%d").timestamp())


async def _fetch_ohlcv_async(
    client: httpx.AsyncClient,
    symbol: str,
    ticker: str,
    cutoff: str,
    today: str,
    sem: asyncio.Semaphore,
) -> list:
    """Fetch daily OHLCV for one NSE symbol between cutoff and today using YF v8 chart."""
    async with sem:
        url = (
            f"https://query2.finance.yahoo.com/v8/finance/chart/{ticker}"
            f"?interval=1d"
            f"&period1={_date_to_unix(cutoff)}"
            f"&period2={_date_to_unix(today)}"
        )
        try:
            r = await client.get(url, timeout=15.0)
            if r.status_code != 200:
                return []
            data = r.json()
            result = data.get("chart", {}).get("result", [])
            if not result:
                return []
            res = result[0]
            timestamps = res.get("timestamp", [])
            quotes = res.get("indicators", {}).get("quote", [{}])[0]
            opens   = quotes.get("open",   [])
            highs   = quotes.get("high",   [])
            lows    = quotes.get("low",    [])
            closes  = quotes.get("close",  [])
            volumes = quotes.get("volume", [])
            records = []
            for i, ts in enumerate(timestamps):
                try:
                    from datetime import datetime, timezone
                    date_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
                    c = float(closes[i]) if closes[i] is not None else None
                    if c is None:
                        continue
                    records.append((
                        symbol, date_str,
                        float(opens[i])   if opens[i]   is not None else c,
                        float(highs[i])   if highs[i]   is not None else c,
                        float(lows[i])    if lows[i]    is not None else c,
                        c,
                        int(volumes[i])   if volumes[i] is not None else 0,
                        # This gap-fill path hits Yahoo's v8 chart API directly (not the
                        # yfinance library), reading `quote.close` -- raw, with NEITHER
                        # split NOR dividend adjustment applied (unlike this file's other
                        # writer, _extract_records, which downloads via yf.download(...,
                        # auto_adjust=True)). A third distinct basis in the same table,
                        # found while fixing Finding #6 -- tagged accurately rather than
                        # mislabeled as either of the other two.
                        "unadjusted",
                    ))
                except (IndexError, TypeError, ValueError):
                    continue
            return records
        except Exception:
            return []


async def _gap_fill_async(
    conn,
    symbols: list,
    tickers: list,
    existing: dict,
    cutoff: str,
    today: str,
) -> int:
    """Download OHLCV for all symbols concurrently and upsert missing rows."""
    sem = asyncio.Semaphore(_GAP_FILL_CONCURRENCY)
    async with httpx.AsyncClient(headers=_HEADERS) as client:
        tasks = [
            _fetch_ohlcv_async(client, sym, tick, cutoff, today, sem)
            for sym, tick in zip(symbols, tickers)
        ]
        results = await asyncio.gather(*tasks)

    all_records = []
    for sym, records in zip(symbols, results):
        existing_dates = existing.get(sym, set())
        new_recs = [r for r in records if r[1] not in existing_dates]
        all_records.extend(new_recs)

    if all_records:
        _upsert(conn, all_records)
    return len(all_records)

def init_db(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS stock_ohlcv (
            symbol TEXT NOT NULL,
            date TEXT NOT NULL,
            open REAL,
            high REAL,
            low REAL,
            close REAL,
            volume INTEGER,
            PRIMARY KEY (symbol, date)
        )
    """)
    conn.commit()
    # adjustment_basis added 2026-07-30 (Finding #6, full-stack audit) -- see
    # mc_ohlcv_backfill.py's ensure_adjustment_basis_column() docstring. CREATE TABLE IF NOT
    # EXISTS above is a no-op on the live table, so an existing DB needs this ALTER too.
    try:
        conn.execute("ALTER TABLE stock_ohlcv ADD COLUMN adjustment_basis TEXT")
        conn.commit()
    except Exception:
        conn.rollback()
    print(f"[OK] stock_ohlcv table ready  [DB: {DB_PATH}]")

def get_all_nse_symbols(conn):
    try:
        rows = conn.execute("SELECT symbol FROM nse_stocks WHERE status = 'ACTIVE'").fetchall()
        if not rows:
            print("[WARN] No active stocks in nse_stocks - run syncNSEStocks first.")
            return []
        return [r[0] for r in rows]
    except Exception:
        print("[ERROR] Table nse_stocks not found - start the app to trigger NSE sync.")
        return []

def _extract_records(symbol: str, df: pd.DataFrame) -> list:
    """Convert a single-symbol OHLCV DataFrame to insert-ready tuples."""
    if df is None or df.empty:
        return []
    # Newer yfinance returns MultiIndex columns like ('Close', 'SYM.NS') even for
    # single-ticker downloads. Flatten to simple string column names.
    if isinstance(df.columns, pd.MultiIndex):
        df = df.droplevel(level=-1, axis=1)
    if "Close" not in df.columns:
        return []
    df = df.dropna(subset=["Close"])
    if df.empty:
        return []
    df = df.reset_index()
    date_col = "Date" if "Date" in df.columns else df.columns[0]
    records = []
    for _, row in df.iterrows():
        try:
            records.append((
                symbol,
                pd.to_datetime(row[date_col]).strftime("%Y-%m-%d"),
                float(row.get("Open",  row["Close"])),
                float(row.get("High",  row["Close"])),
                float(row.get("Low",   row["Close"])),
                float(row["Close"]),
                int(row.get("Volume", 0)),
                # Fixed 2026-07-30 (Finding #6, full-stack audit): this writer downloads
                # with auto_adjust=True (splits AND dividends) while mc_ohlcv_backfill.py's
                # deep-history rows are split-only -- see that file's
                # ensure_adjustment_basis_column() docstring for the live-verified
                # magnitude of the resulting discontinuity. Tagging every row lets
                # downstream consumers detect a straddling return window.
                "split_dividend",
            ))
        except Exception:
            continue
    return records

def _get_ticker_df(data: pd.DataFrame, ticker: str) -> pd.DataFrame | None:
    """Extract per-ticker DataFrame from a yfinance batch-download result.

    yfinance ≥ 0.2 returns a MultiIndex DataFrame in two possible orientations
    depending on the group_by parameter and the version:
      - group_by='ticker'  → level-0 = ticker, level-1 = price type
      - default            → level-0 = price type, level-1 = ticker
    We handle both, plus the single-ticker (flat columns) fallback.
    """
    if not isinstance(data.columns, pd.MultiIndex):
        return data  # single-ticker flat DataFrame

    levels = [data.columns.get_level_values(i).unique().tolist() for i in range(data.columns.nlevels)]

    if ticker in levels[0]:
        return data[ticker]
    if ticker in levels[1]:
        return data.xs(ticker, axis=1, level=1)
    return None

# Known NSE symbol → Yahoo Finance symbol mismatches
YAHOO_SYMBOL_MAP: dict[str, str] = {
    "KOTAK":        "KOTAKBANK",
    "INDUSIND":     "INDUSINDBK",
    "CENTRALBANK":  "CENTRALBK",
    "BANDHANBNK":   "BANDHANBNK",
    "FEDERALBNK":   "FEDERALBNK",
    "RBLBANK":      "RBLBANK",
    "KTKBANK":      "KTKBANK",
    "DCBBANK":      "DCBBANK",
    "KARURVYSYA":   "KARURVYSYA",
    "CSBBANK":      "CSBBANK",
    "SOUTHBANK":    "SOUTHBANK",
    "UJJIVANSFB":   "UJJIVANSFB",
    "EQUITASBNK":   "EQUITASBNK",
    "SURYODAY":     "SURYODAYBNK",
    "NYKAA":        "FSN",
    "POLICYBZR":    "POLICYBZR",
    "POLICYBAZAAR": "POLICYBZR",
    "PAYTM":        "ONE97",
    "ZOMATO":       "ZOMATO",
    "MAHINDRA":     "M&M",
    "SRTRANSFIN":   "SHRIRAMFIN",
    "CHOLAFINSV":   "CHOLAFIN",
    "LTFH":         "LTF",
    "LTIM":         "LTI",
    "BAJAJINSUR":   "BAJAJFINSV",
    "TATAMOTORS":   "TATAMTRDVR",
    "OBEROI":       "OBEROIRLTY",
    "LARSEN":       "LT",
    "NESTLE":       "NESTLEIND",
    "MCDOWELL":     "MCDOWELL-N",
    "VODAFONE":     "IDEA",
    "JIOFINANCIAL": "JIOFIN",
    "ONE97":        "ONE97",
}

# When a symbol fails, try these suffix/prefix patterns in order
_YAHOO_FALLBACK_PATTERNS = [
    lambda s: s + "BANK",
    lambda s: s + "BNK",
    lambda s: s[:-1] if s.endswith("K") else None,
    lambda s: s + "IND",
]

def _try_download(yahoo_symbol: str) -> pd.DataFrame | None:
    """Download a single Yahoo Finance ticker (no .NS suffix needed here)."""
    ticker = f"{yahoo_symbol}.NS"
    for attempt in range(2):
        try:
            df = yf.download(ticker, period="1y", progress=False, auto_adjust=True)
            if df is not None and not df.empty:
                return df
        except Exception:
            pass
        if attempt < 1:
            time.sleep(1)
    return None

def _download_one(symbol: str) -> pd.DataFrame | None:
    """Download with alias map + fallback pattern attempts."""
    # 1. Try mapped symbol first
    yahoo_sym = YAHOO_SYMBOL_MAP.get(symbol, symbol)
    df = _try_download(yahoo_sym)
    if df is not None:
        return df

    # 2. If the mapped symbol is different from original, no further guessing needed
    if yahoo_sym != symbol:
        return None

    # 3. Try common suffix/prefix patterns
    for pattern in _YAHOO_FALLBACK_PATTERNS:
        alt = pattern(symbol)
        if alt and alt != symbol:
            df = _try_download(alt)
            if df is not None:
                tqdm.write(f"  -> {symbol} resolved via alias {alt}.NS")
                return df

    return None

def _upsert(conn, records: list):
    trading, skipped = filter_holiday_records(records, conn)
    if skipped:
        holiday_dates = {r[1] for r in skipped}
        print(f"[HOLIDAY] Skipping {len(skipped)} rows on market holidays: {sorted(holiday_dates)}")
    if not trading:
        return
    conn.executemany(
        "INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume, adjustment_basis) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(symbol, date) DO UPDATE SET "
        "open=excluded.open, high=excluded.high, low=excluded.low, "
        "close=excluded.close, volume=excluded.volume, "
        "adjustment_basis=excluded.adjustment_basis",
        trading,
    )
    conn.commit()

def fetch_and_store(conn, symbols: list, batch_size: int = 50):
    failed = []

    with tqdm(total=len(symbols), unit="stock", desc="Backfilling") as bar:
        for i in range(0, len(symbols), batch_size):
            batch   = symbols[i : i + batch_size]
            # Apply alias map for batch download tickers
            tickers = [f"{YAHOO_SYMBOL_MAP.get(s, s)}.NS" for s in batch]
            retry   = list(batch)  # assume all need retry unless batch succeeds

            # ── batch download ────────────────────────────────────────────────
            try:
                data = yf.download(
                    tickers, period="1y", group_by="ticker",
                    threads=True, progress=False, auto_adjust=True,
                )
                records  = []
                retry    = []

                for symbol, ticker in zip(batch, tickers):
                    df = _get_ticker_df(data, ticker) if len(batch) > 1 else data
                    recs = _extract_records(symbol, df)
                    if recs:
                        records.extend(recs)
                    else:
                        retry.append(symbol)

                if records:
                    _upsert(conn, records)

                bar.update(len(batch) - len(retry))

            except Exception as e:
                tqdm.write(f"  Batch error — will retry individually: {e}")
                retry = list(batch)

            # ── individual retry for anything that failed in the batch ────────
            for symbol in retry:
                df   = _download_one(symbol)
                recs = _extract_records(symbol, df)
                if recs:
                    _upsert(conn, recs)
                else:
                    failed.append(symbol)
                    tqdm.write(f"  x {symbol}: no data")
                bar.update(1)
                time.sleep(0.3)

            time.sleep(1)  # rate-limit between batches

    if failed:
        print(f"\n[WARN] {len(failed)} symbols could not be fetched: {failed}")
    else:
        print("\n[OK] All symbols backfilled successfully!")

_INDEX_TICKERS_FALLBACK = {
    "NIFTY50": "^NSEI", "NIFTYBANK": "^NSEBANK", "NIFTYIT": "^CNXIT",
    "NIFTYPHARMA": "^CNXPHARMA", "NIFTYAUTO": "^CNXAUTO", "NIFTYFMCG": "^CNXFMCG",
    "NIFTYMETAL": "^CNXMETAL", "NIFTYMIDCAP": "^NSEMDCP50", "NIFTYSMALLCAP": "^CNXSC",
    "NIFTYREALTY": "^CNXREALTY", "NIFTYENERGY": "^CNXENERGY", "NIFTYINFRA": "^CNXINFRA",
}

def _get_index_tickers() -> dict[str, str]:
    """Load {index_name: yahoo_ticker} from DB (provider='yahoo')."""
    from db_compat import load_index_map_inv
    m = load_index_map_inv("yahoo")
    return m if m else _INDEX_TICKERS_FALLBACK


def fetch_indices(conn) -> None:
    """Backfill index OHLCV data — not in nse_stocks, fetched separately."""
    import pandas as pd

    for label, ticker in _get_index_tickers().items():
        try:
            df = yf.download(ticker, period="2y", progress=False, auto_adjust=True)
            if df is None or df.empty:
                print(f"[BACKFILL] No data for index {ticker}")
                continue

            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)

            recs = _extract_records(label, df)
            if recs:
                _upsert(conn, recs)
                print(f"[BACKFILL] {label}: {len(recs)} rows upserted into stock_ohlcv")
            else:
                print(f"[BACKFILL] {label}: no valid rows extracted")
        except Exception as e:
            print(f"[BACKFILL] ERROR {label}: {e}")


def gap_fill(conn, lookback_days: int = 30) -> None:
    """Fetch only missing trading days for symbols already in stock_ohlcv."""
    from datetime import datetime, timedelta

    cutoff = (datetime.today() - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    # stock_ohlcv.date is DATE on PG -> bind a date object for `date>=?` comparisons (rule #6).
    cutoff_d = (datetime.today() - timedelta(days=lookback_days)).date()
    symbols = [r[0] for r in conn.execute(
        "SELECT DISTINCT symbol FROM stock_ohlcv"
    ).fetchall()]

    if not symbols:
        print("[GAP-FILL] No symbols in stock_ohlcv yet — run full backfill first")
        return

    print(f"[GAP-FILL] Checking {len(symbols)} symbols for gaps since {cutoff}...")
    total_filled = 0

    batch_size = 50
    for i in range(0, len(symbols), batch_size):
        batch = symbols[i:i + batch_size]
        _idx_map = _get_index_tickers()
        tickers = [f"{YAHOO_SYMBOL_MAP.get(s, s)}.NS" if s not in _idx_map else _idx_map[s]
                   for s in batch]

        existing = {}
        for sym in batch:
            rows = conn.execute(
                "SELECT date FROM stock_ohlcv WHERE symbol=? AND date>=? ORDER BY date",
                (sym, cutoff_d),
            ).fetchall()
            existing[sym] = {str(r[0])[:10] for r in rows}

        try:
            data = yf.download(
                tickers, start=cutoff, group_by="ticker",
                threads=True, progress=False, auto_adjust=True,
            )
            records = []
            for symbol, ticker in zip(batch, tickers):
                df = _get_ticker_df(data, ticker) if len(batch) > 1 else data
                recs = _extract_records(symbol, df)
                if recs:
                    new_recs = [r for r in recs if r[1] not in existing.get(symbol, set())]
                    records.extend(new_recs)

            if records:
                _upsert(conn, records)
                total_filled += len(records)
            time.sleep(0.5)
        except Exception as e:
            print(f"[GAP-FILL] Error in batch {i//batch_size + 1}: {e}")

    # Also gap-fill indices
    for label, ticker in _get_index_tickers().items():
        try:
            existing_dates = {str(r[0])[:10] for r in conn.execute(
                "SELECT date FROM stock_ohlcv WHERE symbol=? AND date>=?", (label, cutoff_d)
            ).fetchall()}
            df = yf.download(ticker, start=cutoff, progress=False, auto_adjust=True)
            if df is not None and not df.empty:
                if isinstance(df.columns, pd.MultiIndex):
                    df.columns = df.columns.get_level_values(0)
                recs = _extract_records(label, df)
                new_recs = [r for r in recs if r[1] not in existing_dates]
                if new_recs:
                    _upsert(conn, new_recs)
                    total_filled += len(new_recs)
        except Exception as e:
            print(f"[GAP-FILL] ERROR index {label}: {e}")

    print(f"[GAP-FILL] Done — {total_filled} missing rows filled")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        choices=["full", "gap-fill", "indices"],
        default="full",
        help="full=backfill all NSE stocks (1y), gap-fill=fill missing recent days, indices=indices only",
    )
    parser.add_argument("--lookback", type=int, default=30,
                        help="Days to look back in gap-fill mode (default 30)")
    args = parser.parse_args()

    with connect() as conn:
        init_db(conn)

        if args.mode == "full":
            symbols = get_all_nse_symbols(conn)
            if symbols:
                print(f"Found {len(symbols)} active NSE stocks to backfill…")
                fetch_and_store(conn, symbols)
            fetch_indices(conn)
            print("Done.")

        elif args.mode == "indices":
            fetch_indices(conn)
            print("Done.")

        elif args.mode == "gap-fill":
            gap_fill(conn, lookback_days=args.lookback)
            print("Done.")

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)

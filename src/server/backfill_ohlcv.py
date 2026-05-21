import sqlite3
import yfinance as yf
import pandas as pd
import os
import time
from tqdm import tqdm

DB_PATH = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'database.sqlite'))

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
    print(f"✓ stock_ohlcv table ready  [DB: {DB_PATH}]")

def get_all_nse_symbols(conn):
    try:
        rows = conn.execute("SELECT symbol FROM nse_stocks WHERE status = 'ACTIVE'").fetchall()
        if not rows:
            print("⚠️  No active stocks in nse_stocks — run syncNSEStocks first.")
            return []
        return [r[0] for r in rows]
    except sqlite3.OperationalError:
        print("❌  Table nse_stocks not found — start the app to trigger NSE sync.")
        return []

def _extract_records(symbol: str, df: pd.DataFrame) -> list:
    """Convert a single-symbol OHLCV DataFrame to insert-ready tuples."""
    if df is None or df.empty:
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
    "PAYTM":        "ONE97",
    "ZOMATO":       "ZOMATO",
    "MAHINDRA":     "M&M",
    "SRTRANSFIN":   "SHRIRAMFIN",
    "CHOLAFINSV":   "CHOLAFIN",
    "LTFH":         "LTF",
    "BAJAJINSUR":   "BAJAJFINSV",
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
    for attempt in range(3):
        try:
            df = yf.download(ticker, period="1y", progress=False, auto_adjust=True)
            if df is not None and not df.empty:
                return df
        except Exception:
            pass
        if attempt < 2:
            time.sleep(2 ** attempt)
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
                tqdm.write(f"  ↳ {symbol} resolved via alias {alt}.NS")
                return df

    return None

def _upsert(conn, records: list):
    conn.executemany(
        "INSERT OR REPLACE INTO stock_ohlcv (symbol, date, open, high, low, close, volume) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        records,
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
                    tqdm.write(f"  ✗ {symbol}: no data")
                bar.update(1)
                time.sleep(0.3)

            time.sleep(1)  # rate-limit between batches

    if failed:
        print(f"\n⚠️  {len(failed)} symbols could not be fetched: {failed}")
    else:
        print("\n✓  All symbols backfilled successfully!")

if __name__ == "__main__":
    with sqlite3.connect(DB_PATH) as conn:
        init_db(conn)
        symbols = get_all_nse_symbols(conn)
        if symbols:
            print(f"Found {len(symbols)} active NSE stocks to backfill…")
            fetch_and_store(conn, symbols)
            print("Done.")

#!/usr/bin/env python3
"""
MoneyControl deep-history OHLCV backfill
========================================
The ML models (breakout classifier, ensemble, calibration) are starved: stock_ohlcv
only had ~1.5y of usable history, so every feature engine and label is thin. MoneyControl's
techCharts endpoint returns split-adjusted daily OHLCV+volume back to 2000 for the RAW NSE
symbol in a single call — verified: NESTLEIND's 1:2 split shows no fake cliff, so it is
back-adjusted and consistent with our yfinance-adjusted rows.

Fetches in parallel (I/O-bound; MC tolerates 12-16 concurrent with no throttling — ~0.34s/
req, so ~2400 symbols in ~2 min) then bulk-upserts sequentially. Default is ON CONFLICT DO
NOTHING so it only EXTENDS history backward and fills gaps — it never overwrites the live
yfinance-maintained recent rows (avoids an adjustment-basis seam). Pass --overwrite to force.

Run:
    python mc_ohlcv_backfill.py                       # all NSE symbols, from 2021
    python mc_ohlcv_backfill.py --from-year 2023      # shallower
    python mc_ohlcv_backfill.py --limit 50            # test subset
    python mc_ohlcv_backfill.py --symbols BEL,INFY    # specific names
"""

import polars as pl
import argparse
import datetime
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from db_compat import connect, read_df, translate, use_postgres, get_engine

URL = "https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
}
MAX_TS = 1783900800   # ~2026-07; countback grabs the full series regardless
COUNTBACK = 12772     # ~50y of trading days — asks for everything available
INSERT_CHUNK = 5000   # 7 cols × 5000 = 35k binds, under PG's 65535 ceiling


def load_symbols(limit: int | None, only: list[str] | None) -> list[str]:
    if only:
        return only
    df = read_df("SELECT symbol FROM nse_stocks WHERE symbol IS NOT NULL ORDER BY symbol")
    syms = [str(s) for s in df["symbol"].tolist()]
    return syms[:limit] if limit else syms


def fetch_one(sym: str, session: requests.Session, from_year: int) -> tuple:
    """Returns (symbol, status, rows) where rows is a list of (symbol,date,o,h,l,c,v)."""
    from_ts = int(datetime.datetime(from_year, 1, 1).timestamp())
    try:
        r = session.get(URL, params={
            "symbol": sym, "resolution": "1D", "from": 239068800,
            "to": MAX_TS, "countback": COUNTBACK, "currencyCode": "INR",
        }, timeout=25)
        if r.status_code != 200:
            return (sym, f"HTTP{r.status_code}", [])
        j = r.json()
        if j.get("s") != "ok":
            return (sym, f"s={j.get('s')}", [])
        t = j.get("t", [])
        o, h, l, c, v = j.get("o", []), j.get("h", []), j.get("l", []), j.get("c", []), j.get("v", [])
        rows = []
        for i in range(len(t)):
            d = datetime.date.fromtimestamp(t[i])
            if d.year < from_year:
                continue
            # skip degenerate bars (missing close / non-positive)
            if c[i] is None or c[i] <= 0:
                continue
            rows.append((sym, d.isoformat(), o[i], h[i], l[i], c[i],
                         int(v[i]) if v[i] is not None else None, "split_only"))
        return (sym, "ok", rows)
    except Exception as e:
        return (sym, f"ERR:{str(e)[:40]}", [])


def ensure_adjustment_basis_column(conn) -> None:
    """Fixed 2026-07-30 (Finding #6, full-stack audit): this writer produces SPLIT-ONLY
    adjusted prices; the weekly backfill_ohlcv.py (yfinance auto_adjust=True) produces
    SPLIT+DIVIDEND adjusted prices for the same table -- verified live (ITC.NS, 2026-07-30):
    yfinance's dividend adjustment alone shifted a 90-day-old bar by ~2.65%, a real,
    material discontinuity at whichever row the two writers' date ranges meet, worst for
    high-yield names. Tagging every row with which basis wrote it is the safe, additive
    first step (Finding #6's option (b)) -- it does NOT rewrite price-adjustment math
    (higher-risk, not attempted here), but lets downstream consumers
    (relative_strength.py/ml_ensemble.py/breakout_classifier.py) detect and correct for a
    straddling return window instead of silently absorbing the step artifact.
    """
    cur = conn.cursor()
    try:
        cur.execute("ALTER TABLE stock_ohlcv ADD COLUMN adjustment_basis TEXT")
        conn.commit()
    except Exception:
        conn.rollback()


def upsert(conn, rows: list[tuple], overwrite: bool) -> int:
    """Bulk upsert. On Postgres uses psycopg2 execute_values (one multi-row INSERT per
    chunk) — orders of magnitude faster than per-row executemany, which turned a ~2-min
    fetch into a ~1-hour write. Falls back to executemany on SQLite (tests)."""
    if not rows:
        return 0
    conflict = ("DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, "
                "close=excluded.close, volume=excluded.volume, "
                "adjustment_basis=excluded.adjustment_basis" if overwrite else "DO NOTHING")
    if use_postgres():
        from psycopg2.extras import execute_values
        sql = ("INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume, adjustment_basis) "
               "VALUES %s ON CONFLICT (symbol, date) " + conflict)
        written = 0
        # Write through the CALLER'S connection when it has one. This used to be an
        # unconditional `get_engine().raw_connection()`, which ignored the `conn` argument
        # entirely: get_engine() is a separate pool that does NOT carry the caller's
        # search_path, so every row landed in `public` no matter which schema the caller was
        # scoped to. Live-caught 2026-08-16 -- the mc_ohlcv_backfill live test wrote 252
        # RELIANCE bars into the real stock_ohlcv while reading back through its own throwaway
        # schema and seeing nothing ("upsert() reported success but wrote no row"). On a
        # developer box that target is PRODUCTION. Same family as recurring-bugs.md's
        # "writes through one engine, reads through another", but in production code, where it
        # silently defeats any scoped caller rather than just a test.
        inner = getattr(conn, "_conn", None)          # db_compat.ConnWrapper -> SA Connection
        borrowed = inner is not None and hasattr(inner, "connection")
        raw = inner.connection if borrowed else get_engine().raw_connection()
        try:
            # One transaction PER CHUNK (not one big commit): a chunk that trips a
            # compressed-chunk ON CONFLICT error or a lock timeout must roll back ONLY itself
            # and be logged LOUDLY — the original single-commit version swallowed such failures
            # so whole symbols silently never landed (RELIANCE et al. showed only recent bars).
            # Commit via the SQLAlchemy Connection when borrowed, so its transaction state
            # stays consistent with what we just executed on its DBAPI handle.
            for i in range(0, len(rows), INSERT_CHUNK):
                batch = rows[i:i + INSERT_CHUNK]
                try:
                    cur = raw.cursor()
                    execute_values(cur, sql, batch, page_size=INSERT_CHUNK)
                    (inner if borrowed else raw).commit()
                    written += len(batch)
                except Exception as e:
                    (inner if borrowed else raw).rollback()
                    print(f"[MCBackfill] UPSERT ERROR on {len(batch)}-row batch "
                          f"({batch[0][0]}..{batch[-1][0]}): {type(e).__name__}: {str(e)[:160]}")
        finally:
            if not borrowed:
                raw.close()
        return written
    # SQLite fallback
    sql = translate(
        "INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume, adjustment_basis) "
        "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (symbol, date) " + conflict)
    cur = conn.cursor()
    for i in range(0, len(rows), INSERT_CHUNK):
        cur.executemany(sql, rows[i:i + INSERT_CHUNK])
    conn.commit()
    return len(rows)


def run(from_year: int, workers: int, limit: int | None,
        only: list[str] | None, overwrite: bool) -> dict:
    syms = load_symbols(limit, only)
    print(f"[MCBackfill] {len(syms)} symbols, from {from_year}, {workers} workers, "
          f"{'OVERWRITE' if overwrite else 'fill-only'}")
    conn = connect()
    ensure_adjustment_basis_column(conn)
    session = requests.Session()
    session.headers.update(HEADERS)

    t0 = time.time()
    ok = failed = total_rows = 0
    fail_syms = []

    # Fetch in parallel (I/O-bound) but write ONE SYMBOL PER TRANSACTION in the main
    # thread. An earlier version accumulated rows across symbols and flushed interleaved
    # 5000-row chunks; under concurrent stock_ohlcv writers (ml-daily-ops) + compressed
    # chunks that silently dropped some symbols' rows with no error. Per-symbol atomic
    # writes match the pattern that works reliably in isolation.
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(fetch_one, s, session, from_year): s for s in syms}
        done = 0
        for f in as_completed(futs):
            sym, status, rows = f.result()
            done += 1
            if status == "ok" and rows:
                ok += 1
                total_rows += upsert(conn, rows, overwrite)
            else:
                failed += 1
                fail_syms.append(f"{sym}({status})")
            if done % 200 == 0:
                print(f"[MCBackfill]   {done}/{len(syms)} done "
                      f"({ok} ok, {failed} failed, {total_rows} rows)...")

    conn.close()
    dt = time.time() - t0
    print(f"[MCBackfill] DONE in {dt:.0f}s: {ok} ok / {failed} failed / {total_rows} rows written")
    if fail_syms:
        print(f"[MCBackfill] failures ({len(fail_syms)}): {', '.join(fail_syms[:40])}"
              + (" ..." if len(fail_syms) > 40 else ""))
    return {"ok": ok, "failed": failed, "rows": total_rows, "seconds": round(dt)}


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="MoneyControl deep-history OHLCV backfill")
    p.add_argument("--from-year", type=int, default=2021, help="Earliest bar year to keep (default 2021)")
    p.add_argument("--workers", type=int, default=12, help="Parallel fetch workers (12-16 safe)")
    p.add_argument("--limit", type=int, help="Only the first N symbols (testing)")
    p.add_argument("--symbols", help="Comma-separated specific NSE symbols")
    p.add_argument("--overwrite", action="store_true", help="Overwrite existing rows (default: fill-only)")
    args = p.parse_args()
    only = [s.strip().upper() for s in args.symbols.split(",")] if args.symbols else None
    run(args.from_year, args.workers, args.limit, only, args.overwrite)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)

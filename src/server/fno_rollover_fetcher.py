#!/usr/bin/env python3
"""
F&O Rollover and Cost-of-Carry Fetcher
=======================================
Downloads NSE's daily F&O bhavcopies (BhavCopy_NSE_FO_0_0_0_{YYYYMMDD}_F_0000.csv.zip)
and computes per-symbol rollover % and cost of carry from stock futures OI.

Rollover %  = next_month_OI / (near_month_OI + next_month_OI) × 100
              High rollover + rising price → bullish continuation (institutions staying long).
              Low rollover + falling price → bearish unwinding.

Cost of carry = (near_futures_close - spot) / spot × 100 / DTE × 365  (annualized %)
              Positive → contango (bullish expectation)
              Negative → backwardation (bearish expectation / dividend effect)

Writes to:
  fno_rollover  (symbol, date, near_expiry, next_expiry, near_oi, next_oi, total_oi,
                 rollover_pct, cost_of_carry_ann, spot_price, near_close)
  technical_signals.rollover_pct, .cost_of_carry_ann (back-filled for today)

Run:
  python fno_rollover_fetcher.py              # yesterday / last trading day
  python fno_rollover_fetcher.py --days 30    # backfill last 30 trading days
  python fno_rollover_fetcher.py --date 2026-06-24  # specific date
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class FnoRolloverFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class FnoRolloverFetcherBaseFetcher(BaseFetcher[FnoRolloverFetcherSchema]):
    fetcher_name = 'FnoRolloverFetcher'
    domain = 'general'
    schema = FnoRolloverFetcherSchema
    min_interval_sec = 0.5


import argparse
import io
import sys
import time
import zipfile
from datetime import date, datetime, timedelta

import pandas as pd
import requests

from db_compat import connect, safe_alter
from fetch_utils import retry_get

BHAVCOPY_URL = (
    "https://nsearchives.nseindia.com/content/fo/"
    "BhavCopy_NSE_FO_0_0_0_{date}_F_0000.csv.zip"
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/124.0.0.0"
    ),
    "Accept": "*/*",
    "Referer": "https://nseindia.com/",
}

RATE_LIMIT_SEC = 1.0  # between downloads

# db_compat.translate() converts ? → $N for Postgres automatically; use ? everywhere.
PH = "?"


# ── Schema ─────────────────────────────────────────────────────────────────────

def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fno_rollover (
            symbol            TEXT NOT NULL,
            date              TEXT NOT NULL,
            near_expiry       TEXT,
            next_expiry       TEXT,
            near_oi           BIGINT,
            next_oi           BIGINT,
            total_oi          BIGINT,
            rollover_pct      REAL,
            cost_of_carry_ann REAL,
            spot_price        REAL,
            near_close        REAL,
            fetched_at        TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    # Indexes for fast joins
    for idx in [
        "CREATE INDEX IF NOT EXISTS idx_fnor_date   ON fno_rollover(date)",
        "CREATE INDEX IF NOT EXISTS idx_fnor_symbol ON fno_rollover(symbol, date DESC)",
    ]:
        cur.execute(idx)

    # Columns on technical_signals
    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN rollover_pct      REAL",
        "ALTER TABLE technical_signals ADD COLUMN cost_of_carry_ann REAL",
    ]:
        safe_alter(con, ddl)


    con.commit()


# ── Download ────────────────────────────────────────────────────────────────────

def _trading_days_back(n: int, con=None) -> list[date]:
    """Real trading sessions, newest first. Shared helper -- the previous weekday-only
    version was holiday-blind (see as_of.trading_days_back)."""
    from as_of import trading_days_back
    return trading_days_back(n, con)


def fetch_bhavcopy(trade_date: date, session: requests.Session) -> pd.DataFrame | None:
    """Download and parse the F&O bhavcopy for `trade_date`. Returns None on failure."""
    url = BHAVCOPY_URL.format(date=trade_date.strftime("%Y%m%d"))
    try:
        r = retry_get(session, url, timeout=20)
    except Exception as e:
        status = getattr(getattr(e, 'response', None), 'status_code', None)
        if status == 404:
            return None  # holiday / non-trading day
        print(f"[Rollover] {trade_date}: download failed after retries — {e}", file=sys.stderr)
        return None
    try:
        z = zipfile.ZipFile(io.BytesIO(r.content))
        with z.open(z.namelist()[0]) as f:
            df = pd.read_csv(f, dtype=str)
        return df
    except Exception as e:
        print(f"[Rollover] {trade_date}: parse failed — {e}", file=sys.stderr)
        return None


# ── Computation ─────────────────────────────────────────────────────────────────

def compute_rollover(df: pd.DataFrame, trade_date: date) -> list[dict]:
    """Compute rollover % and cost of carry from a single day's bhavcopy."""
    # STF = Stock (equity) Futures; IDF = Index Futures (excluded — use Nifty separately)
    fut = df[df["FinInstrmTp"] == "STF"].copy()
    if fut.empty:
        return []

    fut["XpryDt"]    = pd.to_datetime(fut["XpryDt"])
    fut["OpnIntrst"] = pd.to_numeric(fut["OpnIntrst"],   errors="coerce").fillna(0)
    fut["ClsPric"]   = pd.to_numeric(fut["ClsPric"],     errors="coerce")
    fut["UndrlygPric"] = pd.to_numeric(fut["UndrlygPric"], errors="coerce")

    rows = []
    for sym, grp in fut.groupby("TckrSymb"):
        grp_sorted = grp.sort_values("XpryDt")
        expiries = grp_sorted["XpryDt"].unique()
        if len(expiries) < 2:
            continue  # need at least near + next to compute rollover

        near_exp = expiries[0]
        next_exp = expiries[1]

        near_rows = grp_sorted[grp_sorted["XpryDt"] == near_exp]
        next_rows = grp_sorted[grp_sorted["XpryDt"] == next_exp]

        near_oi = int(near_rows["OpnIntrst"].sum())
        next_oi = int(next_rows["OpnIntrst"].sum())
        total   = near_oi + next_oi

        rollover_pct = round(next_oi / total * 100, 4) if total > 0 else None

        # Cost of carry: annualised basis (near futures vs underlying)
        near_row = near_rows.iloc[0]
        spot      = near_row["UndrlygPric"]
        near_cls  = near_row["ClsPric"]
        dte       = (near_exp.date() - trade_date).days
        cost_of_carry = None
        if pd.notna(spot) and spot > 0 and pd.notna(near_cls) and dte > 0:
            cost_of_carry = round(
                (near_cls - spot) / spot * 100 / dte * 365, 4
            )

        rows.append({
            "symbol":            str(sym),
            "date":              trade_date.isoformat(),
            "near_expiry":       near_exp.strftime("%Y-%m-%d"),
            "next_expiry":       next_exp.strftime("%Y-%m-%d"),
            "near_oi":           int(near_oi),
            "next_oi":           int(next_oi),
            "total_oi":          int(total),
            "rollover_pct":      float(rollover_pct) if rollover_pct is not None else None,
            "cost_of_carry_ann": float(cost_of_carry) if cost_of_carry is not None else None,
            "spot_price":        float(spot)     if pd.notna(spot)     else None,
            "near_close":        float(near_cls) if pd.notna(near_cls) else None,
        })

    return rows


# ── Persist ─────────────────────────────────────────────────────────────────────

def upsert_rows(rows: list[dict], con) -> None:
    if not rows:
        return
    cur = con.cursor()

    for r in rows:
        cur.execute("""
            INSERT INTO fno_rollover
                (symbol, date, near_expiry, next_expiry, near_oi, next_oi, total_oi,
                 rollover_pct, cost_of_carry_ann, spot_price, near_close)
            VALUES
                (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(symbol, date) DO UPDATE SET
                near_expiry       = excluded.near_expiry,
                next_expiry       = excluded.next_expiry,
                near_oi           = excluded.near_oi,
                next_oi           = excluded.next_oi,
                total_oi          = excluded.total_oi,
                rollover_pct      = excluded.rollover_pct,
                cost_of_carry_ann = excluded.cost_of_carry_ann,
                spot_price        = excluded.spot_price,
                near_close        = excluded.near_close,
                fetched_at        = CURRENT_TIMESTAMP
        """, (
            r["symbol"], r["date"], r["near_expiry"], r["next_expiry"],
            r["near_oi"], r["next_oi"], r["total_oi"],
            r["rollover_pct"], r["cost_of_carry_ann"],
            r["spot_price"], r["near_close"],
        ))

    con.commit()


def backfill_technical_signals(today: str, con) -> int:
    """Write today's rollover data into technical_signals for the ML pipeline."""
    cur = con.cursor()
    # technical_signals uses 'date' column (not 'signal_date' — that's signal_outcomes).
    cur.execute("""
        UPDATE technical_signals
        SET rollover_pct = (
            SELECT rollover_pct FROM fno_rollover
            WHERE symbol = technical_signals.symbol AND date = ?
            LIMIT 1
        ),
        cost_of_carry_ann = (
            SELECT cost_of_carry_ann FROM fno_rollover
            WHERE symbol = technical_signals.symbol AND date = ?
            LIMIT 1
        )
        WHERE date = ?
    """, (today, today, today))
    updated = cur.rowcount
    con.commit()
    return updated


# ── Main ────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days",  type=int, default=1,
                        help="Backfill last N trading days (default: 1 = yesterday)")
    parser.add_argument("--date",  type=str, default=None,
                        help="Fetch a single specific date (YYYY-MM-DD)")
    parser.add_argument("--force", action="store_true", default=False,
                        help="Force re-fetch and re-compute even if date is already populated")
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    session = requests.Session()
    session.headers.update(HEADERS)

    if args.date:
        dates = [datetime.strptime(args.date, "%Y-%m-%d").date()]
    else:
        dates = _trading_days_back(args.days)

    cur = con.cursor()
    total_rows = 0
    for i, trade_date in enumerate(dates):
        d_str = trade_date.isoformat()
        if not args.force:
            cur.execute("SELECT count(*) FROM fno_rollover WHERE date = ?", (d_str,))
            row = cur.fetchone()
            existing_cnt = row[0] if row else 0
            if existing_cnt and existing_cnt >= 180:
                print(f"[Rollover] {trade_date}: already populated with {existing_cnt} symbols. Skipping download.")
                total_rows += existing_cnt
                continue

        print(f"[Rollover] Fetching {trade_date} ({i+1}/{len(dates)})…")
        raw = fetch_bhavcopy(trade_date, session)
        if raw is None:
            print(f"[Rollover] {trade_date}: skipped (holiday or not yet published)")
            continue

        rows = compute_rollover(raw, trade_date)
        upsert_rows(rows, con)
        print(f"[Rollover] {trade_date}: {len(rows)} symbols saved")
        total_rows += len(rows)


        if i < len(dates) - 1:
            time.sleep(RATE_LIMIT_SEC)

    # Back-fill technical_signals for today / most recent date
    most_recent = dates[0].isoformat() if dates else None
    if most_recent:
        updated = backfill_technical_signals(most_recent, con)
        print(f"[Rollover] Updated {updated} technical_signals rows for {most_recent}")

    print(f"[Rollover] Done. Total rows: {total_rows}")
    con.close()


if __name__ == "__main__":
    main()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)

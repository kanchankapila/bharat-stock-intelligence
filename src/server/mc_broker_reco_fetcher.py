"""
MoneyControl Broker Research Recommendations Fetcher
=====================================================
Fetches broker/analyst buy-sell recommendations from the MC pre-market API and
stores them in mc_broker_reco. Then backfills three feature columns on
technical_signals so ml_ensemble can consume them:

  mc_broker_buy_7d   — count of BUY / STRONG BUY recs in last N days
  mc_broker_sell_7d  — count of SELL / STRONG SELL recs in last N days
  mc_broker_upside   — avg analyst upside % from most recent BUY recs
                       = (target / recommended_price − 1) × 100

scId→NSE mapping is done via mc_pricefeed_daily.scid which was populated by
mc_pricefeed_fetcher. Any scId without a match in that table is silently skipped.

Run:  python mc_broker_reco_fetcher.py             # fetch + backfill (7-day window)
      python mc_broker_reco_fetcher.py --days 14   # wider backfill window
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class McBrokerRecoFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class McBrokerRecoFetcherBaseFetcher(BaseFetcher[McBrokerRecoFetcherSchema]):
    fetcher_name = 'McBrokerRecoFetcher'
    domain = 'moneycontrol.com'
    schema = McBrokerRecoFetcherSchema
    min_interval_sec = 0.5


import argparse
import datetime
import sys

import pandas as pd

from db_compat import connect, translate, read_df, executemany
from fetch_utils import retry_get

try:
    from curl_cffi import requests as cffi_req
except ImportError:
    cffi_req = None  # will raise at fetch time with a clear message

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BASE_URL = (
    "https://api.moneycontrol.com/mcapi/v1/premarket/getBrokerResearchReco"
    "?sublevel=stocks&start={start}&limit=100"
)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Origin": "https://www.moneycontrol.com",
    "Referer": "https://www.moneycontrol.com/",
    "Accept": "application/json",
}

MAX_PAGES = 15      # Page through smaller limit batches to avoid timeouts
PAGE_SIZE = 100
FETCH_LOOKBACK_DAYS = 10   # stop paging once entry_date is older than this

BUY_FLAGS  = {"BUY", "STRONG BUY", "OUTPERFORM", "ACCUMULATE", "ADD"}
SELL_FLAGS = {"SELL", "STRONG SELL", "UNDERPERFORM", "REDUCE", "AVOID"}


# ---------------------------------------------------------------------------
# Schema helpers
# ---------------------------------------------------------------------------

def ensure_schema(con) -> None:
    """Create mc_broker_reco table and add feature columns to technical_signals."""
    # Main reco table
    try:
        con.execute(translate("""
            CREATE TABLE IF NOT EXISTS mc_broker_reco (
                scid              TEXT NOT NULL,
                stock_name        TEXT,
                organization      TEXT NOT NULL,
                recommend_flag    TEXT,
                recommended_price REAL,
                target            REAL,
                entry_date        TEXT,
                recommend_date    TEXT,
                fetched_at        TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (scid, organization, entry_date)
            )
        """))
        con.commit()
    except Exception as exc:
        try:
            con.rollback()
        except Exception:
            pass
        print(f"[BrokerReco] WARN: could not create mc_broker_reco: {exc}", file=sys.stderr)

    # Feature columns on technical_signals
    feature_cols = [
        ("mc_broker_buy_7d",  "INTEGER"),
        ("mc_broker_sell_7d", "INTEGER"),
        ("mc_broker_upside",  "REAL"),
    ]
    for col, dtype in feature_cols:
        try:
            con.execute(translate(
                f"ALTER TABLE technical_signals ADD COLUMN {col} {dtype}"
            ))
            con.commit()
            print(f"[BrokerReco] Added column technical_signals.{col}")
        except Exception:
            try:
                con.rollback()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------

def fetch_recos(lookback_days: int = FETCH_LOOKBACK_DAYS) -> list[dict]:
    """Page through the MC broker-reco API, keeping every rec within lookback_days.

    The API's reco_data is NOT sorted chronologically -- live-verified 2026-07-31: a single
    100-row page mixed entry_dates from 2025-04-29 through 2026-07-28 in no discernible order
    (first 5 rows: 2026-04-29, 2026-06-12, 2025-04-29, 2025-11-06, 2026-05-05; last 5 rows of
    the SAME page: all 2026-07-28). An earlier version of this function assumed newest-first
    ordering and broke out of the whole fetch on the FIRST stale row encountered per page --
    since stale rows can appear anywhere, this silently discarded genuinely recent recs sitting
    later in the same page, and could return a fully empty result on a day the first row
    happened to be old (root-caused via a live_datasource test that reproduced exactly this:
    the real endpoint returned 97 real recs including several from 3 days ago, but
    fetch_recos() returned []). Fixed to filter every row on every page without early-exit,
    paging up to MAX_PAGES (already bounded for timeout reasons) or until a page returns no
    data at all (genuine end of dataset)."""
    if cffi_req is None:
        raise ImportError(
            "curl_cffi is required: pip install curl-cffi"
        )

    cutoff = datetime.datetime.now() - datetime.timedelta(days=lookback_days)
    all_recos: list[dict] = []

    for page in range(MAX_PAGES):
        start = page * PAGE_SIZE
        url = BASE_URL.format(start=start)
        try:
            resp = retry_get(cffi_req, url, headers=HEADERS, impersonate="chrome120", timeout=30)
            payload = resp.json()
        except Exception as exc:
            print(f"[BrokerReco] WARN: page {page} fetch failed after retries: {exc}", file=sys.stderr)
            break

        if not payload.get("success"):
            print(f"[BrokerReco] WARN: API returned success=0 on page {page}")
            break

        reco_data = payload.get("data", {}).get("reco_data", [])
        if not reco_data:
            break

        for rec in reco_data:
            entry_date_str = rec.get("entry_date", "")
            try:
                entry_dt = datetime.datetime.strptime(entry_date_str[:19], "%Y-%m-%d %H:%M:%S")
            except ValueError:
                entry_dt = datetime.datetime.now()

            if entry_dt < cutoff:
                continue

            all_recos.append({
                "scid":              rec.get("scId", ""),
                "stock_name":        rec.get("stock_name", ""),
                "organization":      rec.get("organization", ""),
                "recommend_flag":    (rec.get("recommend_flag") or "").upper().strip(),
                "recommended_price": _to_float(rec.get("recommended_price")),
                "target":            _to_float(rec.get("target")),
                "entry_date":        entry_date_str,
                "recommend_date":    rec.get("recommend_date", ""),
            })

    return all_recos


def _to_float(val) -> float | None:
    try:
        return float(val) if val not in (None, "", "0") else None
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Persist
# ---------------------------------------------------------------------------

def upsert_recos(recos: list[dict]) -> None:
    """Insert-or-replace fetched recs into mc_broker_reco."""
    if not recos:
        return

    rows = [
        (
            r["scid"], r["stock_name"], r["organization"], r["recommend_flag"],
            r["recommended_price"], r["target"], r["entry_date"], r["recommend_date"],
        )
        for r in recos
    ]

    sql = translate("""
        INSERT INTO mc_broker_reco
            (scid, stock_name, organization, recommend_flag,
             recommended_price, target, entry_date, recommend_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (scid, organization, entry_date) DO UPDATE SET
            stock_name        = excluded.stock_name,
            recommend_flag    = excluded.recommend_flag,
            recommended_price = excluded.recommended_price,
            target            = excluded.target,
            recommend_date    = excluded.recommend_date,
            fetched_at        = CURRENT_TIMESTAMP
    """)
    executemany(sql, rows)


# ---------------------------------------------------------------------------
# Backfill technical_signals
# ---------------------------------------------------------------------------

def backfill_technical_signals(days: int) -> int:
    """Compute broker-reco features per NSE symbol and write to technical_signals.

    Returns the number of symbols updated.
    """
    # Pull recs joined to NSE symbols via nse_stocks
    reco_sql = translate(f"""
        SELECT p.symbol,
               r.recommend_flag,
               r.recommended_price,
               r.target,
               r.entry_date
        FROM mc_broker_reco r
        JOIN nse_stocks p ON p.mcsymbol = r.scid
        WHERE r.entry_date >= CAST({_date_offset_expr(days)} AS TEXT)
    """)
    df = read_df(reco_sql)
    if df.empty:
        return 0

    df["recommend_flag"] = df["recommend_flag"].str.upper().str.strip()
    df["recommended_price"] = pd.to_numeric(df["recommended_price"], errors="coerce")
    df["target"] = pd.to_numeric(df["target"], errors="coerce")

    # Upside only meaningful where both price and target are available and price > 0
    df["upside_pct"] = None
    mask = (
        df["recommended_price"].notna()
        & df["target"].notna()
        & (df["recommended_price"] > 0)
        & df["recommend_flag"].isin(BUY_FLAGS)
    )
    df.loc[mask, "upside_pct"] = (
        (df.loc[mask, "target"] / df.loc[mask, "recommended_price"]) - 1
    ) * 100

    # Aggregate per symbol
    agg = (
        df.groupby("symbol")
        .apply(_agg_symbol, include_groups=False)
        .reset_index()
    )

    # Find the most-recent date in technical_signals per symbol (update that row)
    symbols = agg["symbol"].tolist()
    if not symbols:
        return 0

    placeholders = ",".join(["?" for _ in symbols])
    latest_sql = translate(f"""
        SELECT symbol, MAX(date) AS date
        FROM technical_signals
        WHERE symbol IN ({placeholders})
        GROUP BY symbol
    """)
    latest_df = read_df(latest_sql, params=symbols)
    if latest_df.empty:
        return 0

    merged = agg.merge(latest_df, on="symbol", how="inner")
    if merged.empty:
        return 0

    update_sql = translate("""
        UPDATE technical_signals
        SET mc_broker_buy_7d  = ?,
            mc_broker_sell_7d = ?,
            mc_broker_upside  = ?
        WHERE symbol = ? AND date = ?
    """)
    rows = [
        (
            int(row["buy_count"]),
            int(row["sell_count"]),
            row["avg_upside"] if pd.notna(row["avg_upside"]) else None,
            row["symbol"],
            row["date"],
        )
        for _, row in merged.iterrows()
    ]
    executemany(update_sql, rows)
    return len(rows)


def _agg_symbol(grp: pd.DataFrame) -> pd.Series:
    buy_count  = grp["recommend_flag"].isin(BUY_FLAGS).sum()
    sell_count = grp["recommend_flag"].isin(SELL_FLAGS).sum()
    buy_upside = grp.loc[grp["recommend_flag"].isin(BUY_FLAGS), "upside_pct"]
    avg_upside = buy_upside.mean() if not buy_upside.empty else None
    return pd.Series({"buy_count": buy_count, "sell_count": sell_count, "avg_upside": avg_upside})


def _date_offset_expr(days: int) -> str:
    """Return a SQL expression for (now − days) compatible with both SQLite and PG."""
    # translate() converts SQLite dialect; date('now', '-Nd') works in SQLite;
    # for Postgres db_compat.translate handles the rewrite to NOW() - INTERVAL.
    return f"date('now', '-{days} days')"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch MC broker recos + backfill technical_signals")
    parser.add_argument("--days", type=int, default=7,
                        help="Lookback window (days) for technical_signals backfill (default 7)")
    args = parser.parse_args()

    # Ensure schema exists
    con = connect()
    ensure_schema(con)
    con.close()

    # Fetch
    recos = fetch_recos(lookback_days=max(args.days, FETCH_LOOKBACK_DAYS))
    print(f"[BrokerReco] Fetched {len(recos)} recs.")
    if not recos:
        # An empty result after retries most often means the upstream API is down or the
        # response shape changed — surface this as a real failure instead of a silent no-op
        # that would otherwise look identical to "no new recos today" in the job monitor.
        print("[BrokerReco] ERROR: 0 recos fetched — treating as a failed run.")
        sys.exit(1)

    # Persist
    upsert_recos(recos)

    # Backfill
    updated = backfill_technical_signals(args.days)
    print(f"[BrokerReco] Fetched {len(recos)} recs. Updated {updated} symbols in technical_signals.")


if __name__ == "__main__":
    main()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)

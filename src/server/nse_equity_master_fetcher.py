#!/usr/bin/env python3
"""Reconcile the rankable stock master with NSE's official equity and ETF catalogues.

Product policy:
* rank equities, not ETFs/funds;
* admit a current NSE equity only after 60 observed bhavcopy sessions;
* apply no market-cap or turnover floor here (that would embed a size/liquidity bias);
* retain renamed/delisted rows for history, but mark them non-ACTIVE.

The two official catalogues are deliberately fetched and validated together. A partial or
schema-moved response raises before any status is changed, so an upstream outage cannot
mass-deactivate the universe.
"""

from __future__ import annotations

import csv
import datetime as dt
import io

import requests

from db_compat import connect, ConnWrapper
from fetch_utils import retry_get


EQUITY_MASTER_URL = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"
ETF_MASTER_URL = "https://archives.nseindia.com/content/equities/eq_etfseclist.csv"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Referer": "https://www.nseindia.com/",
    "Accept": "text/csv,*/*",
}
MIN_EQUITY_ROWS = 2_000
MIN_ETF_ROWS = 200
MIN_ADMISSION_SESSIONS = 60


def _normalise(raw: dict) -> dict[str, str]:
    return {(key or "").strip(): (value or "").strip() for key, value in raw.items()}


def parse_equity_master(text: str) -> list[dict]:
    rows = []
    for raw in csv.DictReader(io.StringIO(text)):
        row = _normalise(raw)
        symbol = row.get("SYMBOL", "").upper()
        name = row.get("NAME OF COMPANY", "")
        isin = row.get("ISIN NUMBER", "").upper()
        series = row.get("SERIES", "").upper()
        try:
            listing_date = dt.datetime.strptime(row.get("DATE OF LISTING", ""), "%d-%b-%Y").date().isoformat()
        except ValueError:
            listing_date = None
        if symbol and name and series in {"EQ", "BE", "BZ"} and isin.startswith("INE"):
            rows.append({"symbol": symbol, "name": name, "isin": isin,
                         "series": series, "listing_date": listing_date})
    if len(rows) < MIN_EQUITY_ROWS:
        raise ValueError(f"NSE equity master incomplete or schema changed: {len(rows)} valid rows")
    return rows


def parse_etf_master(text: str) -> list[dict]:
    rows = []
    for raw in csv.DictReader(io.StringIO(text)):
        row = _normalise(raw)
        symbol = row.get("Symbol", "").upper()
        name = row.get("SecurityName", "")
        isin = row.get("ISINNumber", "").upper()
        if symbol and name and isin.startswith("INF"):
            rows.append({"symbol": symbol, "name": name, "isin": isin})
    if len(rows) < MIN_ETF_ROWS:
        raise ValueError(f"NSE ETF master incomplete or schema changed: {len(rows)} valid rows")
    return rows


def fetch_official_masters() -> tuple[list[dict], list[dict]]:
    equity = retry_get(requests, EQUITY_MASTER_URL, headers=HEADERS, timeout=30)
    etf = retry_get(requests, ETF_MASTER_URL, headers=HEADERS, timeout=30)
    return parse_equity_master(equity.text), parse_etf_master(etf.text)


def reconcile_master(conn: ConnWrapper, equities: list[dict], etfs: list[dict]) -> dict[str, int]:
    """Apply a complete validated snapshot. Callers must pass the parser outputs."""
    if len(equities) < MIN_EQUITY_ROWS or len(etfs) < MIN_ETF_ROWS:
        raise ValueError("refusing reconciliation from an incomplete NSE master snapshot")
    equity_symbols = {row["symbol"] for row in equities}
    etf_symbols = {row["symbol"] for row in etfs}
    if equity_symbols & etf_symbols:
        raise ValueError("NSE equity and ETF catalogues unexpectedly overlap")

    conn.execute("""
        CREATE TEMP TABLE nse_equity_master_stage (
          symbol TEXT PRIMARY KEY, name TEXT NOT NULL, isin TEXT NOT NULL,
          series TEXT NOT NULL, listing_date DATE
        ) ON COMMIT DROP
    """)
    conn.executemany(
        "INSERT INTO nse_equity_master_stage(symbol,name,isin,series,listing_date) VALUES (?,?,?,?,?)",
        [(r["symbol"], r["name"], r["isin"], r["series"], r["listing_date"]) for r in equities],
    )
    conn.execute("""
        CREATE TEMP TABLE nse_etf_master_stage (
          symbol TEXT PRIMARY KEY, name TEXT NOT NULL, isin TEXT NOT NULL
        ) ON COMMIT DROP
    """)
    conn.executemany(
        "INSERT INTO nse_etf_master_stage(symbol,name,isin) VALUES (?,?,?)",
        [(r["symbol"], r["name"], r["isin"]) for r in etfs],
    )

    # Use the history table's own latest session. This remains deterministic on weekends and
    # during publication lag, and 365 calendar days comfortably contains 60 sessions.
    conn.execute("""
        CREATE TEMP TABLE nse_equity_admission_stage AS
        SELECT e.symbol, e.name, e.isin, e.listing_date, count(DISTINCT h.date)::bigint AS sessions
        FROM nse_equity_master_stage e
        JOIN nse_universe_history h ON h.symbol=e.symbol
        WHERE h.date >= (SELECT max(date) FROM nse_universe_history) - 365
        GROUP BY e.symbol,e.name,e.isin,e.listing_date
        HAVING count(DISTINCT h.date) >= 60
           AND max(h.date) >= (SELECT max(date) FROM nse_universe_history) - 45
    """)

    before_active = conn.execute("SELECT count(*) FROM nse_stocks WHERE status='ACTIVE'").fetchone()[0]
    conn.execute("""
        INSERT INTO nse_stocks
          (symbol,name,isin,listing_date,exchange,status,instrument_type,
           exchange_master_updated_at,admission_sessions,admission_reason,last_updated)
        SELECT symbol,name,isin,listing_date,'NSE','ACTIVE','equity',CURRENT_TIMESTAMP,
               sessions,'official_nse_equity_master_and_60_sessions',CURRENT_TIMESTAMP
        FROM nse_equity_admission_stage
        ON CONFLICT(symbol) DO UPDATE SET
          name=excluded.name, isin=excluded.isin,
          listing_date=COALESCE(excluded.listing_date,nse_stocks.listing_date),
          status='ACTIVE', instrument_type='equity',
          exchange_master_updated_at=CURRENT_TIMESTAMP,
          admission_sessions=excluded.admission_sessions,
          admission_reason=excluded.admission_reason,
          last_updated=CURRENT_TIMESTAMP
    """)
    admitted = conn.execute("SELECT count(*) FROM nse_equity_admission_stage").fetchone()[0]

    # Exact catalogue membership, never name/symbol regexes, classifies funds.
    conn.execute("""
        UPDATE nse_stocks n SET instrument_type='etf', status='INACTIVE',
          exchange_master_updated_at=CURRENT_TIMESTAMP,
          admission_reason='official_nse_etf_excluded_from_equity_ranker',
          last_updated=CURRENT_TIMESTAMP
        FROM nse_etf_master_stage e WHERE e.symbol=n.symbol
    """)
    # A static/bootstrap row does not bypass the seasoning rule merely because NSE already
    # lists it. It becomes ACTIVE only after the same observed-history test as a new insert.
    conn.execute("""
        UPDATE nse_stocks n SET status='INACTIVE', instrument_type='equity',
          exchange_master_updated_at=CURRENT_TIMESTAMP,
          admission_reason='official_nse_equity_below_60_observed_sessions',
          last_updated=CURRENT_TIMESTAMP
        WHERE n.status='ACTIVE'
          AND EXISTS (SELECT 1 FROM nse_equity_master_stage e WHERE e.symbol=n.symbol)
          AND NOT EXISTS (SELECT 1 FROM nse_equity_admission_stage a WHERE a.symbol=n.symbol)
    """)
    # Retain history and provider ids, but remove absent aliases/listings from every ACTIVE read.
    conn.execute("""
        UPDATE nse_stocks n SET status='INACTIVE',
          exchange_master_updated_at=CURRENT_TIMESTAMP,
          admission_reason='absent_from_official_nse_equity_master',
          last_updated=CURRENT_TIMESTAMP
        WHERE n.status='ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM nse_equity_master_stage e WHERE e.symbol=n.symbol)
    """)
    after_active = conn.execute("SELECT count(*) FROM nse_stocks WHERE status='ACTIVE'").fetchone()[0]
    inactive = conn.execute("SELECT count(*) FROM nse_stocks WHERE status='INACTIVE'").fetchone()[0]
    conn.commit()
    return {"eligible_snapshot": admitted, "active_before": before_active,
            "active_after": after_active, "inactive_total": inactive}


def main() -> None:
    equities, etfs = fetch_official_masters()
    with connect() as conn:
        result = reconcile_master(conn, equities, etfs)
    print(f"[NSEMaster] equities={len(equities)} etfs={len(etfs)} "
          f"eligible={result['eligible_snapshot']} active={result['active_after']} "
          f"inactive={result['inactive_total']}")


if __name__ == "__main__":
    main()


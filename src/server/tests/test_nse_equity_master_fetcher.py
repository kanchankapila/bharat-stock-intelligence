import os
import sys
from datetime import date, timedelta

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import nse_equity_master_fetcher as master


def test_parsers_use_official_identifier_fields_not_name_heuristics(monkeypatch):
    monkeypatch.setattr(master, "MIN_EQUITY_ROWS", 1)
    monkeypatch.setattr(master, "MIN_ETF_ROWS", 1)
    equities = master.parse_equity_master(
        "SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, ISIN NUMBER\n"
        "REALCO,Real Company Limited, EQ,01-JAN-2020, INE000A01001\n"
    )
    etfs = master.parse_etf_master(
        "Symbol,SecurityName,ISINNumber\nFUNDX,Index Tracker,INF000A01001\n"
    )
    assert equities[0]["symbol"] == "REALCO"
    assert equities[0]["listing_date"] == "2020-01-01"
    assert etfs[0]["symbol"] == "FUNDX"


def test_partial_master_is_rejected_before_reconciliation():
    with pytest.raises(ValueError, match="incomplete"):
        master.parse_equity_master("SYMBOL,NAME OF COMPANY\nONE,One Ltd\n")


def test_reconcile_admits_mature_equity_and_deactivates_alias_and_etf(pg_conn):
    pg_conn.execute("""
        CREATE TABLE nse_stocks (
          symbol TEXT PRIMARY KEY, name TEXT NOT NULL, isin TEXT, listing_date DATE,
          exchange TEXT, status TEXT, instrument_type TEXT,
          exchange_master_updated_at TIMESTAMPTZ, admission_sessions BIGINT,
          admission_reason TEXT, last_updated TIMESTAMPTZ
        )
    """)
    pg_conn.execute("""
        CREATE TABLE nse_universe_history (
          date DATE NOT NULL, symbol TEXT NOT NULL, series TEXT NOT NULL, close DOUBLE PRECISION,
          PRIMARY KEY(date,symbol,series)
        )
    """)
    old = (date(2026, 10, 15) - timedelta(days=80))
    pg_conn.execute(
        "INSERT INTO nse_stocks(symbol,name,status,instrument_type) VALUES "
        "('OLDALIAS','Old Alias','ACTIVE','equity'),('FUNDX','Fund','ACTIVE','equity'),"
        "('YOUNG','Young Company','ACTIVE','equity')"
    )
    for i in range(60):
        d = old + timedelta(days=i)
        pg_conn.execute(
            "INSERT INTO nse_universe_history(date,symbol,series,close) VALUES (?, 'NEWCO', 'EQ', 100)",
            (d,),
        )
    # Make the table's latest session current and NEWCO recent; 59-session YOUNG stays out.
    latest = date(2026, 10, 15)
    pg_conn.execute(
        "INSERT INTO nse_universe_history(date,symbol,series,close) VALUES (?, 'NEWCO', 'EQ', 101)",
        (latest,),
    )
    for i in range(59):
        pg_conn.execute(
            "INSERT INTO nse_universe_history(date,symbol,series,close) VALUES (?, 'YOUNG', 'EQ', 10)",
            (latest - timedelta(days=i),),
        )
    equities = [
        {"symbol": "NEWCO", "name": "New Company", "isin": "INE000A01001",
         "series": "EQ", "listing_date": "2020-01-01"},
        {"symbol": "YOUNG", "name": "Young Company", "isin": "INE000A01002",
         "series": "EQ", "listing_date": "2026-08-01"},
    ]
    equities.extend(
        {"symbol": f"DUMMY{i:04d}", "name": f"Dummy {i}", "isin": f"INE{i:09d}",
         "series": "EQ", "listing_date": "2020-01-01"}
        for i in range(master.MIN_EQUITY_ROWS - len(equities))
    )
    etfs = [
        {"symbol": "FUNDX", "name": "Index Tracker", "isin": "INF000A01001"}
    ]
    etfs.extend(
        {"symbol": f"ETF{i:04d}", "name": f"ETF {i}", "isin": f"INF{i:09d}"}
        for i in range(master.MIN_ETF_ROWS - len(etfs))
    )

    result = master.reconcile_master(pg_conn, equities, etfs)
    states = dict(pg_conn.execute(
        "SELECT symbol,status FROM nse_stocks WHERE symbol IN ('NEWCO','YOUNG','OLDALIAS','FUNDX')"
    ).fetchall())
    assert states == {"NEWCO": "ACTIVE", "YOUNG": "INACTIVE",
                      "OLDALIAS": "INACTIVE", "FUNDX": "INACTIVE"}
    assert result["eligible_snapshot"] == 1
    assert pg_conn.execute("SELECT instrument_type FROM nse_stocks WHERE symbol='FUNDX'").fetchone()[0] == "etf"


def test_checked_in_schema_uses_lossless_bhavcopy_types():
    schema = (os.path.join(os.path.dirname(__file__), "..", "..", "..", "db", "schema.postgres.sql"))
    text = open(schema, encoding="utf-8").read()
    block = text.split('CREATE TABLE IF NOT EXISTS "nse_universe_history"', 1)[1].split(");", 1)[0]
    for col in ("volume", "num_trades", "deliv_qty"):
        assert f'"{col}" BIGINT' in block
    for col in ("open", "high", "low", "close", "avg_price", "turnover_lacs", "deliv_pct"):
        assert f'"{col}" DOUBLE PRECISION' in block


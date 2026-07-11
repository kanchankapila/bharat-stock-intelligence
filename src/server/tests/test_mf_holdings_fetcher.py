import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import mf_holdings_fetcher as mf


def test_upsert_holdings_updates_technical_signals_by_date(tmp_path):
    db_path = tmp_path / "test-mf-holdings.sqlite"
    con = sqlite3.connect(db_path)
    try:
        con.execute("CREATE TABLE technical_signals (symbol TEXT, date TEXT, mf_holding_pct REAL, mf_fund_count INTEGER, mf_chg_vs_prev REAL)")
        con.execute("INSERT INTO technical_signals (symbol, date) VALUES (?, ?)", ("TEST", "2024-01-02"))
        con.commit()

        mf.ensure_schema(con)
        mf.upsert_holdings([
            {
                "symbol": "TEST",
                "mf_holding_pct": 3.5,
                "num_funds": 10,
                "chg_vs_prev": 0.2,
            }
        ], "2024-01-02", con)

        row = con.execute(
            "SELECT mf_holding_pct, mf_fund_count, mf_chg_vs_prev FROM technical_signals WHERE symbol = ? AND date = ?",
            ("TEST", "2024-01-02"),
        ).fetchone()
        assert row == (3.5, 10, 0.2)
    finally:
        con.close()

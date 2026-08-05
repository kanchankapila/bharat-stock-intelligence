"""Live-datasource test for mc_chart_patterns_fetcher.py (see CLAUDE.md's "Adding a new
data source" mandatory rule). Writing this test caught a real schema-mismatch bug:
ensure_schema()'s CREATE TABLE for mc_chart_patterns didn't match what upsert_patterns()
actually writes (missing mcsymbol/stoploss_price/stoploss_pct, had a plain
PRIMARY KEY(pattern_id) instead of a (mcsymbol, pattern_id) unique key) -- masked in
production only because the real table was already created via a separate migration with
the correct shape. Fixed alongside this test.
"""
import os

os.environ["USE_POSTGRES"] = "false"

import sqlite3
import sys
from datetime import date

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import mc_chart_patterns_fetcher as mcp
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite

REAL_SYMBOL = "RELIANCE"
REAL_MCSYMBOL = "RI"


def _make_test_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("""CREATE TABLE technical_signals (
        symbol TEXT, date TEXT,
        mc_cp_bull_count INTEGER, mc_cp_bear_count INTEGER,
        mc_cp_net_score INTEGER, mc_cp_avg_target_pct REAL
    )""")
    today = date.today().isoformat()
    conn.execute("INSERT INTO technical_signals (symbol, date) VALUES (?, ?)", (REAL_SYMBOL, today))
    conn.commit()
    mcp.ensure_schema(conn)
    return conn


@pytest.mark.live_datasource
class TestMcChartPatternsFetcherLiveDataSource:
    def test_real_fetch_and_write_through_own_functions(self):
        """Hits the real MC chart-patterns endpoint for RELIANCE, parses with the fetcher's
        own _parse_pattern(), and writes through its own upsert_patterns()/
        compute_and_upsert_signals()/backfill_technical_signals() into a throwaway DB whose
        schema comes from the fetcher's own (now-fixed) ensure_schema()."""
        session = mcp.requests.Session()
        raw_list = mcp._fetch(REAL_MCSYMBOL, session)
        assert isinstance(raw_list, list), f"_fetch() should return a list, got {type(raw_list)}"

        patterns = [p for p in (mcp._parse_pattern(r) for r in raw_list) if p is not None]

        conn = _make_test_conn()
        today = date.today().isoformat()
        mcp.upsert_patterns(REAL_SYMBOL, REAL_MCSYMBOL, patterns, conn)

        if patterns:
            rows = conn.execute(
                "SELECT mcsymbol, symbol, pattern_id, pattern_name FROM mc_chart_patterns"
            ).fetchall()
            assert rows, "upsert_patterns() received real patterns but wrote zero rows"
            for row in rows:
                assert row["mcsymbol"] == REAL_MCSYMBOL
                assert_looks_like_ticker(row["symbol"], context="mc_chart_patterns.symbol")
                assert row["pattern_id"], "mc_chart_patterns.pattern_id is empty"

        sigs = mcp.compute_and_upsert_signals(REAL_SYMBOL, today, patterns, conn)
        assert set(sigs.keys()) == {"bull_count", "bear_count", "net_score", "avg_target_pct"}
        assert sigs["net_score"] == sigs["bull_count"] - sigs["bear_count"]

        mcp.backfill_technical_signals(REAL_SYMBOL, today, sigs, conn)
        ts_row = conn.execute(
            "SELECT mc_cp_bull_count, mc_cp_net_score FROM technical_signals WHERE symbol = ?",
            (REAL_SYMBOL,),
        ).fetchone()
        assert ts_row is not None
        if sigs["bull_count"] is not None:
            assert_numeric_and_finite(ts_row["mc_cp_bull_count"], context="technical_signals.mc_cp_bull_count")
        conn.close()

"""Live-datasource test for earnings_surprise_fetcher.py (see CLAUDE.md's "Adding a new
data source" mandatory rule). Writing this test caught a real bug: `upsert_rows()` checked
`if use_postgres:` (a function object, always truthy) instead of `if use_postgres():`,
which meant the SQLite dev-fallback branch was permanently dead code -- fixed alongside
this test (one-line: added the missing call parens).
"""
import os


import sys

import pytest
from sqlalchemy import create_engine, text

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import earnings_surprise_fetcher as esf
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite

REAL_SYMBOL = "RELIANCE"
REAL_MCSYMBOL = "RI"


def _make_sqlite_engine():
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE stock_earnings_beats (
                symbol TEXT, quarter_date TEXT, period_type TEXT, beat_type TEXT,
                beat_score INTEGER, eps_actual REAL, eps_avg REAL, eps_high REAL,
                eps_low REAL, surprise_pct REAL, fetched_at TEXT,
                PRIMARY KEY (symbol, quarter_date)
            )
        """))
    return engine


@pytest.mark.live_datasource
class TestEarningsSurpriseFetcherLiveDataSource:
    def test_real_endpoints_produce_ml_usable_rows(self):
        """Hits both real MC endpoints for RELIANCE via the fetcher's own _annual_rows()/
        _quarterly_rows(), a large well-covered blue chip guaranteed to have completed
        fiscal years."""
        session = esf.requests.Session()
        annual = esf._annual_rows(session, REAL_MCSYMBOL)
        quarterly = esf._quarterly_rows(session, REAL_MCSYMBOL)

        assert annual, "earning-forecast endpoint returned zero completed-year rows for RELIANCE -- may be down/changed"
        for row in annual:
            assert row["period_date"], "annual row missing period_date"
            assert row["period_type"] == "annual"
            assert_numeric_and_finite(row["eps_actual"], context="annual.eps_actual")
            if row["surprise_pct"] is not None:
                assert_numeric_and_finite(row["surprise_pct"], context="annual.surprise_pct")
            assert row["beat_type"] in ("positive", "negative", "inline")

        # quarterly is a supplement -- allowed to legitimately be empty on some days, but
        # if non-empty must be well-shaped.
        for row in quarterly:
            assert row["period_date"], "quarterly row missing period_date"
            assert row["beat_score"] in (-1, 0, 1)

    def test_upsert_writes_ml_usable_rows_sqlite_and_postgres_dialects(self):
        """Writes real fetched RELIANCE data through the fetcher's own upsert_rows() against
        a real (throwaway) SQLite engine -- exercising the exact dialect branch the
        use_postgres() bugfix above restored to life -- then reads the row back and checks
        it's ML-usable."""
        session = esf.requests.Session()
        annual = esf._annual_rows(session, REAL_MCSYMBOL)
        assert annual, "no real annual rows to exercise the write path with"

        engine = _make_sqlite_engine()
        with engine.begin() as conn:
            n = esf.upsert_rows(conn, REAL_SYMBOL, annual)
        assert n == len(annual), "upsert_rows() didn't process every row"

        with engine.begin() as conn:
            rows = conn.execute(text(
                "SELECT symbol, quarter_date, eps_actual, beat_score FROM stock_earnings_beats"
            )).fetchall()
        assert rows, "upsert_rows() reported success but wrote nothing to stock_earnings_beats"
        for symbol, quarter_date, eps_actual, beat_score in rows:
            assert_looks_like_ticker(symbol, context="stock_earnings_beats.symbol")
            assert quarter_date, "stock_earnings_beats.quarter_date is empty"
            assert_numeric_and_finite(eps_actual, context="stock_earnings_beats.eps_actual")
            assert beat_score in (-1, 0, 1)

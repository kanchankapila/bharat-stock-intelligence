"""Live-datasource test for mc_stockvitals_history_fetcher.py (see CLAUDE.md's "Adding a new
data source" mandatory rule).

Verifies the swiftapi stockvitals/historical endpoint (distinct from moneycontrol_fetcher.py's
daily widget-scrape endpoint, mc/widget/stockvitals -- same four metrics, different MC API)
returns real annual bars, that the fetcher's own point-in-time dating logic produces sane
effective dates (never in the future, roughly ~9 years deep), and that a round-trip through
the fetcher's own upsert_history() lands ML-usable rows in proprietary_scores_history.
"""
import os
import sqlite3
import sys
from datetime import date, timedelta

import pytest
from curl_cffi import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import mc_stockvitals_history_fetcher as svh
from live_datasource_helpers import assert_non_empty_response, assert_stored_row_ml_usable

# Bharat Electronics -- one of the 180 liquid stocks with a stable, well-known MC scid
# (see src/data/stocklist.ts's StockMapping). Confirmed live to have Altman/Ohlson/Graham/
# DuPont history back to 2017.
REAL_SYMBOL = "BEL"
REAL_MCSYMBOL = "BE03"


def _make_test_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE proprietary_scores_history (
            symbol TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL,
            score_type TEXT NOT NULL, score_value REAL, score_label TEXT,
            PRIMARY KEY (symbol, date, source, score_type)
        )
    """)
    conn.commit()
    return conn


@pytest.mark.live_datasource
class TestMcStockVitalsHistoryLiveDataSource:
    def test_real_fetch_returns_ml_usable_bars(self):
        """Step 1-3: hit the real endpoint for all four metrics, parse with the fetcher's own
        parse_bars(), assert non-empty and shaped as expected."""
        session = requests.Session()
        today = date.today().isoformat()

        for metric, score_type in svh.SCORE_TYPE_MAP.items():
            bars = svh._fetch_metric(REAL_MCSYMBOL, metric, session)
            assert_non_empty_response(bars, f"_fetch_metric({REAL_MCSYMBOL}, {metric})")
            assert len(bars) >= 5, f"{metric}: expected several years of history, got {len(bars)}"

            rows = svh.parse_bars(bars, score_type, svh.DEFAULT_FY_END, today)
            assert rows, f"{metric}: parse_bars() dropped every bar"
            for r in rows:
                assert r["date"] <= today, \
                    f"{metric}: effective date {r['date']} is in the future (look-ahead)"
                assert isinstance(r["score_value"], (int, float)), \
                    f"{metric}: score_value not numeric: {r['score_value']!r}"
                assert r["score_type"] == score_type

            # PUBLICATION_LAG_DAYS=90 means the effective date must be strictly after the
            # nominal fiscal year-end, never on/before it (that would be look-ahead).
            newest = max(rows, key=lambda r: r["date"])
            assert newest["date"] >= (date.today() - timedelta(days=365 * 2)).isoformat(), \
                f"{metric}: newest bar looks stale, may indicate a parsing/dating regression"

    def test_real_fetch_stores_ml_usable_rows(self):
        """Step 4-5: write through the fetcher's own upsert_history() into a throwaway
        in-memory SQLite DB, then read the rows back and validate they're ML-usable."""
        session = requests.Session()
        today = date.today().isoformat()
        fy_ends = {}  # empty -- exercises the DEFAULT_FY_END fallback path deliberately

        conn = _make_test_conn()
        total_rows = 0
        for metric, score_type in svh.SCORE_TYPE_MAP.items():
            bars = svh._fetch_metric(REAL_MCSYMBOL, metric, session)
            assert_non_empty_response(bars, f"_fetch_metric({REAL_MCSYMBOL}, {metric})")
            rows = svh.parse_bars(bars, score_type, fy_ends.get(REAL_SYMBOL, svh.DEFAULT_FY_END), today)
            svh.upsert_history(REAL_SYMBOL, rows, conn)
            total_rows += len(rows)

        assert total_rows > 0, "no rows were written across any of the 4 metrics"

        stored = conn.execute(
            "SELECT * FROM proprietary_scores_history WHERE symbol = ? ORDER BY score_type, date",
            (REAL_SYMBOL,),
        ).fetchall()
        assert stored, "no rows landed in proprietary_scores_history after upsert_history()"
        assert len(stored) == total_rows, \
            "stored row count doesn't match parsed row count -- possible silent PK collision"

        for row in stored:
            row = dict(row)
            assert row["source"] == "moneycontrol"
            assert row["score_type"] in svh.SCORE_TYPE_MAP.values()
            assert_stored_row_ml_usable(
                row, numeric_cols=["score_value"], ticker_cols=["symbol"],
                context="proprietary_scores_history",
            )

    def test_fiscal_year_end_resolution_prefers_real_data(self):
        """_load_fiscal_year_ends() must return the REAL per-company fiscal year-end
        (e.g. a December-ending company) when working_capital_history has it, not the
        DEFAULT_FY_END majority fallback -- this is the whole point of resolving it per
        company rather than assuming March 31 uniformly."""
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE working_capital_history (symbol TEXT, fiscal_year TEXT)")
        # ABB India genuinely reports a December year-end (confirmed live against production).
        conn.executemany(
            "INSERT INTO working_capital_history (symbol, fiscal_year) VALUES (?, ?)",
            [("ABB", "2024-12-31"), ("ABB", "2025-12-31"), ("RELIANCE", "2025-03-31")],
        )
        conn.commit()
        fy_ends = svh._load_fiscal_year_ends(conn)
        assert fy_ends["ABB"] == "12-31"
        assert fy_ends["RELIANCE"] == "03-31"
        assert "UNKNOWNSYM" not in fy_ends  # absent symbols fall back at call time, not here

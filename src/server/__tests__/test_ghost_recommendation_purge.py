"""Pins data_integrity_repair.repair_ghost_recommendations().

Guards the residue class this codebase keeps re-learning: fixing a writer never cleans the
rows it already wrote. unified_ranker gained _restrict_to_tradeable_universe on 2026-07-31
and live rows have been clean since -- but 26,375 rows for 2,498 symbols with no price
history survived on historical dates, and they silently bias any measurement over the table
because a ghost cannot be graded and is dropped by every join to prices.

SQLite is fine here (unlike the NaN sibling, which needs Postgres): the predicate is a plain
NOT IN, with no float semantics involved.
"""
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import data_integrity_repair as dir_  # noqa: E402


class Conn:
    """Minimal ConnWrapper stand-in: dict-like rows, execute/commit."""

    def __init__(self, raw):
        self.raw = raw
        self.raw.row_factory = sqlite3.Row
        self.commits = 0

    def execute(self, sql, params=()):
        return self.raw.execute(sql, params)

    def commit(self):
        self.commits += 1
        self.raw.commit()


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.execute("CREATE TABLE unified_recommendations "
              "(symbol TEXT, computed_at TEXT, classification TEXT, unified_score REAL)")
    c.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date TEXT, close REAL)")
    # Two priced symbols; RELIANCE trades throughout, STALECO only long ago.
    c.executemany("INSERT INTO stock_ohlcv VALUES (?,?,?)", [
        ("RELIANCE", "2026-08-10", 1400.0),
        ("STALECO", "2021-03-02", 50.0),
    ])
    c.executemany("INSERT INTO unified_recommendations VALUES (?,?,?,?)", [
        ("RELIANCE", "2026-07-29", "Buy", 71.0),
        ("STALECO", "2026-07-29", "Strong Sell", 22.0),   # priced once, long ago -> KEEP
        ("REXPRO", "2026-07-29", "Hold", 3.0),            # ghost
        ("KONSTELEC", "2026-07-29", "Strong Sell", 29.56),  # ghost, actionable
        ("SWADPOL", "2026-07-30", "Buy", 37.0),           # ghost, actionable
    ])
    c.commit()
    return Conn(c)


def rows(conn):
    return {r["symbol"] for r in conn.execute(
        "SELECT symbol FROM unified_recommendations").fetchall()}


class TestPurge:
    def test_deletes_only_symbols_with_no_price_history(self, conn):
        dir_.repair_ghost_recommendations(conn, dry=False)
        assert rows(conn) == {"RELIANCE", "STALECO"}

    def test_a_symbol_priced_only_years_ago_is_kept(self, conn):
        """The predicate is deliberately narrower than unified_ranker's live 30-day filter:
        a delisting or a temporary feed gap must never be mistaken for a ghost."""
        dir_.repair_ghost_recommendations(conn, dry=False)
        assert "STALECO" in rows(conn)

    def test_dry_run_reports_but_deletes_nothing(self, conn):
        dir_.repair_ghost_recommendations(conn, dry=True)
        assert rows(conn) == {"RELIANCE", "STALECO", "REXPRO", "KONSTELEC", "SWADPOL"}
        assert conn.commits == 0

    def test_is_idempotent(self, conn):
        dir_.repair_ghost_recommendations(conn, dry=False)
        after_first = rows(conn)
        dir_.repair_ghost_recommendations(conn, dry=False)
        assert rows(conn) == after_first

    def test_clean_table_is_a_no_op(self, conn):
        conn.execute("DELETE FROM unified_recommendations "
                     "WHERE symbol IN ('REXPRO','KONSTELEC','SWADPOL')")
        conn.commit()
        before = conn.commits
        dir_.repair_ghost_recommendations(conn, dry=False)
        assert conn.commits == before          # returns before touching anything
        assert rows(conn) == {"RELIANCE", "STALECO"}


def test_registered_as_a_task():
    """A repair that is not in TASKS is unreachable from the CLI -- the whole point is that
    it can be re-run on demand."""
    assert dir_.TASKS["ghost_recommendations"] is dir_.repair_ghost_recommendations


class TestWeekendPurge:
    """The four bad snapshots were 2026-07-05/07-12 (Sun), 07-25 (Sat), 08-09 (Sun)."""

    @pytest.fixture
    def wconn(self):
        c = sqlite3.connect(":memory:")
        c.execute("CREATE TABLE unified_recommendations "
                  "(symbol TEXT, computed_at TEXT, classification TEXT, unified_score REAL)")
        c.executemany("INSERT INTO unified_recommendations VALUES (?,?,?,?)", [
            ("RELIANCE", "2026-08-07", "Buy", 71.0),      # Friday   -> keep
            ("INFY",     "2026-08-08", "Buy", 60.0),      # Saturday -> delete
            ("TCS",      "2026-08-09", "Sell", 30.0),     # Sunday   -> delete
            ("HDFCBANK", "2026-08-10", "Buy", 66.0),      # Monday   -> keep
            ("WIPRO",    "not-a-date", "Hold", 10.0),     # unparseable -> keep, not ours
        ])
        c.commit()
        return Conn(c)

    def test_deletes_only_closed_day_snapshots(self, wconn):
        dir_.repair_weekend_recommendations(wconn, dry=False)
        assert rows(wconn) == {"RELIANCE", "HDFCBANK", "WIPRO"}

    def test_friday_and_monday_survive(self, wconn):
        """Negative control for an off-by-one in weekday(): Monday is 0 and Friday is 4;
        a `>= 4` or `>= 6` bound would take one of these with it."""
        dir_.repair_weekend_recommendations(wconn, dry=False)
        kept = rows(wconn)
        assert "RELIANCE" in kept and "HDFCBANK" in kept

    def test_unparseable_date_is_left_alone(self, wconn):
        dir_.repair_weekend_recommendations(wconn, dry=False)
        assert "WIPRO" in rows(wconn)

    def test_dry_run_deletes_nothing(self, wconn):
        dir_.repair_weekend_recommendations(wconn, dry=True)
        assert len(rows(wconn)) == 5
        assert wconn.commits == 0

    def test_is_idempotent_and_clean_table_is_a_no_op(self, wconn):
        dir_.repair_weekend_recommendations(wconn, dry=False)
        after = rows(wconn)
        before_commits = wconn.commits
        dir_.repair_weekend_recommendations(wconn, dry=False)
        assert rows(wconn) == after
        assert wconn.commits == before_commits      # second run returns before writing

    def test_registered_as_a_task(self):
        assert dir_.TASKS["weekend_recommendations"] is dir_.repair_weekend_recommendations

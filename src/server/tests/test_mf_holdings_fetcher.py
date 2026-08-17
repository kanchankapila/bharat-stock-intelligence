import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pg_test_support import pg_memory_conn  # noqa: E402
import mf_holdings_fetcher as mf  # noqa: E402


def _conn(tmp_path):
    con = pg_memory_conn()
    con.execute("CREATE TABLE technical_signals (symbol TEXT, date TEXT, mf_holding_pct REAL, mf_fund_count INTEGER, mf_chg_vs_prev REAL)")
    return con


def test_upsert_holdings_updates_technical_signals_by_date(tmp_path):
    con = _conn(tmp_path)
    try:
        con.execute("INSERT INTO technical_signals (symbol, date) VALUES (?, ?)", ("TEST", "2024-06-01"))
        con.commit()

        mf.ensure_schema(con)
        mf.upsert_holdings([
            {"symbol": "TEST", "mf_holding_pct": 3.5, "chg_vs_prev": 0.2, "as_of_date": "2024-03-31"},
        ], "2024-06-01", con)

        row = con.execute(
            "SELECT mf_holding_pct, mf_chg_vs_prev FROM technical_signals WHERE symbol = ? AND date = ?",
            ("TEST", "2024-06-01"),
        ).fetchone()
        # floor = 2024-03-31 + 30d = 2024-04-30, well before the 2024-06-01 grid row -- write lands.
        assert (row["mf_holding_pct"], row["mf_chg_vs_prev"]) == (3.5, 0.2)
    finally:
        con.close()


class TestPointInTimeGating:
    """2026-08-13 regression: the previous version used a bare UPDATE ... WHERE date = today
    (no CASE WHEN/ELSE-NULL), which silently touched 0 rows whenever this job ran on a day
    with no matching technical_signals grid row, and could never retroactively clear a stale
    value either. Negative control: reverting upsert_holdings to a bare WHERE-date match
    makes test_disclosure_not_yet_mature_leaves_row_null fail (the pre-floor row would just
    never get touched either way, so the ELSE-NULL half is the part that actually regresses)."""

    def test_disclosure_not_yet_mature_leaves_row_null(self, tmp_path):
        """A grid row dated BEFORE the disclosure's point-in-time floor must stay NULL --
        the disclosure wasn't public yet as of that date."""
        con = _conn(tmp_path)
        con.execute("INSERT INTO technical_signals (symbol, date) VALUES (?, ?)", ("TEST", "2024-04-01"))
        con.commit()
        mf.ensure_schema(con)

        mf.upsert_holdings([
            {"symbol": "TEST", "mf_holding_pct": 3.5, "chg_vs_prev": 0.2, "as_of_date": "2024-03-31"},
        ], "2024-04-01", con)

        row = con.execute(
            "SELECT mf_holding_pct FROM technical_signals WHERE symbol = ? AND date = ?",
            ("TEST", "2024-04-01"),
        ).fetchone()
        assert row["mf_holding_pct"] is None, (
            "a 2024-04-01 grid row is BEFORE floor (2024-03-31 + 30d = 2024-04-30) -- "
            "the Mar-31 disclosure wasn't public yet and must not leak onto this row"
        )
        con.close()

    def test_missing_as_of_date_falls_back_to_write_date_not_wall_clock(self, tmp_path):
        """No as_of_date (endpoint shape changed / empty quarterDates) must fall back to the
        passed-in `today` write-target, not a bare date.today() -- same anchor-consistency
        class as recurring-bugs.md's date.today() write-target bugs."""
        con = _conn(tmp_path)
        con.execute("INSERT INTO technical_signals (symbol, date) VALUES (?, ?)", ("TEST", "2024-04-01"))
        con.commit()
        mf.ensure_schema(con)

        mf.upsert_holdings([
            {"symbol": "TEST", "mf_holding_pct": 3.5, "chg_vs_prev": 0.2, "as_of_date": None},
        ], "2024-04-01", con)

        row = con.execute(
            "SELECT mf_holding_pct FROM technical_signals WHERE symbol = ? AND date = ?",
            ("TEST", "2024-04-01"),
        ).fetchone()
        assert row["mf_holding_pct"] == 3.5, "fallback floor should equal the write date, so this row qualifies"
        con.close()

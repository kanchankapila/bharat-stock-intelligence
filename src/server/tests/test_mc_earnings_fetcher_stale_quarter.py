"""
Regression test for _backfill_rapid_features' selection query (measurement-integrity-review,
2026-08-14): was `ORDER BY ABS(category_score) DESC`, which picks the historically most EXTREME
quarter, not the most recent one -- despite the function's own docstring claiming "most recent".
Live-confirmed 442/2,017 multi-row symbols (21.9%) disagreed with what result_date would have
picked; RAMKY showed a stale May-2026 "Beat Positive" label while its real Aug-2026 quarter had
landed "WP" (weak). Fixed to sort by result_date DESC first, |category_score| DESC only as a
same-day tiebreak.
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import mc_earnings_fetcher as mef


def _use_pg(conn):
    """Match the code branch to the connection the fixture actually got. conftest's
    decommission shim swaps sqlite3 for a Postgres-backed ConnWrapper, so this is Postgres
    everywhere as of 2026-08-16 (the shim is unconditional now; the SQLITE_SHIM_POSTGRES opt-in
    is gone). Keyed on the CONNECTION rather than hardcoded because only ':memory:' is
    redirected -- a deliberate temp-file sqlite fixture still hands back real SQLite."""
    return type(conn).__name__ == "ConnWrapper"


def _db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE mc_earnings_rapid (
            scid TEXT, sub_type TEXT, category TEXT, result_date TEXT,
            np_growth REAL, category_score INTEGER,
            PRIMARY KEY (scid, sub_type, category)
        );
        CREATE TABLE mc_pricefeed_daily (symbol TEXT, scid TEXT, date TEXT);
        -- The Postgres branch joins nse_stocks.mcsymbol (mc_pricefeed_daily secondary), so both
        -- have to exist for the same fixture to serve either dialect. See _use_pg above.
        CREATE TABLE nse_stocks (symbol TEXT, mcsymbol TEXT);
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT,
            earnings_category_yoy INTEGER, earnings_np_growth_yoy REAL,
            earnings_category_qoq INTEGER, earnings_np_growth_qoq REAL,
            positive_turnaround INTEGER, negative_turnaround INTEGER
        );
    """)
    return conn


def test_NEGATIVE_CONTROL_picks_most_recent_quarter_not_strongest_score(monkeypatch):
    monkeypatch.setattr(mef, "logical_trading_date", lambda: "2026-08-14")
    conn = _db()
    monkeypatch.setattr(mef, "use_postgres", lambda: _use_pg(conn))
    cur = conn.cursor()
    cur.execute("INSERT INTO mc_pricefeed_daily VALUES ('RAMKY', 'SID1', '2026-08-14')")
    cur.execute("INSERT INTO nse_stocks VALUES ('RAMKY', 'SID1')")
    cur.execute("INSERT INTO technical_signals (symbol, date) VALUES ('RAMKY', '2026-08-14')")
    # Old, strong quarter (score magnitude 2) -- the pre-fix query would have picked this one.
    # result_date uses the real vendor format ("Month DD, YYYY", zero-padded day), not ISO --
    # matches live data (confirmed 2026-08-14: "August 06, 2026").
    cur.execute("""INSERT INTO mc_earnings_rapid
        (scid, sub_type, category, result_date, np_growth, category_score)
        VALUES ('SID1', 'yoy', 'BP', 'May 27, 2026', 40.0, 2)""")
    # New, weaker quarter (score magnitude 1) -- the correct pick, since it's more recent.
    cur.execute("""INSERT INTO mc_earnings_rapid
        (scid, sub_type, category, result_date, np_growth, category_score)
        VALUES ('SID1', 'yoy', 'WP', 'August 10, 2026', -5.0, -1)""")
    conn.commit()

    mef._backfill_rapid_features(conn)

    row = cur.execute(
        "SELECT earnings_category_yoy, earnings_np_growth_yoy FROM technical_signals WHERE symbol='RAMKY'"
    ).fetchone()
    assert row["earnings_category_yoy"] == -1, (
        f"expected the MORE RECENT quarter's category_score (-1), got {row['earnings_category_yoy']} "
        "-- the pre-fix query picks the historically strongest score (2) regardless of recency"
    )
    assert row["earnings_np_growth_yoy"] == -5.0


def test_same_day_tie_falls_back_to_strongest_score(monkeypatch):
    monkeypatch.setattr(mef, "logical_trading_date", lambda: "2026-08-14")
    conn = _db()
    monkeypatch.setattr(mef, "use_postgres", lambda: _use_pg(conn))
    cur = conn.cursor()
    cur.execute("INSERT INTO mc_pricefeed_daily VALUES ('TESTSYM', 'SID2', '2026-08-14')")
    cur.execute("INSERT INTO nse_stocks VALUES ('TESTSYM', 'SID2')")
    cur.execute("INSERT INTO technical_signals (symbol, date) VALUES ('TESTSYM', '2026-08-14')")
    cur.execute("""INSERT INTO mc_earnings_rapid
        (scid, sub_type, category, result_date, np_growth, category_score)
        VALUES ('SID2', 'yoy', 'BP', 'August 10, 2026', 10.0, 1)""")
    cur.execute("""INSERT INTO mc_earnings_rapid
        (scid, sub_type, category, result_date, np_growth, category_score)
        VALUES ('SID2', 'yoy', 'NT', 'August 10, 2026', 0.0, 0)""")
    conn.commit()

    mef._backfill_rapid_features(conn)

    row = cur.execute(
        "SELECT earnings_category_yoy FROM technical_signals WHERE symbol='TESTSYM'"
    ).fetchone()
    assert row["earnings_category_yoy"] == 1


def test_NEGATIVE_CONTROL_pg_date_regex_matches_sqlite_glob_day_width(tmp_path):
    """PG_RESULT_DATE_RE (used to guard Postgres's TO_DATE) and the SQLite branch's GLOB pattern
    ('[0-9][0-9]' for the day) must accept/reject the same inputs -- otherwise an unpadded
    single-digit day ("August 6, 2026") parses fine on Postgres but silently degrades to NULL
    (sorts last) on the SQLite dev fallback, a dialect-inconsistent result for identical input.
    Fails against the pre-fix `[0-9]{1,2}` (which accepts a single digit the SQLite GLOB
    rejects), passes once both require exactly 2 digits."""
    import re
    import sqlite3

    single_digit = "August 6, 2026"
    double_digit = "August 06, 2026"

    pg_re = re.compile(mef.PG_RESULT_DATE_RE)
    # A temp FILE, not ':memory:' -- this test's whole point is comparing against real SQLite
    # GLOB semantics, and conftest's decommission shim redirects ':memory:' onto Postgres.
    conn = sqlite3.connect(str(tmp_path / "glob.db"))
    sqlite_glob = "SELECT ? GLOB '[A-Za-z]* [0-9][0-9], [0-9][0-9][0-9][0-9]'"

    pg_single = bool(pg_re.match(single_digit))
    sqlite_single = bool(conn.execute(sqlite_glob, (single_digit,)).fetchone()[0])
    assert pg_single == sqlite_single, (
        f"single-digit day: Postgres regex matched={pg_single}, SQLite GLOB matched={sqlite_single} "
        "-- the two dialects must agree"
    )

    pg_double = bool(pg_re.match(double_digit))
    sqlite_double = bool(conn.execute(sqlite_glob, (double_digit,)).fetchone()[0])
    assert pg_double is True and sqlite_double is True, "the real vendor format must match both"


def test_undated_row_never_beats_a_dated_row(monkeypatch):
    monkeypatch.setattr(mef, "logical_trading_date", lambda: "2026-08-14")
    conn = _db()
    monkeypatch.setattr(mef, "use_postgres", lambda: _use_pg(conn))
    cur = conn.cursor()
    cur.execute("INSERT INTO mc_pricefeed_daily VALUES ('TESTSYM2', 'SID3', '2026-08-14')")
    cur.execute("INSERT INTO nse_stocks VALUES ('TESTSYM2', 'SID3')")
    cur.execute("INSERT INTO technical_signals (symbol, date) VALUES ('TESTSYM2', '2026-08-14')")
    # Undated row has the stronger score, but must still lose to any dated row.
    cur.execute("""INSERT INTO mc_earnings_rapid
        (scid, sub_type, category, result_date, np_growth, category_score)
        VALUES ('SID3', 'yoy', 'BP', NULL, 99.0, 2)""")
    cur.execute("""INSERT INTO mc_earnings_rapid
        (scid, sub_type, category, result_date, np_growth, category_score)
        VALUES ('SID3', 'yoy', 'WP', 'January 01, 2026', -1.0, -1)""")
    conn.commit()

    mef._backfill_rapid_features(conn)

    row = cur.execute(
        "SELECT earnings_category_yoy FROM technical_signals WHERE symbol='TESTSYM2'"
    ).fetchone()
    assert row["earnings_category_yoy"] == -1

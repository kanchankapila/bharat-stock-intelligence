"""mc_earnings_fetcher's technical_signals backfills, run against real Postgres rows.

A-02  `_backfill_shockers` flagged every scid EVER present in mc_price_shockers (PK scid, never
      purged): 2,811 of 2,821 rows were stale Apr-Sep results, so earnings_shocker_flag read 1 on
      1,933 / 2,160 symbols -- a constant feature. Only the latest fetch is the current list.
A-03  The backfills joined `nse_stocks ON mcsymbol = scid`. mcsymbol is not unique (58 scids in
      stock_earnings_dates fan out), so Bajaj Finance's result date was also written to BAJAJST,
      Adani Power's to EMPOWER. AF-20260918-02 fixed the dict-comprehension form; a SQL JOIN fans
      out instead of overwriting and was invisible to that guard.
A-07  A rescheduled result date leaves the old (scid, result_date) row behind; MIN(result_date)
      then counts down to the stale EARLIER date (63 of 64 measured reschedules: later was real).

Negative control: each test fails on the pre-fix mc_earnings_fetcher.py.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pg_test_support import pg_memory_conn  # noqa: E402

import mc_earnings_fetcher as mef  # noqa: E402

TODAY = "2026-10-08"


def _conn(monkeypatch, nse_rows):
    monkeypatch.setattr(mef, "logical_trading_date", lambda: TODAY)
    conn = pg_memory_conn()
    conn.execute("CREATE TABLE nse_stocks (symbol TEXT, mcsymbol TEXT)")
    conn.execute("""CREATE TABLE technical_signals (
        symbol TEXT, date DATE, days_to_next_results BIGINT,
        earnings_shocker_flag BIGINT, earnings_shocker_gain DOUBLE PRECISION,
        earnings_category_yoy DOUBLE PRECISION, earnings_np_growth_yoy DOUBLE PRECISION,
        earnings_category_qoq DOUBLE PRECISION, earnings_np_growth_qoq DOUBLE PRECISION,
        positive_turnaround BIGINT, negative_turnaround BIGINT,
        eps_beat_last_q BIGINT, mc_eps_vs_cons DOUBLE PRECISION)""")
    conn.execute("""CREATE TABLE stock_earnings_dates (
        scid TEXT NOT NULL, result_date DATE NOT NULL, stock_name TEXT, result_type TEXT,
        result_time TEXT, market_cap DOUBLE PRECISION, exchange TEXT,
        fetched_at TEXT DEFAULT now(), PRIMARY KEY (scid, result_date))""")
    conn.execute("""CREATE TABLE mc_price_shockers (
        scid TEXT PRIMARY KEY, stock_name TEXT, result_date DATE,
        gain_since_result DOUBLE PRECISION, ltp DOUBLE PRECISION, change_pct DOUBLE PRECISION,
        fetched_at TEXT DEFAULT now())""")
    conn.execute("""CREATE TABLE mc_earnings_rapid (
        scid TEXT, sub_type TEXT, category TEXT, category_score DOUBLE PRECISION,
        np_growth DOUBLE PRECISION, result_date TEXT)""")
    for sym, code in nse_rows:
        conn.execute("INSERT INTO nse_stocks VALUES (?, ?)", (sym, code))
        conn.execute("INSERT INTO technical_signals (symbol, date) VALUES (?, ?)", (sym, TODAY))
    conn.commit()
    return conn


def _ts(conn, col):
    return dict(conn.execute(f"SELECT symbol, {col} FROM technical_signals").fetchall())


# Bajaj Finance's real MC code is shared with BAJAJST in nse_stocks (measured 2026-10-08).
AMBIG = [("BAJAJST", "BAF"), ("BAJFINANCE", "BAF"), ("RELIANCE", "RI")]


# ── A-02 ────────────────────────────────────────────────────────────────────────

def test_shocker_flag_set_only_for_the_latest_fetch(monkeypatch):
    conn = _conn(monkeypatch, [("RELIANCE", "RI"), ("TCS", "TCS")])
    conn.execute("INSERT INTO mc_price_shockers (scid, result_date, gain_since_result, fetched_at) "
                 "VALUES ('TCS', '2026-05-04', 9.0, '2026-07-01 12:00:00+00')")   # stale, never purged
    conn.execute("INSERT INTO mc_price_shockers (scid, result_date, gain_since_result, fetched_at) "
                 "VALUES ('RI', '2026-10-06', 4.5, '2026-10-07 14:43:00+00')")    # this run's list
    conn.commit()

    mef._backfill_shockers(conn)

    flag, gain = _ts(conn, "earnings_shocker_flag"), _ts(conn, "earnings_shocker_gain")
    assert flag["RELIANCE"] == 1 and gain["RELIANCE"] == 4.5
    assert flag["TCS"] == 0, "a months-old shocker row is still flagged as current (A-02)"
    assert gain["TCS"] is None


# ── A-03 ────────────────────────────────────────────────────────────────────────

def test_days_to_results_never_fans_out_an_ambiguous_mcsymbol(monkeypatch):
    conn = _conn(monkeypatch, AMBIG)
    conn.execute("INSERT INTO stock_earnings_dates (scid, result_date) VALUES ('BAF', '2026-10-19')")
    conn.execute("INSERT INTO stock_earnings_dates (scid, result_date) VALUES ('RI', '2026-10-17')")
    conn.commit()

    mef._backfill_days_to_results(conn)

    days = _ts(conn, "days_to_next_results")
    assert days["RELIANCE"] == 9, "unambiguous control must still resolve"
    assert days["BAJAJST"] is None and days["BAJFINANCE"] is None, (
        f"ambiguous scid BAF was written to {days} -- one company's result date booked "
        f"against another (A-03)")


def test_shockers_never_fan_out_an_ambiguous_mcsymbol(monkeypatch):
    conn = _conn(monkeypatch, AMBIG)
    for scid in ("BAF", "RI"):
        conn.execute("INSERT INTO mc_price_shockers (scid, result_date, gain_since_result, fetched_at) "
                     "VALUES (?, '2026-10-06', 3.0, '2026-10-07 14:43:00+00')", (scid,))
    conn.commit()

    mef._backfill_shockers(conn)

    flag = _ts(conn, "earnings_shocker_flag")
    assert flag["RELIANCE"] == 1
    assert flag["BAJAJST"] != 1 and flag["BAJFINANCE"] != 1, f"ambiguous BAF flagged: {flag}"


def test_rapid_features_never_fan_out_an_ambiguous_mcsymbol(monkeypatch):
    conn = _conn(monkeypatch, AMBIG)
    for scid in ("BAF", "RI"):
        for sub in ("yoy", "qoq"):
            conn.execute("INSERT INTO mc_earnings_rapid VALUES (?, ?, 'Beat', 1, 12.5, 'October 06, 2026')",
                         (scid, sub))
    conn.commit()

    mef._backfill_rapid_features(conn)

    cat = _ts(conn, "earnings_category_yoy")
    assert cat["RELIANCE"] == 1
    assert cat["BAJAJST"] is None and cat["BAJFINANCE"] is None, f"ambiguous BAF written: {cat}"


def test_actual_estimate_never_guesses_an_ambiguous_mcsymbol(monkeypatch):
    """Same class, dict form: `{row[0]: row[1]}` kept whichever BAF row came last."""
    conn = _conn(monkeypatch, AMBIG)
    monkeypatch.setattr(mef.time, "sleep", lambda *_: None)
    items = [[code, "", "", "", "", "", "", "Beats Estimate", "5.2"] for code in ("BAF", "RI")]
    monkeypatch.setattr(mef, "_get", lambda url: {"list": items})

    mef.fetch_actual_estimate_beats(conn, max_pages=1)

    beat = _ts(conn, "eps_beat_last_q")
    assert beat["RELIANCE"] == 1
    assert beat["BAJAJST"] is None and beat["BAJFINANCE"] is None, f"ambiguous BAF guessed: {beat}"


# ── A-07 ────────────────────────────────────────────────────────────────────────

def test_rescheduled_result_date_counts_down_to_the_current_date(monkeypatch):
    conn = _conn(monkeypatch, [("RELIANCE", "RI")])
    # Announced for 10-10 on 09-20, then moved to 10-20: the vendor stopped returning 10-10,
    # so that row's fetched_at froze while 10-20 keeps being re-seen.
    conn.execute("INSERT INTO stock_earnings_dates (scid, result_date, fetched_at) "
                 "VALUES ('RI', '2026-10-10', '2026-09-20 14:00:00+00')")
    conn.execute("INSERT INTO stock_earnings_dates (scid, result_date, fetched_at) "
                 "VALUES ('RI', '2026-10-20', '2026-10-07 14:42:00+00')")
    conn.commit()

    mef._backfill_days_to_results(conn)

    assert _ts(conn, "days_to_next_results")["RELIANCE"] == 12, (
        "countdown used the stale, superseded earlier date (A-07)")


def test_two_dates_from_the_same_fetch_still_take_the_nearest(monkeypatch):
    """Non-vacuity for A-07: only SUPERSEDED rows drop out, not a genuine earlier date."""
    conn = _conn(monkeypatch, [("RELIANCE", "RI")])
    for d in ("2026-10-10", "2026-12-20"):
        conn.execute("INSERT INTO stock_earnings_dates (scid, result_date, fetched_at) "
                     "VALUES ('RI', ?, '2026-10-07 14:42:00+00')", (d,))
    conn.commit()

    mef._backfill_days_to_results(conn)

    assert _ts(conn, "days_to_next_results")["RELIANCE"] == 2

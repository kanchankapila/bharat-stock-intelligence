"""AF-20261015-07: a demerger has no clean ratio, so ohlcv_adjust rejected it and the ex-date stayed a
-91% return in stock_ohlcv (BHAGYANGR 2026-10-08, VERANDA 10-06, HEG 09-07). A DECLARED corporate
action on the date plus a persisting new level now promotes the rejection to a factor; an undeclared
move or a level that reverts (a bad print) is still only reported."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import ohlcv_adjust as oa

# (date, prev_close, open, high, low, close) -- real nse_universe_history rows.
BHAGYANGR = [
    ("2026-10-07", 432.95, 454.55, 454.55, 454.55, 454.55),
    ("2026-10-08", 454.55, 39.0, 41.4, 39.0, 41.4),      # demerger ex-date, -91%
    ("2026-10-09", 41.4, 43.45, 43.45, 43.45, 43.45),
    ("2026-10-12", 43.45, 45.6, 45.6, 45.6, 45.6),
    ("2026-10-13", 45.6, 47.85, 47.85, 47.85, 47.85),
]
HEG = [
    ("2026-09-04", 707.45, 710.0, 735.0, 705.0, 728.25),
    ("2026-09-07", 728.25, 260.0, 273.0, 250.0, 272.2),   # -63%
    ("2026-09-08", 272.2, 265.4, 265.4, 258.6, 258.6),
    ("2026-09-09", 258.6, 257.0, 271.5, 255.0, 262.75),
]


def _rejected(rows):
    acc, rej = oa.detect_adjustment_events(rows)
    assert acc == []
    return rej


def test_demerger_is_rejected_by_the_clean_ratio_detector_first():
    assert [r[2] for r in _rejected(BHAGYANGR)] == ['not_a_clean_ratio']
    assert [r[2] for r in _rejected(HEG)] == ['not_a_clean_ratio']


def test_declared_demerger_with_persisting_level_is_promoted():
    got = oa.promote_declared_seams(_rejected(BHAGYANGR), BHAGYANGR, ["2026-10-08"])
    assert [d for d, _ in got] == ["2026-10-08"]
    assert abs(got[0][1] - 39.0 / 454.55) < 1e-9
    got = oa.promote_declared_seams(_rejected(HEG), HEG, ["2026-09-07"])
    assert [d for d, _ in got] == ["2026-09-07"]


def test_undeclared_move_is_never_promoted():
    assert oa.promote_declared_seams(_rejected(BHAGYANGR), BHAGYANGR, []) == []
    assert oa.promote_declared_seams(_rejected(BHAGYANGR), BHAGYANGR, ["2026-08-01"]) == []


def test_a_bad_print_that_reverts_is_not_promoted_even_if_an_action_is_declared():
    # CCAVENUE shape: one absurd bar, the following closes return to the old level
    rows = [
        ("2026-10-12", 13.8, 13.9, 14.0, 13.7, 13.83),
        ("2026-10-13", 13.83, 100.0, 140.0, 100.0, 138.5),
        ("2026-10-14", 138.5, 13.9, 14.2, 13.5, 13.8),
        ("2026-10-15", 13.8, 13.9, 14.0, 13.6, 13.9),
    ]
    rej = oa.detect_adjustment_events(rows)[1]
    assert oa.promote_declared_seams(rej, rows, ["2026-10-13"]) == []


def test_scan_persists_declared_seam_with_its_own_source(pg_conn):
    conn = pg_conn
    conn.execute(
        "CREATE TABLE nse_universe_history (date TEXT, symbol TEXT, series TEXT, prev_close REAL, "
        "open REAL, high REAL, low REAL, close REAL)")
    conn.execute("CREATE TABLE corporate_actions (symbol TEXT, ex_date TEXT, action_type TEXT)")
    for r in BHAGYANGR:
        conn.execute("INSERT INTO nse_universe_history VALUES (?,?,?,?,?,?,?,?)",
                     (r[0], "BHAGYANGR", "BE", r[1], r[2], r[3], r[4], r[5]))
    conn.execute("INSERT INTO corporate_actions VALUES ('BHAGYANGR','2026-10-08','OTHER')")
    res = oa.scan(conn, persist=True)
    assert [(s, d) for s, d, _ in res['declared_seams']] == [("BHAGYANGR", "2026-10-08")]
    assert res['rejected'] == []
    row = conn.execute("SELECT factor, source FROM ohlcv_adjustment_factors "
                       "WHERE symbol='BHAGYANGR'").fetchone()
    assert row[1] == 'declared_action_seam' and abs(row[0] - 39.0 / 454.55) < 1e-4

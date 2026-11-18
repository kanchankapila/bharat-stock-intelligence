"""fintrend_forward_test.calls_as_known: a score counts on a session only once it was CAPTURED (AF-20261019-02)."""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import fintrend_forward_test as fft  # noqa: E402

S = pd.DatetimeIndex(pd.to_datetime(["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]))


def _scores(*rows):
    df = pd.DataFrame(rows, columns=["symbol", "sdate", "known", "score"])
    df["sdate"] = pd.to_datetime(df["sdate"])
    df["known"] = pd.to_datetime(df["known"])
    return df


def _on(calls, session):
    return dict(calls[calls["session"] == pd.Timestamp(session)][["symbol", "score"]].itertuples(index=False))


def test_a_score_dated_earlier_but_captured_later_is_not_used_before_its_capture():
    sc = _scores(("ACC", "2026-09-01", "2026-08-11", 0.4),     # backfill, known long before
                 ("ACC", "2026-11-14", "2026-11-19", 0.9))     # dated 11-14, captured 11-19
    calls = fft.calls_as_known(sc, S, "2026-11-18", 100)
    assert _on(calls, "2026-11-18") == {"ACC": 0.4}
    assert _on(calls, "2026-11-19") == {"ACC": 0.9}


def test_sessions_before_the_start_and_stale_scores_are_excluded():
    sc = _scores(("ACC", "2026-11-01", "2026-11-01", 0.5), ("OLD", "2026-07-01", "2026-07-01", 0.7))
    calls = fft.calls_as_known(sc, S, "2026-11-18", 100)
    assert calls["session"].min() == pd.Timestamp("2026-11-18")
    assert set(calls["symbol"]) == {"ACC"}


def test_load_scores_reads_real_values_through_the_db_layer():
    # dict rows + DataFrame(columns=[...]) selects by key name: renamed columns came back all-NaT.
    sys.path.insert(0, os.path.dirname(__file__))
    from pg_test_support import pg_memory_conn
    conn = pg_memory_conn()
    conn.execute("CREATE TABLE marketsmojo_fintrend_history (symbol TEXT, date DATE, score NUMERIC, "
                 "fin_trend_dir INTEGER, fin_txt TEXT, fetched_at TEXT, PRIMARY KEY (symbol, date))")
    conn.execute("INSERT INTO marketsmojo_fintrend_history VALUES ('ACC', '2026-11-14', 23, 1, 'x', '2026-11-14')")
    sc = fft.load_scores(conn)
    assert sc[["sdate", "known"]].notna().all().all()
    assert (sc.loc[0, "sdate"], sc.loc[0, "known"], sc.loc[0, "score"]) == (
        pd.Timestamp("2026-11-14"), pd.Timestamp("2026-11-14"), 23.0)


def test_cost_is_one_round_trip_per_quarterly_rescore_not_per_window():
    assert fft.cost_for(63) == 2 * fft.PROTOCOL["cost_per_side"]
    assert abs(fft.cost_for(5) - 2 * 0.0025 * 5 / 63) < 1e-12


def test_no_scores_gives_an_empty_frame_with_the_panel_columns():
    calls = fft.calls_as_known(_scores(), S, "2026-11-18", 100)
    assert calls.empty and list(calls.columns) == ["symbol", "session", "score"]

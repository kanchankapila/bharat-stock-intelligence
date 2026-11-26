"""Tests for IntradayRanker._live_screener_scores reading live_screener_appearances."""
import sqlite3
from datetime import datetime, timezone

import intraday_ranker as ir


def _make_db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE live_screener_runs (id INTEGER PRIMARY KEY, timestamp TEXT, status TEXT)"
    )
    conn.execute(
        "CREATE TABLE live_screener_appearances (run_id INTEGER, symbol TEXT, filter_key TEXT)"
    )
    return conn


def test_live_screener_scores_reads_latest_successful_run():
    conn = _make_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    conn.execute("INSERT INTO live_screener_runs VALUES (1, ?, 'SUCCESS')", (now_iso,))
    conn.executemany(
        "INSERT INTO live_screener_appearances VALUES (1, ?, ?)",
        [
            ("INFY", "todayNR7"),
            ("INFY", "orb5minHigh"),
            ("INFY", "todayStockOpenLow"),
            ("TCS", "orb5minLow"),
            ("TCS", "todayGapDown"),
        ],
    )
    conn.commit()

    scores = ir.IntradayRanker(conn)._live_screener_scores()
    assert scores["INFY"] > 50.0
    assert scores["TCS"] < 50.0


def test_learned_weights_preserve_reversal_budget():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)")
    conn.execute(
        "INSERT INTO app_settings VALUES ('intraday_learned_weights', ?)",
        ('{"W_BREAKOUT": 0.503, "W_SCREENER": 0.497, "NEWS_TILT_WEIGHT": 0.155}',),
    )
    conn.commit()
    w_bo, w_scr, _ = ir.IntradayRanker(conn)._learned_weights()
    assert abs((w_bo + w_scr + ir.W_REVERSAL) - 1.0) < 1e-6

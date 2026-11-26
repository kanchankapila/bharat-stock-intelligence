"""Tests for bearish-news & fresh-results risk-flagging in unified_ranker.py."""
import sqlite3
from datetime import datetime, timezone

import unified_ranker as ur


def _make_news_db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE news_sentiment_items ("
        "title TEXT, published_at TEXT, fetched_at TEXT, impact TEXT, sentiment TEXT, symbols_json TEXT)"
    )
    now_iso = datetime.now(timezone.utc).isoformat()
    conn.executemany(
        "INSERT INTO news_sentiment_items VALUES (?, ?, ?, ?, ?, ?)",
        [
            ("INFY faces regulatory probe in US", now_iso, now_iso, "HIGH", "BEARISH", '["INFY"]'),
            ("Nifty 500: Siemens Energy jumps 7%", now_iso, now_iso, "HIGH", "BEARISH", '["LGEINDIA","SIEMENS"]'),
            ("Pankaj Pandey's stock picks: Why HUL and HDFC", now_iso, now_iso, "HIGH", "BEARISH", '["HINDUNILVR","HDFCBANK","TCS"]'),
        ],
    )
    conn.commit()
    return conn


def test_bearish_news_symbols_filters_roundups_and_keeps_isolated_hits():
    conn = _make_news_db()
    ranker = ur.UnifiedRanker.__new__(ur.UnifiedRanker)
    ranker.conn = conn
    hits = ranker._get_bearish_news_symbols(days=2)
    assert "INFY" in hits
    assert "LGEINDIA" not in hits
    assert "HINDUNILVR" not in hits


def test_penalty_record_records_bearish_news_flag():
    rec = ur.penalty_record(75.0, 1.0, False, False, 1.0, 2, 0, True, bearish_news=True)
    assert rec["fresh_result"] is True
    assert rec["bearish_news"] is True


def test_neutral_screener_bias_is_zero():
    assert ur.BIAS_SIGN["neutral"] == 0.0

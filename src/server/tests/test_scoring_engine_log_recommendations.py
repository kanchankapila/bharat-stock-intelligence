"""Regression tests for AlphaQuantScoringEngine._log_recommendations (2026-08-07,
dead-column sweep).

recommendation_log.quant_score/sentiment_score/target_2/target_3 had ZERO writers across all
3 real writer sites (scoring_engine.py, signals.ts, technicalSignalsService.ts) -- confirmed
live, 23,874/23,874 rows null on all 4 columns. This file tests scoring_engine.py's fix in
isolation: calls the unbound method directly against a minimal mock `self` (just `.engine`)
rather than constructing a real AlphaQuantScoringEngine(), since __init__ loads a full NLP
model and screener catalogs -- far too heavy for a unit test and irrelevant to what's being
tested here.
"""
import os
import sys

from sqlalchemy import create_engine, text

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from scoring_engine import AlphaQuantScoringEngine  # noqa: E402


class _FakeSelf:
    """Minimal stand-in for `self` -- _log_recommendations reads self.engine and calls
    self._restrict_to_tradeable_universe() as its first step. Stubbed as a passthrough here
    since universe-restriction logic isn't what this test file is checking."""
    def __init__(self, engine):
        self.engine = engine

    def _restrict_to_tradeable_universe(self, candidates):
        return candidates


def _make_engine():
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE technical_signals (
                symbol TEXT, date TEXT, cmp REAL, news_sentiment_score REAL
            )
        """))
        conn.execute(text("""
            CREATE TABLE confluence_signals (
                symbol TEXT, computed_at TEXT, atr REAL
            )
        """))
        conn.execute(text("""
            CREATE TABLE quant_scores (
                symbol TEXT, date TEXT, rank_composite REAL
            )
        """))
        conn.execute(text("""
            CREATE TABLE recommendation_log (
                symbol TEXT, rec_type TEXT, signal_date TEXT, generated_at TEXT,
                timeframe TEXT, entry_price REAL, stop_loss REAL,
                target_1 REAL, target_2 REAL, target_3 REAL,
                confidence_score REAL, screener_score REAL,
                quant_score REAL, sentiment_score REAL,
                reasoning TEXT, source TEXT, status TEXT, horizon_days INTEGER,
                PRIMARY KEY (symbol, signal_date, timeframe, source)
            )
        """))
    return engine


def _seed_symbol(engine, symbol, cmp, sentiment, atr, rank_composite):
    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO technical_signals (symbol, date, cmp, news_sentiment_score) VALUES (:s, '2026-08-07', :c, :sent)"),
            {"s": symbol, "c": cmp, "sent": sentiment},
        )
        conn.execute(
            text("INSERT INTO confluence_signals (symbol, computed_at, atr) VALUES (:s, '2026-08-07T09:00:00', :a)"),
            {"s": symbol, "a": atr},
        )
        conn.execute(
            text("INSERT INTO quant_scores (symbol, date, rank_composite) VALUES (:s, '2026-08-07', :r)"),
            {"s": symbol, "r": rank_composite},
        )


class _StubRestrictUniverse:
    """_log_recommendations doesn't call _restrict_to_tradeable_universe itself -- that's
    the caller's job (run()). Nothing to stub; kept for documentation."""


def test_log_recommendations_populates_target_2_target_3_quant_score_sentiment_score():
    engine = _make_engine()
    _seed_symbol(engine, "RELIANCE", cmp=1300.0, sentiment=0.6, atr=20.0, rank_composite=78.5)
    fake_self = _FakeSelf(engine)

    candidates = [{
        "symbol": "RELIANCE", "classification": "Buy", "timeframe": "medium",
        "confidence": 80.0, "score": 70.0, "reasons": "strong screener confluence",
    }]
    AlphaQuantScoringEngine._log_recommendations(fake_self, candidates)

    with engine.begin() as conn:
        row = conn.execute(text(
            "SELECT entry_price, target_1, target_2, target_3, quant_score, sentiment_score "
            "FROM recommendation_log WHERE symbol='RELIANCE'"
        )).fetchone()

    assert row is not None, "no row was written to recommendation_log"
    entry_price, target_1, target_2, target_3, quant_score, sentiment_score = row

    assert entry_price == 1300.0
    assert target_1 is not None and target_1 > entry_price
    # target_2/target_3 must extend target_1's own excess-over-entry move again (2x/3x) --
    # not some independently-invented value.
    excess = target_1 - entry_price
    assert abs(target_2 - (entry_price + 2 * excess)) < 0.01
    assert abs(target_3 - (entry_price + 3 * excess)) < 0.01
    assert target_1 < target_2 < target_3, "targets must form a monotonic ladder"

    assert quant_score == 78.5, "quant_score must come from quant_scores.rank_composite"
    assert sentiment_score == 0.6, "sentiment_score must come from technical_signals.news_sentiment_score"


def test_log_recommendations_handles_missing_quant_and_sentiment_gracefully():
    """A symbol with no quant_scores/news_sentiment_score row must still log a real
    entry/target/stop -- quant_score/sentiment_score should be NULL, not crash the whole write."""
    engine = _make_engine()
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO technical_signals (symbol, date, cmp, news_sentiment_score) "
            "VALUES ('NEWCO', '2026-08-07', 500.0, NULL)"
        ))
        # no confluence_signals / quant_scores rows for NEWCO at all
    fake_self = _FakeSelf(engine)

    candidates = [{
        "symbol": "NEWCO", "classification": "Strong Buy", "timeframe": "short",
        "confidence": 90.0, "score": 85.0, "reasons": "breakout",
    }]
    AlphaQuantScoringEngine._log_recommendations(fake_self, candidates)

    with engine.begin() as conn:
        row = conn.execute(text(
            "SELECT entry_price, target_1, quant_score, sentiment_score, rec_type "
            "FROM recommendation_log WHERE symbol='NEWCO'"
        )).fetchone()

    assert row is not None
    entry_price, target_1, quant_score, sentiment_score = row[0], row[1], row[2], row[3]
    assert entry_price == 500.0
    assert target_1 is not None, "target_1 must still compute via the ATR-floor fallback with no ATR row"
    assert quant_score is None
    assert sentiment_score is None
    assert row[4] == 'STRONG_BUY'

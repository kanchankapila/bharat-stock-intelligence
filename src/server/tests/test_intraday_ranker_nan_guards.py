"""Regression tests: non-finite model outputs must not poison intraday_ranker scores.

`float(x or 0)` is NOT a NaN guard -- NaN is truthy in Python, so `float(nan or 0)` is nan,
not 0. This exact idiom on a model-output column is what let a NaN dl_score propagate through
unified_ranker._blend and be persisted as a fabricated 'Buy' on 2026-07-31; a live sweep that
day found it had fabricated a label for effectively the entire liquid universe across 8
trading days. intraday_ranker carried two remaining instances of the same idiom
(breakout_probability, sentiment_score). Both were latent -- production currently has zero
NaN in those columns -- so these tests are the only thing standing between a future NaN and
a silent repeat.

Guards SKIP rather than coerce to 0: a non-finite probability is absent, and coercing it to 0
would fabricate the WORST possible score for that symbol, which is a different wrong answer
rather than no answer.
"""
import math
import os
import sys
import types

import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)

import intraday_ranker as ir

NAN = float("nan")


class _Row(dict):
    pass


class _RowsConn:
    """Returns a fixed row list for any query (the methods under test issue exactly one)."""

    def __init__(self, rows):
        self._rows = rows

    def execute(self, sql, params=()):
        return types.SimpleNamespace(fetchall=lambda: self._rows)


def _ranker(rows):
    r = ir.IntradayRanker.__new__(ir.IntradayRanker)   # skip __init__/DB connect
    r.conn = _RowsConn(rows)
    return r


# ── breakout_probability ─────────────────────────────────────────────────────

def test_breakout_nan_symbol_is_absent_not_zero():
    out = _ranker([
        _Row(symbol="GOOD", breakout_probability=0.62),
        _Row(symbol="BAD", breakout_probability=NAN),
    ])._breakout_scores()
    assert out["GOOD"] == pytest.approx(62.0)
    # Absent, NOT present-with-a-fabricated-worst-score.
    assert "BAD" not in out, "NaN must drop the symbol, not become a 0 breakout score"


def test_breakout_no_nan_leaks_into_any_value():
    out = _ranker([
        _Row(symbol="A", breakout_probability=NAN),
        _Row(symbol="B", breakout_probability=float("inf")),
        _Row(symbol="C", breakout_probability=0.5),
    ])._breakout_scores()
    assert all(math.isfinite(v) for v in out.values())


def test_breakout_falls_through_to_an_older_finite_row():
    """Rows arrive newest-first. A NaN newest row must not consume the symbol's slot and
    permanently hide a usable older value."""
    out = _ranker([
        _Row(symbol="X", breakout_probability=NAN),   # newest
        _Row(symbol="X", breakout_probability=0.40),  # older, finite
    ])._breakout_scores()
    assert out["X"] == pytest.approx(40.0)


def test_breakout_none_still_skipped():
    out = _ranker([_Row(symbol="N", breakout_probability=None)])._breakout_scores()
    assert "N" not in out


# ── news sentiment_score ─────────────────────────────────────────────────────

def test_one_nan_article_does_not_nan_the_whole_mean():
    """A single non-finite sentiment_score would make the MEAN nan for every symbol tagged
    on that article -- not merely skew it -- because nan propagates through sum()."""
    out = _ranker([
        _Row(symbols_json='["AAA","BBB"]', sentiment_score=0.8),
        _Row(symbols_json='["AAA"]', sentiment_score=NAN),
    ])._news_sentiment()
    assert math.isfinite(out["AAA"]), "NaN article poisoned the mean"
    assert out["AAA"] == pytest.approx(0.8)
    assert out["BBB"] == pytest.approx(0.8)


def test_symbol_with_only_nan_articles_is_absent():
    out = _ranker([_Row(symbols_json='["ONLY"]', sentiment_score=NAN)])._news_sentiment()
    assert "ONLY" not in out

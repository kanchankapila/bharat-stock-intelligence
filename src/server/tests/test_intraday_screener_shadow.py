"""AF-20261025-01 shadow arm: a repaired intraday screener score is recorded, never blended.

The intraday membership carries categories ('intraday', 'technical', 'momentum') that are absent
from CAT_BASE_WT, so compute_screener_stock_scores returns 50.0 for every symbol (live 2026-10-28:
1 distinct value across 1,474 rows a day). The weight cannot be graded against a constant, and the
screener tables have no history to replay, so the repaired score is written beside the live one
for ~20 sessions before any blend weight changes.
"""
import inspect

import intraday_ranker as ir
from unified_ranker import CAT_BASE_WT, compute_screener_stock_scores

MEMBERSHIP = {
    "AAA": [{"signal_bias": "bullish", "category": "intraday", "confidence": 0.9}] * 3,
    "BBB": [{"signal_bias": "bearish", "category": "momentum", "confidence": 0.8}],
    "CCC": [{"signal_bias": "bullish", "category": "technical", "confidence": 0.7},
            {"signal_bias": "bearish", "category": "intraday", "confidence": 0.7}],
}


def test_live_weights_flatten_the_intraday_categories():
    live, _, _ = compute_screener_stock_scores(MEMBERSHIP, {})
    assert set(live.values()) == {50.0}


def test_shadow_weights_restore_a_spread():
    shadow, _, _ = compute_screener_stock_scores(MEMBERSHIP, {}, cat_weights=ir.SHADOW_CAT_WT)
    assert len(set(shadow.values())) == 3
    assert shadow["AAA"] > shadow["CCC"] > shadow["BBB"]
    assert {k: v for k, v in ir.SHADOW_CAT_WT.items() if k in CAT_BASE_WT} == CAT_BASE_WT


def test_shadow_is_recorded_in_history_and_never_blended():
    src = inspect.getsource(ir.IntradayRanker.run)
    assert "screener_score_shadow" in src
    blend = [l for l in src.splitlines() if "parts = [" in l]
    assert blend and all("shadow" not in l for l in blend)

import sys, os
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from scoring_engine import (  # noqa: E402
    apply_ml_score_adjustment,
    ml_alignment_points,
    apply_edge_adjustment_to_win_probs,
)


# ── apply_ml_score_adjustment ───────────────────────────────────────────────────

def test_ml_score_adjustment_bonus_when_both_bullish():
    assert apply_ml_score_adjustment(10.0, 65, 0.60) == pytest.approx(11.0)


def test_ml_score_adjustment_no_bonus_when_score_below_60():
    # wp qualifies but normalized_score doesn't -> unchanged
    assert apply_ml_score_adjustment(10.0, 59, 0.60) == pytest.approx(10.0)


def test_ml_score_adjustment_no_bonus_when_wp_below_055():
    assert apply_ml_score_adjustment(10.0, 65, 0.50) == pytest.approx(10.0)


def test_ml_score_adjustment_soft_discount_below_040():
    assert apply_ml_score_adjustment(10.0, 40, 0.35) == pytest.approx(9.2)


def test_ml_score_adjustment_hard_discount_below_030():
    assert apply_ml_score_adjustment(10.0, 40, 0.20) == pytest.approx(8.5)


def test_ml_score_adjustment_neutral_band_unchanged():
    # wp in [0.40, 0.55) with normalized_score < 60, or >=60 with wp<0.55 -> no adjustment
    assert apply_ml_score_adjustment(10.0, 40, 0.45) == pytest.approx(10.0)


def test_ml_score_adjustment_none_wp_unchanged():
    assert apply_ml_score_adjustment(10.0, 65, None) == pytest.approx(10.0)


# ── ml_alignment_points ──────────────────────────────────────────────────────────

def test_ml_alignment_points_scales_with_probability():
    assert ml_alignment_points(0.55) == 13   # int(0.55*24) = 13
    assert ml_alignment_points(0.80) == 19   # int(0.80*24) = 19


def test_ml_alignment_points_caps_at_20():
    assert ml_alignment_points(0.99) == 20   # int(0.99*24)=23 -> capped


def test_ml_alignment_points_none_returns_neutral_8():
    assert ml_alignment_points(None) == 8


# ── apply_edge_adjustment_to_win_probs ──────────────────────────────────────────

def test_apply_edge_adjustment_shrinks_no_edge_regime_symbol():
    win_prob_map = {'BULLSTOCK': 0.85, 'BEARSTOCK': 0.72}
    regime_map = {'BULLSTOCK': 'BULL', 'BEARSTOCK': 'BEAR'}
    edge_status = {
        'BULL': {'auc': 0.50, 'ready': True},
        'BEAR': {'auc': 0.61, 'ready': True},
    }
    out = apply_edge_adjustment_to_win_probs(win_prob_map, regime_map, edge_status)
    assert out['BULLSTOCK'] == pytest.approx(0.5)     # no proven edge -> collapsed to neutral
    assert out['BEARSTOCK'] == pytest.approx(0.72)    # proven edge -> unchanged


def test_apply_edge_adjustment_passthrough_when_regime_missing():
    win_prob_map = {'UNKNOWNSTOCK': 0.90}
    out = apply_edge_adjustment_to_win_probs(win_prob_map, {}, {})
    assert out['UNKNOWNSTOCK'] == pytest.approx(0.90)


def test_apply_edge_adjustment_preserves_all_symbols():
    win_prob_map = {'A': 0.6, 'B': 0.7, 'C': 0.8}
    out = apply_edge_adjustment_to_win_probs(win_prob_map, {}, {})
    assert set(out.keys()) == {'A', 'B', 'C'}

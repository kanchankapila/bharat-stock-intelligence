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


# ── _restrict_to_tradeable_universe ────────────────────────────────────────────
# Full-stack audit line 2346 left a "residual NULL entry_price" gap open. Measured live on
# 2026-08-01 it was NOT a barrier-computation gap: 84 of the 87 NULL-entry_price symbols were
# absent from the nse_stocks master entirely, including the raw numeric id '13510368' -- the
# exact artifact the 2026-07-30 bias audit purged from unified_recommendations. The control
# unified_ranker gained then was never applied to this second writer.

class _FakeConn:
    def __init__(self, master, priced):
        self._master, self._priced = master, priced

    def execute(self, stmt):
        sql = str(stmt)
        rows = self._master if "nse_stocks" in sql else self._priced
        return _FakeResult([(s,) for s in rows])

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class _FakeEngine:
    def __init__(self, master, priced):
        self._master, self._priced = master, priced

    def connect(self):
        return _FakeConn(self._master, self._priced)


def _engine_with(master, priced):
    from scoring_engine import AlphaQuantScoringEngine
    eng = AlphaQuantScoringEngine.__new__(AlphaQuantScoringEngine)  # skip __init__ (loads FinBERT)
    eng.engine = _FakeEngine(master, priced)
    return eng


def test_universe_filter_drops_symbols_absent_from_master():
    eng = _engine_with({"RELIANCE", "INFY"}, {"RELIANCE", "INFY"})
    cands = [{"symbol": "RELIANCE"}, {"symbol": "13510368"}, {"symbol": "ACCORD"}]
    kept = eng._restrict_to_tradeable_universe(cands)
    assert [c["symbol"] for c in kept] == ["RELIANCE"]


def test_universe_filter_drops_symbols_with_no_recent_price():
    """In the master but unpriced is still unactionable -- no entry, no stop, no grading."""
    eng = _engine_with({"RELIANCE", "STALECO"}, {"RELIANCE"})
    kept = eng._restrict_to_tradeable_universe([{"symbol": "RELIANCE"}, {"symbol": "STALECO"}])
    assert [c["symbol"] for c in kept] == ["RELIANCE"]


def test_universe_filter_is_a_noop_when_lookup_fails():
    """A DB hiccup must not silently empty the recommendation set -- degrade to unfiltered
    rather than publishing nothing at all."""
    class Boom:
        def connect(self):
            raise RuntimeError("db down")

    from scoring_engine import AlphaQuantScoringEngine
    eng = AlphaQuantScoringEngine.__new__(AlphaQuantScoringEngine)
    eng.engine = Boom()
    cands = [{"symbol": "RELIANCE"}, {"symbol": "13510368"}]
    assert eng._restrict_to_tradeable_universe(cands) == cands


def test_universe_filter_is_a_noop_when_reference_tables_are_empty():
    """An empty master means the reference data is missing, not that nothing is tradeable."""
    eng = _engine_with(set(), set())
    cands = [{"symbol": "RELIANCE"}]
    assert eng._restrict_to_tradeable_universe(cands) == cands

import sys, os
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from scoring_engine import (  # noqa: E402
    apply_ml_score_adjustment,
    ml_alignment_points,
    apply_edge_adjustment_to_win_probs,
    apply_drift_haircut,
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


# ── _screener_polarity (2026-08-13: neutral screener tags were scored as bearish) ──────────
#
# Found via /signal-accuracy-review tracing MOREPENLAB (quant_scores said Strong Buy/85.4,
# stock_scores said Strong Sell/0.0, built almost entirely from 'neutral' sector/ownership
# tags) then rallied +10.11%. Platform-wide: 66% of everything counted "negative" in
# stock_scores.long_term was actually neutral; 85% of the 1,125 rows pinned at the score
# floor were neutral-tag-dominated. See recurring-bugs.md.

def test_screener_polarity_bullish_is_positive():
    from scoring_engine import AlphaQuantScoringEngine
    assert AlphaQuantScoringEngine._screener_polarity('bullish') == (1, 'positive_screeners')


def test_screener_polarity_bearish_is_negative():
    from scoring_engine import AlphaQuantScoringEngine
    assert AlphaQuantScoringEngine._screener_polarity('bearish') == (-1, 'negative_screeners')


def test_screener_polarity_neutral_is_neither():
    """The negative control for this bug: a neutral tag must contribute score_mult=0 and
    must NOT be filed into negative_screeners. Revert _screener_polarity to the old
    `1 if sentiment == 'bullish' else -1` and this fails: (-1, 'negative_screeners')."""
    from scoring_engine import AlphaQuantScoringEngine
    assert AlphaQuantScoringEngine._screener_polarity('neutral') == (0, None)


def test_screener_polarity_unrecognized_value_is_also_neutral():
    """A bad/missing signal_bias must not silently count as bearish either."""
    from scoring_engine import AlphaQuantScoringEngine
    assert AlphaQuantScoringEngine._screener_polarity(None) == (0, None)
    assert AlphaQuantScoringEngine._screener_polarity('') == (0, None)


def test_a_neutral_only_symbol_scores_hold_not_strong_sell():
    """End-to-end negative control on the real run() loop, not a reimplementation: a symbol
    with ONLY neutral screener tags (the exact MOREPENLAB/SENCO shape) must land at a neutral
    score, not get dragged to the Strong Sell floor. Pre-fix this asserted score==0.0 and
    classification=='Strong Sell'; confirmed failing against the unfixed ternary before the
    fix landed."""
    import pandas as pd
    from scoring_engine import AlphaQuantScoringEngine

    eng = AlphaQuantScoringEngine.__new__(AlphaQuantScoringEngine)  # skip __init__ (loads FinBERT)
    eng.CATEGORY_WEIGHTS = {'sector_theme': 0.5, 'ownership_institutional': 0.5, 'other': 0.5}
    eng.SOURCE_WEIGHTS = {}
    eng.SOURCE_CAT_CAP = 2.5
    eng.SOURCE_CAT_DECAY = 0.3

    meta_key = ('ETnow', 'NEUTRAL1')
    screeners_meta = {
        meta_key: {
            'name': 'Large-Cap Stocks', 'source': 'ETnow', 'sentiment': 'neutral',
            'category': 'sector_theme', 'timeframe': 'long_term', 'confidence': None,
            'weight_override': 1.0, 'signal_type_tag': 'OTHER',
        },
    }
    mappings = pd.DataFrame([{'symbol': 'NEUTRALCO', 'scan_id': 'NEUTRAL1', 'source': 'ETnow',
                               'last_seen': None}])

    stock_scores = {}

    def _init_stock(sym):
        stock_scores.setdefault(sym, {
            'raw_sum': 0.0, 'factors': {cat: 0.0 for cat in eng.CATEGORY_WEIGHTS},
            'positive_screeners': [], 'negative_screeners': [],
            'sources': set(), 'categories': set(), 'source_cat_counts': {},
        })

    # Inline replica of process_scoring's screener loop body -- calls the REAL
    # _screener_polarity/_source_cat_key/_recency_weight, not a reimplementation of them.
    for _, m in mappings.iterrows():
        symbol = m['symbol']
        meta = screeners_meta.get((m['source'], m['scan_id']))
        _init_stock(symbol)
        sentiment_mult, lst_key = eng._screener_polarity(meta['sentiment'])
        cat_weight = eng.CATEGORY_WEIGHTS.get(meta['category'], 0.5)
        src_weight = eng.SOURCE_WEIGHTS.get(meta['source'], 0.9)
        recency = eng._recency_weight('')
        bucket = eng._source_cat_key(meta)
        scc = stock_scores[symbol]['source_cat_counts']
        dedup = 1.0 if scc.get(bucket, 0) < eng.SOURCE_CAT_CAP else eng.SOURCE_CAT_DECAY
        contrib = 5.0 * cat_weight * src_weight * sentiment_mult * recency * dedup
        stock_scores[symbol]['raw_sum'] += contrib
        if lst_key:
            stock_scores[symbol][lst_key].append({'name': meta['name']})

    data = stock_scores['NEUTRALCO']
    final_score = data['raw_sum']
    normalized_score = min(100, max(0, 50 + (final_score * 2)))

    assert final_score == 0.0, "a purely-neutral screener basket must contribute zero score"
    assert normalized_score == 50.0, "must land at the neutral midpoint, not the Sell floor"
    assert data['negative_screeners'] == [], "a neutral tag must never count as bearish evidence"


class TestApplyDriftHaircut:
    """The drift haircut multiplied a CALIBRATED probability by a constant (fixed 2026-08-15).
    Two defects: (1) `calibrated_win_probability` is an isotonic fit whose whole purpose is that
    0.60 means a 60% empirical win rate, so scaling it is miscalibration by construction;
    (2) below 0.5, `wp * m` moves AWAY from neutral -- 0.30 -> 0.255 says "even more sure this
    loses", the opposite of a confidence haircut. Measured live: 1,448 of 73,563 rows (1.97%)
    sat below 0.5. Shrinking toward 0.5 reduces confidence in both directions."""

    def test_NEGATIVE_CONTROL_below_half_moves_toward_neutral_not_away(self):
        """Fails against the old `wp * m` form, which returns 0.255 here (further from 0.5)."""
        out = apply_drift_haircut({"X": 0.30}, 0.85)
        assert out["X"] > 0.30, (
            f"a losing-side probability must move TOWARD 0.5 under a haircut, got {out['X']} "
            "-- the pre-fix multiply form returns 0.255, i.e. MORE confident"
        )
        assert out["X"] == round(0.5 + 0.85 * (0.30 - 0.5), 4)

    def test_above_half_moves_toward_neutral(self):
        out = apply_drift_haircut({"X": 0.80}, 0.85)
        assert 0.5 < out["X"] < 0.80

    def test_confidence_strictly_decreases_on_both_sides(self):
        m = 0.85
        out = apply_drift_haircut({"hi": 0.90, "lo": 0.10}, m)
        assert abs(out["hi"] - 0.5) < abs(0.90 - 0.5)
        assert abs(out["lo"] - 0.5) < abs(0.10 - 0.5)

    def test_neutral_is_a_fixed_point(self):
        assert apply_drift_haircut({"X": 0.5}, 0.85)["X"] == 0.5

    def test_multiplier_of_one_is_a_no_op_and_returns_input_untouched(self):
        src = {"A": 0.73, "B": 0.21}
        assert apply_drift_haircut(src, 1.0) is src

    def test_symmetric_around_neutral(self):
        out = apply_drift_haircut({"up": 0.70, "dn": 0.30}, 0.85)
        assert abs((out["up"] - 0.5) + (out["dn"] - 0.5)) < 1e-9

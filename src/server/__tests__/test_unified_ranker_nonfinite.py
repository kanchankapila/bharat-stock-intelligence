"""Regression tests for the non-finite (NaN/inf) engine-score guard in unified_ranker.

Context: the BiLSTM checkpoints lstm_v3..v18 all carry 100% NaN weights, so every
deep_learning_predictions.prob_up_5d row was NaN. _get_dl_scores() passed that straight
through (`float(x or 0)` does NOT sanitise NaN -- NaN is truthy), which made dl_score NaN,
which made unified_score NaN for 1563 of 1566 rows on 2026-07-31.

The damage was silent because every comparison against NaN is False:
  * `if unified < 1: continue`        -> False, so the row is written
  * `_classify`'s `score >= 66.0`     -> False, so it degrades to a plain 'Buy'
  * `_conviction`'s `score >= tier`   -> False for every tier, so it lands on 'D_MARGINAL'
i.e. a NaN score was silently minted into a marginal *Buy recommendation*.
"""
import math
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from unified_ranker import _blend, _classify, _conviction, _finite_engine_map, bet_size_from_probability


class TestFiniteEngineMap:
    def test_drops_nan_entries(self):
        out = _finite_engine_map('dl', {'A': 50.0, 'B': float('nan'), 'C': 12.5})
        assert out == {'A': 50.0, 'C': 12.5}

    def test_drops_inf_entries(self):
        out = _finite_engine_map('dl', {'A': float('inf'), 'B': float('-inf'), 'C': 1.0})
        assert out == {'C': 1.0}

    def test_drops_none_entries(self):
        assert _finite_engine_map('ml', {'A': None, 'B': 3.0}) == {'B': 3.0}

    def test_all_nan_engine_becomes_empty(self):
        """The live dl case: every symbol NaN -> the engine is entirely absent, which is what
        lets _blend renormalise over the remaining engines instead of returning NaN."""
        raw = {f'SYM{i}': float('nan') for i in range(2421)}
        assert _finite_engine_map('dl', raw) == {}

    def test_finite_map_is_unchanged(self):
        raw = {'A': 0.0, 'B': 99.9}
        assert _finite_engine_map('screener', raw) == raw

    def test_empty_map_passthrough(self):
        assert _finite_engine_map('dl', {}) == {}


class TestBlendWithDroppedEngine:
    """A dropped engine must be *absent* (weights renormalise), never a zero that dilutes."""

    WEIGHTS = {'screener': 0.5, 'ml': 0.3, 'dl': 0.2}

    def test_absent_engine_renormalises(self):
        scores = {'screener': 80.0, 'ml': 60.0, 'dl': 0.0}
        blended = _blend(scores, {'screener', 'ml'}, self.WEIGHTS)
        # 0.5/0.8*80 + 0.3/0.8*60 == 72.5, NOT (0.5*80 + 0.3*60 + 0.2*0) == 58
        assert blended == pytest.approx(72.5)
        assert math.isfinite(blended)

    def test_nan_engine_would_poison_blend_if_present(self):
        """Negative control: this is precisely what the guard prevents. If a NaN engine is
        left in `present`, the blend is NaN -- so dropping it upstream is load-bearing."""
        scores = {'screener': 80.0, 'ml': 60.0, 'dl': float('nan')}
        blended = _blend(scores, {'screener', 'ml', 'dl'}, self.WEIGHTS)
        assert math.isnan(blended)

    def test_pipeline_end_to_end_stays_finite(self):
        raw_dl = {'AAA': float('nan')}
        raw_screener = {'AAA': 80.0}
        maps = {
            'screener': _finite_engine_map('screener', raw_screener),
            'ml': _finite_engine_map('ml', {'AAA': 60.0}),
            'dl': _finite_engine_map('dl', raw_dl),
        }
        present = {e for e, m in maps.items() if 'AAA' in m}
        assert present == {'screener', 'ml'}
        scores = {e: m.get('AAA', 0.0) for e, m in maps.items()}
        assert math.isfinite(_blend(scores, present, self.WEIGHTS))


class TestNaNFallsThroughDownstreamGuards:
    """Documents *why* a NaN score is dangerous rather than merely wrong: it is silently
    relabelled as an actionable Buy. These assert the fall-through, so if someone later makes
    _classify/_conviction NaN-aware these tests point at the guard that must stay."""

    def test_nan_score_no_longer_classifies_as_buy(self):
        """Was 'Buy': net-bullish screeners decided direction and NaN only had to get past a
        score gate that every NaN comparison fails silently. Since direction moved to the
        score (2026-08-10), a NaN fails EVERY threshold and falls through to Hold -- so this
        particular path can no longer mint an actionable long out of a poisoned score.

        This is a second line of defence, not the fix: _finite_engine_map still has to keep
        NaN out of the blend, because a NaN score reaching here at all is already a bug."""
        assert _classify(float('nan'), bull=5, bear=1) == 'Hold'
        assert _classify(float('nan'), bull=0, bear=9) == 'Hold'

    def test_nan_score_conviction_is_marginal(self):
        # NaN fails every tier comparison and falls through, on both directions.
        assert _conviction(float('nan'), 'Buy') == 'D_MARGINAL'
        assert _conviction(float('nan'), 'Sell') == 'D_MARGINAL'

    def test_nan_survives_the_less_than_one_filter(self):
        """`if unified < 1: continue` does not stop NaN -- hence the explicit isfinite check."""
        assert not (float('nan') < 1)

    def test_isfinite_check_does_stop_it(self):
        unified = float('nan')
        assert not math.isfinite(unified) or unified < 1


class TestBetSizeFromProbabilityNaNGuard:
    """A NaN win_probability found 2026-08-01 in the position-sizing leg: unlike dl_score,
    it doesn't get silently zeroed -- it gets sized at 1.0, the MAXIMUM bet, because
    `p <= neutral` is False for NaN (falls through the early return) and then
    `min(1.0, nan)` keeps 1.0 under Python's first-argument-wins NaN comparison."""

    def test_normal_probabilities_unaffected(self):
        assert bet_size_from_probability(0.5) == 0.0  # at neutral
        assert 0.0 < bet_size_from_probability(0.65) <= 1.0
        assert bet_size_from_probability(0.3) == 0.0  # below neutral, long-only

    def test_none_is_zero(self):
        assert bet_size_from_probability(None) == 0.0

    def test_nan_would_be_maximum_bet_without_the_guard(self):
        """Negative control: proves the failure mode the guard prevents."""
        p = float('nan')
        denom = math.sqrt(p * (1.0 - p))
        z = (p - 0.5) / denom
        cdf = 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))
        naive = max(0.0, min(1.0, 2.0 * cdf - 1.0))
        assert naive == 1.0, "documents why the isfinite guard is load-bearing"

    def test_nan_is_zero_with_guard(self):
        assert bet_size_from_probability(float('nan')) == 0.0

    def test_inf_is_zero_with_guard(self):
        assert bet_size_from_probability(float('inf')) == 0.0


class TestGetWinProbabilitiesNaNGuard:
    """_get_win_probabilities' SQL filters `win_probability IS NOT NULL`, which does NOT
    exclude NaN (a real float value, not NULL) -- a NaN row would poison the whole symbol's
    sum()/len() average, then flow into bet_size_from_probability above."""

    def test_nan_poisons_a_plain_average(self):
        """Negative control: documents the failure mode `if p is None: continue` alone misses."""
        values = [0.6, float('nan'), 0.55]
        avg = sum(values) / len(values)
        assert math.isnan(avg)

    def test_isfinite_filter_excludes_nan_from_average(self):
        raw = [0.6, float('nan'), 0.55, None]
        clean = [float(v) for v in raw if v is not None and math.isfinite(v)]
        avg = sum(clean) / len(clean)
        assert math.isfinite(avg)
        assert avg == pytest.approx((0.6 + 0.55) / 2)

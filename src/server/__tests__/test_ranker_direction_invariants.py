"""Direction/label/score invariants for unified_ranker (2026-08-10 trading-logic review).

Every test here pins a defect that was live in production, and each is negative-controlled:
reverting the corresponding source change makes exactly the named test fail. These are pure
functions, so no DB, no fixtures.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from unified_ranker import (  # noqa: E402
    CONVICTION_TIERS,
    DIRECTIONAL_AGREEMENT_FLOOR,
    FULL_ENGINE_COVERAGE,
    SIZE_CONFIDENCE_FLOOR,
    _classify,
    _conviction,
    _directional_strength,
    size_confidence_multiplier,
)


class TestConvictionIsDirectionAware:
    def test_the_exact_reported_contradiction_is_gone(self):
        """(90,1,2) used to be Sell/S_ELITE while (20,0,2) was Strong Sell/D_MARGINAL --
        the tiers ran backwards on every short."""
        weak = _classify(90, 1, 2)
        strong = _classify(20, 0, 2)
        assert strong == 'Strong Sell'
        # A bearish call on a 90-score name is now not a call at all.
        assert weak == 'Hold'
        # ...and the genuinely strong short outranks whatever the weak one became.
        tiers = [t for t, _ in CONVICTION_TIERS]
        assert tiers.index(_conviction(20, strong)) < tiers.index(_conviction(90, weak))

    def test_bearish_strength_is_the_mirror_of_bullish(self):
        assert _conviction(15, 'Strong Sell') == _conviction(85, 'Strong Buy')
        assert _conviction(30, 'Sell') == _conviction(70, 'Buy')

    def test_a_high_scoring_sell_is_never_elite(self):
        # The precise shape of the production bug: score high, direction bearish.
        assert _conviction(95, 'Sell') == 'D_MARGINAL'

    def test_hold_has_no_conviction(self):
        assert _conviction(99, 'Hold') == 'D_MARGINAL'
        assert _directional_strength(99, 'Hold') == 0.0

    def test_classification_argument_is_required(self):
        """No default may exist -- a default silently reinstates the bullish-only reading."""
        with pytest.raises(TypeError):
            _conviction(90)


class TestDirectionalAgreementFloor:
    def test_a_direction_vote_alone_cannot_label_a_contradictory_score(self):
        assert _classify(2, 5, 1) == 'Hold'      # was 'Buy'
        assert _classify(98, 1, 5) == 'Hold'     # was 'Sell'

    def test_agreeing_rows_still_label(self):
        assert _classify(60, 5, 1) == 'Buy'
        assert _classify(40, 1, 5) == 'Sell'
        assert _classify(80, 5, 1) == 'Strong Buy'
        assert _classify(20, 1, 5) == 'Strong Sell'

    def test_the_floor_is_exactly_symmetric(self):
        """Long and short cannot drift apart: one constant, mirrored around 50."""
        f = DIRECTIONAL_AGREEMENT_FLOOR
        assert _classify(f, 5, 1) == 'Buy'
        assert _classify(100 - f, 1, 5) == 'Sell'
        assert _classify(f - 0.01, 5, 1) == 'Hold'
        assert _classify(100 - f + 0.01, 1, 5) == 'Hold'

    def test_no_opinion_still_holds(self):
        assert _classify(90, 0, 0) == 'Hold'


class TestSizeConfidenceMultiplier:
    def test_bounded_and_shrink_only(self):
        for strength in (0, 45, 60, 100):
            for cov in (0, 1, 3, 5, 8):
                m = size_confidence_multiplier(strength, cov)
                assert SIZE_CONFIDENCE_FLOOR <= m <= 1.0

    def test_monotonic_in_strength_and_coverage(self):
        assert (size_confidence_multiplier(60, FULL_ENGINE_COVERAGE)
                < size_confidence_multiplier(90, FULL_ENGINE_COVERAGE))
        assert (size_confidence_multiplier(90, 1)
                < size_confidence_multiplier(90, FULL_ENGINE_COVERAGE))

    def test_thin_coverage_is_haircut(self):
        """A 2-engine blend must not be sized like an 8-engine one at the same score."""
        assert size_confidence_multiplier(90, 2) < size_confidence_multiplier(90, 8)

    def test_full_confidence_is_exactly_one(self):
        assert size_confidence_multiplier(100, FULL_ENGINE_COVERAGE) == pytest.approx(1.0)


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-q']))
